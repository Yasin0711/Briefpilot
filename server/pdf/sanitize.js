// Entschärft PDF-Dateien mit aktiven Inhalten (JavaScript, Startaktionen, Programmaufrufe …).
//
// Vorgehen: Die PDF wird vollständig neu geschrieben – jedes Objekt einzeln, komprimierte
// Objekt-Sammlungen ausgepackt, mit neuem Inhaltsverzeichnis (xref). Dabei werden alle
// Einträge entfernt, über die ein PDF-Programm Code ausführen oder Aktionen auslösen kann.
// Seiten, Text, Bilder, Schriften, Formularfelder und normale Links bleiben erhalten.
// Das Ergebnis enthält keinen ausführbaren Inhalt mehr – egal, mit welchem Programm es
// später geöffnet wird.
import { PdfDocument, Name, Ref, Op, Lexer, parseValue } from './extract.js';

// Einträge, die Code ausführen oder automatisch Aktionen auslösen können
const DANGEROUS_KEYS = new Set([
  'JS', 'JavaScript', 'OpenAction', 'AA', 'XFA', 'NeedsRendering',
  'RichMediaContent', 'RichMediaSettings', 'RichMediaExecute',
]);
// Aktionsarten, die Code ausführen, Programme starten, Daten senden/laden oder Medien abspielen
const DANGEROUS_ACTIONS = new Set([
  'JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'RichMediaExecute',
  'Rendition', 'Movie', 'Sound', 'GoToE', 'GoToR',
]);
const SCRIPT_URI = /^\s*(javascript|vbscript|data|file):/i;
// Anmerkungsarten mit eingebetteten, aktiven Medien
const DANGEROUS_ANNOTS = new Set(['RichMedia', 'Screen', 'Movie', 'Sound', '3D']);

function isName(v, name) {
  return v instanceof Name && (name === undefined || v.name === name);
}

/** Entfernt aktive Inhalte aus einem Wert (rekursiv). Zählt Entfernungen in stats.removed. */
function neutralize(value, stats, depth = 0) {
  if (depth > 100) return value;
  if (Array.isArray(value)) return value.map((v) => neutralize(v, stats, depth + 1));
  if (!(value instanceof Map)) return value;
  const out = new Map();
  const action = value.get('S');
  const uri = value.get('URI');
  const scriptUri = isName(action, 'URI') && Buffer.isBuffer(uri) && SCRIPT_URI.test(uri.toString('latin1'));
  if ((isName(action) && DANGEROUS_ACTIONS.has(action.name)) || scriptUri) {
    // Gefährliche Aktion: durch eine wirkungslose ersetzen (Struktur bleibt gültig)
    stats.removed++;
    return new Map([['Type', new Name('Action')], ['S', new Name('Named')], ['N', new Name('NoOp')]]);
  }
  const isAnnot = value.has('Rect') || isName(value.get('Type'), 'Annot');
  for (const [key, v] of value) {
    if (DANGEROUS_KEYS.has(key)) { stats.removed++; continue; }
    if (key === 'Subtype' && isAnnot && isName(v) && DANGEROUS_ANNOTS.has(v.name)) {
      out.set(key, new Name('Square')); // aktive Medien-Anmerkung → harmlose Form
      stats.removed++;
      continue;
    }
    out.set(key, neutralize(v, stats, depth + 1));
  }
  return out;
}

// ---------- Schreiben ----------

function escapeName(name) {
  let out = '';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) out += `#${(c & 0xff).toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

function serialize(v, depth = 0) {
  if (depth > 100) return 'null';
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return formatNumber(v);
  if (v instanceof Name) return `/${escapeName(v.name)}`;
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (Buffer.isBuffer(v)) return `<${v.toString('hex')}>`;
  if (Array.isArray(v)) return `[${v.map((x) => serialize(x, depth + 1)).join(' ')}]`;
  if (v instanceof Map) {
    const parts = [];
    for (const [k, x] of v) parts.push(`/${escapeName(k)} ${serialize(x, depth + 1)}`);
    return `<<${parts.join(' ')}>>`;
  }
  if (v instanceof Op) return 'null';
  return 'null';
}

/** Root- und Info-Verweis aus dem letzten Trailer bzw. dem Querverweis-Stream lesen. */
function findTrailerRefs(doc, buf) {
  const raw = buf.toString('latin1');
  let root = null;
  let info = null;
  let idx = raw.lastIndexOf('trailer');
  while (idx >= 0 && !root) {
    try {
      const dict = parseValue(new Lexer(buf, idx + 7));
      if (dict instanceof Map) {
        if (dict.get('Root') instanceof Ref) root = dict.get('Root');
        if (dict.get('Info') instanceof Ref) info = info || dict.get('Info');
      }
    } catch { /* weiter suchen */ }
    idx = raw.lastIndexOf('trailer', idx - 1);
  }
  if (!root) {
    for (const [, obj] of doc.objects) {
      const v = obj.value;
      if (v instanceof Map && isName(v.get('Type'), 'XRef') && v.get('Root') instanceof Ref) {
        root = v.get('Root');
        if (v.get('Info') instanceof Ref) info = v.get('Info');
      }
    }
  }
  if (!root) {
    for (const [num, obj] of doc.objects) {
      if (obj.value instanceof Map && isName(obj.value.get('Type'), 'Catalog')) { root = new Ref(num, obj.gen || 0); break; }
    }
  }
  return { root, info };
}

/** Rohdaten eines Streams – bei indirekter Längenangabe exakt nach /Length. */
function streamBytes(doc, buf, obj) {
  const dict = obj.value instanceof Map ? obj.value : new Map();
  const len = dict.get('Length');
  if (len instanceof Ref) {
    const n = doc.resolve(len);
    const start = obj.stream.byteOffset - buf.byteOffset;
    if (typeof n === 'number' && n >= 0 && start >= 0 && start + n <= buf.length) return buf.subarray(start, start + n);
  }
  return obj.stream;
}

/**
 * Schreibt die PDF ohne aktive Inhalte neu.
 * @returns {{ pdf: Buffer, removed: number }}
 */
export function sanitizePdf(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const doc = new PdfDocument(buf);
  if (doc.isEncrypted()) throw new Error('Verschlüsselte PDF-Dateien werden nicht unterstützt.');
  const { root, info } = findTrailerRefs(doc, buf);
  if (!root || !doc.objects.has(root.num)) throw new Error('Die PDF-Datei hat keinen gültigen Katalog.');
  const stats = { removed: 0 };
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0].length;
  const offsets = new Map();
  const nums = [...doc.objects.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const obj = doc.objects.get(num);
    const v = obj.value;
    if (v instanceof Map && (isName(v.get('Type'), 'XRef') || isName(v.get('Type'), 'ObjStm'))) continue;
    const gen = obj.gen || 0;
    let body;
    if (obj.stream) {
      const data = streamBytes(doc, buf, obj);
      const dict = neutralize(v instanceof Map ? v : new Map(), stats);
      dict.set('Length', data.length);
      body = Buffer.concat([
        Buffer.from(`${num} ${gen} obj\n${serialize(dict)}\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      body = Buffer.from(`${num} ${gen} obj\n${serialize(neutralize(v, stats))}\nendobj\n`, 'latin1');
    }
    offsets.set(num, { pos, gen });
    chunks.push(body);
    pos += body.length;
  }
  const size = (nums.length ? nums[nums.length - 1] : 0) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    const o = offsets.get(i);
    xref += o ? `${String(o.pos).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n` : '0000000000 65535 f \n';
  }
  const trailer = new Map([['Size', size], ['Root', root]]);
  if (info && offsets.has(info.num)) trailer.set('Info', info);
  chunks.push(Buffer.from(`${xref}trailer\n${serialize(trailer)}\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return { pdf: Buffer.concat(chunks), removed: stats.removed };
}

/** Prüft, ob eine PDF (nach dem Entschärfen) noch aktive Einträge in ihren Objekten hat. */
export function hasActiveObjects(input) {
  const doc = new PdfDocument(Buffer.isBuffer(input) ? input : Buffer.from(input));
  let found = false;
  const walk = (v, d = 0) => {
    if (found || d > 100) return;
    if (Array.isArray(v)) v.forEach((x) => walk(x, d + 1));
    else if (v instanceof Map) {
      for (const [k, x] of v) {
        if (DANGEROUS_KEYS.has(k)) { found = true; return; }
        if (k === 'S' && isName(x) && DANGEROUS_ACTIONS.has(x.name)) { found = true; return; }
        if (k === 'URI' && Buffer.isBuffer(x) && SCRIPT_URI.test(x.toString('latin1'))) { found = true; return; }
        walk(x, d + 1);
      }
    }
  };
  for (const [, obj] of doc.objects) walk(obj.value);
  return found;
}

// ---------- Auszug: nur die ersten Seiten (für die KI bei langen gescannten Dokumenten) ----------

function collectPageRefs(doc, rootRef, max) {
  const out = [];
  const catalog = doc.resolve(rootRef);
  const pagesRef = catalog instanceof Map ? catalog.get('Pages') : null;
  const visit = (ref, inherited, depth) => {
    if (out.length >= max || depth > 50) return;
    const node = doc.resolve(ref);
    if (!(node instanceof Map)) return;
    const inh = { ...inherited };
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) inh[k] = node.get(k);
    const kids = doc.resolve(node.get('Kids'));
    if (Array.isArray(kids) && !isName(node.get('Type'), 'Page')) {
      for (const kid of kids) visit(kid, inh, depth + 1);
    } else if (ref instanceof Ref) {
      out.push({ ref, inherited: inh });
    }
  };
  if (pagesRef) visit(pagesRef, {}, 0);
  return out;
}

/**
 * Neue PDF mit nur den ersten `maxPages` Seiten (ohne Lesezeichen, Formulare, Links).
 * Nicht mehr benötigte Bilder und Schriften fallen weg, damit die Datei klein bleibt.
 * @returns {{ pdf: Buffer, pages: number, total: number }}
 */
export function subsetPdf(input, maxPages) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const doc = new PdfDocument(buf);
  const { root } = findTrailerRefs(doc, buf);
  if (!root) throw new Error('Die PDF-Datei hat keinen gültigen Katalog.');
  const all = collectPageRefs(doc, root, Number.MAX_SAFE_INTEGER);
  const keep = all.slice(0, maxPages);
  if (!keep.length) throw new Error('Keine Seiten gefunden.');
  const nums = [...doc.objects.keys()];
  const pagesNum = Math.max(...nums) + 1;
  const catalogNum = pagesNum + 1;
  const override = new Map();
  override.set(pagesNum, { value: new Map([['Type', new Name('Pages')], ['Kids', keep.map((p) => p.ref)], ['Count', keep.length]]), stream: null, gen: 0 });
  override.set(catalogNum, { value: new Map([['Type', new Name('Catalog')], ['Pages', new Ref(pagesNum, 0)]]), stream: null, gen: 0 });
  for (const p of keep) {
    const obj = doc.objects.get(p.ref.num);
    const dict = new Map(doc.resolve(p.ref));
    for (const [k, v] of Object.entries(p.inherited)) if (!dict.has(k)) dict.set(k, v);
    dict.set('Parent', new Ref(pagesNum, 0));
    for (const k of ['Annots', 'B', 'AA', 'StructParents', 'Thumb']) dict.delete(k);
    override.set(p.ref.num, { value: dict, stream: null, gen: obj?.gen || 0 });
  }
  const get = (num) => override.get(num) || doc.objects.get(num);
  // Erreichbare Objekte ab dem neuen Katalog
  const reachable = new Set();
  const stack = [catalogNum];
  const walk = (v, d = 0) => {
    if (d > 100) return;
    if (v instanceof Ref) { if (!reachable.has(v.num)) stack.push(v.num); return; }
    if (Array.isArray(v)) v.forEach((x) => walk(x, d + 1));
    else if (v instanceof Map) for (const [, x] of v) walk(x, d + 1);
  };
  while (stack.length) {
    const num = stack.pop();
    if (reachable.has(num)) continue;
    const obj = get(num);
    if (!obj) continue;
    reachable.add(num);
    walk(obj.value);
  }
  const stats = { removed: 0 };
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0].length;
  const offsets = new Map();
  for (const num of [...reachable].sort((a, b) => a - b)) {
    const obj = get(num);
    const gen = obj.gen || 0;
    let body;
    if (obj.stream) {
      const data = streamBytes(doc, buf, obj);
      const dict = neutralize(obj.value instanceof Map ? obj.value : new Map(), stats);
      dict.set('Length', data.length);
      body = Buffer.concat([Buffer.from(`${num} ${gen} obj\n${serialize(dict)}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      body = Buffer.from(`${num} ${gen} obj\n${serialize(neutralize(obj.value, stats))}\nendobj\n`, 'latin1');
    }
    offsets.set(num, { pos, gen });
    chunks.push(body);
    pos += body.length;
  }
  const size = Math.max(...reachable) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    const o = offsets.get(i);
    xref += o ? `${String(o.pos).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n` : '0000000000 65535 f \n';
  }
  chunks.push(Buffer.from(`${xref}trailer\n<</Size ${size} /Root ${catalogNum} 0 R>>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return { pdf: Buffer.concat(chunks), pages: keep.length, total: all.length };
}
