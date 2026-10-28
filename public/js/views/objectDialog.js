// Dialog zum Anlegen und Bearbeiten einer Akte (Fahrzeug, Zähler, Vertrag …) samt Nummern.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, openDialog, showError, clearErrors, busy } from '../ui.js';
import { OBJECT_TYPES, objectType } from '../shared/constants.js';
import { IDENTIFIER_KINDS, identifierKind } from '../shared/identifiers.js';

let householdCache = null;
export async function loadHousehold({ fresh = false } = {}) {
  if (!householdCache || fresh) householdCache = await api.get('/api/household');
  return householdCache;
}
export function forgetHousehold() {
  householdCache = null;
}

/** Vorschlag für die Aktenart anhand der Nummern im Brief. */
export function guessType(identifiers = [], category = '') {
  const kinds = new Set(identifiers.map((i) => i.kind));
  if (kinds.has('kennzeichen') || kinds.has('fin')) return 'fahrzeug';
  if (kinds.has('zaehlernummer') || kinds.has('malo_id') || kinds.has('melo_id')) return 'strom';
  if (kinds.has('mitgliedsnummer')) return 'krankenkasse';
  if (kinds.has('versicherungsnummer')) return 'versicherung';
  if (kinds.has('darlehensnummer')) return 'kredit';
  if (kinds.has('mietvertragsnummer') || kinds.has('wohnungsnummer')) return 'wohnen';
  if (kinds.has('steuernummer') || category === 'behoerden') return 'behoerde';
  if (kinds.has('anschlusskennung')) return 'internet';
  if (category === 'versicherungen') return 'versicherung';
  if (category === 'bank') return 'bank';
  return 'vertrag';
}

/** Nummern, die eine Akte kennzeichnen (keine Rechnungs- oder Schadennummern, keine IBAN des Absenders). */
export function objectLevelIdentifiers(identifiers = []) {
  return identifiers.filter((i) => identifierKind(i.kind).level === 'objekt' && i.kind !== 'iban');
}

function kindOptions(type, selected) {
  const hints = objectType(type).hints || [];
  const first = IDENTIFIER_KINDS.filter((k) => hints.includes(k.id));
  const rest = IDENTIFIER_KINDS.filter((k) => !hints.includes(k.id));
  const option = (k) => html`<option value="${k.id}" ${k.id === selected ? 'selected' : ''}>${k.label}</option>`;
  return html`${first.length ? html`<optgroup label="Typisch für ${objectType(type).label}">${first.map(option)}</optgroup>` : ''}
    <optgroup label="Weitere">${rest.map(option)}</optgroup>`;
}

function identifierRow(item, index, type) {
  return html`<div class="id-row" data-id-row>
    <div class="field"><label class="visually-hidden" for="idk-${index}">Art der Nummer ${index + 1}</label>
      <select class="input" id="idk-${index}" data-kind>${kindOptions(type, item.kind || (objectType(type).hints || [])[0] || 'sonstiges')}</select></div>
    <div class="field"><label class="visually-hidden" for="idv-${index}">Nummer ${index + 1}</label>
      <input class="input" id="idv-${index}" name="identifiers.${index}.value" data-value value="${item.value || ''}" placeholder="z. B. SB-AB 123" autocomplete="off" maxlength="120"></div>
    <label class="check id-old"><input type="checkbox" data-old ${item.status === 'alt' ? 'checked' : ''}><span>früher</span></label>
    <button class="icon-btn" type="button" data-remove-id aria-label="Nummer ${index + 1} entfernen">${icon('x')}</button>
  </div>`;
}

/**
 * Öffnet den Dialog.
 * @param {{ object?: object, prefill?: { type, name, provider, identifiers }, letterId?: string,
 *           onSaved?: (result) => void }} options
 */
export async function openObjectDialog({ object = null, prefill = {}, letterId = null, onSaved } = {}) {
  let household = { persons: [], addresses: [] };
  try {
    household = await loadHousehold();
  } catch {
    /* ohne Personen und Adressen weiter */
  }
  const editing = Boolean(object);
  let type = object?.type || prefill.type || 'vertrag';
  const rows = editing ? [] : (prefill.identifiers?.length ? prefill.identifiers : [{}]).map((i) => ({ kind: i.kind, value: i.value, status: i.status === 'alt' ? 'alt' : 'aktuell' }));

  openDialog(html`<form class="dialog-body stack" novalidate>
    <h2>${editing ? 'Akte bearbeiten' : 'Neue Akte'}</h2>
    ${!editing ? html`<p class="muted small">Eine Akte sammelt alle Briefe zu einer Sache – zum Beispiel einem Auto, einem Stromzähler oder einem Vertrag. Mit den Nummern erkennt BriefPilot künftige Briefe von selbst.</p>` : ''}
    <div class="field"><label for="o-type">Art</label>
      <select class="input" id="o-type" name="type" data-type>${OBJECT_TYPES.map((t) => html`<option value="${t.id}" ${t.id === type ? 'selected' : ''}>${t.label}</option>`)}</select></div>
    <div class="field"><label for="o-name">Name</label>
      <input class="input" id="o-name" name="name" maxlength="120" required value="${object?.name || prefill.name || ''}" placeholder="z. B. Fahrzeug 1 · SB-AB 123">
      <p class="hint">So erscheint die Akte in Listen. Gut sind Name und wichtigste Nummer.</p></div>
    <div class="field"><label for="o-provider">Vertragspartner / Absender <span class="muted">(freiwillig)</span></label>
      <input class="input" id="o-provider" name="provider" maxlength="160" value="${object?.provider || prefill.provider || ''}" placeholder="z. B. HUK-COBURG, Stadtwerke Saarbrücken">
      <p class="hint">Hilft, gleiche Nummern verschiedener Firmen auseinanderzuhalten.</p></div>
    ${household.persons.length || household.addresses.length ? html`<div class="field-pair">
      ${household.persons.length ? html`<div class="field"><label for="o-person">Person <span class="muted">(freiwillig)</span></label>
        <select class="input" id="o-person" name="personId"><option value="">–</option>${household.persons.map((p) => html`<option value="${p.id}" ${p.id === object?.personId ? 'selected' : ''}>${p.name}</option>`)}</select></div>` : ''}
      ${household.addresses.length ? html`<div class="field"><label for="o-address">Adresse <span class="muted">(freiwillig)</span></label>
        <select class="input" id="o-address" name="addressId"><option value="">–</option>${household.addresses.map((a) => html`<option value="${a.id}" ${a.id === object?.addressId ? 'selected' : ''}>${a.label}${a.street ? ` – ${a.street}` : ''}</option>`)}</select></div>` : ''}
    </div>` : ''}
    ${!editing ? html`<fieldset class="field"><legend class="field-label">Nummern</legend>
      <p class="hint">Kennzeichen, Vertrags-, Kunden- oder Zählernummer. Leerzeichen und Bindestriche spielen keine Rolle.</p>
      <div class="stack-s" data-id-rows>${rows.map((r, i) => identifierRow(r, i, type))}</div>
      <p><button class="btn btn-ghost btn-small" type="button" data-add-id>${icon('plus')}Weitere Nummer</button></p>
    </fieldset>` : ''}
    <div class="field"><label for="o-notes">Notiz <span class="muted">(freiwillig)</span></label>
      <textarea class="input" id="o-notes" name="notes" rows="2" maxlength="1000">${object?.notes || ''}</textarea></div>
    <div class="row"><button class="btn" type="submit">${icon('check')}${editing ? 'Speichern' : 'Akte anlegen'}</button>
      <button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
  </form>`, (dialog, close) => {
    const form = dialog.querySelector('form');
    const rowsBox = form.querySelector('[data-id-rows]');
    const collectRows = () => [...form.querySelectorAll('[data-id-row]')].map((row) => ({
      kind: row.querySelector('[data-kind]').value,
      value: row.querySelector('[data-value]').value.trim(),
      status: row.querySelector('[data-old]').checked ? 'alt' : 'aktuell',
    }));
    const redrawRows = (items) => {
      if (rowsBox) mount(rowsBox, items.map((r, i) => identifierRow(r, i, type)));
    };
    dialog.querySelector('[data-close]').addEventListener('click', () => close());
    form.querySelector('[data-type]').addEventListener('change', (e) => {
      type = e.target.value;
      if (rowsBox) redrawRows(collectRows());
    });
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add-id]')) {
        const items = collectRows();
        items.push({ kind: (objectType(type).hints || [])[0] || 'sonstiges', value: '', status: 'aktuell' });
        redrawRows(items);
        rowsBox.querySelector('[data-id-row]:last-child [data-value]')?.focus();
      }
      const remove = e.target.closest('[data-remove-id]');
      if (remove) {
        const all = [...form.querySelectorAll('[data-id-row]')];
        const idx = all.indexOf(remove.closest('[data-id-row]'));
        const items = collectRows();
        items.splice(idx, 1);
        redrawRows(items.length ? items : [{}]);
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearErrors(form);
      const data = Object.fromEntries(new FormData(form).entries());
      const body = {
        type: data.type, name: data.name, provider: data.provider || null, notes: data.notes || null,
        personId: data.personId || null, addressId: data.addressId || null,
      };
      // Leere Zeilen werden nicht gesendet; Fehlermeldungen des Servers zeigen auf die richtige Zeile
      const sent = editing ? [] : collectRows().map((r, i) => ({ ...r, i })).filter((r) => r.value);
      if (!editing) {
        body.identifiers = sent.map(({ kind, value, status }) => ({ kind, value, status }));
        if (letterId) body.letterId = letterId;
      }
      await busy(form.querySelector('[type=submit]'), async () => {
        try {
          const res = editing ? await api.patch(`/api/objects/${object.id}`, body) : await api.post('/api/objects', body);
          close();
          toast(editing ? 'Akte gespeichert.' : letterId ? 'Akte angelegt und Brief zugeordnet.' : 'Akte angelegt.');
          if (res.warnings?.length) setTimeout(() => toast(res.warnings[0]), 3700);
          else if (res.reassigned?.zugeordnet) setTimeout(() => toast(`${res.reassigned.zugeordnet === 1 ? 'Ein weiterer Brief wurde' : `${res.reassigned.zugeordnet} weitere Briefe wurden`} zugeordnet.`), 3700);
          onSaved?.(res);
        } catch (err) {
          const m = /^identifiers\.(\d+)\.value$/.exec(err.field || '');
          if (m && sent[Number(m[1])]) err.field = `identifiers.${sent[Number(m[1])].i}.value`;
          showError(form, err);
        }
      });
    });
  });
}
