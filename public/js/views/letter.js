// Brief-Detailansicht: Erklärung in vier Schritten, Fristen bestätigen, Ordner (Zuordnung mit Nachweis),
// Fragen an die KI, Antworten, Original mit Seitenwerkzeugen, erkannter Text und Verlauf.
import { html, mount } from '../html.js';
import { api, download } from '../api.js';
import {
  icon, dateTile, whenLabel, statusBadge, taskKindLabel, toast, confirmDialog, openDialog,
  formValues, showError, clearErrors, busy, formatUploaded, scroller,
} from '../ui.js';
import { hydratePdfViews, hydratePagers } from '../pdfview.js';
import {
  CATEGORIES, REMINDER_OFFSETS, ANALYSIS_SOURCE_LABELS, TASK_KINDS, categoryLabel,
} from '../shared/constants.js';
import { identifierKindLabel } from '../shared/identifiers.js';
import { formatDate, formatDateTime, computeRelativeEnd, todayIn, isValidIsoDate, needsReceivedDate, letterDateDeadline } from '../shared/dates.js';
import { setReviewCount, setInboxCount, backButton, setNavTitle } from '../app.js';
import { objectChips, objectTile, evidenceList, identifierStatusBadge } from './parts.js';
import { moveSheet, fileLetterInto } from '../folderSheet.js';
import { pagesSheet } from '../pagesSheet.js';
import { offerCalendarOnce, autoCalendarActive } from '../calendar.js';
import { mountDecision, forgetObjects } from './assign.js';
import { repliesPanel, chatPanel, bindAssistant } from './replies.js';
import { loadHousehold } from './objectDialog.js';
import { backupNow } from '../backup.js';
import { scanLetterQr } from '../qr.js';

const STATUS_ORDER = { zu_pruefen: 0, offen: 1, erledigt: 2 };

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sucht eine Textstelle (tolerant gegenüber Zeilenumbrüchen) im erkannten Text. */
function findQuote(text, quote) {
  if (!text || !quote) return null;
  const words = quote.replace(/[„“”"]/g, ' ').split(/\s+/).filter(Boolean).map(escapeRegex);
  for (const n of [words.length, Math.min(words.length, 8), Math.min(words.length, 5)]) {
    if (n < 3 && words.length >= 3) continue;
    const re = new RegExp(words.slice(0, n).join('[\\s„“”"]+'), 'i');
    const m = re.exec(text);
    if (m) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function highlightedText(text, tasks) {
  const ranges = [];
  for (const t of tasks) {
    const r = findQuote(text, t.sourceQuote);
    if (r && !ranges.some((x) => r.start < x.end && x.start < r.end)) ranges.push({ ...r, id: t.id });
  }
  ranges.sort((a, b) => a.start - b.start);
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    parts.push(text.slice(pos, r.start));
    parts.push(html`<mark id="q-${r.id}">${text.slice(r.start, r.end)}</mark>`);
    pos = r.end;
  }
  parts.push(text.slice(pos));
  return parts;
}

function periodLabel(rule) {
  const units = { tage: ['Tag', 'Tage'], wochen: ['Woche', 'Wochen'], monate: ['Monat', 'Monate'], jahre: ['Jahr', 'Jahre'] }[rule.unit] || ['', ''];
  return `${rule.amount} ${rule.amount === 1 ? units[0] : units[1]}`;
}

function dueLabel(kind) {
  return { termin: 'Termin am', zahlung: 'Zahlen bis', frist: 'Frist bis', aufgabe: 'Erledigen bis (freiwillig)' }[kind] || 'Datum';
}

function reminderChips(selected, name = 'reminders') {
  return html`<fieldset class="field"><legend class="field-label">Erinnern</legend>
    <div class="chips">${REMINDER_OFFSETS.map((o) => html`<label class="chip"><input type="checkbox" name="${name}" value="${o.id}" ${selected.includes(o.id) ? 'checked' : ''}>${o.label}</label>`)}</div>
  </fieldset>`;
}

// Hinweise, die schon an anderer Stelle sichtbar sind (Zitat, Datumsfeld), nicht doppelt zeigen
const REDUNDANT_NOTE = /Zugangsdatum|nicht gefunden|sinngemäß|kein eindeutiges Datum|Wochenende/i;
function visibleNotes(task) {
  return (task.checkNotes || []).filter((n) => !REDUNDANT_NOTE.test(n));
}

function confirmForm(task, letter, settings, today, { correcting = false } = {}) {
  const relative = needsReceivedDate(task);
  const dateValue = task.dueDate || task.suggestedDate || letterDateDeadline(task, letter.letterDate) || '';
  const timeValue = task.dueTime || task.suggestedTime || '';
  const offsets = task.reminders?.length ? settings.reminderOffsets : settings.reminderOffsets;
  return html`<form class="confirm-box stack" data-confirm="${task.id}" novalidate>
    <h4 class="visually-hidden">Angaben bestätigen</h4>
    ${relative ? html`
      <div class="field"><label class="label-icon" for="rd-${task.id}">${icon('hourglass')}Wann haben Sie den Brief bekommen?</label>
        <input class="input" type="date" id="rd-${task.id}" name="receivedDate" max="${today}" value="${letter.receivedDate || letter.receivedSuggested || ''}" data-received></div>
      <div data-computed aria-live="polite"></div>
      <div class="field"><label for="dd-${task.id}">Fristende</label>
        <input class="input" type="date" id="dd-${task.id}" name="dueDate" value="${task.dueDate || ''}" data-due></div>`
    : html`<div class="field-pair">
        <div class="field"><label for="dd-${task.id}">${dueLabel(task.kind)}</label>
          <input class="input" type="date" id="dd-${task.id}" name="dueDate" value="${dateValue}"></div>
        <div class="field"><label for="dt-${task.id}">Uhrzeit <span class="muted">(freiwillig)</span></label>
          <input class="input" type="time" id="dt-${task.id}" name="dueTime" value="${timeValue}"></div>
      </div>`}
    ${reminderChips(offsets)}
    <label class="check check-strong"><input type="checkbox" name="checked">
      <span>Mit dem Original verglichen</span></label>
    <div class="row">
      <button class="btn" type="submit" data-mode="date">${icon('check')}${correcting ? 'Änderung speichern' : 'Bestätigen'}</button>
      ${!relative ? html`<button class="btn btn-secondary" type="submit" data-mode="nodate">Ohne Datum</button>` : ''}
      ${correcting
        ? html`<button class="btn btn-ghost" type="button" data-action="cancel-correct" data-id="${task.id}">Abbrechen</button>`
        : html`<button class="btn btn-ghost" type="button" data-action="discard" data-id="${task.id}">${icon('x')}Verwerfen</button>`}
    </div>
  </form>`;
}

function taskCard(task, letter, settings, today, correcting) {
  const isReview = task.status === 'zu_pruefen';
  const needsReceived = needsReceivedDate(task);
  const suggested = task.suggestedDate || letterDateDeadline(task, letter.letterDate);
  const shownDate = isReview ? (needsReceived ? null : suggested) : task.dueDate;
  let dateLine;
  if (task.status === 'erledigt') dateLine = html`<p class="small muted">Erledigt${task.completedAt ? ` am ${formatUploaded(task.completedAt)}` : ''}</p>`;
  else if (isReview) {
    if (needsReceived) dateLine = html`<p>Frist: ${task.relativeText || 'ab Erhalt des Briefs'}</p>`;
    else if (suggested) dateLine = html`<p>${formatDate(suggested, { weekday: true })}${task.suggestedTime ? `, ${task.suggestedTime} Uhr` : ''}${task.isRelative ? html` <span class="small muted">(${task.relativeText || 'Frist'} ab Briefdatum)</span>` : ''}</p>`;
    else dateLine = html`<p class="muted">${task.kind === 'aufgabe' ? 'Ohne festes Datum' : 'Kein Datum erkannt'}</p>`;
  } else if (task.dueDate) {
    dateLine = html`<p><strong>${formatDate(task.dueDate, { weekday: true })}${task.dueTime ? `, ${task.dueTime} Uhr` : ''}</strong> ${whenLabel(task.dueDate, today)}</p>`;
  } else dateLine = html`<p class="muted">Ohne Datum</p>`;

  const activeReminders = (task.reminders || []).filter((r) => r.status === 'geplant');
  return html`<article class="task-card ${isReview ? 'is-review' : ''} ${task.status === 'erledigt' ? 'is-done' : ''}" id="task-${task.id}" tabindex="-1" data-ctx="task" data-id="${task.id}" data-name="${task.title}">
    <div class="task-top">
      ${dateTile(shownDate, { today, unsure: isReview })}
      <div class="grow stack">
        <div class="row">${statusBadge(task.status)}<span class="badge">${taskKindLabel(task.kind)}</span></div>
        <h3 class="task-title">${task.title}</h3>
        ${dateLine}
      </div>
    </div>
    ${task.description ? html`<p class="task-desc">${task.description}</p>` : ''}
    ${task.sourceQuote ? html`<details class="quote-details">
      <summary>Textstelle${task.sourcePage ? ` (Seite ${task.sourcePage})` : ''}${icon('chevronDown')}</summary>
      <blockquote class="quote">${task.sourceQuote}</blockquote>
    </details>` : ''}
    ${visibleNotes(task).length && task.status !== 'erledigt' ? html`<ul class="task-notes">${visibleNotes(task).map((n) => html`<li>${icon('alert')}<span>${n}</span></li>`)}</ul>` : ''}
    ${isReview || correcting ? confirmForm(task, letter, settings, today, { correcting }) : ''}
    ${task.status === 'offen' && !correcting ? html`
      <p class="reminder-line">${icon('bell')}${activeReminders.length
        ? `Erinnerung: ${activeReminders.map((r) => formatDateTime(r.remindAt)).join('; ')}`
        : 'Keine Erinnerung geplant'}</p>
      <div class="row">
        <button class="btn btn-small" type="button" data-action="done" data-id="${task.id}">${icon('check')}Erledigt</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="correct" data-id="${task.id}">${icon('edit')}Datum ändern</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="reminders" data-id="${task.id}">${icon('bell')}Erinnerungen</button>
        ${task.dueDate && !autoCalendarActive() ? html`<button class="btn btn-small btn-ghost" type="button" data-action="ics" data-id="${task.id}">${icon('calendar')}In Kalender übernehmen</button>` : ''}
      </div>` : ''}
    ${task.status === 'erledigt' ? html`<div class="row"><button class="btn btn-small btn-secondary" type="button" data-action="reopen" data-id="${task.id}">Wieder öffnen</button></div>` : ''}
  </article>`;
}

/** Originalseiten (ohne zusätzlich aufbewahrte Originalfotos) mit Werkzeugen: PDF, trennen, zusammenführen. */
function originalView(files, { split = null, editable = true, tools = true, letterId = '' } = {}) {
  const pages = files.filter((f) => f.role !== 'original');
  const originals = files.filter((f) => f.role === 'original');
  if (!pages.length) return html`<p class="muted">Keine Datei vorhanden.</p>`;
  let page = 0;
  const views = pages.map((f) => {
    const first = page + 1;
    page += f.pageCount || 1;
    const label = f.pageCount > 1 ? `Seiten ${first}–${page}` : `Seite ${first}`;
    // Papierkorb direkt an der Seite – ohne nach oben zu scrollen
    const del = editable && !split && pages.length > 1
      ? html`<button class="icon-btn icon-btn-small" type="button" data-action="delete-page" data-file="${f.id}" aria-label="${label} löschen" title="Seite löschen">${icon('trash')}</button>` : '';
    const pick = split ? html`<label class="page-pick"><input type="checkbox" data-split-page="${f.id}" ${split.has(f.id) ? 'checked' : ''}><span>${label} in neuen Brief verschieben</span></label>` : '';
    if (f.kind === 'office') {
      const fmt = /presentation/.test(f.mime) ? 'PowerPoint' : /spreadsheet/.test(f.mime) ? 'Excel' : 'Word';
      const unit = fmt === 'PowerPoint' ? (f.pageCount === 1 ? 'Folie' : 'Folien') : fmt === 'Excel' ? (f.pageCount === 1 ? 'Tabelle' : 'Tabellen') : 'Dokument';
      return html`<figure class="original-page">
        <figcaption class="original-cap row"><span class="grow">${fmt}-Datei${fmt === 'Word' ? '' : ` · ${f.pageCount} ${unit}`} </span>
          <a class="btn btn-small btn-secondary" href="/api/files/${f.id}">${icon('download')}Herunterladen</a>${del}</figcaption>
      </figure>`;
    }
    if (f.kind === 'image') {
      return html`<figure class="original-page ${split?.has(f.id) ? 'is-picked' : ''}">${pick}<a class="original-fit" href="/api/files/${f.id}" data-view-letter="${letterId}" data-start="${first - 1}"><img src="/api/files/${f.id}" alt="Originalbrief, ${label}"></a>
        <figcaption class="original-cap row"><span class="grow">${label}</span>${del}</figcaption></figure>`;
    }
    return html`<figure class="original-page ${split?.has(f.id) ? 'is-picked' : ''}">${pick}
      <a class="pdf-view" data-pdf-view="${f.id}" href="/api/files/${f.id}" data-view-letter="${letterId}" data-start="${first - 1}" aria-label="Originalbrief, ${label} (PDF) öffnen"><span class="spinner" aria-hidden="true"></span></a>
      <figcaption class="original-cap row"><span class="grow">${label} (PDF)</span>
        <a class="btn btn-small btn-secondary" href="/api/files/${f.id}" data-view-letter="${letterId}" data-start="${first - 1}">${icon('maximize')}Vollbild</a>${del}</figcaption>
    </figure>`;
  });
  const toolbar = !tools ? '' : split
    ? html`<div class="page-toolbar is-split" role="group" aria-label="Seiten trennen">
        <p class="small">Wählen Sie die Seiten, die zu einem <strong>anderen</strong> Brief gehören. Sie werden ein eigener Brief und neu ausgewertet.</p>
        <div class="row"><button class="btn btn-small" type="button" data-action="split-do" ${split.size ? '' : 'disabled'}>${icon('split')}${split.size ? `${split.size === 1 ? '1 Seite' : `${split.size} Seiten`} als neuen Brief speichern` : 'Seiten auswählen'}</button>
          <button class="btn btn-small btn-ghost" type="button" data-action="split-cancel">Abbrechen</button></div></div>`
    : html`<div class="page-toolbar row" role="group" aria-label="Seiten">
        ${pages.every((p) => p.kind === 'office') ? '' : html`<button class="btn btn-small btn-secondary" type="button" data-action="pdf">${icon('download')}Als PDF</button>`}
        ${editable ? html`<a class="btn btn-small btn-secondary" href="#/scannen?zu=${letterId}">${icon('plus')}Seiten hinzufügen</a>` : ''}
        ${editable && pages.length > 1 ? html`<button class="btn btn-small btn-ghost" type="button" data-action="split-start">${icon('split')}Seiten trennen</button>` : ''}
        ${editable ? html`<button class="btn btn-small btn-ghost" type="button" data-action="merge">${icon('merge')}Seiten eines anderen Briefes anhängen</button>` : ''}
      </div>`;
  return html`${toolbar}${views}
    ${originals.length ? html`<details class="originals"><summary>${originals.length === 1 ? 'Originalfoto' : `${originals.length} Originalfotos`} (unbearbeitet)</summary>
      <div class="originals-grid">${originals.map((f, i) => html`<a href="/api/files/${f.id}" target="_blank" rel="noopener"><img src="/api/files/${f.id}" alt="Originalfoto ${i + 1}" loading="lazy"></a>`)}</div></details>` : ''}`;
}

/** Briefvorschau zum Blättern (rechts in der Box der erkannten Angaben). */
function previewPanel(files, letter, editable) {
  const pages = files.filter((f) => f.role !== 'original' && (f.kind === 'pdf' || f.kind === 'image'));
  const office = files.filter((f) => f.kind === 'office');
  if (!pages.length && !office.length) return '';
  return html`<section class="panel preview-panel" aria-label="Brief">
    ${pages.length ? html`<div class="pager" data-pager data-letter="${letter.id}" data-files="${JSON.stringify(pages.map((f) => ({ id: f.id, kind: f.kind })))}">
      <div class="pager-stage" data-pager-stage title="Antippen zum Vergrößern"><span class="spinner" aria-hidden="true"></span></div>
      <div class="pager-bar">
        <button class="icon-btn icon-btn-small" type="button" data-pager-prev aria-label="Vorherige Seite">${icon('chevronLeft')}</button>
        <span class="pager-label small muted" data-pager-label aria-live="polite"></span>
        <button class="icon-btn icon-btn-small" type="button" data-pager-next aria-label="Nächste Seite">${icon('chevronRight')}</button>
      </div>
      ${editable ? html`<div class="pager-tools">
        <a class="icon-btn icon-btn-small" href="#/scannen?zu=${letter.id}" aria-label="Seiten hinzufügen" title="Seiten hinzufügen">${icon('plus')}</a>
        <button class="icon-btn icon-btn-small" type="button" data-action="pages" aria-label="Seiten löschen" title="Seiten löschen">${icon('trash')}</button>
      </div>` : ''}
    </div>` : ''}
    ${office.map((f) => html`<p class="stack small"><span>${/presentation/.test(f.mime) ? 'PowerPoint' : /spreadsheet/.test(f.mime) ? 'Excel' : 'Word'}-Datei</span>
      <a class="btn btn-small btn-secondary" href="/api/files/${f.id}">${icon('download')}Laden</a></p>`)}
  </section>`;
}

/** Kurzform einer Webadresse für die Anzeige: Domain und Pfad, ohne https:// und www. */
function webLabel(url) {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

function factsPanel(letter, persons = [], { folderRow = '', analyzing = false, viewable = false } = {}) {
  const dateStatus = {
    unsicher: html`<span class="badge badge-review">${icon('alert')}unsicher</span>`,
    fehlt: html`<span class="badge badge-review">${icon('alert')}fehlt</span>`,
  }[letter.reviewed && letter.letterDateStatus !== 'bestaetigt' ? 'ohne' : letter.letterDateStatus];
  if (analyzing) {
    return html`<section class="panel stack facts-panel" aria-label="Brief">${folderRow}<p class="muted">Angaben erscheinen, sobald der Brief gelesen ist.</p></section>`;
  }
  return html`<section class="panel stack facts-panel" aria-labelledby="facts-h">
    <div class="section-title"><h2 id="facts-h">Erkannte Angaben</h2>
      <span class="facts-actions">
        ${viewable ? html`<button class="icon-btn" type="button" data-view-letter="${letter.id}" data-title="${letter.subject || 'Brief'}" aria-label="Brief öffnen" title="Brief öffnen">${icon('eye')}</button>` : ''}
        <button class="icon-btn" type="button" data-action="edit-facts" aria-label="Angaben bearbeiten" title="Bearbeiten">${icon('edit')}</button>
        ${letter.reviewed
          ? html`<span class="icon-btn is-done" role="img" aria-label="Alle Angaben bestätigt" title="Bestätigt">${icon('check')}</span>`
          : html`<button class="icon-btn icon-btn-primary" type="button" data-action="review" aria-label="Alle Angaben bestätigen" title="Alle bestätigen">${icon('check')}</button>`}
      </span></div>
    <dl class="facts">
      <div><dt>Absender</dt><dd>${letter.sender || html`<span class="muted">nicht erkannt</span>`}</dd></div>
      <div><dt>Briefdatum</dt><dd>${letter.letterDate ? formatDate(letter.letterDate) : html`<span class="muted">unbekannt</span>`} ${dateStatus}
</dd></div>
      <div><dt>Betreff</dt><dd>${letter.subject || html`<span class="muted">nicht erkannt</span>`}</dd></div>
      ${(letter.qrLinks || []).map((u) => html`<div><dt>Website</dt><dd><a class="facts-link" href="${u}" target="_blank" rel="noopener noreferrer" title="${u}"><span class="facts-link-text">${webLabel(u)}</span>${icon('external')}</a></dd></div>`)}
    </dl>
    ${folderRow}
  </section>`;
}

function explanation(data, settings, today, correcting, openSteps = new Set()) {
  const { letter, tasks } = data;
  const s = letter.summary || {};
  const sorted = [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const active = tasks.filter((t) => t.status !== 'erledigt');
  const review = tasks.filter((t) => t.status === 'zu_pruefen').length;
  const toCheck = [...(s.toCheck || [])];
  if (letter.letterDateStatus === 'erkannt' && !letter.reviewed) toCheck.push('Stimmt das erkannte Briefdatum?');
  const next = sorted.filter((t) => t.status !== 'erledigt' && (t.dueDate || t.suggestedDate)).map((t) => t.dueDate || t.suggestedDate).sort()[0];
  // Jeder Punkt ist ein aufklappbarer Balken; rechts steht nur eine kurze Angabe
  const step = (n, title, hint, body, attention = false) => html`<details class="explain-step" data-step="${n}" ${openSteps.has(n) ? html`open` : ''}>
    <summary><span class="step-num" aria-hidden="true">${n}</span><span class="step-title">${title}</span>
      ${hint ? html`<span class="step-hint ${attention ? 'is-attention' : ''}">${hint}</span>` : ''}<span class="step-chevron" aria-hidden="true">${icon('chevronDown')}</span></summary>
    <div class="step-body">${body}</div>
  </details>`;
  return html`<div class="explain">
    ${step('1', 'Worum geht es?', s.legalNote ? 'Wichtig' : '', html`<div class="explain-body stack">
        <p>${s.what || 'Keine Erklärung vorhanden – siehe Original.'}</p>
        ${s.legalNote ? html`<div class="note note-warn">${icon('alert')}<div><strong>Wichtig</strong><p>${s.legalNote}</p></div></div>` : ''}
      </div>`, Boolean(s.legalNote))}

    ${step('2', 'Was muss ich tun?', active.length ? String(active.length) : 'nichts', html`
      ${active.length ? html`<ul class="todo-list">${active.map((t) => html`<li>${icon('circle')}<span>${t.title}</span></li>`)}</ul>`
        : s.nothingToDo ? html`<p class="explain-body">Nichts.</p>`
          : tasks.length ? html`<p class="explain-body">Alles erledigt.</p>`
            : html`<p class="explain-body">Keine Aufgaben erkannt.</p>`}
      <p><button class="btn btn-small btn-ghost" type="button" data-action="add-task">${icon('plus')}Eigene Aufgabe</button></p>`, active.length > 0)}

    ${step('3', 'Bis wann?', next ? formatDate(next, { short: true }) : '', html`
      ${sorted.length ? html`<div class="stack">${sorted.map((t) => taskCard(t, letter, settings, today, correcting.has(t.id)))}</div>`
        : html`<p class="explain-body">Keine Fristen.</p>`}`, review > 0)}

    ${step('4', 'Was muss ich prüfen?', toCheck.length ? String(toCheck.length) : '', html`
      ${toCheck.length ? html`<ul class="check-list">${toCheck.map((c) => html`<li>${icon('alert')}<span>${c}</span></li>`)}</ul>` : html`<p class="explain-body">Nichts.</p>`}
      ${!letter.reviewed && letter.analysisStatus !== 'wartet' && letter.analysisStatus !== 'laeuft' ? html`<p><button class="btn btn-secondary" type="button" data-action="review">${icon('check')}Angaben stimmen</button></p>` : ''}`)}
  </div>`;
}

const FIELD_LABELS = {
  sender: 'Absender', subject: 'Betreff', category: 'Kategorie', letter_date: 'Briefdatum', letter_date_status: 'Briefdatum',
  received_date: 'Zugangsdatum', refs_json: 'Nummern', sender_address: 'Absender-Anschrift', sender_email: 'Absender-E-Mail', person_id: 'Person',
};
const SOURCE_TEXT = { ki: 'mit KI', regeln: 'ohne KI (einfache Erkennung)', beispiel: 'Beispielauswertung', manuell: 'von Ihnen' };

/** Kurze Erläuterung zu einem Verlaufseintrag. */
function eventDetail(e) {
  const d = e.detail || {};
  const parts = [];
  if (d.quelle) parts.push(SOURCE_TEXT[d.quelle] || d.quelle);
  if (d.akten?.length) parts.push(d.akten.filter(Boolean).join(', '));
  if (d.akte) parts.push(d.akte);
  if (d.durch) parts.push(d.durch === 'nutzer' ? 'von Ihnen' : 'automatisch');
  if (d.grund) parts.push(d.grund);
  if (d.ohneAkte) parts.push('gehört zu keinem Ordner');
  if (d.seiten) parts.push(d.seiten === 1 ? '1 Seite' : `${d.seiten} Seiten`);
  if (d.originale) parts.push(d.originale === 1 ? '1 Originalfoto' : `${d.originale} Originalfotos`);
  if (d.ausBrief) parts.push(`aus „${d.ausBrief}“`);
  if (d.mit) parts.push(`mit „${d.mit}“`);
  if (d.felder?.length) parts.push([...new Set(d.felder.map((f) => FIELD_LABELS[f] || f))].join(', '));
  if (d.anzahl) parts.push(d.anzahl === 1 ? '1 Nummer' : `${d.anzahl} Nummern`);
  if (d.herkunft) parts.push(d.herkunft === 'ki' ? 'KI-Entwurf' : 'Vorlage');
  if (d.weg) parts.push(d.weg);
  if (d.an) parts.push(`an ${d.an}`);
  if (d.ueber) parts.push(d.ueber === 'text' ? 'gleicher Inhalt' : d.ueber === 'datei' ? 'gleiche Datei' : d.ueber);
  return parts.join(' · ');
}

function historyList(events = []) {
  if (!events.length) return html`<p class="muted small">Noch keine Einträge.</p>`;
  return html`<ol class="timeline">${[...events].reverse().map((e) => {
    const detail = eventDetail(e);
    return html`<li><span class="timeline-time">${formatDateTime(e.at)}</span>
      <span><strong>${e.label}</strong>${detail ? html`<span class="muted"> – ${detail}</span>` : ''}</span></li>`;
  })}</ol>`;
}

export async function render({ root, params, query, state, navigate, isCurrent }) {
  const id = params.id;
  let data = null;
  // Ansicht: Erklärung, Antwort, Original – oder keine (null): dann folgt direkt der nächste Abschnitt
  let tab = ['erklaerung', 'aufgaben', 'antworten'].includes(query.get('ansicht')) ? query.get('ansicht') : null;
  const openSteps = new Set(); // aufgeklappte Punkte der Erklärung (bleiben beim Neuzeichnen offen)
  // Auch über einen Link auf eine Aufgabe bleibt der Aufgaben-Reiter zu (Wunsch des Nutzers)
  let pollTimer = null;
  const correcting = new Set();
  const today = todayIn(state.me?.timezone || 'Europe/Berlin');
  const settings = state.me?.settings || { reminderOffsets: ['7d', '1d'] };
  let scrolledToTask = false;
  let persons = [];
  let assignEditing = false; // „Ordner ändern“ geöffnet
  let split = null; // Set der Seiten im Modus „Seiten trennen“
  // Leiste „Brief ablegen“ weggeklickt? (gilt für alle Briefe, bis sie wieder eingeblendet wird)
  let barHidden = false;
  try {
    barHidden = localStorage.getItem('bp-filebar') !== 'an'; // standardmäßig eingeklappt
  } catch {
    barHidden = false;
  }

  async function load() {
    const [letterData, household] = await Promise.all([
      api.get(`/api/letters/${id}`),
      persons.length ? null : loadHousehold().catch(() => null),
    ]);
    const wasAnalyzing = ['wartet', 'laeuft'].includes(data?.letter?.analysisStatus);
    data = letterData;
    setNavTitle(letterData.letter.subject || 'Brief');
    if (household) persons = household.persons || [];
    // Auswertung fertig: Brief mit den erkannten Angaben gleich sichern
    if (wasAnalyzing && !['wartet', 'laeuft'].includes(data.letter.analysisStatus) && state.me) backupNow(state.me);
    if (!isCurrent()) return;
    draw();
    // QR-Codes einmal je Brief suchen; gefundene Websites erscheinen bei den Angaben
    if (!['wartet', 'laeuft'].includes(data.letter.analysisStatus) && data.letter.qrLinks === null && !data.letter.isDemoContent) {
      const forLetter = data.letter;
      scanLetterQr(forLetter, data.files).then((list) => {
        if (!list) return;
        forLetter.qrLinks = list;
        if (list.length && isCurrent() && data.letter === forLetter) draw();
      });
    }
    clearTimeout(pollTimer);
    if (['wartet', 'laeuft'].includes(data.letter.analysisStatus)) pollTimer = setTimeout(() => load().catch(() => {}), 2500);
    const target = query.get('aufgabe');
    if (target && !scrolledToTask) {
      const el = document.getElementById(`task-${target}`);
      if (el) {
        scrolledToTask = true;
        el.scrollIntoView({ block: 'center' });
        el.focus({ preventScroll: true });
      }
    }
  }

  function showTab(next) {
    tab = next;
    draw();
    if (tab) dropIntoView();
  }

  /** Geöffneter Reiter klappt unter der Leiste auf: Seite so stellen, dass die Leiste an ihrem Platz oben steht. */
  function dropIntoView() {
    const anchor = root.querySelector('[data-tabs-anchor]');
    const sc = scroller();
    if (!anchor || !sc) return;
    const top = anchor.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop;
    if (sc.scrollTop > top) sc.scrollTop = top;
  }

  /** Was vor dem Ablegen noch offen ist (kurz). */
  function openPoints() {
    const { letter, tasks } = data;
    const points = [];
    const review = tasks.filter((t) => t.status === 'zu_pruefen').length;
    if (review) points.push(review === 1 ? '1 Frist nicht bestätigt' : `${review} Fristen nicht bestätigt`);
    if (['neue_akte', 'pruefen', 'vorschlag'].includes(letter.assignmentStatus)) points.push('kein Ordner gewählt');
    return points;
  }

  /** Feste Leiste unten: kurze Zusammenfassung, „Später“ und „Brief ablegen“. */
  function fileBar() {
    const open = openPoints();
    if (barHidden) {
      return html`<button class="file-bar-show" type="button" data-action="bar-show" aria-label="Leiste „Brief ablegen“ einblenden">${icon('folder')}</button>`;
    }
    return html`<div class="file-bar-spacer" aria-hidden="true"></div>
      <div class="file-bar" role="region" aria-label="Brief ablegen">
        <button class="icon-btn file-bar-hide" type="button" data-action="bar-hide" aria-label="Leiste ausblenden" title="Ausblenden">${icon('chevronDown')}</button>
        <button class="btn file-bar-main" type="button" data-action="file-away" ${open.length ? html`title="${open.join(' · ')}"` : ''}>${icon('folder')}Brief ablegen${open.length ? html`<span class="file-bar-badge" aria-label="${open.join(', ')}">${open.length}</span>` : ''}</button>
      </div>`;
  }

  /** Ordner: Zuordnung mit Nachweis – oder die Entscheidung, wenn BriefPilot unsicher ist. */
  function assignmentPanel() {
    const { letter, links } = data;
    const status = letter.assignmentStatus;
    const attention = status === 'pruefen' || status === 'vorschlag' || status === 'neue_akte';
    if (assignEditing || attention) {
      return html`<section class="panel stack assign-panel ${attention && !assignEditing ? 'is-attention' : ''}" aria-labelledby="assign-h">
        <h2 id="assign-h">${icon('folder')} ${assignEditing ? 'Ordner ändern' : 'Zu welchem Ordner gehört dieser Brief?'}</h2>
        <div data-decision></div>
      </section>`;
    }
    // Ordner steht oben am Brief („Ordner wählen“) – hier nur, wenn etwas zu entscheiden ist
    return '';
  }

  function duplicateNote() {
    const { letter, duplicate } = data;
    if (letter.duplicateStatus !== 'verdacht' || !duplicate) return '';
    return html`<div class="note note-warn" role="status">${icon('copy')}<div class="stack">
      <div><strong>Möglicherweise doppelt gespeichert</strong>
        <p>Ein sehr ähnlicher Brief ist schon vorhanden: „${duplicate.subject || 'Brief ohne Betreff'}“${duplicate.sender ? ` von ${duplicate.sender}` : ''}${duplicate.letterDate ? `, Brief vom ${formatDate(duplicate.letterDate)}` : ''} (hochgeladen am ${formatUploaded(duplicate.uploadedAt)}). Es wurde nichts gelöscht.</p></div>
      <div class="row"><a class="btn btn-small btn-secondary" href="#/briefe/${duplicate.id}">${icon('eye')}Vorhandenen Brief ansehen</a>
        <button class="btn btn-small btn-secondary" type="button" data-action="not-duplicate">${icon('check')}Kein Duplikat</button>
        <button class="btn btn-small btn-ghost" type="button" data-action="delete">${icon('trash')}Diesen Brief löschen</button></div>
    </div></div>`;
  }

  function draw() {
    const { letter, files, tasks, links } = data;
    const analyzing = ['wartet', 'laeuft'].includes(letter.analysisStatus);
    const editable = !letter.isDemoContent && !analyzing;
    const drafts = data.replies.filter((r) => r.status !== 'gesendet').length;
    const reviewCount = tasks.filter((t) => t.status === 'zu_pruefen').length;
    mount(root, html`<div class="stack-l">
      <p data-tabs-anchor>${backButton('#/briefe', 'Alle Briefe')}</p>
      <h1 class="visually-hidden">${letter.subject || (analyzing ? 'Neuer Brief' : 'Brief ohne Betreff')}</h1>
      <div class="tabs letter-tabs" role="tablist" aria-label="Ansicht">
        <button class="tab" role="tab" type="button" data-tab="erklaerung" aria-selected="${tab === 'erklaerung'}">Erklärung</button>
        <button class="tab" role="tab" type="button" data-tab="aufgaben" aria-selected="${tab === 'aufgaben'}">Aufgaben${reviewCount ? html` <span class="tab-count">${reviewCount}</span>` : ''}</button>
        <button class="tab" role="tab" type="button" data-tab="antworten" aria-selected="${tab === 'antworten'}">Antwort${drafts ? html` <span class="tab-count">${drafts}</span>` : ''}</button>
      </div>
      ${tab ? html`<div class="tab-drop stack-l" data-drop>
          ${tab === 'erklaerung' ? html`<div data-panel="erklaerung" class="stack-l">
            ${analyzing ? html`<p class="muted">Erscheint, sobald der Brief gelesen ist.</p>` : explanation(data, settings, today, correcting, openSteps)}
            ${analyzing ? '' : chatPanel(data, state)}
          </div>` : ''}
          ${tab === 'aufgaben' ? html`<div data-panel="aufgaben" class="stack">
            <div class="row"><h2 class="grow">Aufgaben</h2>
              <button class="btn btn-small btn-secondary" type="button" data-action="add-task">${icon('plus')}Aufgabe</button></div>
            ${tasks.length ? [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]).map((t) => taskCard(t, letter, settings, today, correcting.has(t.id)))
              : html`<p class="muted">${analyzing ? 'Erscheint, sobald der Brief gelesen ist.' : 'Keine Aufgaben.'}</p>`}
          </div>` : ''}
          <div data-panel="antworten" ${tab === 'antworten' ? '' : html`hidden`}>${tab === 'antworten' ? repliesPanel(data, state) : ''}</div>
      </div>` : ''}

      ${analyzing ? html`<div class="note" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>Wird gelesen …</strong><p>Meist unter einer Minute.</p></div></div>` : ''}
      ${letter.analysisStatus === 'fehler' ? html`<div class="note note-danger" role="alert">${icon('alert')}<div class="stack"><div><strong>Die Auswertung hat nicht geklappt.</strong><p>${letter.analysisError}</p></div>
        <p><button class="btn btn-small" type="button" data-action="reanalyze">${icon('refresh')}Erneut auswerten</button></p></div></div>` : ''}
      ${letter.analysisStatus === 'nicht_moeglich' ? html`<div class="note note-warn" role="status">${icon('info')}<div class="stack"><div><strong>Gespeichert, aber nicht gelesen.</strong><p>${letter.analysisError}</p></div>
        <div class="row"><button class="btn btn-small" type="button" data-action="edit-facts">${icon('edit')}Angaben selbst eintragen</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="add-task">${icon('plus')}Aufgabe anlegen</button></div></div></div>` : ''}
      ${letter.injectionWarning ? html`<div class="note note-danger" role="alert">${icon('shield')}<div><strong>Vorsicht bei diesem Schreiben</strong><p>Enthält Anweisungen an eine KI – wurden ignoriert.</p></div></div>` : ''}
      ${duplicateNote()}
      ${analyzing ? '' : assignmentPanel()}

      ${previewPanel(files, letter, editable)}
      ${factsPanel(letter, persons, {
        analyzing,
        viewable: files.some((f) => f.role !== 'original' && (f.kind === 'pdf' || f.kind === 'image')),
        folderRow: html`<p class="facts-folder">${icon('folder')}<span>${links.length
          ? links.map((l, i) => html`${i ? ', ' : ''}<a href="#/akten/${l.objectId}">${l.name}</a>`)
          : 'Kein Ordner'}</span></p>`,
      })}
      ${split ? html`<section class="panel stack">${originalView(files, { split, editable, letterId: letter.id })}</section>` : ''}

      ${!analyzing ? html`<section class="panel stack more-panel">
            <h2>Weitere Möglichkeiten</h2>
            <div class="row">
              ${letter.isDemoContent ? '' : html`<button class="btn btn-small btn-secondary" type="button" data-action="pick-folder">${icon('folderPlus')}Ordner wählen</button>`}
              <button class="btn btn-small btn-secondary" type="button" data-tab="antworten">${icon('reply')}Antwort schreiben</button>
              <button class="btn btn-small btn-secondary" type="button" data-action="pdf">${icon('download')}Als PDF herunterladen</button>
              ${editable && files.filter((f) => f.role !== 'original').length > 1 ? html`<button class="btn btn-small btn-secondary" type="button" data-action="split-start">${icon('split')}Seiten trennen</button>` : ''}
              ${editable ? html`<button class="btn btn-small btn-secondary" type="button" data-action="merge">${icon('merge')}Anderen Brief anhängen</button>` : ''}
              ${letter.isDemoContent ? '' : html`<button class="btn btn-small btn-secondary" type="button" data-action="reanalyze">${icon('refresh')}Erneut auswerten</button>`}
              <button class="btn btn-small btn-danger" type="button" data-action="delete">${icon('trash')}Brief löschen</button>
            </div>
            <details class="history"><summary>${icon('history')} Verlauf (${data.events.length})</summary>${historyList(data.events)}</details>
          </section>` : ''}
      <p class="upload-note">Hochgeladen am ${formatUploaded(letter.uploadedAt)}</p>
      ${analyzing ? '' : fileBar()}
    </div>`);

    // Entscheidung über den Ordner einbauen (Kandidaten mit Nachweisen, Nummern merken …)
    const decisionBox = root.querySelector('[data-decision]');
    if (decisionBox) {
      const a = letter.assignment || {};
      const current = assignEditing ? links.map((l) => l.objectId) : [];
      const fromLinks = links.map((l) => ({ objectId: l.objectId, name: l.name, type: l.type, caseTitle: l.caseTitle, evidence: l.evidence.filter((e) => e.type !== 'nutzer'), preselected: true }));
      const candidates = [...fromLinks, ...(a.candidates || []).filter((c) => !links.some((l) => l.objectId === c.objectId))];
      mountDecision(decisionBox, {
        letter,
        assignment: { ...a, identifiers: a.identifiers?.length ? a.identifiers : letter.identifiers, candidates },
        current,
        onDone: async () => {
          assignEditing = false;
          forgetObjects();
          refreshCounts();
          await load();
          root.querySelector('#assign-h')?.scrollIntoView({ block: 'nearest' });
        },
        onCancel: assignEditing ? () => {
          assignEditing = false;
          draw();
        } : undefined,
      });
    }
    if (tab === 'antworten') assistant.fillTemplates();
    hydratePdfViews(root);
    hydratePagers(root);

    // Relative Frist: rechnerisches Ende vorschlagen, sobald ein Zugangsdatum eingegeben ist
    root.querySelectorAll('[data-received]').forEach((input) => {
      const form = input.closest('form');
      const task = tasks.find((t) => t.id === form.dataset.confirm);
      const due = form.querySelector('[data-due]');
      const out = form.querySelector('[data-computed]');
      let manual = Boolean(due.value);
      due.addEventListener('input', () => {
        manual = true;
      });
      const update = () => {
        if (!isValidIsoDate(input.value) || !task.relativeRule) {
          mount(out, task.relativeRule ? '' : html`<p class="small muted">Fristende bitte selbst eintragen.</p>`);
          return;
        }
        const res = computeRelativeEnd(task.relativeRule, { receivedDate: input.value, letterDate: letter.letterDate });
        if (!res.date) {
          mount(out, '');
          return;
        }
        mount(out, html`<div><p class="small muted">${formatDate(res.start, { short: true })} + ${periodLabel(task.relativeRule)} = ${formatDate(res.date, { short: true })}</p>
          </div>`);
        if (!manual) due.value = res.date;
      };
      input.addEventListener('input', update);
      update();
    });
  }

  function refreshCounts() {
    api.get('/api/overview').then((o) => {
      setReviewCount(o.counts.tasksToReview);
      setInboxCount(o.counts.inbox);
    }).catch(() => {});
  }

  async function reload() {
    await load();
    refreshCounts();
  }

  // Antworten und Fragen (eigene Ereignisse über Ereignis-Delegation)
  const assistant = bindAssistant(root, { letterId: id, getData: () => data, reload: load, state, showTab });

  // Seiten trennen: Auswahl merken, ohne die Seite neu aufzubauen
  root.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-split-page]');
    if (!pick || !split) return;
    if (pick.checked) split.add(pick.dataset.splitPage);
    else split.delete(pick.dataset.splitPage);
    const y = scroller().scrollTop;
    draw();
    scroller().scrollTop = y;
    root.querySelector(`[data-split-page="${pick.dataset.splitPage}"]`)?.focus({ preventScroll: true });
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-confirm]');
    if (!form) return;
    e.preventDefault();
    clearErrors(form);
    const mode = e.submitter?.dataset.mode || 'date';
    const v = formValues(form);
    const body = { checked: v.checked === true, reminders: v.reminders || [] };
    const task = data.tasks.find((t) => t.id === form.dataset.confirm);
    if (mode === 'nodate' || (!v.dueDate && task?.kind === 'aufgabe' && !needsReceivedDate(task))) {
      body.withoutDate = true;
    } else {
      body.dueDate = v.dueDate;
      if (v.dueTime) body.dueTime = v.dueTime;
      if (v.receivedDate) body.receivedDate = v.receivedDate;
    }
    await busy(e.submitter, async () => {
      try {
        const res = await api.post(`/api/tasks/${form.dataset.confirm}/confirm`, body);
        correcting.delete(form.dataset.confirm);
        const planned = res.schedule?.planned || 0;
        toast(body.withoutDate ? 'Übernommen – ohne Datum.' : `Bestätigt. ${planned === 1 ? 'Eine Erinnerung' : `${planned} Erinnerungen`} geplant.`);
        if (res.warnings?.length) setTimeout(() => toast(res.warnings.join(' ')), 3600);
        await reload();
        offerCalendarOnce(!body.withoutDate);
      } catch (err) {
        showError(form, err);
      }
    });
  });


  /** „Ordner wählen“: vorhandenen Ordner antippen oder neuen anlegen – der Brief liegt dann direkt darin. */
  async function pickFolder() {
    const target = await moveSheet({ title: 'Zuordnen', item: data.letter.subject || data.letter.sender || 'Brief', current: data.links.map((l) => l.objectId) });
    if (!target) return;
    try {
      await fileLetterInto(id, target);
      forgetObjects();
      refreshCounts();
      await load();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // Aufgeklappte Punkte merken (toggle steigt nicht auf – daher in der Capture-Phase)
  root.addEventListener('toggle', (e) => {
    const step = e.target.closest?.('[data-step]');
    if (!step) return;
    if (step.open) openSteps.add(step.dataset.step);
    else openSteps.delete(step.dataset.step);
  }, true);

  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      // Erneutes Tippen auf den gewählten Reiter schließt ihn (keine Ansicht gewählt)
      tab = tabBtn.classList.contains('tab') && tab === tabBtn.dataset.tab ? null : tabBtn.dataset.tab;
      draw();
      root.querySelector(`.tabs [data-tab="${tab || tabBtn.dataset.tab}"]`)?.focus({ preventScroll: true });
      if (tab) dropIntoView();
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const taskId = el.dataset.id;
    const action = el.dataset.action;
    try {
      if (action === 'done') {
        await api.post(`/api/tasks/${taskId}/done`);
        toast('Als erledigt markiert.');
        await reload();
      } else if (action === 'reopen') {
        await api.post(`/api/tasks/${taskId}/reopen`);
        await reload();
      } else if (action === 'correct') {
        correcting.add(taskId);
        draw();
        document.getElementById(`task-${taskId}`)?.querySelector('input')?.focus();
      } else if (action === 'cancel-correct') {
        correcting.delete(taskId);
        draw();
      } else if (action === 'discard') {
        if (await confirmDialog({ title: 'Vorschlag verwerfen?', body: 'Diese erkannte Aufgabe wird entfernt. Der Brief selbst bleibt erhalten.', confirmLabel: 'Verwerfen', danger: true })) {
          await api.del(`/api/tasks/${taskId}`);
          toast('Vorschlag verworfen.');
          await reload();
        }
      } else if (action === 'ics') {
        await download(`/api/tasks/${taskId}/ics`, 'termin.ics');
        toast('Kalenderdatei heruntergeladen. Öffnen Sie sie, um den Termin in Ihren Kalender zu übernehmen.');
      } else if (action === 'reminders') {
        editReminders(data.tasks.find((t) => t.id === taskId));
      } else if (action === 'file-away') {
        // Noch kein Ordner: direkt die Ordnerauswahl öffnen (keine Rückfrage)
        if (!data.links.length) {
          pickFolder();
          return;
        }
        const akte = data.links.map((l) => l.name).join(', ');
        toast(akte ? `Abgelegt in ${akte}.` : 'Abgelegt.');
        navigate('/briefe');
      } else if (action === 'edit-tags') {
        openDialog(html`<form class="dialog-body stack" novalidate>
          <h2>Schlagworte</h2>
          <div class="field"><label for="tags-in">Mit Komma trennen</label>
            <input class="input" id="tags-in" name="tags" value="${(data.letter.tags || []).join(', ')}" autocomplete="off" placeholder="z. B. Steuer, Auto, Garantie"></div>
          <div class="row"><button class="btn" type="submit">${icon('check')}Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
        </form>`, (dialog, close) => {
          const form = dialog.querySelector('form');
          dialog.querySelector('[data-close]').addEventListener('click', () => close());
          form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            try {
              await api.put(`/api/letters/${id}/tags`, { tags: form.tags.value });
              close();
              await reload();
            } catch (err) {
              toast(err.message, { error: true });
            }
          });
          form.tags.focus();
        });
      } else if (action === 'pages') {
        const removed = await pagesSheet({ letterId: id, files: data.files.filter((f) => f.role !== 'original') });
        if (removed) await reload();
      } else if (action === 'confirm-delivery') {
        await api.patch(`/api/letters/${id}`, { receivedDate: data.letter.receivedSuggested });
        toast('Zustelldatum übernommen.');
        await reload();
      } else if (action === 'review') {
        await api.post(`/api/letters/${id}/review`);
        toast('Alle Angaben bestätigt.');
        await reload();
      } else if (action === 'reanalyze') {
        if (await confirmDialog({ title: 'Brief erneut auswerten?', body: 'Unbestätigte Vorschläge werden ersetzt. Von Ihnen bestätigte Aufgaben und Ihre Korrekturen bleiben erhalten.', confirmLabel: 'Erneut auswerten' })) {
          await api.post(`/api/letters/${id}/reanalyze`);
          await reload();
        }
      } else if (action === 'delete') {
        if (await confirmDialog({ title: 'Brief endgültig löschen?', body: 'Das Original, die Erklärung, alle Aufgaben und Erinnerungen zu diesem Brief werden gelöscht. Das kann nicht rückgängig gemacht werden.', confirmLabel: 'Endgültig löschen', danger: true })) {
          await api.del(`/api/letters/${id}`);
          toast('Brief gelöscht.');
          navigate('/briefe');
        }
      } else if (action === 'edit-facts') {
        editFacts();
      } else if (action === 'add-task') {
        addTask();
      } else if (action === 'assign-change') {
        assignEditing = true;
        draw();
        root.querySelector('#assign-h')?.scrollIntoView({ block: 'nearest' });
        root.querySelector('[data-decision] [data-choice], [data-decision] [data-load-objects]')?.focus({ preventScroll: true });
      } else if (action === 'not-duplicate') {
        await api.post(`/api/letters/${id}/duplicate`, { decision: 'kein_duplikat' });
        toast('Gespeichert: kein Duplikat.');
        await load();
      } else if (action === 'pdf') {
        await download(`/api/letters/${id}/pdf`, 'brief.pdf');
        toast('PDF heruntergeladen.');
      } else if (action === 'split-start') {
        split = new Set();
        draw();
        root.querySelector('[data-split-page]')?.focus();
      } else if (action === 'split-cancel') {
        split = null;
        draw();
      } else if (action === 'split-do') {
        const fileIds = [...(split || [])];
        if (!fileIds.length) return;
        if (await confirmDialog({
          title: fileIds.length === 1 ? 'Seite als eigenen Brief speichern?' : `${fileIds.length} Seiten als eigenen Brief speichern?`,
          body: 'Die ausgewählten Seiten werden ein neuer Brief. Beide Briefe werden danach neu ausgewertet. Es wird nichts gelöscht.',
          confirmLabel: 'Neuen Brief anlegen',
        })) {
          const res = await api.post(`/api/letters/${id}/split`, { fileIds });
          split = null;
          toast('Neuer Brief angelegt. Beide werden jetzt neu gelesen.');
          await load();
          if (res.newId && await confirmDialog({ title: 'Neuen Brief öffnen?', body: 'Der abgetrennte Teil ist jetzt ein eigener Brief.', confirmLabel: 'Öffnen', cancelLabel: 'Hier bleiben' })) navigate(`/briefe/${res.newId}`);
        }
      } else if (action === 'merge') {
        await mergeDialog();
      } else if (action === 'bar-hide' || action === 'bar-show') {
        barHidden = action === 'bar-hide';
        try {
          localStorage.setItem('bp-filebar', barHidden ? 'aus' : 'an');
        } catch {
          /* nur für diese Ansicht */
        }
        draw();
      } else if (action === 'pick-folder') {
        pickFolder();
      } else if (action === 'delete-current-page') {
        const fileId = root.querySelector('[data-pager]')?.dataset.current;
        const file = data.files.find((f) => f.id === fileId);
        if (!file) return;
        const many = file.kind === 'pdf' && (file.pageCount || 1) > 1;
        if (await confirmDialog({ title: many ? 'Dieses PDF löschen?' : 'Diese Seite löschen?', body: many ? `Das PDF hat ${file.pageCount} Seiten; alle werden entfernt.` : '', confirmLabel: 'Löschen', danger: true })) {
          await api.del(`/api/letters/${id}/pages/${fileId}`);
          toast('Gelöscht.');
          await load();
        }
      } else if (action === 'delete-page') {
        if (await confirmDialog({ title: 'Seite löschen?', body: 'Der Brief wird danach neu gelesen.', confirmLabel: 'Löschen', danger: true })) {
          await api.del(`/api/letters/${id}/pages/${el.dataset.file}`);
          toast('Seite gelöscht.');
          await load();
        }
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  function editFacts() {
    const l = data.letter;
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Angaben korrigieren</h2>
      <div class="field"><label for="f-sender">Absender</label><input class="input" id="f-sender" name="sender" value="${l.sender || ''}" maxlength="200"></div>
      <div class="field"><label for="f-date">Briefdatum</label><input class="input" type="date" id="f-date" name="letterDate" value="${l.letterDate || ''}"></div>
      <div class="field"><label for="f-subject">Betreff</label><input class="input" id="f-subject" name="subject" value="${l.subject || ''}" maxlength="300"></div>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = formValues(form);
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            const body = { sender: v.sender, subject: v.subject, letterDate: v.letterDate || null };
            await api.patch(`/api/letters/${id}`, body);
            close();
            toast('Angaben gespeichert.');
            await reload();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  /** Seiten eines anderen Briefes anhängen (z. B. Seite 2 wurde als eigener Brief gescannt). */
  async function mergeDialog() {
    const { letters } = await api.get('/api/letters?sort=upload&limit=60');
    const others = letters.filter((l) => l.id !== id && !l.isDemoContent && !['wartet', 'laeuft'].includes(l.analysisStatus));
    if (!others.length) {
      toast('Es gibt keinen anderen Brief, dessen Seiten angehängt werden könnten.');
      return;
    }
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Seiten eines anderen Briefes anhängen</h2>
      <p class="muted">Seiten eines anderen Briefs hinten anhängen.</p>
      <fieldset class="field"><legend class="field-label">Welcher Brief?</legend>
        <div class="pick-list">${others.map((l) => html`<label class="check"><input type="radio" name="sourceId" value="${l.id}">
          <span><strong>${l.subject || 'Brief ohne Betreff'}</strong><span class="row-sub">${l.sender || 'Absender unbekannt'} · ${l.letterDate ? formatDate(l.letterDate) : `hochgeladen ${formatUploaded(l.uploadedAt)}`}${l.pageCount ? ` · ${l.pageCount === 1 ? '1 Seite' : `${l.pageCount} Seiten`}` : ''}</span></span></label>`)}</div>
      </fieldset>
      <div class="row"><button class="btn" type="submit">${icon('merge')}Anhängen</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const sourceId = new FormData(form).get('sourceId');
        if (!sourceId) {
          showError(form, new Error('Bitte einen Brief auswählen.'));
          return;
        }
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post(`/api/letters/${id}/merge`, { sourceId });
            close();
            toast('Seiten angehängt. Der Brief wird neu gelesen.');
            await reload();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function addTask() {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Eigene Aufgabe</h2>
      <div class="field"><label for="t-title">Was ist zu tun?</label><input class="input" id="t-title" name="title" maxlength="160" required></div>
      <div class="field"><label for="t-kind">Art</label><select class="input" id="t-kind" name="kind">
        ${TASK_KINDS.map((k) => html`<option value="${k.id}" ${k.id === 'aufgabe' ? 'selected' : ''}>${k.label}</option>`)}</select></div>
      <div class="field-pair">
        <div class="field"><label for="t-date">Datum <span class="muted">(freiwillig)</span></label><input class="input" type="date" id="t-date" name="dueDate"></div>
        <div class="field"><label for="t-time">Uhrzeit <span class="muted">(freiwillig)</span></label><input class="input" type="time" id="t-time" name="dueTime"></div>
      </div>
      ${reminderChips(settings.reminderOffsets)}
      <div class="row"><button class="btn" type="submit">Aufgabe speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = formValues(form);
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post('/api/tasks', { letterId: id, title: v.title, kind: v.kind, dueDate: v.dueDate || null, dueTime: v.dueTime || null, reminders: v.reminders || [] });
            close();
            toast('Aufgabe gespeichert.');
            await reload();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function editReminders(task) {
    const planned = (task.reminders || []).filter((r) => r.status === 'geplant');
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Erinnerungen</h2>
      <p class="muted">${task.title}${task.dueDate ? ` – ${formatDate(task.dueDate, { weekday: true })}` : ''}</p>
      ${planned.length ? html`<p class="small">Geplant: ${planned.map((r) => formatDateTime(r.remindAt)).join('; ')}</p>` : html`<p class="small">Zurzeit ist keine Erinnerung geplant.</p>`}
      ${task.dueDate ? reminderChips(settings.reminderOffsets, 'offsets') : ''}
      <div class="field-pair">
        <div class="field"><label for="r-date">Eigener Zeitpunkt <span class="muted">(freiwillig)</span></label><input class="input" type="date" id="r-date" name="customDate" min="${today}"></div>
        <div class="field"><label for="r-time">Uhrzeit</label><input class="input" type="time" id="r-time" name="customTime" value="08:00"></div>
      </div>
      <div class="row"><button class="btn" type="submit">Erinnerungen speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = formValues(form);
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            const res = await api.put(`/api/tasks/${task.id}/reminders`, { offsets: v.offsets || [], customDate: v.customDate || null, customTime: v.customTime || null });
            close();
            toast(`${res.schedule.planned === 1 ? 'Eine Erinnerung' : `${res.schedule.planned} Erinnerungen`} geplant.`);
            await reload();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  await load();
  return () => clearTimeout(pollTimer);
}
