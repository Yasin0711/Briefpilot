// Ordnerauswahl wie in der Dateien-App von iOS („Bewegen“): oben Abbrechen · Titel · Zuordnen,
// darunter alle Ordner zum Antippen, unten rechts „Neuer Ordner“. Ein neu angelegter Ordner gilt
// sofort als Auswahl – der Vorgang ist damit beendet.
import { html, mount } from './html.js';
import { api } from './api.js';
import { icon, toast, openDialog } from './ui.js';
import { formatDate } from './shared/dates.js';

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

/**
 * Unterlagen als Bezug wählen – aufgebaut wie die Ordnerauswahl: erst alle Ordner, Antippen öffnet
 * den Ordner mit seinen Briefen. Kreise markieren einzelne Briefe oder (am Ordner) den ganzen Ordner.
 * Die Suche oben findet Ordnernamen und Brief-Betreffe.
 * @param {{ exclude?: string, objects: Map<string,string>, letters: Map<string,string> }} opts
 * @returns {Promise<{ objects: Map<string,string>, letters: Map<string,string> } | null>}
 */
export function refSheet({ exclude = '', objects: curObjects, letters: curLetters }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    Promise.all([
      api.get('/api/objects').then((d) => (d.objects || []).sort(byName)),
      api.get('/api/letters?limit=500').then((d) => (d.letters || []).filter((l) => l.id !== exclude)),
    ]).then(([folders, letters]) => {
      const selObjects = new Map(curObjects);
      const selLetters = new Map(curLetters);
      const title = (l) => l.subject || l.sender || 'Brief ohne Betreff';
      const inFolder = (id) => letters.filter((l) => (id ? (l.objects || []).some((o) => o.id === id) : !(l.objects || []).length));
      let open = undefined; // undefined = Ordnerliste, null = „Ohne Ordner“, sonst Ordner-ID
      let query = '';

      const circle = (on) => html`<span class="ref-circle ${on ? 'is-on' : ''}" aria-hidden="true">${icon('check')}</span>`;
      const letterRow = (l, withFolder = false) => html`<li><button class="move-row" type="button" data-ref-letter="${l.id}" aria-pressed="${selLetters.has(l.id)}">
          <span class="move-folder ref-doc" aria-hidden="true">${icon('file')}</span>
          <span class="grow"><span class="row-title">${title(l)}</span><span class="row-sub">${[l.sender, l.letterDate ? formatDate(l.letterDate, { short: true }) : null, withFolder ? (l.objects || []).map((o) => o.name).join(', ') : null].filter(Boolean).join(' · ')}</span></span>
          ${circle(selLetters.has(l.id))}</button></li>`;
      const folderRow = (f) => html`<li class="ref-folder-li">
          <button class="move-row" type="button" data-ref-open="${f.id}">
            <span class="move-folder" aria-hidden="true">${icon('folder')}</span>
            <span class="grow"><span class="row-title">${f.name}</span><span class="row-sub">${f.letterCount || 0} ${f.letterCount === 1 ? 'Brief' : 'Briefe'}</span></span>
            ${icon('chevronRight')}</button>
          <button class="ref-folder-pick" type="button" data-ref-folder="${f.id}" aria-pressed="${selObjects.has(f.id)}" aria-label="Ganzen Ordner ${f.name} als Bezug">${circle(selObjects.has(f.id))}</button></li>`;

      function body() {
        const q = query.trim().toLowerCase();
        if (q) {
          const fs = folders.filter((f) => f.name.toLowerCase().includes(q));
          const ls = letters.filter((l) => `${title(l)} ${l.sender || ''}`.toLowerCase().includes(q));
          return html`${fs.map(folderRow)}${ls.map((l) => letterRow(l, true))}${!fs.length && !ls.length ? html`<li class="move-empty muted">Nichts gefunden.</li>` : ''}`;
        }
        if (open === undefined) {
          const loose = inFolder(null);
          return html`${folders.map(folderRow)}
            ${loose.length ? html`<li><button class="move-row" type="button" data-ref-open="">
              <span class="move-folder is-muted" aria-hidden="true">${icon('folder')}</span>
              <span class="grow"><span class="row-title">Ohne Ordner</span><span class="row-sub">${loose.length} ${loose.length === 1 ? 'Brief' : 'Briefe'}</span></span>
              ${icon('chevronRight')}</button></li>` : ''}
            ${!folders.length && !loose.length ? html`<li class="move-empty muted">Keine weiteren Briefe.</li>` : ''}`;
        }
        const ls = inFolder(open);
        return html`${ls.length ? ls.map((l) => letterRow(l)) : html`<li class="move-empty muted">Keine Briefe in diesem Ordner.</li>`}`;
      }

      openDialog(html`<div class="move-sheet">
        <div class="move-top">
          <button class="move-link" type="button" data-cancel autofocus>Abbrechen</button>
          <strong class="move-title">Bezug</strong>
          <button class="move-link move-go" type="button" data-go>Übernehmen</button>
        </div>
        <input class="input move-search" type="search" placeholder="Ordner oder Betreff suchen" data-filter aria-label="Ordner oder Briefe suchen">
        <div class="ref-crumb" data-crumb hidden><button class="move-link" type="button" data-back>${icon('chevronLeft')}Ordner</button><strong data-crumb-name></strong></div>
        <ul class="move-list" data-list aria-label="Unterlagen"></ul>
      </div>`, (dialog, close) => {
        dialog.classList.add('sheet-full');
        dialog.addEventListener('close', () => finish(null));
        const list = dialog.querySelector('[data-list]');
        const crumb = dialog.querySelector('[data-crumb]');
        const go = dialog.querySelector('[data-go]');
        const draw = () => {
          mount(list, body());
          const inside = open !== undefined && !query.trim();
          crumb.hidden = !inside;
          if (inside) dialog.querySelector('[data-crumb-name]').textContent = open ? folders.find((f) => f.id === open)?.name || '' : 'Ohne Ordner';
          const n = selObjects.size + selLetters.size;
          go.textContent = n ? `Übernehmen (${n})` : 'Übernehmen';
        };
        draw();
        dialog.querySelector('[data-filter]').addEventListener('input', (ev) => {
          query = ev.target.value;
          draw();
        });
        dialog.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-cancel]')) return close();
          if (ev.target.closest('[data-go]')) {
            finish({ objects: selObjects, letters: selLetters });
            return close();
          }
          if (ev.target.closest('[data-back]')) {
            open = undefined;
            return draw();
          }
          const pickF = ev.target.closest('[data-ref-folder]');
          if (pickF) {
            const f = folders.find((x) => x.id === pickF.dataset.refFolder);
            if (selObjects.has(f.id)) selObjects.delete(f.id);
            else selObjects.set(f.id, f.name);
            return draw();
          }
          const openF = ev.target.closest('[data-ref-open]');
          if (openF) {
            open = openF.dataset.refOpen || null;
            query = '';
            dialog.querySelector('[data-filter]').value = '';
            list.scrollTop = 0;
            return draw();
          }
          const pickL = ev.target.closest('[data-ref-letter]');
          if (pickL) {
            const l = letters.find((x) => x.id === pickL.dataset.refLetter);
            if (selLetters.has(l.id)) selLetters.delete(l.id);
            else selLetters.set(l.id, title(l));
            draw();
          }
          return undefined;
        });
      });
    }).catch((err) => {
      toast(err.message, { error: true });
      finish(null);
    });
  });
}
