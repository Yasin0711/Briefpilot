// QR-Codes im Brief finden (z. B. „Hier online antworten“) und als Website-Link in den Angaben zeigen,
// damit niemand den Code mit dem Handy abscannen muss. Die Erkennung läuft einmal je Brief im Browser;
// das Ergebnis speichert der Server (leere Liste = geprüft, nichts gefunden).
import { api } from './api.js';
import { loadDoc } from './pdfview.js';

const MAX_PAGES = 6;
const SIDE = 1600; // Bildgröße für die Suche (lange Seite)
let worker = null;
let nextJob = 1;
const pendingJobs = new Map();
const running = new Set(); // Brief-IDs, die gerade geprüft werden

function getWorker() {
  if (!worker) {
    worker = new Worker('/js/qrworker.js');
    worker.onmessage = (e) => {
      const job = pendingJobs.get(e.data.id);
      pendingJobs.delete(e.data.id);
      job?.(e.data.codes || []);
    };
    worker.onerror = () => {
      for (const done of pendingJobs.values()) done([]);
      pendingJobs.clear();
    };
  }
  return worker;
}

function decode(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    const id = nextJob++;
    pendingJobs.set(id, resolve);
    getWorker().postMessage({ id, width, height, data }, [data.buffer]);
  });
}

function scaled(source, w, h) {
  const k = Math.min(1, SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imageCanvas(fileId) {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Datei nicht lesbar');
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = scaled(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  return canvas;
}

async function pdfCanvases(fileId, limit) {
  const doc = await loadDoc(fileId);
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, limit); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    out.push(canvas);
  }
  return out;
}

/** Nur Webadressen übernehmen (http/https, auch „www.…“ ohne Schema). */
export function toWebLink(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 600 || /\s/.test(raw)) return null;
  const withScheme = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Prüft die Seiten eines Briefs einmal auf QR-Codes und speichert gefundene Websites.
 * @returns {Promise<string[]|null>} Links oder null, wenn nicht geprüft wurde
 */
export async function scanLetterQr(letter, files) {
  if (!letter || letter.qrLinks || running.has(letter.id) || typeof Worker === 'undefined') return null;
  running.add(letter.id);
  try {
    const links = new Set();
    let pagesLeft = MAX_PAGES;
    for (const f of files.filter((x) => x.role !== 'original')) {
      if (pagesLeft <= 0) break;
      let canvases = [];
      try {
        if (f.kind === 'image') canvases = [await imageCanvas(f.id)];
        else if (f.kind === 'pdf') canvases = await pdfCanvases(f.id, pagesLeft);
      } catch {
        canvases = [];
      }
      pagesLeft -= Math.max(1, canvases.length);
      for (const c of canvases) {
        for (const code of await decode(c)) {
          const link = toWebLink(code);
          if (link) links.add(link);
        }
      }
    }
    const list = [...links].slice(0, 5);
    await api.post(`/api/letters/${letter.id}/qr`, { links: list });
    return list;
  } catch {
    return null;
  } finally {
    running.delete(letter.id);
  }
}
