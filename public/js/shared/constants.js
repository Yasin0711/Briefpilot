// Gemeinsame Konstanten für Server und Oberfläche.

export const CATEGORIES = [
  { id: 'behoerden', label: 'Behörden', icon: 'building' },
  { id: 'versicherungen', label: 'Versicherungen', icon: 'shield' },
  { id: 'gesundheit', label: 'Gesundheit', icon: 'heart' },
  { id: 'wohnen', label: 'Wohnen', icon: 'house' },
  { id: 'arbeit', label: 'Arbeit', icon: 'briefcase' },
  { id: 'vertraege', label: 'Verträge', icon: 'pen' },
  { id: 'rechnungen', label: 'Rechnungen', icon: 'receipt' },
  { id: 'bank', label: 'Bank & Finanzen', icon: 'bank' },
  { id: 'sonstiges', label: 'Sonstiges', icon: 'folder' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export function categoryLabel(id) {
  return (CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1]).label;
}

export const TASK_KINDS = [
  { id: 'zahlung', label: 'Zahlung' },
  { id: 'frist', label: 'Frist' },
  { id: 'termin', label: 'Termin' },
  { id: 'aufgabe', label: 'Aufgabe' },
];
export const TASK_KIND_IDS = TASK_KINDS.map((k) => k.id);
export function taskKindLabel(id) {
  return (TASK_KINDS.find((k) => k.id === id) || TASK_KINDS[3]).label;
}

export const TASK_STATUS = {
  zu_pruefen: 'Zu prüfen',
  offen: 'Offen',
  erledigt: 'Erledigt',
};

export const REMINDER_OFFSETS = [
  { id: '7d', days: 7, label: '1 Woche vorher' },
  { id: '3d', days: 3, label: '3 Tage vorher' },
  { id: '1d', days: 1, label: '1 Tag vorher' },
  { id: '0d', days: 0, label: 'Am Tag selbst' },
];
export const REMINDER_OFFSET_IDS = REMINDER_OFFSETS.map((o) => o.id);

export const DEFAULT_SETTINGS = {
  reminderOffsets: ['7d', '1d'],
  reminderTime: '08:00',
  emailReminders: false,
  notificationDetails: false,
};

export const ANALYSIS_SOURCE_LABELS = {
  ki: 'KI-Auswertung',
  regeln: 'Einfache Erkennung ohne KI',
  beispiel: 'Beispielauswertung (vorbereitet)',
  manuell: 'Von Ihnen eingetragen',
};

export const PASSWORD_MIN_LENGTH = 10;

// ---------- Objektakten ----------
// hints: Kennungen, die für diese Art typisch sind (Vorschläge beim Anlegen)
// plural/pick: für Meldungen wie „Wir haben zwei mögliche Fahrzeuge gefunden. Bitte wählen Sie das richtige aus.“
export const OBJECT_TYPES = [
  { id: 'fahrzeug', label: 'Fahrzeug', plural: 'Fahrzeuge', pick: 'das richtige', icon: 'car', category: 'versicherungen', hints: ['kennzeichen', 'fin', 'versicherungsnummer', 'schadennummer'] },
  { id: 'strom', label: 'Stromzähler', plural: 'Stromzähler', pick: 'den richtigen', icon: 'bolt', category: 'rechnungen', hints: ['zaehlernummer', 'malo_id', 'vertragskonto', 'objektadresse'] },
  { id: 'gas', label: 'Gaszähler', plural: 'Gaszähler', pick: 'den richtigen', icon: 'flame', category: 'rechnungen', hints: ['zaehlernummer', 'malo_id', 'vertragsnummer', 'objektadresse'] },
  { id: 'wasser', label: 'Wasserzähler', plural: 'Wasserzähler', pick: 'den richtigen', icon: 'drop', category: 'rechnungen', hints: ['zaehlernummer', 'kundennummer', 'objektadresse'] },
  { id: 'internet', label: 'Internet / Telefon', plural: 'Anschlüsse', pick: 'den richtigen', icon: 'wifi', category: 'vertraege', hints: ['vertragsnummer', 'kundennummer', 'anschlusskennung'] },
  { id: 'versicherung', label: 'Versicherung', plural: 'Verträge', pick: 'den richtigen', icon: 'shield', category: 'versicherungen', hints: ['versicherungsnummer', 'kundennummer', 'schadennummer'] },
  { id: 'krankenkasse', label: 'Krankenkasse', plural: 'Mitgliedschaften', pick: 'die richtige', icon: 'heart', category: 'gesundheit', hints: ['mitgliedsnummer', 'vorgangsnummer'] },
  { id: 'bank', label: 'Bankkonto', plural: 'Konten', pick: 'das richtige', icon: 'bank', category: 'bank', hints: ['iban', 'kundennummer', 'vertragsnummer'] },
  { id: 'kredit', label: 'Kredit / Darlehen', plural: 'Verträge', pick: 'den richtigen', icon: 'bank', category: 'bank', hints: ['darlehensnummer', 'vertragsnummer'] },
  { id: 'wohnen', label: 'Wohnung / Immobilie', plural: 'Objekte', pick: 'das richtige', icon: 'house', category: 'wohnen', hints: ['objektadresse', 'wohnungsnummer', 'mietvertragsnummer'] },
  { id: 'behoerde', label: 'Behörde / Amt', plural: 'Akten', pick: 'die richtige', icon: 'building', category: 'behoerden', hints: ['aktenzeichen', 'steuernummer'] },
  { id: 'bestellung', label: 'Bestellung / Händler', plural: 'Bestellungen', pick: 'die richtige', icon: 'receipt', category: 'rechnungen', hints: ['bestellnummer', 'kundennummer', 'rechnungsnummer'] },
  { id: 'vertrag', label: 'Sonstiger Vertrag', plural: 'Verträge', pick: 'den richtigen', icon: 'pen', category: 'vertraege', hints: ['vertragsnummer', 'kundennummer'] },
  { id: 'sonstiges', label: 'Sonstiges', plural: 'Akten', pick: 'die richtige', icon: 'folder', category: 'sonstiges', hints: ['sonstiges'] },
];
export const OBJECT_TYPE_IDS = OBJECT_TYPES.map((t) => t.id);
export function objectType(id) {
  return OBJECT_TYPES.find((t) => t.id === id) || OBJECT_TYPES[OBJECT_TYPES.length - 1];
}

export const CASE_KINDS = [
  { id: 'rechnung', label: 'Rechnung' },
  { id: 'schaden', label: 'Schadenfall' },
  { id: 'antrag', label: 'Antrag' },
  { id: 'bescheid', label: 'Bescheid' },
  { id: 'bestellung', label: 'Bestellung' },
  { id: 'kuendigung', label: 'Kündigung' },
  { id: 'allgemein', label: 'Vorgang' },
];
export const CASE_KIND_IDS = CASE_KINDS.map((k) => k.id);

export const PERSON_RELATIONS = [
  { id: 'ich', label: 'Ich' },
  { id: 'partner', label: 'Partner/in' },
  { id: 'kind', label: 'Kind' },
  { id: 'angehoerige', label: 'Angehörige/r' },
  { id: 'sonstige', label: 'Sonstige' },
];
export const ADDRESS_KINDS = [
  { id: 'haushalt', label: 'Haushalt' },
  { id: 'mietobjekt', label: 'Mietobjekt' },
  { id: 'gewerbe', label: 'Gewerbe' },
  { id: 'ferienwohnung', label: 'Ferienwohnung' },
  { id: 'sonstige', label: 'Sonstige' },
];

export const ASSIGNMENT_STATUS = {
  offen: 'Noch nicht zugeordnet',
  zugeordnet: 'Zugeordnet',
  pruefen: 'Zuordnung prüfen',
  vorschlag: 'Vorschlag prüfen',
  keine: 'Keine passende Akte',
  ohne: 'Ohne Akte',
};
