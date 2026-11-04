// Zuordnung eines Briefes zu einem Ordner: ein Vorschlag, „Zuordnen“ oder Ordner aus der Liste wählen/neu anlegen.
// Wird im Eingang „Zuordnen“ und in der Brief-Ansicht verwendet.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, busy } from '../ui.js';
import { objectType } from '../shared/constants.js';
import { objectTile, evidenceList } from './parts.js';
import { objectLevelIdentifiers } from './objectDialog.js';
import { moveSheet, filedAnimation } from '../folderSheet.js';

let objectsCache = null;
/** Alle Ordner (für „anderen Ordner wählen“); wird nach Änderungen neu geladen. */
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

/** Nummern aus dem Brief, die sich einen Ordner merken kann (nicht schon als Treffer genutzt). */
function learnable(identifiers, candidate) {
  const matched = new Set((candidate?.evidence || [])
    .filter((e) => e.type === 'kennung' && e.match !== 'aehnlich')
    .map((e) => String(e.letterValue || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '')));
  return objectLevelIdentifiers(identifiers)
    .filter((i) => !matched.has(String(i.value).toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '')))
    .slice(0, 8);
}

/**
 * Baut die Entscheidung in einen Container: höchstens EIN Vorschlag, darunter nur
 * „Zuordnen“ und der Ordner-Knopf (alle Ordner wie in der Dateien-App, unten rechts „Neuer Ordner“).
 * @param {HTMLElement} container
 * @param {{ letter: { id, sender, subject, category }, assignment: object|null, current?: string[],
 *           onDone: (result) => void, onCancel?: () => void }} options
 */
export function mountDecision(container, { letter, assignment, current = [], onDone, onCancel }) {
  const info = assignment || {};
  const identifiers = info.identifiers || [];
  const best = (info.candidates || []).find((c) => !current.includes(c.objectId)) || null;
  const proposal = !best && info.proposal ? info.proposal : null;

  function draw() {
    mount(container, html`<div class="decision stack">
      ${best ? html`<div class="decision-suggest">
          ${objectTile(best.type)}
          <span class="grow"><span class="row-title">${best.name}</span>
            <span class="row-sub">${objectType(best.type).label}${best.fuzzy ? ' · nur ähnliche Nummer' : ''}</span>
            ${best.evidence?.length ? html`<span class="choice-evidence">${evidenceList(best.evidence)}</span>` : ''}</span>
        </div>`
        : proposal ? html`<div class="decision-suggest">
          ${objectTile(proposal.type)}
          <span class="grow"><span class="row-title">${proposal.name}</span><span class="row-sub">Neuer Ordner</span></span>
        </div>`
        : html`<p class="muted">Kein passender Ordner gefunden.</p>`}
      <div class="decision-actions">
        <button class="btn" type="button" data-save>${icon('check')}Zuordnen</button>
        <button class="icon-btn folder-add-btn" type="button" data-sheet aria-label="Ordner wählen oder neu anlegen" title="Ordner wählen">${icon('folderAdd')}</button>
      </div>
      ${onCancel ? html`<p><button class="btn btn-ghost btn-small" type="button" data-cancel>Abbrechen</button></p>` : ''}
    </div>`);
  }

  async function finish(target, button, { created = false, learn = [] } = {}) {
    await busy(button, async () => {
      try {
        const res = await api.put(`/api/letters/${letter.id}/links`, { objectIds: [target.id], learn });
        forgetObjects();
        await filedAnimation(target.name);
        if (res.learned || res.reassigned?.zugeordnet) toast(`${res.learned ? `${res.learned === 1 ? 'Eine Nummer' : `${res.learned} Nummern`} gemerkt.` : ''}${reassignedText(res.reassigned)}`.trim());
        onDone?.({ ...res, created });
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  }

  async function openSheet(button) {
    const target = await moveSheet({ title: 'Zuordnen', item: letter.subject || letter.sender || 'Brief', current });
    if (target) await finish(target, button, { created: target.created });
  }

  container.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel]')) {
      onCancel?.();
      return;
    }
    const sheetBtn = e.target.closest('[data-sheet]');
    if (sheetBtn) {
      await openSheet(sheetBtn);
      return;
    }
    const saveBtn = e.target.closest('[data-save]');
    if (!saveBtn) return;
    if (best) {
      // Neue Nummern (z. B. nach Vertragswechsel) gleich merken, damit Folgebriefe von selbst passen
      const learn = learnable(identifiers, best).filter((i) => i.status === 'neu')
        .map((i) => ({ objectId: best.objectId, kind: i.kind, value: i.value, status: 'aktuell' }));
      await finish({ id: best.objectId, name: best.name }, saveBtn, { learn });
      return;
    }
    if (proposal) {
      await busy(saveBtn, async () => {
        try {
          const res = await api.post('/api/objects', {
            type: proposal.type, name: proposal.name, provider: proposal.provider || '', letterId: letter.id,
            identifiers: (proposal.identifiers || []).map((i) => ({ kind: i.kind, value: i.value, status: 'aktuell' })),
          });
          forgetObjects();
          await filedAnimation(res.object?.name || proposal.name);
          onDone?.({ ...res, created: true });
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
      return;
    }
    await openSheet(saveBtn);
  });

  draw();
}
