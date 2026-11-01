// Briefliste mit Suche (auch nach Kennzeichen und Nummern der Akten), Kategorien, Filtern und Sortierung.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon } from '../ui.js';
import { CATEGORIES } from '../shared/constants.js';
import { letterRow, briefeTabs, objectTile } from './parts.js';

const FILTERS = [
  { id: 'datum_pruefen', label: 'Datum prüfen', ic: 'alert' },
  { id: 'zuordnung', label: 'Akte wählen', ic: 'inbox' },
  { id: 'ohne_akte', label: 'Ohne Akte', ic: 'folder' },
  { id: 'doppelt', label: 'Doppelt?', ic: 'copy' },
];

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

export async function render({ root, query, state, isCurrent }) {
  const filters = {
    q: query.get('q') || '',
    category: query.get('category') || '',
    filter: query.get('filter') || '',
    sort: query.get('sort') || 'brief',
    object: query.get('object') || '',
    tag: query.get('tag') || '',
  };
  let objectInfo = null;
  if (filters.object) {
    try {
      objectInfo = (await api.get(`/api/objects/${encodeURIComponent(filters.object)}`)).object;
    } catch {
      filters.object = '';
    }
  }

  mount(root, html`<div class="stack">
    <div class="page-head"><div><h1>Briefe</h1><p data-total></p></div>
      <a class="btn btn-small btn-secondary" href="#/scannen">${icon('plus')}Neu</a></div>
    <div data-tabs>${briefeTabs('briefe', { inbox: state.counts.inbox })}</div>
    ${objectInfo ? html`<div class="filter-note">${objectTile(objectInfo.type)}<span class="grow">Nur Briefe der Akte <a href="#/akten/${objectInfo.id}"><strong>${objectInfo.name}</strong></a></span>
      <button class="btn btn-small btn-ghost" type="button" data-clear-object>${icon('x')}Filter entfernen</button></div>` : ''}
    <div class="search-row">
      <form class="search-box grow" role="search" data-search>
        ${icon('search')}
        <label class="visually-hidden" for="q">Briefe durchsuchen</label>
        <input class="input" id="q" name="q" type="search" placeholder="Suchen …" value="${filters.q}" autocomplete="off">
      </form>
      <button class="btn btn-secondary filter-btn" type="button" data-filter-toggle aria-expanded="false" aria-controls="filter-menu" aria-label="Filter">${icon('filter')}<span class="filter-count" data-filter-count hidden></span></button>
    </div>
    <div class="filter-menu" id="filter-menu" data-filter-menu hidden>
      <details class="filter-group" ${filters.filter || filters.category ? html`open` : ''}>
        <summary>Filter${icon('chevronDown')}</summary>
        <div class="chips" role="group" aria-label="Filtern" data-filter-chips>
          <button type="button" class="chip" data-cat="" aria-pressed="${!filters.category && !filters.filter}">Alle</button>
          ${FILTERS.map((f) => html`<button type="button" class="chip" data-filter="${f.id}" aria-pressed="${filters.filter === f.id}">${icon(f.ic)}${f.label}</button>`)}
          ${CATEGORIES.map((c) => html`<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${filters.category === c.id}">${c.label}</button>`)}
        </div>
      </details>
      <details class="filter-group" data-tag-group ${filters.tag ? html`open` : ''}>
        <summary>Schlagworte${icon('chevronDown')}</summary>
        <div class="chips tag-chips" role="group" aria-label="Schlagworte" data-tag-chips></div>
      </details>
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
    if (filters.object) params.set('object', filters.object);
    if (filters.tag) params.set('tag', filters.tag);
    const data = await api.get(`/api/letters?${params}`);
    if (id !== requestId || !isCurrent()) return;
    root.querySelector('[data-total]').textContent = data.total === 1 ? '1 Brief gespeichert' : `${data.total} Briefe gespeichert`;
    const hash = `#/briefe${params.toString() ? `?${params}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (!data.letters.length) {
      const searching = filters.q || filters.category || filters.filter || filters.object || filters.tag;
      mount(results, html`<div class="empty">${icon(searching ? 'search' : 'mail')}
        <h2>${searching ? 'Nichts gefunden' : 'Noch keine Briefe'}</h2>
        <p>${searching ? 'Versuchen Sie einen anderen Suchbegriff, zum Beispiel einen Teil des Absenders oder ein Datum wie 12.10.2026.' : 'Fotografieren Sie Ihren ersten Brief oder laden Sie ein PDF hoch.'}</p>
        ${searching ? '' : html`<a class="btn btn-scan" href="#/scannen">${icon('camera')}Brief scannen</a>`}</div>`);
      return;
    }
    const groups = groupLetters(data.letters, filters.sort);
    mount(results, groups.map((g) => html`<section>
      <h2 class="month-head ${g.warn ? 'warn' : ''}">${g.label}</h2>
      <div class="panel panel-plain"><ul class="list">${g.items.map((l) => letterRow(l))}</ul></div></section>`));
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
  root.querySelector('[data-clear-object]')?.addEventListener('click', () => {
    filters.object = '';
    root.querySelector('.filter-note')?.remove();
    load();
  });
  // Filtermenü: nur ein Symbol, Inhalt erst auf Knopfdruck
  const menu = root.querySelector('[data-filter-menu]');
  const toggle = root.querySelector('[data-filter-toggle]');
  toggle.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
  function updateFilterCount() {
    const n = [filters.filter || filters.category, filters.tag].filter(Boolean).length;
    const badge = root.querySelector('[data-filter-count]');
    badge.hidden = !n;
    badge.textContent = String(n);
    toggle.classList.toggle('is-active', n > 0);
  }
  updateFilterCount();
  root.querySelector('[data-filter-chips]').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.filter !== undefined) {
      filters.filter = filters.filter === chip.dataset.filter ? '' : chip.dataset.filter;
      filters.category = '';
    } else {
      filters.category = chip.dataset.cat;
      filters.filter = '';
    }
    root.querySelectorAll('[data-filter-chips] .chip').forEach((c) => {
      const on = c.dataset.filter !== undefined ? filters.filter === c.dataset.filter : (c.dataset.cat === filters.category && !filters.filter && (c.dataset.cat !== '' || !filters.category));
      c.setAttribute('aria-pressed', String(on));
    });
    updateFilterCount();
    load();
  });
  // Schlagworte: antippen filtert, nochmal antippen hebt den Filter auf
  const tagBox = root.querySelector('[data-tag-chips]');
  async function loadTags() {
    try {
      const { tags } = await api.get('/api/tags');
      if (!isCurrent()) return;
      if (!tags.length) { tagBox.closest('[data-tag-group]').hidden = true; return; }
      mount(tagBox, tags.map((t) => html`<button type="button" class="chip chip-tag" data-tag="${t.tag}" aria-pressed="${filters.tag.toLowerCase() === t.tag.toLowerCase()}">#${t.tag}<span class="chip-count">${t.count}</span></button>`));
    } catch {
      tagBox.closest('[data-tag-group]').hidden = true;
    }
  }
  tagBox.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag]');
    if (!chip) return;
    filters.tag = filters.tag.toLowerCase() === chip.dataset.tag.toLowerCase() ? '' : chip.dataset.tag;
    tagBox.querySelectorAll('[data-tag]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.tag.toLowerCase() === filters.tag.toLowerCase())));
    updateFilterCount();
    load();
  });
  loadTags();
  await load();
  return () => clearTimeout(debounce);
}
