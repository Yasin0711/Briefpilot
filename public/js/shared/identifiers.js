// Kennungen in Briefen: Kfz-Kennzeichen, FIN, Vertrags-, Kunden-, Zähler-, Rechnungsnummern …
// Gemeinsam für Server und Oberfläche: Arten, Normalisierung, Vergleich, Erkennung im Text.
//
// Grundsatz: Zwei Kennungen gelten nur dann als gleich, wenn sie nach dem Entfernen von
// Leer- und Trennzeichen übereinstimmen UND die Schreibweise nicht auf eine andere
// Kennung hindeutet (z. B. „SB-AB 123“ ≠ „SBA-B 123“, obwohl beide zu „SBAB123“ werden).

/**
 * scope:  'global' = praktisch eindeutig (Kennzeichen, FIN, Zählernummer, MaLo-ID …)
 *         'issuer' = nur zusammen mit dem passenden Absender aussagekräftig (Rechnungs-, Kundennummer …)
 * level:  'objekt' = kennzeichnet eine Akte (Fahrzeug, Zähler, Vertrag)
 *         'vorgang' = kennzeichnet einen Vorgang innerhalb einer Akte (Rechnung, Schadenfall)
 * weight: Grundgewicht für die Zuordnung (exakter Treffer, passender Kontext)
 */
export const IDENTIFIER_KINDS = [
  { id: 'kennzeichen', label: 'Kfz-Kennzeichen', scope: 'global', level: 'objekt', weight: 100 },
  { id: 'fin', label: 'Fahrzeug-Ident.-Nr. (FIN)', scope: 'global', level: 'objekt', weight: 100 },
  { id: 'versicherungsnummer', label: 'Versicherungsschein-Nr.', scope: 'issuer', level: 'objekt', weight: 95 },
  { id: 'vertragsnummer', label: 'Vertragsnummer', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'kundennummer', label: 'Kundennummer', scope: 'issuer', level: 'objekt', weight: 85 },
  { id: 'vertragskonto', label: 'Vertragskonto', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'zaehlernummer', label: 'Zählernummer', scope: 'global', level: 'objekt', weight: 100 },
  { id: 'malo_id', label: 'Marktlokations-ID (MaLo)', scope: 'global', level: 'objekt', weight: 100 },
  { id: 'melo_id', label: 'Messlokations-ID (MeLo)', scope: 'global', level: 'objekt', weight: 100 },
  { id: 'objektadresse', label: 'Liefer-/Objektadresse', scope: 'issuer', level: 'objekt', weight: 80 },
  { id: 'anschlusskennung', label: 'Anschlusskennung/Rufnummer', scope: 'issuer', level: 'objekt', weight: 85 },
  { id: 'mitgliedsnummer', label: 'Mitglieds-/Versichertennummer', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'darlehensnummer', label: 'Darlehens-/Kreditnummer', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'iban', label: 'IBAN', scope: 'issuer', level: 'objekt', weight: 80 },
  { id: 'mietvertragsnummer', label: 'Mietvertragsnummer', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'wohnungsnummer', label: 'Wohnungs-/Objektnummer', scope: 'issuer', level: 'objekt', weight: 70 },
  { id: 'steuernummer', label: 'Steuernummer/Steuer-ID', scope: 'issuer', level: 'objekt', weight: 90 },
  { id: 'aktenzeichen', label: 'Aktenzeichen/Geschäftszeichen', scope: 'issuer', level: 'vorgang', weight: 90 },
  { id: 'schadennummer', label: 'Schadennummer', scope: 'issuer', level: 'vorgang', weight: 95 },
  { id: 'rechnungsnummer', label: 'Rechnungsnummer', scope: 'issuer', level: 'vorgang', weight: 90 },
  { id: 'bestellnummer', label: 'Bestell-/Auftragsnummer', scope: 'issuer', level: 'vorgang', weight: 90 },
  { id: 'sendungsnummer', label: 'Sendungsnummer', scope: 'global', level: 'vorgang', weight: 95 },
  { id: 'vorgangsnummer', label: 'Vorgangsnummer', scope: 'issuer', level: 'vorgang', weight: 90 },
  { id: 'kassenzeichen', label: 'Kassenzeichen', scope: 'issuer', level: 'vorgang', weight: 90 },
  { id: 'sonstiges', label: 'Sonstige Nummer', scope: 'issuer', level: 'objekt', weight: 60 },
];
export const IDENTIFIER_KIND_IDS = IDENTIFIER_KINDS.map((k) => k.id);
const KIND_BY_ID = new Map(IDENTIFIER_KINDS.map((k) => [k.id, k]));

export function identifierKind(id) {
  return KIND_BY_ID.get(id) || KIND_BY_ID.get('sonstiges');
}
export function identifierKindLabel(id) {
  return identifierKind(id).label;
}

// Reihenfolge ist wichtig: Speziellere Begriffe zuerst.
const LABEL_RULES = [
  [/kennzeichen|kfz-?kennz|amtl\.?\s*kennz/i, 'kennzeichen'],
  [/\bfin\b|fahrzeug-?ident|fahrgestell|\bvin\b/i, 'fin'],
  [/schaden\s*-?\s*(nr|nummer|fall)|schadennr/i, 'schadennummer'],
  [/versicherungsschein|police|versicherungs-?\s*(nr|nummer)|vers\.\s*-?\s*nr|vertrags-?\s*nr\.?\s*\(?versich/i, 'versicherungsnummer'],
  [/z[äa]hler\s*-?\s*(nr|nummer)|z[äa]hlernr|gasz[äa]hler|wasserz[äa]hler|stromz[äa]hler|z[äa]hler\s*:/i, 'zaehlernummer'],
  [/marktlokation|\bmalo\b/i, 'malo_id'],
  [/messlokation|\bmelo\b|z[äa]hlpunkt/i, 'melo_id'],
  [/vertragskonto/i, 'vertragskonto'],
  [/darlehens|kredit\s*-?\s*(nr|nummer|konto)/i, 'darlehensnummer'],
  [/mietvertrag/i, 'mietvertragsnummer'],
  [/vertrags\s*-?\s*(nr|nummer)|vertragsnr/i, 'vertragsnummer'],
  [/kunden\s*-?\s*(nr|nummer|konto)|kundennr/i, 'kundennummer'],
  [/rechnungs\s*-?\s*(nr|nummer)|rechnungsnr|beleg\s*-?\s*nr/i, 'rechnungsnummer'],
  [/bestell\s*-?\s*(nr|nummer)|auftrags\s*-?\s*(nr|nummer)/i, 'bestellnummer'],
  [/sendungs\s*-?\s*(nr|nummer)|tracking|paket\s*-?\s*nr/i, 'sendungsnummer'],
  [/mitglieds\s*-?\s*(nr|nummer)|versicherten\s*-?\s*(nr|nummer)|krankenversichertennummer|kvnr|patienten\s*-?\s*(nr|nummer)/i, 'mitgliedsnummer'],
  [/\biban\b/i, 'iban'],
  [/lieferadresse|lieferstelle|verbrauchsstelle|objektadresse|mietobjekt|abnahmestelle/i, 'objektadresse'],
  [/wohnungs\s*-?\s*(nr|nummer)|whg\.?\s*-?\s*nr|objekt\s*-?\s*(nr|nummer)/i, 'wohnungsnummer'],
  [/steuer\s*-?\s*(nr|nummer|id)|steuernr|identifikationsnummer/i, 'steuernummer'],
  [/anschlusskennung|anschluss\s*-?\s*(nr|nummer)|rufnummer|telefonnummer/i, 'anschlusskennung'],
  [/kassenzeichen/i, 'kassenzeichen'],
  [/vorgangs\s*-?\s*(nr|nummer)|vorgang\s*:/i, 'vorgangsnummer'],
  [/aktenzeichen|\baz\b\.?|gesch[äa]ftszeichen|unser zeichen|ihr zeichen|buchungszeichen/i, 'aktenzeichen'],
];

/** Ordnet eine Bezeichnung aus dem Brief („Versicherungsschein-Nr.“) einer Art zu. */
export function kindFromLabel(label) {
  const text = String(label || '');
  const exact = IDENTIFIER_KINDS.find((k) => k.label.toLowerCase() === text.trim().toLowerCase());
  if (exact) return exact.id;
  for (const [re, kind] of LABEL_RULES) if (re.test(text)) return kind;
  return 'sonstiges';
}

// ---------- Normalisierung ----------

const PLATE_RE = /^([A-ZÄÖÜ]{1,3})[\s-]+([A-Z]{1,2})[\s-]*(\d{1,4})([EH]?)$/u;

/** Kfz-Kennzeichen in Bestandteile zerlegen. Nur möglich, wenn das Trennzeichen nach dem Ortskürzel erkennbar ist. */
export function parsePlate(value) {
  const v = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = PLATE_RE.exec(v);
  if (!m) return null;
  return { district: m[1], letters: m[2], digits: m[3], suffix: m[4] || '', canonical: `${m[1]}-${m[2]} ${m[3]}${m[4] || ''}` };
}

function addressTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/stra(ss)?e\b|str\.(?=\s|\d|$)/g, 'str')
    .replace(/(\d+)\s+([a-z])\b/g, '$1$2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Adressen werden über Straße und Hausnummer verglichen (Wohnungszusatz, PLZ und Ort zählen nicht):
 * „Ahornstraße 5, 12345 Musterstadt“ = „Ahornstr. 5“, aber „Lindenweg 12“ ≠ „Lindenweg 123“.
 */
function normalizeAddress(value) {
  const tokens = addressTokens(value);
  const numberAt = tokens.findIndex((t) => /\d/.test(t));
  return (numberAt >= 0 ? tokens.slice(0, numberAt + 1) : tokens).join('').toUpperCase();
}

/** Ganzer Text in derselben Schreibweise wie normalisierte Adressen (für „steht das im Brief?“). */
export function compactAddressText(text) {
  return addressTokens(text).join('').toUpperCase();
}

/** Vergleichsform: Großbuchstaben, ohne Leer-, Binde-, Schräg- und Punktzeichen. */
export function normalizeIdentifier(kind, value) {
  if (kind === 'objektadresse') return normalizeAddress(value);
  return String(value || '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Häufige Verwechslungen bei der Texterkennung (OCR) – nur für „ähnlich“, nie für „gleich“
const OCR_FOLD = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
function ocrFold(s) {
  return s.replace(/[OQDILSBZG]/g, (c) => OCR_FOLD[c]);
}

function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Vergleicht zwei Kennungen.
 * @returns 'exakt' | 'schreibweise' | 'aehnlich' | null
 *   exakt        – gleiche Kennung (Leer-/Trennzeichen und Groß-/Kleinschreibung egal)
 *   schreibweise – gleiche Zeichenfolge, aber eine Seite ohne erkennbare Gliederung (z. B. „SBAB123“)
 *   aehnlich     – ein Zeichen anders oder typische Lese-Verwechslung (O/0, I/1 …): nie automatisch zuordnen
 */
export function compareIdentifiers(a, b) {
  const kindA = a.kind;
  const kindB = b.kind;
  const plateA = kindA === 'kennzeichen' || kindB === 'kennzeichen';
  const na = a.normalized ?? normalizeIdentifier(kindA, a.value);
  const nb = b.normalized ?? normalizeIdentifier(kindB, b.value);
  if (!na || !nb || na.length < 3 || nb.length < 3) return null;
  if (plateA) {
    // Kennzeichen nur mit Kennzeichen oder unbekannter Art vergleichen
    const other = kindA === 'kennzeichen' ? kindB : kindA;
    if (other !== 'kennzeichen' && other !== 'sonstiges') return null;
    const pa = parsePlate(a.value);
    const pb = parsePlate(b.value);
    if (na === nb) {
      if (pa && pb) return pa.canonical === pb.canonical ? 'exakt' : null; // „SB-AB 123“ ≠ „SBA-B 123“
      return 'schreibweise';
    }
    if (pa && pb && pa.district === pb.district && pa.letters === pb.letters && levenshtein(pa.digits, pb.digits, 1) === 1) return 'aehnlich';
    if (na.length >= 5 && ocrFold(na) === ocrFold(nb)) return 'aehnlich';
    return null;
  }
  if (kindA === 'objektadresse' || kindB === 'objektadresse') {
    if (kindA !== kindB) return null;
    return na === nb ? 'exakt' : null;
  }
  if (na === nb) return 'exakt';
  if (na.length >= 5 && nb.length >= 5) {
    if (ocrFold(na) === ocrFold(nb)) return 'aehnlich';
    if (levenshtein(na, nb, 1) === 1) return 'aehnlich';
  }
  return null;
}

// ---------- Absender / Vertragspartner vergleichen ----------

const ORG_STOPWORDS = new Set([
  'gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'se', 'ohg', 'gbr', 'ug', 'haftungsbeschränkt', 'ev', 'e', 'v', 'ltd', 'co', 'und', 'der', 'die', 'das',
  'dem', 'den', 'des', 'für', 'fur', 'von', 'zu', 'zum', 'zur', 'ihr', 'ihre', 'kundenservice', 'service', 'team', 'abteilung', 'filiale',
  'niederlassung', 'zentrale', 'inc', 'llc', 'sa', 'bv', 'nv', 'plc', 'partner', 'partnerin',
]);

export function orgTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !ORG_STOPWORDS.has(t));
}

/** Normalisierter Schlüssel eines Absenders (für Speicherung und schnellen Vergleich). */
export function orgKey(name) {
  return orgTokens(name).join(' ');
}

/** Passt der Absender eines Briefes zum Vertragspartner einer Akte? 'ja' | 'nein' | 'unbekannt' */
export function orgMatches(a, b) {
  const ta = new Set(orgTokens(a));
  const tb = new Set(orgTokens(b));
  if (!ta.size || !tb.size) return 'unbekannt';
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const smaller = Math.min(ta.size, tb.size);
  if (common === smaller) return 'ja'; // „Muster Versicherung“ ⊂ „Muster Versicherung AG Schadenservice“
  const jaccard = common / (ta.size + tb.size - common);
  return jaccard >= 0.5 ? 'ja' : 'nein';
}

// ---------- Erkennung im Brieftext (ohne KI) ----------

const LABEL_ALTERNATION = [
  'amtl\\.?\\s*Kennzeichen', 'Kfz-?Kennzeichen', 'Kennzeichen', 'Fahrzeug-?Ident(?:\\.|ifikations)?-?(?:Nr\\.?|nummer)', 'FIN', 'VIN', 'Fahrgestellnummer',
  'Versicherungsschein-?(?:Nr\\.?|nummer)?', 'Versicherungs-?(?:Nr\\.?|nummer)', 'Police(?:n-?(?:Nr\\.?|nummer))?', 'Vers\\.-?Nr\\.?',
  'Schaden-?(?:Nr\\.?|nummer)', 'Schadennummer', 'Zähler-?(?:Nr\\.?|nummer)', 'Zählernummer', 'Gaszähler(?:-?(?:Nr\\.?|nummer))?', 'Wasserzähler(?:-?(?:Nr\\.?|nummer))?', 'Stromzähler(?:-?(?:Nr\\.?|nummer))?',
  'Marktlokations-?(?:ID|Nr\\.?|nummer)?', 'MaLo-?ID', 'Messlokations-?(?:ID|Nr\\.?|nummer)?', 'MeLo-?ID', 'Zählpunkt(?:bezeichnung)?',
  'Vertragskonto(?:-?(?:Nr\\.?|nummer))?', 'Vertrags-?(?:Nr\\.?|nummer)', 'Vertragsnummer', 'Kunden-?(?:Nr\\.?|nummer)', 'Kundennummer',
  'Rechnungs-?(?:Nr\\.?|nummer)', 'Rechnungsnummer', 'Beleg-?(?:Nr\\.?|nummer)', 'Bestell-?(?:Nr\\.?|nummer)', 'Auftrags-?(?:Nr\\.?|nummer)', 'Sendungs-?(?:Nr\\.?|nummer)',
  'Mitglieds-?(?:Nr\\.?|nummer)', 'Versicherten-?(?:Nr\\.?|nummer)', 'Patienten-?(?:Nr\\.?|nummer)', 'Krankenversichertennummer', 'Darlehens-?(?:Nr\\.?|nummer)', 'Kredit-?(?:Nr\\.?|nummer)',
  'Mietvertrags-?(?:Nr\\.?|nummer)', 'Wohnungs-?(?:Nr\\.?|nummer)', 'Objekt-?(?:Nr\\.?|nummer)', 'Steuer-?(?:Nr\\.?|nummer)', 'Steuer-?ID', 'Steuernummer',
  'Anschlusskennung', 'Anschluss-?(?:Nr\\.?|nummer)', 'Rufnummer', 'Kassenzeichen', 'Vorgangs-?(?:Nr\\.?|nummer)', 'Vorgang',
  'Aktenzeichen', 'Az\\.', 'Geschäftszeichen', 'Unser Zeichen', 'Ihr Zeichen', 'Buchungszeichen', 'IBAN',
  'Lieferadresse', 'Lieferstelle', 'Verbrauchsstelle', 'Abnahmestelle', 'Mietobjekt',
].join('|');

const LABELED_RE = new RegExp(`(?<![\\p{L}])(${LABEL_ALTERNATION})(?![\\p{L}\\d])(?:\\s*\\((?:neu|alt|bisher)\\))?\\s*[:.]?\\s*([^\\n]{2,80})`, 'giu');
const PLATE_IN_TEXT = /(?<![\p{L}\d-])([A-ZÄÖÜ]{1,3}-[A-Z]{1,2}[ -]?\d{1,4}[EH]?)(?![\p{L}\d])/gu;
const FIN_IN_TEXT = /(?<![A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Z0-9])/g;
const IBAN_IN_TEXT = /(?<![A-Z0-9])([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?)(?![A-Z0-9])/g;
const MELO_IN_TEXT = /(?<![A-Z0-9])(DE[ ]?(?:[A-Z0-9][ ]?){31})(?![A-Z0-9])/g;

const VALUE_STOP = /\s{2,}|\s[·|•]\s|;|\s(?:vom|von|für|bis|ab|am|zum|zur|und|bitte|Datum|Seite)\b/iu;
const NEXT_LABEL = new RegExp(`\\s(?:${LABEL_ALTERNATION})(?:\\s*\\((?:neu|alt|bisher)\\))?\\s*[:.]`, 'iu');

/** Schneidet den Wert nach einer weiteren Bezeichnung in derselben Zeile ab („Kundennummer: 123 Vertragskonto: 456“). */
function cutAtNextLabel(raw) {
  const next = NEXT_LABEL.exec(raw);
  return next ? raw.slice(0, next.index) : raw;
}

function cleanValue(kind, raw) {
  let v = String(raw).split(VALUE_STOP)[0].trim();
  if (kind === 'objektadresse') return v.replace(/[.;]+$/, '').slice(0, 120);
  v = cutAtNextLabel(v).trim();
  v = v.replace(/[,.;:)]+$/, '').trim();
  if (kind === 'kennzeichen') {
    const m = /^[A-ZÄÖÜ]{1,3}[\s-]+[A-Z]{1,2}[\s-]*\d{1,4}[EH]?/u.exec(v.toUpperCase());
    return m ? m[0] : '';
  }
  if (kind === 'iban') {
    const m = /^[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}/.exec(v.toUpperCase());
    return m ? m[0].trim() : '';
  }
  // Zahlenkennungen: nur Ziffern, Buchstaben und übliche Trennzeichen; höchstens 3 Wörter
  const m = /^[\p{L}\p{N}][\p{L}\p{N}/.\- ]*$/u.exec(v);
  if (!m) return '';
  const words = v.split(' ');
  if (words.length > 4) v = words.slice(0, 4).join(' ');
  return /\d/.test(v) ? v.slice(0, 60) : '';
}

export function isValidIban(value) {
  const v = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

function pageAt(text, index) {
  let page = null;
  const re = /--- Seite (\d+) ---/g;
  let m;
  while ((m = re.exec(text)) && m.index <= index) page = Number(m[1]);
  return page;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim().slice(0, 300);
}

/**
 * Findet Kennungen im Brieftext. Mit Bezeichnung („Kundennummer: 123“) und – für gut
 * erkennbare Formate – auch ohne (Kennzeichen „SB-AB 123“, FIN, IBAN, Messlokation).
 * @returns {Array<{kind,label,value,normalized,quote,page,status}>}
 */
export function extractIdentifiers(text) {
  const t = String(text || '');
  const out = [];
  const add = (item) => {
    const normalized = normalizeIdentifier(item.kind, item.value);
    if (normalized.length < 3) return;
    if (out.some((o) => o.normalized === normalized && (o.kind === item.kind || item.kind === 'sonstiges'))) return;
    // Gleiche Nummer bereits als andere Art erkannt (z. B. per Bezeichnung) – nicht doppelt aufführen
    if (out.some((o) => o.normalized === normalized && item.unlabeled)) return;
    out.push({ ...item, normalized, unlabeled: undefined });
  };

  const labeled = new RegExp(LABELED_RE.source, LABELED_RE.flags);
  let m;
  while ((m = labeled.exec(t))) {
    // Nach dem Wert weitersuchen – nicht erst am Zeilenende –, damit mehrere Angaben je Zeile gefunden werden
    const valueStart = m.index + m[0].length - m[2].length;
    labeled.lastIndex = Math.max(m.index + 1, valueStart + cutAtNextLabel(m[2]).length);
    const label = m[1].replace(/\s+/g, ' ');
    const kind = kindFromLabel(label);
    const value = cleanValue(kind, m[2]);
    if (!value) continue;
    if (kind === 'iban' && !isValidIban(value)) continue;
    const marker = /\((neu|alt|bisher)\)/i.exec(m[0]);
    let status = null;
    if (marker) status = marker[1].toLowerCase() === 'neu' ? 'neu' : 'alt';
    else if (/\b(bisherige|alte|frühere)\s*$/i.test(t.slice(Math.max(0, m.index - 25), m.index))) status = 'alt';
    else if (/\b(neue)\s*$/i.test(t.slice(Math.max(0, m.index - 12), m.index))) status = 'neu';
    add({ kind, label, value, quote: lineAt(t, m.index), page: pageAt(t, m.index), status });
  }
  for (const m of t.matchAll(PLATE_IN_TEXT)) {
    if (!parsePlate(m[1])) continue;
    add({ kind: 'kennzeichen', label: 'Kennzeichen', value: m[1], quote: lineAt(t, m.index), page: pageAt(t, m.index), status: null, unlabeled: true });
  }
  for (const m of t.matchAll(FIN_IN_TEXT)) {
    const v = m[1];
    if (!/[A-Z]/.test(v) || (v.match(/\d/g) || []).length < 4) continue;
    add({ kind: 'fin', label: 'FIN', value: v, quote: lineAt(t, m.index), page: pageAt(t, m.index), status: null, unlabeled: true });
  }
  for (const m of t.matchAll(IBAN_IN_TEXT)) {
    if (!isValidIban(m[1])) continue;
    add({ kind: 'iban', label: 'IBAN', value: m[1], quote: lineAt(t, m.index), page: pageAt(t, m.index), status: null, unlabeled: true });
  }
  for (const m of t.matchAll(MELO_IN_TEXT)) {
    add({ kind: 'melo_id', label: 'Messlokation', value: m[1].replace(/\s+/g, ''), quote: lineAt(t, m.index), page: pageAt(t, m.index), status: null, unlabeled: true });
  }
  return out.slice(0, 40);
}
