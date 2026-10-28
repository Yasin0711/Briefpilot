// Brief-Detailansicht: Erklärung in vier Schritten, Fristen bestätigen, Original und erkannter Text.
import { html, mount } from '../html.js';
import { api, download } from '../api.js';
import {
  icon, dateTile, whenLabel, categoryTile, statusBadge, taskKindLabel, toast, confirmDialog, openDialog,
  formValues, showError, clearErrors, busy, formatUploaded,
} from '../ui.js';
import {
  CATEGORIES, REMINDER_OFFSETS, ANALYSIS_SOURCE_LABELS, TASK_KINDS, categoryLabel,
} from '../shared/constants.js';
import { formatDate, formatDateTime, computeRelativeEnd, todayIn, isValidIsoDate, isWeekend } from '../shared/dates.js';
import { setReviewCount } from '../app.js';

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

function confirmForm(task, letter, settings, today, { correcting = false } = {}) {
  const relative = task.isRelative;
  const dateValue = task.dueDate || task.suggestedDate || '';
  const timeValue = task.dueTime || task.suggestedTime || '';
  const offsets = task.reminders?.length ? settings.reminderOffsets : settings.reminderOffsets;
  return html`<form class="confirm-box stack" data-confirm="${task.id}" novalidate>
    <h4 class="visually-hidden">Angaben bestätigen</h4>
    ${relative ? html`
      <div class="note note-warn">${icon('hourglass')}<p>Diese Frist hängt davon ab, wann Sie den Brief bekommen haben${task.relativeText ? html` („${task.relativeText}“)` : ''}. Ohne Zugangsdatum zeigt BriefPilot kein Enddatum an.</p></div>
      <div class="field"><label for="rd-${task.id}">Wann haben Sie den Brief bekommen?</label>
        <input class="input" type="date" id="rd-${task.id}" name="receivedDate" max="${today}" value="${letter.receivedDate || ''}" data-received>
        <p class="hint">Das Datum, an dem der Brief in Ihrem Briefkasten lag. Bei Bescheiden von Behörden gilt ein Brief oft erst einige Tage nach dem Absenden als zugestellt – im Zweifel beim Absender nachfragen.</p></div>
      <div data-computed aria-live="polite"></div>
      <div class="field"><label for="dd-${task.id}">Fristende</label>
        <input class="input" type="date" id="dd-${task.id}" name="dueDate" value="${task.dueDate || ''}" data-due>
        <p class="hint">Wird nach Eingabe des Zugangsdatums vorgeschlagen. Bitte selbst prüfen.</p></div>`
    : html`<div class="field-pair">
        <div class="field"><label for="dd-${task.id}">${dueLabel(task.kind)}</label>
          <input class="input" type="date" id="dd-${task.id}" name="dueDate" value="${dateValue}">
          ${!dateValue && task.kind !== 'aufgabe' ? html`<p class="hint">Kein Datum erkannt. Tragen Sie es ein, falls es im Brief steht.</p>` : ''}</div>
        <div class="field"><label for="dt-${task.id}">Uhrzeit <span class="muted">(freiwillig)</span></label>
          <input class="input" type="time" id="dt-${task.id}" name="dueTime" value="${timeValue}"></div>
      </div>`}
    ${reminderChips(offsets)}
    <label class="check check-strong"><input type="checkbox" name="checked">
      <span>Ich habe ${relative ? 'die Frist' : 'Datum und Angaben'} mit dem Original-Brief verglichen.</span></label>
    <div class="row">
      <button class="btn" type="submit" data-mode="date">${icon('check')}${correcting ? 'Änderung speichern' : 'Bestätigen'}</button>
      ${!relative ? html`<button class="btn btn-secondary" type="submit" data-mode="nodate">Ohne Datum übernehmen</button>` : ''}
      ${correcting
        ? html`<button class="btn btn-ghost" type="button" data-action="cancel-correct" data-id="${task.id}">Abbrechen</button>`
        : html`<button class="btn btn-ghost" type="button" data-action="discard" data-id="${task.id}">${icon('x')}Keine Aufgabe – verwerfen</button>`}
    </div>
  </form>`;
}

function taskCard(task, letter, settings, today, correcting) {
  const isReview = task.status === 'zu_pruefen';
  const shownDate = isReview ? (task.isRelative ? null : task.suggestedDate) : task.dueDate;
  let dateLine;
  if (task.status === 'erledigt') dateLine = html`<p class="small muted">Erledigt${task.completedAt ? ` am ${formatUploaded(task.completedAt)}` : ''}</p>`;
  else if (isReview) {
    if (task.isRelative) dateLine = html`<p><strong>Relative Frist:</strong> ${task.relativeText || 'hängt vom Zugang ab'}</p>`;
    else if (task.suggestedDate) dateLine = html`<p>Erkanntes Datum: <strong>${formatDate(task.suggestedDate, { weekday: true })}${task.suggestedTime ? `, ${task.suggestedTime} Uhr` : ''}</strong> – noch nicht bestätigt</p>`;
    else dateLine = html`<p class="muted">${task.kind === 'aufgabe' ? 'Ohne festes Datum' : 'Kein Datum erkannt'}</p>`;
  } else if (task.dueDate) {
    dateLine = html`<p><strong>${formatDate(task.dueDate, { weekday: true })}${task.dueTime ? `, ${task.dueTime} Uhr` : ''}</strong> ${whenLabel(task.dueDate, today)}</p>`;
  } else dateLine = html`<p class="muted">Ohne Datum</p>`;

  const activeReminders = (task.reminders || []).filter((r) => r.status === 'geplant');
  return html`<article class="task-card ${isReview ? 'is-review' : ''} ${task.status === 'erledigt' ? 'is-done' : ''}" id="task-${task.id}" tabindex="-1">
    <div class="task-top">
      ${dateTile(shownDate, { today, unsure: isReview })}
      <div class="grow stack">
        <div class="row">${statusBadge(task.status)}<span class="badge">${taskKindLabel(task.kind)}</span></div>
        <h3 class="task-title">${task.title}</h3>
        ${dateLine}
      </div>
    </div>
    ${task.description ? html`<p class="task-desc">${task.description}</p>` : ''}
    ${task.sourceQuote ? html`<div class="stack">
      <div><p class="quote-label">Im Brief steht${task.sourcePage ? ` (Seite ${task.sourcePage})` : ''}:</p>
      <blockquote class="quote">${task.sourceQuote}</blockquote></div>
      <p><button class="btn btn-ghost btn-small" type="button" data-action="show-quote" data-id="${task.id}">${icon('eye')}Stelle im Brieftext zeigen</button></p>
    </div>` : ''}
    ${task.checkNotes?.length && task.status !== 'erledigt' ? html`<ul class="task-notes">${task.checkNotes.map((n) => html`<li>${icon('alert')}<span>${n}</span></li>`)}</ul>` : ''}
    ${isReview || correcting ? confirmForm(task, letter, settings, today, { correcting }) : ''}
    ${task.status === 'offen' && !correcting ? html`
      <p class="reminder-line">${icon('bell')}${activeReminders.length
        ? `Erinnerung: ${activeReminders.map((r) => formatDateTime(r.remindAt)).join('; ')}`
        : 'Keine Erinnerung geplant'}</p>
      <div class="row">
        <button class="btn btn-small" type="button" data-action="done" data-id="${task.id}">${icon('check')}Erledigt</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="correct" data-id="${task.id}">${icon('edit')}Datum ändern</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="reminders" data-id="${task.id}">${icon('bell')}Erinnerungen</button>
        ${task.dueDate ? html`<button class="btn btn-small btn-ghost" type="button" data-action="ics" data-id="${task.id}">${icon('calendar')}In Kalender übernehmen</button>` : ''}
      </div>` : ''}
    ${task.status === 'erledigt' ? html`<div class="row"><button class="btn btn-small btn-secondary" type="button" data-action="reopen" data-id="${task.id}">Wieder öffnen</button></div>` : ''}
  </article>`;
}

function originalView(files) {
  if (!files.length) return html`<p class="muted">Keine Datei vorhanden.</p>`;
  const inlinePdf = navigator.pdfViewerEnabled === true;
  let page = 0;
  return files.map((f) => {
    const first = page + 1;
    page += f.pageCount || 1;
    const label = f.pageCount > 1 ? `Seiten ${first}–${page}` : `Seite ${first}`;
    if (f.kind === 'image') {
      return html`<figure class="original-page"><a href="/api/files/${f.id}" target="_blank" rel="noopener"><img src="/api/files/${f.id}" alt="Originalbrief, ${label}" loading="lazy"></a>
        <figcaption class="original-cap">${label} (Foto) – zum Vergrößern antippen</figcaption></figure>`;
    }
    return html`<figure class="original-page">
      ${inlinePdf ? html`<iframe src="/api/files/${f.id}" title="Originalbrief, ${label} (PDF)"></iframe>` : ''}
      <figcaption class="original-cap row"><span class="grow">${label} (PDF)</span>
        <a class="btn btn-small btn-secondary" href="/api/files/${f.id}" target="_blank" rel="noopener">${icon('file')}PDF öffnen</a></figcaption>
    </figure>`;
  });
}

function factsPanel(letter) {
  const dateStatus = {
    erkannt: html`<span class="badge badge-review">bitte prüfen</span>`,
    unsicher: html`<span class="badge badge-review">${icon('alert')}unsicher</span>`,
    fehlt: html`<span class="badge badge-review">${icon('alert')}fehlt</span>`,
    bestaetigt: html`<span class="badge badge-done">${icon('check')}bestätigt</span>`,
  }[letter.letterDateStatus];
  return html`<section class="panel stack" aria-labelledby="facts-h">
    <div class="section-title"><h2 id="facts-h">Erkannte Angaben</h2>
      <button class="btn btn-small btn-secondary" type="button" data-action="edit-facts">${icon('edit')}Korrigieren</button></div>
    <dl class="facts">
      <div><dt>Absender</dt><dd>${letter.sender || html`<span class="muted">nicht erkannt</span>`}</dd></div>
      <div><dt>Briefdatum</dt><dd>${letter.letterDate ? formatDate(letter.letterDate) : html`<span class="muted">unbekannt</span>`} ${dateStatus}
        ${letter.letterDateQuote && letter.letterDateStatus !== 'bestaetigt' ? html`<br><span class="small muted">Im Brief: „${letter.letterDateQuote}“</span>` : ''}</dd></div>
      <div><dt>Betreff</dt><dd>${letter.subject || html`<span class="muted">nicht erkannt</span>`}</dd></div>
      <div><dt>Kategorie</dt><dd>${categoryLabel(letter.category)}</dd></div>
      ${letter.references?.length ? html`<div><dt>Aktenzeichen und Nummern</dt><dd>${letter.references.map((r) => html`<div>${r.label}: ${r.value}</div>`)}</dd></div>` : ''}
      ${letter.amounts?.length ? html`<div><dt>Beträge</dt><dd>${letter.amounts.map((a) => html`<div>${a.label}: ${a.amount} ${a.currency === 'EUR' ? '€' : a.currency}</div>`)}</dd></div>` : ''}
      <div><dt>Brief erhalten am</dt><dd>${letter.receivedDate ? formatDate(letter.receivedDate) : html`<span class="muted">nicht angegeben</span>`}</dd></div>
      <div><dt>Hochgeladen am</dt><dd>${formatUploaded(letter.uploadedAt)}</dd></div>
    </dl>
  </section>`;
}

function explanation(data, settings, today, correcting) {
  const { letter, tasks } = data;
  const s = letter.summary || {};
  const sorted = [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const active = tasks.filter((t) => t.status !== 'erledigt');
  const toCheck = [...(s.toCheck || [])];
  if (letter.letterDateStatus === 'erkannt' && !letter.reviewed) toCheck.push('Stimmt das erkannte Briefdatum?');
  return html`<div class="explain">
    <section class="explain-step"><span class="step-num" aria-hidden="true">1</span><div>
      <h2>Worum geht es?</h2>
      <div class="explain-body stack">
        <p>${s.what || 'Für diesen Brief gibt es keine automatische Erklärung. Bitte lesen Sie das Original.'}</p>
        ${s.legalNote ? html`<div class="note note-warn">${icon('alert')}<div><strong>Wichtig</strong><p>${s.legalNote}</p></div></div>` : ''}
      </div></div></section>

    <section class="explain-step"><span class="step-num" aria-hidden="true">2</span><div>
      <h2>Was muss ich tun?</h2>
      ${active.length ? html`<ul class="todo-list">${active.map((t) => html`<li>${icon(t.status === 'zu_pruefen' ? 'alert' : 'circle')}<span>${t.title}${t.status === 'zu_pruefen' ? html` <span class="badge badge-review">zu prüfen</span>` : ''}</span></li>`)}</ul>`
        : s.nothingToDo ? html`<p class="explain-body">Nichts. Der Brief dient nur zu Ihrer Information.</p>`
          : tasks.length ? html`<p class="explain-body">Alles erledigt.</p>`
            : html`<p class="explain-body">Es wurden keine Aufgaben erkannt. Bitte lesen Sie den Brief selbst und legen Sie bei Bedarf eine Aufgabe an.</p>`}
      <p><button class="btn btn-small btn-ghost" type="button" data-action="add-task">${icon('plus')}Eigene Aufgabe hinzufügen</button></p>
    </div></section>

    <section class="explain-step"><span class="step-num" aria-hidden="true">3</span><div>
      <h2>Bis wann?</h2>
      ${tasks.some((t) => t.status === 'zu_pruefen') ? html`<p class="muted">Prüfen Sie jedes Datum mit dem Original. Erst nach Ihrer Bestätigung plant BriefPilot Erinnerungen.</p>` : ''}
      ${sorted.length ? html`<div class="stack">${sorted.map((t) => taskCard(t, letter, settings, today, correcting.has(t.id)))}</div>`
        : html`<p class="explain-body">Keine Fristen oder Termine erkannt.</p>`}
    </div></section>

    <section class="explain-step"><span class="step-num" aria-hidden="true">4</span><div>
      <h2>Was muss ich noch prüfen?</h2>
      ${toCheck.length ? html`<ul class="check-list">${toCheck.map((c) => html`<li>${icon('alert')}<span>${c}</span></li>`)}</ul>` : html`<p class="explain-body">Keine offenen Punkte.</p>`}
      ${!letter.reviewed && letter.analysisStatus !== 'wartet' && letter.analysisStatus !== 'laeuft' ? html`<p><button class="btn btn-secondary" type="button" data-action="review">${icon('check')}Angaben stimmen</button></p>` : ''}
    </div></section>
  </div>`;
}

export async function render({ root, params, query, state, navigate, isCurrent }) {
  const id = params.id;
  let data = null;
  let tab = 'erklaerung';
  let pollTimer = null;
  const correcting = new Set();
  const today = todayIn(state.me?.timezone || 'Europe/Berlin');
  const settings = state.me?.settings || { reminderOffsets: ['7d', '1d'] };
  let scrolledToTask = false;

  async function load() {
    data = await api.get(`/api/letters/${id}`);
    if (!isCurrent()) return;
    draw();
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

  function draw() {
    const { letter, files, tasks } = data;
    const analyzing = ['wartet', 'laeuft'].includes(letter.analysisStatus);
    const sourceLabel = ANALYSIS_SOURCE_LABELS[letter.analysisSource];
    mount(root, html`<div class="stack-l">
      <p><a class="btn btn-ghost btn-small" href="#/briefe">${icon('chevronLeft')}Alle Briefe</a></p>
      <header class="letter-head">
        ${categoryTile(letter.category)}
        <div class="grow">
          <h1>${letter.subject || (analyzing ? 'Neuer Brief' : 'Brief ohne Betreff')}</h1>
          <div class="letter-meta">
            <span>${letter.sender || 'Absender unbekannt'}</span>
            <span>${letter.letterDate ? `Brief vom ${formatDate(letter.letterDate)}` : 'Briefdatum unbekannt'}</span>
          </div>
          <div class="row-meta">
            ${sourceLabel ? html`<span class="badge ${letter.analysisSource === 'beispiel' ? 'badge-demo' : ''}">${icon(letter.analysisSource === 'ki' ? 'spark' : 'info')}${sourceLabel}</span>` : ''}
            ${letter.reviewed ? html`<span class="badge badge-done">${icon('check')}Angaben geprüft</span>` : ''}
          </div>
        </div>
      </header>

      ${analyzing ? html`<div class="note" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>Ihr Brief wird gelesen …</strong><p>Das dauert meist unter einer Minute. Sie können die Seite verlassen – die Auswertung läuft weiter.</p></div></div>` : ''}
      ${letter.analysisStatus === 'fehler' ? html`<div class="note note-danger" role="alert">${icon('alert')}<div class="stack"><div><strong>Die Auswertung hat nicht geklappt.</strong><p>${letter.analysisError}</p></div>
        <p><button class="btn btn-small" type="button" data-action="reanalyze">${icon('refresh')}Erneut auswerten</button></p></div></div>` : ''}
      ${letter.analysisStatus === 'nicht_moeglich' ? html`<div class="note note-warn" role="status">${icon('info')}<div class="stack"><div><strong>Der Brief ist gespeichert, aber nicht automatisch gelesen.</strong><p>${letter.analysisError}</p></div>
        <div class="row"><button class="btn btn-small" type="button" data-action="edit-facts">${icon('edit')}Angaben selbst eintragen</button>
        <button class="btn btn-small btn-secondary" type="button" data-action="add-task">${icon('plus')}Aufgabe anlegen</button></div></div></div>` : ''}
      ${letter.injectionWarning ? html`<div class="note note-danger" role="alert">${icon('shield')}<div><strong>Vorsicht bei diesem Schreiben</strong><p>Der Brief enthält Text, der sich wie eine Anweisung an eine KI oder ein Programm liest. BriefPilot hat diesen Text nicht befolgt und nichts automatisch erledigt.</p></div></div>` : ''}
      ${!letter.reviewed && letter.analysisStatus === 'fertig' ? html`<div class="note note-warn">${icon('eye')}<p><strong>Bitte prüfen Sie die Angaben mit dem Original.</strong> ${letter.analysisSource === 'ki' ? 'Die KI kann sich irren.' : 'Die automatische Erkennung kann sich irren.'}</p></div>` : ''}

      <div class="tabs" role="tablist" aria-label="Ansicht">
        <button class="tab" role="tab" type="button" data-tab="erklaerung" aria-selected="${tab === 'erklaerung'}">Erklärung</button>
        <button class="tab tab-original" role="tab" type="button" data-tab="original" aria-selected="${tab === 'original'}">Original</button>
        <button class="tab" role="tab" type="button" data-tab="text" aria-selected="${tab === 'text'}">Brieftext</button>
      </div>

      <div class="detail-grid">
        <div class="stack-l">
          <div data-panel="erklaerung" ${tab === 'erklaerung' ? '' : html`hidden`}>
            ${analyzing ? html`<p class="muted">Die Erklärung erscheint hier, sobald der Brief gelesen ist.</p>` : explanation(data, settings, today, correcting)}
          </div>
          <div data-panel="original" ${tab === 'original' ? '' : html`hidden`}>${originalView(files)}</div>
          <div data-panel="text" ${tab === 'text' ? '' : html`hidden`}>
            ${letter.fullText ? html`<p class="small muted">So hat BriefPilot den Text erkannt. Markiert sind die Stellen, aus denen Aufgaben und Fristen stammen.</p>
              <div class="fulltext">${highlightedText(letter.fullText, tasks)}</div>`
              : html`<p class="muted">Für diesen Brief liegt kein erkannter Text vor.</p>`}
          </div>
          ${tab === 'erklaerung' && !analyzing ? factsPanel(letter) : ''}
          ${tab === 'erklaerung' && !analyzing ? html`<section class="panel stack">
            <h2>Weitere Möglichkeiten</h2>
            <div class="row">
              ${letter.isDemoContent ? '' : html`<button class="btn btn-small btn-secondary" type="button" data-action="reanalyze">${icon('refresh')}Erneut auswerten</button>`}
              <button class="btn btn-small btn-danger" type="button" data-action="delete">${icon('trash')}Brief löschen</button>
            </div>
            <div class="note">${icon('star')}<div><strong>Antwort entwerfen – Pro-Vorschau</strong><p class="small">Später kann BriefPilot hier einen Antwortbrief vorschlagen, den Sie bearbeiten und als PDF herunterladen. Diese Funktion ist noch nicht verfügbar. <a href="#/pro">Mehr zur Pro-Vorschau</a></p></div></div>
          </section>` : ''}
        </div>
        <aside class="detail-original" aria-label="Originalbrief">
          <h2 class="visually-hidden">Original</h2>
          ${originalView(files)}
        </aside>
      </div>
    </div>`);

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
          mount(out, task.relativeRule ? '' : html`<p class="small muted">Die Frist konnte nicht automatisch berechnet werden. Bitte tragen Sie das Fristende selbst ein.</p>`);
          return;
        }
        const res = computeRelativeEnd(task.relativeRule, { receivedDate: input.value, letterDate: letter.letterDate });
        if (!res.date) {
          mount(out, '');
          return;
        }
        mount(out, html`<div class="computed"><p>Rechnerisches Fristende: <strong>${formatDate(res.date, { weekday: true })}</strong></p>
          <p class="small muted">Berechnet: ${formatDate(res.start)} plus ${periodLabel(task.relativeRule)}. Das ist ein Vorschlag, keine Rechtsauskunft.</p>
          ${isWeekend(res.date) ? html`<p class="small"><strong>Wochenende:</strong> Endet eine Frist an einem Samstag, Sonntag oder Feiertag, verschiebt sie sich oft auf den nächsten Werktag. Sicherer ist es, vorher zu handeln.</p>` : ''}</div>`);
        if (!manual) due.value = res.date;
      };
      input.addEventListener('input', update);
      update();
    });
  }

  async function reload() {
    await load();
    api.get('/api/overview').then((o) => setReviewCount(o.counts.tasksToReview)).catch(() => {});
  }

  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-confirm]');
    if (!form) return;
    e.preventDefault();
    clearErrors(form);
    const mode = e.submitter?.dataset.mode || 'date';
    const v = formValues(form);
    const body = { checked: v.checked === true, reminders: v.reminders || [] };
    const task = data.tasks.find((t) => t.id === form.dataset.confirm);
    if (mode === 'nodate' || (!v.dueDate && task?.kind === 'aufgabe' && !task.isRelative)) {
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
      } catch (err) {
        showError(form, err);
      }
    });
  });

  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      draw();
      root.querySelector(`[data-tab="${tab}"]`)?.focus();
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const taskId = el.dataset.id;
    const action = el.dataset.action;
    try {
      if (action === 'show-quote') {
        tab = 'text';
        draw();
        const mark = document.getElementById(`q-${taskId}`);
        if (mark) {
          mark.classList.add('is-target');
          mark.scrollIntoView({ block: 'center' });
        } else toast('Die Stelle wurde im erkannten Text nicht gefunden. Bitte im Original nachsehen.');
      } else if (action === 'done') {
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
      } else if (action === 'review') {
        await api.post(`/api/letters/${id}/review`);
        toast('Danke! Die Angaben sind als geprüft markiert.');
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
      <div class="field"><label for="f-subject">Betreff</label><input class="input" id="f-subject" name="subject" value="${l.subject || ''}" maxlength="300"></div>
      <div class="field-pair">
        <div class="field"><label for="f-date">Briefdatum</label><input class="input" type="date" id="f-date" name="letterDate" value="${l.letterDate || ''}"></div>
        <div class="field"><label for="f-recv">Erhalten am</label><input class="input" type="date" id="f-recv" name="receivedDate" max="${today}" value="${l.receivedDate || ''}"></div>
      </div>
      <div class="field"><label for="f-cat">Kategorie</label><select class="input" id="f-cat" name="category">
        ${CATEGORIES.map((c) => html`<option value="${c.id}" ${c.id === l.category ? 'selected' : ''}>${c.label}</option>`)}</select></div>
      <div class="field"><label for="f-refs">Aktenzeichen und Nummern</label>
        <textarea class="input" id="f-refs" name="references" rows="3">${(l.references || []).map((r) => `${r.label}: ${r.value}`).join('\n')}</textarea>
        <p class="hint">Eine Angabe pro Zeile, zum Beispiel „Kundennummer: 12345“.</p></div>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = formValues(form);
        const references = v.references.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const idx = line.indexOf(':');
          return idx > 0 ? { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() } : { label: 'Nummer', value: line };
        });
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.patch(`/api/letters/${id}`, {
              sender: v.sender, subject: v.subject, letterDate: v.letterDate || null, receivedDate: v.receivedDate || null,
              category: v.category, references,
            });
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
