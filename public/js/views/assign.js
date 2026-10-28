// Zuordnung eines Briefes zu Akten: Auswahl mit Nachweisen, Nummern merken, neue Akte, keine Akte.
// Wird im Eingang „Zuordnen“ und in der Brief-Ansicht verwendet.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, busy } from '../ui.js';
import { OBJECT_TYPES, objectType } from '../shared/constants.js';
import { identifierKindLabel, identifierKind } from '../shared/identifiers.js';
import { objectTile, evidenceList, identifierStatusBadge } from './parts.js';
import { openObjectDialog, guessType, objectLevelIdentifiers } from './objectDialog.js';

let objectsCache = null;
/** Alle Akten (für „andere Akte wählen“); wird nach Änderungen neu geladen. */
export async function loadObjects({ fresh = false } = {}) {
  if (!objectsCache || fresh) objectsCache = (await api.get('/api/objects')).objects;
  return objectsCache;
}
export function forgetObjects() {
  objectsCache = null;
}

function reassignedText(r) {
  if (!r?.zugeordnet) return '';
  return r.zugeordnet === 1 ? ' Ein weiterer Brief wurde dadurch zugeordnet.' : ` ${r.zugeordnet} weitere Briefe wurden dadurch zugeordnet.`;
}

/** Nummern aus dem Brief, die sich eine Akte merken kann (nicht schon als Treffer genutzt). */
function learnable(identifiers, candidate) {
  const matched = new Set((candidate?.evidence || [])
    .filter((e) => e.type === 'kennung' && e.match !== 'aehnlich')
    .map((e) => String(e.letterValue || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '')));
  return objectLevelIdentifiers(identifiers)
    .filter((i) => !matched.has(String(i.value).toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '')))
    .slice(0, 8);
}

/**
 * Baut die Entscheidung in einen Container.
 * @param {HTMLElement} container
 * @param {{ letter: { id, sender, subject, category }, assignment: object|null, current?: string[],
 *           onDone: (result) => void, onCancel?: () => void }} options
 */
export function mountDecision(container, { letter, assignment, current = [], onDone, onCancel }) {
  const info = assignment || {};
  const identifiers = info.identifiers || [];
  const candidates = [...(info.candidates || [])];
  const selected = new Set(current.length ? current : candidates.filter((c) => c.preselected).map((c) => c.objectId));
  let learnChecked = null; // Set der gewählten Nummern (Schlüssel = value); null = Vorgabe
  let allObjects = null;

  const cardFor = (id) => candidates.find((c) => c.objectId === id);

  function draw() {
    const single = selected.size === 1 ? cardFor([...selected][0]) : null;
    const toLearn = single ? learnable(identifiers, single) : [];
    if (learnChecked === null || !single) learnChecked = new Set(toLearn.filter((i) => i.status === 'neu').map((i) => i.value));
    const others = (allObjects || []).filter((o) => !candidates.some((c) => c.objectId === o.id));
    mount(container, html`<div class="decision stack">
      ${info.message && !current.length && !(info.proposal && !candidates.length) ? html`<p class="decision-msg">${icon('inbox')}<strong>${info.message}</strong></p>` : ''}
      ${info.proposal && !candidates.length && !current.length ? html`<div class="proposal panel stack">
        <p class="decision-msg">${icon('folder')}<strong>Für diesen Brief gibt es noch keine passende Akte.</strong></p>
        <div class="field"><label for="proposal-${letter.id}">Neue Akte (${info.proposal.typeLabel})</label>
          <input class="input" id="proposal-${letter.id}" data-proposal-name maxlength="120" value="${info.proposal.name}"></div>
        ${info.proposal.identifiers?.length ? html`<p class="small muted">Die Akte merkt sich: ${info.proposal.identifiers.map((i) => `${i.label} ${i.value}`).join(', ')} – künftige Briefe damit landen automatisch dort.</p>` : ''}
        <div class="row"><button class="btn" type="button" data-accept-proposal>${icon('check')}Akte anlegen und Brief ablegen</button></div>
      </div>` : ''}
      ${candidates.length ? html`<fieldset class="choices">
        <legend class="visually-hidden">Mögliche Akten</legend>
        ${candidates.map((c) => html`<label class="choice ${selected.has(c.objectId) ? 'is-on' : ''}">
          <input type="checkbox" value="${c.objectId}" data-choice ${selected.has(c.objectId) ? 'checked' : ''}>
          <span class="choice-check" aria-hidden="true">${icon('check')}</span>
          ${objectTile(c.type)}
          <span class="choice-title"><span class="row-title">${c.name}</span>
            <span class="row-sub">${objectType(c.type).label}${c.caseTitle ? ` · Vorgang: ${c.caseTitle}` : ''}${c.fuzzy ? ' · nur ähnliche Nummer' : ''}</span></span>
          ${c.evidence?.length ? html`<span class="choice-evidence">${evidenceList(c.evidence)}</span>` : ''}
        </label>`)}
      </fieldset>
      ${candidates.length > 1 ? html`<p class="small muted">Gehört der Brief zu mehreren Akten (z. B. eine Rechnung für alle Fahrzeuge), wählen Sie alle passenden aus.</p>` : ''}`
        : html`<p class="muted">${current.length ? '' : 'BriefPilot hat keine passende Akte gefunden.'}</p>`}

      <div class="field decision-other">
        <label for="other-${letter.id}">${candidates.length ? 'Andere Akte wählen' : 'Akte wählen'}</label>
        ${allObjects === null
          ? html`<button class="btn btn-secondary btn-small" type="button" data-load-objects>${icon('folder')}Alle Akten anzeigen</button>`
          : others.length
            ? html`<select class="input" id="other-${letter.id}" data-other>
                <option value="">Akte auswählen …</option>
                ${OBJECT_TYPES.filter((t) => others.some((o) => o.type === t.id)).map((t) => html`<optgroup label="${t.plural}">
                  ${others.filter((o) => o.type === t.id).map((o) => html`<option value="${o.id}">${o.name}${o.status === 'beendet' ? ' (beendet)' : ''}</option>`)}</optgroup>`)}
              </select>`
            : html`<p class="small muted">Keine weiteren Akten vorhanden.</p>`}
      </div>

      ${toLearn.length ? html`<fieldset class="learn">
        <legend class="field-label">Nummern für „${single.name}“ merken?</legend>
        <p class="hint">Dann ordnet BriefPilot künftige Briefe mit dieser Nummer selbst zu.</p>
        ${toLearn.map((i) => html`<label class="check"><input type="checkbox" data-learn="${i.value}" ${learnChecked.has(i.value) ? 'checked' : ''}>
          <span>${identifierKindLabel(i.kind)}: <strong>${i.value}</strong> ${identifierStatusBadge(i.status)}
          ${identifierKind(i.kind).scope === 'issuer' && letter.sender ? html`<span class="row-sub">gilt zusammen mit dem Absender ${letter.sender}</span>` : ''}</span></label>`)}
      </fieldset>` : ''}

      <div class="row">
        <button class="btn" type="button" data-save ${selected.size ? '' : 'disabled'}>${icon('check')}${selected.size > 1 ? `${selected.size} Akten zuordnen` : 'Zuordnen'}</button>
        <button class="btn btn-secondary" type="button" data-new>${icon('plus')}Neue Akte</button>
        <button class="btn btn-ghost" type="button" data-none>Gehört zu keiner Akte</button>
        ${onCancel ? html`<button class="btn btn-ghost" type="button" data-cancel>Abbrechen</button>` : ''}
      </div>
    </div>`);
  }

  async function save(button, body, message) {
    await busy(button, async () => {
      try {
        const res = await api.put(`/api/letters/${letter.id}/links`, body);
        forgetObjects();
        toast(`${message}${res.learned ? ` ${res.learned === 1 ? 'Eine Nummer' : `${res.learned} Nummern`} gemerkt.` : ''}${reassignedText(res.reassigned)}`);
        onDone?.(res);
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  }

  container.addEventListener('change', (e) => {
    const choice = e.target.closest('[data-choice]');
    if (choice) {
      if (choice.checked) selected.add(choice.value);
      else selected.delete(choice.value);
      learnChecked = null;
      draw();
      container.querySelector(`[data-choice][value="${choice.value}"]`)?.focus();
      return;
    }
    const other = e.target.closest('[data-other]');
    if (other && other.value) {
      const o = allObjects.find((x) => x.id === other.value);
      candidates.push({ objectId: o.id, name: o.name, type: o.type, evidence: [], manual: true });
      selected.add(o.id);
      learnChecked = null;
      draw();
      container.querySelector(`[data-choice][value="${o.id}"]`)?.focus();
      return;
    }
    const learn = e.target.closest('[data-learn]');
    if (learn) {
      if (learn.checked) learnChecked.add(learn.dataset.learn);
      else learnChecked.delete(learn.dataset.learn);
    }
  });

  container.addEventListener('click', async (e) => {
    if (e.target.closest('[data-load-objects]')) {
      try {
        allObjects = await loadObjects();
        draw();
        container.querySelector('[data-other]')?.focus();
      } catch (err) {
        toast(err.message, { error: true });
      }
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      onCancel?.();
      return;
    }
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn && selected.size) {
      const objectIds = [...selected];
      const single = objectIds.length === 1 ? cardFor(objectIds[0]) : null;
      const learn = single ? learnable(identifiers, single)
        .filter((i) => learnChecked?.has(i.value))
        .map((i) => ({ objectId: single.objectId, kind: i.kind, value: i.value, status: i.status === 'alt' ? 'alt' : 'aktuell' })) : [];
      const names = objectIds.map((id) => cardFor(id)?.name).filter(Boolean);
      await save(saveBtn, { objectIds, learn }, `Zugeordnet: ${names.join(', ')}.`);
      return;
    }
    const noneBtn = e.target.closest('[data-none]');
    if (noneBtn) {
      await save(noneBtn, { objectIds: [], none: true }, 'Gespeichert: Der Brief gehört zu keiner Akte.');
      return;
    }
    const acceptBtn = e.target.closest('[data-accept-proposal]');
    if (acceptBtn && info.proposal) {
      const name = container.querySelector('[data-proposal-name]')?.value.trim() || info.proposal.name;
      await busy(acceptBtn, async () => {
        try {
          const res = await api.post('/api/objects', {
            type: info.proposal.type, name, provider: info.proposal.provider || '', letterId: letter.id,
            identifiers: (info.proposal.identifiers || []).map((i) => ({ kind: i.kind, value: i.value, status: 'aktuell' })),
          });
          forgetObjects();
          toast(`Akte „${name}“ angelegt – der Brief liegt jetzt dort.${reassignedText(res.reassigned)}`);
          onDone?.(res);
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
      return;
    }
    if (e.target.closest('[data-new]')) {
      const ids = objectLevelIdentifiers(identifiers);
      const type = guessType(ids, letter.category);
      const plate = ids.find((i) => i.kind === 'kennzeichen')?.value;
      openObjectDialog({
        letterId: letter.id,
        prefill: info.proposal ? {
          type: info.proposal.type,
          name: info.proposal.name,
          provider: info.proposal.provider || '',
          identifiers: ids.slice(0, 6).map((i) => ({ kind: i.kind, value: i.value, status: i.status === 'alt' ? 'alt' : 'aktuell' })),
        } : {
          type,
          name: plate ? `Fahrzeug · ${plate}` : letter.sender ? `${objectType(type).label} · ${letter.sender}`.slice(0, 120) : '',
          provider: letter.sender || '',
          identifiers: ids.slice(0, 6).map((i) => ({ kind: i.kind, value: i.value, status: i.status === 'alt' ? 'alt' : 'aktuell' })),
        },
        onSaved: (res) => {
          forgetObjects();
          onDone?.(res);
        },
      });
    }
  });

  draw();
}
