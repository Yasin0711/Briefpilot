// PDFs mit JavaScript & Co.: werden angenommen, aber vollständig entschärft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePdf, hasActiveObjects } from '../server/pdf/sanitize.js';
import { inspectPdf, extractPdfText } from '../server/pdf/extract.js';
import { buildPdf } from '../server/pdf/write.js';
import { pdfWithJavaScript, pdfWithJavaScriptInObjectStream } from './pdf-js-fixtures.js';
import { startTestServer, registerUser } from './helpers.js';

const ACTIVE = /\/(JavaScript|JS|Launch|OpenAction|AA|XFA|SubmitForm|RichMedia)(?![A-Za-z])/;

for (const [name, make] of [['klassische PDF', pdfWithJavaScript], ['PDF mit komprimierten Objekten', pdfWithJavaScriptInObjectStream]]) {
  test(`Entschärfen: ${name}`, () => {
    const input = make();
    assert.equal(inspectPdf(input).activeContent, true);
    const { pdf, removed } = sanitizePdf(input);
    assert.ok(removed > 0);
    const info = inspectPdf(pdf);
    assert.equal(info.valid, true);
    assert.equal(info.activeContent, false);
    assert.equal(info.pageCount, 1);
    assert.equal(hasActiveObjects(pdf), false);
    assert.equal(ACTIVE.test(pdf.toString('latin1')), false, 'kein aktiver Eintrag mehr in der Datei');
    assert.equal(/javascript:/i.test(pdf.toString('latin1')), false);
    assert.match(extractPdfText(pdf).text, /Rechnung Nr\. 4711/, 'Text bleibt erhalten');
  });
}

test('Entschärfen: normale Links bleiben, harmlose PDFs unverändert lesbar', () => {
  const { pdf } = sanitizePdf(pdfWithJavaScript());
  assert.ok(pdf.toString('latin1').includes(Buffer.from('https://www.stadtwerke-musterstadt.de').toString('hex')), 'https-Link bleibt erhalten');
  const plain = buildPdf([[{ type: 'text', x: 72, y: 720, text: 'Hallo Welt', size: 12 }]]);
  const out = sanitizePdf(plain);
  assert.equal(out.removed, 0);
  assert.match(extractPdfText(out.pdf).text, /Hallo Welt/);
});

test('Upload: PDF mit JavaScript wird angenommen und nur entschärft gespeichert', async () => {
  const server = await startTestServer();
  try {
    const { c } = await registerUser(server);
    const up = await c.upload(pdfWithJavaScript(), 'application/pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.ok(up.data.sanitized?.removed > 0);
    assert.match(up.data.sanitized.message, /entfernt/);
    const created = await c.post('/api/letters', { fileIds: [up.data.id] });
    assert.equal(created.status, 200);
    await server.app.ctx.analyzer.idle();
    const pdf = await c.get(`/api/letters/${created.data.id}/pdf`);
    assert.equal(pdf.status, 200);
    const stored = Buffer.from(pdf.data);
    assert.equal(hasActiveObjects(stored), false);
    assert.equal(ACTIVE.test(stored.toString('latin1')), false);
    const detail = (await c.get(`/api/letters/${created.data.id}`)).data;
    assert.match(detail.letter.fullText || '', /4711/, 'Text wurde ohne KI erkannt');
    const up2 = await c.upload(pdfWithJavaScriptInObjectStream(), 'application/pdf');
    assert.equal(up2.status, 200, JSON.stringify(up2.data));
    assert.ok(up2.data.sanitized);
  } finally {
    await server.stop();
  }
});
