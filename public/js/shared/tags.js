// Schlagworte (Tags) für Briefe und Dokumente – gemeinsam für Server und Oberfläche.

export const MAX_TAGS = 6;

/** Bereinigt eine Liste: kurz, ohne Doppelte, erster Buchstabe groß, höchstens MAX_TAGS. */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,;\n]/) : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    let t = String(raw || '').replace(/^#/, '').replace(/[<>{}[\]"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
    if (t.length < 2) continue;
    t = t.charAt(0).toLocaleUpperCase('de-DE') + t.slice(1);
    const key = t.toLocaleLowerCase('de-DE');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const CATEGORY_TAG = {
  behoerden: 'Behörde', versicherungen: 'Versicherung', gesundheit: 'Gesundheit', wohnen: 'Wohnen', arbeit: 'Arbeit',
  vertraege: 'Vertrag', rechnungen: 'Rechnung', bank: 'Bank',
};

const KEYWORD_TAGS = [
  [/finanzamt|steuer/, 'Steuer'], [/kfz|fahrzeug|kennzeichen|auto\b/, 'Auto'], [/strom/, 'Strom'], [/\bgas\b|erdgas/, 'Gas'],
  [/wasserzähler|abwasser|trinkwasser|wasserversorgung/, 'Wasser'], [/miete|nebenkosten|hausverwaltung/, 'Miete'], [/mahnung|zahlungserinnerung|inkasso/, 'Mahnung'],
  [/kassenbon|kassenbeleg|quittung|barkauf/, 'Kaufbeleg'], [/garantie|gewährleistung/, 'Garantie'],
  [/weiterbildung|fortbildung|schulung|seminar/, 'Weiterbildung'], [/zertifikat|teilnahmebescheinigung|zeugnis/, 'Zertifikat'],
  [/arzt|praxis|krankenkasse|klinik/, 'Gesundheit'], [/bescheid/, 'Bescheid'], [/rente/, 'Rente'],
  [/hausrat/, 'Hausrat'], [/haftpflicht/, 'Haftpflicht'], [/gewinn.*gebühr|unseriös/, 'Vorsicht'],
];

/** Tags ohne KI: aus Kategorie, Dokumentart und Stichworten im Text. */
export function deriveTags({ category, documentType, subject, text }) {
  const head = `${documentType || ''} ${subject || ''}`.toLowerCase();
  const hay = `${head} ${String(text || '').slice(0, 1500)}`.toLowerCase();
  const tags = [];
  if (CATEGORY_TAG[category]) tags.push(CATEGORY_TAG[category]);
  for (const [re, tag] of KEYWORD_TAGS) if (re.test(hay)) tags.push(tag);
  // Nur aus Betreff/Dokumentart – im Fließtext zu oft nur erwähnt
  if (/\bkündigung/.test(head)) tags.push('Kündigung');
  if (/\bwasser\b/.test(head)) tags.push('Wasser');
  if (/termin/.test(head)) tags.push('Termin');
  return normalizeTags(tags).slice(0, 4);
}
