// Scanner-Bildverarbeitung mit künstlichen Fotos: Blattkanten erkennen (dunkler, farbiger und
// heller Untergrund, schräg fotografiert), Perspektive entzerren, Schatten entfernen, Fingerabdruck
// (dient der Kamera nur zum Erkennen, ob eine neue Seite im Bild liegt).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDocument, warpPerspective, enhance, differenceHash, hashDistance, homography, outputSize, defaultCorners,
} from '../public/js/scanner/imageproc.js';
import { hashDistance as serverHashDistance } from '../server/domain/duplicates.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Erzeugt ein „Foto“: Blatt (mit Textzeilen) als Viereck auf einem Untergrund. */
function photo({ w = 400, h = 460, corners, background, paper = [238, 236, 230], shading = 0, noise = 8, seed = 1, textTone = 35 }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const dst = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const H = homography(corners, dst); // Bild → Blattkoordinaten
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + H[8];
      const u = (H[0] * x + H[1] * y + H[2]) / den;
      const v = (H[3] * x + H[4] * y + H[5]) / den;
      const n = (rand() - 0.5) * noise;
      let rgb;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const shade = 1 - shading * u; // Schatten von links nach rechts
        const line = v > 0.12 && v < 0.85 && ((v * 40) % 1) < 0.35 && u > 0.1 && u < 0.85 && ((u * 13) % 1) < 0.8;
        rgb = line ? [textTone, textTone, textTone] : paper.map((c) => c * shade);
      } else {
        rgb = typeof background === 'function' ? background(x, y) : background;
      }
      const o = (y * w + x) * 4;
      data[o] = rgb[0] + n;
      data[o + 1] = rgb[1] + n;
      data[o + 2] = rgb[2] + n;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function cornerError(found, truth, w, h) {
  return Math.max(...found.map((p, i) => Math.hypot(p.x * w - truth[i].x, p.y * h - truth[i].y) / Math.max(w, h)));
}

const tilted = [{ x: 70, y: 48 }, { x: 335, y: 72 }, { x: 318, y: 415 }, { x: 52, y: 392 }];

test('Blattkanten auf dunklem Tisch, schräg fotografiert', () => {
  const img = photo({ corners: tilted, background: [52, 48, 46] });
  const found = detectDocument(img);
  assert.ok(found, 'Blatt erkannt');
  assert.ok(cornerError(found.corners, tilted, img.width, img.height) < 0.03, `Ecken genau (Fehler ${cornerError(found.corners, tilted, img.width, img.height)})`);
  assert.ok(found.confidence > 0.4);
});

test('Blattkanten auf Holz (farbiger Untergrund)', () => {
  const corners = [{ x: 40, y: 30 }, { x: 360, y: 40 }, { x: 370, y: 430 }, { x: 30, y: 420 }];
  const wood = (x, y) => [150 + 20 * Math.sin(y / 9), 100 + 12 * Math.sin(y / 9), 60];
  const img = photo({ corners, background: wood, seed: 3 });
  const found = detectDocument(img);
  assert.ok(found);
  assert.ok(cornerError(found.corners, corners, img.width, img.height) < 0.03);
});

test('Blattkanten auf hellem Untergrund (über die Kantenerkennung)', () => {
  const corners = [{ x: 90, y: 60 }, { x: 320, y: 50 }, { x: 330, y: 400 }, { x: 80, y: 410 }];
  // Heller, leicht grauer Tisch – das Blatt ist nur etwas heller; harte Kante durch leichten Schattenwurf
  const img = photo({ corners, background: [196, 196, 198], paper: [246, 246, 244], noise: 6, seed: 5 });
  const found = detectDocument(img);
  assert.ok(found, 'auch auf hellem Untergrund erkannt');
  assert.ok(cornerError(found.corners, corners, img.width, img.height) < 0.035, `Fehler ${cornerError(found.corners, corners, img.width, img.height)}`);
});

test('Kein Blatt im Bild → keine erfundenen Ecken', () => {
  const rand = rng(9);
  const w = 300;
  const h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = 90 + rand() * 60;
    data.set([v, v * 0.9, v * 0.8, 255], i * 4);
  }
  const found = detectDocument({ width: w, height: h, data });
  assert.ok(!found || found.confidence < 0.2, 'nichts oder sehr unsicher');
  assert.equal(defaultCorners().length, 4);
});

test('Perspektive entzerren: Inhalte landen an der richtigen Stelle', () => {
  const img = photo({ corners: tilted, background: [52, 48, 46], textTone: 20 });
  const rel = tilted.map((p) => ({ x: p.x / (img.width - 1), y: p.y / (img.height - 1) }));
  const size = outputSize(rel, img.width, img.height, 600);
  assert.ok(Math.abs(size.height / size.width - Math.SQRT2) < 0.01, 'nahe A4 → A4-Seitenverhältnis');
  const out = warpPerspective(img, rel, 300, 424);
  const at = (u, v) => {
    const x = Math.round(u * 299);
    const y = Math.round(v * 423);
    return out.data[(y * 300 + x) * 4];
  };
  assert.ok(at(0.05, 0.05) > 180, 'Ecke des Blattes ist Papier');
  assert.ok(at(0.95, 0.95) > 180);
  // Textzeile: v in einer dunklen Zeile, u im Textbereich
  let dark = 0;
  for (let u = 0.12; u < 0.8; u += 0.01) if (at(u, 0.130) < 100) dark++;
  assert.ok(dark > 20, `Textzeile erhalten (${dark})`);
});

test('Bildverbesserung entfernt Schatten, Schrift bleibt dunkel', () => {
  const corners = [{ x: 0, y: 0 }, { x: 399, y: 0 }, { x: 399, y: 459 }, { x: 0, y: 459 }];
  const img = photo({ corners, background: [0, 0, 0], shading: 0.45, noise: 4, textTone: 30 });
  const stats = (im) => {
    let paperMin = 255;
    let paperSum = 0;
    let paperN = 0;
    for (let y = 5; y < im.height - 5; y += 3) {
      const v = y / im.height;
      if (v > 0.12 && v < 0.85) continue; // nur Ränder ohne Text
      for (let x = 5; x < im.width - 5; x += 3) {
        const val = im.data[(y * im.width + x) * 4];
        paperMin = Math.min(paperMin, val);
        paperSum += val;
        paperN++;
      }
    }
    return { paperMin, paperMean: paperSum / paperN };
  };
  const before = stats(img);
  assert.ok(before.paperMin < 150, 'Ausgangsbild hat deutlichen Schatten');
  for (const mode of ['farbe', 'grau', 'sw']) {
    const out = enhance(img, mode);
    const after = stats(out);
    assert.ok(after.paperMin > 200, `${mode}: Schatten entfernt (min ${after.paperMin})`);
    // Schrift im hellen und im schattigen Bereich bleibt dunkel
    const text = (u) => {
      for (let y = Math.round(0.13 * img.height); y < 0.85 * img.height; y++) {
        const v = y / img.height;
        if (((v * 40) % 1) >= 0.35) continue;
        const x = Math.round(u * img.width);
        if (((u * 13) % 1) >= 0.8) continue;
        return out.data[(y * img.width + x) * 4];
      }
      return null;
    };
    assert.ok(text(0.15) < 110, `${mode}: Schrift links dunkel (${text(0.15)})`);
    assert.ok(text(0.8) < 110, `${mode}: Schrift im Schatten dunkel (${text(0.8)})`);
  }
  assert.equal(enhance(img, 'original'), img);
});

test('Fingerabdruck (Kamera): gleiches Bild anders belichtet ähnlich, anderes Bild verschieden', () => {
  const a = photo({ corners: tilted, background: [52, 48, 46], seed: 1 });
  const brighter = { ...a, data: a.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v * 1.08 + 6))) };
  const other = photo({ corners: [{ x: 20, y: 20 }, { x: 380, y: 30 }, { x: 370, y: 300 }, { x: 30, y: 290 }], background: [200, 60, 60], seed: 7 });
  const ha = differenceHash(a);
  assert.match(ha, /^[0-9a-f]{16}$/);
  assert.ok(hashDistance(ha, differenceHash(brighter)) <= 6);
  assert.ok(hashDistance(ha, differenceHash(other)) > 12);
  // Browser- und Server-Berechnung stimmen überein
  assert.equal(hashDistance(ha, differenceHash(other)), serverHashDistance(ha, differenceHash(other)));
  assert.equal(hashDistance(ha, 'kein-hash'), 64);
});
