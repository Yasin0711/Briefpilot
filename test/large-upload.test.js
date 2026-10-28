// Große Dateien in Stücken, viele Seiten, PowerPoint/Word, Makro-Dateien abgelehnt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, registerUser } from './helpers.js';
import { buildPdf } from '../server/pdf/write.js';
import { inspectPdf } from '../server/pdf/extract.js';
import { makePptx, makeDocx, withMacro } from './office-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
void here; void fs;

async function chunkedUpload(c, data, type, chunk) {
  const init = await c.post('/api/uploads', { size: data.length, type });
  assert.equal(init.status, 200, JSON.stringify(init.data));
  for (let i = 0; i < init.data.chunks; i++) {
    const r = await c.call('PUT', `/api/uploads/${init.data.id}/${i}`, undefined, { raw: data.subarray(i * chunk, (i + 1) * chunk), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return c.post(`/api/uploads/${init.data.id}/complete`, {});
}

test('Upload in Stücken: PDF mit 120 Seiten', async () => {
  const server = await startTestServer({ UPLOAD_CHUNK_KB: '16' });
  try {
    const { c } = await registerUser(server);
    const pages = Array.from({ length: 120 }, (_, i) => [{ type: 'text', x: 72, y: 720, text: `Schulungsunterlagen Seite ${i + 1} Datenschutz und Informationssicherheit`, size: 12 }]);
    const pdf = buildPdf(pages);
    assert.equal(inspectPdf(pdf).pageCount, 120);
    const done = await chunkedUpload(c, pdf, 'application/pdf', 16 * 1024);
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.pageCount, 120);
    // Unvollständig → Fehler, kein Speichern
    const init = await c.post('/api/uploads', { size: pdf.length, type: 'application/pdf' });
    const r = await c.post(`/api/uploads/${init.data.id}/complete`, {});
    assert.equal(r.status, 400);
    // Zu groß → abgelehnt, bevor etwas übertragen wird
    const big = await c.post('/api/uploads', { size: 500 * 1024 * 1024, type: 'application/pdf' });
    assert.equal(big.status, 413);
  } finally {
    await server.stop();
  }
});

test('PowerPoint und Word: angenommen, Text gelesen und durchsuchbar; Makros abgelehnt', async () => {
  const server = await startTestServer();
  try {
    const { c } = await registerUser(server);
    const pptx = makePptx(['Weiterbildung Datenschutz 2026', 'Modul 2: DSGVO-Grundlagen', 'Teilnahmebescheinigung Akademie Musterstadt']);
    let up = await c.upload(pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.kind, 'office');
    assert.equal(up.data.pageCount, 3);
    let created = await c.post('/api/letters', { fileIds: [up.data.id] });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    await server.app.ctx.analyzer.idle();
    let detail = (await c.get(`/api/letters/${created.data.id}`)).data;
    assert.match(detail.letter.fullText, /DSGVO-Grundlagen/);
    const found = (await c.get('/api/letters?q=DSGVO')).data.letters;
    assert.ok(found.some((l) => l.id === created.data.id), 'Volltextsuche findet die Präsentation');
    const file = await c.get(`/api/files/${up.data.id}`);
    assert.match(file.headers.get('content-disposition'), /^attachment;.*\.pptx"/);

    up = await c.upload(makeDocx(['Arbeitsvertrag zwischen der Muster GmbH und Herrn Max Mustermann', 'Vertragsnummer: AV-2026-77', 'Beginn des Arbeitsverhältnisses ist der 01.01.2027.']), 'application/octet-stream');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    created = await c.post('/api/letters', { fileIds: [up.data.id] });
    await server.app.ctx.analyzer.idle();
    detail = (await c.get(`/api/letters/${created.data.id}`)).data;
    assert.match(detail.letter.fullText, /AV-2026-77/);

    const macro = await c.upload(withMacro(pptx), 'application/octet-stream');
    assert.equal(macro.status, 415);
    assert.match(macro.data.error, /Makros/);
  } finally {
    await server.stop();
  }
});
