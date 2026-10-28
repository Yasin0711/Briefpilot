// Erzeugt einfache Text-PDFs (für die Beispielbriefe im Demomodus).
// Verwendet die eingebauten PDF-Schriften Helvetica und Helvetica-Bold.
import zlib from 'node:zlib';
import { encodeWinAnsi } from './encodings.js';

// Zeichenbreiten von Helvetica (1/1000 der Schriftgröße) für ASCII 32–126
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const EXTRA_WIDTHS = { 'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, '€': 556, '–': 556, '—': 1000, '„': 333, '“': 333, '”': 333, '§': 556, '•': 350, '…': 1000 };

export function textWidth(text, size, bold = false) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    w += (code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : EXTRA_WIDTHS[ch] || 556) * (bold ? 1.06 : 1);
  }
  return (w / 1000) * size;
}

export function wrapText(text, maxWidth, size, bold = false) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function pdfString(text) {
  const bytes = encodeWinAnsi(text);
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

/** Liest Breite, Höhe und Farbkanäle aus einer JPEG-Datei (SOF-Marker). */
export function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Keine JPEG-Datei');
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7), components: buf[pos + 9] };
    }
    pos += 2 + length;
  }
  throw new Error('JPEG-Größe nicht gefunden');
}

/**
 * pages: Array von Seiten. Eine Seite ist entweder ein Array von Elementen (A4 hoch)
 * oder { width, height, items }. Elemente:
 *   { type: 'text', x, y, text, size = 11, bold = false, gray = 0 }
 *   { type: 'line', x1, y1, x2, y2, gray = 0.6, width = 0.6 }
 *   { type: 'image', x, y, w, h, jpeg: Buffer }   (JPEG wird unverändert eingebettet)
 * Koordinaten in Punkt, Ursprung unten links (A4 = 595 × 842).
 */
export function buildPdf(pages, { title = 'Dokument', producer = 'BriefPilot' } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];

  for (const page of pages) {
    const items = Array.isArray(page) ? page : page.items;
    const width = Array.isArray(page) ? 595 : page.width || 595;
    const height = Array.isArray(page) ? 842 : page.height || 842;
    let content = '';
    const images = [];
    for (const item of items) {
      if (item.type === 'line') {
        content += `${item.gray ?? 0.6} G ${item.width ?? 0.6} w ${item.x1} ${item.y1} m ${item.x2} ${item.y2} l S\n`;
      } else if (item.type === 'image') {
        const info = jpegInfo(item.jpeg);
        const colorSpace = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
        const imageId = add({
          dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${item.jpeg.length} >>`,
          stream: item.jpeg,
        });
        const name = `Im${images.length + 1}`;
        images.push(`/${name} ${imageId} 0 R`);
        content += `q ${item.w.toFixed(2)} 0 0 ${item.h.toFixed(2)} ${item.x.toFixed(2)} ${item.y.toFixed(2)} cm /${name} Do Q\n`;
      } else {
        const size = item.size || 11;
        content += `BT /${item.bold ? 'F2' : 'F1'} ${size} Tf ${item.gray ?? 0} g ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td ${pdfString(item.text)} Tj ET\n`;
      }
    }
    const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const contentId = add({ dict: `<< /Length ${compressed.length} /Filter /FlateDecode >>`, stream: compressed });
    const xobjects = images.length ? ` /XObject << ${images.join(' ')} >>` : '';
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${xobjects} >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title ${pdfString(title)} /Producer ${pdfString(producer)} >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    let buf;
    if (body && typeof body === 'object') {
      buf = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${body.dict}\nstream\n`, 'latin1'),
        body.stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      buf = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    }
    chunks.push(buf);
    offset += buf.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** Erzeugt aus gescannten Seiten (JPEG) eine PDF-Datei: je Bild eine A4-Seite, hoch oder quer. */
export function buildScanPdf(jpegs, { title = 'Scan' } = {}) {
  const pages = jpegs.map((jpeg) => {
    const info = jpegInfo(jpeg);
    const landscape = info.width > info.height;
    const width = landscape ? 842 : 595;
    const height = landscape ? 595 : 842;
    const scale = Math.min(width / info.width, height / info.height);
    const w = info.width * scale;
    const h = info.height * scale;
    return { width, height, items: [{ type: 'image', jpeg, x: (width - w) / 2, y: (height - h) / 2, w, h }] };
  });
  return buildPdf(pages, { title });
}
