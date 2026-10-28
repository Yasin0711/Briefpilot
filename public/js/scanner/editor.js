// Seiten-Editor: Ecken anpassen (mit Lupe), Ergebnis mit Filter ansehen, drehen, übernehmen.
// Bedienbar per Finger, Maus und Tastatur (Ecke auswählen, mit Pfeiltasten verschieben).
import { html, mount } from '../html.js';
import { icon } from '../ui.js';
import { FILTERS, detectCorners, renderPage, toCanvas } from './processing.js';
import { defaultCorners } from './imageproc.js';
import { trapBackButton, closeOnAbort } from './overlay.js';

const CORNER_LABELS = ['oben links', 'oben rechts', 'unten rechts', 'unten links'];

/**
 * @param {{ source: HTMLCanvasElement, corners?: Array, rotation?: number, filter?: string, detected?: boolean,
 *           title?: string, onSave: (r: {corners, rotation, filter}) => void, onCancel: () => void, onDelete?: () => void,
 *           signal?: AbortSignal }} options
 */
export function openEditor({ source, corners, rotation = 0, filter = 'farbe', detected = null, title = 'Seite bearbeiten', onSave, onCancel, onDelete, signal }) {
  const state = {
    step: 'zuschnitt',
    corners: (corners || defaultCorners()).map((p) => ({ ...p })),
    rotation,
    filter,
    detected,
    previewUrl: null,
    previewToken: 0,
  };
  const root = document.createElement('div');
  root.className = 'scanner scanner-editor';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', title);
  document.body.append(root);
  document.body.classList.add('scanner-open');
  const previousFocus = document.activeElement;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    window.removeEventListener('resize', layout);
    window.removeEventListener('keydown', onKey);
    releaseBack();
    root.remove();
    document.body.classList.remove('scanner-open');
    previousFocus?.focus?.();
  }
  // Zurück-Taste: wie „Abbrechen“; Seitenwechsel schließt den Editor ohne Rückfrage
  const releaseBack = trapBackButton(() => {
    close();
    onCancel?.();
  });
  closeOnAbort(signal, close);

  function onKey(e) {
    if (e.key === 'Escape') {
      close();
      onCancel?.();
    }
  }
  window.addEventListener('keydown', onKey);

  function draw() {
    if (state.step === 'zuschnitt') {
      mount(root, html`
        <div class="scanner-top">
          <button class="scanner-icon" type="button" data-cancel aria-label="Abbrechen">${icon('x')}</button>
          <span class="scanner-title">Zuschnitt</span>
          ${onDelete ? html`<button class="scanner-icon" type="button" data-delete aria-label="Seite löschen">${icon('trash')}</button>` : html`<span></span>`}
        </div>
        <div class="scanner-stage editor-stage" data-stage>
          <canvas class="editor-image" data-image aria-label="Foto der Seite"></canvas>
          <svg class="editor-quad" data-quad aria-hidden="true"><path data-path></path></svg>
          ${state.corners.map((_, i) => html`<button class="editor-handle" type="button" data-handle="${i}" aria-label="Ecke ${CORNER_LABELS[i]} – mit Pfeiltasten verschieben"></button>`)}
          <canvas class="editor-loupe" data-loupe width="140" height="140" hidden aria-hidden="true"></canvas>
          <p class="scanner-hint" aria-live="polite">${state.detected === false
            ? 'Die Blattkanten wurden nicht sicher erkannt. Ziehen Sie die vier Punkte auf die Ecken des Blattes.'
            : 'Ziehen Sie die Punkte auf die Ecken des Blattes, falls nötig.'}</p>
        </div>
        <div class="scanner-bottom editor-tools">
          <button class="scanner-chip" type="button" data-detect>${icon('spark')}<span>Automatisch</span></button>
          <button class="scanner-chip" type="button" data-full>${icon('maximize')}<span>Ganzes Bild</span></button>
          <button class="btn btn-scan" type="button" data-next>Weiter${icon('chevronRight')}</button>
        </div>`);
      layout();
      root.querySelector('[data-next]').focus();
    } else {
      mount(root, html`
        <div class="scanner-top">
          <button class="scanner-icon" type="button" data-back aria-label="Zurück zum Zuschnitt">${icon('chevronLeft')}</button>
          <span class="scanner-title">Ergebnis</span>
          <span class="row">
            <button class="scanner-icon" type="button" data-rotate="-90" aria-label="Nach links drehen">${icon('rotateLeft')}</button>
            <button class="scanner-icon" type="button" data-rotate="90" aria-label="Nach rechts drehen">${icon('rotateRight')}</button>
          </span>
        </div>
        <div class="scanner-stage editor-stage" data-stage>
          <img class="editor-preview" data-preview alt="Vorschau der gescannten Seite" ${state.previewUrl ? html`src="${state.previewUrl}"` : ''}>
          <span class="spinner editor-spinner" data-spinner aria-hidden="true" hidden></span>
        </div>
        <div class="scanner-bottom editor-tools editor-filters">
          <div class="chips chips-dark" role="radiogroup" aria-label="Bildverbesserung">
            ${FILTERS.map((f) => html`<button class="scanner-chip" type="button" role="radio" data-filter="${f.id}" aria-checked="${state.filter === f.id}">${f.label}</button>`)}
          </div>
          <button class="btn btn-scan" type="button" data-save>${icon('check')}Seite übernehmen</button>
        </div>`);
      renderPreview();
      root.querySelector('[data-save]').focus();
    }
  }

  // ---------- Zuschnitt ----------

  function imageRect() {
    const stage = root.querySelector('[data-stage]');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight - 8;
    const scale = Math.min(sw / source.width, sh / source.height);
    return { x: (sw - source.width * scale) / 2, y: (sh - source.height * scale) / 2 + 4, w: source.width * scale, h: source.height * scale };
  }

  function layout() {
    if (closed || state.step !== 'zuschnitt') return;
    const r = imageRect();
    const canvas = root.querySelector('[data-image]');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.w * dpr);
    canvas.height = Math.round(r.h * dpr);
    canvas.style.left = `${r.x}px`;
    canvas.style.top = `${r.y}px`;
    canvas.style.width = `${r.w}px`;
    canvas.style.height = `${r.h}px`;
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    updateQuad();
  }

  function updateQuad() {
    const r = imageRect();
    const pts = state.corners.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    const svg = root.querySelector('[data-quad]');
    const stage = root.querySelector('[data-stage]');
    svg.setAttribute('viewBox', `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
    root.querySelector('[data-path]').setAttribute('d', `M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`);
    root.querySelectorAll('[data-handle]').forEach((h, i) => {
      h.style.left = `${pts[i].x}px`;
      h.style.top = `${pts[i].y}px`;
    });
  }

  function showLoupe(i, clientX, clientY) {
    const loupe = root.querySelector('[data-loupe]');
    const stage = root.querySelector('[data-stage]').getBoundingClientRect();
    loupe.hidden = false;
    // Lupe über dem Finger, am Rand nach innen versetzt
    const lx = Math.min(stage.width - 150, Math.max(10, clientX - stage.left - 70));
    const ly = Math.max(10, clientY - stage.top - 190);
    loupe.style.left = `${lx}px`;
    loupe.style.top = `${ly}px`;
    const ctx = loupe.getContext('2d');
    const p = state.corners[i];
    const zoomW = source.width * 0.08;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 140, 140);
    ctx.drawImage(source, p.x * source.width - zoomW / 2, p.y * source.height - zoomW / 2, zoomW, zoomW, 0, 0, 140, 140);
    ctx.strokeStyle = '#FFCC00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(70, 50);
    ctx.lineTo(70, 90);
    ctx.moveTo(50, 70);
    ctx.lineTo(90, 70);
    ctx.stroke();
  }

  let dragging = null;
  root.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-handle]');
    if (!handle || state.step !== 'zuschnitt') return;
    e.preventDefault();
    dragging = Number(handle.dataset.handle);
    handle.setPointerCapture(e.pointerId);
    showLoupe(dragging, e.clientX, e.clientY);
  });
  root.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    const r = imageRect();
    const stage = root.querySelector('[data-stage]').getBoundingClientRect();
    const x = (e.clientX - stage.left - r.x) / r.w;
    const y = (e.clientY - stage.top - r.y) / r.h;
    state.corners[dragging] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    updateQuad();
    showLoupe(dragging, e.clientX, e.clientY);
  });
  const endDrag = () => {
    if (dragging === null) return;
    dragging = null;
    const loupe = root.querySelector('[data-loupe]');
    if (loupe) loupe.hidden = true;
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('keydown', (e) => {
    const handle = e.target.closest?.('[data-handle]');
    if (!handle) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = Number(handle.dataset.handle);
    const p = state.corners[i];
    state.corners[i] = { x: Math.min(1, Math.max(0, p.x + d[0])), y: Math.min(1, Math.max(0, p.y + d[1])) };
    updateQuad();
  });

  // ---------- Ergebnis ----------

  let previewSource = null;
  async function renderPreview() {
    const token = ++state.previewToken;
    const spinner = root.querySelector('[data-spinner]');
    if (spinner) spinner.hidden = false;
    try {
      // Vorschau aus einer kleineren Kopie berechnen (schnell); die endgültige Seite entsteht in voller Auflösung
      previewSource = previewSource || toCanvas(source, 1500);
      const preview = await renderPage(previewSource, { corners: state.corners, filter: state.filter, rotation: state.rotation, maxSide: 1100, quality: 0.8 });
      URL.revokeObjectURL(preview.thumbUrl);
      if (closed || token !== state.previewToken) return;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(preview.blob);
      const img = root.querySelector('[data-preview]');
      if (img) img.src = state.previewUrl;
    } catch (err) {
      const hint = document.createElement('p');
      hint.className = 'scanner-hint';
      hint.textContent = err.message;
      root.querySelector('[data-stage]')?.append(hint);
    } finally {
      if (token === state.previewToken && spinner) spinner.hidden = true;
    }
  }

  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-cancel]')) {
      close();
      onCancel?.();
    } else if (t.closest('[data-delete]')) {
      close();
      onDelete?.();
    } else if (t.closest('[data-full]')) {
      state.corners = defaultCorners(0);
      updateQuad();
    } else if (t.closest('[data-detect]')) {
      const found = await detectCorners(source).catch(() => null);
      state.detected = Boolean(found);
      state.corners = found ? found.corners : defaultCorners();
      const hint = root.querySelector('.scanner-hint');
      if (hint) hint.textContent = found ? 'Blattkanten erkannt.' : 'Keine Blattkanten erkannt – bitte die Punkte selbst setzen.';
      updateQuad();
    } else if (t.closest('[data-next]')) {
      state.step = 'ergebnis';
      draw();
    } else if (t.closest('[data-back]')) {
      state.step = 'zuschnitt';
      draw();
    } else if (t.closest('[data-rotate]')) {
      state.rotation = (state.rotation + Number(t.closest('[data-rotate]').dataset.rotate) + 360) % 360;
      renderPreview();
    } else if (t.closest('[data-filter]')) {
      state.filter = t.closest('[data-filter]').dataset.filter;
      root.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.filter === state.filter)));
      renderPreview();
    } else if (t.closest('[data-save]')) {
      close();
      onSave?.({ corners: state.corners, rotation: state.rotation, filter: state.filter });
    }
  });

  window.addEventListener('resize', layout);
  draw();
}
