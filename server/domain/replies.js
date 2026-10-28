// Antwortbriefe: Vorlagen (ohne KI), Standardangaben (Absender/Empfänger) und Ausgabeformat.
import { formatDate } from '../../public/js/shared/dates.js';
import { identifierKind } from '../../public/js/shared/identifiers.js';

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const REPLY_TEMPLATES = [
  { id: 'fristverlaengerung', label: 'Bitte um Fristverlängerung' },
  { id: 'rueckfrage', label: 'Rückfrage / Bitte um Erklärung' },
  { id: 'ratenzahlung', label: 'Bitte um Ratenzahlung' },
  { id: 'unterlagen', label: 'Unterlagen nachreichen' },
  { id: 'widerspruch', label: 'Widerspruch / Einspruch (Vorlage)' },
  { id: 'kuendigung', label: 'Kündigung' },
  { id: 'eingang', label: 'Eingangsbestätigung' },
  { id: 'leer', label: 'Leerer Brief' },
];
export const REPLY_TEMPLATE_IDS = REPLY_TEMPLATES.map((t) => t.id);

const openTasks = (tasks) => tasks.filter((t) => !['erledigt', 'abgelehnt', 'verworfen'].includes(t.status));
const taskDate = (t) => t?.due_date || t?.suggested_date || null;

function letterText(letter) {
  return [letter.document_type, letter.subject, letter.full_text].filter(Boolean).join('\n').toLowerCase();
}

/** Aufgaben, die nach Unterlagen/Nachweisen verlangen (für „Unterlagen nachreichen“). */
function requestedDocuments(tasks) {
  return openTasks(tasks)
    .filter((t) => /unterlag|nachweis|beleg|bescheinigung|kopie|formular|vorlegen|einreichen|einsend|zusenden|nachreichen|kostenvoranschlag|fotos/i.test(`${t.title} ${t.description || ''}`))
    .map((t) => t.title.replace(/\s+/g, ' ').trim())
    .slice(0, 5);
}

/**
 * Antwortvorschläge passend zum Brief: Jede Vorlage bekommt „passt gut“ (recommended) und eine
 * kurze Begründung aus dem Brief. Empfohlene zuerst, „Leerer Brief“ immer zuletzt.
 * Alle Vorlagen bleiben wählbar – es wird nur sortiert und markiert.
 */
export function suggestReplyTemplates(letter, tasks = []) {
  const text = letterText(letter);
  const summary = parseJson(letter.summary_json, {}) || {};
  const open = openTasks(tasks);
  const amounts = parseJson(letter.amounts_json, []);
  // Freiwillige Rechte (Widerspruch, Einspruch, Kündigung) sind keine Fristen, die man verlängern kann
  const optionalRight = (t) => /widerspruch|einspruch|kündig|rechtsbehelf|nur nötig/i.test(`${t.title} ${t.description || ''} ${t.relative_text || ''}`);
  const payment = open.find((t) => t.kind === 'zahlung');
  // Verlängern lassen sich Fristen, bei denen man dem Absender etwas schuldet (zahlen, einreichen, sich melden …)
  const owesSender = (t) => t.kind === 'zahlung' || /zahl|überweis|einreich|nachreich|unterlag|nachweis|stellungnahme|äußer|melden|rückmeld|antwort|ausfüll|send|schick|übermittel|vorlegen/i.test(`${t.title} ${t.description || ''} ${t.relative_text || ''} ${t.source_quote || ''}`);
  const deadline = open.find((t) => ['frist', 'zahlung'].includes(t.kind) && (taskDate(t) || t.relative_text) && !optionalRight(t) && owesSender(t));
  const docs = requestedDocuments(tasks);
  const isTaxOffice = /finanzamt/i.test(letter.sender || '');
  const isDecision = /bescheid|festsetzung|rechtsbehelf|ablehnung|abgelehnt|rückforderung|erstattungsforderung/.test(text);
  const isDunning = /mahnung|zahlungserinnerung|inkasso|letzte aufforderung/.test(text);
  const isIncrease = /preiserhöhung|preisanpassung|beitragserhöhung|beitragsanpassung|sonderkündigungsrecht/.test(text);
  const dubious = /unseriös|betrug|vorsicht|fake|gewinnspiel|gewinn von .* gegen gebühr/i.test(`${summary.what || ''} ${(summary.toCheck || []).join(' ')} ${letter.subject || ''}`);
  const dateTxt = (t) => (taskDate(t) ? formatDate(taskDate(t), { short: true }) : t?.relative_text || '');
  const sug = dubious ? {} : {
    fristverlaengerung: deadline ? `Im Brief steht eine Frist${dateTxt(deadline) ? ` (${dateTxt(deadline)})` : ''}.` : null,
    ratenzahlung: payment || isDunning
      ? `Es geht um eine Zahlung${amounts[0] ? ` von ${amounts[0].amount} ${amounts[0].currency === 'EUR' ? '€' : amounts[0].currency || ''}`.trimEnd() : ''}.` : null,
    widerspruch: isDecision || isDunning
      ? (isDecision ? `Der Brief ist ein Bescheid – ${isTaxOffice ? 'ein Einspruch' : 'ein Widerspruch'} ist möglich, falls Sie nicht einverstanden sind.` : 'Falls die Forderung nicht stimmt, können Sie widersprechen.') : null,
    unterlagen: docs.length || /unterlagen|nachweis|belege|bescheinigung|nachreichen/.test(text)
      ? (docs.length ? `Angefordert: ${docs.slice(0, 2).join('; ')}.` : 'Im Brief geht es um Unterlagen oder Nachweise.') : null,
    kuendigung: isIncrease || /kündigungsbestätigung|vertragsverlängerung|verlängert sich automatisch/.test(text)
      ? (isIncrease ? 'Bei einer Preis- oder Beitragserhöhung ist oft eine Kündigung möglich.' : 'Der Brief betrifft die Laufzeit eines Vertrags.') : null,
  };
  if (!dubious && !Object.values(sug).some(Boolean)) {
    if (summary.toCheck?.length && open.length) sug.rueckfrage = 'Einige Angaben im Brief sind unklar.';
    else if (!open.length) sug.eingang = 'Im Brief ist nichts zu tun – falls nötig, genügt eine kurze Bestätigung.';
  }
  const rank = (id) => (id === 'leer' ? 2 : sug[id] ? 0 : 1);
  return REPLY_TEMPLATES
    .map((t, i) => ({ ...t, recommended: Boolean(sug[t.id]), reason: sug[t.id] || null, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map(({ i, ...t }) => t);
}

/** Fragen an die KI, passend zum Brief (Vorschlags-Chips). */
export function suggestQuestions(letter, tasks = []) {
  const text = letterText(letter);
  const open = openTasks(tasks);
  const payment = open.find((t) => t.kind === 'zahlung');
  const termin = open.find((t) => t.kind === 'termin');
  const summary = parseJson(letter.summary_json, {}) || {};
  const dubious = /unseriös|betrug|vorsicht|fake|gewinnspiel/i.test(`${summary.what || ''} ${(summary.toCheck || []).join(' ')}`);
  const out = dubious ? ['Ist dieser Brief seriös oder Betrug?', 'Muss ich darauf überhaupt reagieren?'] : ['Was muss ich jetzt tun?'];
  if (payment) out.push(taskDate(payment) ? `Muss ich bis zum ${formatDate(taskDate(payment), { short: true })} wirklich zahlen?` : 'Wie viel muss ich bezahlen – und bis wann?');
  if (/bescheid|rechtsbehelf/.test(text)) out.push(/finanzamt/i.test(letter.sender || '') ? 'Kann ich Einspruch einlegen – und bis wann?' : 'Kann ich widersprechen – und bis wann?');
  if (/mahnung|inkasso/.test(text)) out.push('Ist diese Mahnung berechtigt?');
  if (/preiserhöhung|preisanpassung|beitragserhöhung|beitragsanpassung/.test(text)) out.push('Darf ich wegen der Erhöhung kündigen?');
  if (termin) out.push('Was muss ich zum Termin mitbringen?');
  if (requestedDocuments(tasks).length || /unterlagen|nachweis/.test(text)) out.push('Welche Unterlagen genau soll ich schicken?');
  out.push('Erkläre den Brief in einfachen Worten.');
  out.push('Hilf mir bei einer Antwort.');
  return [...new Set(out)].slice(0, 6);
}

const REF_ORDER = ['aktenzeichen', 'versicherungsnummer', 'vertragsnummer', 'kundennummer', 'rechnungsnummer', 'schadennummer', 'steuernummer', 'mitgliedsnummer', 'kassenzeichen', 'vertragskonto', 'zaehlernummer', 'kennzeichen'];

/** Die wichtigsten Nummern des erhaltenen Briefes für Betreff und Infoblock (höchstens drei). */
export function replyReferences(letter) {
  const refs = parseJson(letter.refs_json, []);
  const ids = parseJson(letter.identifiers_json, []);
  const all = [...ids, ...refs.map((r) => ({ ...r, kind: r.kind || 'sonstiges' }))];
  const seen = new Set();
  const sorted = all
    .filter((r) => r.value && !['iban', 'objektadresse', 'anschlusskennung'].includes(r.kind))
    .sort((a, b) => {
      const ia = REF_ORDER.indexOf(a.kind);
      const ib = REF_ORDER.indexOf(b.kind);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .filter((r) => {
      const key = String(r.value).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return sorted.slice(0, 3).map((r) => ({ label: r.label || identifierKind(r.kind).label, value: r.value }));
}

function refText(refs) {
  return refs.map((r) => `${r.label} ${r.value}`).join(', ');
}

/** Vorlagentext – ohne KI, mit Platzhaltern in eckigen Klammern für fehlende Angaben. */
export function templateReply(templateId, letter, tasks = []) {
  const refs = replyReferences(letter);
  const refsLine = refs.length ? ` (${refText(refs)})` : '';
  const their = letter.letter_date ? `vom ${formatDate(letter.letter_date, { short: true })}` : '[Datum des Schreibens]';
  const topic = letter.subject || 'Ihr Schreiben';
  const subjectRefs = refs.length ? ` – ${refText(refs.slice(0, 2))}` : '';
  const isTaxOffice = /finanzamt/i.test(letter.sender || '');
  const deadline = openTasks(tasks).find((t) => t.kind === 'frist' || t.kind === 'zahlung') || tasks.find((t) => t.kind === 'frist' || t.kind === 'zahlung');
  const deadlineText = taskDate(deadline) ? ` bis zum ${formatDate(taskDate(deadline), { short: true })}` : deadline?.relative_text ? ` („${deadline.relative_text}“)` : '';
  const docs = requestedDocuments(tasks);
  const amount = parseJson(letter.amounts_json, [])[0];
  const open = 'Sehr geehrte Damen und Herren,';
  const close = 'Mit freundlichen Grüßen';
  const T = {
    fristverlaengerung: {
      subject: `Bitte um Fristverlängerung${subjectRefs}`,
      body: `${open}\n\nvielen Dank für Ihr Schreiben ${their}${refsLine}.\n\nDie darin genannte Frist${deadlineText} kann ich leider nicht einhalten, weil [Grund kurz nennen]. Ich bitte Sie daher, die Frist bis zum [neues Datum] zu verlängern.\n\nBitte bestätigen Sie mir die Verlängerung kurz schriftlich.\n\n${close}`,
    },
    rueckfrage: {
      subject: `Rückfrage zu Ihrem Schreiben ${their}${subjectRefs}`,
      body: `${open}\n\nich habe Ihr Schreiben ${their}${refsLine} erhalten. Dazu habe ich folgende Frage:\n\n[Ihre Frage]\n\nBitte erläutern Sie mir das kurz schriftlich.\n\n${close}`,
    },
    ratenzahlung: {
      subject: `Bitte um Ratenzahlung${subjectRefs}`,
      body: `${open}\n\nbezugnehmend auf Ihr Schreiben ${their}${refsLine} bitte ich Sie um eine Ratenzahlung${amount ? ` des Betrags von ${amount.amount} ${amount.currency === 'EUR' ? '€' : amount.currency}` : ''}.\n\nIch kann monatlich [Betrag] € zahlen, beginnend am [Datum]. Grund: [kurze Begründung].\n\nBitte teilen Sie mir mit, ob Sie damit einverstanden sind.\n\n${close}`,
    },
    unterlagen: {
      subject: `Nachreichung von Unterlagen${subjectRefs}`,
      body: `${open}\n\nzu Ihrem Schreiben ${their}${refsLine} reiche ich folgende Unterlagen nach:\n\n${(docs.length ? docs : ['[Unterlage 1]', '[Unterlage 2]']).map((d) => `- ${d}`).join('\n')}\n\nBitte bestätigen Sie mir den Eingang.\n\n${close}`,
    },
    widerspruch: {
      subject: `${isTaxOffice ? 'Einspruch' : 'Widerspruch'} gegen ${/bescheid/i.test(topic) ? 'den Bescheid' : 'Ihr Schreiben'} ${their}${subjectRefs}`,
      body: `${open}\n\ngegen ${/bescheid/i.test(topic) ? 'Ihren Bescheid' : 'Ihr Schreiben'} ${their}${refsLine} lege ich hiermit ${isTaxOffice ? 'Einspruch' : 'Widerspruch'} ein${amount ? ` (betroffener Betrag: ${amount.amount} ${amount.currency === 'EUR' ? '€' : amount.currency})` : ''}.\n\nBegründung: [Begründung ergänzen – oder: Die Begründung reiche ich nach.]\n\nBitte bestätigen Sie mir den Eingang dieses Schreibens.\n\n${close}`,
    },
    kuendigung: {
      subject: `Kündigung${subjectRefs}`,
      body: `${open}\n\nhiermit kündige ich den Vertrag${refsLine} ${/preiserhöhung|preisanpassung|beitragserhöhung|beitragsanpassung/i.test(`${letter.subject || ''} ${letter.full_text || ''}`) ? `wegen der in Ihrem Schreiben ${their} angekündigten Preis- bzw. Beitragserhöhung außerordentlich zum Zeitpunkt des Inkrafttretens, hilfsweise ` : ''}fristgerecht zum nächstmöglichen Zeitpunkt.\n\nBitte bestätigen Sie mir die Kündigung und das genaue Vertragsende schriftlich.\n\n${close}`,
    },
    eingang: {
      subject: `Ihr Schreiben ${their}${subjectRefs}`,
      body: `${open}\n\nhiermit bestätige ich den Erhalt Ihres Schreibens ${their}${refsLine}.\n\n[Weitere Mitteilung, falls nötig]\n\n${close}`,
    },
    leer: { subject: `Ihr Schreiben ${their}${subjectRefs}`, body: `${open}\n\n\n\n${close}` },
  };
  return T[templateId] || T.leer;
}

function addressText(a) {
  if (!a) return '';
  return [a.street, [a.zip, a.city].filter(Boolean).join(' ')].filter(Boolean).join('\n');
}

/** Standardangaben: Empfänger = Absender des Briefes; Absender = eigene Person und Hauptadresse. */
export function replyDefaults(db, user, letter) {
  const me = db.get("SELECT * FROM persons WHERE user_id = ? AND relation = 'ich' ORDER BY created_at LIMIT 1", user.id);
  const today = new Date().toISOString().slice(0, 10);
  const home = db.get(
    `SELECT * FROM addresses WHERE user_id = ? AND (valid_to IS NULL OR valid_to >= ?)
      ORDER BY is_primary DESC, CASE kind WHEN 'haushalt' THEN 0 ELSE 1 END, created_at LIMIT 1`,
    user.id, today
  );
  return {
    recipient: { name: letter.sender || '', address: letter.sender_address || '', email: letter.sender_email || '' },
    sender: {
      name: me?.name || (user.name && !user.is_demo ? user.name : user.name?.replace(/\s*\(Demo\)$/, '') || ''),
      address: addressText(home),
      email: user.is_demo || String(user.email || '').endsWith('@gast.invalid') ? '' : user.email || '',
      phone: '',
    },
    place: home?.city || '',
  };
}

export function serializeReply(row) {
  const body = row.body || '';
  return {
    id: row.id,
    letterId: row.letter_id,
    subject: row.subject,
    body,
    recipient: parseJson(row.recipient_json, {}),
    sender: parseJson(row.sender_json, {}),
    place: row.place,
    replyDate: row.reply_date,
    origin: row.origin,
    template: row.template,
    status: row.status,
    sentVia: row.sent_via,
    sentTo: row.sent_to,
    sentAt: row.sent_at,
    placeholders: (body.match(/\[[^\]\n]{2,80}\]/g) || []).length + ((row.subject || '').match(/\[[^\]\n]{2,80}\]/g) || []).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Text für E-Mail und Zwischenablage: Betreff, Text und Name. */
export function replyPlainText(reply, { withSubject = false } = {}) {
  const sender = parseJson(reply.sender_json, {});
  const body = String(reply.body || '').trim();
  const signed = sender.name && !body.endsWith(sender.name) ? `${body}\n${sender.name}` : body;
  return withSubject ? `Betreff: ${reply.subject}\n\n${signed}` : signed;
}
