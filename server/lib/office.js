// PowerPoint (.pptx), Word (.docx) und Excel (.xlsx) lesen – ohne externe Bibliotheken.
// Diese Formate sind ZIP-Archive mit XML-Dateien. Wir lesen nur den Text aus;
// Makros werden nie ausgeführt – Dateien MIT Makros werden gar nicht angenommen.
// Schutz gegen „Zip-Bomben“: Größen- und Anzahl-Grenzen beim Entpacken.
import zlib from 'node:zlib';

const MAX_ENTRIES = 5000;
const MAX_UNPACKED_TOTAL = 300 * 1024 * 1024; // insgesamt entpackt
const MAX_UNPACKED_ENTRY = 64 * 1024 * 1024; // je Datei im Archiv

export const OFFICE_TYPES = {
  pptx: { kind: 'office', format: 'pptx', ext: 'pptx', label: 'PowerPoint', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  docx: { kind: 'office', format: 'docx', ext: 'docx', label: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'office', format: 'xlsx', ext: 'xlsx', label: 'Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};
export const OFFICE_MIMES = new Set(Object.values(OFFICE_TYPES).map((t) => t.mime));

/** Liest das Inhaltsverzeichnis eines ZIP-Archivs. */
export function readZipDirectory(buf) {
  // „End of central directory“ suchen (am Ende, höchstens 64 KB Kommentar)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Kein gültiges ZIP-Archiv');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('Zu viele Dateien im Archiv');
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Beschädigtes ZIP-Archiv');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { name, flags, method, compressedSize, size, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Entpackt eine Datei aus dem Archiv (mit Größengrenze). */
export function readZipEntry(buf, entry, budget = { left: MAX_UNPACKED_TOTAL }) {
  if (!entry) return null;
  if (entry.flags & 0x1) throw new Error('Verschlüsselte Office-Dateien werden nicht unterstützt');
  const lh = entry.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Beschädigtes ZIP-Archiv');
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  const limit = Math.min(MAX_UNPACKED_ENTRY, budget.left);
  let out;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: limit });
  else throw new Error('Nicht unterstütztes Packverfahren');
  if (out.length > limit) throw new Error('Datei im Archiv zu groß');
  budget.left -= out.length;
  return out;
}

/** Erkennt PowerPoint/Word/Excel anhand des Inhalts. Gibt null zurück, wenn es keins davon ist. */
export function detectOffice(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let entries;
  try {
    entries = readZipDirectory(buf);
  } catch {
    return null;
  }
  if (!entries.has('[Content_Types].xml')) return null;
  const names = [...entries.keys()];
  const macros = names.some((n) => /vbaProject\.bin$|\/activeX\//i.test(n));
  let type = null;
  if (entries.has('ppt/presentation.xml')) type = OFFICE_TYPES.pptx;
  else if (entries.has('word/document.xml')) type = OFFICE_TYPES.docx;
  else if (entries.has('xl/workbook.xml')) type = OFFICE_TYPES.xlsx;
  if (!type) return null;
  return { ...type, macros };
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Text aus einer Office-XML-Datei: Absätze als Zeilen, Tabs als Leerzeichen. */
function xmlText(xml, textTag, paraTag) {
  const out = [];
  let line = '';
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|</${paraTag}>|<(?:w:tab|a:tab|w:br|a:br)\\b[^>]*/>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) line += decodeXml(m[1]);
    else if (m[0].startsWith('</')) { if (line.trim()) out.push(line.trim()); line = ''; }
    else line += ' ';
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}

const numericOrder = (re) => (a, b) => Number(a.match(re)?.[1] || 0) - Number(b.match(re)?.[1] || 0);

/**
 * Liest den Text einer Office-Datei.
 * @returns {{ text: string, pageCount: number, format: string }}
 */
export function extractOfficeText(buf) {
  const type = detectOffice(buf);
  if (!type) throw new Error('Keine Office-Datei');
  const entries = readZipDirectory(buf);
  const budget = { left: MAX_UNPACKED_TOTAL };
  const read = (name) => readZipEntry(buf, entries.get(name), budget)?.toString('utf8') || '';
  if (type.format === 'pptx') {
    const slides = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericOrder(/slide(\d+)\.xml$/));
    const parts = slides.map((name, i) => {
      const body = xmlText(read(name), 'a:t', 'a:p');
      const notesName = `ppt/notesSlides/notesSlide${name.match(/slide(\d+)\.xml$/)[1]}.xml`;
      const notes = entries.has(notesName) ? xmlText(read(notesName), 'a:t', 'a:p').replace(/^\d+$/m, '').trim() : '';
      return `--- Folie ${i + 1} ---\n${body}${notes ? `\n[Notizen] ${notes}` : ''}`;
    });
    return { text: parts.join('\n\n').trim(), pageCount: Math.max(1, slides.length), format: 'pptx' };
  }
  if (type.format === 'docx') {
    const text = xmlText(read('word/document.xml'), 'w:t', 'w:p');
    return { text, pageCount: Math.max(1, Math.ceil(text.length / 3000)), format: 'docx' };
  }
  // xlsx: gemeinsame Texte + Zahlen je Blatt (einfach)
  const shared = [];
  const ss = read('xl/sharedStrings.xml');
  for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(decodeXml((si.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const sheets = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(numericOrder(/sheet(\d+)\.xml$/));
  const parts = sheets.map((name, i) => {
    const rows = (read(name).match(/<row[\s\S]*?<\/row>/g) || []).slice(0, 2000).map((row) => (row.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || []).map((c) => {
      const v = (c.match(/<v>([^<]*)<\/v>/) || [])[1] ?? decodeXml((c.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/) || [])[1] || '');
      return /t="s"/.test(c) ? shared[Number(v)] ?? '' : v;
    }).join(' | '));
    return `--- Tabelle ${i + 1} ---\n${rows.join('\n')}`;
  });
  return { text: parts.join('\n\n').trim(), pageCount: Math.max(1, sheets.length), format: 'xlsx' };
}
