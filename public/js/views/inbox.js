// „Zuordnen“: Briefe, bei denen BriefPilot nicht sicher ist, zu welchem Ordner sie gehören.
// Neutral formuliert – der Nutzer entscheidet, BriefPilot lernt daraus für künftige Briefe.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, categoryTile } from '../ui.js';
import { formatDate } from '../shared/dates.js';
import { briefeTabs } from './parts.js';
import { mountDecision } from './assign.js';
import { setInboxCount } from '../app.js';
import { hydratePagers } from '../pdfview.js';

export async function render({ root, isCurrent }) {
  async function load() {
    const data = await api.get('/api/inbox');
    if (!isCurrent()) return;
    const letters = data.letters;
    setInboxCount(letters.length);
    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Briefe zuordnen</h1>
        <p>Briefe mit unklarem Ordner.</p></div></div>
      ${briefeTabs('zuordnen', { inbox: letters.length })}
      ${letters.length ? html`<div class="stack-l">${letters.map((l) => html`<article class="panel stack decision-card" data-letter="${l.id}" aria-labelledby="t-${l.id}">
          <div class="letter-head">
            ${categoryTile(l.category)}
            <div class="grow">
              <h2 id="t-${l.id}"><a class="title-link" href="#/briefe/${l.id}">${l.subject || 'Brief ohne Betreff'}</a></h2>
              <div class="letter-meta"><span>${l.sender || 'Absender unbekannt'}</span>
                <span>${l.letterDate ? `Brief vom ${formatDate(l.letterDate)}` : 'Briefdatum unbekannt'}</span></div>
              <div class="pager inbox-pager" data-pager data-letter="${l.id}">
                <div class="pager-stage" data-pager-stage title="Antippen zum Vergrößern"><span class="spinner" aria-hidden="true"></span></div>
                <div class="pager-bar">
                  <button class="icon-btn icon-btn-small" type="button" data-pager-prev aria-label="Vorherige Seite">${icon('chevronLeft')}</button>
                  <span class="pager-label small muted" data-pager-label></span>
                  <button class="icon-btn icon-btn-small" type="button" data-pager-next aria-label="Nächste Seite">${icon('chevronRight')}</button>
                </div>
              </div>
            </div>
          </div>
          <div data-decision></div>
        </article>`)}</div>`
        : html`<div class="empty">${icon('checkCircle')}<h2>Alles zugeordnet</h2>
          <p>Nichts zu entscheiden.</p>
          <a class="btn btn-secondary" href="#/akten">${icon('folder')}Ordner ansehen</a></div>`}
    </div>`);
    hydratePagers(root);
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
