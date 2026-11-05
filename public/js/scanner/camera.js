// Live-Kamera im Vollbild: erkennt das Blatt laufend, zeigt den Rahmen und löst automatisch aus,
// sobald das Blatt ruhig im Bild liegt. Mehrere Seiten nacheinander, ohne die Kamera zu schließen.
// Braucht eine sichere Verbindung (https oder localhost) – sonst nutzt die App den Foto-Dialog.
import { html, mount } from '../html.js';
import { icon } from '../ui.js';
import { detectCorners, toCanvas, imageDataOf, imageproc } from './processing.js';
import { trapBackButton, closeOnAbort } from './overlay.js';

const DETECT_EVERY_MS = 260;
// Kamera nach dem Schließen kurz offen halten: Wer gleich weiterscannt, wird nicht erneut gefragt.
const KEEP_STREAM_MS = 45_000;
let kept = null; // { stream, timer }

function takeKeptStream() {
  if (!kept) return null;
  clearTimeout(kept.timer);
  const { stream } = kept;
  kept = null;
  return stream.getVideoTracks().some((t) => t.readyState === 'live') ? stream : null;
}

function keepStream(stream) {
  if (!stream) return;
  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (kept?.stream === stream) kept = null;
    document.removeEventListener('visibilitychange', onHide);
  };
  // App im Hintergrund: Kamera sofort aus
  const onHide = () => {
    if (document.visibilityState === 'hidden') stop();
  };
  document.addEventListener('visibilitychange', onHide);
  kept = { stream, timer: setTimeout(stop, KEEP_STREAM_MS) };
}
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
export async function openCamera({
  pageCount = 0, lastThumb = null, onCapture, onClose, onError, onFiles, fileAccept = '', signal,
  onGallery = null, onSave = null, saveLabel = 'Brief speichern', letterCount = 0, onList = null, titlePrefix = '', onMount = null,
}) {
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
  let failed = false; // Kamera ließ sich nicht starten – die Seite zeigt dann „Dateien“/Foto-Dialog
  let letters = letterCount;
  let prefix = titlePrefix;
  let saveText = saveLabel;

  mount(root, html`
    <div class="scanner-top">
      <button class="scanner-chip scanner-list" type="button" data-list aria-label="Gescannte Briefe" ${letters ? '' : html`hidden`}>${icon('layers')}<span data-letters>${letters}</span></button>
      <button class="scanner-icon" type="button" data-close aria-label="Kamera schließen" ${letters ? html`hidden` : ''}>${icon('x')}</button>
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
    <div class="scanner-tray" data-tray ${count ? '' : html`hidden`}>
      <button class="scanner-finish" type="button" data-done aria-label="Seiten ansehen">
        <span class="scanner-thumb"><img data-thumb alt="" ${thumb ? html`src="${thumb}"` : ''}><span class="scanner-count" data-count>${count}</span></span></button>
      ${onSave ? html`<button class="scanner-save" type="button" data-save>${icon('check')}<span data-save-label>${saveText}</span></button>` : ''}
    </div>
    <div class="scanner-bottom">
      ${onGallery ? html`<label class="scanner-files scanner-gallery">${icon('image')}<span>Bilder</span>
        <input class="visually-hidden" type="file" multiple accept="image/*,.heic,.heif" data-gallery aria-label="Bilder aus der Galerie"></label>` : html`<span></span>`}
      <button class="scanner-shutter" type="button" data-shoot aria-label="Seite aufnehmen"><span class="scanner-ring" data-ring></span></button>
      ${onFiles ? html`<label class="scanner-files scanner-upload">${icon('folder')}<span>Dateien</span>
        <input class="visually-hidden" type="file" multiple accept="${fileAccept}" data-pick aria-label="Dateien hochladen"></label>` : html`<span></span>`}
    </div>`);

  const $ = (sel) => root.querySelector(sel);
  const video = $('[data-video]');
  const overlay = $('[data-overlay]');
  const hint = $('[data-hint]');
  const setHint = (text) => {
    if (hint.textContent !== text) hint.textContent = text;
  };
  const updateTitle = () => {
    $('[data-title]').textContent = `${prefix}Seite ${count + 1}`;
  };
  updateTitle();

  /** Stand von außen setzen (Bilder aus der Galerie, Brief gespeichert, neuer Brief …). */
  function setPages(n, url = null) {
    count = n;
    thumb = url;
    const img = $('[data-thumb]');
    if (url) img.src = url;
    else img.removeAttribute('src');
    $('[data-count]').textContent = String(n);
    $('[data-tray]').hidden = !n;
    updateTitle();
  }
  function setLetters(n) {
    letters = n;
    $('[data-letters]').textContent = String(n);
    $('[data-list]').hidden = !n;
    $('[data-close]').hidden = Boolean(n);
  }
  function setTitle(text, label = null) {
    prefix = text || '';
    if (label) {
      saveText = label;
      const el = $('[data-save-label]');
      if (el) el.textContent = label;
    }
    updateTitle();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (torchOn) track?.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    if (video) video.srcObject = null;
    keepStream(stream);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', drawOverlay);
    releaseBack();
    root.remove();
    document.body.classList.remove('scanner-open');
    previousFocus?.focus?.();
    onClose?.({ failed });
  }
  // Zurück-Taste schließt nur die Kamera; Seitenwechsel schließt sie ebenfalls
  const releaseBack = trapBackButton(close);
  closeOnAbort(signal, close);
  onMount?.({ setPages, setLetters, setTitle, setHint: (t) => setHint(t), close, isOpen: () => !closed });

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
    ctx.fillStyle = good ? 'rgba(10, 132, 255, 0.18)' : 'rgba(255, 255, 255, 0.10)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = good ? '#0A84FF' : 'rgba(255, 255, 255, 0.75)';
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = good ? '#0A84FF' : 'rgba(255, 255, 255, 0.75)';
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
      $('[data-tray]').hidden = false;
      updateTitle();
      armed = false;
    } catch (err) {
      setHint(err?.message || 'Die Aufnahme hat nicht geklappt. Bitte erneut versuchen.');
    } finally {
      capturing = false;
    }
  }

  // Bilder aus der Galerie: werden Seiten dieses Briefs – die Kamera bleibt offen
  // Ordner-Symbol: Dateien statt Kamera – Kamera schließen und Dateien weitergeben
  root.addEventListener('change', async (e) => {
    if (!e.target.files?.length) return;
    const files = [...e.target.files];
    e.target.value = '';
    if (e.target.matches('[data-gallery]')) {
      setHint(files.length === 1 ? 'Bild wird übernommen …' : `${files.length} Bilder werden übernommen …`);
      try {
        await onGallery?.(files);
        setHint('Übernommen. Weiter scannen – oder speichern');
      } catch (err) {
        setHint(err?.message || 'Die Bilder konnten nicht übernommen werden.');
      }
      return;
    }
    if (!e.target.matches('[data-pick]')) return;
    close();
    onFiles?.(files);
  });

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target.closest('[data-done]')) {
      close();
      return;
    }
    if (e.target.closest('[data-list]')) {
      close();
      onList?.();
      return;
    }
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn && count && !capturing) {
      saveBtn.disabled = true;
      try {
        await onSave?.();
        armed = false;
      } catch (err) {
        setHint(err?.message || 'Speichern hat nicht geklappt.');
      } finally {
        saveBtn.disabled = false;
      }
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
    stream = takeKeptStream() || await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    failed = true;
    close();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    onError?.(new Error(denied
      ? 'Kamera nicht erlaubt. Anleitung: Einstellungen → Kamera immer erlauben.'
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
