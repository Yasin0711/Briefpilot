// PDF-Seiten als Bilder anzeigen – passend zum Fenster, ohne Zoomen.
// Nutzt pdf.js (Mozilla, Apache-2.0) aus /vendor/pdfjs/. Wird erst geladen, wenn ein PDF sichtbar ist.
// Gerendert wird nur, was ins Bild kommt (bei sehr langen PDFs wichtig).
import { scroller } from './ui.js';

const BASE = '/vendor/pdfjs/';
const MAX_PAGES_SHOWN = 300;
const MAX_CANVAS_PIXELS = 8_000_000; // iPhone verkraftet keine riesigen Zeichenflächen

let libPromise = null;
const docs = new Map(); // fileId → Promise<PDFDocumentProxy>
const rendered = new Map(); // `${fileId}:${page}` → { canvas, width }

function lib() {
  if (!libPromise) {
    libPromise = import(`${BASE}pdf.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.mjs`;
      return m;
    });
  }
  return libPromise;
}

export function loadDoc(fileId) {
  if (!docs.has(fileId)) {
    const p = lib().then((m) => m.getDocument({
      url: `/api/files/${fileId}`,
      withCredentials: true,
      isEvalSupported: false, // keine dynamische Code-Erzeugung (passt zur Sicherheitsrichtlinie)
      enableXfa: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      standardFontDataUrl: `${BASE}standard_fonts/`,
    }).promise);
    p.catch(() => docs.delete(fileId));
    docs.set(fileId, p);
  }
  return docs.get(fileId);
}

/** Verfügbare Höhe im Fenster, damit eine ganze Seite auf einmal sichtbar ist. */
export function availableHeight() {
  const h = scroller()?.clientHeight || window.innerHeight;
  const bar = document.querySelector('.file-bar');
  const covered = bar && getComputedStyle(bar).position === 'fixed' && bar.getBoundingClientRect().top < window.innerHeight ? bar.offsetHeight : 0;
  return Math.max(260, h - covered - 24);
}

/** Breite, mit der eine Seite (Seitenverhältnis ratio = Höhe/Breite) komplett ins Fenster passt. */
export function fitWidth(containerWidth, ratio) {
  return Math.floor(Math.min(containerWidth, availableHeight() / ratio));
}

async function renderPage(doc, fileId, pageNo, slot) {
  const width = fitWidth(slot.parentElement.clientWidth || 320, Number(slot.dataset.ratio) || 1.414);
  const key = `${fileId}:${pageNo}`;
  const cached = rendered.get(key);
  if (cached && Math.abs(cached.width - width) < 8) {
    slot.replaceChildren(cached.canvas);
    slot.style.width = `${width}px`;
    slot.style.height = '';
    return;
  }
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const ratio = base.height / base.width;
  const cssWidth = fitWidth(slot.parentElement.clientWidth || 320, ratio);
  let scale = (cssWidth / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
  if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Seite ${pageNo}`);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  page.cleanup();
  rendered.set(key, { canvas, width: cssWidth });
  slot.dataset.ratio = String(ratio);
  slot.style.width = `${cssWidth}px`;
  slot.style.height = '';
  slot.replaceChildren(canvas);
}

/**
 * Ersetzt alle [data-pdf-view]-Platzhalter in root durch die Seiten des PDFs.
 * Fällt auf den Link „PDF öffnen“ zurück, wenn das PDF nicht dargestellt werden kann.
 */
export function hydratePdfViews(root) {
  // Fotos passen per CSS (--view-h) ebenfalls komplett ins Fenster
  document.documentElement.style.setProperty('--view-h', `${availableHeight()}px`);
  const boxes = [...root.querySelectorAll('[data-pdf-view]')].filter((b) => b.offsetParent !== null);
  if (!boxes.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      const slot = entry.target;
      const fileId = slot.closest('[data-pdf-view]').dataset.pdfView;
      loadDoc(fileId)
        .then((doc) => renderPage(doc, fileId, Number(slot.dataset.page), slot))
        .catch(() => slot.classList.add('is-error'));
    }
  }, { root: scroller(), rootMargin: '600px 0px' });

  for (const box of boxes) {
    const fileId = box.dataset.pdfView;
    loadDoc(fileId).then(async (doc) => {
      if (!box.isConnected) return;
      const first = await doc.getPage(1);
      const v = first.getViewport({ scale: 1 });
      const ratio = v.height / v.width;
      const count = Math.min(doc.numPages, MAX_PAGES_SHOWN);
      const w = fitWidth(box.clientWidth || 320, ratio);
      const slots = [];
      for (let n = 1; n <= count; n++) {
        const slot = document.createElement('div');
        slot.className = 'pdf-page';
        slot.dataset.page = String(n);
        slot.dataset.ratio = String(ratio);
        const cached = rendered.get(`${fileId}:${n}`);
        if (cached) {
          slot.style.width = `${cached.width}px`;
          slot.append(cached.canvas);
        } else {
          slot.style.width = `${w}px`;
          slot.style.height = `${Math.round(w * ratio)}px`;
        }
        slots.push(slot);
      }
      box.replaceChildren(...slots);
      box.classList.add('is-ready');
      for (const s of slots) io.observe(s);
    }).catch(() => {
      box.classList.add('is-error');
    });
  }
}

// ---------- Kleine Vorschau der ersten Seite (Briefliste) ----------
// Erst versucht der Server ein Vorschaubild (Foto bzw. eingebettetes Scan-Bild). Gibt es keins
// (z. B. digital erstelltes PDF), zeichnet pdf.js die erste Seite – nur bei nicht zu großen Dateien.
const THUMB_MAX_BYTES = 8 * 1024 * 1024;
const thumbCache = new Map(); // fileId → dataURL
let thumbQueue = Promise.resolve();

function renderPdfThumb(fileId, width = 160) {
  if (thumbCache.has(fileId)) return Promise.resolve(thumbCache.get(fileId));
  // nacheinander, damit das Telefon nicht mehrere PDFs gleichzeitig lädt
  const job = thumbQueue.then(async () => {
    const m = await lib();
    const doc = await m.getDocument({
      url: `/api/files/${fileId}`, withCredentials: true, isEvalSupported: false, enableXfa: false,
      disableRange: true, disableStream: true, disableAutoFetch: true, standardFontDataUrl: `${BASE}standard_fonts/`,
    }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.8);
      thumbCache.set(fileId, url);
      return url;
    } finally {
      doc.destroy();
    }
  });
  thumbQueue = job.catch(() => {});
  return job;
}

/**
 * Einmal beim Start: Vorschaubilder [data-letter-thumb] überall in der App behandeln.
 * Fehlt das Server-Vorschaubild, zeichnet pdf.js die erste Seite (nur PDFs bis 8 MB).
 */
export function installLetterThumbs() {
  document.addEventListener('load', (e) => {
    if (e.target.matches?.('img[data-letter-thumb]')) e.target.closest('.letter-thumb')?.classList.add('is-loaded');
  }, true);
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img.matches?.('img[data-letter-thumb]') || img.dataset.fallback) return;
    img.dataset.fallback = '1';
    const { fileId, kind, size } = img.dataset;
    if (kind !== 'pdf' || Number(size) > THUMB_MAX_BYTES) return;
    renderPdfThumb(fileId).then((url) => {
      if (img.isConnected) img.src = url;
    }).catch(() => {});
  }, true);
}

/** Bereits gezeichnete Vorschau sofort verwenden (kein erneuter Server-Versuch). */
export function cachedThumb(fileId) {
  return thumbCache.get(fileId) || null;
}

// ---------- Briefvorschau zum Blättern (eine Seite, ‹ › und Antippen = Vollbild) ----------
// Zeigt das Original unverändert an: Es wird nur gezeichnet, an der Datei ändert sich nichts.

/** Liste aller Seiten eines Briefes: [{ fileId, kind, page }] – PDFs werden dafür kurz geöffnet. */
async function pageList(files) {
  const pages = [];
  for (const f of files) {
    if (f.kind === 'image') pages.push({ fileId: f.id, kind: 'image', page: 1 });
    else if (f.kind === 'pdf') {
      try {
        const doc = await loadDoc(f.id);
        for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES_SHOWN); n++) pages.push({ fileId: f.id, kind: 'pdf', page: n });
      } catch {
        pages.push({ fileId: f.id, kind: 'pdf', page: 1, failed: true });
      }
    }
  }
  return pages;
}

const pagerState = new Map(); // Brief-ID → zuletzt gezeigte Seite (bleibt beim Neuzeichnen erhalten)

/**
 * Baut die Blätter-Vorschau in [data-pager]-Container (data-letter = Brief-ID, data-files = JSON der Dateien).
 * Meldet die aktuelle Seite über data-current (für „Seite löschen“).
 */
export function hydratePagers(root) {
  for (const box of root.querySelectorAll('[data-pager]')) {
    if (box.dataset.ready) continue;
    box.dataset.ready = '1';
    const letterId = box.dataset.letter;
    let files = [];
    try {
      files = JSON.parse(box.dataset.files || '[]');
    } catch {
      files = [];
    }
    const stage = box.querySelector('[data-pager-stage]');
    const label = box.querySelector('[data-pager-label]');
    const prev = box.querySelector('[data-pager-prev]');
    const next = box.querySelector('[data-pager-next]');
    let pages = [];
    let index = pagerState.get(letterId) || 0;

    async function show() {
      if (!pages.length) return;
      index = Math.max(0, Math.min(index, pages.length - 1));
      pagerState.set(letterId, index);
      const p = pages[index];
      box.dataset.current = p.fileId;
      label.textContent = pages.length > 1 ? `${index + 1} von ${pages.length}` : '1 Seite';
      label.setAttribute('aria-label', `Seite ${index + 1} von ${pages.length}`);
      prev.disabled = index === 0;
      next.disabled = index === pages.length - 1;
      const width = Math.max(200, stage.clientWidth || 320);
      if (p.kind === 'image') {
        const img = document.createElement('img');
        img.src = `/api/files/${p.fileId}`;
        img.alt = `Seite ${index + 1}`;
        stage.replaceChildren(img);
        return;
      }
      if (p.failed) {
        stage.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Vorschau nicht möglich – antippen öffnet die Datei.' }));
        return;
      }
      const doc = await loadDoc(p.fileId);
      const page = await doc.getPage(p.page);
      const base = page.getViewport({ scale: 1 });
      let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
      if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Seite ${index + 1}`);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup();
      if (pages[index] === p) stage.replaceChildren(canvas);
    }

    prev.addEventListener('click', () => {
      index--;
      show().catch(() => {});
    });
    next.addEventListener('click', () => {
      index++;
      show().catch(() => {});
    });
    // Antippen der Seite: Vollbild mit Zoom, an genau dieser Seite
    stage.addEventListener('click', () => {
      stage.closest('[data-pager]')?.dispatchEvent(new CustomEvent('bp:open-page', { bubbles: true, detail: { start: index } }));
    });
    // Wischen nach links/rechts blättert
    let x0 = null;
    stage.addEventListener('touchstart', (e) => {
      x0 = e.touches[0]?.clientX ?? null;
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
      x0 = null;
      if (Math.abs(dx) > 50) {
        index += dx < 0 ? 1 : -1;
        show().catch(() => {});
      }
    });
    // Ohne Dateiliste (z. B. im Eingang): Seiten des Briefes nachladen
    const filesReady = files.length ? Promise.resolve(files) : fetch(`/api/letters/${encodeURIComponent(letterId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((d) => (d.files || []).filter((f) => f.role !== 'original').map((f) => ({ id: f.id, kind: f.kind })));
    filesReady.then((fl) => {
      files = fl;
      box.dataset.files = JSON.stringify(fl);
      return pageList(fl);
    }).then((list) => {
      pages = list;
      if (!pages.length) {
        label.textContent = 'Keine Vorschau';
        stage.replaceChildren();
        return;
      }
      show().catch(() => {});
    });
  }
}
