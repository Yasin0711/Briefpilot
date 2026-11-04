// Seitenübersicht eines Briefes (aufgebaut wie die Ordnerauswahl): alle Seiten als Kacheln,
// Antippen markiert eine Seite (Kreis füllt sich), langes Drücken öffnet sie groß.
// Oben rechts „Löschen“ entfernt die markierten Seiten. Mindestens eine Seite bleibt.
import { html } from './html.js';
import { api } from './api.js';
import { icon, toast, openDialog } from './ui.js';
import { loadDoc, pageList } from './pdfview.js';
import { openViewer } from './viewer.js';

const LONG_PRESS_MS = 500;

/**
 * @param {{ letterId: string, files: {id:string, kind:string}[] }} opts
 * @returns {Promise<number>} Anzahl gelöschter Seiten (0 = abgebrochen)
 */
export async function pagesSheet({ letterId, files }) {
  const viewable = files.filter((f) => f.kind === 'pdf' || f.kind === 'image');
  const pages = await pageList(viewable);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (n) => {
      if (!settled) {
        settled = true;
        resolve(n);
      }
    };
    const selected = new Set();
    openDialog(html`<div class="move-sheet">
      <div class="move-top">
        <button class="move-link" type="button" data-cancel autofocus>Abbrechen</button>
        <strong class="move-title">${pages.length === 1 ? '1 Seite' : `${pages.length} Seiten`}</strong>
        <button class="move-link move-go move-danger" type="button" data-delete disabled>Löschen</button>
      </div>
      <p class="pages-hint small muted" data-hint>Antippen zum Auswählen · lange drücken zum Öffnen</p>
      <ul class="pages-grid" role="listbox" aria-multiselectable="true" aria-label="Seiten">
        ${pages.map((p, i) => html`<li>
          <button class="page-tile" type="button" role="option" aria-selected="false" data-index="${i}" aria-label="Seite ${i + 1}">
            <span class="sheet-thumb" data-thumb="${i}"><span class="spinner" aria-hidden="true"></span></span>
            <span class="page-circle" aria-hidden="true">${icon('check')}</span>
            <span class="page-no">${i + 1}</span>
          </button></li>`)}
      </ul>
    </div>`, (dialog, close) => {
      dialog.classList.add('sheet-full');
      dialog.addEventListener('close', () => finish(0));
      const del = dialog.querySelector('[data-delete]');
      const hint = dialog.querySelector('[data-hint]');

      const update = () => {
        const n = selected.size;
        const all = n >= pages.length;
        del.disabled = !n || all;
        del.textContent = n ? `Löschen (${n})` : 'Löschen';
        hint.textContent = all ? 'Eine Seite muss bleiben – sonst den ganzen Brief löschen.' : n ? `${n} ${n === 1 ? 'Seite' : 'Seiten'} ausgewählt` : 'Antippen zum Auswählen · lange drücken zum Öffnen';
        hint.classList.toggle('is-warn', all);
      };

      // Vorschaubilder zeichnen
      pages.forEach((p, i) => drawThumb(p, dialog.querySelector(`[data-thumb="${i}"]`)).catch(() => {}));

      // Langes Drücken = Seite groß öffnen; kurzes Tippen = auswählen
      let timer = null;
      let longFired = false;
      dialog.addEventListener('pointerdown', (e) => {
        const tile = e.target.closest('.page-tile');
        if (!tile) return;
        longFired = false;
        clearTimeout(timer);
        timer = setTimeout(() => {
          longFired = true;
          openViewer({ files: viewable, start: Number(tile.dataset.index), container: dialog });
        }, LONG_PRESS_MS);
      });
      const cancelPress = () => clearTimeout(timer);
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => dialog.addEventListener(t, cancelPress));
      dialog.addEventListener('pointermove', (e) => {
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancelPress();
      });
      dialog.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.page-tile')) e.preventDefault();
      });

      dialog.addEventListener('click', async (e) => {
        if (e.target.closest('[data-cancel]')) {
          close();
          return;
        }
        const tile = e.target.closest('.page-tile');
        if (tile) {
          if (longFired) {
            longFired = false;
            return;
          }
          const i = Number(tile.dataset.index);
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          tile.setAttribute('aria-selected', String(selected.has(i)));
          update();
          return;
        }
        if (e.target.closest('[data-delete]') && selected.size && selected.size < pages.length) {
          del.disabled = true;
          try {
            const body = [...selected].map((i) => pages[i]).map((p) => (p.kind === 'pdf' ? { fileId: p.fileId, page: p.page - 1 } : { fileId: p.fileId }));
            const res = await api.post(`/api/letters/${letterId}/pages/delete`, { pages: body });
            toast(res.removed === 1 ? '1 Seite gelöscht.' : `${res.removed} Seiten gelöscht.`);
            finish(res.removed);
            close();
          } catch (err) {
            toast(err.message, { error: true });
            update();
          }
        }
      });
    });
  });
}

async function drawThumb(p, slot) {
  if (!slot) return;
  if (p.kind === 'image') {
    const img = document.createElement('img');
    img.src = `/api/files/${p.fileId}`;
    img.alt = '';
    img.loading = 'lazy';
    slot.replaceChildren(img);
    return;
  }
  const doc = await loadDoc(p.fileId);
  const page = await doc.getPage(p.page);
  const base = page.getViewport({ scale: 1 });
  const scale = ((slot.clientWidth || 140) / base.width) * Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  page.cleanup();
  slot.replaceChildren(canvas);
}
