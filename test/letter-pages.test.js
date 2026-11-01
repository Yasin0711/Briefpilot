// Seiten zu einem bestehenden Brief hinzufügen und einzelne Seiten löschen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';
import { buildPdf } from '../server/pdf/write.js';

const pdf = (text) => buildPdf([[{ type: 'text', x: 70, y: 700, text }]]);

test('Seiten anhängen und einzeln löschen', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const { c } = await registerUser(srv);
  const up = async (text) => {
    const r = await c.upload(pdf(text), 'application/pdf');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const a = await up('Seite eins Stadtwerke Rechnung');
  const created = await c.post('/api/letters', { fileIds: [a] });
  const id = created.data.id;
  const b = await up('Seite zwei Anlage');
  const d3 = await up('Seite drei Anlage');
  assert.equal((await c.post(`/api/letters/${id}/pages`, { fileIds: [b, d3] })).status, 200);
  const pages = async () => (await c.get(`/api/letters/${id}`)).data.files.filter((f) => f.role === 'seite').map((f) => f.id);
  assert.deepEqual(await pages(), [a, b, d3]);
  // Fremde oder bereits zugeordnete Dateien werden nicht angenommen
  assert.equal((await c.post(`/api/letters/${id}/pages`, { fileIds: [a] })).status, 400);
  // Warten, bis die (Regel-)Auswertung durch ist – während der Auswertung ist der Brief gesperrt
  for (let i = 0; i < 50 && ['wartet', 'laeuft'].includes((await c.get(`/api/letters/${id}`)).data.letter.analysisStatus); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await c.del(`/api/letters/${id}/pages/${b}`)).status, 200);
  assert.deepEqual(await pages(), [a, d3]);
  for (let i = 0; i < 50 && ['wartet', 'laeuft'].includes((await c.get(`/api/letters/${id}`)).data.letter.analysisStatus); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await c.del(`/api/letters/${id}/pages/${d3}`)).status, 200);
  for (let i = 0; i < 50 && ['wartet', 'laeuft'].includes((await c.get(`/api/letters/${id}`)).data.letter.analysisStatus); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const last = await c.del(`/api/letters/${id}/pages/${a}`);
  assert.equal(last.status, 400);
  assert.match(last.data.error || JSON.stringify(last.data), /einzige Seite/);
});
