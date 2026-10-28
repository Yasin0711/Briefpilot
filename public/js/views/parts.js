// Gemeinsame Bausteine für Briefe, Zuordnung und Akten (ohne Abhängigkeit zu anderen Ansichten).
import { html } from '../html.js';
import { icon, categoryTile } from '../ui.js';
import { objectType } from '../shared/constants.js';
import { identifierKindLabel } from '../shared/identifiers.js';
import { formatDate } from '../shared/dates.js';

export function objectIconName(type) {
  return objectType(type).icon || 'folder';
}

/** Kachel mit dem Symbol der Aktenart (Auto, Zähler, Versicherung …). */
export function objectTile(type, { large = false } = {}) {
  const t = objectType(type);
  return html`<span class="cat-tile obj-tile ${large ? 'is-large' : ''}" title="${t.label}">${icon(objectIconName(type))}<span class="visually-hidden">${t.label}</span></span>`;
}

/** Kleine Kennzeichnungen der Akten eines Briefes. In Listenzeilen ohne Link (keine Links in Links). */
export function objectChips(objects = [], { link = false } = {}) {
  if (!objects?.length) return '';
  return html`<span class="obj-chips">${objects.map((o) => (link
    ? html`<a class="obj-chip" href="#/akten/${o.id || o.objectId}">${icon(objectIconName(o.type))}<span>${o.name}</span></a>`
    : html`<span class="obj-chip">${icon(objectIconName(o.type))}<span>${o.name}</span></span>`))}</span>`;
}

/** Umschalter oben in „Briefe“: alle Briefe · zuordnen · Akten. */
export function briefeTabs(active, counts = {}) {
  const items = [
    { id: 'briefe', href: '#/briefe', label: 'Alle Briefe', ic: 'mail' },
    { id: 'zuordnen', href: '#/zuordnen', label: 'Zuordnen', ic: 'inbox', count: counts.inbox },
    { id: 'akten', href: '#/akten', label: 'Akten', ic: 'folder' },
  ];
  return html`<nav class="seg" aria-label="Briefe und Akten">${items.map((i) => html`<a class="seg-item" href="${i.href}" ${active === i.id ? html`aria-current="page"` : ''}>
    ${icon(i.ic)}<span>${i.label}</span>${i.count ? html`<span class="seg-badge" aria-label="${i.count} offen">${i.count}</span>` : ''}</a>`)}</nav>`;
}

/** Zeile in Brieflisten (Übersicht, Briefe, Akte). note: zusätzliche Zeile (z. B. warum zugeordnet). */
export function letterRow(l, { note = null } = {}) {
  const dateText = l.letterDate ? `Brief vom ${formatDate(l.letterDate)}` : 'Briefdatum unbekannt';
  const badges = [];
  if (l.analysisStatus === 'wartet' || l.analysisStatus === 'laeuft') badges.push(html`<span class="badge badge-open">Wird gelesen …</span>`);
  else if (l.analysisStatus === 'fehler') badges.push(html`<span class="badge badge-danger">Auswertung fehlgeschlagen</span>`);
  else if (l.tasksToReview) badges.push(html`<span class="badge badge-review">${icon('alert')}${l.tasksToReview} zu prüfen</span>`);
  else if (!l.reviewed && l.analysisStatus === 'fertig') badges.push(html`<span class="badge badge-review">Angaben prüfen</span>`);
  if (l.assignmentStatus === 'pruefen' || l.assignmentStatus === 'vorschlag') badges.push(html`<span class="badge badge-review">${icon('inbox')}Akte wählen</span>`);
  if (l.assignmentStatus === 'neue_akte') badges.push(html`<span class="badge badge-review">${icon('folder')}Neue Akte?</span>`);
  if (l.duplicateStatus === 'verdacht') badges.push(html`<span class="badge badge-review">${icon('copy')}Doppelt?</span>`);
  return html`<li><a class="list-row" href="#/briefe/${l.id}">
    ${categoryTile(l.category)}
    <span class="grow"><span class="row-title">${l.subject || 'Brief ohne Betreff'}</span>
      <span class="row-sub">${l.sender || 'Absender unbekannt'}</span><span class="row-sub">${dateText}</span>
      ${l.objects?.length || badges.length || l.tags?.length ? html`<span class="row-meta">${objectChips(l.objects)}${(l.tags || []).slice(0, 3).map((t) => html`<span class="tag">#${t}</span>`)}${badges}</span>` : ''}
      ${note ? html`<span class="row-sub">${note}</span>` : ''}</span>
    ${icon('chevronRight', 'chev')}</a></li>`;
}

/** Ein Nachweis in Worten: warum ein Brief zu einer Akte passt (oder nicht sicher passt). */
export function evidenceText(ev) {
  if (!ev) return '';
  if (ev.type === 'absender') return `Absender passt zum Vertragspartner „${ev.value}“ (allein kein Beweis)`;
  if (ev.type === 'nutzer') return ev.note || 'Von Ihnen zugeordnet';
  if (ev.type !== 'kennung') return ev.note || '';
  const label = identifierKindLabel(ev.kind);
  let text;
  if (ev.match === 'aehnlich') text = `${label} im Brief „${ev.letterValue}“ ist nur ähnlich wie „${ev.value}“`;
  else if (ev.match === 'schreibweise') text = `${label} „${ev.letterValue}“ stimmt überein (gespeichert als „${ev.value}“)`;
  else text = `${label} „${ev.letterValue || ev.value}“ stimmt überein`;
  if (ev.page) text += ` – Seite ${ev.page}`;
  return text;
}

/** Nachweise als Liste, mit Zitat aus dem Brief und Hinweis (z. B. „gehört zu 5 Akten“). */
export function evidenceList(evidence = []) {
  const items = evidence.filter((e) => e && (e.type !== 'kennung' || e.weight !== 0));
  if (!items.length) return '';
  return html`<ul class="evidence">${items.map((ev) => html`<li class="${ev.match === 'aehnlich' || ev.type === 'absender' || ev.shared > 1 ? 'is-weak' : ''}">
    ${icon(ev.match === 'aehnlich' ? 'alert' : ev.type === 'absender' ? 'building' : ev.shared > 1 ? 'info' : 'check')}
    <span>${evidenceText(ev)}${ev.note && ev.type === 'kennung' ? html`<span class="evidence-note">${ev.note}</span>` : ''}
    ${ev.quote ? html`<span class="evidence-quote">„${ev.quote}“</span>` : ''}</span></li>`)}</ul>`;
}

export function identifierStatusBadge(status) {
  if (status === 'alt') return html`<span class="badge">frühere Nummer</span>`;
  if (status === 'neu') return html`<span class="badge badge-open">neu laut Brief</span>`;
  return '';
}
