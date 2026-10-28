// Akten: Liste (gruppiert nach Art) und Detailansicht mit Nummern, Vorgängen, Briefen und Aufgaben.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, confirmDialog, openDialog, showError, clearErrors, busy } from '../ui.js';
import { OBJECT_TYPES, objectType, CASE_KINDS } from '../shared/constants.js';
import { IDENTIFIER_KINDS, identifierKindLabel } from '../shared/identifiers.js';
import { formatDate, todayIn } from '../shared/dates.js';
import { briefeTabs, objectTile, letterRow, evidenceText } from './parts.js';
import { openObjectDialog } from './objectDialog.js';
import { forgetObjects } from './assign.js';
import { taskRow } from './overview.js';
import { setInboxCount } from '../app.js';

function idSummary(identifiers = []) {
  const current = identifiers.filter((i) => i.status !== 'alt').slice(0, 3);
  return current.map((i) => i.value).join(' · ');
}

// ---------- Liste ----------

export async function renderList({ root, query, navigate, isCurrent }) {
  let q = query.get('q') || '';
  let requestId = 0;

  mount(root, html`<div class="stack-l">
    <div class="page-head"><div><h1>Akten</h1>
      <p>Ordner für Fahrzeuge, Zähler, Verträge und Ämter. Briefe werden anhand ihrer Nummern automatisch einsortiert.</p></div>
      <button class="btn btn-small" type="button" data-new>${icon('plus')}Neue Akte</button></div>
    <div data-tabs>${briefeTabs('akten')}</div>
    <form class="search-box" role="search" data-search>
      ${icon('search')}
      <label class="visually-hidden" for="oq">Akten durchsuchen</label>
      <input class="input" id="oq" name="q" type="search" placeholder="Name, Kennzeichen oder Nummer" value="${q}" autocomplete="off">
    </form>
    <div data-results aria-live="polite"><p class="muted">Wird geladen …</p></div>
  </div>`);

  const results = root.querySelector('[data-results]');

  async function load() {
    const id = ++requestId;
    const data = await api.get(`/api/objects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (id !== requestId || !isCurrent()) return;
    setInboxCount(data.inbox);
    mount(root.querySelector('[data-tabs]'), briefeTabs('akten', { inbox: data.inbox }));
    const hash = `#/akten${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
    const active = data.objects.filter((o) => o.status !== 'beendet');
    const ended = data.objects.filter((o) => o.status === 'beendet');
    if (!data.objects.length) {
      mount(results, q
        ? html`<div class="empty">${icon('search')}<h2>Keine Akte gefunden</h2><p>Versuchen Sie einen Teil des Namens, der Firma oder einer Nummer.</p></div>`
        : html`<div class="empty">${icon('folder')}<h2>Noch keine Akten</h2>
          <p>Legen Sie für jede Sache eine Akte an – zum Beispiel für jedes Auto mit Kennzeichen, jeden Stromzähler oder jede Versicherung. Dann sortiert BriefPilot neue Briefe selbst ein.</p>
          <button class="btn" type="button" data-new>${icon('plus')}Erste Akte anlegen</button></div>`);
      return;
    }
    const groups = OBJECT_TYPES.map((t) => ({ type: t, items: active.filter((o) => o.type === t.id) })).filter((g) => g.items.length);
    mount(results, html`${groups.map((g) => html`<section>
        <h2 class="month-head">${g.type.plural} <span class="muted">(${g.items.length})</span></h2>
        <div class="panel panel-plain"><ul class="list">${g.items.map(objectRow)}</ul></div>
      </section>`)}
      ${ended.length ? html`<details class="ended"><summary class="month-head">Beendete Akten (${ended.length})</summary>
        <div class="panel panel-plain"><ul class="list">${ended.map(objectRow)}</ul></div></details>` : ''}`);
  }

  function objectRow(o) {
    const ids = idSummary(o.identifiers);
    return html`<li><a class="list-row" href="#/akten/${o.id}">
      ${objectTile(o.type)}
      <span class="grow"><span class="row-title">${o.name}</span>
        ${o.provider ? html`<span class="row-sub">${o.provider}</span>` : ''}
        ${ids ? html`<span class="row-sub mono">${ids}</span>` : ''}
        <span class="row-meta"><span class="badge">${o.letterCount === 1 ? '1 Brief' : `${o.letterCount || 0} Briefe`}</span>
          ${o.openTasks ? html`<span class="badge badge-open">${o.openTasks} offen</span>` : ''}
          ${o.status === 'beendet' ? html`<span class="badge">beendet${o.endedAt ? ` am ${formatDate(o.endedAt)}` : ''}</span>` : ''}
          ${o.personName ? html`<span class="badge">${icon('user')}${o.personName}</span>` : ''}</span></span>
      ${icon('chevronRight', 'chev')}</a></li>`;
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
    draw();
  }

  function draw() {
    const { object: o, identifiers, cases, letters, tasks, successor, predecessors } = data;
    const objectIds = identifiers.filter((i) => !i.caseId);
    const t = objectType(o.type);
    mount(root, html`<div class="stack-l">
      <p><a class="btn btn-ghost btn-small" href="#/akten">${icon('chevronLeft')}Alle Akten</a></p>
      <header class="letter-head">
        ${objectTile(o.type, { large: true })}
        <div class="grow">
          <h1>${o.name}</h1>
          <div class="letter-meta">
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
      <div class="row">
        <button class="btn btn-small btn-secondary" type="button" data-act="edit">${icon('edit')}Bearbeiten</button>
        ${o.status === 'beendet'
          ? html`<button class="btn btn-small btn-secondary" type="button" data-act="reactivate">${icon('refresh')}Wieder aktiv</button>`
          : html`<button class="btn btn-small btn-secondary" type="button" data-act="end">${icon('history')}Beenden / Nachfolger</button>`}
        <button class="btn btn-small btn-secondary" type="button" data-act="merge">${icon('merge')}Zusammenführen</button>
        <button class="btn btn-small btn-danger" type="button" data-act="delete">${icon('trash')}Löschen</button>
      </div>

      <section class="panel stack" aria-labelledby="ids-h">
        <div class="section-title"><h2 id="ids-h">Nummern</h2></div>
        <p class="small muted">Steht eine dieser Nummern in einem Brief, ordnet BriefPilot ihn dieser Akte zu. Nummern wie Kunden- oder Vertragsnummern zählen nur zusammen mit dem passenden Absender.</p>
        ${objectIds.length ? html`<ul class="id-list">${objectIds.map((i) => html`<li>
            <span class="grow"><span class="row-sub">${i.kindLabel}</span><span class="row-title mono">${i.value}</span>
              <span class="row-meta">${i.status === 'alt' ? html`<span class="badge">frühere Nummer</span>` : ''}
                ${i.validFrom ? html`<span class="badge">ab ${formatDate(i.validFrom)}</span>` : ''}${i.validTo ? html`<span class="badge">bis ${formatDate(i.validTo)}</span>` : ''}
                ${i.source === 'brief' ? html`<span class="badge">aus einem Brief gelernt</span>` : ''}</span></span>
            <button class="icon-btn" type="button" data-id-edit="${i.id}" aria-label="${i.kindLabel} ${i.value} bearbeiten">${icon('edit')}</button>
            <button class="icon-btn" type="button" data-id-delete="${i.id}" aria-label="${i.kindLabel} ${i.value} entfernen">${icon('trash')}</button>
          </li>`)}</ul>` : html`<p class="muted">Noch keine Nummer gespeichert. Ohne Nummer kann BriefPilot Briefe nicht sicher zuordnen.</p>`}
        <form class="id-add" data-id-add novalidate>
          <div class="field"><label for="nk">Art</label><select class="input" id="nk" name="kind">
            ${IDENTIFIER_KINDS.map((k) => html`<option value="${k.id}" ${k.id === (t.hints || [])[0] ? 'selected' : ''}>${k.label}</option>`)}</select></div>
          <div class="field"><label for="nv">Nummer</label><input class="input" id="nv" name="value" maxlength="120" autocomplete="off" placeholder="z. B. SB-AB 123"></div>
          <label class="check"><input type="checkbox" name="old"><span>frühere Nummer</span></label>
          <button class="btn btn-small" type="submit">${icon('plus')}Hinzufügen</button>
        </form>
      </section>

      ${tasks.length ? html`<section aria-labelledby="tasks-h">
        <div class="section-title"><h2 id="tasks-h">Offene Aufgaben</h2></div>
        <div class="panel panel-plain"><ul class="list">${tasks.map((tk) => taskRow(tk, today))}</ul></div>
      </section>` : ''}

      <section aria-labelledby="letters-h">
        <div class="section-title"><h2 id="letters-h">Briefe</h2>
          <a href="#/briefe?object=${o.id}">In der Briefliste</a></div>
        ${letters.length ? html`<div class="panel panel-plain"><ul class="list">${letters.map((l) => letterRow(l, {
          note: html`<span class="link-why">${icon(l.link.origin === 'nutzer' ? 'user' : 'link')}${ORIGIN_LABEL[l.link.origin] || 'zugeordnet'}${l.link.evidence?.[0] && l.link.evidence[0].type !== 'nutzer' ? `: ${evidenceText(l.link.evidence[0])}` : ''}${l.link.caseId ? ` · Vorgang: ${cases.find((c) => c.id === l.link.caseId)?.title || ''}` : ''}</span>`,
        }))}</ul></div>`
          : html`<p class="muted">Noch keine Briefe in dieser Akte. Neue Briefe mit einer der Nummern landen automatisch hier.</p>`}
      </section>

      <section class="panel stack" aria-labelledby="cases-h">
        <div class="section-title"><h2 id="cases-h">Vorgänge</h2></div>
        <p class="small muted">Zusammengehörige Briefe innerhalb der Akte, z. B. ein Schadenfall oder eine Rechnung mit Mahnung. Vorgänge mit Rechnungs- oder Schadennummer legt BriefPilot selbst an.</p>
        ${cases.length ? html`<ul class="id-list">${cases.map((c) => html`<li>
            <span class="grow"><span class="row-title">${c.title}</span>
              <span class="row-meta"><span class="badge">${CASE_KINDS.find((k) => k.id === c.kind)?.label || 'Vorgang'}</span>
                <span class="badge">${c.letterCount === 1 ? '1 Brief' : `${c.letterCount} Briefe`}</span>
                ${c.status === 'abgeschlossen' ? html`<span class="badge badge-done">${icon('check')}abgeschlossen</span>` : html`<span class="badge badge-open">offen</span>`}</span></span>
            <button class="btn btn-small btn-ghost" type="button" data-case-toggle="${c.id}" data-status="${c.status === 'abgeschlossen' ? 'offen' : 'abgeschlossen'}">${c.status === 'abgeschlossen' ? 'Wieder öffnen' : 'Abschließen'}</button>
            <button class="icon-btn" type="button" data-case-delete="${c.id}" aria-label="Vorgang ${c.title} löschen">${icon('trash')}</button>
          </li>`)}</ul>` : html`<p class="muted">Keine Vorgänge.</p>`}
        <form class="id-add" data-case-add novalidate>
          <div class="field"><label for="ct">Neuer Vorgang</label><input class="input" id="ct" name="title" maxlength="160" placeholder="z. B. Unfall vom 3. März"></div>
          <div class="field"><label for="ck">Art</label><select class="input" id="ck" name="kind">${CASE_KINDS.map((k) => html`<option value="${k.id}" ${k.id === 'allgemein' ? 'selected' : ''}>${k.label}</option>`)}</select></div>
          <button class="btn btn-small" type="submit">${icon('plus')}Anlegen</button>
        </form>
      </section>
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
      <h2>Akte beenden</h2>
      <p class="muted">Zum Beispiel: Auto verkauft, Zähler gewechselt, Vertrag gekündigt oder umgezogen. Die Briefe bleiben in der Akte. Nummern einer beendeten Akte zählen bei neuen Briefen nur noch eingeschränkt.</p>
      <div class="field"><label for="end-date">Beendet am</label><input class="input" type="date" id="end-date" name="endedAt" value="${today}" max="${today}"></div>
      ${select}
      <p class="hint">Ein Nachfolger ist z. B. der neue Zähler oder das neue Auto. Legen Sie ihn vorher als eigene Akte an.</p>
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
            toast('Akte beendet.');
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
      <h2>Akten zusammenführen</h2>
      <p class="muted">Alle Briefe, Nummern und Vorgänge von „${data.object.name}“ wandern in die gewählte Akte. Danach gibt es „${data.object.name}“ nicht mehr. Briefe werden dabei nicht gelöscht.</p>
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
            toast('Akten zusammengeführt.');
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
        toast('Akte ist wieder aktiv.');
        forgetObjects();
        await load();
      } else if (act === 'merge') {
        await mergeObject();
      } else if (act === 'delete') {
        if (await confirmDialog({
          title: 'Akte löschen?',
          body: `Die Akte „${data.object.name}“ mit ihren Nummern und Vorgängen wird gelöscht. ${data.letters.length === 1 ? 'Der zugehörige Brief bleibt erhalten und wird' : data.letters.length ? `Die ${data.letters.length} zugehörigen Briefe bleiben erhalten und werden` : 'Briefe werden'} – wenn möglich – anderen Akten zugeordnet.`,
          confirmLabel: 'Akte löschen', danger: true,
        })) {
          await api.del(`/api/objects/${id}`);
          forgetObjects();
          toast('Akte gelöscht. Die Briefe sind weiterhin gespeichert.');
          navigate('/akten');
        }
      }
      const idEdit = e.target.closest('[data-id-edit]');
      if (idEdit) editIdentifier(data.identifiers.find((i) => i.id === idEdit.dataset.idEdit));
      const idDel = e.target.closest('[data-id-delete]');
      if (idDel) {
        const item = data.identifiers.find((i) => i.id === idDel.dataset.idDelete);
        if (await confirmDialog({ title: 'Nummer entfernen?', body: `${identifierKindLabel(item.kind)} „${item.value}“ wird aus der Akte entfernt. Bereits zugeordnete Briefe bleiben zugeordnet.`, confirmLabel: 'Entfernen', danger: true })) {
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
        if (await confirmDialog({ title: 'Vorgang löschen?', body: 'Die Briefe bleiben in der Akte, nur die Bündelung als Vorgang entfällt.', confirmLabel: 'Löschen', danger: true })) {
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
