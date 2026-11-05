// Brief erfassen wie mit einem Dokumentenscanner: Live-Kamera mit automatischer Kantenerkennung,
// Fotos, Screenshots und PDFs importieren, Seiten zuschneiden, entzerren, verbessern, drehen und sortieren.
// Hochgeladen wird jede Seite als bearbeitetes JPEG; die Originalfotos auf Wunsch zusätzlich.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, formatBytes, busy, openDialog, formatUploaded, naStar } from '../ui.js';
import { liveCameraAvailable, openCamera } from '../scanner/camera.js';
import { takePendingFiles } from '../pending.js';
import { openEditor } from '../scanner/editor.js';
import { FILTERS, MAX_SOURCE_SIDE, decodeImage, toCanvas, detectCorners, renderPage, cleanOriginal, imageproc } from '../scanner/processing.js';
import { afterBack } from '../scanner/overlay.js';
import { letterPickSheet } from '../folderSheet.js';
import { lastPage } from '../app.js';

const ALL_ACCEPT = 'application/pdf,image/*,.heic,.heif,.pptx,.docx,.xlsx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BULK_STATUS = { wartet: 'wartet', laedt: 'wird übertragen …', fertig: 'gespeichert – wird gelesen', doppelt: 'schon vorhanden – übersprungen', fehler: 'Fehler' };
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

/*
 * Scan-Sitzung: bleibt erhalten, solange die App offen ist. So lassen sich mehrere Briefe nacheinander
 * scannen („Brief speichern“ in der Kamera, oder erneut auf „Hinzufügen“), ohne den Scanner zu verlassen.
 * draft = Brief, der gerade entsteht: { no, pages, target: { id, subject } | null }
 * letters = schon gespeicherte (oder gerade übertragene) Briefe dieser Sitzung.
 */
const session = { letters: [], draft: null, nextNo: 1, nextKey: 1 };
let nextId = 1;

function newDraft(target = null) {
  return { no: target ? null : session.nextNo++, pages: [], target };
}

function resetSession() {
  for (const e of session.letters) if (e.thumb) URL.revokeObjectURL(e.thumb);
  for (const p of session.draft?.pages || []) if (p.thumb) URL.revokeObjectURL(p.thumb);
  session.letters = [];
  session.nextNo = 1;
  session.draft = newDraft();
}

export async function render({ root, query, state, navigate, refreshMe }) {
  /** Seite: { id, kind: 'image'|'pdf', blob, size, thumb, source, corners, rotation, filter, cropped, needsCheck,
   *           busy, fileId, originalFileId, duplicate, name } */
  if (!session.draft) session.draft = newDraft();
  // ?zu=<Brief-ID>: Seiten zu einem bestehenden Brief hinzufügen
  const zu = /^[\w-]{8,64}$/.test(query.get('zu') || '') ? query.get('zu') : null;
  if (zu && !session.draft.pages.length) session.draft = newDraft({ id: zu, subject: null });
  let pages = session.draft.pages;
  let uploading = false;
  let saved = false;
  let liveFailed = false;
  let keepOriginals = readPref(KEEP_KEY, 'nein') === 'ja';
  let cam = null; // Steuerung der offenen Kamera (siehe openCamera → onMount)
  const target = () => session.draft.target;
  const controller = new AbortController(); // schließt Kamera und Editor, wenn die Seite verlassen wird
  const maxMb = state.status?.limits?.maxFileMb || 15;
  const maxPages = state.status?.limits?.maxPages || 20;

  /** Kurzer Hinweis, wenn Fotos nicht automatisch gelesen werden. */
  function aiNote() {
    const ai = state.status?.ai;
    if (!ai?.enabled) {
      return html`<p class="small na-row">Fotos automatisch lesen (KI)${naStar()}</p>`;
    }
    if (state.me.aiConsent === 'nein') {
      return html`<div class="note">${icon('info')}<div><strong>KI-Auswertung ist ausgeschaltet</strong>
        <p>Fotos werden nur gespeichert. Ändern in den <a href="#/einstellungen">Einstellungen</a> ändern.</p></div></div>`;
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

  // ---------- Viele Dokumente auf einmal (Bestand importieren) ----------
  let bulk = null; // { items: [{ name, size, status, error, letterId, progress }], running }

  function bulkSection() {
    const items = bulk?.items || [];
    const done = items.filter((i) => ['fertig', 'doppelt', 'fehler'].includes(i.status)).length;
    return html`<section class="panel stack" aria-label="Dateien">
      <p class="small" aria-live="polite"><strong>${done} von ${items.length}</strong> Dateien</p>
      <ul class="bulk-list">${items.map((it) => html`<li class="bulk-item is-${it.status}">
        <span class="grow"><span class="row-title">${it.name}</span>
          <span class="row-sub">${it.status === 'laedt' ? `${Math.round((it.progress || 0) * 100)} %` : BULK_STATUS[it.status]}${it.error ? `: ${it.error}` : ''}</span></span>
        ${it.letterId ? html`<a class="btn btn-small btn-ghost" href="#/briefe/${it.letterId}">Öffnen</a>` : ''}</li>`)}</ul>
      ${!bulk.running && done === items.length ? html`<a class="btn btn-block" href="#/briefe">${icon('mail')}Zu den Briefen</a>` : ''}
    </section>`;
  }

  async function runBulk(files) {
    bulk = { running: true, items: files.map((f) => ({ file: f, name: f.name, size: f.size, status: 'wartet' })) };
    draw();
    for (const it of bulk.items) {
      it.status = 'laedt';
      draw();
      try {
        const res = await api.upload(it.file, (fraction) => {
          it.progress = fraction;
          const row = root.querySelectorAll('.bulk-item')[bulk.items.indexOf(it)];
          const sub = row?.querySelector('.row-sub');
          if (sub) sub.textContent = `${Math.round(fraction * 100)} %`;
        });
        if (res.duplicateOf) {
          it.status = 'doppelt';
          it.letterId = res.duplicateOf.letterId;
          api.del(`/api/files/${res.id}`).catch(() => {});
        } else {
          const { id } = await api.post('/api/letters', { fileIds: [res.id] });
          it.status = 'fertig';
          it.letterId = id;
        }
      } catch (err) {
        it.status = 'fehler';
        it.error = err.message;
      }
      it.file = null;
      draw();
    }
    bulk.running = false;
    const ok = bulk.items.filter((i) => i.status === 'fertig').length;
    // Eine einzelne Datei: gleich den Brief öffnen
    if (bulk.items.length === 1 && ok === 1 && !pages.length) {
      saved = true;
      navigate(`/briefe/${bulk.items[0].letterId}`);
      return;
    }
    toast(`${ok} ${ok === 1 ? 'Dokument' : 'Dokumente'} gespeichert. Sie werden jetzt gelesen und zugeordnet.`);
    draw();
  }

  /** Gescannte Briefe dieser Sitzung (oben links in der Kamera, hier als Liste). */
  function lettersSection() {
    if (!session.letters.length) return '';
    const status = (e) => {
      if (e.status === 'speichert') return html`<span class="row-sub">${e.target ? 'Seiten werden angehängt …' : 'Wird gespeichert …'}</span>
        <div class="progress progress-s"><span data-entry-bar="${e.key}" style="width:${Math.round((e.progress || 0) * 100)}%"></span></div>`;
      if (e.status === 'fehler') return html`<span class="row-sub scan-entry-error">${e.error || 'Speichern hat nicht geklappt.'}</span>`;
      return html`<span class="row-sub">${e.pageCount} ${e.pageCount === 1 ? 'Seite' : 'Seiten'} · ${e.target ? 'angehängt' : 'gespeichert'}</span>`;
    };
    return html`<section class="stack" aria-labelledby="scan-letters-h" data-scan-letters>
      <h2 id="scan-letters-h">Gescannte Briefe</h2>
      <ul class="list panel panel-plain scan-letters">${session.letters.map((e) => html`<li class="scan-entry" data-entry="${e.key}">
        <span class="scan-entry-thumb" aria-hidden="true">${e.thumb ? html`<img src="${e.thumb}" alt="">` : icon('file')}</span>
        <span class="grow scan-entry-main"><span class="row-title">${e.target ? `Zu „${e.target.subject || 'Brief'}“` : `Brief ${e.no}`}</span>${status(e)}</span>
        <span class="scan-entry-actions">
          ${e.status === 'gespeichert' ? html`
            <button class="icon-btn" type="button" data-entry-add="${e.key}" aria-label="Seiten hinzufügen" title="Seiten hinzufügen">${icon('plus')}</button>
            <a class="btn btn-small btn-secondary" href="#/briefe/${e.letterId}">Öffnen</a>` : ''}
          ${e.status === 'fehler' ? html`<button class="btn btn-small btn-secondary" type="button" data-entry-retry="${e.key}">${icon('refresh')}Erneut</button>` : ''}
          ${e.status === 'speichert' ? html`<span class="spinner spinner-s" aria-hidden="true"></span>` : ''}
        </span></li>`)}</ul>
      ${pages.length ? '' : html`<button class="btn btn-block" type="button" data-scan-finish ${session.letters.some((e) => e.status === 'speichert') ? 'disabled' : ''}>${icon('check')}Fertig</button>`}
    </section>`;
  }

  function draw() {
    const live = liveCameraAvailable() && !liveFailed;
    const count = pages.length;
    const working = pages.some((p) => p.busy);
    const hasImages = pages.some((p) => p.kind === 'image');
    const t = target();
    const scanBtn = (label, cls) => (live
      ? html`<button class="btn ${cls}" type="button" data-live>${icon('camera')}${label}</button>`
      : html`<label class="btn ${cls} capture-btn">${icon('camera')}${label}
          <input type="file" accept="image/*" capture="environment" data-camera aria-label="${label}"></label>`);
    const filesBtn = (cls) => html`<label class="btn btn-secondary ${cls} capture-btn">${icon('folder')}Dateien
      <input type="file" accept="${ALL_ACCEPT}" multiple data-files aria-label="Dateien hochladen"></label>`;
    const multi = session.letters.length > 0;
    const heading = t ? `Seiten für „${t.subject || 'Brief'}“` : multi ? `Brief ${session.draft.no}` : '';

    mount(root, html`<div class="stack-l">
      ${zu && t?.id === zu && !multi ? html`<div class="row"><h1 class="grow">Seiten hinzufügen</h1><a class="btn btn-small btn-ghost" href="#/briefe/${zu}">Abbrechen</a></div>` : html`<h1 class="visually-hidden">Scannen</h1>`}
      ${consentCard()}
      ${lettersSection()}
      ${!count && !bulk && !multi ? html`<div class="scan-start">
        ${scanBtn('Scannen', 'btn-scan btn-block scan-start-main')}
        ${filesBtn('btn-block')}
        ${state.status?.mailImport?.enabled ? html`<a class="btn btn-ghost btn-block" href="#/email-import">${icon('mail')}E-Mail importieren</a>` : ''}
      </div>` : ''}
      ${!count && multi ? html`<div class="row">${scanBtn('Nächsten Brief scannen', 'btn-secondary grow')}${filesBtn('')}</div>` : ''}

      ${bulk ? bulkSection() : ''}

      ${count ? html`<section class="stack" aria-labelledby="pages-h">
        ${heading ? html`<p class="scan-draft-head"><strong>${heading}</strong>${t && !zu ? html` <button class="btn btn-ghost btn-small" type="button" data-untarget>Als eigenen Brief</button>` : ''}</p>` : ''}
        <div class="row"><h2 id="pages-h" class="grow">${count === 1 ? '1 Seite' : `${count} Seiten`}</h2>
          ${scanBtn('Weitere', 'btn-small btn-secondary')}${filesBtn('btn-small')}</div>
        <ol class="pages">${pages.map((p, i) => pageItem(p, i))}</ol>
        ${hasImages ? html`<label class="check"><input type="checkbox" data-keep ${keepOriginals ? 'checked' : ''} ${uploading ? 'disabled' : ''}>
          <span>Originalfotos aufbewahren</span></label>` : ''}
        <div data-progress hidden class="stack"><p data-progress-text class="small" aria-live="polite"></p><div class="progress"><span data-bar></span></div></div>
        <button class="btn btn-block" type="button" data-submit ${working || uploading ? 'disabled' : ''}>${icon('check')}${working ? 'Wird bearbeitet …' : t ? 'Zum Brief hinzufügen' : 'Brief speichern'}</button>
        ${t ? '' : html`<button class="btn btn-secondary btn-block" type="button" data-attach ${working || uploading ? 'disabled' : ''}>${icon('plus')}Zu einem Brief hinzufügen</button>`}
      </section>` : ''}

      ${aiNote()}
      ${state.me.isDemo ? html`<div class="note note-warn">${icon('info')}<div class="stack"><p><strong>Demo:</strong> keine echten Briefe. Beispiele:</p>
        <div class="row"><a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=0" download>${icon('download')}Stromabrechnung</a>
        <a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=3" download>${icon('download')}Versicherung</a></div></div></div>` : ''}
    </div>`);
  }

  /** Dateien aus dem Ordner: Fotos werden Seiten dieses Briefs, PDFs und Office-Dateien je ein eigenes Dokument. */
  function handlePicked(files) {
    const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
    if (target()) {
      addFiles(files); // alles wird Seite des bestehenden Briefs
      return;
    }
    const images = files.filter(isImage);
    const docs = files.filter((f) => !isImage(f));
    if (images.length) addFiles(images);
    if (docs.length) {
      if (bulk?.running) toast('Bitte warten, bis die anderen Dateien übertragen sind.', { error: true });
      else runBulk(docs);
    }
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

  function lastThumb() {
    return [...pages].reverse().find((p) => p.kind === 'image' && p.thumb)?.thumb || null;
  }

  function startCamera() {
    openCamera({
      pageCount: pages.length,
      lastThumb: lastThumb(),
      signal: controller.signal,
      letterCount: session.letters.length,
      titlePrefix: cameraTitle(),
      saveLabel: target() ? 'Hinzufügen' : 'Brief speichern',
      onMount: (handle) => {
        cam = handle;
      },
      onCapture: async (shot) => {
        if (pages.length >= maxPages) throw new Error(`Höchstens ${maxPages} Seiten pro Brief. Tippen Sie auf „Brief speichern“.`);
        const page = { id: nextId++, kind: 'image', busy: true, rotation: 0 };
        await processInto(page, shot.canvas, {
          found: shot.corners ? { corners: shot.corners, confidence: shot.confidence } : null,
          origin: 'kamera',
        });
        pages.push(page);
        return { thumbUrl: page.thumb };
      },
      // Galerie: Bilder werden Seiten dieses Briefs, die Kamera bleibt offen
      onGallery: async (files) => {
        await addFiles(files);
        cam?.setPages(pages.length, lastThumb());
      },
      // Brief speichern, ohne den Scanner zu verlassen – danach beginnt der nächste Brief
      onSave: async () => {
        const entry = finishDraft();
        if (!entry) return;
        cam?.setPages(0, null);
        cam?.setLetters(session.letters.length);
        cam?.setTitle(cameraTitle(), 'Brief speichern');
        cam?.setHint(entry.target ? 'Seiten werden angehängt …' : `Brief ${entry.no} wird gespeichert – nächsten Brief hinlegen`);
      },
      onList: () => focus('[data-scan-letters] h2'),
      onFiles: (files) => handlePicked(files),
      fileAccept: ALL_ACCEPT,
      onClose: ({ failed = false } = {}) => {
        cam = null;
        if (failed) return; // onError zeigt die Seite mit Foto-Dialog und Dateien
        // Nichts gescannt: zurück dorthin, wo man herkam
        if (!pages.length && !session.letters.length && !bulk && !controller.signal.aborted) {
          afterBack().then(() => {
            if (root.isConnected) location.hash = lastPage('#/');
          });
          return;
        }
        draw();
        focus(pages.length ? '[data-submit]' : '[data-scan-letters] h2');
      },
      onError: (err) => {
        cam = null;
        liveFailed = true;
        draw();
        toast(err.message, { error: true });
      },
    });
  }

  /** Neuer Brief (erneut „Hinzufügen“ oder „Nächsten Brief scannen“): bisherigen speichern, Kamera öffnen. */
  function nextLetter() {
    if (cam?.isOpen()) return;
    if (pages.length) {
      try {
        const entry = finishDraft();
        if (entry) toast(entry.target ? 'Seiten werden angehängt.' : `Brief ${entry.no} wird gespeichert.`);
      } catch (err) {
        toast(err.message, { error: true });
        return;
      }
    } else if (target() && !zu) {
      session.draft = newDraft();
      pages = session.draft.pages;
    }
    draw();
    if (liveCameraAvailable() && !liveFailed) startCamera();
    else root.querySelector('[data-camera]')?.click();
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

  /**
   * Seiten eines Briefs übertragen und den Brief anlegen (oder an einen bestehenden anhängen).
   * Unabhängig von der Anzeige – läuft auch weiter, während die Kamera offen ist.
   * @returns {Promise<{ outcome: 'gespeichert'|'abgebrochen'|'vorhanden', id?: string }>}
   */
  async function saveDraft(d, { onText = () => {}, onBar = () => {} } = {}) {
    const list = d.pages;
    const steps = [];
    list.forEach((p, i) => {
      steps.push({ p, i, role: 'seite' });
      if (keepOriginals && p.kind === 'image' && p.source) steps.push({ p, i, role: 'original' });
    });
    for (let s = 0; s < steps.length; s++) {
      const { p, i, role } = steps[s];
      const onProgress = (fraction) => onBar((s + fraction) / steps.length);
      if (role === 'seite' && !p.fileId) {
        onText(`Seite ${i + 1} von ${list.length} wird sicher übertragen …`);
        let res;
        try {
          res = await api.upload(p.blob, onProgress);
        } catch (err) {
          // Bei vielen Dateien sagen, welche nicht geklappt hat
          err.message = `${p.kind === 'pdf' && p.name ? `„${p.name}“` : `Seite ${i + 1}`}: ${err.message}`;
          throw err;
        }
        p.fileId = res.id;
        p.duplicate = res.duplicateOf || null;
        if (res.sanitized) toast(res.sanitized.message);
      } else if (role === 'original' && !p.originalFileId) {
        onText(`Originalfoto von Seite ${i + 1} wird übertragen …`);
        const res = await api.upload(p.source, onProgress, { 'X-File-Role': 'original' });
        p.originalFileId = res.id;
      }
    }
    onBar(1);
    const known = d.target ? null : list.find((p) => p.duplicate);
    if (known) {
      const choice = await askDuplicate(known);
      if (choice === 'abbrechen') return { outcome: 'abgebrochen' };
      if (choice === 'oeffnen') return { outcome: 'vorhanden', id: known.duplicate.letterId };
    }
    if (d.target) {
      // Seiten an einen bestehenden Brief anhängen
      await api.post(`/api/letters/${d.target.id}/pages`, { fileIds: list.map((p) => p.fileId) });
      return { outcome: 'gespeichert', id: d.target.id };
    }
    onText('Brief wird angelegt …');
    const originalIds = keepOriginals ? list.filter((p) => p.originalFileId).map((p) => p.originalFileId) : [];
    const { id } = await api.post('/api/letters', { fileIds: list.map((p) => p.fileId), originalIds });
    return { outcome: 'gespeichert', id };
  }

  /** Eintrag in der Liste „Gescannte Briefe“; das erste Seitenbild bleibt als Vorschau. */
  function addEntry(d, status = 'speichert') {
    const first = d.pages.find((p) => p.thumb);
    const entry = { key: session.nextKey++, no: d.no, target: d.target, pageCount: d.pages.length, thumb: first?.thumb || null, status, progress: 0, draft: d };
    d.pages.forEach((p) => {
      if (p.thumb && p !== first) URL.revokeObjectURL(p.thumb);
    });
    session.letters.push(entry);
    return entry;
  }

  /** Seiten, die an einen Brief dieser Sitzung gehängt wurden, zählen bei diesem Brief mit (keine eigene Zeile). */
  function mergeIntoSessionLetter(entry) {
    if (!entry.target) return;
    const host = session.letters.find((x) => x !== entry && !x.target && x.letterId === entry.target.id);
    if (!host) return;
    host.pageCount += entry.pageCount;
    if (entry.thumb) URL.revokeObjectURL(entry.thumb);
    session.letters.splice(session.letters.indexOf(entry), 1);
  }

  function redraw() {
    if (root.isConnected && !uploading) draw();
  }

  /** Brief im Hintergrund speichern (Kamera bleibt offen). */
  async function saveInBackground(entry) {
    entry.status = 'speichert';
    entry.error = null;
    redraw();
    try {
      const res = await saveDraft(entry.draft, {
        onBar: (f) => {
          entry.progress = f;
          const bar = root.querySelector(`[data-entry-bar="${entry.key}"]`);
          if (bar) bar.style.width = `${Math.round(f * 100)}%`;
        },
      });
      if (res.outcome === 'abgebrochen') {
        session.letters.splice(session.letters.indexOf(entry), 1);
        toast(`Brief ${entry.no} nicht gespeichert.`);
      } else {
        entry.status = 'gespeichert';
        entry.letterId = res.id;
        entry.draft = null;
        mergeIntoSessionLetter(entry);
        cam?.setHint(entry.target ? 'Seiten angehängt' : `Brief ${entry.no} gespeichert`);
      }
    } catch (err) {
      entry.status = 'fehler';
      entry.error = err.message;
      toast(err.message, { error: true });
    }
    cam?.setLetters(session.letters.length);
    redraw();
  }

  /** Aktuellen Brief abschließen und einen neuen beginnen – das Speichern läuft im Hintergrund. */
  function finishDraft() {
    const d = session.draft;
    if (!d.pages.length) return null;
    if (d.pages.some((p) => p.busy)) throw new Error('Einen Moment – die Seite wird noch bearbeitet.');
    const entry = addEntry(d);
    session.draft = newDraft();
    pages = session.draft.pages;
    saveInBackground(entry);
    return entry;
  }

  function cameraTitle() {
    const t = target();
    if (t) return 'Anhängen · ';
    return session.letters.length ? `Brief ${session.draft.no} · ` : '';
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
    const d = session.draft;
    let outcome = 'fehler';
    await busy(button, async () => {
      try {
        const res = await saveDraft(d, {
          onText: (t) => {
            text.textContent = t;
          },
          onBar: (f) => {
            bar.style.width = `${Math.round(f * 100)}%`;
          },
        });
        outcome = res.outcome;
        if (res.outcome === 'abgebrochen') return;
        // Mehrere Briefe in dieser Sitzung: in der Liste bleiben, sonst den Brief öffnen
        if (session.letters.length) {
          const entry = addEntry(d, 'gespeichert');
          entry.letterId = res.id;
          entry.draft = null;
          mergeIntoSessionLetter(entry);
          session.draft = newDraft();
          pages = session.draft.pages;
          toast(d.target ? 'Seiten hinzugefügt.' : `Brief ${entry.no} gespeichert.`);
          return;
        }
        saved = true;
        d.pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
        d.pages.length = 0;
        resetSession();
        pages = session.draft.pages;
        if (res.outcome === 'vorhanden') {
          navigate(`/briefe/${res.id}`);
          return;
        }
        toast(d.target ? 'Seiten hinzugefügt. Der Brief wird neu gelesen.' : 'Brief gespeichert. Er wird jetzt gelesen.');
        navigate(`/briefe/${res.id}`);
      } catch (err) {
        text.textContent = err.message;
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
    } else if (root.isConnected && session.letters.length) {
      draw();
    }
  }

  // ---------- Ereignisse ----------

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-keep]')) {
      keepOriginals = e.target.checked;
      writePref(KEEP_KEY, keepOriginals ? 'ja' : 'nein');
      return;
    }
    if (e.target.matches('[data-files]') && e.target.files?.length) {
      handlePicked([...e.target.files]);
      e.target.value = '';
      return;
    }
    if (e.target.matches('[data-camera]') && e.target.files?.length) {
      addFiles([...e.target.files], { fromCameraApp: true });
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
        if (liveCameraAvailable() && !liveFailed) startCamera();
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
    if (submitBtn) {
      submit(submitBtn);
      return;
    }
    // Statt eines eigenen Briefs: an einen bestehenden Brief anhängen
    if (e.target.closest('[data-attach]')) {
      const chosen = await letterPickSheet({
        first: session.letters.filter((x) => x.status === 'gespeichert' && !x.target).map((x) => ({ id: x.letterId, subject: `Brief ${x.no}` })),
      });
      if (!chosen) return;
      session.draft.target = chosen;
      draw();
      submit(root.querySelector('[data-submit]'));
      return;
    }
    if (e.target.closest('[data-untarget]')) {
      session.draft.target = null;
      session.draft.no = session.nextNo++;
      draw();
      return;
    }
    const add = e.target.closest('[data-entry-add]');
    if (add) {
      // Weitere Seiten zu einem gerade gescannten Brief
      const entry = session.letters.find((x) => String(x.key) === add.dataset.entryAdd);
      if (!entry || pages.length) {
        if (pages.length) toast('Bitte zuerst den aktuellen Brief speichern.', { error: true });
        return;
      }
      session.draft = newDraft({ id: entry.letterId, subject: entry.target?.subject || `Brief ${entry.no}` });
      pages = session.draft.pages;
      draw();
      if (liveCameraAvailable() && !liveFailed) startCamera();
      return;
    }
    const retry = e.target.closest('[data-entry-retry]');
    if (retry) {
      const entry = session.letters.find((x) => String(x.key) === retry.dataset.entryRetry);
      if (entry?.draft) saveInBackground(entry);
      return;
    }
    if (e.target.closest('[data-scan-finish]')) {
      const done = session.letters.filter((x) => x.status === 'gespeichert');
      const one = done.length === 1 ? done[0].letterId : null;
      saved = true;
      resetSession();
      pages = session.draft.pages;
      navigate(one ? `/briefe/${one}` : '/briefe');
    }
  });

  // Warnung beim Schließen des Tabs, solange Seiten noch nicht gespeichert sind
  const onBeforeUnload = (e) => {
    if ((pages.length && !saved) || session.letters.some((x) => x.status === 'speichert')) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  draw();
  // Über das Plus-Menü gewählte Dateien übernehmen
  const pending = takePendingFiles();
  if (pending?.files?.length) {
    if (pending.fromCamera) addFiles(pending.files, { fromCameraApp: true });
    else handlePicked(pending.files);
  }
  // Direkt in den Scanner – außer beim Hochladen von Dateien oder solange die KI-Frage offen ist
  const consentOpen = state.status?.ai?.enabled && !['ja', 'nein'].includes(state.me.aiConsent);
  if (!pending && query.get('modus') !== 'datei' && !consentOpen && liveCameraAvailable()) startCamera();
  // Erneut auf „Hinzufügen“ (Plus in der Mitte), während der Scanner offen ist: nächster Brief
  const onScanNew = () => nextLetter();
  window.addEventListener('bp:scan-new', onScanNew);
  return () => {
    controller.abort();
    cam = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('bp:scan-new', onScanNew);
    // Ungespeicherte Seiten bleiben für die Rückkehr erhalten; sonst beginnt die nächste Sitzung frisch
    if (!session.draft.pages.length && !session.letters.some((x) => x.status === 'speichert')) resetSession();
  };
}
