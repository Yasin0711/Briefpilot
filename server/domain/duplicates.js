// Erkennung doppelter Briefe – auch wenn derselbe Brief zweimal gescannt wurde
// (dann unterscheiden sich die Dateien, der Inhalt aber kaum).
import { orgKey } from '../../public/js/shared/identifiers.js';
import { logLetterEvent } from './events.js';

const SHINGLE = 3;
const TEXT_THRESHOLD = 0.9;

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/--- seite \d+ ---/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

function shingles(text) {
  const t = tokens(text);
  const out = new Set();
  for (let i = 0; i + SHINGLE <= t.length; i++) out.add(t.slice(i, i + SHINGLE).join(' '));
  if (!out.size && t.length) out.add(t.join(' '));
  return out;
}

/** Ähnlichkeit zweier Texte (Jaccard über Wortgruppen), 0 bis 1. */
export function textSimilarity(a, b) {
  const sa = shingles(a);
  const sb = shingles(b);
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common++;
  return common / (sa.size + sb.size - common);
}

/** Hamming-Abstand zweier 64-Bit-Bild-Fingerabdrücke (16 Hex-Zeichen) – nur für Tests und Auswertungen. */
export function hashDistance(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a || '') || !/^[0-9a-f]{16}$/.test(b || '')) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Sucht einen bereits gespeicherten Brief mit (nahezu) gleichem Inhalt. */
export function findDuplicate(db, letter) {
  const params = [letter.user_id, letter.id];
  let where = 'user_id = ? AND id != ? AND analysis_status IN (\'fertig\', \'nicht_moeglich\')';
  if (letter.letter_date) {
    where += ' AND letter_date = ?';
    params.push(letter.letter_date);
  } else {
    where += ' AND letter_date IS NULL AND uploaded_at >= ?';
    params.push(new Date(Date.parse(letter.uploaded_at) - 120 * 86400_000).toISOString());
  }
  const candidates = db.all(`SELECT id, subject, sender, full_text, letter_date, uploaded_at FROM letters WHERE ${where} ORDER BY uploaded_at DESC LIMIT 25`, ...params);
  const senderKey = orgKey(letter.sender);
  if (letter.full_text && letter.full_text.length >= 80) {
    for (const c of candidates) {
      if (senderKey && orgKey(c.sender) && orgKey(c.sender) !== senderKey) continue;
      const sim = textSimilarity(letter.full_text, c.full_text);
      if (sim >= TEXT_THRESHOLD) return { id: c.id, similarity: Math.round(sim * 100) / 100, via: 'text' };
    }
  }
  // Ohne lesbaren Text: dieselben Dateien (bytegleich) schon einmal als Brief gespeichert?
  // Bild-Fingerabdrücke werden bewusst nicht verglichen: Tests mit echten Scans zeigten, dass
  // dieselbe Seite je nach Licht und Zuschnitt sehr verschiedene Werte ergibt, Briefe mit gleichem
  // Aufbau (z. B. monatliche Rechnungen) dagegen fast gleiche – das gäbe falsche Warnungen.
  const pages = db.all("SELECT sha256 FROM files WHERE letter_id = ? AND role = 'seite' ORDER BY position", letter.id).map((f) => f.sha256);
  if (pages.length) {
    const others = db.all(
      `SELECT f.letter_id, f.sha256 FROM files f JOIN letters l ON l.id = f.letter_id
        WHERE f.user_id = ? AND f.letter_id != ? AND f.role = 'seite' AND f.sha256 IN (${pages.map(() => '?').join(', ')})`,
      letter.user_id, letter.id, ...pages
    );
    const byLetter = new Map();
    for (const o of others) {
      if (!byLetter.has(o.letter_id)) byLetter.set(o.letter_id, new Set());
      byLetter.get(o.letter_id).add(o.sha256);
    }
    for (const [otherId, hashes] of byLetter) {
      const count = db.get("SELECT COUNT(*) AS n FROM files WHERE letter_id = ? AND role = 'seite'", otherId).n;
      if (count === pages.length && pages.every((h) => hashes.has(h))) return { id: otherId, similarity: 1, via: 'datei' };
    }
  }
  return null;
}

/** Prüft nach der Auswertung auf Duplikate und merkt einen Verdacht vor (nichts wird gelöscht). */
export function checkDuplicate(db, letterId) {
  const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
  if (!letter || letter.duplicate_status === 'kein_duplikat') return null;
  const dup = findDuplicate(db, letter);
  if (dup) {
    if (letter.duplicate_of !== dup.id) {
      db.run("UPDATE letters SET duplicate_of = ?, duplicate_status = 'verdacht' WHERE id = ?", dup.id, letterId);
      logLetterEvent(db, letter.user_id, letterId, 'duplikat_verdacht', { aehnlichkeit: dup.similarity, ueber: dup.via });
    }
  } else if (letter.duplicate_status === 'verdacht') {
    db.run('UPDATE letters SET duplicate_of = NULL, duplicate_status = NULL WHERE id = ?', letterId);
  }
  return dup;
}
