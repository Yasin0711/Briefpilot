// Anbindung an die Claude-API von Anthropic (Texterkennung + Auswertung in einem Schritt).
// Der API-Schlüssel bleibt ausschließlich auf dem Server.
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, userInstruction } from './prompt.js';
import { AiError, MESSAGES, postJson, parseJsonText, assertRequestSize, sleep } from './ai.js';

export { AiError };

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

export function buildRequest({ files, model, today }) {
  const content = [];
  files.forEach((file, i) => {
    content.push({ type: 'text', text: `Datei ${i + 1} von ${files.length}:` });
    if (file.kind === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: file.mime, data: file.data.toString('base64') } });
    }
  });
  content.push({ type: 'text', text: userInstruction({ today, fileCount: files.length }) });
  return {
    model,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
  };
}

function classify(res) {
  // Fehlertexte der API werden nicht ungeprüft weitergegeben, nur der Typ.
  const type = res.data?.error?.type || '';
  if (res.status === 401 || res.status === 403) return new AiError(MESSAGES.key, { code: 'schluessel' });
  if (res.status === 404) return new AiError(MESSAGES.model, { code: 'modell' });
  if (res.status === 413) return new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
  if (res.status === 429 || res.status === 529 || res.status >= 500) {
    return new AiError(MESSAGES.overloaded, { retryable: true, code: `status_${res.status}` });
  }
  return new AiError(`Die KI-Anfrage wurde abgelehnt (${res.status}${type ? `, ${type}` : ''}).`, { code: `status_${res.status}` });
}

async function call(config, body, fetchImpl) {
  const payload = JSON.stringify(body);
  assertRequestSize(payload, MAX_REQUEST_BYTES);
  const url = `${config.ai.baseUrl}/v1/messages`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await postJson(fetchImpl, url, { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' }, payload, config.ai.timeoutMs);
      if (!res.ok) throw classify(res);
      if (!res.data) throw new AiError(MESSAGES.unreadable, { retryable: true, code: 'antwort' });
      const data = res.data;
      if (data.stop_reason === 'refusal') throw new AiError(MESSAGES.refused, { code: 'abgelehnt' });
      if (data.stop_reason === 'max_tokens') throw new AiError(MESSAGES.tooLong, { code: 'zu_lang' });
      const block = (data.content || []).find((c) => c.type === 'text');
      if (!block) throw new AiError(MESSAGES.empty, { retryable: true, code: 'leer' });
      return { result: parseJsonText(block.text), model: data.model || config.ai.model };
    } catch (err) {
      if (!(err instanceof AiError) || !err.retryable || attempt >= 3) throw err;
      await sleep(attempt * config.ai.retryDelayMs);
    }
  }
}

/**
 * Wertet einen Brief aus.
 * files: [{ kind: 'pdf'|'image', mime, data: Buffer }]
 * Ergebnis: { result: <Rohdaten gemäß Schema>, model }
 */
export async function analyzeWithClaude({ files, config, today, fetchImpl = fetch }) {
  return call(config, buildRequest({ files, model: config.ai.model, today }), fetchImpl);
}

/** Text-Anfrage mit JSON-Antwort (Rückfragen, Antwortentwürfe). */
export async function completeWithClaude({ system, prompt, schema, config, fetchImpl = fetch, maxTokens = 8192 }) {
  return call(config, {
    model: config.ai.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema } },
  }, fetchImpl);
}
