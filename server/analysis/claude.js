// Anbindung an die Claude-API von Anthropic (Texterkennung + Auswertung in einem Schritt).
// Der API-Schlüssel bleibt ausschließlich auf dem Server.
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, userInstruction } from './prompt.js';

export class AiError extends Error {
  constructor(message, { retryable = false, code = 'ki_fehler' } = {}) {
    super(message);
    this.retryable = retryable;
    this.code = code;
  }
}

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

async function callOnce(url, apiKey, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError';
    throw new AiError(timeout ? 'Die KI hat nicht rechtzeitig geantwortet.' : 'Die KI ist gerade nicht erreichbar.', { retryable: true, code: timeout ? 'timeout' : 'netzwerk' });
  }
  const text = await res.text();
  if (!res.ok) {
    // Fehlertexte der API werden nicht ungeprüft weitergegeben, nur der Typ.
    let type = '';
    try {
      type = JSON.parse(text)?.error?.type || '';
    } catch {
      type = '';
    }
    if (res.status === 401 || res.status === 403) throw new AiError('Der KI-Schlüssel ist ungültig oder nicht berechtigt.', { code: 'schluessel' });
    if (res.status === 413) throw new AiError('Der Brief ist zu groß für die KI-Auswertung.', { code: 'zu_gross' });
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      throw new AiError('Die KI ist gerade überlastet. Bitte später erneut versuchen.', { retryable: true, code: `status_${res.status}` });
    }
    throw new AiError(`Die KI-Anfrage wurde abgelehnt (${res.status}${type ? `, ${type}` : ''}).`, { code: `status_${res.status}` });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('Die Antwort der KI war unlesbar.', { retryable: true, code: 'antwort' });
  }
  return data;
}

/**
 * Wertet einen Brief aus.
 * files: [{ kind: 'pdf'|'image', mime, data: Buffer }]
 * Ergebnis: { result: <Rohdaten gemäß Schema>, model }
 */
export async function analyzeWithClaude({ files, config, today }) {
  const requestBody = JSON.stringify(buildRequest({ files, model: config.ai.model, today }));
  if (Buffer.byteLength(requestBody) > MAX_REQUEST_BYTES) {
    throw new AiError('Der Brief ist zu groß für die KI-Auswertung (zu viele oder zu große Seiten).', { code: 'zu_gross' });
  }
  const url = `${config.ai.baseUrl}/v1/messages`;
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      data = await callOnce(url, config.ai.apiKey, requestBody, config.ai.timeoutMs);
      break;
    } catch (err) {
      if (!(err instanceof AiError) || !err.retryable || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  if (data.stop_reason === 'refusal') throw new AiError('Die KI hat die Auswertung dieses Dokuments abgelehnt.', { code: 'abgelehnt' });
  if (data.stop_reason === 'max_tokens') throw new AiError('Der Brief ist zu lang für eine vollständige Auswertung.', { code: 'zu_lang' });
  const block = (data.content || []).find((c) => c.type === 'text');
  if (!block) throw new AiError('Die KI hat keine Auswertung geliefert.', { retryable: true, code: 'leer' });
  let result;
  try {
    result = JSON.parse(block.text);
  } catch {
    throw new AiError('Die Auswertung der KI war unvollständig.', { retryable: true, code: 'json' });
  }
  return { result, model: data.model || config.ai.model };
}
