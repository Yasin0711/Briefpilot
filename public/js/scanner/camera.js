// Live-Kamera im Vollbild: erkennt das Blatt laufend, zeigt den Rahmen und löst automatisch aus,
// sobald das Blatt ruhig im Bild liegt. Mehrere Seiten nacheinander, ohne die Kamera zu schließen.
// Braucht eine sichere Verbindung (https oder localhost) – sonst nutzt die App den Foto-Dialog.
import { html, mount } from '../html.js';
import { icon } from '../ui.js';
import { detectCorners, toCanvas, imageDataOf, imageproc } from './processing.js';
import { trapBackButton, closeOnAbort } from './overlay.js';

const DETECT_EVERY_MS = 260;
const STABLE_FRAMES = 4; // ≈ 1 Sekunde ruhig halten
const MIN_CONFIDENCE = 0.35;

export function liveCameraAvailable() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

function maxDelta(a, b) {
  if (!a || !b) return 1;
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

function frameHash(video) {
  const small = toCanvas(video, 64);
  return imageproc.differenceHash(imageDataOf(small));
}

const { hashDistance } = imageproc;

/**
 * Öffnet die Kamera.
 * @param {{ pageCount: number, lastThumb?: string, onCapture: (shot) => Promise<{thumbUrl}|void>, onClose: () => void,
 *           onError: (err) => void, signal?: AbortSignal }} options
 *   shot = { canvas, corners, confidence }
 */
export async function openCamera({ pageCount = 0, lastThumb = null, onCapture, onClose, onError, signal }) {
  const root = document.createElement('div');
  root.className = 'scanner';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Brief scannen');
  document.body.append(root);
  document.body.classList.add('scanner-open');
  const previousFocus = document.activeElement;

  let auto = true;
  try {
    auto = localStorage.getItem('bp-auto-capture') !== 'aus';
  } catch {
    auto = true;
  }
  let count = pageCount;
  let thumb = lastThumb;
  let stream = null;
  let track = null;
  let torchOn = false;
  let closed = false;
  let timer = null;
  let busy = false;
  let capturing = false;
  let corners = null;
  let confidence = 0;
  let stable = 0;
  let armed = true;
  let lostFrames = 0;
  let lastShotHash = null;

  mount(root, html`
    <div class="scanner-top">
      <button class="scanner-icon" type="button" data-close aria-label="Kamera schließen">${icon('x')}</button>
      <span class="scanner-title" data-title aria-live="polite"></span>
      <span class="row">
        <button class="scanner-icon" type="button" data-torch aria-pressed="false" aria-label="Licht einschalten" hidden>${icon('bolt')}</button>
        <button class="scanner-chip" type="button" data-auto aria-pressed="${auto}">${icon('spark')}<span>Automatisch</span></button>
      </span>
    </div>
    <div class="scanner-stage" data-stage>
      <video playsinline muted autoplay data-video></video>
      <canvas class="scanner-overlay" data-overlay aria-hidden="true"></canvas>
      <div class="scanner-flash" data-flash aria-hidden="true"></div>
      <p class="scanner-hint" data-hint aria-live="polite">Kamera wird gestartet …</p>
    </div>
    <div class="scanner-bottom">
      <button class="scanner-thumb" type="button" data-done aria-label="Fertig – Seiten ansehen" ${count ? '' : html`hidden`}>
        <img data-thumb alt="" ${thumb ? html`src="${thumb}"` : ''}><span class="scanner-count" data-count>${count}</span></button>
      <button class="scanner-shutter" type="button" data-shoot aria-label="Seite aufnehmen"><span class="scanner-ring" data-ring></span></button>
      <button class="scanner-done" type="button" data-done>${count ? 'Fertig' : 'Abbrechen'}</button>
    </div>`);

  const $ = (sel) => root.querySelector(sel);
  const video = $('[data-video]');
  const overlay = $('[data-overlay]');
  const hint = $('[data-hint]');
  const setHint = (text) => {
    if (hint.textContent !== text) hint.textContent = text;
  };
  const updateTitle = () => {
    $('[data-title]').textContent = `Seite ${count + 1}`;
  };
  updateTitle();

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', drawOverlay);
    releaseBack();
    root.remove();
    document.body.classList.remove('scanner-open');
    previousFocus?.focus?.();
    onClose?.();
  }
  // Zurück-Taste schließt nur die Kamera; Seitenwechsel schließt sie ebenfalls
  const releaseBack = trapBackButton(close);
  closeOnAbort(signal, close);

  function onKey(e) {
    if (e.key === 'Escape') close();
    if ((e.key === ' ' || e.key === 'Enter') && document.activeElement === document.body) {
      e.preventDefault();
      shoot();
    }
  }
  window.addEventListener('keydown', onKey);

  /** Rechteck, in dem das Video innerhalb der Bühne angezeigt wird (object-fit: contain). */
  function videoRect() {
    const stage = $('[data-stage]');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(sw / vw, sh / vh);
    return { x: (sw - vw * scale) / 2, y: (sh - vh * scale) / 2, w: vw * scale, h: vh * scale, sw, sh };
  }

  function drawOverlay() {
    const r = videoRect();
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.sw * dpr)) overlay.width = Math.round(r.sw * dpr);
    if (overlay.height !== Math.round(r.sh * dpr)) overlay.height = Math.round(r.sh * dpr);
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.sw, r.sh);
    if (!corners) return;
    const pts = corners.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    const good = confidence >= MIN_CONFIDENCE;
    ctx.fillStyle = good ? 'rgba(255, 204, 0, 0.18)' : 'rgba(110, 168, 255, 0.14)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = good ? '#FFCC00' : '#6EA8FF';
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = good ? '#FFCC00' : '#6EA8FF';
      ctx.fill();
    }
  }
  window.addEventListener('resize', drawOverlay);

  function setRing(progress) {
    $('[data-ring]').style.setProperty('--progress', String(Math.max(0, Math.min(1, progress))));
  }

  async function detectLoop() {
    if (closed) return;
    if (!busy && !capturing && video.readyState >= 2) {
      busy = true;
      try {
        const frame = toCanvas(video, 360);
        const found = await detectCorners(frame);
        if (closed) return;
        const next = found && found.confidence >= 0.1 ? found.corners : null;
        const delta = maxDelta(corners, next);
        corners = next;
        confidence = found?.confidence || 0;
        if (corners && confidence >= MIN_CONFIDENCE && delta < 0.025) stable++;
        else stable = 0;
        if (!corners) lostFrames++;
        else lostFrames = 0;
        // Nach einer Aufnahme erst wieder auslösen, wenn eine neue Seite im Bild ist
        if (!armed) {
          if (lostFrames >= 2) armed = true;
          else if (lastShotHash && hashDistance(frameHash(video), lastShotHash) > 14) armed = true;
        }
        if (!corners) setHint('Blatt flach hinlegen und ganz ins Bild holen');
        else if (!armed) setHint('Gespeichert. Nächste Seite hinlegen – oder „Fertig“');
        else if (confidence < MIN_CONFIDENCE) setHint('Blatt erkannt – etwas mehr Abstand oder besseres Licht');
        else if (auto) setHint(stable >= 2 ? 'Ruhig halten …' : 'Blatt erkannt');
        else setHint('Blatt erkannt – jetzt auslösen');
        setRing(auto && armed ? stable / STABLE_FRAMES : 0);
        drawOverlay();
        if (auto && armed && stable >= STABLE_FRAMES) shoot();
      } catch {
        /* einzelnes Bild übersprungen */
      } finally {
        busy = false;
      }
    }
    timer = setTimeout(detectLoop, DETECT_EVERY_MS);
  }

  async function grab() {
    // Volle Auflösung, wenn der Browser Fotos direkt aufnehmen kann (z. B. Chrome auf Android)
    if (track && 'ImageCapture' in window) {
      try {
        const capture = new window.ImageCapture(track);
        const blob = await Promise.race([
          capture.takePhoto(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        const bitmap = await createImageBitmap(blob);
        const canvas = toCanvas(bitmap);
        bitmap.close?.();
        return canvas;
      } catch {
        /* weiter mit dem Videobild */
      }
    }
    return toCanvas(video);
  }

  async function shoot() {
    if (capturing || closed || video.readyState < 2) return;
    capturing = true;
    stable = 0;
    setRing(0);
    const flash = $('[data-flash]');
    flash.classList.remove('is-on');
    void flash.offsetWidth;
    flash.classList.add('is-on');
    setHint('Aufnahme …');
    try {
      const liveCorners = corners;
      const liveConfidence = confidence;
      lastShotHash = frameHash(video);
      const canvas = await grab();
      // Auf dem großen Bild noch einmal genau erkennen
      let shot = await detectCorners(canvas).catch(() => null);
      if (!shot && liveCorners) shot = { corners: liveCorners, confidence: liveConfidence };
      const result = await onCapture({ canvas, corners: shot?.corners || null, confidence: shot?.confidence || 0 });
      count++;
      if (result?.thumbUrl) thumb = result.thumbUrl;
      const thumbBtn = $('[data-thumb]');
      if (thumb) thumbBtn.src = thumb;
      $('[data-count]').textContent = String(count);
      root.querySelectorAll('[data-done]').forEach((b) => {
        b.hidden = false;
        if (b.classList.contains('scanner-done')) b.textContent = 'Fertig';
      });
      updateTitle();
      armed = false;
    } catch (err) {
      setHint(err?.message || 'Die Aufnahme hat nicht geklappt. Bitte erneut versuchen.');
    } finally {
      capturing = false;
    }
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target.closest('[data-done]')) {
      close();
      return;
    }
    if (e.target.closest('[data-shoot]')) {
      shoot();
      return;
    }
    const autoBtn = e.target.closest('[data-auto]');
    if (autoBtn) {
      auto = !auto;
      autoBtn.setAttribute('aria-pressed', String(auto));
      try {
        localStorage.setItem('bp-auto-capture', auto ? 'an' : 'aus');
      } catch {
        /* egal */
      }
      return;
    }
    const torch = e.target.closest('[data-torch]');
    if (torch && track) {
      torchOn = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        torch.setAttribute('aria-pressed', String(torchOn));
        torch.setAttribute('aria-label', torchOn ? 'Licht ausschalten' : 'Licht einschalten');
      } catch {
        torch.hidden = true;
      }
    }
  });

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    close();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    onError?.(new Error(denied
      ? 'Der Zugriff auf die Kamera wurde nicht erlaubt. Sie können die Kamera in den Browser-Einstellungen freigeben – oder ein Foto über die Kamera-App aufnehmen.'
      : 'Die Kamera konnte nicht gestartet werden. Bitte nehmen Sie ein Foto über die Kamera-App auf.'));
    return;
  }
  if (closed) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  track = stream.getVideoTracks()[0];
  try {
    if (track.getCapabilities?.().torch) $('[data-torch]').hidden = false;
  } catch {
    /* kein Licht */
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* Autoplay startet ggf. nach Antippen */
  }
  $('[data-shoot]').focus();
  setHint('Blatt flach hinlegen und ganz ins Bild holen');
  detectLoop();
}
