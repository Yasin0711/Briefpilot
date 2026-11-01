// Gerätesicherung: Konto, Briefe und Dateien nach einem Server-Neustart ohne Daten wieder einspielen.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, registerUser } from './helpers.js';
import { buildPdf } from '../server/pdf/write.js';

test('Sicherung holen, Server „verliert“ alles, Sicherung einspielen', async (t) => {
  const key = crypto.randomBytes(32).toString('base64');
  const a = await startTestServer({ FILE_ENCRYPTION_KEY: key });
  const { c, email } = await registerUser(a);
  const pdf = buildPdf([[{ type: 'text', x: 70, y: 700, text: 'Stadtwerke Rechnung 89,40 EUR' }]]);
  const up = await c.upload(pdf, 'application/pdf');
  const letter = (await c.post('/api/letters', { fileIds: [up.data.id] })).data;
  await a.app.ctx.analyzer.idle();
  await c.post('/api/folders', { name: 'Haus' });
  await c.patch('/api/me', { name: 'Onkel' }).catch(() => {});
  const { data: b } = await c.get('/api/backup');
  assert.ok(b.backup && b.sig);
  const files = JSON.parse(b.backup).tables.files;
  assert.equal(files.length, 1);
  assert.equal(files[0].storage_key, undefined, 'keine internen Speicherschlüssel in der Sicherung');
  const content = (await c.get(`/api/files/${up.data.id}`)).data;
  await a.stop();

  // Neuer, leerer Server mit demselben Schlüssel (wie nach einem Neustart auf Render)
  const fresh = await startTestServer({ FILE_ENCRYPTION_KEY: key });
  t.after(() => fresh.stop());
  const d = fresh.client();
  // Veränderte Sicherung wird abgelehnt
  const forged = b.backup.replace(email, 'fremd@example.org');
  assert.equal((await d.post('/api/backup/restore', { backup: forged, sig: b.sig })).status, 400);
  const r = await d.post('/api/backup/restore', { backup: b.backup, sig: b.sig });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.restored, true);
  assert.deepEqual(r.data.pendingFiles, [up.data.id]);
  // Falsche Datei wird abgelehnt, richtige angenommen
  assert.equal((await d.call('PUT', `/api/backup/files/${up.data.id}`, undefined, { raw: Buffer.from('falsch'), headers: { 'content-type': 'application/octet-stream' } })).status, 400);
  const put = await d.call('PUT', `/api/backup/files/${up.data.id}`, undefined, { raw: content, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.left, 0);
  // Alles wieder da
  const me = (await d.get('/api/me')).data.user;
  assert.equal(me.email, email);
  const detail = (await d.get(`/api/letters/${letter.id}`)).data;
  assert.equal(detail.letter.id, letter.id);
  assert.equal((await d.get(`/api/files/${up.data.id}`)).status, 200);
  assert.equal((await d.get('/api/folders')).data.folders[0].name, 'Haus');
  // Passwort gilt weiterhin
  const e = fresh.client();
  assert.equal((await e.post('/api/auth/login', { email, password: 'ein langes sicheres Passwort' })).status, 200);
  // Konto existiert jetzt: erneutes Einspielen → 409 (bei registrierten Konten)
  assert.equal((await fresh.client().post('/api/backup/restore', { backup: b.backup, sig: b.sig })).status, 409);
});

test('Sicherung eines anderen Servers (anderer Schlüssel) wird nicht angenommen', async (t) => {
  const a = await startTestServer();
  const { c } = await registerUser(a);
  const { data: b } = await c.get('/api/backup');
  await a.stop();
  const other = await startTestServer();
  t.after(() => other.stop());
  assert.equal((await other.client().post('/api/backup/restore', { backup: b.backup, sig: b.sig })).status, 400);
});
