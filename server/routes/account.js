// Konto: Einstellungen, Passwort, KI-Freigabe, Geräte, Export, Löschung, Push.
import { HttpError, badRequest, readJson } from '../lib/http.js';
import { hashPassword, verifyPassword, passwordProblem, newId, logSecurityEvent, isGuest } from '../lib/security.js';
import { isAllowedPushEndpoint } from '../lib/push.js';
import { createZip } from '../lib/zip.js';
import { serializeUser, clearSessionCookie } from './auth.js';
import { userSettings } from '../domain/reminders.js';
import { REMINDER_OFFSET_IDS } from '../../public/js/shared/constants.js';
import { isValidTime } from '../../public/js/shared/dates.js';
import { serializeLetter, serializeTask } from '../domain/letters.js';
import { deviceLabel } from '../lib/http.js';

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeName(value) {
  return String(value || '').normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'brief';
}

export function registerAccountRoutes(router, ctx) {
  const { db, config, storage, push, limiter } = ctx;

  router.patch('/api/me', async (req, res, { user }) => {
    const body = await readJson(req);
    const updates = {};
    if (body.name !== undefined) updates.name = String(body.name || '').trim().slice(0, 80) || null;
    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) throw badRequest('Unbekannte Zeitzone.');
      updates.timezone = body.timezone;
    }
    if (body.settings !== undefined) {
      const current = userSettings(user);
      const s = body.settings || {};
      const next = { ...current };
      if (s.reminderOffsets !== undefined) {
        if (!Array.isArray(s.reminderOffsets) || s.reminderOffsets.some((o) => !REMINDER_OFFSET_IDS.includes(o))) throw badRequest('Ungültige Erinnerungszeitpunkte.');
        next.reminderOffsets = [...new Set(s.reminderOffsets)];
      }
      if (s.reminderTime !== undefined) {
        if (!isValidTime(s.reminderTime)) throw badRequest('Bitte eine gültige Uhrzeit angeben (z. B. 08:00).');
        next.reminderTime = s.reminderTime;
      }
      if (s.emailReminders !== undefined) next.emailReminders = s.emailReminders === true;
      if (s.notificationDetails !== undefined) next.notificationDetails = s.notificationDetails === true;
      updates.settings = JSON.stringify(next);
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      db.run(
        `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...keys.map((k) => updates[k]), new Date().toISOString(), user.id
      );
    }
    return { user: serializeUser(db.get('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  router.post('/api/me/password', async (req, res, { user, sessionId, ip }) => {
    limiter.hit(`pwchange:${user.id}`, 10, 3600_000);
    const body = await readJson(req);
    if (user.is_demo) throw badRequest('Im Demomodus gibt es kein Passwort.');
    if (isGuest(user)) throw badRequest('Ohne Konto gibt es kein Passwort.');
    if (!(await verifyPassword(String(body.currentPassword || ''), user.password_hash))) {
      throw badRequest('Das aktuelle Passwort ist falsch.', { field: 'currentPassword' });
    }
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) throw badRequest(problem, { field: 'newPassword' });
    const hash = await hashPassword(body.newPassword, config.passwordHashCost);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, new Date().toISOString(), user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, sessionId);
    });
    logSecurityEvent(db, user.id, 'passwort_geaendert');
    void ip;
    return { ok: true };
  });

  router.post('/api/me/ai-consent', async (req, res, { user }) => {
    const body = await readJson(req);
    if (!['ja', 'nein'].includes(body.consent)) throw badRequest('Bitte „ja“ oder „nein“ angeben.');
    db.run('UPDATE users SET ai_consent = ?, ai_consent_at = ?, updated_at = ? WHERE id = ?', body.consent, new Date().toISOString(), new Date().toISOString(), user.id);
    logSecurityEvent(db, user.id, body.consent === 'ja' ? 'ki_freigegeben' : 'ki_abgelehnt');
    return { user: serializeUser(db.get('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  router.get('/api/me/sessions', (req, res, { user, sessionId }) => ({
    sessions: db.all('SELECT id, device, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', user.id)
      .map((s) => ({ id: s.id.slice(0, 16), device: s.device, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === sessionId })),
    events: db.all('SELECT event, created_at FROM security_events WHERE user_id = ? ORDER BY id DESC LIMIT 15', user.id)
      .map((e) => ({ event: e.event, at: e.created_at })),
  }));

  router.post('/api/me/sessions/logout-others', (req, res, { user, sessionId }) => {
    const r = db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, sessionId);
    logSecurityEvent(db, user.id, 'andere_geraete_abgemeldet');
    return { removed: r.changes };
  });

  router.delete('/api/me/sessions/:id', (req, res, { user, params }) => {
    if (!/^[0-9a-f]{16}$/.test(params.id)) throw badRequest('Ungültige Sitzung.');
    db.run("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", user.id, params.id);
    return { ok: true };
  });

  // ---------- Datenexport ----------
  router.get('/api/me/export', async (req, res, { user }) => {
    limiter.hit(`export:${user.id}`, 5, 3600_000, 'Bitte warten Sie etwas, bevor Sie erneut exportieren.');
    const letters = db.all('SELECT * FROM letters WHERE user_id = ? ORDER BY letter_date, uploaded_at', user.id);
    const tasks = db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at', user.id);
    const reminders = db.all('SELECT id, task_id, remind_at, label, status, sent_at, delivery_json, seen_at FROM reminders WHERE user_id = ?', user.id);
    const files = db.all('SELECT * FROM files WHERE user_id = ? AND letter_id IS NOT NULL ORDER BY letter_id, position', user.id);
    const rowsOf = (table, order = 'created_at') => db.all(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY ${order}`, user.id);
    const withoutUser = (rows) => rows.map(({ user_id: _u, ...rest }) => rest);
    const entries = [];
    const letterFolders = new Map();
    for (const l of letters) {
      letterFolders.set(l.id, `briefe/${l.letter_date || 'ohne-datum'}_${safeName(l.sender)}_${l.id.slice(0, 8)}`);
    }
    for (const f of files) {
      const folder = letterFolders.get(f.letter_id);
      if (!folder) continue;
      const ext = f.kind === 'pdf' ? 'pdf' : f.mime.split('/')[1].replace('jpeg', 'jpg');
      const name = f.role === 'original'
        ? `${folder}/originalaufnahme-${String(f.position - 999).padStart(2, '0')}.${ext}`
        : `${folder}/seite-${String(f.position + 1).padStart(2, '0')}.${ext}`;
      entries.push({ name, data: await storage.get(f.storage_key) });
    }
    const data = {
      exportiertAm: new Date().toISOString(),
      hinweis: 'Vollständiger Export Ihrer Daten aus BriefPilot.',
      konto: serializeUser(user),
      briefe: letters.map((l) => ({ ...serializeLetter(l), ordner: letterFolders.get(l.id) })),
      aufgaben: tasks.map(serializeTask),
      erinnerungen: reminders,
      akten: withoutUser(rowsOf('objects')),
      kennungen: withoutUser(rowsOf('identifiers')),
      vorgaenge: withoutUser(rowsOf('cases')),
      zuordnungen: withoutUser(rowsOf('letter_links')),
      personen: withoutUser(rowsOf('persons')),
      adressen: withoutUser(rowsOf('addresses')),
      antworten: withoutUser(rowsOf('replies')),
      fragen: withoutUser(rowsOf('letter_messages')),
      verlauf: withoutUser(rowsOf('letter_events', 'id')),
      geraete: db.all('SELECT device, created_at, last_seen_at FROM sessions WHERE user_id = ?', user.id),
      sicherheitsereignisse: db.all('SELECT event, created_at FROM security_events WHERE user_id = ?', user.id),
    };
    entries.unshift({ name: 'daten.json', data: JSON.stringify(data, null, 2) });
    entries.unshift({
      name: 'LIESMICH.txt',
      data: 'BriefPilot – Datenexport\n\ndaten.json enthält alle gespeicherten Angaben (Konto, Briefe, Erklärungen, Aufgaben, Erinnerungen, Akten mit Nummern, Zuordnungen, Personen, Adressen, Antwortbriefe, Fragen an die KI und Verlauf).\nIm Ordner „briefe“ liegen Ihre Originaldokumente, je Brief ein Unterordner.\n',
    });
    const zip = createZip(entries);
    logSecurityEvent(db, user.id, 'daten_exportiert');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="briefpilot-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Content-Length': zip.length,
      'Cache-Control': 'no-store',
    });
    res.end(zip);
  });

  // ---------- Konto löschen ----------
  router.post('/api/me/delete', async (req, res, { user }) => {
    const body = await readJson(req);
    if (body.confirm !== 'LÖSCHEN') throw badRequest('Bitte geben Sie zur Bestätigung LÖSCHEN ein.', { field: 'confirm' });
    if (!user.is_demo && !isGuest(user) && !(await verifyPassword(String(body.password || ''), user.password_hash))) {
      throw badRequest('Das Passwort ist falsch.', { field: 'password' });
    }
    await deleteUserCompletely(ctx, user.id);
    clearSessionCookie(res, config);
    return { ok: true };
  });

  // ---------- Push-Benachrichtigungen ----------
  router.post('/api/push/subscribe', async (req, res, { user }) => {
    if (!push.enabled) throw new HttpError(503, 'Push-Benachrichtigungen sind auf diesem Server nicht eingerichtet.');
    const body = await readJson(req);
    const endpoint = String(body.endpoint || '');
    const p256dh = String(body.keys?.p256dh || '');
    const auth = String(body.keys?.auth || '');
    if (!isAllowedPushEndpoint(endpoint)) throw badRequest('Dieser Push-Dienst wird nicht unterstützt.');
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) throw badRequest('Ungültige Push-Daten.');
    const count = db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', user.id).n;
    if (count >= 10) throw badRequest('Es sind bereits 10 Geräte für Benachrichtigungen angemeldet. Bitte entfernen Sie zuerst ein Gerät.');
    db.run(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
      newId(), user.id, endpoint, p256dh, auth, deviceLabel(req.headers['user-agent']), new Date().toISOString()
    );
    return { ok: true };
  });

  router.post('/api/push/unsubscribe', async (req, res, { user }) => {
    const body = await readJson(req);
    db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', user.id, String(body.endpoint || ''));
    return { ok: true };
  });

  router.get('/api/push/devices', (req, res, { user }) => ({
    devices: db.all('SELECT id, device, created_at, last_success_at, failures FROM push_subscriptions WHERE user_id = ?', user.id),
  }));

  router.post('/api/push/test', async (req, res, { user }) => {
    limiter.hit(`pushtest:${user.id}`, 5, 600_000);
    if (!push.enabled) throw new HttpError(503, 'Push-Benachrichtigungen sind auf diesem Server nicht eingerichtet.');
    const subs = db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', user.id);
    if (!subs.length) throw badRequest('Auf keinem Gerät sind Benachrichtigungen eingeschaltet.');
    let ok = 0;
    for (const sub of subs) {
      const r = await push.send(sub, { title: 'BriefPilot', body: 'Test: Benachrichtigungen funktionieren.', url: '/#/einstellungen', tag: 'test' });
      if (r.ok) ok++;
      else if (r.gone) db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
    }
    return { sent: ok, total: subs.length };
  });
}

export async function deleteUserCompletely(ctx, userId) {
  const { db, storage } = ctx;
  db.run('DELETE FROM users WHERE id = ?', userId); // alle abhängigen Daten werden mitgelöscht (ON DELETE CASCADE)
  await storage.removeUser(userId);
}
