// Briefliste mit Suche, Kategorien und Sortierung nach Briefdatum.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon } from '../ui.js';
import { CATEGORIES } from '../shared/constants.js';
import { letterRow } from './overview.js';

function monthLabel(iso) {
  return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso.slice(0, 7) + '-15T12:00:00Z'));
}

function groupLetters(letters, sort) {
  const groups = [];
  let current = null;
  for (const l of letters) {
    let key;
    let label;
    let warn = false;
    if (sort === 'upload') {
      key = l.uploadedAt.slice(0, 7);
      label = `Hochgeladen im ${monthLabel(l.uploadedAt)}`;
    } else if (!l.letterDate) {
      key = 'ohne';
      label = 'Ohne Briefdatum – bitte prüfen';
      warn = true;
    } else {
      key = l.letterDate.slice(0, 7);
      label = monthLabel(l.letterDate);
    }
    if (!current || current.key !== key) {
      current = { key, label, warn, items: [] };
      groups.push(current);
    }
    current.items.push(l);
  }
  return groups;
}

export async function render({ root, query, isCurrent }) {
  const filters = {
    q: query.get('q') || '',
    category: query.get('category') || '',
    filter: query.get('filter') || '',
    sort: query.get('sort') || 'brief',
  };

  mount(root, html`<div class="stack">
    <div class="page-head"><div><h1>Briefe</h1><p data-total></p></div>
      <a class="btn btn-small btn-secondary" href="#/scannen">${icon('plus')}Neu</a></div>
    <form class="search-box" role="search" data-search>
      ${icon('search')}
      <label class="visually-hidden" for="q">Briefe durchsuchen</label>
      <input class="input" id="q" name="q" type="search" placeholder="Absender, Inhalt, Datum oder Aktenzeichen" value="${filters.q}" autocomplete="off">
    </form>
    <div class="chips chips-scroll" role="group" aria-label="Filtern">
      <button type="button" class="chip" data-cat="" aria-pressed="${!filters.category && !filters.filter}">Alle</button>
      <button type="button" class="chip" data-filter="datum_pruefen" aria-pressed="${filters.filter === 'datum_pruefen'}">${icon('alert')}Datum prüfen</button>
      ${CATEGORIES.map((c) => html`<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${filters.category === c.id}">${c.label}</button>`)}
    </div>
    <div class="row">
      <label for="sort" class="small muted">Sortieren nach</label>
      <select id="sort" class="input grow" data-sort>
        <option value="brief" ${filters.sort !== 'upload' ? 'selected' : ''}>Briefdatum (neueste zuerst)</option>
        <option value="upload" ${filters.sort === 'upload' ? 'selected' : ''}>Hochgeladen (neueste zuerst)</option>
      </select>
    </div>
    <div data-results aria-live="polite"><p class="muted">Wird geladen …</p></div>
  </div>`);

  const results = root.querySelector('[data-results]');
  let requestId = 0;

  async function load() {
    const id = ++requestId;
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.category) params.set('category', filters.category);
    if (filters.filter) params.set('filter', filters.filter);
    if (filters.sort === 'upload') params.set('sort', 'upload');
    const data = await api.get(`/api/letters?${params}`);
    if (id !== requestId || !isCurrent()) return;
    root.querySelector('[data-total]').textContent = data.total === 1 ? '1 Brief gespeichert' : `${data.total} Briefe gespeichert`;
    const hash = `#/briefe${params.toString() ? `?${params}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (!data.letters.length) {
      const searching = filters.q || filters.category || filters.filter;
      mount(results, html`<div class="empty">${icon(searching ? 'search' : 'mail')}
        <h2>${searching ? 'Nichts gefunden' : 'Noch keine Briefe'}</h2>
        <p>${searching ? 'Versuchen Sie einen anderen Suchbegriff, zum Beispiel einen Teil des Absenders oder ein Datum wie 12.10.2026.' : 'Fotografieren Sie Ihren ersten Brief oder laden Sie ein PDF hoch.'}</p>
        ${searching ? '' : html`<a class="btn btn-scan" href="#/scannen">${icon('camera')}Brief scannen</a>`}</div>`);
      return;
    }
    const groups = groupLetters(data.letters, filters.sort);
    mount(results, groups.map((g) => html`<section>
      <h2 class="month-head ${g.warn ? 'warn' : ''}">${g.label}</h2>
      <div class="panel panel-plain"><ul class="list">${g.items.map(letterRow)}</ul></div></section>`));
  }

  let debounce = null;
  const input = root.querySelector('#q');
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filters.q = input.value.trim();
      load();
    }, 300);
  });
  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    filters.q = input.value.trim();
    load();
  });
  root.querySelector('[data-sort]').addEventListener('change', (e) => {
    filters.sort = e.target.value;
    load();
  });
  root.querySelector('.chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.filter !== undefined) {
      filters.filter = filters.filter === chip.dataset.filter ? '' : chip.dataset.filter;
      filters.category = '';
    } else {
      filters.category = chip.dataset.cat;
      filters.filter = '';
    }
    root.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.filter !== undefined ? filters.filter === c.dataset.filter : (c.dataset.cat === filters.category && !filters.filter && (c.dataset.cat !== '' || !filters.category));
      c.setAttribute('aria-pressed', String(on));
    });
    load();
  });
  await load();
  return () => clearTimeout(debounce);
}
