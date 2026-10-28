// Hintergrund-Thread für die Bildverarbeitung, damit Kamera und Bedienung flüssig bleiben.
import { detectDocument, warpPerspective, enhance } from './imageproc.js';

self.onmessage = (event) => {
  const { id, op } = event.data;
  try {
    if (op === 'detect') {
      self.postMessage({ id, result: detectDocument(event.data.img) });
    } else if (op === 'process') {
      const { img, corners, outW, outH, filter } = event.data;
      const warped = warpPerspective(img, corners, outW, outH);
      const out = enhance(warped, filter);
      self.postMessage({ id, result: { width: out.width, height: out.height, data: out.data } }, [out.data.buffer]);
    } else {
      self.postMessage({ id, error: 'Unbekannte Aufgabe' });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || 'Bildverarbeitung fehlgeschlagen' });
  }
};
