// Prüft jede Auswertung (KI oder Regeln), bevor sie gespeichert wird.
// Ziel: Nichts Erfundenes als sicher darstellen. Unklare Angaben werden markiert,
// relative Fristen bekommen nie ein festes Enddatum, und jede Textstelle wird im
// erkannten Brieftext gesucht.
import { CATEGORY_IDS, TASK_KIND_IDS } from '../../public/js/shared/constants.js';
import { normalizeTags, deriveTags } from '../../public/js/shared/tags.js';
import {
  IDENTIFIER_KIND_IDS, kindFromLabel, normalizeIdentifier, extractIdentifiers, identifierKindLabel, compactAddressText,
} from '../../public/js/shared/identifiers.js';
import {
  isValidIsoDate, isValidTime, parseGermanDates, parseRelativeDeadline, isWeekend, daysBetween,
} from '../../public/js/shared/dates.js';

const str = (v, max = 500) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const strOrNull = (v, max = 500) => str(v, max) || null;

function timePattern(time) {
  const [h, m] = time.split(':');
  const hour = String(Number(h));
  return m === '00'
    ? new RegExp(`(^|[^\\d])0?${hour}([:.]00\\b|\\s*uhr)`, 'i')
    : new RegExp(`(^|[^\\d])0?${hour}[:.]${m}`);
}

// Zeitraum aus dem Fristtext, Bezugspunkt (z. B. „nach Zugang“) notfalls aus der längeren Textstelle
function mergeRules(fromRelativeText, fromQuote) {
  const rule = fromRelativeText || fromQuote;
  if (!rule) return null;
  if (rule.anchor === 'unbekannt' && fromQuote && fromQuote.anchor !== 'unbekannt') return { ...rule, anchor: fromQuote.anchor };
  return rule;
}

export function normalizeForSearch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[„“”‚‘’«»"']/g, '"')
    .replace(/[–—‐-]/g, '-')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sucht eine Textstelle im Brieftext. 'gefunden' | 'aehnlich' | 'nicht_gefunden' | 'unbekannt' */
export function verifyQuote(quote, fullText) {
  if (!quote) return 'unbekannt';
  if (!fullText || fullText.length < 20) return 'unbekannt';
  const q = normalizeForSearch(quote).replace(/^\.{3}|\.{3}$/g, '').replace(/…/g, '').trim();
  const t = normalizeForSearch(fullText);
  if (q.length < 3) return 'unbekannt';
  if (t.includes(q)) return 'gefunden';
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return 'unbekannt';
  const textWords = new Set(t.split(/[^\p{L}\p{N}]+/u));
  const hits = words.filter((w) => textWords.has(w)).length;
  return hits / words.length >= 0.85 ? 'aehnlich' : 'nicht_gefunden';
}

const INJECTION_PATTERNS = [
  /ignorier\w*\s+(alle|sämtliche|die|deine|vorherige\w*|bisherige\w*)\s+\w*\s*(anweisung|regel|instruktion)/i,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /\b(an|für)\s+(die\s+)?(ki|künstliche intelligenz|ai|assistent\w*|chatbot|sprachmodell)\b.{0,40}(anweisung|bitte|markier|lösch|bestätig)/i,
  /(system\s*prompt|systemanweisung|developer\s+mode)/i,
  /\b(du bist (jetzt|nun|ab sofort)|you are now)\b/i,
];

export function looksLikeInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(String(text || '')));
}

function cleanList(list, mapper, max = 30) {
  return Array.isArray(list) ? list.slice(0, max).map(mapper).filter(Boolean) : [];
}

/**
 * Normalisiert eine Rohauswertung und ergänzt Prüfhinweise.
 * @param raw  Rohdaten (Schema aus prompt.js)
 * @param opts { fullText, today, source }
 */
export function normalizeAnalysis(raw, { fullText: providedText, today, source }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fullText = str(providedText || r.full_text, 3000000);
  const toCheck = [];

  // Absender, Betreff, Kategorie
  const sender = strOrNull(r.sender, 200);
  const subject = strOrNull(r.subject, 300);
  const category = CATEGORY_IDS.includes(String(r.category || '').toLowerCase()) ? String(r.category).toLowerCase() : 'sonstiges';
  if (!sender) toCheck.push('Der Absender wurde nicht sicher erkannt. Bitte ergänzen.');

  // Briefdatum
  let letterDate = isValidIsoDate(r.letter_date) ? r.letter_date : null;
  const letterDateQuote = strOrNull(r.letter_date_quote, 300);
  let letterDateStatus = 'fehlt';
  if (letterDate) {
    const year = Number(letterDate.slice(0, 4));
    const inFuture = today && daysBetween(today, letterDate) > 7;
    if (year < 1990 || inFuture) {
      toCheck.push('Das erkannte Briefdatum ist unplausibel und wurde nicht übernommen. Bitte prüfen.');
      letterDate = null;
    } else {
      const quoteState = verifyQuote(letterDateQuote, fullText);
      const quoteDates = parseGermanDates(letterDateQuote || '').map((d) => d.date);
      const matches = quoteDates.includes(letterDate);
      letterDateStatus = quoteState === 'gefunden' && matches ? 'erkannt' : 'unsicher';
      if (letterDateStatus === 'unsicher') toCheck.push('Das Briefdatum ist nicht ganz sicher erkannt. Bitte mit dem Original vergleichen.');
    }
  } else {
    toCheck.push('Im Brief wurde kein Briefdatum gefunden. Bitte tragen Sie es ein, falls es im Brief steht.');
  }

  const references = cleanList(r.references, (ref) => {
    const label = str(ref?.label, 80);
    const value = str(ref?.value, 120);
    if (!label || !value) return null;
    const kind = IDENTIFIER_KIND_IDS.includes(ref?.kind) && ref.kind !== 'sonstiges' ? ref.kind : kindFromLabel(label);
    const status = ['alt', 'neu'].includes(ref?.status) ? ref.status : null;
    return { label, value, quote: strOrNull(ref?.quote, 300), kind, status };
  });
  const { identifiers, missing } = buildIdentifiers(references, fullText, source);
  for (const m of missing.slice(0, 3)) {
    toCheck.push(`Die Nummer „${m.value}“ (${m.label}) wurde im erkannten Brieftext nicht gefunden. Sie wird für die Zuordnung nicht verwendet.`);
  }
  const amounts = cleanList(r.amounts, (a) => {
    const label = str(a?.label, 80);
    const amount = str(a?.amount, 40);
    return amount && /\d/.test(amount) ? { label: label || 'Betrag', amount, currency: str(a?.currency, 8) || 'EUR', quote: strOrNull(a?.quote, 300) } : null;
  });

  // Aufgaben, Fristen, Termine
  let relativeCount = 0;
  let unverifiedCount = 0;
  const actions = cleanList(r.actions, (a, index) => {
    const title = str(a?.title, 160);
    if (!title) return null;
    const notes = [];
    const kind = TASK_KIND_IDS.includes(a?.kind) ? a.kind : 'aufgabe';
    const quote = strOrNull(a?.quote, 600);
    let date = isValidIsoDate(a?.date) ? a.date : null;
    let time = isValidTime(a?.time) ? a.time : null;
    let relativeText = strOrNull(a?.relative_text, 300);
    let isRelative = a?.is_relative === true;

    // Relative Frist auch dann erkennen, wenn die KI sie nicht markiert hat
    const quoteDates = parseGermanDates(quote || '').map((d) => d.date);
    const relativeFromQuote = parseRelativeDeadline(quote || '') || parseRelativeDeadline(relativeText || '');
    if (!isRelative && relativeFromQuote && quoteDates.length === 0) {
      isRelative = true;
      relativeText = relativeText || relativeFromQuote.text;
    }
    if (isRelative) {
      relativeCount++;
      if (date) notes.push('Für diese relative Frist wurde ein Enddatum vorgeschlagen. Es wurde verworfen, weil es vom Zugangsdatum abhängt.');
      date = null;
      notes.push('Relative Frist: Das Enddatum hängt davon ab, wann Sie den Brief erhalten haben. Bitte geben Sie das Zugangsdatum an.');
    }

    // Textstelle prüfen
    const quoteState = verifyQuote(quote, fullText);
    if (!quote) {
      notes.push('Zu dieser Angabe gibt es keine Textstelle aus dem Brief. Bitte besonders sorgfältig prüfen.');
      unverifiedCount++;
    } else if (quoteState === 'nicht_gefunden') {
      notes.push('Diese Textstelle wurde im erkannten Brieftext nicht gefunden. Bitte mit dem Original vergleichen.');
      unverifiedCount++;
    } else if (quoteState === 'aehnlich') {
      notes.push('Die Textstelle wurde nur sinngemäß im Brief gefunden. Bitte mit dem Original vergleichen.');
    }

    // Datum gegen Textstelle prüfen
    if (date) {
      if (quoteDates.length > 0 && !quoteDates.includes(date)) {
        notes.push('Das vorgeschlagene Datum stimmt nicht mit dem Datum in der Textstelle überein. Es wurde nicht übernommen.');
        date = null;
      } else if (quoteDates.length === 0) {
        notes.push('Das Datum steht nicht wörtlich in der Textstelle. Bitte prüfen, ob es stimmt.');
      }
    }
    if (time && quote && !timePattern(time).test(quote)) {
      notes.push('Die Uhrzeit steht nicht wörtlich in der Textstelle. Bitte prüfen.');
    }
    if (date && today && daysBetween(today, date) < 0) notes.push('Dieses Datum liegt in der Vergangenheit.');
    if (date && isWeekend(date)) notes.push('Das Datum fällt auf ein Wochenende.');
    if (!date && !isRelative && kind !== 'aufgabe') notes.push('Für diese Angabe wurde kein eindeutiges Datum gefunden.');

    let page = Number.isInteger(a?.page) && a.page > 0 && a.page < 500 ? a.page : null;
    if (page === null && quote && /--- Seite \d+ ---/.test(fullText)) {
      const idx = normalizeForSearch(fullText).indexOf(normalizeForSearch(quote).slice(0, 40));
      if (idx >= 0) {
        const before = normalizeForSearch(fullText).slice(0, idx);
        const m = [...before.matchAll(/--- seite (\d+) ---/g)].pop();
        page = m ? Number(m[1]) : null;
      }
    }

    return {
      title,
      description: strOrNull(a?.description, 800),
      kind,
      suggestedDate: date,
      suggestedTime: time,
      isRelative,
      relativeText,
      relativeRule: isRelative ? mergeRules(parseRelativeDeadline(relativeText || ''), parseRelativeDeadline(quote || '')) : null,
      quote,
      page,
      quoteFound: quoteState === 'gefunden' || quoteState === 'aehnlich' ? 1 : quoteState === 'nicht_gefunden' || !quote ? 0 : null,
      notes,
      position: index,
    };
  }, 20);

  if (relativeCount) toCheck.push('Mindestens eine Frist hängt vom Zugangsdatum ab. Geben Sie an, wann Sie den Brief erhalten haben.');
  if (unverifiedCount) toCheck.push('Nicht alle Angaben konnten im Brieftext wiedergefunden werden. Diese sind markiert.');

  const injection = r.contains_instructions_to_ai === true || looksLikeInjection(fullText);
  if (injection) {
    toCheck.unshift('Der Brief enthält Text, der wie eine Anweisung an eine KI oder ein Programm aussieht. BriefPilot hat diesen Text nicht befolgt. Seien Sie bei diesem Schreiben besonders vorsichtig.');
  }

  for (const item of cleanList(r.to_check, (t) => str(t, 300) || null, 15)) {
    if (!toCheck.includes(item)) toCheck.push(item);
  }

  return {
    sender,
    subject,
    documentType: strOrNull(r.document_type, 80),
    tags: (() => {
      const fromAi = normalizeTags(r.tags);
      return fromAi.length ? fromAi : deriveTags({ category, documentType: r.document_type, subject, text: fullText });
    })(),
    category,
    letterDate,
    letterDateStatus,
    letterDateQuote,
    references,
    amounts,
    summary: {
      what: str(r.summary_what, 2000) || null,
      nothingToDo: r.nothing_to_do === true && actions.length === 0,
      legalNote: strOrNull(r.legal_note, 1000),
      toCheck,
      language: strOrNull(r.language, 10),
      source,
    },
    actions,
    fullText,
    injection,
    identifiers,
    recipient: strOrNull(r.recipient, 200),
    senderAddress: strOrNull(r.sender_address, 300),
    senderEmail: validEmail(r.sender_email),
  };
}

function validEmail(value) {
  const v = str(value, 254);
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(v) ? v : null;
}

/**
 * Kennungen für die Zuordnung: Angaben der KI bzw. Regel-Erkennung plus eigene Suche im
 * Brieftext. Eine Nummer zählt nur, wenn sie im erkannten Text tatsächlich vorkommt –
 * so kann eine erfundene Nummer keinen Brief einer falschen Akte zuordnen.
 */
export function buildIdentifiers(references, fullText, refSource = 'ki') {
  const compactText = normalizeIdentifier('sonstiges', fullText);
  const addressText = compactAddressText(fullText);
  const inText = (kind, normalized) => (kind === 'objektadresse' ? addressText : compactText).includes(normalized);
  const out = [];
  const missing = [];
  const add = (item, source) => {
    const normalized = normalizeIdentifier(item.kind, item.value);
    if (normalized.length < 3) return;
    if (fullText && fullText.length >= 20 && !inText(item.kind, normalized)) {
      if (source !== 'regeln' && !missing.some((m) => m.value === item.value)) missing.push(item);
      return;
    }
    const existing = out.find((o) => o.normalized === normalized);
    if (existing) {
      if (existing.kind === 'sonstiges' && item.kind !== 'sonstiges') existing.kind = item.kind;
      if (!existing.status && item.status) existing.status = item.status;
      if (!existing.quote && item.quote) existing.quote = item.quote;
      return;
    }
    out.push({
      kind: item.kind, label: item.label || identifierKindLabel(item.kind), value: item.value, normalized,
      quote: item.quote || null, page: Number.isInteger(item.page) ? item.page : null, status: item.status || null, source,
    });
  };
  for (const ref of references) add(ref, refSource);
  for (const found of extractIdentifiers(fullText)) add(found, 'regeln');
  return { identifiers: out.slice(0, 40), missing };
}
