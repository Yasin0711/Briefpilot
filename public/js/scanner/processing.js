// Verbindung zwischen Oberfläche (Canvas, Blobs) und Bildverarbeitung (imageproc.js).
// Rechenintensives läuft in einem Hintergrund-Thread; ohne Unterstützung im Hauptthread.
import * as imageproc from './imageproc.js';

export const MAX_SOURCE_SIDE = 3000; // Fotos werden vor der Verarbeitung auf diese Größe begrenzt (Speicher)
export const MAX_PAGE_SIDE = 2000; // gescannte Seite: ca. 170 dpi bei A4 – gut lesbar für Mensch und KI
export const FILTERS = [
  { id: 'farbe', label: 'Verbessert' },
  { id: 'grau', label: 'Graustufen' },
  { id: 'sw', label: 'Schwarzweiß' },
  { id: 'original', label: 'Original' },
];

let worker = null;
let workerBroken = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker('/js/scanner/worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const [, p] of pending) p.reject(new Error('worker'));
      pending.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

async function run(op, payload, transfer = []) {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, op, ...payload }, transfer);
      });
    } catch (err) {
      if (err.message !== 'worker') throw err;
      // Hintergrund-Thread nicht verfügbar → im Hauptthread weiterrechnen
    }
  }
  if (op === 'detect') return imageproc.detectDocument(payload.img);
  const warped = imageproc.warpPerspective(payload.img, payload.corners, payload.outW, payload.outH);
  return imageproc.enhance(warped, payload.filter);
}

// ---------- Canvas-Hilfen ----------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Lädt ein Bild (Datei/Blob) mit richtiger Ausrichtung (EXIF). */
export async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Dieses Bild kann Ihr Browser nicht öffnen (zum Beispiel das iPhone-Format HEIC). Bitte fotografieren Sie direkt mit „Kamera öffnen“.'));
      };
      img.src = url;
    });
  }
}

/** Zeichnet eine Bildquelle in ein Canvas, längste Seite höchstens maxSide. */
export function toCanvas(source, maxSide = MAX_SOURCE_SIDE) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = makeCanvas(w * scale, h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function imageDataOf(canvas, maxSide = null) {
  const src = maxSide && Math.max(canvas.width, canvas.height) > maxSide ? toCanvas(canvas, maxSide) : canvas;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
  return { width: d.width, height: d.height, data: d.data };
}

export function canvasFromImageData(img) {
  const canvas = makeCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
  return canvas;
}

export function rotateCanvas(canvas, degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (!d) return canvas;
  const swap = d === 90 || d === 270;
  const out = makeCanvas(swap ? canvas.height : canvas.width, swap ? canvas.width : canvas.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Das Bild konnte nicht gespeichert werden.'))), type, quality);
  });
}

// ---------- Erkennen und Verarbeiten ----------

/** Blattecken in einem Canvas finden (relativ 0–1) oder null. */
export async function detectCorners(canvas) {
  const img = imageDataOf(canvas, 360);
  // Daten werden kopiert (nicht übertragen), damit bei einem Fehler im Hintergrund-Thread weitergerechnet werden kann
  const result = await run('detect', { img });
  return result || null;
}

/**
 * Erzeugt aus einem Foto die fertige Seite: zuschneiden, entzerren, verbessern, drehen.
 * @returns {{ blob, width, height, hash, thumbUrl }}
 */
export async function renderPage(sourceCanvas, { corners, filter = 'farbe', rotation = 0, maxSide = MAX_PAGE_SIDE, quality = 0.85 }) {
  const size = imageproc.outputSize(corners, sourceCanvas.width, sourceCanvas.height, maxSide);
  const img = imageDataOf(sourceCanvas);
  const out = await run('process', { img, corners, outW: size.width, outH: size.height, filter });
  const canvas = rotateCanvas(canvasFromImageData(out), rotation);
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  const small = toCanvas(canvas, 64);
  const hash = imageproc.differenceHash(imageDataOf(small));
  const thumb = await canvasToBlob(toCanvas(canvas, 360), 'image/jpeg', 0.75);
  return { blob, width: canvas.width, height: canvas.height, hash, thumbUrl: URL.createObjectURL(thumb), canvas };
}

/** Originalaufnahme ohne Standortdaten (neu kodiert), für die optionale Aufbewahrung. */
export async function cleanOriginal(sourceCanvas) {
  return canvasToBlob(toCanvas(sourceCanvas, MAX_SOURCE_SIDE), 'image/jpeg', 0.9);
}

export { imageproc };
