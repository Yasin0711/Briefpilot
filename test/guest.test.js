// „Ohne Konto fortfahren“: Gastzugang ohne E-Mail und Passwort.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('Ohne Konto fortfahren: Gastzugang mit langer Sitzung, getrennte Daten, Löschen ohne Passwort', async () => {
  const server = await startTestServer();
  try {
    const c = server.client();
    const res = await c.post('/api/auth/guest');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.user.isGuest, true);
    assert.equal(res.data.user.email, null, 'interne Gast-Adresse wird nie angezeigt');
    const maxAge = Number(/Max-Age=(\d+)/i.exec(res.headers.get('set-cookie'))[1]);
    assert.ok(maxAge >= 360 * 86400, 'Sitzung hält etwa ein Jahr');
    assert.equal((await c.get('/api/me')).data.user.isGuest, true);
    assert.equal((await c.get('/api/letters')).status, 200);
    const other = server.client();
    const r2 = await other.post('/api/auth/guest');
    assert.notEqual(r2.data.user.id, res.data.user.id, 'jeder Gast hat ein eigenes Konto');
    assert.equal((await c.post('/api/me/password', { currentPassword: '', newPassword: 'irgendein sehr langes Passwort' })).status, 400);
    assert.equal((await c.post('/api/me/delete', { confirm: 'LÖSCHEN' })).status, 200);
    assert.equal((await c.get('/api/letters')).status, 401);
  } finally {
    await server.stop();
  }
});
