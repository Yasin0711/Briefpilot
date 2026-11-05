// Sicherung auf diesem Gerät (IndexedDB): Konto, Einstellungen, Briefe, Ordner – und alle Dateien.
// Der kostenlose Server verliert bei jedem Neustart seine Daten. Fehlt das Konto dort, spielt die
// App diese Kopie automatisch wieder ein (siehe restoreFromDevice).
import { api } from './api.js';

const DB_NAME = 'briefpilot-sicherung';
const META = 'meta';
const FILES = 'files';
const MIN_GAP_MS = 60_000; // höchstens einmal pro Minute ohne Änderung
let dbPromise = null;
let running = null;
let lastRun = 0;
let timer = null;
let again = false; // während einer laufenden Sicherung kam eine Änderung dazu
let retryTimer = null;
let retries = 0;

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Kein Gerätespeicher verfügbar.'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => {
      result = r;
    });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const getMeta = () => tx(META, 'readonly', (s) => req2p(s.get('current'))).catch(() => null);
const putMeta = (value) => tx(META, 'readwrite', (s) => {
  s.put(value, 'current');
});
const fileKeys = () => tx(FILES, 'readonly', (s) => req2p(s.getAllKeys())).catch(() => []);
const getFile = (id) => tx(FILES, 'readonly', (s) => req2p(s.get(id)));
const putFile = (id, value) => tx(FILES, 'readwrite', (s) => {
  s.put(value, id);
});
const deleteFile = (id) => tx(FILES, 'readwrite', (s) => {
  s.delete(id);
});

/** Kurzer Stand für die Einstellungen. */
export async function backupInfo() {
  const meta = await getMeta();
  if (!meta) return null;
  return { savedAt: meta.savedAt, files: meta.fileCount || 0, bytes: meta.bytes || 0, userId: meta.userId, loggedOut: Boolean(meta.loggedOut) };
}

/** Gibt es eine Sicherung, die automatisch eingespielt werden darf? */
export async function hasRestorableBackup({ includeLoggedOut = false } = {}) {
  const meta = await getMeta();
  return Boolean(meta?.backup && meta?.sig && (includeLoggedOut || !meta.loggedOut));
}

/** Sicherung aktualisieren: Kontodaten neu, Dateien nur, wenn sie noch fehlen. */
export async function syncBackup(me, { force = false } = {}) {
  if (!me || me.isDemo) return null;
  if (running) {
    if (force) again = true; // danach gleich noch einmal, damit nichts fehlt
    return running;
  }
  if (!force && Date.now() - lastRun < MIN_GAP_MS) return null;
  running = (async () => {
    try {
      const { backup, sig } = await api.get('/api/backup');
      const data = JSON.parse(backup);
      const files = data.tables?.files || [];
      const have = new Set(await fileKeys());
      let bytes = 0;
      for (const f of files) {
        bytes += f.size || 0;
        if (have.has(f.id)) continue;
        const res = await fetch(`/api/files/${encodeURIComponent(f.id)}`, { credentials: 'same-origin' });
        if (!res.ok) continue; // z. B. Datei gerade erst hochgeladen – beim nächsten Mal
        await putFile(f.id, { blob: await res.blob(), sha256: f.sha256, kind: f.kind, mime: f.mime });
      }
      const wanted = new Set(files.map((f) => f.id));
      for (const id of have) if (!wanted.has(id)) await deleteFile(id);
      await putMeta({ backup, sig, userId: me.id, savedAt: new Date().toISOString(), fileCount: files.length, bytes, loggedOut: false });
      lastRun = Date.now();
      retries = 0;
      return true;
    } catch {
      // z. B. kurz offline: bis zu dreimal später erneut versuchen
      if (force && retries < 3) {
        retries += 1;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => syncBackup(me, { force: true }), 30_000 * retries);
      }
      return false;
    } finally {
      running = null;
      if (again) {
        again = false;
        setTimeout(() => syncBackup(me, { force: true }), 0);
      }
    }
  })();
  return running;
}

/** Sofort sichern – z. B. direkt nach jedem neuen Brief. */
export function backupNow(me) {
  clearTimeout(timer);
  lastRun = 0;
  return syncBackup(me, { force: true });
}

/** Nach Änderungen bald sichern (gebündelt). */
export function scheduleBackup(me, delay = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    lastRun = 0;
    syncBackup(me);
  }, delay);
}

/** Beim Abmelden: Sicherung behalten, aber nicht mehr automatisch einspielen. */
export async function markLoggedOut() {
  const meta = await getMeta();
  if (meta) await putMeta({ ...meta, loggedOut: true });
}

/** Sicherung auf diesem Gerät vollständig löschen (z. B. wenn das Konto gelöscht wurde). */
export async function clearBackup() {
  await tx(META, 'readwrite', (s) => {
    s.clear();
  }).catch(() => {});
  await tx(FILES, 'readwrite', (s) => {
    s.clear();
  }).catch(() => {});
}

/**
 * Sicherung vom Gerät auf den Server spielen.
 * @returns {Promise<{ ok: boolean, conflict?: boolean, message?: string }>}
 */
export async function restoreFromDevice(onProgress = () => {}) {
  const meta = await getMeta();
  if (!meta?.backup) return { ok: false, message: 'Keine Sicherung auf diesem Gerät.' };
  let res;
  try {
    res = await api.post('/api/backup/restore', { backup: meta.backup, sig: meta.sig });
  } catch (err) {
    return { ok: false, conflict: err.status === 409, message: err.message };
  }
  const pending = res.pendingFiles || [];
  let done = 0;
  for (const id of pending) {
    onProgress(done, pending.length);
    const f = await getFile(id).catch(() => null);
    if (f?.blob) {
      try {
        await api.raw('PUT', `/api/backup/files/${encodeURIComponent(id)}`, f.blob);
      } catch {
        /* einzelne Datei fehlt – der Rest geht weiter */
      }
    }
    done++;
  }
  onProgress(done, pending.length);
  await putMeta({ ...meta, loggedOut: false });
  return { ok: true, restored: res.restored };
}

/** Den Browser bitten, die Sicherung nicht automatisch zu löschen. */
export function requestPersistentStorage() {
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* nicht unterstützt */
  }
}
