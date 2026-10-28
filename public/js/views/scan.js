// Brief erfassen wie mit einem Dokumentenscanner: Live-Kamera mit automatischer Kantenerkennung,
// Fotos, Screenshots und PDFs importieren, Seiten zuschneiden, entzerren, verbessern, drehen und sortieren.
// Hochgeladen wird jede Seite als bearbeitetes JPEG; die Originalfotos auf Wunsch zusätzlich.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, formatBytes, busy, openDialog, formatUploaded } from '../ui.js';
import { liveCameraAvailable, openCamera } from '../scanner/camera.js';
import { openEditor } from '../scanner/editor.js';
import { FILTERS, MAX_SOURCE_SIDE, decodeImage, toCanvas, detectCorners, renderPage, cleanOriginal, imageproc } from '../scanner/processing.js';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
const MIN_SIDE = 300; // kleinere Bilder sind nicht lesbar
const SURE = 0.35; // ab dieser Sicherheit gilt die Blatterkennung als zuverlässig
const KEEP_KEY = 'bp-keep-originals';

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Einstellung gilt dann nur bis zum Neuladen */
  }
}

function filterLabel(id) {
  return FILTERS.find((f) => f.id === id)?.label || 'Original';
}

function isFullFrame(corners) {
  const full = imageproc.defaultCorners(0);
  return corners.every((p, i) => Math.abs(p.x - full[i].x) < 0.01 && Math.abs(p.y - full[i].y) < 0.01);
}

export async function render({ root, query, state, navigate, refreshMe }) {
  /** Seite: { id, kind: 'image'|'pdf', blob, size, thumb, source, corners, rotation, filter, cropped, needsCheck,
   *           busy, fileId, originalFileId, duplicate, name } */
  const pages = [];
  let nextId = 1;
  let uploading = false;
  let saved = false;
  let liveFailed = false;
  let keepOriginals = readPref(KEEP_KEY, 'nein') === 'ja';
  const controller = new AbortController(); // schließt Kamera und Editor, wenn die Seite verlassen wird
  const maxMb = state.status?.limits?.maxFileMb || 15;
  const maxPages = state.status?.limits?.maxPages || 20;

  /** Kurzer Hinweis, wenn Fotos nicht automatisch gelesen werden. */
  function aiNote() {
    const ai = state.status?.ai;
    if (!ai?.enabled) {
      return html`<div class="note">${icon('info')}<div><strong>Ohne KI-Auswertung</strong>
        <p>Auf diesem Server ist keine KI eingerichtet. PDFs mit Text werden mit einer einfachen Erkennung gelesen. Fotos werden sicher gespeichert, aber nicht automatisch gelesen – Sie können die Angaben dann selbst eintragen.</p></div></div>`;
    }
    if (state.me.aiConsent === 'nein') {
      return html`<div class="note">${icon('info')}<div><strong>KI-Auswertung ist ausgeschaltet</strong>
        <p>Sie haben die KI-Auswertung abgelehnt. Fotos werden nur gespeichert. Sie können das jederzeit in den <a href="#/einstellungen">Einstellungen</a> ändern.</p></div></div>`;
    }
    return '';
  }

  /** Frage nach der Einwilligung – steht vor dem ersten Scan, solange nicht entschieden. */
  function consentCard() {
    const ai = state.status?.ai;
    if (!ai?.enabled || state.me.aiConsent === 'ja' || state.me.aiConsent === 'nein') return '';
    return html`<section class="panel stack" aria-labelledby="consent-h">
      <h2 id="consent-h">Darf BriefPilot Ihre Briefe mit KI lesen?</h2>
      <p>Damit BriefPilot Fotos lesen und Briefe in einfacher Sprache erklären kann, werden die Bilder oder PDFs eines Briefes an den KI-Dienst <strong>${ai.provider}</strong> übermittelt und dort ausgewertet.</p>
      <ul class="tips">
        <li>Übermittelt wird nur der jeweilige Brief – nicht Ihr Name, Ihre E-Mail-Adresse oder Ihr Passwort.</li>
        <li>Briefe können sensible Angaben enthalten (z. B. Gesundheit, Finanzen).</li>
        <li>Sie können Ihre Entscheidung jederzeit in den Einstellungen ändern.</li>
      </ul>
      <p><a href="#/datenschutz">Genauer nachlesen, was mit Ihren Daten passiert</a></p>
      <div class="row">
        <button class="btn" type="button" data-consent="ja">${icon('check')}Ja, mit KI auswerten</button>
        <button class="btn btn-secondary" type="button" data-consent="nein">Nein, ohne KI</button>
      </div>
    </section>`;
  }

  function pageItem(p, i) {
    const n = i + 1;
    const locked = p.busy || uploading;
    let sub;
    if (p.kind === 'pdf') sub = `PDF-Datei, ${formatBytes(p.size)}`;
    else if (p.busy) sub = 'Wird bearbeitet …';
    else sub = `${p.cropped ? 'Zugeschnitten' : 'Ganzes Bild'} · ${filterLabel(p.filter)} · ${formatBytes(p.size)}`;
    return html`<li class="page-item ${p.busy ? 'is-busy' : ''}" data-page="${p.id}" ${p.busy ? html`aria-busy="true"` : ''}>
      ${p.kind === 'image'
        ? html`<button class="page-thumb-btn" type="button" data-edit="${i}" aria-label="Seite ${n} zuschneiden und verbessern" ${locked ? 'disabled' : ''}>
            ${p.thumb ? html`<img class="page-thumb" src="${p.thumb}" alt="">` : html`<span class="page-thumb is-loading"></span>`}
            <span class="page-num" aria-hidden="true">${n}</span>
            ${p.busy ? html`<span class="spinner page-spinner" aria-hidden="true"></span>` : ''}</button>`
        : html`<span class="page-thumb-btn"><span class="page-thumb is-pdf">${icon('file')}</span><span class="page-num" aria-hidden="true">${n}</span></span>`}
      <div class="page-info">
        <span class="row-title">${p.kind === 'pdf' ? p.name : `Seite ${n}`}</span>
        <span class="row-sub">${sub}</span>
        <span class="row-meta">
          ${p.needsCheck && !p.busy ? html`<span class="badge badge-review">${icon('crop')}Zuschnitt prüfen</span>` : ''}
          ${p.duplicate ? html`<span class="badge badge-review">${icon('alert')}Schon gespeichert</span>` : ''}
        </span>
      </div>
      <div class="page-tools" role="group" aria-label="Seite ${n}">
        ${p.kind === 'image' ? html`
          <button class="icon-btn" type="button" data-edit="${i}" aria-label="Seite ${n} zuschneiden und verbessern" title="Zuschneiden und verbessern" ${locked ? 'disabled' : ''}>${icon('crop')}</button>
          <button class="icon-btn" type="button" data-rotate="${i}" aria-label="Seite ${n} nach rechts drehen" title="Drehen" ${locked ? 'disabled' : ''}>${icon('rotateRight')}</button>` : ''}
        <span class="page-tools-gap"></span>
        <button class="icon-btn" type="button" data-move="${i}" data-dir="-1" aria-label="Seite ${n} nach oben" title="Nach oben" ${i === 0 || uploading ? 'disabled' : ''}>${icon('arrowUp')}</button>
        <button class="icon-btn" type="button" data-move="${i}" data-dir="1" aria-label="Seite ${n} nach unten" title="Nach unten" ${i === pages.length - 1 || uploading ? 'disabled' : ''}>${icon('arrowDown')}</button>
        <button class="icon-btn" type="button" data-remove="${i}" aria-label="Seite ${n} entfernen" title="Entfernen" ${uploading ? 'disabled' : ''}>${icon('trash')}</button>
      </div>
    </li>`;
  }

  function draw() {
    const fileFirst = query.get('modus') === 'datei';
    const live = liveCameraAvailable() && !liveFailed;
    const count = pages.length;
    const working = pages.some((p) => p.busy);
    const hasImages = pages.some((p) => p.kind === 'image');
    const cameraApp = (label, cls) => html`<label class="btn ${cls} capture-btn">${icon('camera')}${label}
      <input type="file" accept="image/*" capture="environment" data-camera aria-label="${label}"></label>`;
    const cameraBtn = live
      ? html`<button class="btn btn-scan btn-block" type="button" data-live>${icon('camera')}${count ? 'Weitere Seiten scannen' : 'Kamera öffnen und scannen'}</button>`
      : cameraApp(count ? 'Weitere Seite fotografieren' : 'Seite fotografieren', 'btn-scan btn-block');
    const fileBtn = html`<label class="btn btn-secondary btn-block capture-btn">${icon('upload')}Fotos, Screenshots oder PDF
      <input type="file" accept="${ACCEPT}" multiple data-files aria-label="Fotos, Screenshots oder PDF-Dateien auswählen"></label>`;

    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Brief scannen</h1><p>Scannen Sie alle Seiten nacheinander oder laden Sie Fotos, Screenshots oder ein PDF hoch. Alle Seiten werden zu einem Brief zusammengefasst.</p></div></div>
      ${consentCard()}

      <div class="stack">
        <div class="capture-grid">${fileFirst ? [fileBtn, cameraBtn] : [cameraBtn, fileBtn]}</div>
        ${live ? html`<p class="center">${cameraApp('Mit der Kamera-App fotografieren', 'btn-ghost btn-small')}</p>` : ''}
        ${!window.isSecureContext ? html`<p class="small muted">Hinweis: Die Live-Kamera mit automatischer Auslösung braucht eine sichere Verbindung (https). Bis dahin öffnet „Seite fotografieren“ die Kamera-App – die Seite wird danach trotzdem automatisch zugeschnitten und verbessert.</p>` : ''}
      </div>

      ${count ? html`<section class="stack" aria-labelledby="pages-h">
        <h2 id="pages-h">${count === 1 ? '1 Seite' : `${count} Seiten`} in diesem Brief</h2>
        <ol class="pages">${pages.map((p, i) => pageItem(p, i))}</ol>
        ${hasImages ? html`<label class="check check-strong"><input type="checkbox" data-keep ${keepOriginals ? 'checked' : ''} ${uploading ? 'disabled' : ''}>
          <span><strong>Originalfotos zusätzlich aufbewahren</strong>
          <span class="row-sub">Die unbearbeiteten Aufnahmen werden mit dem Brief gespeichert, zum Beispiel als Nachweis. Braucht mehr Speicherplatz.</span></span></label>` : ''}
        <div data-progress hidden class="stack"><p data-progress-text class="small" aria-live="polite"></p><div class="progress"><span data-bar></span></div></div>
        <button class="btn btn-block" type="button" data-submit ${working || uploading ? 'disabled' : ''}>${icon('check')}${working ? 'Seiten werden noch bearbeitet …' : 'Brief speichern und auswerten'}</button>
      </section>` : html`<section class="panel stack">
        <h2>So gelingt der Scan</h2>
        <ul class="tips">
          <li>Brief auf einen dunklen, ruhigen Untergrund legen – dann findet BriefPilot die Ränder von selbst.</li>
          <li>Für gleichmäßiges Licht sorgen. Im Dunkeln hilft das Licht-Symbol in der Kamera.</li>
          <li>Ist „Automatisch“ eingeschaltet, löst die Kamera selbst aus, sobald das Blatt ruhig im Bild liegt.</li>
          <li>Alle Seiten nacheinander scannen – auch bedruckte Rückseiten. Die Reihenfolge können Sie danach ändern.</li>
        </ul>
        <p class="small muted">Schief fotografierte Seiten werden automatisch gerade gerückt, Schatten aufgehellt und der Kontrast verbessert. Erlaubt sind Fotos und Screenshots (JPG, PNG, WebP) und PDF-Dateien bis ${maxMb} MB, höchstens ${maxPages} Dateien pro Brief.</p>
      </section>`}

      ${aiNote()}
      ${state.me.isDemo ? html`<div class="note note-warn">${icon('info')}<div class="stack"><p><strong>Demomodus:</strong> Bitte laden Sie keine echten Briefe hoch. Zum Ausprobieren können Sie einen erfundenen Beispielbrief herunterladen und dann hier hochladen:</p>
        <div class="row"><a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=0" download>${icon('download')}Beispiel: Stromabrechnung</a>
        <a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=3" download>${icon('download')}Beispiel: Versicherung</a></div></div></div>` : ''}
    </div>`);
  }

  function focus(selector) {
    requestAnimationFrame(() => root.querySelector(selector)?.focus());
  }

  // ---------- Bildverarbeitung ----------

  async function sourceCanvasOf(page) {
    const bitmap = await decodeImage(page.source);
    const canvas = toCanvas(bitmap, MAX_SOURCE_SIDE);
    bitmap.close?.();
    return canvas;
  }

  /** Erzeugt die fertige Seite neu (nach Zuschnitt, Drehung oder Filterwechsel). */
  async function renderInto(page, canvas) {
    const out = await renderPage(canvas, { corners: page.corners, filter: page.filter, rotation: page.rotation });
    if (page.thumb) URL.revokeObjectURL(page.thumb);
    Object.assign(page, { blob: out.blob, size: out.blob.size, thumb: out.thumbUrl, duplicate: null });
    // Eine bereits hochgeladene ältere Fassung wird verworfen und beim Speichern neu übertragen
    if (page.fileId) {
      api.del(`/api/files/${page.fileId}`).catch(() => {});
      page.fileId = null;
    }
    if (page.removed) URL.revokeObjectURL(page.thumb); // während der Bearbeitung entfernt
  }

  /**
   * Aus einem Foto eine Seite machen: Blatt erkennen, zuschneiden, entzerren, verbessern.
   * origin: 'kamera' (Aufnahme) oder 'datei' (importiertes Bild, z. B. Screenshot)
   */
  async function processInto(page, canvas, { found, origin, mime = 'image/jpeg' }) {
    if (Math.min(canvas.width, canvas.height) < MIN_SIDE) throw new Error('Das Bild ist zu klein, um den Text lesen zu können.');
    if (found === undefined) found = await detectCorners(canvas).catch(() => null);
    const area = found ? imageproc.polygonArea(found.corners) : 0;
    // Importierte Bilder nur zuschneiden, wenn das Blatt deutlich erkannt wurde (Screenshots sind oft schon „fertig“)
    const usable = Boolean(found) && area >= 0.12 && (origin === 'kamera' || (found.confidence >= 0.2 && area <= 0.97));
    const screenshot = origin === 'datei' && !/jpe?g|hei[cf]/i.test(mime);
    Object.assign(page, {
      corners: usable ? found.corners : imageproc.defaultCorners(0),
      cropped: usable,
      rotation: page.rotation || 0,
      filter: screenshot ? 'original' : usable || origin === 'kamera' ? 'farbe' : 'original',
      needsCheck: origin === 'kamera' ? !usable || found.confidence < SURE : usable && found.confidence < SURE,
    });
    page.source = await cleanOriginal(canvas); // ohne Standortdaten, für späteres Bearbeiten und als Original
    await renderInto(page, canvas);
    page.busy = false;
  }

  // ---------- Kamera ----------

  function startCamera() {
    const lastImage = [...pages].reverse().find((p) => p.kind === 'image' && p.thumb);
    openCamera({
      pageCount: pages.length,
      lastThumb: lastImage?.thumb || null,
      signal: controller.signal,
      onCapture: async (shot) => {
        if (pages.length >= maxPages) throw new Error(`Höchstens ${maxPages} Seiten pro Brief. Tippen Sie auf „Fertig“.`);
        const page = { id: nextId++, kind: 'image', busy: true, rotation: 0 };
        await processInto(page, shot.canvas, {
          found: shot.corners ? { corners: shot.corners, confidence: shot.confidence } : null,
          origin: 'kamera',
        });
        pages.push(page);
        return { thumbUrl: page.thumb };
      },
      onClose: () => {
        draw();
        focus(pages.length ? '[data-submit]' : '[data-live]');
      },
      onError: (err) => {
        liveFailed = true;
        draw();
        toast(err.message, { error: true });
      },
    });
  }

  // ---------- Dateien und Kamera-App ----------

  async function addFiles(fileList, { fromCameraApp = false } = {}) {
    const jobs = [];
    for (const file of fileList) {
      if (pages.length >= maxPages) {
        toast(`Höchstens ${maxPages} Dateien pro Brief.`, { error: true });
        break;
      }
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
      if (isPdf) {
        if (file.size > maxMb * 1024 * 1024) {
          toast(`„${file.name}“ ist größer als ${maxMb} MB.`, { error: true });
          continue;
        }
        pages.push({ id: nextId++, kind: 'pdf', blob: file, name: file.name, size: file.size });
      } else if (isImage) {
        const page = { id: nextId++, kind: 'image', busy: true, name: file.name, rotation: 0 };
        pages.push(page);
        jobs.push({ page, file });
      } else {
        toast(`„${file.name}“ ist kein Foto und kein PDF.`, { error: true });
      }
    }
    draw();
    // Nacheinander verarbeiten – schont den Speicher auf dem Smartphone
    for (const { page, file } of jobs) {
      let canvas = null;
      try {
        const bitmap = await decodeImage(file);
        canvas = toCanvas(bitmap, MAX_SOURCE_SIDE);
        bitmap.close?.();
        await processInto(page, canvas, { origin: fromCameraApp ? 'kamera' : 'datei', mime: file.type });
      } catch (err) {
        const i = pages.indexOf(page);
        if (i >= 0) pages.splice(i, 1);
        toast(err.message || 'Das Bild konnte nicht verarbeitet werden.', { error: true });
        canvas = null;
      }
      draw();
      // Einzelnes Foto aus der Kamera-App mit unsicherem Zuschnitt: gleich zum Prüfen öffnen
      if (canvas && fromCameraApp && jobs.length === 1 && page.needsCheck && pages.includes(page)) editPage(page, canvas);
    }
  }

  // ---------- Seiten bearbeiten ----------

  async function editPage(page, canvas = null) {
    if (!page || page.kind !== 'image' || page.busy || uploading) return;
    let source = canvas;
    if (!source) {
      page.busy = true;
      draw();
      try {
        source = await sourceCanvasOf(page);
      } catch (err) {
        toast(err.message, { error: true });
      }
      page.busy = false;
      draw();
      if (!source) return;
    }
    const position = () => pages.indexOf(page) + 1;
    openEditor({
      source,
      corners: page.corners,
      rotation: page.rotation,
      filter: page.filter,
      detected: page.needsCheck ? false : null,
      title: `Seite ${position()} bearbeiten`,
      signal: controller.signal,
      onSave: async ({ corners, rotation, filter }) => {
        Object.assign(page, { corners, rotation, filter, cropped: !isFullFrame(corners), needsCheck: false, busy: true });
        draw();
        try {
          await renderInto(page, source);
        } catch (err) {
          toast(err.message, { error: true });
        }
        page.busy = false;
        draw();
        focus(`[data-page="${page.id}"] [data-edit]`);
      },
      onCancel: () => focus(`[data-page="${page.id}"] [data-edit]`),
      onDelete: () => removePage(page),
    });
  }

  async function rotatePage(page) {
    if (!page || page.busy || uploading) return;
    const before = page.rotation;
    page.busy = true;
    draw();
    try {
      const source = await sourceCanvasOf(page);
      page.rotation = (before + 90) % 360;
      await renderInto(page, source);
    } catch (err) {
      page.rotation = before;
      toast(err.message, { error: true });
    }
    page.busy = false;
    draw();
    focus(`[data-page="${page.id}"] [data-rotate]`);
  }

  function removePage(page) {
    const i = pages.indexOf(page);
    if (i < 0) return;
    pages.splice(i, 1);
    page.removed = true;
    if (page.thumb) URL.revokeObjectURL(page.thumb);
    // Nur noch nicht gespeicherte Zwischen-Uploads löschen (gehören zu keinem Brief)
    for (const id of [page.fileId, page.originalFileId]) if (id) api.del(`/api/files/${id}`).catch(() => {});
    draw();
    toast(`Seite ${i + 1} entfernt.`);
    focus(pages.length ? `[data-page="${pages[Math.min(i, pages.length - 1)].id}"] [data-remove]` : '[data-live], [data-camera]');
  }

  // ---------- Speichern ----------

  /** Fragt nach, wenn genau diese Datei schon in einem gespeicherten Brief vorkommt. */
  function askDuplicate(page) {
    const info = page.duplicate;
    const when = info.uploadedAt ? formatUploaded(info.uploadedAt) : '';
    return new Promise((resolve) => {
      openDialog(
        html`<div class="dialog-body stack">
          <h2>Ist dieser Brief schon gespeichert?</h2>
          <p>Genau diese Datei ist bereits gespeichert${when ? ` (hochgeladen am ${when})` : ''}:
            <strong>${info.subject || 'Brief ohne Betreff'}</strong></p>
          <p class="muted">Möchten Sie den Brief trotzdem ein zweites Mal speichern?</p>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-act="abbrechen">Abbrechen</button>
          <button type="button" class="btn btn-secondary" data-act="oeffnen">Gespeicherten Brief öffnen</button>
          <button type="button" class="btn" data-act="speichern">Trotzdem speichern</button>
        </div>`,
        (dialog, close) => {
          let answered = false;
          dialog.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            answered = true;
            resolve(close(act));
          });
          dialog.addEventListener('close', () => {
            if (!answered) resolve('abbrechen');
          });
        }
      );
    });
  }

  async function submit(button) {
    if (uploading || !pages.length || pages.some((p) => p.busy)) return;
    uploading = true;
    const progress = root.querySelector('[data-progress]');
    const text = root.querySelector('[data-progress-text]');
    const bar = root.querySelector('[data-bar]');
    progress.hidden = false;
    root.querySelectorAll('.page-tools button, [data-keep]').forEach((b) => {
      b.disabled = true;
    });
    const steps = [];
    pages.forEach((p, i) => {
      steps.push({ p, i, role: 'seite' });
      if (keepOriginals && p.kind === 'image' && p.source) steps.push({ p, i, role: 'original' });
    });
    let outcome = 'fehler';
    await busy(button, async () => {
      try {
        for (let s = 0; s < steps.length; s++) {
          const { p, i, role } = steps[s];
          const onProgress = (fraction) => {
            bar.style.width = `${Math.round(((s + fraction) / steps.length) * 100)}%`;
          };
          if (role === 'seite' && !p.fileId) {
            text.textContent = `Seite ${i + 1} von ${pages.length} wird sicher übertragen …`;
            const res = await api.upload(p.blob, onProgress);
            p.fileId = res.id;
            p.duplicate = res.duplicateOf || null;
            if (res.sanitized) toast(res.sanitized.message);
          } else if (role === 'original' && !p.originalFileId) {
            text.textContent = `Originalfoto von Seite ${i + 1} wird übertragen …`;
            const res = await api.upload(p.source, onProgress, { 'X-File-Role': 'original' });
            p.originalFileId = res.id;
          }
        }
        bar.style.width = '100%';
        const known = pages.find((p) => p.duplicate);
        if (known) {
          const choice = await askDuplicate(known);
          if (choice === 'abbrechen') {
            outcome = 'abgebrochen';
            return;
          }
          if (choice === 'oeffnen') {
            outcome = 'gespeichert';
            saved = true; // Seiten bewusst verworfen; Zwischen-Uploads räumt der Server auf
            navigate(`/briefe/${known.duplicate.letterId}`);
            return;
          }
        }
        text.textContent = 'Brief wird angelegt …';
        const originalIds = keepOriginals ? pages.filter((p) => p.originalFileId).map((p) => p.originalFileId) : [];
        const { id } = await api.post('/api/letters', { fileIds: pages.map((p) => p.fileId), originalIds });
        outcome = 'gespeichert';
        saved = true;
        pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
        toast('Brief gespeichert. Er wird jetzt gelesen.');
        navigate(`/briefe/${id}`);
      } catch (err) {
        text.textContent = `${err.message} Sie können es erneut versuchen – bereits übertragene Seiten werden nicht doppelt gesendet.`;
        toast(err.message, { error: true });
      } finally {
        uploading = false;
      }
    });
    if (outcome === 'abgebrochen') {
      draw();
      focus('[data-submit]');
    } else if (outcome === 'fehler') {
      draw();
      const p = root.querySelector('[data-progress]');
      if (p) {
        p.hidden = false;
        p.querySelector('[data-progress-text]').textContent = text.textContent;
      }
    }
  }

  // ---------- Ereignisse ----------

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-keep]')) {
      keepOriginals = e.target.checked;
      writePref(KEEP_KEY, keepOriginals ? 'ja' : 'nein');
      return;
    }
    if (e.target.matches('[data-camera], [data-files]') && e.target.files?.length) {
      addFiles([...e.target.files], { fromCameraApp: e.target.matches('[data-camera]') });
    }
  });

  root.addEventListener('click', async (e) => {
    const consent = e.target.closest('[data-consent]');
    if (consent) {
      try {
        await api.post('/api/me/ai-consent', { consent: consent.dataset.consent });
        await refreshMe();
        toast(consent.dataset.consent === 'ja' ? 'KI-Auswertung ist eingeschaltet.' : 'Briefe werden ohne KI gespeichert.');
        draw();
      } catch (err) {
        toast(err.message, { error: true });
      }
      return;
    }
    if (uploading) return;
    if (e.target.closest('[data-live]')) {
      startCamera();
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      editPage(pages[Number(edit.dataset.edit)]);
      return;
    }
    const rotate = e.target.closest('[data-rotate]');
    if (rotate) {
      rotatePage(pages[Number(rotate.dataset.rotate)]);
      return;
    }
    const move = e.target.closest('[data-move]');
    if (move) {
      const i = Number(move.dataset.move);
      const j = i + Number(move.dataset.dir);
      if (j < 0 || j >= pages.length) return;
      [pages[i], pages[j]] = [pages[j], pages[i]];
      draw();
      // Fokus bleibt bei der verschobenen Seite (gleiche Richtung, sonst die andere)
      const same = root.querySelector(`[data-move="${j}"][data-dir="${move.dataset.dir}"]`);
      (same && !same.disabled ? same : root.querySelector(`[data-move="${j}"]:not(:disabled)`))?.focus();
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      removePage(pages[Number(remove.dataset.remove)]);
      return;
    }
    const submitBtn = e.target.closest('[data-submit]');
    if (submitBtn) submit(submitBtn);
  });

  // Warnung beim Schließen des Tabs, solange Seiten noch nicht gespeichert sind
  const onBeforeUnload = (e) => {
    if (pages.length && !saved) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  draw();
  return () => {
    controller.abort();
    window.removeEventListener('beforeunload', onBeforeUnload);
    pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
  };
}
