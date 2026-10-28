// Sichere HTML-Erzeugung: Alle eingesetzten Werte werden automatisch maskiert.
// So kann Text aus Briefen (oder von der KI) niemals Code in der Seite ausführen.

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/** Vorlagen-Funktion: html`<p>${text}</p>` */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Nur für fest im Code stehendes, vertrauenswürdiges Markup (z. B. Symbole). */
export function trusted(markup) {
  return new SafeHtml(markup);
}

export function mount(element, content) {
  element.innerHTML = render(content);
}
