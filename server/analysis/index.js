// Warteschlange für die Auswertung hochgeladener Briefe.
// Ablauf: Dateien entschlüsseln → KI (falls eingerichtet und erlaubt) oder
// Regel-Erkennung → Ergebnis prüfen (validate.js) → speichern → Akte zuordnen,
// Duplikate prüfen, Verlauf schreiben.
import { AiError } from './ai.js';
import { prepareForAi, preparationNote } from './prepare.js';
import { extractOfficeText } from '../lib/office.js';
import { analyzeWithRules } from './rules.js';
import { normalizeAnalysis } from './validate.js';
import { extractPdfText } from '../pdf/extract.js';
import { saveAnalysis, markAnalysis } from '../domain/letters.js';
import { assignLetter, detectPerson } from '../domain/assignment.js';
import { checkDuplicate } from '../domain/duplicates.js';
import { logLetterEvent } from '../domain/events.js';
import { todayIn } from '../../public/js/shared/dates.js';

const CONCURRENCY = 2;

export function createAnalyzer({ db, storage, config, ai, log = console }) {
  const queue = [];
  let running = 0;
  const idleWaiters = [];

  function checkIdle() {
    if (running === 0 && queue.length === 0) while (idleWaiters.length) idleWaiters.shift()();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const id = queue.shift();
      running++;
      process(id)
        .catch((err) => {
          log.error(`[Auswertung] Unerwarteter Fehler (${err.name})`);
          markAnalysis(db, id, 'fehler', 'Bei der Auswertung ist ein unerwarteter Fehler aufgetreten.');
        })
        .finally(() => {
          running--;
          pump();
          checkIdle();
        });
    }
  }

  function enqueue(letterId) {
    if (!queue.includes(letterId)) queue.push(letterId);
    pump();
  }

  /** Nach einem Neustart: unterbrochene Auswertungen erneut einreihen. */
  function resumePending() {
    const rows = db.all("SELECT id FROM letters WHERE analysis_status IN ('wartet', 'laeuft') ORDER BY created_at");
    for (const row of rows) enqueue(row.id);
    return rows.length;
  }

  function aiAllowed(user) {
    return Boolean(ai?.enabled) && user.ai_consent === 'ja';
  }

  /** Zählt eine KI-Anfrage gegen das Tageslimit des Nutzers (Kostenschutz). */
  function takeAiQuota(user) {
    const day = todayIn(user.timezone);
    const limit = user.is_demo ? config.ai.demoDailyLimit : config.ai.dailyLimit;
    const row = db.get('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?', user.id, day);
    if (row && row.count >= limit) return false;
    db.run(
      'INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1',
      user.id, day
    );
    return true;
  }

  /** Nach jeder Auswertung: betroffene Person, Akte, Duplikate, Verlauf. */
  function afterAnalysis(letterId, { source, model }) {
    const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
    if (!letter) return;
    try {
      if (!letter.person_id) {
        const personId = detectPerson(db, letter);
        if (personId) db.run('UPDATE letters SET person_id = ? WHERE id = ?', personId, letterId);
      }
      assignLetter(db, letterId);
      checkDuplicate(db, letterId);
    } catch (err) {
      log.error(`[Auswertung] Zuordnung fehlgeschlagen (${err.name})`);
    }
    logLetterEvent(db, letter.user_id, letterId, 'ausgewertet', { quelle: source, modell: model || null });
  }

  async function process(letterId) {
    const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
    if (!letter) return;
    const user = db.get('SELECT * FROM users WHERE id = ?', letter.user_id);
    if (!user) return;
    markAnalysis(db, letterId, 'laeuft');
    const started = Date.now();
    // Nur die Seiten des Briefes – nicht zusätzlich aufbewahrte Originalaufnahmen
    const fileRows = db.all("SELECT * FROM files WHERE letter_id = ? AND role = 'seite' ORDER BY position", letterId);
    const files = [];
    for (const f of fileRows) files.push({ kind: f.kind, mime: f.mime, data: await storage.get(f.storage_key) });
    const today = todayIn(user.timezone);

    let useAi = aiAllowed(user);
    let quotaNote = null;
    if (useAi && !takeAiQuota(user)) {
      useAi = false;
      quotaNote = 'Das Tageslimit für KI-Auswertungen ist erreicht. Dieser Brief wurde nur mit der einfachen Erkennung gelesen. Sie können ihn morgen erneut auswerten lassen.';
    }

    if (useAi) {
      try {
        const prepared = prepareForAi(files);
        const { result, model } = await ai.analyzeLetter({ files: prepared.aiFiles, today, note: preparationNote(prepared) });
        // Vollständiger Text: lokal gelesener Text (alle Seiten) plus Abschrift gescannter Teile durch die KI
        const aiText = String(result.full_text || '').trim();
        const fullText = prepared.localText
          ? [prepared.localText, aiText && !prepared.localText.includes(aiText.slice(0, 200)) ? aiText : ''].filter(Boolean).join('\n\n')
          : aiText;
        result.full_text = fullText;
        const analysis = normalizeAnalysis(result, { fullText, today, source: 'ki' });
        saveAnalysis(db, letterId, analysis, { source: 'ki', model });
        afterAnalysis(letterId, { source: 'ki', model });
        log.info(`[Auswertung] Brief ausgewertet · Quelle=ki · Dateien=${files.length} · Aufgaben=${analysis.actions.length} · ${Date.now() - started} ms`);
        return;
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'Die KI-Auswertung ist fehlgeschlagen.';
        log.warn(`[Auswertung] KI-Fehler · Code=${err.code || err.name}`);
        if (err instanceof AiError && err.code === 'kontingent') {
          // Kostenloses Kontingent erschöpft: ehrlich melden und mit der einfachen Erkennung weitermachen
          quotaNote = `${message} Dieser Brief wurde deshalb nur mit der einfachen Erkennung gelesen. Sie können ihn später erneut auswerten lassen.`;
        } else {
          markAnalysis(db, letterId, 'fehler', message);
          logLetterEvent(db, letter.user_id, letterId, 'auswertung_fehler', { code: err.code || 'unbekannt' });
          return;
        }
      }
    }

    // Ohne KI: Text aus PDFs lesen und mit Regeln auswerten
    const texts = [];
    let photos = 0;
    let encrypted = false;
    for (const f of files) {
      if (f.kind === 'pdf') {
        const extracted = extractPdfText(f.data);
        if (extracted.encrypted) encrypted = true;
        if (extracted.text) texts.push(extracted.text);
      } else if (f.kind === 'office') {
        try {
          texts.push(extractOfficeText(f.data).text);
        } catch {
          /* unlesbar: wie leerer Text */
        }
      } else {
        photos++;
      }
    }
    const fullText = texts.join('\n\n').trim();
    if (fullText.replace(/\s|-|Seite \d+/g, '').length < 40) {
      let reason;
      if (encrypted) reason = 'Dieses PDF ist verschlüsselt. Der Text kann nicht gelesen werden.';
      else if (quotaNote) reason = photos
        ? `${quotaNote.split(' Dieser Brief')[0]} Fotos können ohne KI nicht gelesen werden. Der Brief ist gespeichert – Sie können ihn später erneut auswerten lassen oder die Angaben selbst eintragen.`
        : quotaNote;
      else if (!config.ai.enabled) reason = photos
        ? 'Fotos können nur mit KI-Texterkennung gelesen werden. Diese ist auf diesem Server nicht eingerichtet. Der Brief ist gespeichert – Sie können Absender, Datum und Aufgaben selbst eintragen.'
        : 'Dieses PDF enthält keinen lesbaren Text (vermutlich ein Scan). Dafür wird die KI-Texterkennung benötigt, die auf diesem Server nicht eingerichtet ist. Sie können die Angaben selbst eintragen.';
      else if (user.ai_consent !== 'ja') reason = 'Sie haben die KI-Auswertung nicht freigegeben. Ohne KI können Fotos und gescannte PDFs nicht gelesen werden. Sie können die KI in den Einstellungen freigeben oder die Angaben selbst eintragen.';
      else reason = 'Der Brief konnte nicht gelesen werden.';
      markAnalysis(db, letterId, 'nicht_moeglich', reason);
      try {
        checkDuplicate(db, letterId);
      } catch {
        /* Duplikatprüfung ist nur ein Hinweis */
      }
      log.info(`[Auswertung] Keine Texterkennung möglich · Dateien=${files.length}`);
      return;
    }
    const raw = analyzeWithRules(fullText);
    if (files.length && files.every((f) => f.kind === 'office')) {
      // Präsentationen und Dokumente haben keine Absenderzeile: erste Zeile ist der Titel
      const title = fullText.split('\n').map((l) => l.trim()).find((l) => l && !/^--- (Seite|Folie|Tabelle) \d+ ---$/.test(l)) || null;
      raw.sender = null;
      raw.sender_quote = null;
      raw.subject = title ? title.slice(0, 200) : raw.subject;
      raw.document_type = files.some((f) => /presentation/.test(f.mime)) ? 'Präsentation' : files.some((f) => /spreadsheet/.test(f.mime)) ? 'Tabelle' : 'Dokument';
      raw.to_check = (raw.to_check || []).filter((t) => !/Absender/.test(t));
    }
    if (photos) raw.to_check.push(`${photos} Foto(s) dieses Briefes wurden nicht gelesen (Texterkennung für Fotos benötigt KI).`);
    if (quotaNote) raw.to_check.unshift(quotaNote);
    if (config.ai.enabled && user.ai_consent !== 'ja') {
      raw.to_check.push('Mit freigegebener KI-Auswertung bekommen Sie eine Erklärung in einfacher Sprache (Einstellungen → Datenschutz & KI).');
    }
    const analysis = normalizeAnalysis(raw, { fullText, today, source: 'regeln' });
    saveAnalysis(db, letterId, analysis, { source: 'regeln', model: null });
    afterAnalysis(letterId, { source: 'regeln', model: null });
    log.info(`[Auswertung] Brief ausgewertet · Quelle=regeln · Dateien=${files.length} · Aufgaben=${analysis.actions.length} · ${Date.now() - started} ms`);
  }

  return {
    enqueue,
    resumePending,
    takeAiQuota,
    aiAllowed,
    /** Für Tests: wartet, bis die Warteschlange leer ist. */
    idle: () => new Promise((resolve) => {
      idleWaiters.push(resolve);
      checkIdle();
    }),
  };
}
