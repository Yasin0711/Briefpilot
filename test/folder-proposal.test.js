// Briefe automatisch in Akten („Ordner“); ohne passende Akte: Vorschlag für eine neue – erst nach Zustimmung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, registerUser } from './helpers.js';
import { renderLetterPdf } from '../server/demo/seed.js';
import { buildDemoLetters } from '../server/demo/letters.js';
import { proposeObject, shortSender } from '../server/domain/proposal.js';
import { todayIn } from '../public/js/shared/dates.js';

const demo = buildDemoLetters(todayIn('Europe/Berlin'));

async function uploadLetter(c, server, letter) {
  const up = await c.upload(renderLetterPdf(letter), 'application/pdf');
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const created = await c.post('/api/letters', { fileIds: [up.data.id] });
  assert.equal(created.status, 200);
  await server.app.ctx.analyzer.idle();
  return (await c.get(`/api/letters/${created.data.id}`)).data;
}

test('Vorschlag: passende Namen je Briefart', () => {
  assert.equal(shortSender('Stadtwerke Musterstadt GmbH'), 'Stadtwerke Musterstadt');
  const p = (o, ids = []) => proposeObject({ summary_json: '{}', ...o }, ids);
  assert.equal(p({ sender: 'Muster Versicherung AG', subject: 'Beitragsanpassung Hausratversicherung', full_text: 'Ihre Hausratversicherung' }, [{ kind: 'versicherungsnummer', value: 'HR-123456', label: 'Vers.-Nr.' }]).name, 'Hausratversicherung · Muster Versicherung');
  assert.equal(p({ sender: 'Muster Versicherung AG', subject: 'Kfz-Beitrag', full_text: 'Kfz-Versicherung' }, [{ kind: 'kennzeichen', value: 'SB-EF 789' }]).name, 'Fahrzeug · SB-EF 789');
  assert.equal(p({ sender: 'Finanzamt Musterstadt', subject: 'Bescheid', category: 'behoerden', full_text: '' }).name, 'Steuern · Finanzamt Musterstadt');
  assert.equal(p({ sender: 'Stadtwerke Musterstadt GmbH', subject: 'Jahresabrechnung Strom', full_text: 'Strom Jahresabrechnung' }).name, 'Strom · Stadtwerke Musterstadt');
  assert.equal(p({ sender: 'Gewinnzentrale Ltd.', subject: 'Gewinn', summary_json: JSON.stringify({ what: 'Das Schreiben wirkt unseriös.' }) }), null, 'kein Ordner für unseriöse Post');
});

test('Ohne passende Akte: Vorschlag im Eingang, Anlegen nach Zustimmung, nächster Brief landet automatisch dort', async () => {
  const server = await startTestServer();
  try {
    const { c } = await registerUser(server);
    const strom = demo.find((l) => /Jahresabrechnung Strom/.test(l.subject));
    assert.ok(strom);
    const first = await uploadLetter(c, server, strom);
    assert.equal(first.letter.assignmentStatus, 'neue_akte');
    const inbox = (await c.get('/api/inbox')).data.letters;
    const entry = inbox.find((l) => l.id === first.letter.id);
    assert.ok(entry, 'Brief erscheint unter „Zuordnen“');
    const proposal = entry.assignment.proposal;
    assert.equal(proposal.type, 'strom');
    assert.match(proposal.name, /Stadtwerke Musterstadt/);
    assert.ok(proposal.identifiers.length >= 1, 'Nummern werden mitgemerkt');
    // Nichts wird ohne Zustimmung angelegt
    assert.equal((await c.get('/api/objects')).data.objects.length, 0);
    // Zustimmen (wie der Knopf „Akte anlegen und Brief ablegen“)
    const res = await c.post('/api/objects', { type: proposal.type, name: proposal.name, provider: proposal.provider, letterId: first.letter.id, identifiers: proposal.identifiers });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const after = (await c.get(`/api/letters/${first.letter.id}`)).data;
    assert.ok(JSON.stringify(after).includes(res.data.object.id), 'Brief liegt in der neuen Akte');
    assert.equal((await c.get('/api/inbox')).data.letters.some((l) => l.id === first.letter.id), false);
    // Zweiter Brief desselben Zählers → automatisch in die neue Akte
    const second = await uploadLetter(c, server, { ...strom, subject: 'Abschlagsänderung', paragraphs: ['Ihr neuer monatlicher Abschlag beträgt 60,00 EUR.'] });
    assert.equal(second.letter.assignmentStatus, 'zugeordnet');
  } finally {
    await server.stop();
  }
});

test('Gleichnamige Akte existiert schon: kein zweiter Ordner, sondern Vorschlag dieser Akte', async () => {
  const { makePptx } = await import('./office-fixtures.js');
  const server = await startTestServer();
  try {
    const { c } = await registerUser(server);
    const upload = async (title) => {
      const up = await c.upload(makePptx([title, 'Inhalte der Schulung zur Arbeitssicherheit im Betrieb']), 'application/octet-stream');
      const cr = await c.post('/api/letters', { fileIds: [up.data.id] });
      await server.app.ctx.analyzer.idle();
      return (await c.get(`/api/letters/${cr.data.id}`)).data.letter;
    };
    const first = await upload('Weiterbildung Arbeitssicherheit 2025');
    assert.equal(first.assignmentStatus, 'neue_akte');
    const p = first.assignment.proposal;
    assert.equal(p.name, 'Weiterbildung');
    await c.post('/api/objects', { type: p.type, name: p.name, letterId: first.id, identifiers: [] });
    const second = await upload('Weiterbildung Brandschutz 2026');
    assert.equal(second.assignmentStatus, 'vorschlag');
    assert.equal(second.assignment.candidates[0].name, 'Weiterbildung');
    assert.equal(second.assignment.proposal, null);
  } finally {
    await server.stop();
  }
});
