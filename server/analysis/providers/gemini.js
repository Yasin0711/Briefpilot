// Google Gemini (Gemini API, Endpunkt generateContent).
// Kostenlos testbar: Schlüssel aus Google AI Studio (aistudio.google.com), ohne Zahlungsdaten.
// Ohne aktiviertes Rechnungskonto entstehen keine Kosten – ist das Gratis-Kontingent erschöpft,
// antwortet Google mit „429 RESOURCE_EXHAUSTED“, und BriefPilot meldet das verständlich.
//
// Ablauf bei Problemen:
//  - Kontingent des Hauptmodells erschöpft oder Modell nicht verfügbar → Ersatzmodell (eigenes Kontingent)
//  - Kurzfristige Überlastung → bis zu zwei Wiederholungen
//  - Antwortformat (JSON-Schema) vom Modell nicht unterstützt → einmal ohne Schema, mit Formatbeschreibung
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, userInstruction, formatInstruction } from '../prompt.js';
import { AiError, MESSAGES, postJson, parseJsonText, toTypeListSchema, assertRequestSize, sleep } from '../ai.js';

// Google erlaubt eingebettete Dateien bis 20 MB je Anfrage (Base64 eingerechnet)
const MAX_REQUEST_BYTES = 19.5 * 1024 * 1024;
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

function parseDelay(value) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value || ''));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

function classify(res) {
  const err = res.data?.error || {};
  const message = String(err.message || '');
  const status = String(err.status || '');
  if (res.status === 400) {
    if (/response_?json_?schema|responseJsonSchema|response_?schema|json schema|schema/i.test(message)) return new AiError('schema', { code: 'schema' });
    if (/location is not supported|not available in your country|enable billing/i.test(message)) return new AiError(MESSAGES.region, { code: 'region' });
    if (/api key not valid|api_key_invalid|api key expired/i.test(message)) return new AiError(MESSAGES.key, { code: 'schluessel' });
    if (/too large|exceeds the maximum|payload size|request entity/i.test(message)) return new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
    return new AiError(`Die KI-Anfrage wurde abgelehnt (400${status ? `, ${status}` : ''}).`, { code: 'status_400' });
  }
  if (res.status === 401 || res.status === 403) return new AiError(MESSAGES.key, { code: 'schluessel' });
  if (res.status === 404) return new AiError(MESSAGES.model, { code: 'modell' });
  if (res.status === 413) return new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
  if (res.status === 429) {
    const details = Array.isArray(err.details) ? err.details : [];
    const retry = details.find((d) => String(d?.['@type'] || '').includes('RetryInfo'));
    const quota = details.find((d) => String(d?.['@type'] || '').includes('QuotaFailure'));
    const perDay = /PerDay/i.test(JSON.stringify(quota || {})) || /per day|daily/i.test(message);
    return new AiError(perDay ? MESSAGES.quotaDay : MESSAGES.quotaMinute, {
      code: 'kontingent', retryable: !perDay, retryAfterMs: parseDelay(retry?.retryDelay), perDay,
    });
  }
  if (res.status >= 500) return new AiError(MESSAGES.overloaded, { retryable: true, code: `status_${res.status}` });
  return new AiError(`Die KI-Anfrage wurde abgelehnt (${res.status}).`, { code: `status_${res.status}` });
}

/** Text der Antwort ohne „Gedanken“-Teile (Gemini 3 denkt vor der Antwort). */
export function extractText(data) {
  if (data?.promptFeedback?.blockReason) throw new AiError(MESSAGES.refused, { code: 'abgelehnt' });
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new AiError(MESSAGES.empty, { retryable: true, code: 'leer' });
  if (candidate.finishReason === 'MAX_TOKENS') throw new AiError(MESSAGES.tooLong, { code: 'zu_lang' });
  if (BLOCKED.has(candidate.finishReason)) throw new AiError(MESSAGES.refused, { code: 'abgelehnt' });
  const text = (candidate.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!text.trim()) throw new AiError(MESSAGES.empty, { retryable: true, code: 'leer' });
  return text;
}

export function buildGeminiRequest({ system, parts, schema, useSchema = true, maxOutputTokens = 32768 }) {
  const generationConfig = { responseMimeType: 'application/json', maxOutputTokens };
  if (useSchema && schema) generationConfig.responseJsonSchema = toTypeListSchema(schema);
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: useSchema ? parts : [...parts, { text: formatInstruction(schema) }] }],
    generationConfig,
  };
}

async function run({ config, fetchImpl, build }) {
  const ai = config.ai;
  const models = [...new Set([ai.model, ai.fallbackModel].filter(Boolean))];
  let lastError = null;
  for (const [index, model] of models.entries()) {
    const isLast = index === models.length - 1;
    let useSchema = true;
    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      const body = JSON.stringify(build(useSchema));
      assertRequestSize(body, MAX_REQUEST_BYTES);
      const url = `${ai.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      try {
        const res = await postJson(fetchImpl, url, { 'x-goog-api-key': ai.apiKey }, body, ai.timeoutMs);
        if (!res.ok) throw classify(res);
        if (!res.data) throw new AiError(MESSAGES.unreadable, { retryable: true, code: 'antwort' });
        const result = parseJsonText(extractText(res.data));
        return { result, model: res.data.modelVersion || model, usage: res.data.usageMetadata || null };
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        lastError = err;
        if (err.code === 'schema' && useSchema) {
          useSchema = false; // Modell kennt das Antwortformat nicht: ohne Schema, mit Formatbeschreibung
          attempt--;
          continue;
        }
        if (err.code === 'modell') break;
        if (err.code === 'kontingent') {
          if (!err.perDay && isLast && attempt < 3) {
            await sleep(Math.min(err.retryAfterMs ?? ai.retryDelayMs, 30_000));
            continue;
          }
          break; // Ersatzmodell hat ein eigenes Kontingent
        }
        if (err.retryable && attempt < 3) {
          await sleep(attempt * ai.retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError || new AiError(MESSAGES.empty, { code: 'leer' });
}

/** Brief lesen und auswerten (Fotos und PDFs werden direkt übergeben, auch gescannte PDFs). */
export async function analyzeLetterGemini({ files, config, today, note = '', fetchImpl = fetch }) {
  const parts = [];
  files.forEach((f, i) => {
    parts.push({ text: `Datei ${i + 1} von ${files.length}:` });
    if (f.kind === 'text') parts.push({ text: `${f.label || 'Ausgelesener Text'}:\n<<<DOKUMENT\n${f.text}\nDOKUMENT>>>` });
    else parts.push({ inlineData: { mimeType: f.kind === 'pdf' ? 'application/pdf' : f.mime, data: f.data.toString('base64') } });
  });
  parts.push({ text: userInstruction({ today, fileCount: files.length, note }) });
  return run({ config, fetchImpl, build: (useSchema) => buildGeminiRequest({ system: SYSTEM_PROMPT, parts, schema: RESPONSE_SCHEMA, useSchema }) });
}

/** Text-Anfrage mit JSON-Antwort (Rückfragen, Antwortentwürfe). */
export async function completeJsonGemini({ system, prompt, schema, config, fetchImpl = fetch, maxTokens = 8192 }) {
  const parts = [{ text: prompt }];
  return run({ config, fetchImpl, build: (useSchema) => buildGeminiRequest({ system, parts, schema, useSchema, maxOutputTokens: maxTokens }) });
}
