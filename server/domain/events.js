// Verlauf eines Briefes: was wann passiert ist (ohne Briefinhalte zu duplizieren).
const MAX_DETAIL = 4000;

export const EVENT_LABELS = {
  hochgeladen: 'Brief gespeichert',
  ausgewertet: 'Brief ausgewertet',
  auswertung_fehler: 'Auswertung fehlgeschlagen',
  korrigiert: 'Angaben korrigiert',
  geprueft: 'Angaben als geprüft markiert',
  zugeordnet: 'Einer Akte zugeordnet',
  zuordnung_pruefen: 'Zuordnung zur Prüfung vorgelegt',
  zuordnung_entfernt: 'Zuordnung entfernt',
  kennung_gelernt: 'Nummer zur Akte hinzugefügt',
  frage: 'Frage an die KI',
  antwort_entwurf: 'Antwortentwurf erstellt',
  antwort_geaendert: 'Antwortentwurf bearbeitet',
  antwort_gesendet: 'Antwort versendet',
  antwort_pdf: 'Antwort als PDF erstellt',
  zusammengefuehrt: 'Mit anderem Brief zusammengeführt',
  getrennt: 'Seiten in neuen Brief verschoben',
  duplikat_verdacht: 'Möglicherweise doppelt',
  duplikat_verworfen: 'Kein Duplikat (bestätigt)',
};

export function logLetterEvent(db, userId, letterId, type, detail = null) {
  let json = null;
  if (detail) {
    json = JSON.stringify(detail);
    if (json.length > MAX_DETAIL) json = JSON.stringify({ gekuerzt: true });
  }
  db.run(
    'INSERT INTO letter_events (user_id, letter_id, type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, letterId, type, json, new Date().toISOString()
  );
}

export function letterEvents(db, letterId) {
  return db.all('SELECT id, type, detail_json, created_at FROM letter_events WHERE letter_id = ? ORDER BY id', letterId).map((e) => {
    let detail = null;
    try {
      detail = e.detail_json ? JSON.parse(e.detail_json) : null;
    } catch {
      detail = null;
    }
    return { id: e.id, type: e.type, label: EVENT_LABELS[e.type] || e.type, detail, at: e.created_at };
  });
}
