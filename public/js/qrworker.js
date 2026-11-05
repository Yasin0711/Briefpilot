// Sucht QR-Codes in einem Seitenbild (läuft im Hintergrund, damit die Ansicht flüssig bleibt).
// jsQR findet je Aufruf einen Code – darum zusätzlich in überlappenden Ausschnitten suchen.
/* global jsQR */
importScripts('/vendor/jsqr/jsQR.js');

function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

self.onmessage = (e) => {
  const { id, width, height, data } = e.data;
  const img = { width, height, data };
  const found = new Set();
  const tryArea = (x, y, w, h) => {
    try {
      const res = jsQR(x === 0 && y === 0 && w === width && h === height ? data : crop(img, x, y, w, h), w, h, { inversionAttempts: 'dontInvert' });
      if (res?.data) found.add(res.data);
    } catch {
      /* Ausschnitt übersprungen */
    }
  };
  tryArea(0, 0, width, height);
  // 3 × 3 überlappende Ausschnitte (je halbe Breite/Höhe) für kleine oder mehrere Codes
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  for (let iy = 0; iy < 3; iy++) {
    for (let ix = 0; ix < 3; ix++) tryArea(Math.floor((ix * (width - w)) / 2), Math.floor((iy * (height - h)) / 2), w, h);
  }
  self.postMessage({ id, codes: [...found] });
};
