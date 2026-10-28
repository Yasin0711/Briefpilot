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
