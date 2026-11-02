// Vollbild-Ansicht für Briefe (PDF und Fotos) innerhalb der App.
// Oben „Zurück“ und „Fertig“, die Zurück-Geste/-Taste schließt ebenfalls.
// Vergrößern mit + / − (oder mit zwei Fingern); gerendert wird nur, was sichtbar ist.
import { html, mount } from './html.js';
import { api } from './api.js';
import { icon } from './ui.js';
import { loadDoc } from './pdfview.js';
import { trapBackButton } from './scanner/overlay.js';

const ZOOMS = [1, 1.5, 2, 3];
const MAX_CANVAS_PIXELS = 12_000_000;
let openInstance = null;

/**
 * @param {{ files?: {id:string, kind:string}[], letterId?: string, title?: string, start?: number }} opts
 */
export async function openViewer({ files = null, letterId = null, title = '', start = 0 } = {}) {
  if (openInstance) openInstance.close();
  const root = document.createElement('div');
  root.className = 'viewer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', title || 'Brief');
  document.body.append(root);
  document.body.classList.add('viewer-open');
  const previousFocus = document.activeElement;
  let zoom = 0;
  let closed = false;
  let io = null;

  function close() {
    if (closed) return;
    closed = true;
    io?.disconnect();
    release();
    root.remove();
    document.body.classList.remove('viewer-open');
    window.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    openInstance = null;
  }
  const release = trapBackButton(() => {
    // Zurück-Taste: Verlaufseintrag ist schon weg
    if (closed) return;
    closed = true;
    io?.disconnect();
    root.remove();
    document.body.classList.remove('viewer-open');
    window.removeEventListener('keydown', onKey);
    openInstance = null;
  });
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);
  openInstance = { close };

  mount(root, html`
    <div class="viewer-top">
      <button class="viewer-btn" type="button" data-close>${icon('chevronLeft')}Zurück</button>
      <span class="viewer-zoom">
        <button class="viewer-btn viewer-icon" type="button" data-zoom="-1" aria-label="Verkleinern">${icon('minus')}</button>
        <button class="viewer-btn viewer-icon" type="button" data-zoom="1" aria-label="Vergrößern">${icon('plus')}</button>
      </span>
      <button class="viewer-btn viewer-done" type="button" data-close>Fertig</button>
    </div>
    <div class="viewer-body" data-body><div class="viewer-pages" data-pages><span class="spinner" aria-hidden="true"></span></div></div>`);
  root.querySelector('.viewer-done').focus();
  const body = root.querySelector('[data-body]');
  const pagesBox = root.querySelector('[data-pages]');

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    const z = e.target.closest('[data-zoom]');
    if (z) setZoom(zoom + Number(z.dataset.zoom));
  });

  if (!files && letterId) {
    try {
      const d = await api.get(`/api/letters/${encodeURIComponent(letterId)}`);
      files = (d.files || []).filter((f) => f.role !== 'original');
    } catch {
      files = [];
    }
  }
  files = (files || []).filter((f) => f.kind === 'pdf' || f.kind === 'image');
  if (closed) return;
  if (!files.length) {
    mount(pagesBox, html`<p class="viewer-empty">Keine Vorschau vorhanden.</p>`);
    return;
  }

  /** Seiten-Platzhalter anlegen; Inhalte werden beim Sichtbarwerden gezeichnet. */
  async function build() {
    io?.disconnect();
    const width = Math.floor((body.clientWidth - 16) * ZOOMS[zoom]);
    pagesBox.style.width = `${width}px`;
    const slots = [];
    for (const f of files) {
      if (f.kind === 'image') {
        const img = document.createElement('img');
        img.src = `/api/files/${f.id}`;
        img.alt = '';
        img.className = 'viewer-page';
        slots.push(img);
        continue;
      }
      try {
        const doc = await loadDoc(f.id);
        const first = await doc.getPage(1);
        const v = first.getViewport({ scale: 1 });
        for (let n = 1; n <= doc.numPages; n++) {
          const slot = document.createElement('div');
          slot.className = 'viewer-page';
          slot.style.height = `${Math.round(width * (v.height / v.width))}px`;
          slot.dataset.file = f.id;
          slot.dataset.page = String(n);
          slots.push(slot);
        }
      } catch {
        const a = document.createElement('a');
        a.href = `/api/files/${f.id}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'btn btn-secondary';
        a.textContent = 'PDF öffnen';
        slots.push(a);
      }
      if (closed) return;
    }
    pagesBox.replaceChildren(...slots);
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        draw(entry.target, width).catch(() => entry.target.classList.add('is-error'));
      }
    }, { root: body, rootMargin: '800px 0px' });
    slots.filter((s) => s.dataset?.page).forEach((s) => io.observe(s));
    const target = slots[start];
    if (target && start) target.scrollIntoView({ block: 'start' });
  }

  async function draw(slot, width) {
    const doc = await loadDoc(slot.dataset.file);
    const page = await doc.getPage(Number(slot.dataset.page));
    const base = page.getViewport({ scale: 1 });
    let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
    if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    if (closed) return;
    slot.style.height = '';
    slot.replaceChildren(canvas);
  }

  function setZoom(next) {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, next));
    if (z === zoom) return;
    const rel = body.scrollTop / Math.max(1, body.scrollHeight);
    zoom = z;
    build().then(() => {
      body.scrollTop = rel * body.scrollHeight;
    });
  }

  await build();
}

/** Klicks auf [data-view-letter] / [data-view-file] überall in der App öffnen die Vollbild-Ansicht. */
export function installViewerLinks() {
  // Blätter-Vorschau angetippt (pdfview.js): Vollbild an dieser Seite
  document.addEventListener('bp:open-page', (e) => {
    const box = e.target.closest?.('[data-pager]');
    let files = [];
    try {
      files = JSON.parse(box?.dataset.files || '[]');
    } catch {
      files = [];
    }
    if (files.length) openViewer({ files, start: e.detail?.start || 0 });
    else if (box?.dataset.letter) openViewer({ letterId: box.dataset.letter, start: e.detail?.start || 0 });
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-view-letter], [data-view-file]');
    if (!el || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (el.dataset.viewFile) openViewer({ files: [{ id: el.dataset.viewFile, kind: el.dataset.kind || 'pdf' }], title: el.dataset.title || '' });
    else openViewer({ letterId: el.dataset.viewLetter, title: el.dataset.title || '', start: Number(el.dataset.start || 0) });
  });
}
