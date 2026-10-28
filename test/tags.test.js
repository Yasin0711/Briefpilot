// Schlagworte: automatisch, filtern, selbst festlegen (bleibt bei neuer Auswertung).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { normalizeTags, deriveTags } from '../public/js/shared/tags.js';
import { RESPONSE_SCHEMA } from '../server/analysis/prompt.js';

test('Tags bereinigen und ohne KI ableiten', () => {
  assert.deepEqual(normalizeTags(['steuer', '#Steuer', ' auto ', 'x', 'Garantie']), ['Steuer', 'Auto', 'Garantie']);
  assert.deepEqual(normalizeTags('a, Strom; Miete'), ['Strom', 'Miete']);
  assert.ok(deriveTags({ category: 'behoerden', subject: 'Bescheid über Einkommensteuer', text: 'Finanzamt' }).includes('Steuer'));
  assert.ok(RESPONSE_SCHEMA.required.includes('tags'));
});

test('Tags: Liste, Filter, eigene Tags', async () => {
  const server = await startTestServer();
  try {
    const c = server.client();
    await c.post('/api/auth/demo');
    const tags = (await c.get('/api/tags')).data.tags;
    assert.ok(tags.some((t) => t.tag === 'Versicherung' && t.count >= 3));
    const filtered = (await c.get('/api/letters?tag=versicherung')).data.letters;
    assert.ok(filtered.length >= 3 && filtered.every((l) => l.tags.includes('Versicherung')));
    const one = filtered[0];
    const r = await c.put(`/api/letters/${one.id}/tags`, { tags: 'Auto, Wichtig' });
    assert.deepEqual(r.data.tags, ['Auto', 'Wichtig']);
    assert.ok((await c.get('/api/letters?tag=wichtig')).data.letters.some((l) => l.id === one.id));
    assert.ok((await c.get('/api/letters?q=wichtig')).data.letters.some((l) => l.id === one.id), 'Tags sind durchsuchbar');
  } finally {
    await server.stop();
  }
});
