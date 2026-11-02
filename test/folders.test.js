// Ordner (früher „Akten“): keine Duplikate.
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
