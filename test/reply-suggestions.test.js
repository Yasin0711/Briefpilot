// Antwortvorschläge passend zum Brief (Demo-Briefe als Grundlage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('Antwortvorschläge und Fragen passen zum Brief', async () => {
  const server = await startTestServer();
  try {
    const c = server.client();
    await c.post('/api/auth/demo');
    const letters = (await c.get('/api/letters')).data.letters;
    const get = async (pattern) => {
      const l = letters.find((x) => pattern.test(`${x.sender} ${x.subject}`));
      assert.ok(l, `Demo-Brief ${pattern} vorhanden`);
      const r = await c.get(`/api/letters/${l.id}/reply-suggestions`);
      assert.equal(r.status, 200);
      return { letter: l, ...r.data, rec: r.data.templates.filter((t) => t.recommended).map((t) => t.id) };
    };
    const bescheid = await get(/Finanzamt.*Bescheid/);
    assert.ok(bescheid.rec.includes('widerspruch'));
    assert.match(bescheid.templates.find((t) => t.id === 'widerspruch').reason, /Einspruch/);
    assert.ok(!bescheid.rec.includes('fristverlaengerung'), 'Einspruchsfrist ist keine verlängerbare Frist');
    assert.ok(bescheid.questions.some((q) => /Einspruch/.test(q)));

    const rechnung = await get(/Jahresabrechnung Strom/);
    assert.ok(rechnung.rec.includes('ratenzahlung') && rechnung.rec.includes('fristverlaengerung'));
    assert.ok(rechnung.questions.some((q) => /zahlen/.test(q)));

    const erhoehung = await get(/Beitragsanpassung/);
    assert.deepEqual(erhoehung.rec, ['kuendigung']);

    const gewinn = await get(/Gewinn/);
    assert.deepEqual(gewinn.rec, [], 'bei unseriösen Schreiben keine Antwort empfehlen');
    assert.match(gewinn.questions[0], /seriös|Betrug/);

    for (const id of [bescheid, rechnung, gewinn]) {
      assert.equal(id.templates.length, 8, 'alle Vorlagen bleiben wählbar');
      assert.equal(id.templates.at(-1).id, 'leer');
    }
    // Vorlage wird mit Angaben aus dem Brief gefüllt
    const r = await c.post(`/api/letters/${erhoehung.letter.id}/replies`, { mode: 'vorlage', template: 'kuendigung' });
    assert.equal(r.status, 200);
    assert.match(r.data.reply.body, /Beitragserhöhung/);
  } finally {
    await server.stop();
  }
});
