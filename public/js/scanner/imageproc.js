// Bildverarbeitung für den Dokumentenscanner – ohne Bibliotheken, ohne Browser-Funktionen,
// damit sie auf dem Gerät läuft (keine Übertragung von Rohbildern) und in Node getestet werden kann.
//
// Bildformat wie ImageData: { width, height, data: Uint8ClampedArray (RGBA) }
//
// 1. detectDocument(): findet die vier Blattecken – zwei Verfahren, das bessere gewinnt:
//    a) Helligkeit: Papier ist hell und farblos → größte helle Fläche → Hülle → Viereck
//    b) Kanten: Hough-Transformation findet gerade Blattkanten (auch bei hellem Untergrund)
// 2. warpPerspective(): entzerrt das Viereck zu einem geraden Rechteck (Perspektivkorrektur)
// 3. enhance(): entfernt Schatten und ungleichmäßige Beleuchtung, verbessert Kontrast
// 4. differenceHash(): 64-Bit-Fingerabdruck für die Erkennung doppelt gescannter Seiten

// ---------- Grundlagen ----------

/** Graustufen (Luminanz) und „Farbigkeit“ je Pixel. */
export function grayscale(img) {
  const n = img.width * img.height;
  const gray = new Float32Array(n);
  const chroma = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { gray, chroma };
}

/** Verkleinert ein RGBA-Bild durch Mittelwertbildung, längste Seite höchstens maxSide. */
export function downscale(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += img.data[p];
          g += img.data[p + 1];
          b += img.data[p + 2];
          c++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / c;
      out[o + 1] = g / c;
      out[o + 2] = b / c;
      out[o + 3] = 255;
    }
  }
  return { img: { width: w, height: h, data: out }, scale: w / img.width };
}

/** Box-Weichzeichner (zweimal angewendet ≈ Gauß), getrennt nach Zeilen und Spalten. */
export function boxBlur(src, w, h, radius) {
  if (radius < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / size;
      acc += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / size;
      acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

/** Schwellwert nach Otsu für Werte 0–255. */
export function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round(values[i])))]++;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

function sobel(gray, w, h) {
  const mag = new Float32Array(w * h);
  const ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
      ang[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, ang };
}

// ---------- Geometrie ----------

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Konvexe Hülle (Monotone Chain), Punkte {x, y}. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

const triArea = (a, b, c) => Math.abs(cross(a, b, c)) / 2;

/** Vereinfacht ein Polygon auf höchstens maxPoints Ecken (entfernt jeweils die unwichtigste Ecke). */
function simplify(poly, maxPoints) {
  const pts = [...poly];
  while (pts.length > maxPoints) {
    let minIdx = 0;
    let minArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = triArea(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]);
      if (a < minArea) {
        minArea = a;
        minIdx = i;
      }
    }
    pts.splice(minIdx, 1);
  }
  return pts;
}

/** Größtes Viereck aus den Ecken eines konvexen Polygons. */
export function largestQuad(hull) {
  const pts = simplify(hull, 40);
  const n = pts.length;
  if (n < 4) return null;
  let best = null;
  let bestArea = -1;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      let bj = -1;
      let aj = -1;
      for (let j = i + 1; j < k; j++) {
        const a = triArea(pts[i], pts[j], pts[k]);
        if (a > aj) {
          aj = a;
          bj = j;
        }
      }
      let bl = -1;
      let al = -1;
      for (let l = k + 1; l < n + i; l++) {
        const a = triArea(pts[k], pts[l % n], pts[i]);
        if (a > al) {
          al = a;
          bl = l % n;
        }
      }
      if (bj < 0 || bl < 0) continue;
      if (aj + al > bestArea) {
        bestArea = aj + al;
        best = [pts[i], pts[bj], pts[k], pts[bl]];
      }
    }
  }
  return best;
}

/** Sortiert vier Punkte: oben links, oben rechts, unten rechts, unten links. */
export function orderCorners(quad) {
  const c = quad.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
  const sorted = [...quad].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // Winkelreihenfolge beginnt links oben (Winkel um -135°)
  let start = 0;
  let bestScore = Infinity;
  sorted.forEach((p, i) => {
    const s = p.x + p.y;
    if (s < bestScore) {
      bestScore = s;
      start = i;
    }
  });
  const ordered = [];
  for (let i = 0; i < 4; i++) ordered.push(sorted[(start + i) % 4]);
  return ordered.map((p) => ({ x: p.x, y: p.y }));
}

function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function cornerAngles(q) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4];
    const b = q[i];
    const c = q[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return out;
}

function insideQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], { x, y });
    const s = Math.sign(c);
    if (s === 0) continue;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * Typische Kantenstärke als Vergleichswert für echte Blattkanten: gemessen AUSSERHALB des Vierecks
 * (Untergrund). Schrift auf dem Blatt verfälscht den Wert so nicht. Ohne genug Fläche außerhalb:
 * ganzes Bild.
 */
function edgeBaseline(mag, w, h, norm, quad = null) {
  let acc = 0;
  let n = 0;
  let accAll = 0;
  let nAll = 0;
  const step = Math.max(3, Math.round(Math.min(w, h) / 40));
  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.max(m, mag[(y + dy) * w + x + dx]);
      const v = Math.min(1, m / norm);
      accAll += v;
      nAll++;
      // Abstand zum Viereck, damit die Blattkante selbst nicht mitzählt
      if (quad && !insideQuad(quad, x, y) && !insideQuad(grow(quad, 1.06), x, y)) {
        acc += v;
        n++;
      }
    }
  }
  if (n >= 30) return acc / n;
  return nAll ? accAll / nAll : 0;
}

function grow(q, f) {
  const c = q.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  return q.map((p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f }));
}

/** Wie gut liegt das Viereck auf echten Kanten? Mittlere Kantenstärke entlang der vier Seiten (0–1). */
function edgeSupport(quad, mag, w, h, norm) {
  let worst = Infinity;
  let total = 0;
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(8, Math.round(len));
    let acc = 0;
    let n = 0;
    for (let t = 1; t < steps; t++) {
      const x = a.x + ((b.x - a.x) * t) / steps;
      const y = a.y + ((b.y - a.y) * t) / steps;
      // stärkster Wert in einer kleinen Umgebung (Kante liegt nicht immer exakt auf der Linie)
      let m = 0;
      let inside = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xi = Math.round(x) + dx;
          const yi = Math.round(y) + dy;
          if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
          inside = true;
          m = Math.max(m, mag[yi * w + xi]);
        }
      }
      if (!inside) continue;
      acc += Math.min(1, m / norm);
      n++;
    }
    // Seiten außerhalb des Bildes (Blatt angeschnitten) gelten als neutral
    const side = n < steps * 0.3 ? 0.5 : acc / n;
    worst = Math.min(worst, side);
    total += side;
  }
  return { mean: total / 4, worst };
}

// ---------- Verfahren a: helle Fläche ----------

function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  let bestId = 0;
  let bestSize = 0;
  let current = 0;
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    current++;
    let top = 0;
    stack[top++] = i;
    label[i] = current;
    let size = 0;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = current; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = current; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = current; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = current; stack[top++] = p + w; }
    }
    if (size > bestSize) {
      bestSize = size;
      bestId = current;
    }
  }
  return { label, id: bestId, size: bestSize };
}

function quadFromBrightness(gray, chroma, w, h) {
  const paper = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) paper[i] = Math.max(0, gray[i] - 0.8 * chroma[i]);
  const smooth = boxBlur(boxBlur(paper, w, h, 1), w, h, 1);
  const t = otsu(smooth);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = smooth[i] > t ? 1 : 0;
  const { label, id, size } = largestComponent(mask, w, h);
  if (!id || size < w * h * 0.12) return null;
  // Berührt die helle Fläche alle vier Bildränder großflächig, ist vermutlich der Untergrund hell
  let borderHits = 0;
  for (let x = 0; x < w; x++) {
    if (label[x] === id) borderHits++;
    if (label[(h - 1) * w + x] === id) borderHits++;
  }
  for (let y = 0; y < h; y++) {
    if (label[y * w] === id) borderHits++;
    if (label[y * w + w - 1] === id) borderHits++;
  }
  if (borderHits > (2 * (w + h)) * 0.6) return null;
  const pts = [];
  for (let y = 0; y < h; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] === id) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    if (minX >= 0) {
      pts.push({ x: minX, y });
      if (maxX !== minX) pts.push({ x: maxX + 1, y });
    }
  }
  const hull = convexHull(pts);
  const quad = largestQuad(hull);
  if (!quad) return null;
  // Ein Blatt ist eine geschlossene Fläche: zerfaserte Flächen (Muster, Rauschen) verwerfen
  if (size / Math.max(1, polygonArea(quad)) < 0.6) return null;
  return orderCorners(quad);
}

// ---------- Verfahren b: gerade Kanten (Hough) ----------

function houghLines(mag, ang, w, h, threshold) {
  const thetaSteps = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoSize = diag * 2 + 1;
  const acc = new Float32Array(thetaSteps * rhoSize);
  const cos = new Float32Array(thetaSteps);
  const sin = new Float32Array(thetaSteps);
  for (let t = 0; t < thetaSteps; t++) {
    cos[t] = Math.cos((t * Math.PI) / thetaSteps);
    sin[t] = Math.sin((t * Math.PI) / thetaSteps);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < threshold) continue;
      // nur Winkel nahe der Kantenrichtung abstimmen lassen (schneller, weniger Rauschen)
      let theta = ang[i];
      if (theta < 0) theta += Math.PI;
      const center = Math.round((theta / Math.PI) * thetaSteps) % thetaSteps;
      for (let dt = -8; dt <= 8; dt++) {
        const t = (center + dt + thetaSteps) % thetaSteps;
        const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * rhoSize + rho] += m;
      }
    }
  }
  // Spitzen finden (mit Unterdrückung benachbarter Werte)
  const lines = [];
  const used = new Uint8Array(acc.length);
  for (let n = 0; n < 16; n++) {
    let best = 0;
    let bi = -1;
    for (let i = 0; i < acc.length; i++) {
      if (!used[i] && acc[i] > best) {
        best = acc[i];
        bi = i;
      }
    }
    if (bi < 0 || best <= 0) break;
    const t = Math.floor(bi / rhoSize);
    const r = (bi % rhoSize) - diag;
    lines.push({ theta: (t * Math.PI) / thetaSteps, rho: r, votes: best });
    for (let dt = -6; dt <= 6; dt++) {
      const tt = (t + dt + thetaSteps) % thetaSteps;
      const wrapped = t + dt < 0 || t + dt >= thetaSteps;
      for (let dr = -Math.max(6, Math.round(diag * 0.025)); dr <= Math.max(6, Math.round(diag * 0.025)); dr++) {
        const rr = (wrapped ? -r : r) + dr + diag;
        if (rr >= 0 && rr < rhoSize) used[tt * rhoSize + rr] = 1;
      }
    }
  }
  return lines;
}

function intersect(a, b) {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  };
}

function quadsFromLines(lines, w, h) {
  const out = [];
  const angleDiff = (a, b) => {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleDiff(lines[i].theta, lines[j].theta) > 0.35) continue; // Paar 1: ungefähr parallel
      for (let k = 0; k < lines.length; k++) {
        if (k === i || k === j) continue;
        for (let l = k + 1; l < lines.length; l++) {
          if (l === i || l === j) continue;
          if (angleDiff(lines[k].theta, lines[l].theta) > 0.35) continue; // Paar 2: parallel
          if (angleDiff(lines[i].theta, lines[k].theta) < 0.9) continue; // Paare etwa senkrecht zueinander
          const pts = [intersect(lines[i], lines[k]), intersect(lines[k], lines[j]), intersect(lines[j], lines[l]), intersect(lines[l], lines[i])];
          if (pts.some((p) => !p || p.x < -w * 0.1 || p.y < -h * 0.1 || p.x > w * 1.1 || p.y > h * 1.1)) continue;
          out.push(orderCorners(pts));
        }
      }
    }
  }
  return out;
}

// ---------- Erkennung ----------

/**
 * Findet die vier Ecken eines Blattes.
 * @param img RGBA-Bild (am besten schon verkleinert, ca. 300–500 Pixel)
 * @returns {{ corners: [{x,y}×4] in Bildkoordinaten (0–1 relativ), confidence: 0–1, method } | null}
 */
export function detectDocument(img, { maxSide = 360 } = {}) {
  const { img: small } = downscale(img, maxSide);
  const w = small.width;
  const h = small.height;
  if (w < 32 || h < 32) return null;
  const { gray, chroma } = grayscale(small);
  const blurred = boxBlur(boxBlur(gray, w, h, 1), w, h, 1);
  const { mag, ang } = sobel(blurred, w, h);
  // Kantenstärke normieren: hohes Quantil der Gradienten
  const sample = [];
  for (let i = 0; i < mag.length; i += 7) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const norm = Math.max(40, sample[Math.floor(sample.length * 0.97)] || 0);

  const candidates = [];
  const brightQuad = quadFromBrightness(gray, chroma, w, h);
  if (brightQuad) candidates.push({ quad: brightQuad, method: 'helligkeit' });
  const lines = houghLines(mag, ang, w, h, norm * 0.35);
  for (const quad of quadsFromLines(lines, w, h)) candidates.push({ quad, method: 'kanten' });

  let best = null;
  for (const c of candidates) {
    if (!isConvexQuad(c.quad)) continue;
    const area = polygonArea(c.quad) / (w * h);
    if (area < 0.12 || area > 1.02) continue;
    const angles = cornerAngles(c.quad);
    if (angles.some((a) => a < 45 || a > 135)) continue;
    const raw = edgeSupport(c.quad, mag, w, h, norm);
    // Kanten müssen sich deutlich vom Untergrund abheben (sonst: Muster oder Rauschen)
    const baseline = edgeBaseline(mag, w, h, norm, c.quad);
    const contrast = (v) => Math.max(0, (v - baseline) / Math.max(0.05, 1 - baseline));
    const support = { mean: contrast(raw.mean), worst: contrast(raw.worst) };
    if (support.mean < 0.18 || support.worst < 0.06) continue;
    // Gute Kanten zählen am meisten; größere Blätter leicht bevorzugt
    const score = support.mean * 0.65 + support.worst * 0.35 + Math.min(area, 0.9) * 0.15 + (c.method === 'helligkeit' ? 0.03 : 0);
    if (!best || score > best.score) best = { ...c, score, support, area };
  }
  if (!best) return null;
  return {
    corners: best.quad.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) })),
    confidence: Math.max(0, Math.min(1, (best.support.mean - 0.2) / 0.5)),
    method: best.method,
  };
}

/** Standard-Ecken, wenn nichts erkannt wurde: ganzes Bild mit kleinem Rand. */
export function defaultCorners(inset = 0.04) {
  return [{ x: inset, y: inset }, { x: 1 - inset, y: inset }, { x: 1 - inset, y: 1 - inset }, { x: inset, y: 1 - inset }];
}

// ---------- Perspektivkorrektur ----------

/** Löst ein lineares Gleichungssystem (Gauß mit Pivotsuche). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const div = M[c][c];
    if (Math.abs(div) < 1e-12) return null;
    for (let k = c; k <= n; k++) M[c][k] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

/** Homographie, die die Punkte src[i] auf dst[i] abbildet (je 4 Punkte). */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** Ausgabegröße aus den Seitenlängen; nahe DIN A4 wird auf A4-Verhältnis gerundet. */
export function outputSize(corners, srcW, srcH, maxSide = 2200) {
  const px = corners.map((p) => ({ x: p.x * srcW, y: p.y * srcH }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(dist(px[0], px[1]), dist(px[3], px[2]));
  let h = Math.max(dist(px[0], px[3]), dist(px[1], px[2]));
  const ratio = h / w;
  const A4 = Math.SQRT2;
  if (Math.abs(ratio - A4) / A4 < 0.12) h = w * A4;
  else if (Math.abs(1 / ratio - A4) / A4 < 0.12) w = h * A4;
  const scale = Math.min(1.25, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Entzerrt den Bereich innerhalb der Ecken auf ein gerades Rechteck.
 * corners: relativ (0–1), Reihenfolge oben links, oben rechts, unten rechts, unten links.
 */
export function warpPerspective(img, corners, outW, outH) {
  const src = corners.map((p) => ({ x: p.x * (img.width - 1), y: p.y * (img.height - 1) }));
  const dst = [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }];
  const H = homography(dst, src); // Ziel → Quelle (für jedes Zielpixel die Quelle berechnen)
  if (!H) throw new Error('Die Ecken ergeben kein gültiges Viereck.');
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = img.width;
  const sh = img.height;
  const s = img.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = H[6] * x + H[7] * y + H[8];
      let sx = (H[0] * x + H[1] * y + H[2]) / den;
      let sy = (H[3] * x + H[4] * y + H[5]) / den;
      sx = Math.min(sw - 1.001, Math.max(0, sx));
      sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[p00 + c] + (s[p10 + c] - s[p00 + c]) * fx;
        const bottom = s[p01 + c] + (s[p11 + c] - s[p01 + c]) * fx;
        out[o + c] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

// ---------- Bildverbesserung ----------

/** Hintergrund (Papierhelligkeit) eines Kanals schätzen: verkleinern, Schrift „wegfiltern“, glätten. */
function backgroundMap(channel, w, h, factor = 12) {
  const bw = Math.max(1, Math.ceil(w / factor));
  const bh = Math.max(1, Math.ceil(h / factor));
  const small = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // heller Anteil des Blocks (oberes Viertel) statt Mittelwert – Schrift zieht den Wert sonst nach unten
      const vals = [];
      for (let y = by * factor; y < Math.min(h, (by + 1) * factor); y += 2) {
        for (let x = bx * factor; x < Math.min(w, (bx + 1) * factor); x += 2) vals.push(channel[y * w + x]);
      }
      vals.sort((a, b) => a - b);
      small[by * bw + bx] = vals[Math.floor(vals.length * 0.75)] ?? 255;
    }
  }
  // Maximumfilter (Radius 2) entfernt größere Schriftzüge, danach glätten
  const dil = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, y + dy));
          const xx = Math.min(bw - 1, Math.max(0, x + dx));
          m = Math.max(m, small[yy * bw + xx]);
        }
      }
      dil[y * bw + x] = m;
    }
  }
  return { map: boxBlur(boxBlur(dil, bw, bh, 2), bw, bh, 2), bw, bh, factor };
}

function sampleBg(bg, x, y) {
  const fx = Math.min(bg.bw - 1.001, Math.max(0, x / bg.factor - 0.5));
  const fy = Math.min(bg.bh - 1.001, Math.max(0, y / bg.factor - 0.5));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const m = bg.map;
  const i = y0 * bg.bw + x0;
  const x1 = Math.min(bg.bw - 1, x0 + 1) - x0;
  const y1 = Math.min(bg.bh - 1, y0 + 1) - y0;
  const top = m[i] + (m[i + x1] - m[i]) * ax;
  const bottom = m[i + y1 * bg.bw] + (m[i + y1 * bg.bw + x1] - m[i + y1 * bg.bw]) * ax;
  return Math.max(1, top + (bottom - top) * ay);
}

function percentile(values, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, values[i] | 0))]++;
  let target = values.length * p;
  for (let t = 0; t < 256; t++) {
    target -= hist[t];
    if (target <= 0) return t;
  }
  return 255;
}

/**
 * Verbessert ein Scanbild.
 * mode: 'original' | 'farbe' (Schatten weg, Farben bleiben) | 'grau' | 'sw' (Schwarzweiß, Text kräftig)
 */
export function enhance(img, mode = 'farbe') {
  if (mode === 'original') return img;
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const d = img.data;
  const out = new Uint8ClampedArray(n * 4);
  if (mode === 'farbe') {
    const ch = [0, 1, 2].map((c) => {
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) arr[i] = d[i * 4 + c];
      return arr;
    });
    const bgs = ch.map((arr) => backgroundMap(arr, w, h));
    const luma = new Uint8ClampedArray(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let l = 0;
        for (let c = 0; c < 3; c++) {
          const v = Math.min(255, (ch[c][i] / sampleBg(bgs[c], x, y)) * 255);
          out[i * 4 + c] = v;
          l += v * [0.299, 0.587, 0.114][c];
        }
        out[i * 4 + 3] = 255;
        luma[i] = l;
      }
    }
    // Kontrast: dunkelste 2 % werden schwarz, Papier bleibt weiß
    const black = Math.min(120, percentile(luma, 0.02));
    const scale = 255 / Math.max(1, 255 - black);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = (out[i * 4 + c] - black) * scale;
    }
    return { width: w, height: h, data: out };
  }
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const bg = backgroundMap(gray, w, h);
  const norm = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      norm[i] = Math.min(255, (gray[i] / sampleBg(bg, x, y)) * 255);
    }
  }
  if (mode === 'grau') {
    const black = Math.min(120, percentile(norm, 0.02));
    const scale = 255 / Math.max(1, 255 - black);
    for (let i = 0; i < n; i++) {
      const v = (norm[i] - black) * scale;
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }
  // Schwarzweiß: Schwelle aus der normalisierten Helligkeit, weicher Übergang gegen Treppenkanten
  const t = Math.min(215, Math.max(140, otsu(norm) + 10));
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, 128 + (norm[i] - t) * 6));
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

// ---------- Fingerabdruck ----------

/** 64-Bit-Differenz-Hash (16 Hex-Zeichen): ähnliche Bilder → ähnlicher Hash. */
export function differenceHash(img) {
  const { img: small } = downscale(img, 64);
  const w = 9;
  const h = 8;
  const { gray } = grayscale(small);
  const cells = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      let c = 0;
      const x0 = Math.floor((x * small.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * small.width) / w));
      const y0 = Math.floor((y * small.height) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * small.height) / h));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          acc += gray[yy * small.width + xx];
          c++;
        }
      }
      cells[y * w + x] = acc / c;
    }
  }
  let hex = '';
  for (let y = 0; y < h; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (cells[y * w + x] > cells[y * w + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Anzahl unterschiedlicher Bits zweier Fingerabdrücke (0 = gleich, 64 = völlig verschieden). */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}
