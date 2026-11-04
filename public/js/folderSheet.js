// Ordnerauswahl wie in der Dateien-App von iOS („Bewegen“): oben Abbrechen · Titel · Zuordnen,
// darunter alle Ordner zum Antippen, unten rechts „Neuer Ordner“. Ein neu angelegter Ordner gilt
// sofort als Auswahl – der Vorgang ist damit beendet.
import { html, mount } from './html.js';
import { api } from './api.js';
import { icon, toast, openDialog } from './ui.js';

const byName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });

/**
 * @param {{ title?: string, action?: string, item?: string, current?: string[] }} opts
 * @returns {Promise<{ id: string, name: string, created: boolean } | null>}
 */
export function moveSheet({ title = 'Ordner wählen', action = 'Zuordnen', item = '', current = [] } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    api.get('/api/objects').then(({ objects }) => {
      const list = objects.filter((o) => o.status !== 'beendet').sort(byName);
      const now = new Set(current);
      let chosen = null;
      openDialog(html`<div class="move-sheet">
        <div class="move-top">
          <button class="move-link" type="button" data-cancel autofocus>Abbrechen</button>
          <strong class="move-title">${title}</strong>
          <button class="move-link move-go" type="button" data-go disabled>${action}</button>
        </div>
        ${item ? html`<p class="move-item">${icon('file')}<span>${item}</span></p>` : ''}
        <input class="input move-search" type="search" placeholder="Suchen" data-filter aria-label="Ordner suchen">
        <ul class="move-list" role="listbox" aria-label="Ordner">
          ${list.length ? list.map((o) => html`<li data-item="${o.name.toLowerCase()}">
            <button class="move-row" type="button" role="option" aria-selected="false" data-pick="${o.id}">
              <span class="move-folder" aria-hidden="true">${icon('folder')}</span>
              <span class="grow"><span class="row-title">${o.name}</span><span class="row-sub">${o.letterCount || 0} ${o.letterCount === 1 ? 'Brief' : 'Briefe'}${now.has(o.id) ? ' · hier abgelegt' : ''}</span></span>
              <span class="move-check" aria-hidden="true">${icon('check')}</span>
            </button></li>`) : html`<li class="move-empty muted">Noch keine Ordner.</li>`}
        </ul>
        <button class="move-new" type="button" data-new aria-label="Neuer Ordner" title="Neuer Ordner">${icon('folderAdd')}</button>
      </div>`, (dialog, close) => {
        dialog.classList.add('sheet-full');
        dialog.addEventListener('close', () => finish(null));
        const go = dialog.querySelector('[data-go]');
        dialog.querySelector('[data-filter]').addEventListener('input', (ev) => {
          const q = ev.target.value.trim().toLowerCase();
          dialog.querySelectorAll('[data-item]').forEach((li) => {
            li.hidden = Boolean(q) && !li.dataset.item.includes(q);
          });
        });
        dialog.addEventListener('click', async (ev) => {
          if (ev.target.closest('[data-cancel]')) {
            close();
            return;
          }
          const pick = ev.target.closest('[data-pick]');
          if (pick) {
            chosen = list.find((o) => o.id === pick.dataset.pick);
            dialog.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-selected', String(b === pick)));
            go.disabled = false;
            return;
          }
          if (ev.target.closest('[data-go]') && chosen) {
            finish({ id: chosen.id, name: chosen.name, created: false });
            close();
            return;
          }
          if (ev.target.closest('[data-new]')) {
            const made = await newFolderSheet();
            if (made) {
              finish({ ...made, created: true });
              close();
            }
          }
        });
      });
    }).catch((err) => {
      toast(err.message, { error: true });
      finish(null);
    });
  });
}

/** Zweites Fenster: Namen für einen neuen Ordner eingeben. */
function newFolderSheet() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openDialog(html`<form class="move-sheet" novalidate>
      <div class="move-top">
        <button class="move-link" type="button" data-cancel>Abbrechen</button>
        <strong class="move-title">Neuer Ordner</strong>
        <button class="move-link move-go" type="submit" disabled>Fertig</button>
      </div>
      <div class="new-folder-body">
        <span class="new-folder-icon" aria-hidden="true">${icon('folder')}</span>
        <label class="visually-hidden" for="nf-sheet-name">Name des Ordners</label>
        <input class="input new-folder-name" id="nf-sheet-name" autofocus name="name" maxlength="120" placeholder="Name" autocomplete="off" enterkeyhint="done">
      </div>
    </form>`, (dialog, close) => {
      dialog.classList.add('sheet-full');
      dialog.addEventListener('close', () => finish(null));
      const form = dialog.querySelector('form');
      const input = form.name;
      const done = form.querySelector('[type=submit]');
      input.addEventListener('input', () => {
        done.disabled = !input.value.trim();
      });
      form.querySelector('[data-cancel]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        done.disabled = true;
        try {
          const res = await api.post('/api/objects', { type: 'sonstiges', name, identifiers: [] });
          finish({ id: res.object.id, name: res.object.name });
          close();
        } catch (err) {
          done.disabled = false;
          toast(err.message, { error: true });
        }
      });
    });
  });
}

/** Kurze Bestätigung: Brief fliegt in den Ordner, darunter der Ordnername. */
export function filedAnimation(name) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'filed-anim';
    el.setAttribute('role', 'status');
    mount(el, html`<div class="filed-card">
      <span class="filed-stage" aria-hidden="true"><span class="filed-doc">${icon('file')}</span><span class="filed-folder">${icon('folder')}</span></span>
      <strong>Abgelegt</strong><span class="filed-name">${name}</span>
    </div>`);
    document.body.append(el);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => {
        el.remove();
        resolve();
      }, 250);
    }, reduce ? 900 : 1300);
  });
}

/** Brief einem Ordner zuordnen (ersetzt bisherige Ordner) und mit Animation bestätigen. */
export async function fileLetterInto(letterId, target) {
  const res = await api.put(`/api/letters/${letterId}/links`, { objectIds: [target.id] });
  await filedAnimation(target.name);
  return res;
}
