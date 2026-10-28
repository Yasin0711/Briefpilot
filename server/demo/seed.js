// Demomodus: legt ein eigenes, zeitlich begrenztes Demo-Konto mit Beispielbriefen an.
// Jede Demo bekommt ein eigenes Konto – niemand sieht die Daten anderer Demo-Nutzer.
import crypto from 'node:crypto';
import { buildPdf, wrapText, textWidth } from '../pdf/write.js';
import { extractPdfText } from '../pdf/extract.js';
import { normalizeAnalysis } from '../analysis/validate.js';
import { saveAnalysis } from '../domain/letters.js';
import { scheduleReminders } from '../domain/reminders.js';
import { newId } from '../lib/security.js';
import { buildDemoLetters, demoHousehold, RECIPIENT } from './letters.js';
import { assignLetter, loadAssignmentContext, detectPerson } from '../domain/assignment.js';
import { checkDuplicate } from '../domain/duplicates.js';
import { logLetterEvent } from '../domain/events.js';
import { normalizeIdentifier, orgKey, identifierKind } from '../../public/js/shared/identifiers.js';
import { objectType } from '../../public/js/shared/constants.js';
import { formatDate, todayIn } from '../../public/js/shared/dates.js';

const LEFT = 70;
const RIGHT = 525;
const BODY_SIZE = 10.5;
const LEADING = 15;

/** Setzt einen Beispielbrief als PDF (A4) im Stil eines deutschen Geschäftsbriefs. */
export function renderLetterPdf(letter) {
  const pages = [[]];
  let page = pages[0];
  const text = (x, y, value, opts = {}) => page.push({ type: 'text', x, y, text: value, ...opts });

  text(LEFT, 792, letter.senderName, { size: 14, bold: true });
  text(LEFT, 777, letter.senderLine, { size: 8, gray: 0.35 });
  page.push({ type: 'line', x1: LEFT, y1: 768, x2: RIGHT, y2: 768, gray: 0.75 });

  // Anschriftfeld
  text(LEFT, 712, letter.senderLine, { size: 6.5, gray: 0.4 });
  RECIPIENT.forEach((line, i) => text(LEFT, 694 - i * 14, line, { size: 10.5 }));

  // Infoblock rechts
  let infoY = 712;
  for (const [label, value] of letter.refs) {
    text(360, infoY, `${label}: ${value}`, { size: 9 });
    infoY -= 13;
  }
  if (letter.letterDate) {
    const dateLine = `${letter.place}, ${formatDate(letter.letterDate, { short: true })}`;
    text(RIGHT - textWidth(dateLine, 10.5), 600, dateLine, { size: 10.5 });
  }

  let y = 565;
  for (const line of wrapText(letter.subject, RIGHT - LEFT, 11.5, true)) {
    text(LEFT, y, line, { size: 11.5, bold: true });
    y -= 16;
  }
  y -= 14;
  const newPageIfNeeded = () => {
    if (y < 95) {
      page = [];
      pages.push(page);
      text(LEFT, 800, `${letter.senderName} – Seite ${pages.length}`, { size: 8, gray: 0.4 });
      y = 770;
    }
  };
  const paragraph = (value) => {
    for (const line of wrapText(value, RIGHT - LEFT, BODY_SIZE)) {
      newPageIfNeeded();
      text(LEFT, y, line, { size: BODY_SIZE });
      y -= LEADING;
    }
    y -= 7;
  };
  paragraph(letter.salutation);
  for (const p of letter.paragraphs) paragraph(p);
  y -= 4;
  paragraph('Mit freundlichen Grüßen');
  paragraph(letter.signer);

  for (const p of pages) {
    p.push({ type: 'line', x1: LEFT, y1: 62, x2: RIGHT, y2: 62, gray: 0.8 });
    p.push({ type: 'text', x: LEFT, y: 50, text: letter.footer, size: 7.5, gray: 0.45 });
    p.push({ type: 'text', x: LEFT, y: 38, text: 'BEISPIELBRIEF – frei erfunden für den Demomodus von BriefPilot. Namen, Adressen, Nummern und Konten sind ausgedacht.', size: 7.5, gray: 0.45, bold: true });
  }
  return buildPdf(pages, { title: letter.subject });
}

export function demoSamplePdf(index, today) {
  const letters = buildDemoLetters(today);
  const letter = letters[Math.max(0, Math.min(letters.length - 1, index))];
  return { pdf: renderLetterPdf(letter), name: `beispielbrief-${letter.key}.pdf` };
}

export async function createDemoAccount({ db, storage, config }) {
  const userId = newId();
  const now = new Date();
  const nowIso = now.toISOString();
  const timezone = 'Europe/Berlin';
  const today = todayIn(timezone, now);
  db.run(
    `INSERT INTO users (id, email, name, password_hash, timezone, is_demo, privacy_accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?)`,
    userId, `demo-${userId}@demo.invalid`, 'Lena (Demo)', timezone, nowIso, nowIso, nowIso
  );
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  seedHousehold(db, userId, today, nowIso);
  const letterIds = [];

  for (const letter of buildDemoLetters(today)) {
    const pdf = renderLetterPdf(letter);
    const storageKey = await storage.put(userId, pdf);
    const letterId = newId();
    const uploadedAt = new Date(now.getTime() - letter.uploadedDaysAgo * 86400000).toISOString();
    db.tx(() => {
      db.run(
        `INSERT INTO letters (id, user_id, uploaded_at, analysis_status, is_demo_content, created_at, updated_at)
         VALUES (?, ?, ?, 'laeuft', 1, ?, ?)`,
        letterId, userId, uploadedAt, uploadedAt, uploadedAt
      );
      db.run(
        `INSERT INTO files (id, user_id, letter_id, position, kind, mime, size, page_count, sha256, storage_key, created_at)
         VALUES (?, ?, ?, 0, 'pdf', 'application/pdf', ?, ?, ?, ?, ?)`,
        newId(), userId, letterId, pdf.length, 1, crypto.createHash('sha256').update(pdf).digest('hex'), storageKey, uploadedAt
      );
    });
    // Die vorbereitete Auswertung durchläuft dieselben Prüfungen wie eine echte KI-Antwort
    const fullText = extractPdfText(pdf).text;
    const analysis = normalizeAnalysis(letter.raw, { fullText, today, source: 'beispiel' });
    saveAnalysis(db, letterId, analysis, { source: 'beispiel', model: null });
    letterIds.push(letterId);
    logLetterEvent(db, userId, letterId, 'hochgeladen', { seiten: 1 });
    logLetterEvent(db, userId, letterId, 'ausgewertet', { quelle: 'beispiel' });
    if (letter.reviewed) {
      db.run("UPDATE letters SET reviewed_at = ?, letter_date_status = CASE WHEN letter_date IS NOT NULL THEN 'bestaetigt' ELSE letter_date_status END WHERE id = ?", uploadedAt, letterId);
    }

    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letterId);
    letter.taskStates.forEach((state, i) => {
      const task = tasks[i];
      if (!task || state.status === 'zu_pruefen') return;
      db.run(
        `UPDATE tasks SET status = ?, due_date = suggested_date, due_time = suggested_time, confirmed_at = ?, completed_at = ? WHERE id = ?`,
        state.status, uploadedAt, state.status === 'erledigt' ? nowIso : null, task.id
      );
      const fresh = db.get('SELECT * FROM tasks WHERE id = ?', task.id);
      if (fresh.status === 'offen') scheduleReminders(db, fresh, user, {});
      if (state.demoReminder) {
        db.run(
          'INSERT INTO reminders (id, user_id, task_id, remind_at, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(), userId, task.id, new Date(now.getTime() + 90_000).toISOString(), 'Demo: Beispiel-Erinnerung in 90 Sekunden', 'geplant', nowIso
        );
      }
    });
  }
  // Zuordnung zu den Akten – mit derselben Logik wie bei echten Briefen
  const ctx = loadAssignmentContext(db, userId);
  for (const letterId of letterIds) {
    const row = db.get('SELECT * FROM letters WHERE id = ?', letterId);
    const personId = detectPerson(db, row);
    if (personId) db.run('UPDATE letters SET person_id = ? WHERE id = ?', personId, letterId);
    assignLetter(db, letterId, { ctx });
    checkDuplicate(db, letterId);
  }
  void config;
  return user;
}

function seedHousehold(db, userId, today, nowIso) {
  const household = demoHousehold(today);
  const persons = {};
  const addresses = {};
  for (const p of household.persons) {
    persons[p.key] = newId();
    db.run('INSERT INTO persons (id, user_id, name, relation, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', persons[p.key], userId, p.name, p.relation, '[]', nowIso, nowIso);
  }
  for (const a of household.addresses) {
    addresses[a.key] = newId();
    db.run(
      `INSERT INTO addresses (id, user_id, label, kind, street, zip, city, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      addresses[a.key], userId, a.label, a.kind, a.street, a.zip, a.city, a.primary ? 1 : 0, nowIso, nowIso
    );
  }
  for (const o of household.objects) {
    const objectId = newId();
    const providerKey = o.provider ? orgKey(o.provider) : null;
    db.run(
      `INSERT INTO objects (id, user_id, type, name, provider, provider_key, category, person_id, address_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      objectId, userId, o.type, o.name, o.provider || null, providerKey, objectType(o.type).category,
      persons[o.person] || null, addresses[o.address] || null, nowIso, nowIso
    );
    for (const i of o.identifiers) {
      db.run(
        `INSERT INTO identifiers (id, user_id, object_id, kind, value, normalized, issuer_key, status, valid_from, valid_to, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nutzer', ?)`,
        newId(), userId, objectId, i.kind, i.value, normalizeIdentifier(i.kind, i.value),
        identifierKind(i.kind).scope === 'issuer' ? providerKey : null, i.status || 'aktuell', i.validFrom || null, i.validTo || null, nowIso
      );
    }
  }
}

/** Entfernt abgelaufene Demo-Konten samt Dateien. */
export async function cleanupDemoAccounts({ db, storage, config }) {
  const cutoff = new Date(Date.now() - config.demo.ttlHours * 3600_000).toISOString();
  const old = db.all('SELECT id FROM users WHERE is_demo = 1 AND created_at < ?', cutoff);
  for (const u of old) {
    db.run('DELETE FROM users WHERE id = ?', u.id);
    await storage.removeUser(u.id);
  }
  return old.length;
}
