// Sicherung auf dem Gerät: Weil der kostenlose Server bei jedem Neustart seine Daten verliert,
// hält die App eine vollständige Kopie (Konto, Einstellungen, Briefe, Dateien …) im Speicher des
// Gerätes. Fehlt das Konto auf dem Server, spielt die App diese Kopie wieder ein.
//
// Sicherheit: Die Sicherung ist mit einem Schlüssel des Servers signiert (abgeleitet aus
// FILE_ENCRYPTION_KEY). Nur vom Server ausgestellte, unveränderte Sicherungen werden angenommen;
// Dateien müssen zum gespeicherten SHA-256 passen.
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, readJson, readBody, deviceLabel } from '../lib/http.js';
import { createSession, isGuest, logSecurityEvent } from '../lib/security.js';
import { SCHEMA_VERSION } from '../db.js';
import { setSessionCookie, serializeUser } from './auth.js';

// Reihenfolge = Abhängigkeiten (beim Einspielen werden Fremdschlüssel ohnehin kurz ausgesetzt)
export const BACKUP_TABLES = [
  'folders', 'persons', 'addresses', 'objects', 'cases', 'identifiers', 'letters', 'files',
  'letter_links', 'tasks', 'reminders', 'replies', 'letter_messages', 'letter_events',
];
const FORMAT = 'briefpilot-sicherung';

function signingKey(config) {
  return crypto.createHmac('sha256', Buffer.from(config.fileEncryptionKey || '', 'base64')).update('briefpilot-backup-v1').digest();
}
export function signBackup(config, text) {
  return crypto.createHmac('sha256', signingKey(config)).update(text).digest('base64url');
}
function verifySignature(config, text, sig) {
  const expected = Buffer.from(signBackup(config, text));
  const given = Buffer.from(String(sig || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const columnsOf = (db, table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);

export function registerBackupRoutes(router, ctx) {
  const { db, config, storage, limiter } = ctx;

  /** Vollständige Sicherung des eigenen Kontos (ohne Dateiinhalte – die holt die App einzeln). */
  router.get('/api/backup', (req, res, { user }) => {
    if (user.is_demo) throw badRequest('Demo-Konten werden nicht gesichert.');
    const tables = {};
    for (const t of BACKUP_TABLES) {
      const rows = db.all(`SELECT * FROM ${t} WHERE user_id = ?`, user.id);
      tables[t] = t === 'files' ? rows.map(({ storage_key: _k, ...rest }) => rest) : rows;
    }
    const { password_hash: hash, ...account } = db.get('SELECT * FROM users WHERE id = ?', user.id);
    const text = JSON.stringify({
      format: FORMAT, version: 1, schema: SCHEMA_VERSION, createdAt: new Date().toISOString(),
      user: { ...account, password_hash: hash }, tables,
    });
    return { backup: text, sig: signBackup(config, text) };
  });

  /** Sicherung vom Gerät einspielen (wenn der Server das Konto nicht mehr kennt). */
  router.post('/api/backup/restore', async (req, res, { ip }) => {
    limiter.hit(`restore:${ip}`, 20, 3600_000, 'Zu viele Wiederherstellungen. Bitte später erneut versuchen.');
    const body = await readJson(req, 80 * 1024 * 1024);
    const text = String(body.backup || '');
    if (!text || !verifySignature(config, text, body.sig)) {
      throw badRequest('Diese Sicherung stammt nicht von diesem BriefPilot-Server oder wurde verändert.');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw badRequest('Die Sicherung ist beschädigt.');
    }
    if (data.format !== FORMAT || !data.user?.id) throw badRequest('Unbekanntes Sicherungsformat.');
    if (Number(data.schema) > SCHEMA_VERSION) throw badRequest('Die Sicherung ist neuer als der Server. Bitte später erneut versuchen.');
    const u = data.user;

    const existing = db.get('SELECT * FROM users WHERE id = ?', u.id);
    if (existing) {
      // Konto ist noch da: Gastkonten (ohne Passwort) dürfen sich mit ihrer Sicherung wieder anmelden
      if (!isGuest(existing)) throw new HttpError(409, 'Dieses Konto ist noch vorhanden. Bitte melden Sie sich an.');
      const session = createSession(db, existing.id, deviceLabel(req.headers['user-agent']), 365);
      setSessionCookie(res, config, session.token, session.maxAge);
      return { user: serializeUser(existing), restored: false, pendingFiles: pendingFiles(existing.id) };
    }
    if (db.get('SELECT id FROM users WHERE email = ?', u.email)) {
      throw new HttpError(409, 'Für diese E-Mail-Adresse gibt es bereits ein anderes Konto. Bitte melden Sie sich an.');
    }

    const raw = db.raw;
    raw.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.tx(() => {
        insertRows(db, 'users', [u]);
        for (const t of BACKUP_TABLES) {
          let rows = Array.isArray(data.tables?.[t]) ? data.tables[t] : [];
          rows = rows.filter((r) => r && r.user_id === u.id); // nur Zeilen dieses Kontos
          if (t === 'files') rows = rows.map((r) => ({ ...r, storage_key: '' })); // Inhalt folgt einzeln
          insertRows(db, t, rows);
        }
      });
    } finally {
      raw.exec('PRAGMA foreign_keys = ON;');
    }
    // Unterbrochene Auswertungen nicht automatisch neu starten (Dateien kommen erst noch)
    db.run("UPDATE letters SET analysis_status = 'fehler', analysis_error = 'Bitte erneut auswerten.' WHERE user_id = ? AND analysis_status IN ('wartet', 'laeuft')", u.id);
    logSecurityEvent(db, u.id, 'sicherung_eingespielt');
    const session = createSession(db, u.id, deviceLabel(req.headers['user-agent']), isGuest(u) ? 365 : undefined);
    setSessionCookie(res, config, session.token, session.maxAge);
    return { user: serializeUser(db.get('SELECT * FROM users WHERE id = ?', u.id)), restored: true, pendingFiles: pendingFiles(u.id) };
  }, { auth: false });

  /** Inhalt einer Datei aus der Gerätesicherung nachreichen (muss zum gespeicherten SHA-256 passen). */
  router.put('/api/backup/files/:id', async (req, res, { user, params }) => {
    const file = db.get("SELECT * FROM files WHERE id = ? AND user_id = ? AND storage_key = ''", params.id, user.id);
    if (!file) throw notFound('Diese Datei wird nicht erwartet.');
    const data = await readBody(req, config.limits.maxFileBytes);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== file.sha256) throw badRequest('Die Datei passt nicht zur Sicherung.');
    const key = await storage.put(user.id, data);
    db.run('UPDATE files SET storage_key = ? WHERE id = ?', key, file.id);
    return { ok: true, left: pendingFiles(user.id).length };
  });

  function pendingFiles(userId) {
    return db.all("SELECT id FROM files WHERE user_id = ? AND storage_key = ''", userId).map((r) => r.id);
  }

  function insertRows(database, table, rows) {
    if (!rows.length) return;
    const cols = new Set(columnsOf(database, table));
    for (const row of rows) {
      const keys = Object.keys(row).filter((k) => cols.has(k));
      database.run(
        `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        ...keys.map((k) => row[k])
      );
    }
  }
}
