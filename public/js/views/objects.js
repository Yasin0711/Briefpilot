// Ordner: Liste und Detailansicht mit Briefen und Aufgaben (Verwaltung unten).
import { html, mount, trusted } from '../html.js';
import { api } from '../api.js';
import { icon, toast, confirmDialog, openDialog, showError, clearErrors, busy } from '../ui.js';
import { OBJECT_TYPES, objectType, CASE_KINDS } from '../shared/constants.js';
import { IDENTIFIER_KINDS, identifierKindLabel } from '../shared/identifiers.js';
import { formatDate, todayIn } from '../shared/dates.js';
import { briefeTabs, objectTile, letterRow, evidenceText } from './parts.js';
import { openObjectDialog } from './objectDialog.js';
import { forgetObjects } from './assign.js';
import { taskRow } from './overview.js';
import { setInboxCount, backButton, setNavTitle } from '../app.js';

function idSummary(identifiers = []) {
  const current = identifiers.filter((i) => i.status !== 'alt').slice(0, 3);
  return current.map((i) => i.value).join(' · ');
}

// ---------- Liste (wie „Dateien“: Ordner und Ordner als Kacheln) ----------

const SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'neu', label: 'Neueste Briefe' },
  { id: 'anzahl', label: 'Anzahl Briefe' },
];
const SORT_KEY = 'bp-akten-sort';

/** Ordner-Symbol wie in „Dateien“. */
function folderSvg() {
  return trusted(`<svg class="files-icon" viewBox="0 0 64 50" aria-hidden="true"><path class="back" d="M4 7a4 4 0 0 1 4-4h15.5a4 4 0 0 1 3 1.3L31 9h25a4 4 0 0 1 4 4v29a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path class="front" d="M4 17a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/></svg>`);
}

function sortObjects(list, sort) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
  const copy = [...list];
  if (sort === 'neu') return copy.sort((a, b) => String(b.lastLetterDate || '').localeCompare(String(a.lastLetterDate || '')) || byName(a, b));
  if (sort === 'anzahl') return copy.sort((a, b) => (b.letterCount || 0) - (a.letterCount || 0) || byName(a, b));
  return copy.sort(byName);
}

export async function renderList({ root, query, navigate, isCurrent }) {
  let q = query.get('q') || '';
  let sort = 'name';
  try {
    sort = localStorage.getItem(SORT_KEY) || 'name';
  } catch {
    sort = 'name';
  }
  let requestId = 0;
  let data = null;

  mount(root, html`<div class="stack-l">
    <div class="page-head"><div><h1>Ordner</h1></div>
      <button class="btn btn-small" type="button" data-new>${icon('folderPlus')}Neuer Ordner</button></div>
    <div data-tabs>${briefeTabs('akten')}</div>
    <div class="search-row">
      <form class="search-box grow" role="search" data-search>
        ${icon('search')}
        <label class="visually-hidden" for="oq">Ordner durchsuchen</label>
        <input class="input" id="oq" name="q" type="search" placeholder="Suchen …" value="${q}" autocomplete="off">
      </form>
      <label class="visually-hidden" for="osort">Sortieren</label>
      <select class="input sort-select" id="osort" data-sort>${SORTS.map((o) => html`<option value="${o.id}" ${o.id === sort ? 'selected' : ''}>${o.label}</option>`)}</select>
    </div>
    <div data-results aria-live="polite"><p class="muted">Wird geladen …</p></div>
  </div>`);

  const results = root.querySelector('[data-results]');

  async function load() {
    const id = ++requestId;
    data = await api.get(`/api/objects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (id !== requestId || !isCurrent()) return;
    setInboxCount(data.inbox);
    mount(root.querySelector('[data-tabs]'), briefeTabs('akten', { inbox: data.inbox }));
    const hash = `#/akten${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
    draw();
  }

  function draw() {
    const active = data.objects.filter((o) => o.status !== 'beendet');
    const ended = data.objects.filter((o) => o.status === 'beendet');
    if (!data.objects.length) {
      mount(results, q
        ? html`<div class="empty">${icon('search')}<h2>Nichts gefunden</h2></div>`
        : html`<div class="empty">${icon('folder')}<h2>Noch keine Ordner</h2>
          <button class="btn" type="button" data-new>${icon('folderPlus')}Ersten Ordner anlegen</button></div>`);
      return;
    }
    const tile = (o, extra = '') => html`<li><a class="files-item ${extra}" href="#/akten/${o.id}" data-ctx="folder" data-id="${o.id}" data-name="${o.name}">
      ${folderSvg()}<span class="files-name">${o.name}</span>
      <span class="files-sub">${o.status === 'beendet' ? 'beendet' : html`${o.letterCount === 1 ? '1 Brief' : `${o.letterCount || 0} Briefe`}${o.openTasks ? html` · <span class="files-open">${o.openTasks} offen</span>` : ''}`}</span></a></li>`;
    mount(results, html`
      ${active.length ? html`<ul class="files-grid">${sortObjects(active, sort).map((o) => tile(o))}</ul>` : html`<p class="muted">Keine Ordner.</p>`}
      ${ended.length ? html`<details class="ended"><summary class="month-head">Beendete Ordner (${ended.length})</summary>
        <ul class="files-grid">${sortObjects(ended, sort).map((o) => tile(o, 'is-ended'))}</ul></details>` : ''}`);
  }

  let debounce = null;
  const input = root.querySelector('#oq');
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      q = input.value.trim();
      load().catch((err) => toast(err.message, { error: true }));
    }, 300);
  });
  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    q = input.value.trim();
    load().catch((err) => toast(err.message, { error: true }));
  });
  root.querySelector('[data-sort]').addEventListener('change', (e) => {
    sort = e.target.value;
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* nur für diese Ansicht */
    }
    draw();
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) {
      openObjectDialog({
        onSaved: (res) => {
          forgetObjects();
          navigate(`/akten/${res.object.id}`);
        },
      });
    }
  });
  // Kontextmenü (langes Drücken) hat Änderungen gemacht → neu laden
  root.addEventListener('bp:changed', () => load().catch(() => {}));
  await load();
  return () => clearTimeout(debounce);
}

// ---------- Detail ----------

const ORIGIN_LABEL = { auto: 'automatisch zugeordnet', nutzer: 'von Ihnen zugeordnet' };

export async function renderDetail({ root, params, state, navigate, isCurrent }) {
  const id = params.id;
  const today = todayIn(state.me?.timezone || 'Europe/Berlin');
  let data = null;

  async function load() {
    data = await api.get(`/api/objects/${id}`);
    if (!isCurrent()) return;
    setNavTitle(data.object.name);
    draw();
  }

  function draw() {
    const { object: o, letters, tasks, successor, predecessors } = data;
    const t = objectType(o.type);
    mount(root, html`<div class="stack-l">
      <p>${backButton('#/akten', 'Alle Ordner')}</p>
      <header class="letter-head">
        ${objectTile(o.type, { large: true })}
        <div class="grow">
          <h1>${o.name}</h1>
          <div class="letter-meta wrap-meta">
            <span>${t.label}${o.provider ? ` · ${o.provider}` : ''}</span>
            ${o.personName ? html`<span>${icon('user')} ${o.personName}</span>` : ''}
            ${o.addressLabel ? html`<span>${icon('mapPin')} ${o.addressLabel}</span>` : ''}
          </div>
          <div class="row-meta">
            ${o.status === 'beendet' ? html`<span class="badge">beendet${o.endedAt ? ` am ${formatDate(o.endedAt)}` : ''}</span>` : html`<span class="badge badge-done">${icon('check')}aktiv</span>`}
            <span class="badge">${o.letterCount === 1 ? '1 Brief' : `${o.letterCount || 0} Briefe`}</span>
          </div>
        </div>
      </header>
      ${successor ? html`<div class="note">${icon('info')}<p>Nachfolger: <a href="#/akten/${successor.id}">${successor.name}</a> – neue Briefe gehören dorthin.</p></div>` : ''}
      ${predecessors.length ? html`<div class="note">${icon('history')}<p>Vorher: ${predecessors.map((p, i) => html`${i ? ', ' : ''}<a href="#/akten/${p.id}">${p.name}</a>`)}</p></div>` : ''}
      ${o.notes ? html`<p class="muted">${o.notes}</p>` : ''}

      ${tasks.length ? html`<section aria-labelledby="tasks-h">
        <div class="section-title"><h2 id="tasks-h">Offene Aufgaben</h2></div>
        <div class="panel panel-plain"><ul class="list">${tasks.map((tk) => taskRow(tk, today))}</ul></div>
      </section>` : ''}

      <section aria-labelledby="letters-h">
        <div class="section-title"><h2 id="letters-h">Briefe</h2>
          <a href="#/briefe?object=${o.id}">In der Briefliste</a></div>
        ${letters.length ? html`<div class="panel panel-plain"><ul class="list">${letters.map((l) => letterRow(l, {
          note: html`<span class="link-why">${icon(l.link.origin === 'nutzer' ? 'user' : 'link')}${ORIGIN_LABEL[l.link.origin] || 'zugeordnet'}${l.link.evidence?.[0] && l.link.evidence[0].type !== 'nutzer' ? `: ${evidenceText(l.link.evidence[0])}` : ''}</span>`,
        }))}</ul></div>`
          : html`<p class="muted">Noch keine Briefe.</p>`}
      </section>

      <div class="row object-actions">
        <button class="btn btn-small btn-secondary" type="button" data-act="edit">${icon('edit')}Bearbeiten</button>
        ${o.status === 'beendet'
          ? html`<button class="btn btn-small btn-secondary" type="button" data-act="reactivate">${icon('refresh')}Wieder aktiv</button>`
          : html`<button class="btn btn-small btn-secondary" type="button" data-act="end">${icon('history')}Beenden / Nachfolger</button>`}
        <button class="btn btn-small btn-secondary" type="button" data-act="merge">${icon('merge')}Zusammenführen</button>
        <button class="btn btn-small btn-danger" type="button" data-act="delete">${icon('trash')}Löschen</button>
      </div>
    </div>`);
  }

  function otherObjectsSelect(name, label, { allowEmpty = true } = {}) {
    return api.get('/api/objects').then(({ objects }) => {
      const others = objects.filter((x) => x.id !== id);
      return html`<div class="field"><label for="sel-${name}">${label}</label>
        <select class="input" id="sel-${name}" name="${name}">${allowEmpty ? html`<option value="">–</option>` : ''}
          ${OBJECT_TYPES.filter((t) => others.some((o) => o.type === t.id)).map((t) => html`<optgroup label="${t.plural}">
            ${others.filter((o) => o.type === t.id).map((o) => html`<option value="${o.id}">${o.name}</option>`)}</optgroup>`)}</select></div>`;
    });
  }

  async function endObject() {
    const select = await otherObjectsSelect('successorId', 'Nachfolger (freiwillig)');
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Ordner beenden</h2>
      <p class="muted">Z. B. Auto verkauft oder Vertrag gekündigt. Die Briefe bleiben.</p>
      <div class="field"><label for="end-date">Beendet am</label><input class="input" type="date" id="end-date" name="endedAt" value="${today}" max="${today}"></div>
      ${select}
      <p class="hint">Z. B. neuer Zähler oder neues Auto.</p>
      <div class="row"><button class="btn" type="submit">Beenden</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const v = Object.fromEntries(new FormData(form).entries());
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.patch(`/api/objects/${id}`, { status: 'beendet', endedAt: v.endedAt || null, successorId: v.successorId || null });
            close();
            toast('Ordner beendet.');
            forgetObjects();
            await load();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  async function mergeObject() {
    const select = await otherObjectsSelect('targetId', 'Zusammenführen mit', { allowEmpty: false });
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Ordner zusammenführen</h2>
      <p class="muted">Alle Briefe wandern in den gewählten Ordner, „${data.object.name}“ entfällt.</p>
      ${select}
      <div class="row"><button class="btn" type="submit">${icon('merge')}Zusammenführen</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const targetId = new FormData(form).get('targetId');
        if (!targetId) return;
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post(`/api/objects/${id}/merge`, { targetId });
            close();
            toast('Ordner zusammengeführt.');
            forgetObjects();
            navigate(`/akten/${targetId}`);
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function editIdentifier(item) {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Nummer bearbeiten</h2>
      <div class="field"><label for="ek">Art</label><select class="input" id="ek" name="kind">${IDENTIFIER_KINDS.map((k) => html`<option value="${k.id}" ${k.id === item.kind ? 'selected' : ''}>${k.label}</option>`)}</select></div>
      <div class="field"><label for="ev">Nummer</label><input class="input" id="ev" name="value" value="${item.value}" maxlength="120"></div>
      <label class="check"><input type="checkbox" name="old" ${item.status === 'alt' ? 'checked' : ''}><span>Frühere Nummer (gilt nicht mehr)</span></label>
      <div class="field-pair">
        <div class="field"><label for="vf">Gültig ab <span class="muted">(freiwillig)</span></label><input class="input" type="date" id="vf" name="validFrom" value="${item.validFrom || ''}"></div>
        <div class="field"><label for="vt">Gültig bis <span class="muted">(freiwillig)</span></label><input class="input" type="date" id="vt" name="validTo" value="${item.validTo || ''}"></div>
      </div>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const fd = new FormData(form);
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.patch(`/api/identifiers/${item.id}`, {
              kind: fd.get('kind'), value: fd.get('value'), status: fd.get('old') ? 'alt' : 'aktuell',
              validFrom: fd.get('validFrom') || null, validTo: fd.get('validTo') || null,
            });
            close();
            toast('Nummer gespeichert.');
            forgetObjects();
            await load();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  root.addEventListener('submit', async (e) => {
    const idForm = e.target.closest('[data-id-add]');
    const caseForm = e.target.closest('[data-case-add]');
    if (!idForm && !caseForm) return;
    e.preventDefault();
    const form = idForm || caseForm;
    clearErrors(form);
    const fd = new FormData(form);
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        if (idForm) {
          const res = await api.post(`/api/objects/${id}/identifiers`, { kind: fd.get('kind'), value: fd.get('value'), status: fd.get('old') ? 'alt' : 'aktuell' });
          forgetObjects();
          toast(res.warnings?.length ? res.warnings[0] : res.reassigned?.zugeordnet ? `Nummer gespeichert. ${res.reassigned.zugeordnet === 1 ? 'Ein Brief wurde' : `${res.reassigned.zugeordnet} Briefe wurden`} dadurch zugeordnet.` : 'Nummer gespeichert.');
        } else {
          await api.post(`/api/objects/${id}/cases`, { title: fd.get('title'), kind: fd.get('kind') });
          toast('Vorgang angelegt.');
        }
        await load();
        root.querySelector(idForm ? '#nv' : '#ct')?.focus();
      } catch (err) {
        showError(form, err);
      }
    });
  });

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'edit') {
        openObjectDialog({ object: data.object, onSaved: () => { forgetObjects(); load(); } });
      } else if (act === 'end') {
        await endObject();
      } else if (act === 'reactivate') {
        await api.patch(`/api/objects/${id}`, { status: 'aktiv' });
        toast('Ordner ist wieder aktiv.');
        forgetObjects();
        await load();
      } else if (act === 'merge') {
        await mergeObject();
      } else if (act === 'delete') {
        if (await confirmDialog({
          title: 'Ordner löschen?',
          body: `Der Ordner „${data.object.name}“ wird gelöscht. ${data.letters.length === 1 ? 'Der zugehörige Brief bleibt erhalten und wird' : data.letters.length ? `Die ${data.letters.length} zugehörigen Briefe bleiben erhalten und werden` : 'Briefe werden'} – wenn möglich – anderen Ordnern zugeordnet.`,
          confirmLabel: 'Ordner löschen', danger: true,
        })) {
          await api.del(`/api/objects/${id}`);
          forgetObjects();
          toast('Ordner gelöscht. Die Briefe sind weiterhin gespeichert.');
          navigate('/akten');
        }
      }
      const idEdit = e.target.closest('[data-id-edit]');
      if (idEdit) editIdentifier(data.identifiers.find((i) => i.id === idEdit.dataset.idEdit));
      const idDel = e.target.closest('[data-id-delete]');
      if (idDel) {
        const item = data.identifiers.find((i) => i.id === idDel.dataset.idDelete);
        if (await confirmDialog({ title: 'Nummer entfernen?', body: `${identifierKindLabel(item.kind)} „${item.value}“ wird aus dem Ordner entfernt. Bereits zugeordnete Briefe bleiben zugeordnet.`, confirmLabel: 'Entfernen', danger: true })) {
          await api.del(`/api/identifiers/${item.id}`);
          forgetObjects();
          toast('Nummer entfernt.');
          await load();
        }
      }
      const caseToggle = e.target.closest('[data-case-toggle]');
      if (caseToggle) {
        await api.patch(`/api/cases/${caseToggle.dataset.caseToggle}`, { status: caseToggle.dataset.status });
        await load();
      }
      const caseDel = e.target.closest('[data-case-delete]');
      if (caseDel) {
        if (await confirmDialog({ title: 'Vorgang löschen?', body: 'Die Briefe bleiben im Ordner, nur die Bündelung als Vorgang entfällt.', confirmLabel: 'Löschen', danger: true })) {
          await api.del(`/api/cases/${caseDel.dataset.caseDelete}`);
          await load();
        }
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  await load();
}
