// Gemeinsame Bausteine aller KI-Anbieter: Fehlerart, Wiederholen, JSON aus Antworten lesen.
// Fehlertexte der Anbieter werden nie ungeprüft an die Oberfläche gegeben – nur verständliche,
// eigene Meldungen. Der API-Schlüssel bleibt ausschließlich auf dem Server.

export class AiError extends Error {
  /**
   * @param {string} message verständliche Meldung für die Oberfläche
   * @param {{retryable?: boolean, code?: string, retryAfterMs?: number, perDay?: boolean}} opts
   */
  constructor(message, { retryable = false, code = 'ki_fehler', retryAfterMs = null, perDay = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.perDay = perDay;
  }
}

export const MESSAGES = {
  timeout: 'Die KI hat nicht rechtzeitig geantwortet.',
  network: 'Die KI ist gerade nicht erreichbar. Bitte prüfen Sie die Internetverbindung des Servers.',
  key: 'Der KI-Schlüssel ist ungültig oder nicht berechtigt. Bitte den Schlüssel in der Datei .env prüfen.',
  tooBig: 'Der Brief ist zu groß für die KI-Auswertung (zu viele oder zu große Seiten).',
  overloaded: 'Die KI ist gerade überlastet. Bitte später erneut versuchen.',
  quotaDay: 'Das kostenlose Tageskontingent des KI-Dienstes ist aufgebraucht. Ab morgen geht es wieder – oder Sie tragen einen anderen Schlüssel bzw. Anbieter ein.',
  quotaMinute: 'Zu viele KI-Anfragen in kurzer Zeit (kostenloses Kontingent). Bitte in einer Minute erneut versuchen.',
  refused: 'Die KI hat die Auswertung dieses Dokuments abgelehnt.',
  tooLong: 'Der Brief ist zu lang für eine vollständige Auswertung.',
  empty: 'Die KI hat keine Auswertung geliefert.',
  unreadable: 'Die Antwort der KI war unlesbar.',
  incomplete: 'Die Auswertung der KI war unvollständig.',
  model: 'Das eingestellte KI-Modell ist nicht verfügbar. Bitte den Modellnamen in der Datei .env prüfen.',
  region: 'Der KI-Dienst ist von diesem Standort aus nicht verfügbar.',
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST mit Zeitlimit. Netzwerkfehler werden zu verständlichen AiErrors. */
export async function postJson(fetchImpl, url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new AiError(timeout ? MESSAGES.timeout : MESSAGES.network, { retryable: true, code: timeout ? 'timeout' : 'netzwerk' });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data, text };
}

/** Liest ein JSON-Objekt aus einer Modellantwort (auch mit ```json-Umrahmung oder Begleittext). */
export function parseJsonText(text) {
  let t = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    const value = JSON.parse(t);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* weiter unten: Objekt aus dem Text herauslösen */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(t.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* unten */
    }
  }
  throw new AiError(MESSAGES.incomplete, { retryable: true, code: 'json' });
}

/** Wandelt das gemeinsame Schema in reines JSON Schema mit Typ-Listen für „oder null“. */
export function toTypeListSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toTypeListSchema);
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2 && schema.anyOf.some((s) => s.type === 'null')) {
    const other = schema.anyOf.find((s) => s.type !== 'null');
    const converted = toTypeListSchema(other);
    return { ...converted, type: [converted.type, 'null'] };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toTypeListSchema(v)]));
    else if (key === 'items') out.items = toTypeListSchema(value);
    else out[key] = value;
  }
  return out;
}

/** Größe einer Anfrage prüfen, bevor sie verschickt wird. */
export function assertRequestSize(body, maxBytes) {
  if (Buffer.byteLength(body) > maxBytes) throw new AiError(MESSAGES.tooBig, { code: 'zu_gross' });
}
