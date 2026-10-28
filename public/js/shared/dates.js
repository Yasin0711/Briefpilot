// Gemeinsame Datumslogik für Server und Browser.
// Wird vom Server (Node.js) und von der Oberfläche importiert, damit beide
// Seiten Fristen exakt gleich berechnen.

const MONTH_ALIASES = {
  jan: 1, januar: 1, 'jänner': 1,
  feb: 2, februar: 2,
  'mär': 3, 'märz': 3, maerz: 3, marz: 3,
  apr: 4, april: 4,
  mai: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10,
  nov: 11, november: 11,
  dez: 12, dezember: 12,
};

const MONTH_PATTERN =
  'januar|jänner|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mär|apr|jun|jul|aug|sept|sep|okt|nov|dez';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function toIso(y, m, d) {
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isValidIsoDate(iso) ? iso : null;
}

function expandYear(y) {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n < 70 ? 2000 + n : 1900 + n;
}

/**
 * Findet alle eindeutig geschriebenen Kalenderdaten in einem Text.
 * Erkennt „05.11.2026“, „5.11.26“, „5. November 2026“ und „2026-11-05“.
 * Daten ohne Jahreszahl werden bewusst NICHT erkannt (zu unsicher).
 */
export function parseGermanDates(text) {
  if (!text) return [];
  const found = [];
  const numeric = /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?![\d])/g;
  const written = new RegExp(`(?<![\\d])(\\d{1,2})\\.?\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{4})(?![\\d])`, 'gi');
  const iso = /(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;
  let m;
  while ((m = numeric.exec(text))) {
    const date = toIso(expandYear(m[3]), Number(m[2]), Number(m[1]));
    if (date) found.push({ date, index: m.index, raw: m[0] });
  }
  while ((m = written.exec(text))) {
    const month = MONTH_ALIASES[m[2].toLowerCase()];
    const date = month ? toIso(Number(m[3]), month, Number(m[1])) : null;
    if (date) found.push({ date, index: m.index, raw: m[0] });
  }
  while ((m = iso.exec(text))) {
    const date = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date) found.push({ date, index: m.index, raw: m[0] });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Findet Uhrzeiten wie „9:30 Uhr“, „09.30 Uhr“ oder „14 Uhr“. */
export function parseTimes(text) {
  if (!text) return [];
  const out = [];
  const re = /(?<![\d.:])([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*Uhr/g;
  let m;
  while ((m = re.exec(text))) out.push(`${pad(Number(m[1]))}:${m[2] || '00'}`);
  return out;
}

const NUMBER_WORDS = {
  ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eines: 1,
  zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
  elf: 11, 'zwölf': 12, zwoelf: 12, vierzehn: 14, 'einundzwanzig': 21, 'dreißig': 30, dreissig: 30,
};

const UNIT_MAP = [
  [/^tag/i, 'tage'],
  [/^woche/i, 'wochen'],
  [/^monat/i, 'monate'],
  [/^jahr/i, 'jahre'],
];

const RELATIVE_TRIGGER = /(innerhalb|binnen|frist|spätestens|nach\s+(zugang|erhalt|zustellung|bekanntgabe|eingang|empfang))/i;

/**
 * Erkennt relative Fristen, z. B. „innerhalb von zwei Wochen nach Zugang“.
 * Gibt null zurück, wenn keine relative Frist gefunden wurde.
 * anchor: 'zugang' (Zugang/Erhalt/Bekanntgabe des Briefes), 'briefdatum' oder 'unbekannt'.
 */
export function parseRelativeDeadline(text) {
  if (!text || !RELATIVE_TRIGGER.test(text)) return null;
  const numberAlt = Object.keys(NUMBER_WORDS).join('|');
  const re = new RegExp(
    `(?:innerhalb|binnen|frist\\s+von|spätestens\\s+nach|nach\\s+ablauf\\s+von)?\\s*(?:von\\s+)?(\\d{1,3}|${numberAlt})\\s+(tag(?:e|en|es)?|woche(?:n)?|monat(?:e|en|s)?|jahr(?:e|en|es)?)\\b`,
    'i'
  );
  const m = re.exec(text);
  if (!m) return null;
  const amountRaw = m[1].toLowerCase();
  const amount = /^\d+$/.test(amountRaw) ? Number(amountRaw) : NUMBER_WORDS[amountRaw];
  if (!amount || amount > 366) return null;
  let unit = null;
  for (const [pattern, u] of UNIT_MAP) if (pattern.test(m[2])) unit = u;
  if (!unit) return null;
  const after = text.slice(m.index, m.index + m[0].length + 140).toLowerCase();
  let anchor = 'unbekannt';
  if (/(nach|ab|seit)\s+(dem\s+|der\s+)?(zugang|erhalt|zustellung|bekanntgabe|eingang|empfang)/.test(after)
    || /(bekannt\s?gegeben|zugegangen|zugestellt|erhalten haben)/.test(after)) anchor = 'zugang';
  else if (/(nach|ab)\s+(dem\s+)?(rechnungsdatum|datum\s+(dieses|des)\s+schreibens|ausstellung|briefdatum)/.test(after)) anchor = 'briefdatum';
  return { amount, unit, anchor, text: m[0].trim() };
}

/** Addiert einen Zeitraum. Monatsfristen enden am Monatsende, falls der Tag fehlt (z. B. 31.01. + 1 Monat = 28./29.02.). */
export function addPeriod(isoDate, amount, unit) {
  if (!isValidIsoDate(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  if (unit === 'tage' || unit === 'wochen') {
    const days = unit === 'tage' ? amount : amount * 7;
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const months = unit === 'monate' ? amount : amount * 12;
  const total = (m - 1) + months;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return toIso(ty, tm, Math.min(d, lastDay));
}

/**
 * Rechnerisches Fristende einer relativen Frist. Liefert nur dann ein Datum,
 * wenn das nötige Ausgangsdatum (Zugangsdatum) bekannt ist.
 */
export function computeRelativeEnd(rule, { receivedDate, letterDate } = {}) {
  if (!rule) return { date: null, reason: 'keine-regel' };
  const start = rule.anchor === 'briefdatum' ? letterDate : receivedDate;
  if (!start || !isValidIsoDate(start)) {
    return { date: null, reason: rule.anchor === 'briefdatum' ? 'briefdatum-fehlt' : 'zugangsdatum-fehlt' };
  }
  return { date: addPeriod(start, rule.amount, rule.unit), reason: null, start };
}

export function daysBetween(fromIso, toIsoDate) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIsoDate + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function addDays(isoDate, days) {
  return addPeriod(isoDate, days, 'tage');
}

export function weekdayIndex(isoDate) {
  return new Date(isoDate + 'T12:00:00Z').getUTCDay();
}

export function isWeekend(isoDate) {
  const d = weekdayIndex(isoDate);
  return d === 0 || d === 6;
}

/** Heutiges Datum (YYYY-MM-DD) in einer Zeitzone. */
export function todayIn(timeZone = 'Europe/Berlin', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatDate(isoDate, { weekday = false, short = false } = {}) {
  if (!isValidIsoDate(isoDate)) return '';
  const dt = new Date(isoDate + 'T12:00:00Z');
  if (short) return new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(dt);
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC',
    weekday: weekday ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(dt);
}

/** „heute“, „morgen“, „in 5 Tagen“, „seit 2 Tagen überfällig“ … */
export function relativeDayLabel(isoDate, todayIso) {
  if (!isValidIsoDate(isoDate)) return '';
  const diff = daysBetween(todayIso, isoDate);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff === 2) return 'übermorgen';
  if (diff === -1) return 'seit gestern überfällig';
  if (diff < -1) return `seit ${-diff} Tagen überfällig`;
  if (diff < 14) return `in ${diff} Tagen`;
  const weeks = Math.round(diff / 7);
  return diff < 60 ? `in ${weeks} Wochen` : `in ${Math.round(diff / 30)} Monaten`;
}

function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour), Number(v.minute), Number(v.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wandelt „Datum + Uhrzeit in Zeitzone X“ in einen UTC-Zeitpunkt um (berücksichtigt Sommer-/Winterzeit). */
export function zonedTimeToUtc(isoDate, time, timeZone = 'Europe/Berlin') {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(new Date(utc), timeZone);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

export function formatDateTime(isoString, timeZone = 'Europe/Berlin') {
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(dt) + ' Uhr';
}
