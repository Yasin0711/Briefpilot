// Brief erfassen: mit der Kamera fotografieren oder Dateien wählen, Seiten ordnen, hochladen.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, toast, formatBytes, busy } from '../ui.js';

const MAX_EDGE = 2200;
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Dieses Bild kann Ihr Browser nicht öffnen (zum Beispiel das iPhone-Format HEIC). Bitte fotografieren Sie direkt über „Seite fotografieren“.'));
    };
    img.src = url;
  });
}

/** Verkleinert Fotos und speichert sie als JPEG. Dabei gehen auch Standortdaten (EXIF) verloren – gewollt. */
async function prepareImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await loadImageElement(file);
  }
  const w = source.width;
  const h = source.height;
  if (w < 300 || h < 300) throw new Error('Das Bild ist zu klein, um den Text lesen zu können.');
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Das Foto konnte nicht verarbeitet werden.');
  return blob;
}

export async function render({ root, query, state, navigate, refreshMe }) {
  const pages = []; // { id, kind, blob, name, size, thumb, fileId }
  let uploading = false;
  const maxMb = state.status?.limits?.maxFileMb || 15;
  const maxPages = state.status?.limits?.maxPages || 20;

  function consentCard() {
    const ai = state.status?.ai;
    if (!ai?.enabled) {
      return html`<div class="note">${icon('info')}<div><strong>Ohne KI-Auswertung</strong>
        <p>Auf diesem Server ist keine KI eingerichtet. PDFs mit Text werden mit einer einfachen Erkennung gelesen. Fotos werden sicher gespeichert, aber nicht automatisch gelesen – Sie können die Angaben dann selbst eintragen.</p></div></div>`;
    }
    if (state.me.aiConsent === 'nein') {
      return html`<div class="note">${icon('info')}<div><strong>KI-Auswertung ist ausgeschaltet</strong>
        <p>Sie haben die KI-Auswertung abgelehnt. Fotos werden nur gespeichert. Sie können das jederzeit in den <a href="#/einstellungen">Einstellungen</a> ändern.</p></div></div>`;
    }
    if (state.me.aiConsent === 'ja') return '';
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

  function draw() {
    const fileFirst = query.get('modus') === 'datei';
    const cameraBtn = html`<label class="btn btn-scan btn-block capture-btn">${icon('camera')}${pages.length ? 'Weitere Seite fotografieren' : 'Seite fotografieren'}
      <input type="file" accept="image/*" capture="environment" data-camera aria-label="Seite mit der Kamera fotografieren"></label>`;
    const fileBtn = html`<label class="btn btn-secondary btn-block capture-btn">${icon('upload')}Bilder oder PDF auswählen
      <input type="file" accept="${ACCEPT}" multiple data-files aria-label="Bilder oder PDF-Dateien auswählen"></label>`;
    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Brief scannen</h1><p>Fotografieren Sie jede Seite einzeln oder laden Sie ein PDF hoch. Mehrere Seiten werden zu einem Brief zusammengefasst.</p></div></div>
      ${consentCard()}
      ${state.me.isDemo ? html`<div class="note note-warn">${icon('info')}<div class="stack"><p><strong>Demomodus:</strong> Bitte laden Sie keine echten Briefe hoch. Zum Ausprobieren können Sie einen erfundenen Beispielbrief herunterladen und dann hier hochladen:</p>
        <div class="row"><a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=0" download>${icon('download')}Beispiel: Stromabrechnung</a>
        <a class="btn btn-small btn-secondary" href="/api/demo/beispielbrief?nr=3" download>${icon('download')}Beispiel: Versicherung</a></div></div></div>` : ''}

      <div class="capture-grid">${fileFirst ? [fileBtn, cameraBtn] : [cameraBtn, fileBtn]}</div>

      ${pages.length ? html`<section class="stack" aria-labelledby="pages-h">
        <h2 id="pages-h">${pages.length === 1 ? '1 Seite' : `${pages.length} Seiten`} in diesem Brief</h2>
        <ol class="pages">${pages.map((p, i) => html`<li class="page-item">
          <span class="page-num">${i + 1}</span>
          ${p.kind === 'image' ? html`<img class="page-thumb" src="${p.thumb}" alt="Vorschau Seite ${i + 1}">` : html`<span class="page-thumb is-pdf">${icon('file')}</span>`}
          <span class="grow"><span class="row-title">${p.kind === 'pdf' ? p.name : `Foto ${i + 1}`}</span><span class="row-sub">${p.kind === 'pdf' ? 'PDF' : 'Foto'}, ${formatBytes(p.size)}</span>
            ${p.duplicate ? html`<span class="badge badge-review">${icon('alert')}Schon einmal hochgeladen</span>` : ''}</span>
          <span class="page-tools">
            <button class="icon-btn" type="button" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Seite ${i + 1} nach oben">${icon('arrowUp')}</button>
            <button class="icon-btn" type="button" data-move="${i}" data-dir="1" ${i === pages.length - 1 ? 'disabled' : ''} aria-label="Seite ${i + 1} nach unten">${icon('arrowDown')}</button>
            <button class="icon-btn" type="button" data-remove="${i}" aria-label="Seite ${i + 1} entfernen">${icon('trash')}</button>
          </span></li>`)}</ol>
        <div data-progress hidden class="stack"><p data-progress-text class="small"></p><div class="progress"><span data-bar></span></div></div>
        <button class="btn btn-block" type="button" data-submit>${icon('check')}Brief speichern und auswerten</button>
      </section>` : html`<section class="panel stack">
        <h2>Tipps für gut lesbare Fotos</h2>
        <ul class="tips">
          <li>Brief flach auf einen dunklen Tisch legen.</li>
          <li>Für gutes Licht sorgen, ohne Schatten oder Spiegelungen.</li>
          <li>Die ganze Seite muss im Bild sein, gerade von oben fotografieren.</li>
          <li>Jede Seite einzeln fotografieren – auch die Rückseite, wenn sie bedruckt ist.</li>
        </ul>
        <p class="small muted">Erlaubt: Fotos (JPG, PNG, WebP) und PDF-Dateien bis ${maxMb} MB, höchstens ${maxPages} Dateien pro Brief.</p>
      </section>`}
    </div>`);
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      if (pages.length >= maxPages) {
        toast(`Höchstens ${maxPages} Dateien pro Brief.`, { error: true });
        break;
      }
      try {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > maxMb * 1024 * 1024) throw new Error(`„${file.name}“ ist größer als ${maxMb} MB.`);
          pages.push({ kind: 'pdf', blob: file, name: file.name, size: file.size });
        } else if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) {
          const blob = await prepareImage(file);
          pages.push({ kind: 'image', blob, size: blob.size, thumb: URL.createObjectURL(blob) });
        } else {
          throw new Error(`„${file.name}“ ist kein Foto und kein PDF.`);
        }
      } catch (err) {
        toast(err.message, { error: true });
      }
    }
    draw();
  }

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-camera], [data-files]') && e.target.files?.length) addFiles([...e.target.files]);
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
    const move = e.target.closest('[data-move]');
    if (move && !uploading) {
      const i = Number(move.dataset.move);
      const j = i + Number(move.dataset.dir);
      [pages[i], pages[j]] = [pages[j], pages[i]];
      draw();
      root.querySelector(`[data-move="${j}"][data-dir="${move.dataset.dir}"]`)?.focus();
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove && !uploading) {
      const [p] = pages.splice(Number(remove.dataset.remove), 1);
      if (p.thumb) URL.revokeObjectURL(p.thumb);
      if (p.fileId) api.del(`/api/files/${p.fileId}`).catch(() => {});
      draw();
      return;
    }
    const submit = e.target.closest('[data-submit]');
    if (submit && !uploading) {
      uploading = true;
      const progress = root.querySelector('[data-progress]');
      const text = root.querySelector('[data-progress-text]');
      const bar = root.querySelector('[data-bar]');
      progress.hidden = false;
      await busy(submit, async () => {
        try {
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            if (p.fileId) continue; // bei erneutem Versuch nicht doppelt hochladen
            text.textContent = `Seite ${i + 1} von ${pages.length} wird sicher übertragen …`;
            const res = await api.upload(p.blob, (fraction) => {
              bar.style.width = `${Math.round(((i + fraction) / pages.length) * 100)}%`;
            });
            p.fileId = res.id;
            if (res.duplicateOf) {
              p.duplicate = true;
              toast(`Hinweis: Seite ${i + 1} haben Sie schon einmal hochgeladen.`);
            }
          }
          text.textContent = 'Brief wird angelegt …';
          const { id } = await api.post('/api/letters', { fileIds: pages.map((p) => p.fileId) });
          pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
          toast('Brief gespeichert. Er wird jetzt gelesen.');
          navigate(`/briefe/${id}`);
        } catch (err) {
          text.textContent = `${err.message} Sie können es erneut versuchen.`;
          toast(err.message, { error: true });
        } finally {
          uploading = false;
        }
      });
    }
  });

  draw();
  return () => pages.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
}
