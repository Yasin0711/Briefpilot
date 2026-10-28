// Gemeinsame Bausteine der Oberfläche: Symbole, Kennzeichnungen, Dialoge, Meldungen.
import { html, trusted, mount } from './html.js';
import { CATEGORIES, TASK_STATUS, taskKindLabel } from './shared/constants.js';
import { daysBetween, formatDate, relativeDayLabel, isValidIsoDate } from './shared/dates.js';

const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  tasks: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 4-4"/><path d="M8 16h8"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 17-5-5 5-5"/><path d="M5 12h11"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6 6 2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L20 15"/><path d="M20 20v-5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  building: '<path d="M3 21h18M5 21V10M19 21V10M9.5 21v-7M14.5 21v-7M3 10l9-6 9 6z"/>',
  shieldCat: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  house: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  pen: '<path d="M4 20h16"/><path d="M6 16l9-9 3 3-9 9H6z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  bank: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.1 9.5l6.1-.9z"/>',
  euro: '<path d="M17 6.5A6 6 0 1 0 17 17.5"/><path d="M4 10h9M4 14h9"/>',
  hourglass: '<path d="M6 3h12M6 21h12"/><path d="M7 3v2a5 5 0 0 0 10 0V3M7 21v-2a5 5 0 0 1 10 0v2"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  translate: '<path d="M4 5h9M8.5 3v2M6 5c0 4 3 7 6 8M11 5c0 3-3 7-6 8"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3 2.8 3 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
};

const CATEGORY_ICON = { building: 'building', shield: 'shieldCat', heart: 'heart', house: 'house', briefcase: 'briefcase', pen: 'pen', receipt: 'receipt', bank: 'bank', folder: 'folder' };
const KIND_ICON = { zahlung: 'euro', frist: 'hourglass', termin: 'calendar', aufgabe: 'tasks' };

export function icon(name, className = '') {
  const paths = PATHS[name] || PATHS.circle;
  return trusted(
    `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
  );
}

export const LOGO = trusted(
  '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#15324B"/><rect x="11" y="18" width="40" height="28" rx="4" fill="#fff"/><path d="M12.5 20.5 31 34l18.5-13.5" fill="none" stroke="#15324B" stroke-width="3" stroke-linejoin="round"/><circle cx="47" cy="44" r="10" fill="#F4C430" stroke="#15324B" stroke-width="3"/><path d="m42.5 44 3 3 5.5-6" fill="none" stroke="#15324B" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
);

export function categoryTile(categoryId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId) || CATEGORIES[CATEGORIES.length - 1];
  return html`<span class="cat-tile" title="${cat.label}">${icon(CATEGORY_ICON[cat.icon] || 'folder')}<span class="visually-hidden">${cat.label}</span></span>`;
}

export function kindIcon(kind) {
  return icon(KIND_ICON[kind] || 'tasks');
}

export function statusBadge(status) {
  const cls = { zu_pruefen: 'badge-review', offen: 'badge-open', erledigt: 'badge-done' }[status] || '';
  const ic = { zu_pruefen: 'alert', offen: 'circle', erledigt: 'check' }[status];
  return html`<span class="badge ${cls}">${icon(ic)}${TASK_STATUS[status] || status}</span>`;
}

/** Kalenderblatt-Kachel für ein Datum. */
export function dateTile(iso, { today, unsure = false, small = false } = {}) {
  if (!isValidIsoDate(iso)) {
    return html`<div class="date-tile is-empty ${small ? 'is-small' : ''}" aria-label="Kein Datum">${icon(unsure ? 'alert' : 'calendar')}</div>`;
  }
  const dt = new Date(iso + 'T12:00:00Z');
  const month = new Intl.DateTimeFormat('de-DE', { month: 'short', timeZone: 'UTC' }).format(dt).replace('.', '');
  const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' }).format(dt).replace('.', '');
  const overdue = today && daysBetween(today, iso) < 0;
  return html`<div class="date-tile ${overdue ? 'is-overdue' : ''} ${unsure ? 'is-unsure' : ''} ${small ? 'is-small' : ''}" aria-label="${formatDate(iso, { weekday: true })}">
    <div class="dt-month" aria-hidden="true">${month}${today && today.slice(0, 4) !== iso.slice(0, 4) ? ` ${dt.getUTCFullYear()}` : ''}</div>
    <div class="dt-day" aria-hidden="true">${dt.getUTCDate()}</div>
    <div class="dt-weekday" aria-hidden="true">${weekday}</div>
  </div>`;
}

export function whenLabel(iso, today) {
  if (!isValidIsoDate(iso) || !today) return '';
  const diff = daysBetween(today, iso);
  const cls = diff < 0 ? 'is-overdue' : diff <= 3 ? 'is-soon' : '';
  return html`<span class="when ${cls}">${relativeDayLabel(iso, today)}</span>`;
}

export function taskDateText(task) {
  if (!task.dueDate) return '';
  return `${formatDate(task.dueDate, { weekday: true })}${task.dueTime ? `, ${task.dueTime} Uhr` : ''}`;
}

export { taskKindLabel };

// ---------- Meldungen ----------

let toastTimer = null;
export function toast(message, { error = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), error ? 6000 : 3500);
}

// ---------- Dialoge ----------

/** Öffnet einen Dialog. content: html; setup(dialog, close) bindet Ereignisse. */
export function openDialog(content, setup) {
  const dialog = document.createElement('dialog');
  mount(dialog, content);
  document.body.append(dialog);
  const close = (value) => {
    dialog.close();
    dialog.remove();
    return value;
  };
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  setup?.(dialog, close);
  dialog.showModal();
  const first = dialog.querySelector('[autofocus], input, select, textarea, button');
  first?.focus();
  return { dialog, close };
}

export function confirmDialog({ title, body, confirmLabel = 'Bestätigen', cancelLabel = 'Abbrechen', danger = false }) {
  return new Promise((resolve) => {
    openDialog(
      html`<div class="dialog-body stack"><h2>${title}</h2>${body ? html`<p>${body}</p>` : ''}</div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">${cancelLabel}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : ''}" data-act="ok">${confirmLabel}</button>
        </div>`,
      (dialog, close) => {
        dialog.querySelector('[data-act="cancel"]').addEventListener('click', () => resolve(close(false)));
        dialog.querySelector('[data-act="ok"]').addEventListener('click', () => resolve(close(true)));
        dialog.addEventListener('close', () => resolve(false));
      }
    );
  });
}

// ---------- Formulare ----------

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (form.querySelectorAll(`[name="${el.name}"]`).length > 1) {
        values[el.name] = values[el.name] || [];
        if (el.checked) values[el.name].push(el.value);
      } else values[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) values[el.name] = el.value;
    } else values[el.name] = el.value;
  }
  return values;
}

export function clearErrors(form) {
  form.querySelectorAll('.field-error, .form-error').forEach((el) => el.remove());
  form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

/** Zeigt eine Fehlermeldung direkt am betroffenen Feld (oder oben im Formular). */
export function showError(form, err) {
  clearErrors(form);
  const message = err?.message || String(err);
  const input = err?.field ? form.querySelector(`[name="${err.field}"]`) : null;
  if (input) {
    const field = input.closest('.field') || input.closest('.check') || input.parentElement;
    field.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    const p = document.createElement('p');
    p.className = 'field-error';
    p.textContent = message;
    field.append(p);
    input.focus();
  } else {
    const p = document.createElement('p');
    p.className = 'form-error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    form.prepend(p);
    p.scrollIntoView({ block: 'nearest' });
  }
}

/** Sperrt den Absende-Knopf während einer Anfrage. */
export async function busy(button, fn) {
  if (!button) return fn();
  const label = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = label;
  }
}

export function greeting(name) {
  const h = new Date().getHours();
  const base = h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  return name ? `${base}, ${name.replace(/\s*\(Demo\)$/, '')}` : base;
}

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function formatUploaded(isoString) {
  const d = new Date(isoString);
  return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
