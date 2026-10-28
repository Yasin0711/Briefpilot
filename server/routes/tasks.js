// Aufgaben, Fristen und Termine: bestätigen, korrigieren, erledigen, Erinnerungen, Kalenderdatei.
import { HttpError, badRequest, notFound, readJson } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { serializeTask } from '../domain/letters.js';
import { scheduleReminders, cancelReminders } from '../domain/reminders.js';
import { TASK_KIND_IDS, REMINDER_OFFSET_IDS, taskKindLabel } from '../../public/js/shared/constants.js';
import {
  isValidIsoDate, isValidTime, todayIn, daysBetween, computeRelativeEnd, zonedTimeToUtc, addDays,
} from '../../public/js/shared/dates.js';

const TASK_SELECT = `SELECT t.*, l.subject AS letter_subject, l.sender AS letter_sender,
  (SELECT f.id || ':' || f.kind FROM files f WHERE f.letter_id = t.letter_id AND f.role = 'seite' ORDER BY f.position LIMIT 1) AS first_file
  FROM tasks t LEFT JOIN letters l ON l.id = t.letter_id`;

function checkDate(value, field, label = 'Datum') {
  if (!isValidIsoDate(value)) throw badRequest(`Bitte ein gültiges ${label} angeben.`, { field });
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) throw badRequest(`Das ${label} ist unplausibel. Bitte prüfen.`, { field });
}

function checkOffsets(offsets) {
  if (offsets === undefined) return undefined;
  if (!Array.isArray(offsets) || offsets.some((o) => !REMINDER_OFFSET_IDS.includes(o))) throw badRequest('Ungültige Erinnerungszeitpunkte.');
  return [...new Set(offsets)];
}

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = ch;
    } else current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const icsUtc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function registerTaskRoutes(router, ctx) {
  const { db } = ctx;

  function ownTask(user, id) {
    const task = db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', id, user.id);
    if (!task) throw notFound('Diese Aufgabe wurde nicht gefunden.');
    return task;
  }

  function withReminders(taskRow) {
    const row = db.get(`${TASK_SELECT} WHERE t.id = ?`, taskRow.id);
    const reminders = db.all("SELECT id, remind_at, label, status FROM reminders WHERE task_id = ? AND status IN ('geplant', 'gesendet') ORDER BY remind_at", taskRow.id);
    return { ...serializeTask(row), reminders: reminders.map((r) => ({ id: r.id, remindAt: r.remind_at, label: r.label, status: r.status })) };
  }

  router.get('/api/tasks', (req, res, { user, query }) => {
    const status = query.get('status');
    const where = ['t.user_id = ?'];
    const params = [user.id];
    if (status) {
      if (!['zu_pruefen', 'offen', 'erledigt'].includes(status)) throw badRequest('Unbekannter Status.');
      where.push('t.status = ?');
      params.push(status);
    }
    const order = status === 'erledigt'
      ? 't.completed_at DESC'
      : 'CASE WHEN t.due_date IS NULL AND t.suggested_date IS NULL THEN 1 ELSE 0 END, COALESCE(t.due_date, t.suggested_date), t.due_time, t.created_at';
    const rows = db.all(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`, ...params);
    const counts = Object.fromEntries(
      db.all('SELECT status, COUNT(*) AS n FROM tasks WHERE user_id = ? GROUP BY status', user.id).map((r) => [r.status, r.n])
    );
    return {
      tasks: rows.map((r) => {
        const [fileId, kind] = String(r.first_file || '').split(':');
        return { ...serializeTask(r), letterFile: fileId ? { id: fileId, kind } : null };
      }),
      counts,
      today: todayIn(user.timezone),
    };
  });

  // Eigene Aufgabe anlegen – vom Nutzer selbst eingetragen, daher direkt „Offen“
  router.post('/api/tasks', async (req, res, { user }) => {
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 160);
    if (!title) throw badRequest('Bitte geben Sie einen Titel ein.', { field: 'title' });
    const kind = TASK_KIND_IDS.includes(body.kind) ? body.kind : 'aufgabe';
    let letterId = null;
    if (body.letterId) {
      const letter = db.get('SELECT id FROM letters WHERE id = ? AND user_id = ?', String(body.letterId), user.id);
      if (!letter) throw notFound('Der Brief wurde nicht gefunden.');
      letterId = letter.id;
    }
    if (body.dueDate) checkDate(body.dueDate, 'dueDate');
    if (body.dueTime && !isValidTime(body.dueTime)) throw badRequest('Bitte eine gültige Uhrzeit angeben.', { field: 'dueTime' });
    const now = new Date().toISOString();
    const id = newId();
    db.run(
      `INSERT INTO tasks (id, user_id, letter_id, title, description, kind, status, origin, due_date, due_time, confirmed_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'offen', 'nutzer', ?, ?, ?, 99, ?, ?)`,
      id, user.id, letterId, title, String(body.description || '').trim().slice(0, 800) || null, kind,
      body.dueDate || null, body.dueDate && body.dueTime ? body.dueTime : null, now, now, now
    );
    const task = db.get('SELECT * FROM tasks WHERE id = ?', id);
    const schedule = scheduleReminders(db, task, user, { offsets: checkOffsets(body.reminders) });
    return { task: withReminders(task), schedule };
  });

  router.patch('/api/tasks/:id', async (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    const body = await readJson(req);
    const updates = {};
    if (body.title !== undefined) {
      const title = String(body.title || '').trim().slice(0, 160);
      if (!title) throw badRequest('Bitte geben Sie einen Titel ein.', { field: 'title' });
      updates.title = title;
    }
    if (body.description !== undefined) updates.description = String(body.description || '').trim().slice(0, 800) || null;
    if (body.kind !== undefined) {
      if (!TASK_KIND_IDS.includes(body.kind)) throw badRequest('Unbekannte Art.');
      updates.kind = body.kind;
    }
    if (!Object.keys(updates).length) return { task: withReminders(task) };
    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    db.run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), task.id);
    return { task: withReminders(db.get('SELECT * FROM tasks WHERE id = ?', task.id)) };
  });

  /**
   * Frist / Termin bestätigen oder korrigieren.
   * Regeln:
   *  - Ein Datum muss ausdrücklich mit dem Original verglichen worden sein (checked = true).
   *  - Relative Fristen brauchen ein bestätigtes Zugangsdatum (receivedDate).
   *  - Ohne Datum übernehmen geht nur mit ausdrücklicher Angabe (withoutDate = true).
   */
  router.post('/api/tasks/:id/confirm', async (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    if (task.status === 'erledigt') throw badRequest('Diese Aufgabe ist bereits erledigt.');
    const body = await readJson(req);
    const today = todayIn(user.timezone);
    const offsets = checkOffsets(body.reminders);
    const letter = task.letter_id ? db.get('SELECT * FROM letters WHERE id = ?', task.letter_id) : null;
    let dueDate = null;
    let dueTime = null;
    const warnings = [];

    if (body.checked !== true) {
      throw badRequest('Bitte bestätigen Sie, dass Sie die Angaben mit dem Brief verglichen haben.', { field: 'checked' });
    }

    if (task.is_relative && body.withoutDate !== true && !body.receivedDate) {
      throw badRequest('Diese Frist hängt davon ab, wann Sie den Brief erhalten haben. Bitte geben Sie das Zugangsdatum an.', { field: 'receivedDate' });
    }

    // Schnell-Bestätigung mit Zugangsdatum: Fristende aus der Regel berechnen
    if (task.is_relative && body.receivedDate && !body.dueDate && body.withoutDate !== true && task.relative_rule) {
      checkDate(body.receivedDate, 'receivedDate', 'Zugangsdatum');
      const computed = computeRelativeEnd(JSON.parse(task.relative_rule), { receivedDate: body.receivedDate, letterDate: letter?.letter_date }).date;
      if (!computed) throw badRequest('Das Fristende ließ sich nicht berechnen. Bitte im Brief bestätigen.', { field: 'dueDate' });
      body.dueDate = computed;
    }
    if (body.withoutDate === true) {
      dueDate = null;
    } else {
      checkDate(body.dueDate, 'dueDate', task.kind === 'termin' ? 'Termindatum' : 'Datum');
      if (body.dueTime) {
        if (!isValidTime(body.dueTime)) throw badRequest('Bitte eine gültige Uhrzeit angeben (z. B. 09:30).', { field: 'dueTime' });
        dueTime = body.dueTime;
      }
      dueDate = body.dueDate;

      if (task.is_relative) {
        if (!body.receivedDate) {
          throw badRequest('Diese Frist hängt davon ab, wann Sie den Brief erhalten haben. Bitte geben Sie das Zugangsdatum an.', { field: 'receivedDate' });
        }
        checkDate(body.receivedDate, 'receivedDate', 'Zugangsdatum');
        if (daysBetween(today, body.receivedDate) > 0) throw badRequest('Das Zugangsdatum kann nicht in der Zukunft liegen.', { field: 'receivedDate' });
        if (letter?.letter_date && daysBetween(letter.letter_date, body.receivedDate) < 0) {
          throw badRequest('Das Zugangsdatum liegt vor dem Briefdatum. Bitte prüfen.', { field: 'receivedDate' });
        }
        if (daysBetween(body.receivedDate, dueDate) < 0) throw badRequest('Das Fristende kann nicht vor dem Zugangsdatum liegen.', { field: 'dueDate' });
        const rule = task.relative_rule ? JSON.parse(task.relative_rule) : null;
        const computed = rule ? computeRelativeEnd(rule, { receivedDate: body.receivedDate, letterDate: letter?.letter_date }).date : null;
        if (computed && computed !== dueDate) warnings.push('Das eingetragene Fristende weicht vom rechnerischen Vorschlag ab. Ihre Angabe wurde übernommen.');
        if (letter) {
          db.run('UPDATE letters SET received_date = ?, updated_at = ? WHERE id = ?', body.receivedDate, new Date().toISOString(), letter.id);
        }
      }
      if (daysBetween(today, dueDate) < 0) warnings.push('Das Datum liegt in der Vergangenheit.');
    }

    const now = new Date().toISOString();
    db.run(
      `UPDATE tasks SET status = 'offen', due_date = ?, due_time = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
      dueDate, dueTime, now, now, task.id
    );
    const fresh = db.get('SELECT * FROM tasks WHERE id = ?', task.id);
    const schedule = scheduleReminders(db, fresh, user, { offsets });
    if (dueDate && schedule.planned === 0) warnings.push('Es wurde keine Erinnerung geplant, weil alle gewählten Zeitpunkte schon vorbei sind.');
    return { task: withReminders(fresh), schedule, warnings };
  });

  router.post('/api/tasks/:id/done', (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    const now = new Date().toISOString();
    db.run("UPDATE tasks SET status = 'erledigt', completed_at = ?, updated_at = ? WHERE id = ?", now, now, task.id);
    cancelReminders(db, task.id);
    return { task: withReminders(db.get('SELECT * FROM tasks WHERE id = ?', task.id)) };
  });

  router.post('/api/tasks/:id/reopen', (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    if (task.status !== 'erledigt') throw badRequest('Diese Aufgabe ist nicht erledigt.');
    const status = task.confirmed_at ? 'offen' : 'zu_pruefen';
    db.run('UPDATE tasks SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ?', status, new Date().toISOString(), task.id);
    const fresh = db.get('SELECT * FROM tasks WHERE id = ?', task.id);
    if (status === 'offen') scheduleReminders(db, fresh, user, {});
    return { task: withReminders(fresh) };
  });

  router.delete('/api/tasks/:id', (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    db.run('DELETE FROM tasks WHERE id = ?', task.id);
    return { ok: true };
  });

  router.put('/api/tasks/:id/reminders', async (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    if (task.status !== 'offen') throw badRequest('Erinnerungen gibt es nur für bestätigte, offene Aufgaben.');
    const body = await readJson(req);
    const offsets = checkOffsets(body.offsets || []);
    let custom = null;
    if (body.customDate) {
      checkDate(body.customDate, 'customDate');
      const time = body.customTime && isValidTime(body.customTime) ? body.customTime : '08:00';
      custom = zonedTimeToUtc(body.customDate, time, user.timezone).toISOString();
      if (Date.parse(custom) <= Date.now()) throw badRequest('Der Erinnerungszeitpunkt liegt in der Vergangenheit.', { field: 'customDate' });
    }
    if (!task.due_date && offsets.length) throw badRequest('Ohne Datum sind nur eigene Erinnerungszeitpunkte möglich.');
    const schedule = scheduleReminders(db, task, user, { offsets, custom });
    return { task: withReminders(task), schedule };
  });

  router.post('/api/reminders/:id/seen', (req, res, { user, params }) => {
    const r = db.run('UPDATE reminders SET seen_at = ? WHERE id = ? AND user_id = ?', new Date().toISOString(), params.id, user.id);
    if (!r.changes) throw notFound();
    return { ok: true };
  });

  // Kalenderdatei (.ics) für einen bestätigten Termin – nur auf ausdrücklichen Klick des Nutzers
  router.get('/api/tasks/:id/ics', (req, res, { user, params }) => {
    const task = ownTask(user, params.id);
    if (task.status !== 'offen' || !task.due_date) throw new HttpError(400, 'Nur bestätigte Aufgaben mit Datum können in den Kalender übernommen werden.');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BriefPilot//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${task.id}@briefpilot`, `DTSTAMP:${icsUtc(new Date())}`,
    ];
    if (task.due_time) {
      const start = zonedTimeToUtc(task.due_date, task.due_time, user.timezone);
      lines.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(new Date(start.getTime() + 3600_000))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${task.due_date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(task.due_date, 1).replace(/-/g, '')}`);
    }
    lines.push(
      `SUMMARY:${icsEscape(`${taskKindLabel(task.kind)}: ${task.title}`)}`,
      `DESCRIPTION:${icsEscape('Aus BriefPilot übernommen. Bitte im Original-Brief prüfen.')}`,
      'END:VEVENT', 'END:VCALENDAR'
    );
    const body = lines.map(icsFold).join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="briefpilot-${task.due_date}.ics"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
}
