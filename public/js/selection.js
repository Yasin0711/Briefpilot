// Mehrere Briefe auswählen (wie „Auswählen“ in Mail oder Dateien): Kreise vor den Zeilen,
// unten eine Leiste mit Verschieben · Teilen · Löschen. Verschieben nutzt die Ordnerauswahl
// samt „Neuer Ordner“. Die Liste selbst bleibt unverändert – Zeilen sind a[data-ctx="letter"].
import { html, mount } from './html.js';
import { api, download } from './api.js';
import { icon, toast, confirmDialog } from './ui.js';
import { moveSheet, filedAnimation } from './folderSheet.js';

const ROW = 'a[data-ctx="letter"]';
const safeName = (s) => String(s || 'Brief').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Brief';

/**
 * @param {{ root: HTMLElement, button: HTMLElement, allButton?: HTMLElement, reload: () => Promise<void>, folderId?: string }} opts
 *   button: „Auswählen“/„Fertig“; allButton: „Alle auswählen“ (nur im Auswahlmodus sichtbar)
 */
export function createSelection({ root, button, allButton = null, reload, folderId = null }) {
  let active = false;
  const chosen = new Map(); // id → Name
  let bar = null;
  let working = false;

  const rows = () => [...root.querySelectorAll(ROW)];

  function decorate() {
    for (const a of rows()) {
      let circle = a.querySelector('.select-circle');
      if (active && !circle) {
        circle = document.createElement('span');
        circle.className = 'select-circle';
        circle.setAttribute('aria-hidden', 'true');
        circle.innerHTML = icon('check').toString();
        a.prepend(circle);
      } else if (!active && circle) {
        circle.remove();
      }
      const on = active && chosen.has(a.dataset.id);
      a.classList.toggle('is-selected', on);
      if (active) a.setAttribute('aria-pressed', String(on));
      else a.removeAttribute('aria-pressed');
    }
  }

  function renderBar() {
    if (!active) {
      bar?.remove();
      bar = null;
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'select-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Ausgewählte Briefe');
      document.body.append(bar);
      bar.addEventListener('click', onBarClick);
    }
    const n = chosen.size;
    const off = !n || working;
    mount(bar, html`
      <span class="select-count" aria-live="polite">${n ? `${n} ausgewählt` : 'Briefe antippen'}</span>
      <button class="select-act" type="button" data-sel="move" ${off ? 'disabled' : ''}>${icon('folderOpen')}<span>Verschieben</span></button>
      <button class="select-act" type="button" data-sel="share" ${off ? 'disabled' : ''}>${icon('share')}<span>Teilen</span></button>
      <button class="select-act is-danger" type="button" data-sel="delete" ${off ? 'disabled' : ''}>${icon('trash')}<span>Löschen</span></button>`);
  }

  function update() {
    decorate();
    renderBar();
    button.textContent = active ? 'Fertig' : 'Auswählen';
    button.setAttribute('aria-pressed', String(active));
    if (allButton) {
      allButton.hidden = !active;
      const all = rows();
      allButton.textContent = all.length && all.every((a) => chosen.has(a.dataset.id)) ? 'Keine' : 'Alle';
    }
    root.classList.toggle('is-selecting', active);
    document.body.classList.toggle('has-select-bar', active);
  }

  function enter(id = null) {
    active = true;
    if (id) {
      const a = rows().find((r) => r.dataset.id === id);
      if (a) chosen.set(id, a.dataset.name);
    }
    update();
  }

  function exit() {
    active = false;
    chosen.clear();
    update();
  }

  /** Nach dem Neuzeichnen der Liste: Kreise wieder anbringen, verschwundene Briefe abwählen. */
  function refresh() {
    const ids = new Set(rows().map((a) => a.dataset.id));
    for (const id of [...chosen.keys()]) if (!ids.has(id)) chosen.delete(id);
    update();
  }

  // Antippen wählt aus statt zu öffnen
  root.addEventListener('click', (e) => {
    if (!active) return;
    const a = e.target.closest(ROW);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (chosen.has(a.dataset.id)) chosen.delete(a.dataset.id);
    else chosen.set(a.dataset.id, a.dataset.name);
    update();
  }, true);

  button.addEventListener('click', () => (active ? exit() : enter()));
  allButton?.addEventListener('click', () => {
    const all = rows();
    if (all.every((a) => chosen.has(a.dataset.id))) chosen.clear();
    else all.forEach((a) => chosen.set(a.dataset.id, a.dataset.name));
    update();
  });
  // „Auswählen“ aus dem Menü bei langem Drücken
  const onSelectEvent = (e) => enter(e.detail?.id || null);
  document.addEventListener('bp:select', onSelectEvent);

  async function eachLetter(fn) {
    let ok = 0;
    let failed = 0;
    for (const [id, name] of chosen) {
      try {
        await fn(id, name);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  async function moveSelected() {
    const n = chosen.size;
    const target = await moveSheet({ title: 'Verschieben', action: 'Bewegen', item: n === 1 ? [...chosen.values()][0] : `${n} Briefe`, current: folderId ? [folderId] : [] });
    if (!target) return;
    const { ok, failed } = await eachLetter((id) => api.put(`/api/letters/${id}/links`, { objectIds: [target.id] }));
    if (ok) await filedAnimation(target.name);
    if (failed) toast(`${failed} ${failed === 1 ? 'Brief konnte' : 'Briefe konnten'} nicht verschoben werden.`, { error: true });
    exit();
    await reload();
  }

  async function shareSelected() {
    const list = [...chosen];
    const files = [];
    const used = new Map(); // gleiche Namen durchnummerieren, sonst überschreiben sie sich beim Sichern
    const fileName = (name) => {
      const base = safeName(name);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      return n === 1 ? `${base}.pdf` : `${base} (${n}).pdf`;
    };
    for (const [id, name] of list) {
      const res = await fetch(`/api/letters/${id}/pdf`, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], fileName(name), { type: 'application/pdf' }));
    }
    if (!files.length) throw new Error('Die Briefe konnten nicht geladen werden.');
    if (navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files, title: files.length === 1 ? list[0][1] : `${files.length} Briefe` });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    // Ohne Teilen-Funktion: einzeln herunterladen
    used.clear();
    for (const [id, name] of list) await download(`/api/letters/${id}/pdf`, fileName(name));
  }

  async function deleteSelected() {
    const n = chosen.size;
    const yes = await confirmDialog({
      title: n === 1 ? 'Brief löschen?' : `${n} Briefe löschen?`,
      body: 'Original, Aufgaben und Erinnerungen werden gelöscht.',
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (!yes) return;
    const { ok, failed } = await eachLetter((id) => api.del(`/api/letters/${id}`));
    if (ok) toast(ok === 1 ? 'Brief gelöscht.' : `${ok} Briefe gelöscht.`);
    if (failed) toast(`${failed} ${failed === 1 ? 'Brief konnte' : 'Briefe konnten'} nicht gelöscht werden.`, { error: true });
    exit();
    await reload();
  }

  async function onBarClick(e) {
    const act = e.target.closest('[data-sel]')?.dataset.sel;
    if (!act || working || !chosen.size) return;
    working = true;
    renderBar();
    try {
      if (act === 'move') await moveSelected();
      else if (act === 'share') await shareSelected();
      else if (act === 'delete') await deleteSelected();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      working = false;
      renderBar();
    }
  }

  return {
    refresh,
    enter,
    exit,
    get active() {
      return active;
    },
    destroy() {
      document.removeEventListener('bp:select', onSelectEvent);
      bar?.remove();
      bar = null;
      document.body.classList.remove('has-select-bar');
    },
  };
}
