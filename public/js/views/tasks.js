// Aufgaben und Termine: Zu prüfen, Offen, Erledigt.
import { html, mount } from '../html.js';
import { offerCalendarOnce, autoCalendarActive } from '../calendar.js';
import { api, download } from '../api.js';
import { icon, whenLabel, taskKindLabel, toast } from '../ui.js';
import { formatDate, needsReceivedDate } from '../shared/dates.js';
import { setReviewCount } from '../app.js';
import { letterThumb } from './parts.js';

const TABS = [
  { id: 'zu_pruefen', label: 'Zu prüfen' },
  { id: 'aufgaben', label: 'Aufgaben' },
  { id: 'termine', label: 'Termine' },
  { id: 'erledigt', label: 'Erledigt' },
];

/** Mini-Vorschau der ersten Seite – antippen öffnet den Brief im Vollbild. */
function thumb(t) {
  const f = t.letterFile;
  if (!f || !t.letterId) return html`<span class="task-thumb is-empty" aria-hidden="true">${icon('file')}</span>`;
  return html`<a class="task-thumb" href="/api/files/${f.id}" data-view-letter="${t.letterId}" data-title="${t.letterSubject || t.title}" aria-label="Brief ansehen: ${t.letterSubject || t.title}">
    ${letterThumb({ firstFile: f })}</a>`;
}

/** Zeile „Zu prüfen“: Vorschau · Titel (öffnet die Prüfung im Brief) · Datum als Text · Kalender · Bestätigen. */
function reviewRow(t, date, href) {
  const relative = needsReceivedDate(t);
  const dateText = relative ? (t.relativeText || 'Frist ab Zugang') : date ? formatDate(date, { short: true }) : 'ohne Datum';
  const pickLabel = relative ? 'Zugang' : 'Frist';
  const pickValue = relative ? '' : (date || '');
  return html`<li class="review-row" data-ctx="task" data-id="${t.id}" data-name="${t.title}">
    ${thumb(t)}
    <span class="grow review-main">
      ${href ? html`<a class="row-title" href="${href}">${t.title}</a>` : html`<span class="row-title">${t.title}</span>`}
      <span class="row-sub" data-sub="${t.id}">${dateText}${t.letterSender ? ` · ${t.letterSender}` : ''}</span>
    </span>
    <span class="review-actions">
      <label class="date-pick" title="${relative ? 'Zugangsdatum wählen – Fristende wird berechnet' : 'Datum ändern'}">
        ${icon('calendar')}<span>${pickLabel}</span>
        <input type="date" data-pick="${t.id}" data-relative="${relative ? '1' : ''}" value="${pickValue}" aria-label="${relative ? 'Zugangsdatum wählen' : 'Datum ändern'}: ${t.title}">
      </label>
      <button class="btn btn-small" type="button" data-confirm="${t.id}" data-date="${relative ? '' : (date || '')}" data-received="" data-relative="${relative ? '1' : ''}">${icon('check')}Bestätigen</button>
    </span>
  </li>`;
}

/** Zustelldatum (gelber Brief) als Vorschlag: bestätigen oder anderes Datum wählen. */
function deliveryRow(d) {
  return html`<li class="review-row">
    ${thumb({ letterId: d.letterId, letterFile: d.letterFile })}
    <span class="grow review-main">
      <a class="row-title" href="#/briefe/${d.letterId}">Zugestellt am ${formatDate(d.date, { short: true })}?</a>
      <span class="row-sub">${d.subject || 'Brief'}${d.sender ? ` · ${d.sender}` : ''}</span>
    </span>
    <span class="review-actions">
      <label class="date-pick" title="Anderes Datum">${icon('calendar')}<span>Datum</span>
        <input type="date" data-delivery-pick="${d.letterId}" value="${d.date}" aria-label="Zustelldatum ändern"></label>
      <button class="btn btn-small" type="button" data-delivery="${d.letterId}" data-date="${d.date}">${icon('check')}Bestätigen</button>
    </span>
  </li>`;
}

export async function render({ root, query, isCurrent }) {
  // Alte Links mit ?status=offen landen bei „Aufgaben“
  const asked = query.get('status') === 'offen' ? 'aufgaben' : query.get('status');
  let status = TABS.some((t) => t.id === asked) ? asked : null;

  async function load() {
    if (!status) {
      const probe = await api.get('/api/tasks?status=zu_pruefen');
      status = probe.counts.zu_pruefen ? 'zu_pruefen' : 'aufgaben';
    }
    const data = await api.get(`/api/tasks?status=${status}`);
    if (!isCurrent()) return;
    setReviewCount(data.counts.zu_pruefen || 0);
    history.replaceState(null, '', `#/aufgaben?status=${status}`);
    const { today } = data;
    const empty = {
      zu_pruefen: 'Nichts zu prüfen. Neue Vorschläge aus Ihren Briefen erscheinen hier.',
      aufgaben: 'Keine offenen Aufgaben.',
      termine: 'Keine Termine.',
      erledigt: 'Noch nichts erledigt.',
    }[status];

    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Aufgaben und Termine</h1>
        </div></div>
      <div class="tabs status-tabs" role="tablist" aria-label="Status">
        ${TABS.map((t) => html`<button class="tab" role="tab" type="button" data-status="${t.id}" aria-selected="${t.id === status}"><span class="tab-label">${t.label}</span><span class="tab-num">${data.counts[t.id] || 0}</span></button>`)}
      </div>
      ${data.tasks.length || data.deliveries?.length ? html`<div class="panel panel-plain"><ul class="list">${status === 'zu_pruefen' ? (data.deliveries || []).map(deliveryRow) : ''}${data.tasks.map((t) => {
        const date = t.status === 'zu_pruefen' ? (needsReceivedDate(t) ? null : t.suggestedDate) : t.dueDate;
        const href = t.letterId ? `#/briefe/${t.letterId}?aufgabe=${t.id}` : null;
        if (t.status === 'zu_pruefen') return reviewRow(t, date, href);
        return html`<li class="deadline-row" data-ctx="task" data-id="${t.id}" data-name="${t.title}">
          ${thumb(t)}
          <span class="grow">
            ${href ? html`<a class="row-title" href="${href}">${t.title}</a>` : html`<span class="row-title">${t.title}</span>`}
            <span class="row-sub">${taskKindLabel(t.kind)}${t.letterSender ? ` – ${t.letterSender}` : ''}</span>
            ${t.status === 'zu_pruefen'
              ? html`<span class="badge badge-review">${icon('alert')}${needsReceivedDate(t) ? 'Zugangsdatum fehlt' : date ? 'Datum bestätigen' : 'prüfen'}</span>`
              : t.status === 'offen'
                ? (t.dueDate ? html`${whenLabel(t.dueDate, today)}<span class="small muted"> – ${formatDate(t.dueDate, { weekday: true })}${t.dueTime ? `, ${t.dueTime} Uhr` : ''}</span>` : html`<span class="small muted">ohne Datum</span>`)
                : html`<span class="small muted">erledigt</span>`}
          </span>
          <span class="row">
            ${t.status === 'zu_pruefen' && href ? html`<a class="btn btn-small" href="${href}">Prüfen</a>` : ''}
            ${t.status === 'offen' ? html`<button class="btn btn-small btn-secondary" type="button" data-done="${t.id}" aria-label="${t.title} als erledigt markieren">${icon('check')}Erledigt</button>` : ''}
            ${t.status === 'offen' && t.dueDate && !autoCalendarActive() ? html`<button class="icon-btn" type="button" data-ics="${t.id}" aria-label="In Kalender übernehmen" title="In Kalender übernehmen (.ics)">${icon('calendar')}</button>` : ''}
            ${t.status === 'erledigt' ? html`<button class="btn btn-small btn-ghost" type="button" data-reopen="${t.id}">Wieder öffnen</button>` : ''}
          </span>
        </li>`;
      })}</ul></div>` : html`<div class="empty">${icon('tasks')}<p>${empty}</p></div>`}
    </div>`);
  }

  async function confirmDelivery(letterId, date) {
    await api.patch(`/api/letters/${letterId}`, { receivedDate: date });
    toast(`Zustellung: ${formatDate(date, { short: true })}`);
    await load();
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
    offerCalendarOnce(Boolean(d));
  }

  // Bild ohne Vorschau (z. B. PDF ohne Foto): Symbol statt leerem Bild
  root.addEventListener('error', (e) => {
    if (e.target.matches?.('[data-thumb]')) e.target.closest('.task-thumb')?.classList.add('is-empty');
  }, true);

  // Datum im Kalender gewählt: nur vormerken – bestätigt wird erst mit „Bestätigen“.
  // (Auf dem iPhone feuert die Datumsauswahl schon beim Drehen am Rad.)
  root.addEventListener('change', (e) => {
    const dp = e.target.closest('[data-delivery-pick]');
    if (dp?.value) {
      const btn = root.querySelector(`[data-delivery="${dp.dataset.deliveryPick}"]`);
      btn.dataset.date = dp.value;
      btn.closest('li').querySelector('.row-title').textContent = `Zugestellt am ${formatDate(dp.value, { short: true })}?`;
      btn.classList.add('is-ready');
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (!pick || !pick.value) return;
    const id = pick.dataset.pick;
    const btn = root.querySelector(`[data-confirm="${id}"]`);
    const sub = root.querySelector(`[data-sub="${id}"]`);
    const when = formatDate(pick.value, { short: true });
    if (pick.dataset.relative) {
      btn.dataset.received = pick.value;
      if (sub) sub.textContent = `Erhalten am ${when}`;
    } else {
      btn.dataset.date = pick.value;
      if (sub) sub.textContent = `Frist ${when}`;
    }
    pick.closest('.date-pick')?.classList.add('is-set');
    btn.classList.add('is-ready');
  });

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-status]');
    try {
      if (tab) {
        status = tab.dataset.status;
        await load();
        root.querySelector(`[data-status="${status}"]`)?.focus();
      } else if (e.target.closest('[data-delivery]')) {
        const btn = e.target.closest('[data-delivery]');
        await confirmDelivery(btn.dataset.delivery, btn.dataset.date);
      } else if (e.target.closest('[data-confirm]')) {
        const btn = e.target.closest('[data-confirm]');
        if (btn.dataset.relative && btn.dataset.received) {
          await confirmTask(btn.dataset.confirm, { receivedDate: btn.dataset.received });
          return;
        }
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
