// Automatische Kalendereintragung: bestätigte Termine und Aufgaben mit Datum erscheinen über ein
// Kalender-Abo im iPhone-Kalender. Eine Web-App darf nicht selbst in den Kalender schreiben –
// das Abo muss einmal bestätigt werden, danach kommt jeder bestätigte Eintrag von allein dazu.
import { api } from './api.js';
import { confirmDialog } from './ui.js';
import { state, refreshMe } from './app.js';

export function calendarUrl(token, scheme = 'webcal') {
  const url = `${location.host}/api/calendar/${token}.ics`;
  return scheme === 'webcal' ? `webcal://${url}` : `${location.protocol}//${url}`;
}

/** Läuft die automatische Kalendereintragung? Dann keine Einzel-Dateien (.ics) anbieten –
 *  die ließen sich beim Erledigen nicht wieder entfernen und gäbe es doppelt. */
export function autoCalendarActive() {
  const s = state.me?.settings || {};
  return s.autoCalendar !== false && Boolean(s.calendarToken);
}

/** Abo anlegen (falls nötig) und den Kalender des Geräts zum Abonnieren öffnen. */
export async function connectCalendar() {
  let token = state.me?.settings?.calendarToken;
  if (!token) {
    token = (await api.post('/api/me/calendar', {})).token;
    await refreshMe();
  }
  location.href = calendarUrl(token, 'webcal');
}

/**
 * Nach dem ersten Bestätigen einer Frist: einmalig anbieten, den Kalender zu verbinden.
 * Nur wenn die automatische Eintragung eingeschaltet und noch kein Abo eingerichtet ist.
 */
export async function offerCalendarOnce(hasDate) {
  const s = state.me?.settings || {};
  if (!hasDate || state.me?.isDemo || s.autoCalendar === false || s.calendarToken) return;
  try {
    if (localStorage.getItem('bp-cal-offered') === '1') return;
    localStorage.setItem('bp-cal-offered', '1');
  } catch {
    return;
  }
  const ok = await confirmDialog({
    title: 'In den Kalender?',
    body: 'Bestätigte Termine und Aufgaben landen dann von allein im iPhone-Kalender. Einmal verbinden genügt.',
    confirmLabel: 'Verbinden',
    cancelLabel: 'Später',
  });
  if (ok) await connectCalendar();
}
