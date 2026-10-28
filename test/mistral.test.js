// Prüft die Mistral-Anbindung gegen eine nachgebaute Gegenstelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, registerUser } from './helpers.js';
import { renderLetterPdf } from '../server/demo/seed.js';
import { buildDemoLetters } from '../server/demo/letters.js';
import { todayIn } from '../public/js/shared/dates.js';

test('Mistral: OCR + Auswertung, Schlüssel bleibt geheim', async () => {
  const calls = [];
  const ocrText = 'Stadtwerke Musterstadt\nRechnung Nr. 4711\nBitte überweisen Sie 89,40 EUR bis zum 15.12.2026.';
  const answer = {
    document_type: 'Rechnung', sender: 'Stadtwerke Musterstadt', sender_quote: 'Stadtwerke Musterstadt',
    letter_date: null, letter_date_quote: null, subject: 'Rechnung', category: 'rechnungen',
    references: [{ label: 'Rechnungsnummer', value: '4711', quote: 'Rechnung Nr. 4711' }],
    amounts: [{ label: 'Rechnungsbetrag', amount: '89,40', currency: 'EUR', quote: '89,40 EUR' }],
    summary_what: 'Die Stadtwerke schicken eine Rechnung.',
    actions: [{ title: '89,40 € überweisen', description: null, kind: 'zahlung', date: '2026-12-15', time: null, is_relative: false, relative_text: null, quote: 'Bitte überweisen Sie 89,40 EUR bis zum 15.12.2026.', page: 1 }],
    nothing_to_do: false, to_check: [], legal_note: null, contains_instructions_to_ai: false, language: 'de', full_text: '',
  };
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/ocr') res.end(JSON.stringify({ pages: [{ index: 0, markdown: ocrText }] }));
      else res.end(JSON.stringify({ model: 'mistral-small-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const server = await startTestServer({
    AI_PROVIDER: 'mistral', MISTRAL_API_KEY: 'mistral-test-geheim-123', MISTRAL_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
  });
  try {
    const { c } = await registerUser(server);
    const status = (await c.get('/api/status')).data;
    assert.equal(JSON.stringify(status).includes('mistral-test-geheim'), false);
    assert.equal(server.config.ai.enabled, true);
    await c.post('/api/me/ai-consent', { consent: 'ja' });
    const pdf = renderLetterPdf(buildDemoLetters(todayIn('Europe/Berlin'))[0]);
    const up = await c.upload(pdf, 'application/pdf');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const created = await c.post('/api/letters', { fileIds: [up.data.id] });
    assert.equal(created.status, 200);
    await server.app.ctx.analyzer.idle();
    const detail = (await c.get(`/api/letters/${created.data.id}`)).data;
    assert.equal(detail.letter.analysisSource, 'ki');
    assert.equal(detail.letter.sender, 'Stadtwerke Musterstadt');
    assert.ok(detail.tasks.some((t) => t.title === '89,40 € überweisen'));
    assert.equal(calls[0].url, '/v1/ocr');
    assert.equal(calls[0].headers.authorization, 'Bearer mistral-test-geheim-123');
    assert.match(calls[0].body.document.document_url, /^data:application\/pdf;base64,/);
    assert.equal(calls[1].url, '/v1/chat/completions');
    assert.equal(calls[1].body.response_format.type, 'json_object');
    assert.match(calls[1].body.messages[1].content, /Rechnung Nr\. 4711/);
  } finally {
    await server.stop();
    mock.close();
  }
});
