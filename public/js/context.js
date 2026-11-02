// Langes Drücken (bzw. Rechtsklick) auf Briefe, Ordner, Aufgaben und Antworten öffnet ein
// schlichtes Menü wie in iOS: Verschieben · Kopieren · Teilen · Löschen.
// Elemente kennzeichnen sich mit data-ctx="letter|folder|task|reply", data-id und optional data-name.
import { html } from './html.js';
import { api, download } from './api.js';
import { icon, toast, actionSheet, openDialog, confirmDialog } from './ui.js';
import { formatDate } from './shared/dates.js';

const HOLD_MS = 500;

/** Ordnerauswahl: vorhandenen Ordner antippen oder neuen anlegen. Liefert die Ordner-ID (oder null). */
export function chooseFolder({ title = 'Ordner wählen', current = [] } = {}) {
  return new Promise((resolve) => {
    api.get('/api/objects').then(({ objects }) => {
      const list = objects.filter((o) => o.status !== 'beendet').sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
      const on = new Set(current);
      let settled = false;
      const finish = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      openDialog(html`<div class="dialog-body stack">
        <div class="row"><h2 class="grow">${title}</h2><button class="icon-btn" type="button" data-close aria-label="Schließen">${icon('x')}</button></div>
        <input class="input" type="search" placeholder="Suchen …" data-folder-filter aria-label="Ordner suchen">
        <ul class="pick-list">${list.map((o) => html`<li data-item="${o.name.toLowerCase()}"><button class="pick-item ${on.has(o.id) ? 'is-on' : ''}" type="button" data-pick="${o.id}">
          ${icon('folder')}<span class="grow">${o.name}</span><span class="small muted">${o.letterCount || 0}</span>${on.has(o.id) ? icon('check') : ''}</button></li>`)}</ul>
        <form class="row" data-new-folder novalidate>
          <label class="visually-hidden" for="cf-name">Neuer Ordner</label>
          <input class="input grow" id="cf-name" name="name" maxlength="120" placeholder="Neuer Ordner …" autocomplete="off">
          <button class="btn" type="submit">${icon('folderPlus')}Anlegen</button>
        </form>
      </div>`, (dialog, close) => {
        dialog.addEventListener('close', () => finish(null));
        dialog.querySelector('[data-close]').addEventListener('click', () => close());
        dialog.querySelector('[data-folder-filter]').addEventListener('input', (ev) => {
          const q = ev.target.value.trim().toLowerCase();
          dialog.querySelectorAll('[data-item]').forEach((li) => {
            li.hidden = Boolean(q) && !li.dataset.item.includes(q);
          });
        });
        dialog.addEventListener('click', (ev) => {
          const pick = ev.target.closest('[data-pick]');
          if (!pick) return;
          finish({ id: pick.dataset.pick, name: list.find((o) => o.id === pick.dataset.pick)?.name });
          close();
        });
        dialog.querySelector('[data-new-folder]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const name = ev.target.name.value.trim();
          if (!name) return;
          try {
            const res = await api.post('/api/objects', { type: 'sonstiges', name, identifiers: [] });
            finish({ id: res.object.id, name: res.object.name });
            close();
          } catch (err) {
            toast(err.message, { error: true });
          }
        });
      });
    }).catch((err) => {
      toast(err.message, { error: true });
      resolve(null);
    });
  });
}

/** Datei mit dem Teilen-Menü des Geräts teilen; ohne Teilen-Funktion wird sie heruntergeladen. */
export async function shareFile(url, filename, title) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Die Datei konnte nicht geladen werden.');
  const blob = await res.blob();
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'geteilt';
    } catch (err) {
      if (err?.name === 'AbortError') return 'abgebrochen';
    }
  }
  await download(url, filename);
  return 'heruntergeladen';
}

async function shareText(text, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Text kopiert.');
  } catch {
    toast('Teilen ist auf diesem Gerät nicht möglich.', { error: true });
  }
}

function dateDialog(title, value) {
  return new Promise((resolve) => {
    let result = null;
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>${title}</h2>
      <input class="input" type="date" name="date" value="${value || ''}" required>
      <div class="row"><button class="btn" type="submit">${icon('check')}Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      dialog.addEventListener('close', () => resolve(result));
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      dialog.querySelector('form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        result = ev.target.date.value || null;
        close();
      });
    });
  });
}

function textDialog(title, value) {
  return new Promise((resolve) => {
    let result = null;
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>${title}</h2>
      <input class="input" name="text" value="${value || ''}" maxlength="120" required autocomplete="off">
      <div class="row"><button class="btn" type="submit">${icon('check')}Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      dialog.addEventListener('close', () => resolve(result));
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      dialog.querySelector('form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        result = ev.target.text.value.trim() || null;
        close();
      });
    });
  });
}

// ---------- Menüs je Art ----------

async function letterMenu(id, name, refresh) {
  const detail = () => api.get(`/api/letters/${encodeURIComponent(id)}`);
  actionSheet({
    title: name || 'Brief',
    actions: [
      { label: 'Verschieben', icon: 'folderOpen', onSelect: async () => {
        const d = await detail();
        const target = await chooseFolder({ title: 'Verschieben nach …', current: d.links.map((l) => l.objectId) });
        if (!target) return;
        await api.put(`/api/letters/${id}/links`, { objectIds: [target.id] });
        toast(`Verschoben nach „${target.name}“.`);
        refresh();
      } },
      { label: 'Kopieren', icon: 'copy', onSelect: async () => {
        const d = await detail();
        const target = await chooseFolder({ title: 'Zusätzlich ablegen in …', current: d.links.map((l) => l.objectId) });
        if (!target) return;
        await api.put(`/api/letters/${id}/links`, { objectIds: [...new Set([...d.links.map((l) => l.objectId), target.id])] });
        toast(`Auch in „${target.name}“ abgelegt.`);
        refresh();
      } },
      { label: 'Teilen', icon: 'send', onSelect: () => shareFile(`/api/letters/${id}/pdf`, `${(name || 'Brief').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)}.pdf`, name || 'Brief').catch((e) => toast(e.message, { error: true })) },
      { label: 'Löschen', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: 'Brief löschen?', body: 'Original, Aufgaben und Erinnerungen werden gelöscht.', confirmLabel: 'Löschen', danger: true }))) return;
        await api.del(`/api/letters/${id}`);
        toast('Brief gelöscht.');
        refresh({ left: true });
      } },
    ],
  });
}

function folderMenu(id, name, refresh) {
  actionSheet({
    title: name || 'Ordner',
    actions: [
      { label: 'Umbenennen', icon: 'edit', onSelect: async () => {
        const next = await textDialog('Ordner umbenennen', name);
        if (!next || next === name) return;
        await api.patch(`/api/objects/${id}`, { name: next });
        toast('Umbenannt.');
        refresh();
      } },
      { label: 'Teilen', icon: 'send', onSelect: async () => {
        const d = await api.get(`/api/objects/${id}`);
        const lines = d.letters.map((l) => `• ${l.subject || 'Brief'}${l.sender ? ` – ${l.sender}` : ''}${l.letterDate ? ` (${formatDate(l.letterDate, { short: true })})` : ''}`);
        await shareText(`Ordner „${name}“\n${lines.join('\n') || '(leer)'}`, name);
      } },
      { label: 'Löschen', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: 'Ordner löschen?', body: 'Die Briefe bleiben erhalten.', confirmLabel: 'Löschen', danger: true }))) return;
        await api.del(`/api/objects/${id}`);
        toast('Ordner gelöscht.');
        refresh({ left: true });
      } },
    ],
  });
}

function taskMenu(id, name, refresh) {
  actionSheet({
    title: name || 'Aufgabe',
    actions: [
      { label: 'Verschieben', icon: 'calendar', onSelect: async () => {
        const { task } = await api.get(`/api/tasks/${id}`);
        const date = await dateDialog('Neues Datum', task.dueDate || task.suggestedDate);
        if (!date) return;
        await api.post(`/api/tasks/${id}/confirm`, { checked: true, dueDate: date });
        toast(`Verschoben auf ${formatDate(date, { short: true })}.`);
        refresh();
      } },
      { label: 'Kopieren', icon: 'copy', onSelect: async () => {
        const { task } = await api.get(`/api/tasks/${id}`);
        await api.post('/api/tasks', { title: task.title, kind: task.kind, description: task.description, letterId: task.letterId, dueDate: task.dueDate, dueTime: task.dueTime });
        toast('Kopie angelegt.');
        refresh();
      } },
      { label: 'Teilen', icon: 'send', onSelect: async () => {
        const { task } = await api.get(`/api/tasks/${id}`);
        if (task.status === 'offen' && task.dueDate) {
          await shareFile(`/api/tasks/${id}/ics`, 'termin.ics', task.title).catch((e) => toast(e.message, { error: true }));
        } else {
          await shareText(`${task.title}${task.dueDate ? ` – bis ${formatDate(task.dueDate, { short: true })}` : ''}`, task.title);
        }
      } },
      { label: 'Löschen', icon: 'trash', danger: true, onSelect: async () => {
        await api.del(`/api/tasks/${id}`);
        toast('Aufgabe gelöscht.');
        refresh();
      } },
    ],
  });
}

function replyMenu(id, name, refresh) {
  actionSheet({
    title: name || 'Antwort',
    actions: [
      { label: 'Teilen', icon: 'send', onSelect: () => shareFile(`/api/replies/${id}/pdf`, 'antwort.pdf', name || 'Antwort').catch((e) => toast(e.message, { error: true })) },
      { label: 'Löschen', icon: 'trash', danger: true, onSelect: async () => {
        await api.del(`/api/replies/${id}`);
        toast('Entwurf gelöscht.');
        refresh();
      } },
    ],
  });
}

const MENUS = { letter: letterMenu, folder: folderMenu, task: taskMenu, reply: replyMenu };

/**
 * Einmal beim Start: langes Drücken / Rechtsklick auf [data-ctx] öffnet das passende Menü.
 * refresh({ left }) zeichnet die aktuelle Ansicht neu (left: das Element gibt es nicht mehr).
 */
export function installContextMenus(refresh) {
  let timer = null;
  let start = null;
  let suppressClick = false;
  const open = (el) => {
    const fn = MENUS[el.dataset.ctx];
    if (!fn) return;
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ohne Vibration */
    }
    fn(el.dataset.id, el.dataset.name, (opts = {}) => refresh({ ...opts, kind: el.dataset.ctx, id: el.dataset.id }));
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('[data-ctx]');
    if (!el || e.target.closest('input, textarea, select')) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      open(el);
    }, HOLD_MS);
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  }, { passive: true });
  document.addEventListener('pointerup', cancel, { passive: true });
  document.addEventListener('pointercancel', cancel, { passive: true });
  document.addEventListener('scroll', cancel, { passive: true, capture: true });
  // Nach langem Drücken keinen normalen Klick auslösen
  document.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // Rechtsklick (Computer) öffnet dasselbe Menü
  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-ctx]');
    if (!el) return;
    e.preventDefault();
    cancel();
    if (!suppressClick) open(el);
  });
}
