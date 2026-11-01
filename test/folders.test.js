// Akten: keine Duplikate, eigene Ordner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';

test('Gleichnamige Akte wird nicht doppelt angelegt; alte Duplikate werden zusammengeführt', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const { c } = await registerUser(srv);
  const a = await c.post('/api/objects', { type: 'sonstiges', name: 'Weiterbildung', identifiers: [] });
  const b = await c.post('/api/objects', { type: 'sonstiges', name: ' weiterbildung ', identifiers: [] });
  assert.equal(b.data.object.id, a.data.object.id);
  assert.equal(b.data.existing, true);
  // Alte Duplikate direkt in der Datenbank (wie vor der Korrektur entstanden)
  const db = srv.app.ctx.db;
  const userId = db.get('SELECT id FROM users ORDER BY created_at DESC LIMIT 1').id;
  const now = new Date().toISOString();
  for (const id of ['dup-1', 'dup-2']) {
    db.run("INSERT INTO objects (id, user_id, type, name, category, created_at, updated_at) VALUES (?, ?, 'sonstiges', 'Zertifikate', 'sonstiges', ?, ?)", id, userId, now, now);
  }
  const list = (await c.get('/api/objects')).data;
  assert.equal(list.objects.filter((o) => o.name === 'Zertifikate').length, 1);
});

test('Eigene Ordner: anlegen, Akten hineinlegen, umbenennen, löschen (Akten bleiben)', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.stop());
  const { c } = await registerUser(srv);
  const car = (await c.post('/api/objects', { type: 'fahrzeug', name: 'Auto', identifiers: [{ kind: 'kennzeichen', value: 'SB-AB 123' }] })).data.object;
  const flat = (await c.post('/api/objects', { type: 'wohnen', name: 'Wohnung', identifiers: [] })).data.object;
  const f = (await c.post('/api/folders', { name: 'Familie', objectIds: [car.id, flat.id] })).data.folder;
  assert.equal(f.objectCount, 2);
  assert.equal((await c.post('/api/folders', { name: 'familie' })).data.folder.id, f.id, 'kein doppelter Ordner');
  let list = (await c.get('/api/objects')).data;
  assert.equal(list.objects.find((o) => o.id === car.id).folderId, f.id);
  await c.patch(`/api/objects/${car.id}`, { folderId: null });
  await c.patch(`/api/folders/${f.id}`, { name: 'Haus' });
  list = (await c.get('/api/objects')).data;
  assert.equal(list.folders[0].name, 'Haus');
  assert.equal(list.folders[0].objectCount, 1);
  assert.equal((await c.del(`/api/folders/${f.id}`)).status, 200);
  list = (await c.get('/api/objects')).data;
  assert.equal(list.objects.length, 2);
  assert.equal(list.folders.length, 0);
  // Neue Akte direkt in einem Ordner
  const g = (await c.post('/api/folders', { name: 'Arbeit' })).data.folder;
  const job = (await c.post('/api/objects', { type: 'sonstiges', name: 'Arbeitsvertrag', folderId: g.id, identifiers: [] })).data.object;
  assert.equal(job.folderId, g.id);
});
