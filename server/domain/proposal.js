// Vorschlag für eine neue Akte („Ordner“), wenn ein Brief zu keiner vorhandenen Akte passt.
// Der Vorschlag wird nur angezeigt – angelegt wird die Akte erst, wenn der Nutzer zustimmt.
import { objectType } from '../../public/js/shared/constants.js';
import { identifierKind } from '../../public/js/shared/identifiers.js';

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

// Absender kürzen: Rechtsform und Zusätze weg („Stadtwerke Musterstadt GmbH“ → „Stadtwerke Musterstadt“)
export function shortSender(sender) {
  return String(sender || '')
    .replace(/\s*[–-]\s*(Bürgeramt|Kundenservice|Service|Abteilung.*|Zentrale)$/i, (m) => m) // Bereich bleibt
    .replace(/,?\s+(GmbH\s*&\s*Co\.?\s*KG|GmbH|AG|KG|KGaA|SE|e\.\s?V\.|mbH|Ltd\.?|UG(\s*\(haftungsbeschränkt\))?|OHG|GbR|& Partner)\b\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);
}

function find(ids, ...kinds) {
  return ids.find((i) => kinds.includes(i.kind));
}

/** Leitet Art und Namen der Akte aus dem Brief ab. Gibt null zurück, wenn kein sinnvoller Vorschlag möglich ist. */
export function proposeObject(letter, identifiers = []) {
  const summary = parseJson(letter.summary_json, {}) || {};
  if (letter.injection_warning || /unseriös|betrug|gewinnspiel|fake/i.test(`${summary.what || ''} ${(summary.toCheck || []).join(' ')}`)) return null;
  const sender = shortSender(letter.sender);
  // Bei sehr langen Dokumenten zählt für die Einordnung vor allem der Anfang
  const text = [letter.document_type, letter.subject, String(letter.full_text || '').slice(0, 20000)].filter(Boolean).join('\n').toLowerCase();
  if (!sender && !identifiers.length && !/weiterbildung|fortbildung|schulung|seminar|zertifikat|teilnahmebescheinigung|zeugnis/.test(text)) return null;
  const ids = identifiers.filter((i) => i.value && i.status !== 'alt');
  let type = 'sonstiges';
  let name = null;

  const plate = find(ids, 'kennzeichen', 'fin');
  const meter = find(ids, 'zaehlernummer', 'malo_id', 'melo_id');
  const insurance = /versicherung/.test(text) || /versicherung/i.test(letter.sender || '') || find(ids, 'versicherungsnummer');
  const insuranceKind = (text.match(/\b([a-zäöü-]{3,}versicherung)\b/) || [])[1];

  if (plate && /kfz|fahrzeug|auto|kennzeichen|zulassung|versicherung/.test(text)) {
    type = 'fahrzeug';
    name = `Fahrzeug · ${plate.value}`;
  } else if (meter || /zählerstand|abschlag|jahresabrechnung|verbrauchsabrechnung/.test(text)) {
    type = /\bgas\b|erdgas/.test(text) ? 'gas' : /wasser/.test(text) && !/strom/.test(text) ? 'wasser' : 'strom';
    name = `${objectType(type).label.replace('zähler', '')} · ${sender || meter.value}`;
  } else if (/weiterbildung|fortbildung|schulung|seminar|lehrgang|zertifikat|teilnahmebescheinigung|zeugnis|prüfungsergebnis|kursunterlagen|präsentation|vortrag/.test(text) && !find(ids, 'versicherungsnummer', 'steuernummer', 'zaehlernummer')) {
    type = 'sonstiges';
    const topic = /zeugnis|zertifikat|teilnahmebescheinigung|prüfungsergebnis/.test(text) ? 'Zertifikate & Nachweise' : 'Weiterbildung';
    name = sender ? `${topic} · ${sender}` : topic;
  } else if (letter.category === 'gesundheit' && /praxis|dr\. med|klinik|krankenhaus|arzt|zahnarzt|apotheke|therapie/i.test(`${letter.sender || ''} ${text}`) && !/krankenkasse/i.test(letter.sender || '')) {
    type = 'sonstiges';
    name = `Gesundheit · ${sender}`;
  } else if (/krankenkasse|krankenversicherung|\baok\b|\btk\b|barmer|\bdak\b|\bikk\b|\bbkk\b/.test(`${text} ${(letter.sender || '').toLowerCase()}`) && !/praxis|dr\. med/i.test(letter.sender || '')) {
    type = 'krankenkasse';
    name = `Krankenkasse · ${sender}`;
  } else if (insurance && sender) {
    type = 'versicherung';
    const kind = insuranceKind && !/^(kfz-?)?versicherung$/.test(insuranceKind) ? insuranceKind.charAt(0).toUpperCase() + insuranceKind.slice(1) : 'Versicherung';
    name = `${kind} · ${sender}`;
  } else if (find(ids, 'steuernummer') || /finanzamt/i.test(letter.sender || '')) {
    type = 'behoerde';
    name = `Steuern · ${sender || 'Finanzamt'}`;
  } else if (letter.category === 'behoerden' || /\b(amt|behörde|stadt|gemeinde|landkreis|jobcenter|agentur für arbeit|familienkasse|rentenversicherung)\b/i.test(letter.sender || '')) {
    type = 'behoerde';
    const topic = /personalausweis|reisepass/.test(text) ? 'Ausweis' : /kindergeld/.test(text) ? 'Kindergeld' : /rente/.test(text) ? 'Rente' : null;
    name = topic ? `${topic} · ${sender}` : sender;
  } else if (find(ids, 'darlehensnummer') || /darlehen|kredit/.test(text)) {
    type = 'kredit';
    name = `Kredit · ${sender}`;
  } else if (letter.category === 'bank' || find(ids, 'iban') && /kontoauszug|girokonto|konto/.test(text)) {
    type = 'bank';
    name = `Konto · ${sender}`;
  } else if (find(ids, 'mietvertragsnummer', 'wohnungsnummer') || letter.category === 'wohnen' || /hausverwaltung|vermiet|nebenkosten|betriebskosten/.test(text)) {
    type = 'wohnen';
    name = `Wohnung · ${sender}`;
  } else if (find(ids, 'anschlusskennung') || /internetanschluss|\bdsl\b|mobilfunk|glasfaser|telefonanschluss|festnetz|handyvertrag|datenvolumen/.test(text)) {
    type = 'internet';
    name = `Internet / Telefon · ${sender}`;
  } else if (find(ids, 'bestellnummer') || /ihre bestellung|bestellung vom|lieferschein|artikel/.test(text) || (/versand/i.test(letter.sender || '') && letter.category === 'rechnungen')) {
    type = 'bestellung';
    name = `Bestellungen · ${sender}`;
  } else if (find(ids, 'vertragsnummer') || letter.category === 'vertraege') {
    type = 'vertrag';
    name = `Vertrag · ${sender}`;
  } else if (letter.category === 'gesundheit') {
    type = 'sonstiges';
    name = `Gesundheit · ${sender}`;
  } else {
    name = sender;
  }
  if (!name) return null;

  // Nummern, die sich die neue Akte merken soll (nur passende Arten, keine Vorgangsnummern)
  const hints = objectType(type).hints || [];
  const learn = ids
    .filter((i) => identifierKind(i.kind).level === 'objekt' && (hints.includes(i.kind) || ['kundennummer', 'vertragsnummer'].includes(i.kind)))
    .filter((i) => i.kind !== 'iban' || type === 'bank')
    .slice(0, 5)
    .map((i) => ({ kind: i.kind, value: i.value, label: i.label || identifierKind(i.kind).label }));

  return {
    type,
    typeLabel: objectType(type).label,
    name: name.slice(0, 120),
    provider: letter.sender ? String(letter.sender).slice(0, 160) : null,
    identifiers: learn,
  };
}
