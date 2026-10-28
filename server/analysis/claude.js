// Anbindung an die Claude-API von Anthropic (Texterkennung + Auswertung in einem Schritt).
// Der API-Schlüssel bleibt ausschließlich auf dem Server.
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, userInstruction, formatInstruction } from './prompt.js';
import { AiError, MESSAGES, postJson, parseJsonText, assertRequestSize, sleep } from './ai.js';

export { AiError };

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

// ---------- Antwortformat für Claude ----------
// Die Claude-API erlaubt in einem Antwort-Schema nur eine begrenzte Zahl von Feldern mit
// „entweder … oder null“ (anyOf/Typ-Listen). Unser Schema hat mehr davon – die API antwortet
// dann mit „400 invalid_request_error“. Deshalb schicken wir Claude eine gleichwertige Fassung
// ohne null: fehlende Texte als "" und fehlende Seitenzahlen als 0. Nach der Antwort werden
// diese Platzhalter wieder zu null – für die App ändert sich nichts.

function nullableInner(schema) {
  if (!schema || !Array.isArray(schema.anyOf)) return null;
  const others = schema.anyOf.filter((x) => x?.type !== 'null');
  return others.length === 1 && others.length < schema.anyOf.length ? others[0] : null;
}

/** Schema ohne null-Varianten (für Claude). */
export function toClaudeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const inner = nullableInner(schema);
  if (inner) {
    const converted = toClaudeSchema(inner);
    const hint = converted.type === 'integer' || converted.type === 'number' ? '0, wenn nicht vorhanden' : 'leerer String "", wenn nicht vorhanden';
    return { ...converted, description: [converted.description, hint].filter(Boolean).join(' – ') };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toClaudeSchema(v)]));
    else if (key === 'items') out.items = toClaudeSchema(value);
    else out[key] = value;
  }
  return out;
}

/** Wandelt die Platzhalter ("" bzw. 0) in Feldern, die laut Original-Schema null sein dürfen, zurück in null. */
export function restoreNulls(value, schema) {
  if (value === undefined || value === null || !schema || typeof schema !== 'object') return value;
  const inner = nullableInner(schema);
  if (inner) {
    if (value === '' || (typeof value === 'string' && !value.trim())) return null;
    if ((inner.type === 'integer' || inner.type === 'number') && value === 0) return null;
    return restoreNulls(value, inner);
  }
  if (Array.isArray(value)) return schema.items ? value.map((v) => restoreNulls(v, schema.items)) : value;
  if (typeof value === 'object' && schema.properties) {
    const out = { ...value };
    for (const [k, sub] of Object.entries(schema.properties)) if (k in out) out[k] = restoreNulls(out[k], sub);
    return out;
  }
  return value;
}

function letterContent(files, today, note = '') {
  const content = [];
  files.forEach((file, i) => {
    content.push({ type: 'text', text: `Datei ${i + 1} von ${files.length}:` });
    if (file.kind === 'text') {
      content.push({ type: 'text', text: `${file.label || 'Ausgelesener Text'}:\n<<<DOKUMENT\n${file.text}\nDOKUMENT>>>` });
    } else if (file.kind === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageMime(file), data: file.data.toString('base64') } });
    }
  });
  content.push({ type: 'text', text: userInstruction({ today, fileCount: files.length, note }) });
  return content;
}

// Claude nimmt nur diese Bildformate an; alles andere wird anhand der Datei selbst erkannt.
function imageMime(file) {
  const mime = String(file.mime || '').toLowerCase().split(';')[0].trim().replace('image/jpg', 'image/jpeg');
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) return mime;
  const b = file.data;
  if (b?.[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b?.[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b?.[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Anfrage an Claude. Variante „schema“ nutzt das strukturierte Antwortformat,
 * Variante „text“ beschreibt das Format nur im Text (Rückfall, falls die API das Schema ablehnt).
 */
function buildBody({ model, system, content, schema, maxTokens, mode = 'schema' }) {
  const body = { model, max_tokens: maxTokens, system };
  if (mode === 'schema') {
    body.messages = [{ role: 'user', content }];
    body.output_config = { format: { type: 'json_schema', schema: toClaudeSchema(schema) } };
  } else {
    const formatBlock = { type: 'text', text: formatInstruction(schema) };
    body.messages = [{ role: 'user', content: Array.isArray(content) ? [...content, formatBlock] : `${content}\n\n${formatBlock.text}` }];
  }
  return body;
}

export function buildRequest({ files, model, today }) {
  return buildBody({ model, system: SYSTEM_PROMPT, content: letterContent(files, today), schema: RESPONSE_SCHEMA, maxTokens: 32000 });
}

function classify(res) {
  // Fehlertexte der API werden nicht ungeprüft an die Oberfläche gegeben, nur der Typ.
  // Ins Server-Protokoll kommt die Meldung der API (enthält keine Briefinhalte), damit Fehler auffindbar sind.
  const type = res.data?.error?.type || '';
  const apiMessage = String(res.data?.error?.message || '').slice(0, 400);
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    console.warn(`[KI] Claude-API antwortet ${res.status}${type ? ` (${type})` : ''}: ${apiMessage || '(ohne Meldung)'}`);
  }
  if (res.status === 401 || res.status === 403) return new AiError(MESSAGES.key, { code: 'schluessel' });
  if (res.status === 404) return new AiError(MESSAGES.model, { code: 'modell' });
  if (res.status === 413) return new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
  if (res.status === 429 || res.status === 529 || res.status >= 500) {
    return new AiError(MESSAGES.overloaded, { retryable: true, code: `status_${res.status}` });
  }
  if (res.status === 400 && /credit balance|billing|purchase credits/i.test(apiMessage)) {
    return new AiError('Das Guthaben des Claude-Kontos reicht nicht aus. Bitte unter platform.claude.com → Billing Guthaben aufladen.', { code: 'guthaben' });
  }
  if (res.status === 400 && /image|media_type|base64/i.test(apiMessage) && !/schema|output_config|format/i.test(apiMessage)) {
    return new AiError('Ein Bild des Briefes konnte von der KI nicht gelesen werden. Bitte die Seite erneut scannen.', { code: 'bild' });
  }
  return new AiError(`Die KI-Anfrage wurde abgelehnt (${res.status}${type ? `, ${type}` : ''}).`, { code: `status_${res.status}` });
}

async function send(config, body, fetchImpl) {
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
 * Erst mit strukturiertem Antwortformat; lehnt die API die Anfrage als ungültig ab (400),
 * einmal ohne Schema mit Formatbeschreibung im Text. Danach Platzhalter → null.
 */
async function call(config, { system, content, schema, maxTokens }, fetchImpl) {
  const model = config.ai.model;
  let out;
  try {
    out = await send(config, buildBody({ model, system, content, schema, maxTokens, mode: 'schema' }), fetchImpl);
  } catch (err) {
    if (!(err instanceof AiError) || err.code !== 'status_400') throw err;
    console.warn('[KI] Wiederhole die Anfrage ohne Antwort-Schema.');
    out = await send(config, buildBody({ model, system, content, schema, maxTokens: Math.min(maxTokens, 16000), mode: 'text' }), fetchImpl);
  }
  return { ...out, result: restoreNulls(out.result, schema) };
}

/**
 * Wertet einen Brief aus.
 * files: [{ kind: 'pdf'|'image', mime, data: Buffer }]
 * Ergebnis: { result: <Rohdaten gemäß Schema>, model }
 */
export async function analyzeWithClaude({ files, config, today, note = '', fetchImpl = fetch }) {
  return call(config, { system: SYSTEM_PROMPT, content: letterContent(files, today, note), schema: RESPONSE_SCHEMA, maxTokens: 32000 }, fetchImpl);
}

/** Text-Anfrage mit JSON-Antwort (Rückfragen, Antwortentwürfe). */
export async function completeWithClaude({ system, prompt, schema, config, fetchImpl = fetch, maxTokens = 8192 }) {
  return call(config, { system, content: prompt, schema, maxTokens }, fetchImpl);
}
