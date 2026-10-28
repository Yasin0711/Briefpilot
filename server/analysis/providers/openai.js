// OpenAI-kompatible Schnittstelle (/v1/chat/completions).
// Damit funktionieren viele – teils kostenlose – Dienste mit demselben Code, z. B.:
//  - Ollama oder LM Studio auf dem eigenen Computer (komplett kostenlos und offline)
//  - Groq, OpenRouter, Mistral (mit eigenem Schlüssel, je nach Anbieter mit Gratis-Kontingent)
// Für Fotos wird ein Modell mit Bildverständnis benötigt. PDFs mit Textebene werden als Text
// übergeben; gescannte PDFs (nur Bilder) kann diese Schnittstelle nicht lesen.
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, userInstruction, formatInstruction } from '../prompt.js';
import { AiError, MESSAGES, postJson, parseJsonText, assertRequestSize, sleep } from '../ai.js';
import { extractPdfText } from '../../pdf/extract.js';

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

function classify(res) {
  const message = String(res.data?.error?.message || res.data?.message || res.data?.error || '');
  if (res.status === 400) {
    if (/response_format|json_object|json mode/i.test(message)) return new AiError('format', { code: 'format' });
    if (/image|vision|multimodal|image_url/i.test(message)) {
      return new AiError('Das eingestellte KI-Modell kann keine Bilder lesen. Bitte ein Modell mit Bildverständnis eintragen (OPENAI_COMPAT_MODEL).', { code: 'kein_bild' });
    }
    if (/context|too long|maximum.*tokens/i.test(message)) return new AiError(MESSAGES.tooLong, { code: 'zu_lang' });
    return new AiError('Die KI-Anfrage wurde abgelehnt (400).', { code: 'status_400' });
  }
  if (res.status === 401 || res.status === 403) return new AiError(MESSAGES.key, { code: 'schluessel' });
  if (res.status === 404) return new AiError(MESSAGES.model, { code: 'modell' });
  if (res.status === 413) return new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
  if (res.status === 429) {
    const after = Number(res.headers?.get?.('retry-after'));
    const perDay = /per day|daily|tokens per day|requests per day/i.test(message);
    return new AiError(perDay ? MESSAGES.quotaDay : MESSAGES.quotaMinute, {
      code: 'kontingent', retryable: !perDay, retryAfterMs: Number.isFinite(after) ? after * 1000 : null, perDay,
    });
  }
  if (res.status >= 500) return new AiError(MESSAGES.overloaded, { retryable: true, code: `status_${res.status}` });
  return new AiError(`Die KI-Anfrage wurde abgelehnt (${res.status}).`, { code: `status_${res.status}` });
}

function messageText(data) {
  const choice = data?.choices?.[0];
  if (!choice) throw new AiError(MESSAGES.empty, { retryable: true, code: 'leer' });
  if (choice.finish_reason === 'length') throw new AiError(MESSAGES.tooLong, { code: 'zu_lang' });
  if (choice.finish_reason === 'content_filter') throw new AiError(MESSAGES.refused, { code: 'abgelehnt' });
  const content = choice.message?.content;
  const text = Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('') : String(content || '');
  if (!text.trim()) throw new AiError(MESSAGES.empty, { retryable: true, code: 'leer' });
  return text;
}

async function run({ config, fetchImpl, messages, maxTokens }) {
  const ai = config.ai;
  const url = `${ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {};
  let jsonMode = true;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const body = { model: ai.model, messages, max_tokens: maxTokens };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const payload = JSON.stringify(body);
    assertRequestSize(payload, MAX_REQUEST_BYTES);
    try {
      const res = await postJson(fetchImpl, url, headers, payload, ai.timeoutMs);
      if (!res.ok) throw classify(res);
      if (!res.data) throw new AiError(MESSAGES.unreadable, { retryable: true, code: 'antwort' });
      return { result: parseJsonText(messageText(res.data)), model: res.data.model || ai.model };
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      lastError = err;
      if (err.code === 'format' && jsonMode) {
        jsonMode = false;
        attempt--;
        continue;
      }
      if (err.retryable && attempt < 3) {
        await sleep(Math.min(err.retryAfterMs ?? attempt * ai.retryDelayMs, 30_000));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function analyzeLetterOpenAi({ files, config, today, fetchImpl = fetch }) {
  const content = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `Datei ${i + 1} von ${files.length}:` });
    if (f.kind === 'pdf') {
      const { text } = extractPdfText(f.data);
      if (!text || text.replace(/\s|-|Seite \d+/g, '').length < 40) {
        throw new AiError('Dieser KI-Dienst kann gescannte PDF-Dateien (nur Bilder) nicht lesen. Bitte die Seiten mit der Kamera in BriefPilot scannen oder Gemini verwenden.', { code: 'pdf_ohne_text' });
      }
      content.push({ type: 'text', text: `Automatisch ausgelesener Text dieser PDF-Datei:\n${text.slice(0, 60000)}` });
    } else {
      content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data.toString('base64')}` } });
    }
  });
  content.push({ type: 'text', text: `${userInstruction({ today, fileCount: files.length })}\n\n${formatInstruction(RESPONSE_SCHEMA)}` });
  return run({ config, fetchImpl, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }], maxTokens: 16384 });
}

export async function completeJsonOpenAi({ system, prompt, schema, config, fetchImpl = fetch, maxTokens = 8192 }) {
  return run({
    config, fetchImpl, maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: `${prompt}\n\n${formatInstruction(schema)}` }],
  });
}
