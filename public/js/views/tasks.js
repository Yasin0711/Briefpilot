// Aufgaben und Termine: Zu prüfen, Offen, Erledigt.
import { html, mount } from '../html.js';
import { api, download } from '../api.js';
import { icon, dateTile, whenLabel, taskKindLabel, toast } from '../ui.js';
import { formatDate } from '../shared/dates.js';
import { setReviewCount } from '../app.js';

const TABS = [
  { id: 'zu_pruefen', label: 'Zu prüfen' },
  { id: 'offen', label: 'Offen' },
  { id: 'erledigt', label: 'Erledigt' },
];

/** Mini-Vorschau der ersten Seite – antippen öffnet die Datei. */
function thumb(t) {
  const f = t.letterFile;
  if (!f) return html`<span class="task-thumb is-empty" aria-hidden="true">${icon('file')}</span>`;
  const label = `Brief öffnen: ${t.letterSubject || t.title}`;
  if (f.kind === 'image' || f.kind === 'pdf') {
    return html`<a class="task-thumb" href="/api/files/${f.id}" target="_blank" rel="noopener" aria-label="${label}">
      <img src="/api/files/${f.id}/thumb" alt="" loading="lazy" data-thumb>${icon('file')}</a>`;
  }
  return html`<a class="task-thumb is-empty" href="/api/files/${f.id}" aria-label="${label}">${icon('file')}</a>`;
}

/** Zeile „Zu prüfen“: Vorschau · Titel (öffnet die Prüfung im Brief) · Datum als Text · Kalender · Bestätigen. */
function reviewRow(t, date, href) {
  const relative = t.isRelative;
  const dateText = relative ? (t.relativeText || 'Frist ab Zugang') : date ? formatDate(date, { short: true }) : 'ohne Datum';
  const pickLabel = relative ? 'Zugang' : 'Frist';
  const pickValue = relative ? '' : (date || '');
  return html`<li class="review-row">
    ${thumb(t)}
    <span class="grow review-main">
      ${href ? html`<a class="row-title" href="${href}">${t.title}</a>` : html`<span class="row-title">${t.title}</span>`}
      <span class="row-sub">${dateText}${t.letterSender ? ` · ${t.letterSender}` : ''}</span>
    </span>
    <span class="review-actions">
      <label class="date-pick" title="${relative ? 'Zugangsdatum wählen – Fristende wird berechnet' : 'Datum ändern'}">
        ${icon('calendar')}<span>${pickLabel}</span>
        <input type="date" data-pick="${t.id}" data-relative="${relative ? '1' : ''}" value="${pickValue}" aria-label="${relative ? 'Zugangsdatum wählen' : 'Datum ändern'}: ${t.title}">
      </label>
      <button class="btn btn-small" type="button" data-confirm="${t.id}" data-date="${relative ? '' : (date || '')}" data-relative="${relative ? '1' : ''}">${icon('check')}Bestätigen</button>
    </span>
  </li>`;
}

export async function render({ root, query, isCurrent }) {
  let status = TABS.some((t) => t.id === query.get('status')) ? query.get('status') : null;

  async function load() {
    if (!status) {
      const probe = await api.get('/api/tasks?status=zu_pruefen');
      status = probe.counts.zu_pruefen ? 'zu_pruefen' : 'offen';
    }
    const data = await api.get(`/api/tasks?status=${status}`);
    if (!isCurrent()) return;
    setReviewCount(data.counts.zu_pruefen || 0);
    history.replaceState(null, '', `#/aufgaben?status=${status}`);
    const { today } = data;
    const empty = {
      zu_pruefen: 'Nichts zu prüfen. Neue Vorschläge aus Ihren Briefen erscheinen hier.',
      offen: 'Keine offenen Aufgaben. Bestätigte Fristen und Termine erscheinen hier.',
      erledigt: 'Noch nichts erledigt.',
    }[status];

    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Aufgaben und Termine</h1>
        </div></div>
      <div class="tabs" role="tablist" aria-label="Status">
        ${TABS.map((t) => html`<button class="tab" role="tab" type="button" data-status="${t.id}" aria-selected="${t.id === status}">${t.label}${data.counts[t.id] ? ` (${data.counts[t.id]})` : ''}</button>`)}
      </div>
      ${data.tasks.length ? html`<div class="panel panel-plain"><ul class="list">${data.tasks.map((t) => {
        const date = t.status === 'zu_pruefen' ? (t.isRelative ? null : t.suggestedDate) : t.dueDate;
        const href = t.letterId ? `#/briefe/${t.letterId}?aufgabe=${t.id}` : null;
        if (t.status === 'zu_pruefen') return reviewRow(t, date, href);
        return html`<li class="deadline-row">
          ${dateTile(date, { today, small: true, unsure: t.status === 'zu_pruefen' })}
          <span class="grow">
            ${href ? html`<a class="row-title" href="${href}">${t.title}</a>` : html`<span class="row-title">${t.title}</span>`}
            <span class="row-sub">${taskKindLabel(t.kind)}${t.letterSender ? ` – ${t.letterSender}` : ''}</span>
            ${t.status === 'zu_pruefen'
              ? html`<span class="badge badge-review">${icon('alert')}${t.isRelative ? 'Zugangsdatum fehlt' : date ? 'Datum bestätigen' : 'prüfen'}</span>`
              : t.status === 'offen'
                ? (t.dueDate ? html`${whenLabel(t.dueDate, today)}<span class="small muted"> – ${formatDate(t.dueDate, { weekday: true })}${t.dueTime ? `, ${t.dueTime} Uhr` : ''}</span>` : html`<span class="small muted">ohne Datum</span>`)
                : html`<span class="small muted">erledigt</span>`}
          </span>
          <span class="row">
            ${t.status === 'zu_pruefen' && href ? html`<a class="btn btn-small" href="${href}">Prüfen</a>` : ''}
            ${t.status === 'offen' ? html`<button class="btn btn-small btn-secondary" type="button" data-done="${t.id}" aria-label="${t.title} als erledigt markieren">${icon('check')}Erledigt</button>` : ''}
            ${t.status === 'offen' && t.dueDate ? html`<button class="icon-btn" type="button" data-ics="${t.id}" aria-label="In Kalender übernehmen" title="In Kalender übernehmen (.ics)">${icon('calendar')}</button>` : ''}
            ${t.status === 'erledigt' ? html`<button class="btn btn-small btn-ghost" type="button" data-reopen="${t.id}">Wieder öffnen</button>` : ''}
          </span>
        </li>`;
      })}</ul></div>` : html`<div class="empty">${icon('tasks')}<p>${empty}</p></div>`}
    </div>`);
  }

  async function confirmTask(taskId, { dueDate = null, receivedDate = null } = {}) {
    const body = { checked: true };
    if (receivedDate) body.receivedDate = receivedDate;
    else if (dueDate) body.dueDate = dueDate;
    else body.withoutDate = true;
    const res = await api.post(`/api/tasks/${taskId}/confirm`, body);
    const d = res.task?.dueDate;
    toast(d ? `Bestätigt: ${formatDate(d, { short: true })}` : 'Bestätigt.');
    await load();
  }

  // Bild ohne Vorschau (z. B. PDF ohne Foto): Symbol statt leerem Bild
  root.addEventListener('error', (e) => {
    if (e.target.matches?.('[data-thumb]')) e.target.closest('.task-thumb')?.classList.add('is-empty');
  }, true);

  // Datum im Kalender gewählt: gleich bestätigen (Frist bzw. Zugangsdatum → Fristende wird berechnet)
  root.addEventListener('change', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick || !pick.value) return;
    try {
      await confirmTask(pick.dataset.pick, pick.dataset.relative ? { receivedDate: pick.value } : { dueDate: pick.value });
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-status]');
    try {
      if (tab) {
        status = tab.dataset.status;
        await load();
        root.querySelector(`[data-status="${status}"]`)?.focus();
      } else if (e.target.closest('[data-confirm]')) {
        const btn = e.target.closest('[data-confirm]');
        if (btn.dataset.relative) {
          // Frist ab Zugang: ohne Zugangsdatum geht es nicht – Kalender öffnen
          const input = root.querySelector(`[data-pick="${btn.dataset.confirm}"]`);
          if (input?.showPicker) input.showPicker(); else input?.focus();
          toast('Bitte wählen Sie, wann der Brief angekommen ist.');
          return;
        }
        await confirmTask(btn.dataset.confirm, { dueDate: btn.dataset.date || null });
      } else if (e.target.closest('[data-done]')) {
        await api.post(`/api/tasks/${e.target.closest('[data-done]').dataset.done}/done`);
        toast('Als erledigt markiert.');
        await load();
      } else if (e.target.closest('[data-reopen]')) {
        await api.post(`/api/tasks/${e.target.closest('[data-reopen]').dataset.reopen}/reopen`);
        await load();
      } else if (e.target.closest('[data-ics]')) {
        await download(`/api/tasks/${e.target.closest('[data-ics]').dataset.ics}/ics`, 'termin.ics');
        toast('Kalenderdatei heruntergeladen.');
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  await load();
}
