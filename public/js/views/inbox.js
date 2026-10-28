// „Zuordnen“: Briefe, bei denen BriefPilot nicht sicher ist, zu welcher Akte sie gehören.
// Neutral formuliert – der Nutzer entscheidet, BriefPilot lernt daraus für künftige Briefe.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, categoryTile } from '../ui.js';
import { formatDate } from '../shared/dates.js';
import { briefeTabs } from './parts.js';
import { mountDecision } from './assign.js';
import { setInboxCount } from '../app.js';

export async function render({ root, isCurrent }) {
  async function load() {
    const data = await api.get('/api/inbox');
    if (!isCurrent()) return;
    const letters = data.letters;
    setInboxCount(letters.length);
    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Briefe zuordnen</h1>
        <p>Hier landen Briefe, bei denen BriefPilot nicht sicher ist, zu welcher Akte sie gehören. Ihre Entscheidung hilft auch bei künftigen Briefen.</p></div></div>
      ${briefeTabs('zuordnen', { inbox: letters.length })}
      ${letters.length ? html`<div class="stack-l">${letters.map((l) => html`<article class="panel stack decision-card" data-letter="${l.id}" aria-labelledby="t-${l.id}">
          <div class="letter-head">
            ${categoryTile(l.category)}
            <div class="grow">
              <h2 id="t-${l.id}">${l.subject || 'Brief ohne Betreff'}</h2>
              <div class="letter-meta"><span>${l.sender || 'Absender unbekannt'}</span>
                <span>${l.letterDate ? `Brief vom ${formatDate(l.letterDate)}` : 'Briefdatum unbekannt'}</span></div>
              <p><a class="btn btn-small btn-ghost" href="#/briefe/${l.id}">${icon('eye')}Brief ansehen</a></p>
            </div>
          </div>
          <div data-decision></div>
        </article>`)}</div>`
        : html`<div class="empty">${icon('checkCircle')}<h2>Alles zugeordnet</h2>
          <p>Zurzeit wartet kein Brief auf Ihre Entscheidung. Neue Briefe ordnet BriefPilot anhand der Nummern in Ihren Akten selbst zu.</p>
          <a class="btn btn-secondary" href="#/akten">${icon('folder')}Akten ansehen</a></div>`}
    </div>`);
    for (const l of letters) {
      const card = root.querySelector(`[data-letter="${l.id}"]`);
      mountDecision(card.querySelector('[data-decision]'), {
        letter: l,
        assignment: l.assignment,
        onDone: () => {
          // Erledigte Karte ausblenden, Liste neu laden (andere Briefe können mit zugeordnet worden sein)
          card.classList.add('is-done');
          load()
            .then(() => root.querySelector('.decision-card [data-choice], .decision-card [data-load-objects], .empty a')?.focus())
            .catch(() => {});
        },
      });
    }
  }
  await load();
}
