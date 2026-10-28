// Erinnerungen: planen (nur für bestätigte Aufgaben) und zum Zeitpunkt zustellen.
import { newId } from '../lib/security.js';
import { REMINDER_OFFSETS, DEFAULT_SETTINGS, taskKindLabel } from '../../public/js/shared/constants.js';
import { addDays, zonedTimeToUtc, formatDate, isValidTime } from '../../public/js/shared/dates.js';

export function userSettings(user) {
  let parsed = {};
  try {
    parsed = JSON.parse(user.settings || '{}');
  } catch {
    parsed = {};
  }
  return { ...DEFAULT_SETTINGS, ...parsed };
}

function minus(time, hours) {
  const [h, m] = time.split(':').map(Number);
  const total = Math.max(6 * 60, h * 60 + m - hours * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Ersetzt die geplanten Erinnerungen einer Aufgabe.
 * offsets: z. B. ['7d', '1d']; custom: optionaler eigener Zeitpunkt (ISO, UTC).
 * Gibt die Anzahl geplanter Erinnerungen und übersprungener (vergangener) Zeitpunkte zurück.
 */
export function scheduleReminders(db, task, user, { offsets, custom } = {}) {
  const settings = userSettings(user);
  const chosen = (offsets ?? settings.reminderOffsets).filter((id) => REMINDER_OFFSETS.some((o) => o.id === id));
  const reminderTime = isValidTime(settings.reminderTime) ? settings.reminderTime : '08:00';
  const now = Date.now();
  let planned = 0;
  let skipped = 0;
  db.tx(() => {
    db.run("UPDATE reminders SET status = 'abgebrochen' WHERE task_id = ? AND status = 'geplant'", task.id);
    if (task.status !== 'offen') return;
    const createdAt = new Date().toISOString();
    if (task.due_date) {
      for (const id of chosen) {
        const offset = REMINDER_OFFSETS.find((o) => o.id === id);
        const day = addDays(task.due_date, -offset.days);
        let time = reminderTime;
        if (offset.days === 0 && task.due_time && task.due_time <= reminderTime) time = minus(task.due_time, 1);
        const at = zonedTimeToUtc(day, time, user.timezone);
        if (at.getTime() <= now) {
          skipped++;
          continue;
        }
        db.run(
          'INSERT INTO reminders (id, user_id, task_id, remind_at, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(), user.id, task.id, at.toISOString(), offset.label, 'geplant', createdAt
        );
        planned++;
      }
    }
    if (custom) {
      const at = new Date(custom);
      if (!Number.isNaN(at.getTime()) && at.getTime() > now) {
        db.run(
          'INSERT INTO reminders (id, user_id, task_id, remind_at, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(), user.id, task.id, at.toISOString(), 'Eigener Zeitpunkt', 'geplant', createdAt
        );
        planned++;
      } else skipped++;
    }
  });
  return { planned, skipped };
}

export function cancelReminders(db, taskId) {
  db.run("UPDATE reminders SET status = 'abgebrochen' WHERE task_id = ? AND status = 'geplant'", taskId);
}

function reminderText(task, settings) {
  if (!settings.notificationDetails) {
    return { title: 'BriefPilot: Erinnerung', body: 'Sie haben eine anstehende Aufgabe. Öffnen Sie BriefPilot für Details.' };
  }
  const when = task.due_date ? ` – fällig am ${formatDate(task.due_date, { weekday: true })}${task.due_time ? `, ${task.due_time} Uhr` : ''}` : '';
  return { title: `Erinnerung: ${taskKindLabel(task.kind)}`, body: `${task.title}${when}` };
}

/**
 * Stellt fällige Erinnerungen zu. In der App erscheinen sie immer; zusätzlich
 * per Push und E-Mail, wenn eingerichtet und vom Nutzer gewünscht.
 */
export async function deliverDueReminders({ db, push, mailer, config, log = console }) {
  const due = db.all(
    `SELECT r.id AS reminder_id, r.label, t.*, u.email, u.settings AS user_settings, u.timezone
       FROM reminders r
       JOIN tasks t ON t.id = r.task_id
       JOIN users u ON u.id = r.user_id
      WHERE r.status = 'geplant' AND r.remind_at <= ?
      ORDER BY r.remind_at LIMIT 200`,
    new Date().toISOString()
  );
  let delivered = 0;
  for (const row of due) {
    if (row.status !== 'offen') {
      db.run("UPDATE reminders SET status = 'abgebrochen' WHERE id = ?", row.reminder_id);
      continue;
    }
    // Zuerst als gesendet markieren, damit nichts doppelt zugestellt wird
    const claimed = db.run("UPDATE reminders SET status = 'gesendet', sent_at = ? WHERE id = ? AND status = 'geplant'", new Date().toISOString(), row.reminder_id);
    if (!claimed.changes) continue;
    const settings = userSettings({ settings: row.user_settings });
    const result = { app: 'angezeigt' };
    const text = reminderText(row, settings);

    if (push.enabled) {
      const subs = db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', row.user_id);
      if (!subs.length) result.push = 'kein_geraet';
      let ok = 0;
      for (const sub of subs) {
        const res = await push.send(sub, { ...text, url: row.letter_id ? `/#/briefe/${row.letter_id}` : '/#/aufgaben', tag: row.id });
        if (res.ok) {
          ok++;
          db.run('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?', new Date().toISOString(), sub.id);
        } else if (res.gone) {
          db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
        } else {
          db.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', sub.id);
        }
      }
      if (subs.length) result.push = ok ? `gesendet_${ok}` : 'fehler';
    } else {
      result.push = 'nicht_eingerichtet';
    }

    if (settings.emailReminders) {
      const mail = await mailer.send({
        to: row.email,
        subject: text.title,
        text: `${text.body}\n\nÖffnen: ${config.baseUrl}/#/aufgaben\n\nDiese Erinnerung haben Sie in BriefPilot eingerichtet. Sie können E-Mail-Erinnerungen in den Einstellungen ausschalten.`,
      });
      result.email = mail.delivered ? 'gesendet' : mail.reason;
    }
    db.run('UPDATE reminders SET delivery_json = ? WHERE id = ?', JSON.stringify(result), row.reminder_id);
    delivered++;
  }
  if (delivered) log.info(`[Erinnerungen] ${delivered} Erinnerung(en) ausgelöst`);
  return delivered;
}
