// Antwort im Ordner speichern, Kalender-Abo, Zustelldatum (gelber Brief), automatische Übernahme.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';
import { buildPdf } from '../server/pdf/write.js';
import { normalizeAnalysis } from '../server/analysis/validate.js';

async function letterWithFolder(c, app) {
  const pdf = buildPdf([[{ type: 'text', x: 70, y: 700, text: 'Stadtwerke Rechnung 89,40 EUR' }]]);
  const up = await c.upload(pdf, 'application/pdf');
  const letter = (await c.post('/api/letters', { fileIds: [up.data.id] })).data;
  await app.ctx.analyzer.idle();
  const obj = (await c.post('/api/objects', { type: 'sonstiges', name: 'Strom', letterId: letter.id })).data;
  return { letter, obj };
}

test('Antwort im Ordner speichern: PDF-Dokument im selben Ordner, erneutes Speichern ersetzt', async (t) => {
  const s = await startTestServer();
  t.after(() => s.stop());
  const { c } = await registerUser(s);
  const { letter } = await letterWithFolder(c, s.app);
  const reply = (await c.post(`/api/letters/${letter.id}/replies`, { mode: 'text', subject: 'Widerspruch', body: 'Sehr geehrte Damen und Herren,\n\nich widerspreche.' })).data.reply;
  const r1 = await c.post(`/api/replies/${reply.id}/save`, {});
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.folders, 1);
  const doc = (await c.get(`/api/letters/${r1.data.letterId}`)).data;
  assert.equal(doc.letter.subject, 'Antwort: Widerspruch');
  assert.equal(doc.files.length, 1);
  assert.equal(doc.files[0].kind, 'pdf');
  const r2 = await c.post(`/api/replies/${reply.id}/save`, {});
  assert.equal(r2.data.letterId, r1.data.letterId, 'kein zweites Dokument');
  assert.equal((await c.get(`/api/letters/${r1.data.letterId}`)).data.files.length, 1);
  const list = (await c.get(`/api/letters/${letter.id}/replies`)).data;
  const saved = (list.replies || []).find((x) => x.id === reply.id);
  if (saved) assert.equal(saved.savedLetterId, r1.data.letterId);
});

test('Kalender-Abo: nur bestätigte Termine, ohne Anmeldung über geheimen Link, abschaltbar', async (t) => {
  const s = await startTestServer();
  t.after(() => s.stop());
  const { c } = await registerUser(s);
  const { letter } = await letterWithFolder(c, s.app);
  await c.post('/api/tasks', { letterId: letter.id, title: 'Zahlen', kind: 'zahlung', dueDate: '2030-05-02' });
  const { data } = await c.post('/api/me/calendar', {});
  assert.ok(data.token && data.token.length >= 20);
  const anon = s.client();
  const feed = await anon.call('GET', `/api/calendar/${data.token}.ics`, undefined, { rawResponse: true });
  assert.equal(feed.status, 200);
  const text = typeof feed.data === 'string' ? feed.data : Buffer.from(feed.data).toString('utf8');
  assert.match(text, /BEGIN:VCALENDAR/);
  assert.match(text, /DTSTART;VALUE=DATE:20300502/);
  assert.equal((await anon.call('GET', '/api/calendar/falsch-falsch-falsch-falsch.ics')).status, 404);
  await c.post('/api/me/calendar', { off: true });
  assert.equal((await anon.call('GET', `/api/calendar/${data.token}.ics`)).status, 404);
});

test('Zustelldatum: nur als Vorschlag und nur, wenn es wörtlich im Brief steht', () => {
  const fullText = 'Musterstadt, 03.10.2026\nZugestellt am 07.10.2026';
  const base = { sender: 'Amt', letter_date: '2026-10-03', letter_date_quote: 'Musterstadt, 03.10.2026', full_text: fullText, actions: [] };
  const ok = normalizeAnalysis({ ...base, delivery_date: '2026-10-07', delivery_quote: 'Zugestellt am 07.10.2026' }, { fullText, today: '2026-10-20', source: 'ki' });
  assert.equal(ok.deliveryDate, '2026-10-07');
  const invented = normalizeAnalysis({ ...base, delivery_date: '2026-10-08', delivery_quote: 'Zugestellt am 07.10.2026' }, { fullText, today: '2026-10-20', source: 'ki' });
  assert.equal(invented.deliveryDate, null);
  const sameAsLetter = normalizeAnalysis({ ...base, delivery_date: '2026-10-03', delivery_quote: 'Musterstadt, 03.10.2026' }, { fullText, today: '2026-10-20', source: 'ki' });
  assert.equal(sameAsLetter.deliveryDate, null);
  const noQuote = normalizeAnalysis({ ...base, delivery_date: '2026-10-07', delivery_quote: null }, { fullText, today: '2026-10-20', source: 'ki' });
  assert.equal(noQuote.deliveryDate, null);
});

test('Einstellung „automatisch übernehmen“ ist aus und lässt sich speichern', async (t) => {
  const s = await startTestServer();
  t.after(() => s.stop());
  const { c } = await registerUser(s);
  assert.equal((await c.get('/api/me')).data.user.settings.autoConfirmFacts, false);
  const r = await c.patch('/api/me', { settings: { autoConfirmFacts: true } });
  assert.equal(r.data.user.settings.autoConfirmFacts, true);
});
