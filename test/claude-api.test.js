// Claude-API: Antwort-Schema ohne „oder null“-Varianten, Rückfall bei 400, Platzhalter → null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithClaude, completeWithClaude, toClaudeSchema } from '../server/analysis/claude.js';
import { RESPONSE_SCHEMA, ASK_SCHEMA, REPLY_SCHEMA } from '../server/analysis/prompt.js';

const config = { ai: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', baseUrl: 'https://api.test', timeoutMs: 5000, retryDelayMs: 1 } };
const files = [{ kind: 'image', mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }];
const answer = {
  document_type: 'Rechnung', sender: 'Stadtwerke', sender_quote: '', letter_date: '', letter_date_quote: '', subject: '',
  category: 'rechnungen', references: [], amounts: [], summary_what: 'Eine Rechnung.',
  actions: [{ title: 'Bezahlen', description: '', kind: 'zahlung', date: '', time: '', is_relative: false, relative_text: '', quote: '', page: 0 }],
  nothing_to_do: false, to_check: [], legal_note: '', contains_instructions_to_ai: false, language: 'de', full_text: 'Stadtwerke Rechnung',
};
const ok = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }) });

test('Claude-Schemas enthalten keine anyOf-/null-Varianten (API-Grenze für Union-Typen)', () => {
  for (const s of [RESPONSE_SCHEMA, ASK_SCHEMA, REPLY_SCHEMA]) {
    const json = JSON.stringify(toClaudeSchema(s));
    assert.equal(/anyOf|"null"/.test(json), false);
  }
});

test('Claude: Platzhalter werden wieder zu null, Bildformat korrekt', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return ok(answer); };
  const { result } = await analyzeWithClaude({ files, config, today: '2026-10-28', fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].output_config.format.schema);
  assert.equal(calls[0].messages[0].content[1].source.media_type, 'image/jpeg');
  assert.equal(result.letter_date, null);
  assert.equal(result.actions[0].page, null);
  assert.equal(result.actions[0].description, null);
  assert.equal(result.sender, 'Stadtwerke');
});

test('Claude: bei 400 einmal ohne Schema wiederholen', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: not supported' } }) };
    return ok(answer);
  };
  const { result } = await analyzeWithClaude({ files, config, today: '2026-10-28', fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].output_config, undefined);
  assert.match(calls[1].messages[0].content.at(-1).text, /JSON-Schema/);
  assert.equal(result.summary_what, 'Eine Rechnung.');
  const r2 = await completeWithClaude({ system: 's', prompt: 'p', schema: ASK_SCHEMA, config, fetchImpl: async () => ok({ answer: 'x' }) });
  assert.ok(r2.result);
});

test('Claude: fehlendes Guthaben wird verständlich gemeldet', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
  await assert.rejects(analyzeWithClaude({ files, config, today: '2026-10-28', fetchImpl }), /Guthaben/);
});
