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
        <p>${status === 'zu_pruefen' ? 'Diese Angaben hat BriefPilot erkannt. Bitte prüfen und bestätigen Sie sie im jeweiligen Brief.' : status === 'offen' ? 'Bestätigte Aufgaben, sortiert nach Datum.' : 'Erledigte Aufgaben.'}</p></div></div>
      <div class="tabs" role="tablist" aria-label="Status">
        ${TABS.map((t) => html`<button class="tab" role="tab" type="button" data-status="${t.id}" aria-selected="${t.id === status}">${t.label}${data.counts[t.id] ? ` (${data.counts[t.id]})` : ''}</button>`)}
      </div>
      ${data.tasks.length ? html`<div class="panel panel-plain"><ul class="list">${data.tasks.map((t) => {
        const date = t.status === 'zu_pruefen' ? (t.isRelative ? null : t.suggestedDate) : t.dueDate;
        const href = t.letterId ? `#/briefe/${t.letterId}?aufgabe=${t.id}` : null;
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

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-status]');
    try {
      if (tab) {
        status = tab.dataset.status;
        await load();
        root.querySelector(`[data-status="${status}"]`)?.focus();
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
