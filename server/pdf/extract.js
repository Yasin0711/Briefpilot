// Liest Text aus PDF-Dateien (ohne externe Bibliotheken) und prüft PDFs auf
// gefährliche Inhalte. Funktioniert für die meisten digital erzeugten PDFs
// (z. B. Rechnungen aus Onlineportalen). Eingescannte PDFs enthalten nur Bilder –
// dort findet diese Funktion keinen Text; dafür wird die KI-Texterkennung benötigt.
import zlib from 'node:zlib';
import { WIN_ANSI, MAC_ROMAN, STANDARD, glyphToUnicode } from './encodings.js';

class Name {
  constructor(value) {
    this.name = value;
  }
}
class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}
class Op {
  constructor(op) {
    this.op = op;
  }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Lexer {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipWhitespace() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  token() {
    this.skipWhitespace();
    const b = this.buf;
    if (this.pos >= b.length) return { t: 'eof' };
    const c = b[this.pos];
    if (c === 0x5b) { this.pos++; return { t: '[' }; }
    if (c === 0x5d) { this.pos++; return { t: ']' }; }
    if (c === 0x7b || c === 0x7d) { this.pos++; return { t: 'kw', v: String.fromCharCode(c) }; }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { this.pos += 2; return { t: '<<' }; }
      return { t: 'str', v: this.hexString() };
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) { this.pos += 2; return { t: '>>' }; }
      this.pos++;
      return { t: 'kw', v: '>' };
    }
    if (c === 0x28) return { t: 'str', v: this.literalString() };
    if (c === 0x2f) return { t: 'name', v: this.name() };
    const start = this.pos;
    while (this.pos < b.length && !WHITESPACE.has(b[this.pos]) && !DELIMITERS.has(b[this.pos])) this.pos++;
    if (this.pos === start) { this.pos++; return { t: 'kw', v: String.fromCharCode(c) }; }
    const word = b.toString('latin1', start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word) };
    return { t: 'kw', v: word };
  }

  name() {
    const b = this.buf;
    this.pos++;
    const start = this.pos;
    while (this.pos < b.length && !WHITESPACE.has(b[this.pos]) && !DELIMITERS.has(b[this.pos])) this.pos++;
    return b.toString('latin1', start, this.pos).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  hexString() {
    const b = this.buf;
    this.pos++;
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(b[this.pos]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      this.pos++;
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }

  literalString() {
    const b = this.buf;
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === 0x6e) out.push(0x0a);
        else if (n === 0x72) out.push(0x0d);
        else if (n === 0x74) out.push(0x09);
        else if (n === 0x62) out.push(0x08);
        else if (n === 0x66) out.push(0x0c);
        else if (n === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; }
        else if (n === 0x0a) { /* Zeilenfortsetzung */ }
        else if (n >= 0x30 && n <= 0x37) {
          let oct = n - 0x30;
          for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) oct = oct * 8 + (b[this.pos++] - 0x30);
          out.push(oct & 0xff);
        } else if (n !== undefined) out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Buffer.from(out);
  }
}

/** Liest ein PDF-Objekt (Zahl, Name, String, Array, Dictionary, Referenz). */
function parseValue(lex, allowOps = false, depth = 0) {
  if (depth > 100) throw new Error('PDF zu tief verschachtelt');
  const tok = lex.token();
  switch (tok.t) {
    case 'eof': return undefined;
    case 'num': {
      if (Number.isInteger(tok.v) && tok.v >= 0) {
        const save = lex.pos;
        const t2 = lex.token();
        if (t2.t === 'num' && Number.isInteger(t2.v)) {
          const t3 = lex.token();
          if (t3.t === 'kw' && t3.v === 'R') return new Ref(tok.v, t2.v);
        }
        lex.pos = save;
      }
      return tok.v;
    }
    case 'name': return new Name(tok.v);
    case 'str': return tok.v;
    case '[': {
      const arr = [];
      for (;;) {
        const save = lex.pos;
        const t = lex.token();
        if (t.t === ']' || t.t === 'eof') break;
        lex.pos = save;
        const v = parseValue(lex, false, depth + 1);
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    case '<<': {
      const dict = new Map();
      for (;;) {
        const t = lex.token();
        if (t.t === '>>' || t.t === 'eof') break;
        if (t.t !== 'name') continue;
        const v = parseValue(lex, false, depth + 1);
        dict.set(t.v, v);
      }
      return dict;
    }
    case 'kw':
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return allowOps ? new Op(tok.v) : new Op(tok.v);
    default:
      return undefined;
  }
}

// Obergrenze gegen „Zip-Bomben“: entpackte Inhalte dürfen höchstens 64 MB groß werden
const MAX_INFLATE = 64 * 1024 * 1024;

function inflate(data) {
  const attempts = [
    () => zlib.inflateSync(data, { maxOutputLength: MAX_INFLATE }),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATE }),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATE }),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      /* nächste Variante versuchen */
    }
  }
  return null;
}

function asciiHex(data) {
  const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
  return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
}

function ascii85(data) {
  const s = data.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

class PdfDocument {
  constructor(buf) {
    this.buf = buf;
    this.objects = new Map();
    this.decodedObjectStreams = [];
    this.fontCache = new Map();
    this.parseObjects();
  }

  parseObjects() {
    const buf = this.buf;
    const s = buf.toString('latin1');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const lex = new Lexer(buf, m.index + m[0].length);
      let value;
      try {
        value = parseValue(lex);
      } catch {
        continue;
      }
      lex.skipWhitespace();
      let stream = null;
      if (s.startsWith('stream', lex.pos)) {
        let start = lex.pos + 6;
        if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
        else if (buf[start] === 0x0a || buf[start] === 0x0d) start += 1;
        const len = value instanceof Map ? value.get('Length') : undefined;
        let end;
        if (typeof len === 'number' && start + len <= buf.length && s.slice(start + len, start + len + 40).includes('endstream')) {
          end = start + len;
        } else {
          end = s.indexOf('endstream', start);
          if (end < 0) end = buf.length;
          while (end > start && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
        }
        stream = buf.subarray(start, end);
        re.lastIndex = end;
      } else if (lex.pos > re.lastIndex) {
        re.lastIndex = lex.pos;
      }
      this.objects.set(num, { value, stream, gen: Number(m[2]) || 0 });
    }

    // Komprimierte Objekt-Sammlungen (ab PDF 1.5) auspacken
    for (const [, obj] of [...this.objects]) {
      if (!(obj.value instanceof Map) || !obj.stream) continue;
      if (this.nameOf(obj.value.get('Type')) !== 'ObjStm') continue;
      const data = this.decodeStream(obj);
      if (!data) continue;
      this.decodedObjectStreams.push(data.toString('latin1'));
      const n = this.resolve(obj.value.get('N'));
      const first = this.resolve(obj.value.get('First'));
      if (typeof n !== 'number' || typeof first !== 'number') continue;
      const lex = new Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n && i < 100000; i++) {
        const a = lex.token();
        const b = lex.token();
        if (a.t !== 'num' || b.t !== 'num') break;
        pairs.push([a.v, b.v]);
      }
      for (const [num, offset] of pairs) {
        if (this.objects.has(num)) continue;
        try {
          const value = parseValue(new Lexer(data, first + offset));
          this.objects.set(num, { value, stream: null, gen: 0, inObjStm: true });
        } catch {
          /* beschädigtes Objekt überspringen */
        }
      }
    }
  }

  resolve(value, depth = 0) {
    if (value instanceof Ref && depth < 20) {
      const obj = this.objects.get(value.num);
      return obj ? this.resolve(obj.value, depth + 1) : undefined;
    }
    return value;
  }

  objectOf(value) {
    if (value instanceof Ref) return this.objects.get(value.num);
    return null;
  }

  nameOf(value) {
    const v = this.resolve(value);
    return v instanceof Name ? v.name : undefined;
  }

  decodeStream(obj) {
    if (!obj || !obj.stream) return null;
    const dict = obj.value instanceof Map ? obj.value : new Map();
    let filters = this.resolve(dict.get('Filter'));
    if (!filters) return obj.stream;
    if (!Array.isArray(filters)) filters = [filters];
    let data = obj.stream;
    for (const f of filters) {
      const name = this.nameOf(f);
      if (name === 'FlateDecode' || name === 'Fl') data = inflate(data);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else return null;
      if (!data) return null;
    }
    return data;
  }

  isEncrypted() {
    const tail = this.buf.subarray(Math.max(0, this.buf.length - 4096)).toString('latin1');
    if (/\/Encrypt\s/.test(tail)) return true;
    for (const [, obj] of this.objects) {
      if (obj.value instanceof Map && obj.value.has('Encrypt') && (this.nameOf(obj.value.get('Type')) === 'XRef' || obj.value.has('Root'))) return true;
    }
    return /trailer[\s\S]{0,2000}\/Encrypt/.test(this.buf.toString('latin1'));
  }

  pages() {
    const result = [];
    let rootPages = null;
    for (const [, obj] of this.objects) {
      if (obj.value instanceof Map && this.nameOf(obj.value.get('Type')) === 'Catalog') {
        rootPages = obj.value.get('Pages');
        break;
      }
    }
    const seen = new Set();
    const visit = (ref, inheritedResources, depth) => {
      if (depth > 40) return;
      const key = ref instanceof Ref ? ref.num : null;
      if (key !== null) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = this.resolve(ref);
      if (!(node instanceof Map)) return;
      const resources = node.has('Resources') ? node.get('Resources') : inheritedResources;
      const kids = this.resolve(node.get('Kids'));
      if (this.nameOf(node.get('Type')) === 'Pages' || Array.isArray(kids)) {
        for (const kid of kids || []) visit(kid, resources, depth + 1);
      } else {
        result.push({ dict: node, resources });
      }
    };
    if (rootPages) visit(rootPages, null, 0);
    if (!result.length) {
      for (const [, obj] of this.objects) {
        if (obj.value instanceof Map && this.nameOf(obj.value.get('Type')) === 'Page') {
          result.push({ dict: obj.value, resources: obj.value.get('Resources') });
        }
      }
    }
    return result;
  }

  // ---------- Schriften ----------

  fontFor(fontRef) {
    const cacheKey = fontRef instanceof Ref ? fontRef.num : fontRef;
    if (this.fontCache.has(cacheKey)) return this.fontCache.get(cacheKey);
    const font = this.resolve(fontRef);
    const decoder = this.buildFont(font instanceof Map ? font : new Map());
    this.fontCache.set(cacheKey, decoder);
    return decoder;
  }

  buildFont(font) {
    const subtype = this.nameOf(font.get('Subtype'));
    let cmap = null;
    const toUnicode = font.get('ToUnicode');
    if (toUnicode) {
      const obj = this.objectOf(toUnicode);
      const data = this.decodeStream(obj);
      if (data) cmap = parseCMap(data.toString('latin1'));
    }
    if (subtype === 'Type0') {
      const bytes = cmap?.codeLength || 2;
      const descendants = this.resolve(font.get('DescendantFonts'));
      const cid = Array.isArray(descendants) ? this.resolve(descendants[0]) : null;
      const defaultWidth = cid instanceof Map && typeof this.resolve(cid.get('DW')) === 'number' ? this.resolve(cid.get('DW')) : 1000;
      const widths = new Map();
      const w = cid instanceof Map ? this.resolve(cid.get('W')) : null;
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length;) {
          const first = this.resolve(w[i]);
          const next = this.resolve(w[i + 1]);
          if (Array.isArray(next)) {
            next.forEach((width, j) => widths.set(first + j, this.resolve(width)));
            i += 2;
          } else {
            const last = next;
            const width = this.resolve(w[i + 2]);
            if (typeof first === 'number' && typeof last === 'number' && last - first < 65536) {
              for (let c = first; c <= last; c++) widths.set(c, width);
            }
            i += 3;
          }
        }
      }
      return {
        bytes,
        decode: (buf) => {
          let out = '';
          let advance = 0;
          for (let i = 0; i + bytes <= buf.length; i += bytes) {
            const code = bytes === 2 ? buf.readUInt16BE(i) : buf[i];
            out += cmap?.map.get(code) ?? '';
            advance += (widths.get(code) ?? defaultWidth) / 1000;
          }
          return { text: out, advance };
        },
      };
    }
    let table = STANDARD;
    const enc = this.resolve(font.get('Encoding'));
    const encName = enc instanceof Name ? enc.name : enc instanceof Map ? this.nameOf(enc.get('BaseEncoding')) : undefined;
    if (encName === 'WinAnsiEncoding') table = WIN_ANSI;
    else if (encName === 'MacRomanEncoding') table = MAC_ROMAN;
    else if (!encName) table = WIN_ANSI;
    table = [...table];
    if (enc instanceof Map) {
      const diffs = this.resolve(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const item of diffs) {
          if (typeof item === 'number') code = item;
          else if (item instanceof Name) {
            if (code >= 0 && code < 256) table[code] = glyphToUnicode(item.name);
            code++;
          }
        }
      }
    }
    const firstChar = this.resolve(font.get('FirstChar'));
    const widthList = this.resolve(font.get('Widths'));
    const descriptor = this.resolve(font.get('FontDescriptor'));
    const missing = descriptor instanceof Map && typeof this.resolve(descriptor.get('MissingWidth')) === 'number'
      ? this.resolve(descriptor.get('MissingWidth')) : 500;
    const widthOf = (code) => {
      if (Array.isArray(widthList) && typeof firstChar === 'number') {
        const v = this.resolve(widthList[code - firstChar]);
        if (typeof v === 'number') return v;
      }
      return missing;
    };
    return {
      bytes: 1,
      decode: (buf) => {
        let out = '';
        let advance = 0;
        for (const byte of buf) {
          out += cmap?.map.get(byte) ?? table[byte] ?? '';
          advance += widthOf(byte) / 1000;
        }
        return { text: out, advance };
      },
    };
  }

  // ---------- Seiteninhalt ----------

  pageText(page) {
    const contents = this.resolve(page.dict.get('Contents'));
    const refs = Array.isArray(contents) ? contents : [page.dict.get('Contents')];
    const parts = [];
    for (const ref of refs) {
      const obj = this.objectOf(ref);
      const data = this.decodeStream(obj);
      if (data) parts.push(data);
    }
    const state = { lines: [], current: '', lastY: null, lastEndX: null };
    this.runContent(Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')])), page.resources, state, 0);
    if (state.current.trim()) state.lines.push(state.current);
    return state.lines.map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  runContent(data, resourcesRef, state, depth) {
    if (depth > 4) return;
    const resources = this.resolve(resourcesRef);
    const fontDict = resources instanceof Map ? this.resolve(resources.get('Font')) : null;
    const xobjects = resources instanceof Map ? this.resolve(resources.get('XObject')) : null;
    const lex = new Lexer(data, 0);
    const operands = [];
    let font = null;
    let fontSize = 10;
    let leading = 0;
    let tm = [1, 0, 0, 1, 0, 0];
    let lm = [1, 0, 0, 1, 0, 0];
    let guard = 0;

    const newline = () => {
      if (state.current.trim()) state.lines.push(state.current);
      state.current = '';
    };

    const show = (bytes) => {
      if (!font || !(bytes instanceof Buffer)) return;
      const { text, advance } = font.decode(bytes);
      const scale = Math.hypot(tm[0], tm[1]) || 1;
      const size = fontSize * scale;
      const x = tm[4];
      const y = tm[5];
      if (state.lastY !== null && Math.abs(y - state.lastY) > Math.max(size, 2) * 0.5) newline();
      else if (state.lastEndX !== null && x > state.lastEndX + size * 0.2 && state.current && !state.current.endsWith(' ')) state.current += ' ';
      state.current += text;
      tm[4] += advance * fontSize * scale;
      state.lastY = y;
      state.lastEndX = tm[4];
    };

    const translate = (tx, ty) => {
      lm = [lm[0], lm[1], lm[2], lm[3], tx * lm[0] + ty * lm[2] + lm[4], tx * lm[1] + ty * lm[3] + lm[5]];
      tm = [...lm];
    };

    while (guard++ < 2_000_000) {
      let value;
      try {
        value = parseValue(lex, true);
      } catch {
        break;
      }
      if (value === undefined) break;
      if (!(value instanceof Op)) {
        operands.push(value);
        if (operands.length > 64) operands.shift();
        continue;
      }
      const op = value.op;
      const args = operands.splice(0, operands.length);
      switch (op) {
        case 'BT':
          tm = [1, 0, 0, 1, 0, 0];
          lm = [1, 0, 0, 1, 0, 0];
          break;
        case 'Tf': {
          const name = args[0] instanceof Name ? args[0].name : null;
          fontSize = typeof args[1] === 'number' ? args[1] : fontSize;
          const ref = fontDict instanceof Map && name ? fontDict.get(name) : null;
          font = ref ? this.fontFor(ref) : null;
          break;
        }
        case 'TL':
          leading = typeof args[0] === 'number' ? args[0] : leading;
          break;
        case 'Td':
          translate(args[0] || 0, args[1] || 0);
          break;
        case 'TD':
          leading = -(args[1] || 0);
          translate(args[0] || 0, args[1] || 0);
          break;
        case 'Tm':
          if (args.length >= 6 && args.every((a) => typeof a === 'number')) {
            lm = args.slice(0, 6);
            tm = [...lm];
          }
          break;
        case 'T*':
          translate(0, -leading);
          break;
        case 'Tj':
          show(args[0]);
          break;
        case "'":
          translate(0, -leading);
          show(args[0]);
          break;
        case '"':
          translate(0, -leading);
          show(args[2]);
          break;
        case 'TJ': {
          const arr = Array.isArray(args[0]) ? args[0] : [];
          for (const item of arr) {
            if (item instanceof Buffer) show(item);
            else if (typeof item === 'number') {
              const scale = Math.hypot(tm[0], tm[1]) || 1;
              tm[4] -= (item / 1000) * fontSize * scale;
              if (item < -250 && state.current && !state.current.endsWith(' ')) state.current += ' ';
              state.lastEndX = tm[4];
            }
          }
          break;
        }
        case 'Do': {
          const name = args[0] instanceof Name ? args[0].name : null;
          const ref = xobjects instanceof Map && name ? xobjects.get(name) : null;
          const obj = this.objectOf(ref);
          if (obj && obj.value instanceof Map && this.nameOf(obj.value.get('Subtype')) === 'Form') {
            const formData = this.decodeStream(obj);
            if (formData) this.runContent(formData, obj.value.get('Resources') || resourcesRef, state, depth + 1);
          }
          break;
        }
        case 'BI': {
          // Eingebettetes Bild überspringen
          const s = data.toString('latin1', lex.pos);
          const idIdx = s.search(/\sID[\s]/);
          if (idIdx < 0) return;
          const eiRel = s.slice(idIdx + 4).search(/\sEI(?=[\s]|$)/);
          if (eiRel < 0) return;
          lex.pos += idIdx + 4 + eiRel + 3;
          break;
        }
        default:
          break;
      }
    }
  }
}

function utf16Hex(hex) {
  const units = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) units.push(parseInt(hex, 16));
  return String.fromCharCode(...units);
}

export function parseCMap(text) {
  const map = new Map();
  let codeLength = null;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (cs) {
    const m = /<([0-9a-fA-F]+)>/.exec(cs[1]);
    if (m) codeLength = m[1].length / 2;
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), utf16Hex(m[2]));
      if (!codeLength) codeLength = m[1].length / 2;
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!codeLength) codeLength = m[1].length / 2;
      if (hi < lo || hi - lo > 65535) continue;
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16Hex(x[1]));
        items.forEach((str, i) => map.set(lo + i, str));
      } else {
        const base = utf16Hex(m[3].slice(1, -1));
        if (!base) continue;
        const prefix = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1);
        for (let code = lo; code <= hi; code++) map.set(code, prefix + String.fromCharCode(last + (code - lo)));
      }
    }
  }
  return { map, codeLength };
}

/**
 * Liest den Text aller Seiten.
 * @returns {{ pages: string[], pageCount: number, encrypted: boolean, text: string }}
 */
export function extractPdfText(buf) {
  const doc = new PdfDocument(buf);
  if (doc.isEncrypted()) return { pages: [], pageCount: doc.pages().length, encrypted: true, text: '' };
  const pages = doc.pages();
  const texts = pages.map((p) => {
    try {
      return doc.pageText(p);
    } catch {
      return '';
    }
  });
  const text = texts.map((t, i) => (texts.length > 1 ? `--- Seite ${i + 1} ---\n${t}` : t)).join('\n\n').trim();
  return { pages: texts, pageCount: pages.length, encrypted: false, text };
}

/** Sicherheitsprüfung beim Hochladen: Seitenzahl, Verschlüsselung, aktive Inhalte. */
export { PdfDocument, Name, Ref, Op, Lexer, parseValue };

export function inspectPdf(buf) {
  const raw = buf.toString('latin1');
  const hasEof = raw.slice(-2048).includes('%%EOF');
  let doc;
  try {
    doc = new PdfDocument(buf);
  } catch {
    return { valid: false, pageCount: 0, encrypted: false, activeContent: false };
  }
  const haystack = [raw, ...doc.decodedObjectStreams].join('\n');
  const activeContent = /\/(JavaScript|JS|Launch|RichMedia)(?![A-Za-z])/.test(haystack);
  let pageCount = 0;
  try {
    pageCount = doc.pages().length;
  } catch {
    pageCount = 0;
  }
  if (!pageCount) pageCount = (haystack.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  return { valid: hasEof && pageCount > 0, pageCount, encrypted: doc.isEncrypted(), activeContent };
}

/** Erstes JPEG-Bild der ersten Seite (für Vorschauen gescannter PDFs) – oder null. */
export function firstPageJpeg(buf) {
  try {
    const doc = new PdfDocument(buf);
    const page = doc.pages()[0];
    if (!page) return null;
    const resources = doc.resolve(page.resources);
    const xobjects = resources instanceof Map ? doc.resolve(resources.get('XObject')) : null;
    if (!(xobjects instanceof Map)) return null;
    for (const [, ref] of xobjects) {
      const obj = doc.objectOf(ref);
      if (!obj?.stream || !(obj.value instanceof Map)) continue;
      if (doc.nameOf(obj.value.get('Subtype')) !== 'Image') continue;
      const filter = doc.resolve(obj.value.get('Filter'));
      const name = Array.isArray(filter) ? (filter.length === 1 ? doc.nameOf(filter[0]) : null) : doc.nameOf(filter);
      if (name === 'DCTDecode' && obj.stream[0] === 0xff && obj.stream[1] === 0xd8) return Buffer.from(obj.stream);
    }
  } catch {
    return null;
  }
  return null;
}
