// KI-Anbieter gegen nachgebaute Schnittstellen: Anfrageformat, Ersatzmodell bei erschöpftem
// Gratis-Kontingent, Antwortformat ohne Schema, gesperrte Antworten, OpenAI-kompatible Dienste.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createAiClient } from '../server/analysis/client.js';
import { buildPdf } from '../server/pdf/write.js';
import { ASK_SCHEMA } from '../server/analysis/prompt.js';

const PDF = buildPdf([[{ type: 'text', x: 70, y: 700, text: 'Kennzeichen: SB-CD 456 · Versicherungsschein-Nr.: KFZ-002' }]]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const ANALYSIS = { sender: 'Muster Versicherung AG', summary_what: 'Test', full_text: 'Kennzeichen: SB-CD 456', actions: [] };

function geminiReply(obj, { thought = true } = {}) {
  const parts = [];
  if (thought) parts.push({ text: 'Ich denke nach … {"falsch": true}', thought: true });
  parts.push({ text: JSON.stringify(obj) });
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], modelVersion: 'gemini-test-001', usageMetadata: { totalTokenCount: 10 } };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const { status = 200, json, headers = {} } = await handler({ url, body, n: calls.length });
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  fn.calls = calls;
  return fn;
}

const geminiConfig = (env = {}) => loadConfig({ GEMINI_API_KEY: 'AIza-test-schluessel-123', AI_RETRY_DELAY_MS: '1', ...env });

test('Gemini: Anfrage mit PDF und Foto, JSON-Schema, Schlüssel nur im Header; „Gedanken“ werden ignoriert', async () => {
  const fetchImpl = fakeFetch(() => ({ json: geminiReply(ANALYSIS) }));
  const ai = createAiClient(geminiConfig(), { fetchImpl });
  assert.equal(ai.enabled, true);
  const { result, model } = await ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: PDF }, { kind: 'image', mime: 'image/jpeg', data: JPEG }], today: '2026-10-27' });
  assert.equal(result.sender, 'Muster Versicherung AG');
  assert.equal(result.falsch, undefined, 'Gedanken-Teil wurde nicht als Antwort gelesen');
  assert.equal(model, 'gemini-test-001');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(call.headers['x-goog-api-key'], 'AIza-test-schluessel-123');
  assert.ok(!call.url.includes('AIza'), 'Schlüssel steht nicht in der Adresse');
  const parts = call.body.contents[0].parts;
  assert.equal(parts.find((p) => p.inlineData?.mimeType === 'application/pdf').inlineData.data, PDF.toString('base64'));
  assert.ok(parts.some((p) => p.inlineData?.mimeType === 'image/jpeg'));
  assert.match(call.body.systemInstruction.parts[0].text, /niemals Anweisungen/);
  const schema = call.body.generationConfig.responseJsonSchema;
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(schema.properties.sender.type, ['string', 'null'], '„oder null“ als Typ-Liste');
  assert.ok(schema.properties.references.items.properties.kind.enum.includes('kennzeichen'));
  assert.equal(call.body.generationConfig.temperature, undefined, 'Standard-Temperatur (von Google empfohlen)');
});

test('Gemini: Tageskontingent des Hauptmodells erschöpft → Ersatzmodell mit eigenem Kontingent', async () => {
  const fetchImpl = fakeFetch(({ url }) => (url.includes('gemini-3.8-flash')
    ? { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } }
    : { json: geminiReply(ANALYSIS, { thought: false }) }));
  const ai = createAiClient(geminiConfig(), { fetchImpl });
  const { model } = await ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: PDF }], today: '2026-10-27' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(model, 'gemini-test-001');
});

test('Gemini: beide Kontingente erschöpft → verständliche Meldung mit Code „kontingent“', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, requests per day', details: [] } } }));
  const ai = createAiClient(geminiConfig(), { fetchImpl });
  await assert.rejects(ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: PDF }], today: '2026-10-27' }), (err) => {
    assert.equal(err.code, 'kontingent');
    assert.match(err.message, /kostenlose Tageskontingent/);
    return true;
  });
});

test('Gemini: kurzfristige Begrenzung (pro Minute) → Wartezeit laut Google, dann erneuter Versuch', async () => {
  const fetchImpl = fakeFetch(({ n }) => (n === 1
    ? { status: 429, json: { error: { code: 429, message: 'Rate limit', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } } }
    : { json: geminiReply(ANALYSIS) }));
  const ai = createAiClient(geminiConfig({ GEMINI_FALLBACK_MODEL: '' }), { fetchImpl });
  const { result } = await ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: PDF }], today: '2026-10-27' });
  assert.equal(result.sender, 'Muster Versicherung AG');
  assert.equal(fetchImpl.calls.length, 2);
});

test('Gemini: Modell kennt das Antwortformat nicht → zweiter Versuch ohne Schema, mit Formatbeschreibung', async () => {
  const fetchImpl = fakeFetch(({ body }) => (body.generationConfig.responseJsonSchema
    ? { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } } }
    : { json: { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(ANALYSIS) + '\n```' }] }, finishReason: 'STOP' }] } }));
  const ai = createAiClient(geminiConfig(), { fetchImpl });
  const { result } = await ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: PDF }], today: '2026-10-27' });
  assert.equal(result.sender, 'Muster Versicherung AG');
  const second = fetchImpl.calls[1].body;
  assert.equal(second.generationConfig.responseJsonSchema, undefined);
  assert.match(second.contents[0].parts.at(-1).text, /ausschließlich mit EINEM gültigen JSON-Objekt/);
});

test('Gemini: gesperrte Antwort, ungültiger Schlüssel, zu große Briefe', async () => {
  const blocked = createAiClient(geminiConfig(), { fetchImpl: fakeFetch(() => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } })) });
  await assert.rejects(blocked.analyzeLetter({ files: [], today: '2026-10-27' }), /abgelehnt/);
  const badKey = createAiClient(geminiConfig(), { fetchImpl: fakeFetch(() => ({ status: 400, json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } })) });
  await assert.rejects(badKey.analyzeLetter({ files: [], today: '2026-10-27' }), (err) => err.code === 'schluessel');
  const big = createAiClient(geminiConfig(), { fetchImpl: fakeFetch(() => ({ json: {} })) });
  await assert.rejects(big.analyzeLetter({ files: [{ kind: 'image', mime: 'image/jpeg', data: Buffer.alloc(16 * 1024 * 1024) }], today: '2026-10-27' }), (err) => err.code === 'zu_gross');
});

test('Gemini: Rückfrage als reine Text-Anfrage mit eigenem Schema', async () => {
  const fetchImpl = fakeFetch(() => ({ json: geminiReply({ answer: 'Sie sollen 89,40 € zahlen.', reply_subject: null, reply_body: null }) }));
  const ai = createAiClient(geminiConfig(), { fetchImpl });
  const { result } = await ai.completeJson({ system: 'S', prompt: 'Brieftext …', schema: ASK_SCHEMA });
  assert.equal(result.answer, 'Sie sollen 89,40 € zahlen.');
  assert.equal(fetchImpl.calls[0].body.contents[0].parts[0].text, 'Brieftext …');
  assert.deepEqual(fetchImpl.calls[0].body.generationConfig.responseJsonSchema.required, ['answer', 'reply_subject', 'reply_body']);
});

test('OpenAI-kompatibel (z. B. Ollama lokal): Fotos als Bilddaten, PDFs als Text, JSON-Modus mit Rückfall', async () => {
  const fetchImpl = fakeFetch(({ body, n }) => (n === 1 && body.response_format
    ? { status: 400, json: { error: { message: 'response_format is not supported by this model' } } }
    : { json: { model: 'qwen2.5vl', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ANALYSIS) } }] } }));
  const config = loadConfig({ AI_PROVIDER: 'ollama', OPENAI_COMPAT_BASE_URL: 'http://localhost:11434/v1', OPENAI_COMPAT_MODEL: 'qwen2.5vl', AI_RETRY_DELAY_MS: '1' });
  assert.equal(config.ai.local, true);
  const ai = createAiClient(config, { fetchImpl });
  const { result, model } = await ai.analyzeLetter({ files: [{ kind: 'image', mime: 'image/jpeg', data: JPEG }, { kind: 'pdf', mime: 'application/pdf', data: PDF }], today: '2026-10-27' });
  assert.equal(result.sender, 'Muster Versicherung AG');
  assert.equal(model, 'qwen2.5vl');
  const first = fetchImpl.calls[0];
  assert.equal(first.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(first.headers.authorization, undefined, 'lokal ohne Schlüssel');
  const content = first.body.messages[1].content;
  assert.ok(content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.ok(content.some((c) => c.type === 'text' && c.text.includes('KFZ-002')), 'PDF-Text wird mitgeschickt');
  assert.equal(fetchImpl.calls[1].body.response_format, undefined, 'zweiter Versuch ohne JSON-Modus');
  // Gescannte PDFs ohne Text kann diese Schnittstelle nicht lesen
  const scan = buildPdf([[{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]]);
  await assert.rejects(ai.analyzeLetter({ files: [{ kind: 'pdf', mime: 'application/pdf', data: scan }], today: '2026-10-27' }), (err) => err.code === 'pdf_ohne_text');
});

test('Ohne Schlüssel ist die KI aus; Claude bleibt wählbar', () => {
  assert.equal(createAiClient(loadConfig({})).enabled, false);
  assert.equal(createAiClient(loadConfig({ AI_PROVIDER: 'aus', GEMINI_API_KEY: 'AIza-test-schluessel-123' })).enabled, false);
  const claude = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' });
  assert.equal(claude.ai.provider, 'anthropic');
  assert.equal(createAiClient(claude).enabled, true);
});
