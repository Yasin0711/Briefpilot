// Gemeinsame Funktionen rund um Briefe: Suchtext, Ausgabeformat, Speichern von Auswertungen.
import { newId } from '../lib/security.js';
import { formatDate } from '../../public/js/shared/dates.js';
import { categoryLabel } from '../../public/js/shared/constants.js';

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const compact = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Alles, wonach gesucht werden kann, in Kleinbuchstaben zusammengefasst. */
export function buildSearchText(letter) {
  const refs = parseJson(letter.refs_json, []);
  const amounts = parseJson(letter.amounts_json, []);
  const summary = parseJson(letter.summary_json, {});
  const parts = [
    letter.sender, letter.subject, letter.document_type, categoryLabel(letter.category),
    letter.letter_date, letter.letter_date ? formatDate(letter.letter_date, { short: true }) : '',
    letter.letter_date ? formatDate(letter.letter_date) : '',
    ...refs.map((r) => `${r.label} ${r.value} ${compact(r.value)}`),
    ...parseJson(letter.identifiers_json, []).map((i) => `${i.label} ${i.value} ${compact(i.value)}`),
    ...amounts.map((a) => `${a.label} ${a.amount}`),
    letter.recipient, letter.sender_address,
    summary?.what, letter.full_text,
  ];
  return parts.filter(Boolean).join('\n').toLowerCase().slice(0, 400000);
}

export function serializeLetterSummary(row) {
  return {
    id: row.id,
    subject: row.subject,
    sender: row.sender,
    documentType: row.document_type,
    letterDate: row.letter_date,
    letterDateStatus: row.letter_date_status,
    receivedDate: row.received_date,
    uploadedAt: row.uploaded_at,
    category: row.category,
    analysisStatus: row.analysis_status,
    analysisSource: row.analysis_source,
    reviewed: Boolean(row.reviewed_at),
    injectionWarning: Boolean(row.injection_warning),
    isDemoContent: Boolean(row.is_demo_content),
    openTasks: row.open_tasks ?? undefined,
    tasksToReview: row.review_tasks ?? undefined,
    nextDue: row.next_due ?? undefined,
    pageCount: row.page_count ?? undefined,
    assignmentStatus: row.assignment_status || 'offen',
    duplicateStatus: row.duplicate_status || null,
    personId: row.person_id || null,
  };
}

export function serializeLetter(row) {
  return {
    ...serializeLetterSummary(row),
    letterDateQuote: row.letter_date_quote,
    references: parseJson(row.refs_json, []),
    amounts: parseJson(row.amounts_json, []),
    summary: parseJson(row.summary_json, null),
    fullText: row.full_text,
    analysisModel: row.analysis_model,
    analysisError: row.analysis_error,
    analyzedAt: row.analyzed_at,
    userEdited: parseJson(row.user_edited, []),
    reviewedAt: row.reviewed_at,
    identifiers: parseJson(row.identifiers_json, []),
    recipient: row.recipient || null,
    senderAddress: row.sender_address || null,
    senderEmail: row.sender_email || null,
    assignment: parseJson(row.assignment_json, null),
    duplicateOf: row.duplicate_of || null,
  };
}

export function serializeTask(row) {
  return {
    id: row.id,
    letterId: row.letter_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    suggestedDate: row.suggested_date,
    suggestedTime: row.suggested_time,
    isRelative: Boolean(row.is_relative),
    relativeText: row.relative_text,
    relativeRule: parseJson(row.relative_rule, null),
    sourceQuote: row.source_quote,
    sourcePage: row.source_page,
    quoteFound: row.quote_found === null || row.quote_found === undefined ? null : Boolean(row.quote_found),
    checkNotes: parseJson(row.check_notes, []),
    dueDate: row.due_date,
    dueTime: row.due_time,
    confirmedAt: row.confirmed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    letterSubject: row.letter_subject ?? undefined,
    letterSender: row.letter_sender ?? undefined,
  };
}

/**
 * Speichert eine geprüfte Auswertung. Vom Nutzer geänderte Felder werden nicht
 * überschrieben; bereits bestätigte oder erledigte Aufgaben bleiben erhalten.
 */
export function saveAnalysis(db, letterId, analysis, { source, model }) {
  const now = new Date().toISOString();
  db.tx(() => {
    const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
    if (!letter) return;
    const edited = new Set(parseJson(letter.user_edited, []));
    const keep = (field, value) => (edited.has(field) ? letter[field] : value);
    const updated = {
      ...letter,
      sender: keep('sender', analysis.sender),
      subject: keep('subject', analysis.subject),
      document_type: analysis.documentType,
      category: keep('category', analysis.category),
      letter_date: keep('letter_date', analysis.letterDate),
      letter_date_status: edited.has('letter_date') ? letter.letter_date_status : analysis.letterDateStatus,
      letter_date_quote: analysis.letterDateQuote,
      refs_json: edited.has('references') ? letter.refs_json : JSON.stringify(analysis.references),
      amounts_json: JSON.stringify(analysis.amounts),
      summary_json: JSON.stringify(analysis.summary),
      full_text: analysis.fullText,
      identifiers_json: edited.has('references') ? letter.identifiers_json : JSON.stringify(analysis.identifiers || []),
      recipient: analysis.recipient ?? null,
      sender_address: keep('sender_address', analysis.senderAddress ?? null),
      sender_email: keep('sender_email', analysis.senderEmail ?? null),
    };
    db.run(
      `UPDATE letters SET sender = ?, subject = ?, document_type = ?, category = ?, letter_date = ?, letter_date_status = ?,
              letter_date_quote = ?, refs_json = ?, amounts_json = ?, summary_json = ?, full_text = ?, search_text = ?,
              identifiers_json = ?, recipient = ?, sender_address = ?, sender_email = ?,
              analysis_status = 'fertig', analysis_source = ?, analysis_model = ?, analysis_error = NULL, analyzed_at = ?,
              injection_warning = ?, updated_at = ?
        WHERE id = ?`,
      updated.sender, updated.subject, updated.document_type, updated.category, updated.letter_date, updated.letter_date_status,
      updated.letter_date_quote, updated.refs_json, updated.amounts_json, updated.summary_json, updated.full_text,
      buildSearchText(updated), updated.identifiers_json, updated.recipient, updated.sender_address, updated.sender_email,
      source, model || null, now, analysis.injection ? 1 : 0, now, letterId
    );
    // Nur unbestätigte, automatisch erzeugte Vorschläge werden ersetzt
    db.run("DELETE FROM tasks WHERE letter_id = ? AND status = 'zu_pruefen' AND origin != 'nutzer'", letterId);
    for (const action of analysis.actions) {
      db.run(
        `INSERT INTO tasks (id, user_id, letter_id, title, description, kind, status, origin, suggested_date, suggested_time,
                            is_relative, relative_text, relative_rule, source_quote, source_page, quote_found, check_notes,
                            position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'zu_pruefen', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), letter.user_id, letterId, action.title, action.description, action.kind, source === 'ki' ? 'ki' : source,
        action.suggestedDate, action.suggestedTime, action.isRelative ? 1 : 0, action.relativeText,
        action.relativeRule ? JSON.stringify(action.relativeRule) : null, action.quote, action.page, action.quoteFound,
        JSON.stringify(action.notes), action.position, now, now
      );
    }
  });
}

export function markAnalysis(db, letterId, status, error = null) {
  db.run(
    'UPDATE letters SET analysis_status = ?, analysis_error = ?, updated_at = ? WHERE id = ?',
    status, error, new Date().toISOString(), letterId
  );
}

/** Für Briefe ohne Auswertung: Suchtext aus den vorhandenen Angaben neu bilden. */
export function refreshSearchText(db, letterId) {
  const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
  if (letter) db.run('UPDATE letters SET search_text = ? WHERE id = ?', buildSearchText(letter), letterId);
}
