// Startseite: Erinnerungen, Briefe zum Zuordnen, offene Aufgaben, anstehende Fristen, zuletzt hinzugefügte Briefe.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, dateTile, whenLabel, greeting, taskKindLabel, toast, statusBadge } from '../ui.js';
import { formatDate } from '../shared/dates.js';
import { setReviewCount, setInboxCount } from '../app.js';
import { letterRow } from './parts.js';

export function taskRow(t, today) {
  const href = t.letterId ? `#/briefe/${t.letterId}?aufgabe=${t.id}` : '#/aufgaben';
  return html`<li><a class="deadline-row" href="${href}">
    ${dateTile(t.dueDate, { today, small: true })}
    <span class="grow">
      <span class="row-title">${t.title}</span>
      <span class="row-sub">${taskKindLabel(t.kind)}${t.dueTime ? `, ${t.dueTime} Uhr` : ''}${t.letterSender ? ` – ${t.letterSender}` : ''}</span>
      ${t.dueDate ? whenLabel(t.dueDate, today) : ''}
    </span>
    ${icon('chevronRight', 'chev')}</a></li>`;
}

export async function render({ root, state, isCurrent }) {
  let timer = null;
  let stopped = false;
  root.addEventListener('click', async (e) => {
    const seen = e.target.closest('[data-seen]');
    if (!seen) return;
    try {
      await api.post(`/api/reminders/${seen.dataset.seen}/seen`);
      seen.closest('.reminder-alert').remove();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  async function load() {
    const data = await api.get('/api/overview');
    if (stopped || !isCurrent()) return;
    draw(root, state, data);
    // Solange Briefe gelesen werden, öfter auffrischen; sonst jede Minute (für neue Erinnerungen)
    timer = setTimeout(() => load().catch(() => {}), data.counts.analyzing ? 4000 : 60000);
  }
  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function draw(root, state, data) {
  setReviewCount(data.counts.tasksToReview);
  setInboxCount(data.counts.inbox);
  const { counts, today } = data;
  const isEmpty = counts.letters === 0;
  const aiOff = !state.status?.ai?.enabled;

  mount(root, html`<div class="stack-l">
    <div class="hello">
      <h1>${greeting(state.me?.name)}</h1>
      <p class="muted">${formatDate(today, { weekday: true })}</p>
    </div>

    <div class="scan-cta">
      <a class="btn btn-scan btn-block" href="#/scannen">${icon('camera')}Brief scannen</a>
      <a class="btn btn-secondary btn-block" href="#/scannen?modus=datei">${icon('upload')}PDF oder Bild hochladen</a>
    </div>

    ${data.reminders.length ? html`<section class="stack" aria-label="Erinnerungen">
      ${data.reminders.map((r) => html`<div class="reminder-alert" role="alert">
        ${icon('bell')}
        <div class="grow"><div class="row-title">${r.title}</div>
          <div class="row-sub">Erinnerung: ${r.dueDate ? `${taskKindLabel(r.kind)} am ${formatDate(r.dueDate, { weekday: true })}${r.dueTime ? `, ${r.dueTime} Uhr` : ''}` : taskKindLabel(r.kind)}</div></div>
        <div class="row">
          ${r.letterId ? html`<a class="btn btn-small btn-secondary" href="#/briefe/${r.letterId}?aufgabe=${r.taskId}">Öffnen</a>` : ''}
          <button class="btn btn-small btn-secondary" data-seen="${r.id}">Gesehen</button>
        </div></div>`)}
    </section>` : ''}

    ${counts.inbox ? html`<a class="inbox-alert" href="#/zuordnen">
      <span class="alert-disc">${icon('inbox')}</span>
      <span class="grow"><span class="row-title">${counts.inbox === 1 ? '1 Brief wartet' : `${counts.inbox} Briefe warten`} auf Ihre Entscheidung</span>
        <span class="row-sub">BriefPilot hat mehrere mögliche Akten gefunden. Bitte wählen Sie die richtige aus.</span></span>
      ${icon('chevronRight', 'chev')}</a>` : ''}

    ${aiOff ? html`<div class="note">${icon('info')}<div><strong>KI-Auswertung ist auf diesem Server nicht eingerichtet.</strong>
      <p>PDFs mit Text werden mit einer einfachen Erkennung gelesen, Fotos nur gespeichert. <a href="#/status">Mehr dazu</a></p></div></div>` : ''}

    ${isEmpty ? html`<section class="panel stack">
      <h2>So funktioniert BriefPilot</h2>
      <ol class="welcome-steps">
        <li><span><strong>Brief fotografieren</strong> oder als PDF hochladen – auch mehrere Seiten.</span></li>
        <li><span><strong>Erklärung lesen:</strong> Worum geht es, was ist zu tun, bis wann?</span></li>
        <li><span><strong>Fristen bestätigen.</strong> Sie vergleichen jedes Datum mit dem Original. Erst dann erinnert BriefPilot Sie.</span></li>
        <li><span><strong>Später wiederfinden</strong> – über die Suche nach Absender, Datum, Aktenzeichen oder Inhalt.</span></li>
      </ol>
    </section>` : html`
    <div class="stat-row">
      <a class="stat ${counts.tasksToReview ? 'is-review' : ''}" href="#/aufgaben?status=zu_pruefen">
        <strong>${counts.tasksToReview}</strong><span>${counts.tasksToReview === 1 ? 'Angabe' : 'Angaben'} zu prüfen</span></a>
      <a class="stat" href="#/aufgaben?status=offen"><strong>${counts.open}</strong><span>offene Aufgaben${counts.overdue ? html`, <span class="when is-overdue">${counts.overdue} überfällig</span>` : ''}</span></a>
      <a class="stat" href="#/akten"><strong>${counts.objects}</strong><span>${counts.objects === 1 ? 'Akte' : 'Akten'}${counts.inbox ? html`, <span class="when is-soon">${counts.inbox} zuzuordnen</span>` : ''}</span></a>
      ${counts.duplicates
        ? html`<a class="stat is-review" href="#/briefe?filter=doppelt"><strong>${counts.duplicates}</strong><span>${counts.duplicates === 1 ? 'Brief' : 'Briefe'} vielleicht doppelt</span></a>`
        : html`<a class="stat" href="#/briefe"><strong>${counts.letters}</strong><span>${counts.letters === 1 ? 'Brief' : 'Briefe'} gespeichert</span></a>`}
    </div>`}

    ${counts.analyzing ? html`<div class="note">${html`<span class="spinner" aria-hidden="true"></span>`}<p>${counts.analyzing === 1 ? 'Ein Brief wird' : `${counts.analyzing} Briefe werden`} gerade gelesen. Das dauert meist unter einer Minute.</p></div>` : ''}

    ${!isEmpty ? html`<section>
      <div class="section-title"><h2>Anstehende Fristen und Termine</h2><a href="#/aufgaben">Alle</a></div>
      ${data.upcoming.length
        ? html`<div class="panel panel-plain"><ul class="list">${data.upcoming.map((t) => taskRow(t, today))}</ul></div>`
        : html`<p class="muted">Keine bestätigten Fristen. ${counts.tasksToReview ? 'Prüfen Sie die erkannten Angaben, damit BriefPilot Sie erinnern kann.' : ''}</p>`}
    </section>` : ''}

    ${data.openWithoutDate.length ? html`<section>
      <div class="section-title"><h2>Offene Aufgaben ohne Datum</h2></div>
      <div class="panel panel-plain"><ul class="list">${data.openWithoutDate.map((t) => html`<li><a class="list-row" href="${t.letterId ? `#/briefe/${t.letterId}?aufgabe=${t.id}` : '#/aufgaben'}">
        <span class="cat-tile">${icon('tasks')}</span><span class="grow"><span class="row-title">${t.title}</span>
        <span class="row-sub">${t.letterSender || ''}</span></span>${statusBadge(t.status)}</a></li>`)}</ul></div>
    </section>` : ''}

    ${data.recentLetters.length ? html`<section>
      <div class="section-title"><h2>Zuletzt hinzugefügt</h2><a href="#/briefe">Alle Briefe</a></div>
      <div class="panel panel-plain"><ul class="list">${data.recentLetters.map((l) => letterRow(l))}</ul></div>
    </section>` : ''}
  </div>`);

}

export { letterRow };
