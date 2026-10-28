// Hochladen, Briefe anlegen, anzeigen, suchen, bearbeiten, löschen; Übersicht.
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, readBody, readJson } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { detectFileType } from '../lib/storage.js';
import { inspectPdf } from '../pdf/extract.js';
import {
  serializeLetter, serializeLetterSummary, serializeTask, buildSearchText, compact,
} from '../domain/letters.js';
import { CATEGORY_IDS } from '../../public/js/shared/constants.js';
import { isValidIsoDate, parseGermanDates, todayIn, daysBetween } from '../../public/js/shared/dates.js';

const LIST_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'offen') AS open_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'zu_pruefen') AS review_tasks,
    (SELECT MIN(t.due_date) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'offen' AND t.due_date IS NOT NULL) AS next_due,
    (SELECT COALESCE(SUM(f.page_count), 0) FROM files f WHERE f.letter_id = l.id) AS page_count
  FROM letters l`;

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function registerLetterRoutes(router, ctx) {
  const { db, config, storage, analyzer, limiter } = ctx;

  function ownLetter(user, id) {
    const letter = db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', id, user.id);
    if (!letter) throw notFound('Dieser Brief wurde nicht gefunden.'); // auch bei fremden Briefen: 404 statt 403
    return letter;
  }

  // ---------- Datei (eine Seite) hochladen ----------
  router.post('/api/files', async (req, res, { user }) => {
    limiter.hit(`upload:${user.id}`, 300, 3600_000, 'Sie haben sehr viele Dateien hochgeladen. Bitte warten Sie etwas.');
    const data = await readBody(req, config.limits.maxFileBytes);
    if (data.length < 100) throw badRequest('Die Datei ist leer oder beschädigt.');
    const type = detectFileType(data);
    if (!type) throw new HttpError(415, 'Dieses Dateiformat wird nicht unterstützt. Erlaubt sind Fotos (JPG, PNG, WebP) und PDF-Dateien.');
    if (type.kind === 'unsupported') {
      throw new HttpError(415, 'HEIC-Fotos (iPhone-Format) werden noch nicht unterstützt. Bitte fotografieren Sie direkt in BriefPilot oder stellen Sie die Kamera auf „Maximale Kompatibilität“.');
    }
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== type.mime) {
      throw new HttpError(415, 'Der Dateityp passt nicht zum Inhalt der Datei.');
    }
    let pageCount = 1;
    if (type.kind === 'pdf') {
      const info = inspectPdf(data);
      if (!info.valid) throw badRequest('Die PDF-Datei ist beschädigt oder unvollständig.');
      if (info.encrypted) throw badRequest('Passwortgeschützte PDF-Dateien können nicht verarbeitet werden. Bitte entfernen Sie den Schutz und laden Sie die Datei erneut hoch.');
      if (info.activeContent) throw badRequest('Diese PDF-Datei enthält ausführbare Inhalte (z. B. JavaScript) und wird aus Sicherheitsgründen nicht angenommen.');
      if (info.pageCount > 50) throw badRequest('Die PDF-Datei hat mehr als 50 Seiten. Bitte laden Sie nur den Brief hoch.');
      pageCount = info.pageCount;
    }
    const used = db.get('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?', user.id).total;
    if (used + data.length > config.limits.maxStorageBytesPerUser) {
      throw new HttpError(413, 'Ihr Speicherplatz ist voll. Bitte löschen Sie ältere Briefe oder exportieren Sie Ihre Daten.');
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const duplicate = db.get(
      `SELECT l.id, l.subject, l.uploaded_at FROM files f JOIN letters l ON l.id = f.letter_id
        WHERE f.user_id = ? AND f.sha256 = ? LIMIT 1`, user.id, sha256
    );
    const storageKey = await storage.put(user.id, data);
    const id = newId();
    db.run(
      `INSERT INTO files (id, user_id, kind, mime, size, page_count, sha256, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.id, type.kind, type.mime, data.length, pageCount, sha256, storageKey, new Date().toISOString()
    );
    return {
      id, kind: type.kind, size: data.length, pageCount,
      duplicateOf: duplicate ? { letterId: duplicate.id, subject: duplicate.subject, uploadedAt: duplicate.uploaded_at } : null,
    };
  });

  router.delete('/api/files/:id', async (req, res, { user, params }) => {
    const file = db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND letter_id IS NULL', params.id, user.id);
    if (!file) throw notFound();
    db.run('DELETE FROM files WHERE id = ?', file.id);
    await storage.remove(file.storage_key);
    return { ok: true };
  });

  // Originaldatei anzeigen – nur für den Eigentümer, nie öffentlich, nie zwischengespeichert
  router.get('/api/files/:id', async (req, res, { user, params }) => {
    const file = db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!file) throw notFound('Diese Datei wurde nicht gefunden.');
    const data = await storage.get(file.storage_key);
    const ext = file.kind === 'pdf' ? 'pdf' : file.mime.split('/')[1].replace('jpeg', 'jpg');
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename="brief-seite-${(file.position ?? 0) + 1}.${ext}"`,
      'Cache-Control': 'private, no-store',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
    });
    res.end(data);
  });

  // ---------- Brief aus hochgeladenen Seiten anlegen ----------
  router.post('/api/letters', async (req, res, { user }) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.fileIds) ? body.fileIds.map(String) : [];
    if (!ids.length) throw badRequest('Bitte fügen Sie mindestens eine Seite hinzu.');
    if (ids.length > config.limits.maxFilesPerLetter) throw badRequest(`Ein Brief darf höchstens ${config.limits.maxFilesPerLetter} Dateien haben.`);
    if (new Set(ids).size !== ids.length) throw badRequest('Eine Seite wurde doppelt ausgewählt.');
    const files = ids.map((id) => db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND letter_id IS NULL', id, user.id));
    if (files.some((f) => !f)) throw badRequest('Mindestens eine Seite wurde nicht gefunden oder gehört bereits zu einem Brief. Bitte erneut hochladen.');
    const totalPages = files.reduce((n, f) => n + f.page_count, 0);
    if (totalPages > 50) throw badRequest('Der Brief hat zu viele Seiten (höchstens 50).');
    const now = new Date().toISOString();
    const letterId = newId();
    db.tx(() => {
      db.run(
        `INSERT INTO letters (id, user_id, uploaded_at, analysis_status, is_demo_content, created_at, updated_at)
         VALUES (?, ?, ?, 'wartet', 0, ?, ?)`,
        letterId, user.id, now, now, now
      );
      files.forEach((f, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', letterId, i, f.id));
    });
    analyzer.enqueue(letterId);
    return { id: letterId };
  });

  // ---------- Liste und Suche ----------
  router.get('/api/letters', (req, res, { user, query }) => {
    const where = ['l.user_id = ?'];
    const params = [user.id];
    const q = String(query.get('q') || '').trim().slice(0, 200);
    if (q) {
      for (const word of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
        const alternatives = ['l.search_text LIKE ? ESCAPE \'\\\''];
        params.push(`%${escapeLike(word)}%`);
        // Datumssuche: „12.10.2026“ findet auch das ISO-Datum
        const date = parseGermanDates(word)[0]?.date;
        if (date) {
          alternatives.push('l.letter_date = ?');
          params.push(date);
        }
        // Aktenzeichen ohne Leer- und Trennzeichen vergleichen
        if (/\d/.test(word) && compact(word).length >= 4 && compact(word) !== word) {
          alternatives.push('l.search_text LIKE ? ESCAPE \'\\\'');
          params.push(`%${escapeLike(compact(word))}%`);
        }
        where.push(`(${alternatives.join(' OR ')})`);
      }
    }
    const category = query.get('category');
    if (category && CATEGORY_IDS.includes(category)) {
      where.push('l.category = ?');
      params.push(category);
    }
    const filter = query.get('filter');
    if (filter === 'datum_pruefen') where.push("l.letter_date_status IN ('fehlt', 'unsicher') AND l.analysis_status IN ('fertig', 'nicht_moeglich', 'fehler')");
    if (filter === 'ungeprueft') where.push("l.reviewed_at IS NULL AND l.analysis_status = 'fertig'");
    const from = query.get('from');
    if (from && isValidIsoDate(from)) {
      where.push('l.letter_date >= ?');
      params.push(from);
    }
    const to = query.get('to');
    if (to && isValidIsoDate(to)) {
      where.push('l.letter_date <= ?');
      params.push(to);
    }
    const order = query.get('sort') === 'upload'
      ? 'l.uploaded_at DESC'
      : 'CASE WHEN l.letter_date IS NULL THEN 0 ELSE 1 END, l.letter_date DESC, l.uploaded_at DESC';
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '200', 10) || 200, 1), 500);
    const rows = db.all(`${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`, ...params);
    const total = db.get('SELECT COUNT(*) AS n FROM letters WHERE user_id = ?', user.id).n;
    return { letters: rows.map(serializeLetterSummary), total };
  });

  router.get('/api/letters/:id', (req, res, { user, params }) => {
    ownLetter(user, params.id);
    const letter = db.get(`${LIST_SELECT} WHERE l.id = ?`, params.id);
    const files = db.all('SELECT id, kind, mime, size, page_count, position FROM files WHERE letter_id = ? ORDER BY position', params.id);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? AND user_id = ? ORDER BY position, created_at', params.id, user.id);
    const reminders = db.all(
      "SELECT id, task_id, remind_at, label, status FROM reminders WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE letter_id = ?) AND status IN ('geplant', 'gesendet') ORDER BY remind_at",
      user.id, params.id
    );
    return {
      letter: serializeLetter(letter),
      files: files.map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, size: f.size, pageCount: f.page_count, position: f.position })),
      tasks: tasks.map((t) => ({
        ...serializeTask(t),
        reminders: reminders.filter((r) => r.task_id === t.id).map((r) => ({ id: r.id, remindAt: r.remind_at, label: r.label, status: r.status })),
      })),
    };
  });

  // ---------- Angaben korrigieren ----------
  router.patch('/api/letters/:id', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const body = await readJson(req);
    const edited = new Set(JSON.parse(letter.user_edited || '[]'));
    const updates = {};
    const text = (v, max) => (v === null ? null : String(v ?? '').trim().slice(0, max) || null);
    if (body.sender !== undefined) { updates.sender = text(body.sender, 200); edited.add('sender'); }
    if (body.subject !== undefined) { updates.subject = text(body.subject, 300); edited.add('subject'); }
    if (body.category !== undefined) {
      if (!CATEGORY_IDS.includes(body.category)) throw badRequest('Unbekannte Kategorie.');
      updates.category = body.category;
      edited.add('category');
    }
    const today = todayIn(user.timezone);
    if (body.letterDate !== undefined) {
      if (body.letterDate === null || body.letterDate === '') {
        updates.letter_date = null;
        updates.letter_date_status = 'fehlt';
      } else {
        if (!isValidIsoDate(body.letterDate)) throw badRequest('Bitte ein gültiges Briefdatum angeben.', { field: 'letterDate' });
        if (daysBetween(today, body.letterDate) > 7) throw badRequest('Das Briefdatum liegt in der Zukunft. Bitte prüfen.', { field: 'letterDate' });
        updates.letter_date = body.letterDate;
        updates.letter_date_status = 'bestaetigt';
      }
      edited.add('letter_date');
    }
    if (body.receivedDate !== undefined) {
      if (body.receivedDate === null || body.receivedDate === '') updates.received_date = null;
      else {
        if (!isValidIsoDate(body.receivedDate)) throw badRequest('Bitte ein gültiges Zugangsdatum angeben.', { field: 'receivedDate' });
        if (daysBetween(today, body.receivedDate) > 0) throw badRequest('Das Zugangsdatum kann nicht in der Zukunft liegen.', { field: 'receivedDate' });
        const ld = updates.letter_date !== undefined ? updates.letter_date : letter.letter_date;
        if (ld && daysBetween(ld, body.receivedDate) < 0) throw badRequest('Das Zugangsdatum liegt vor dem Briefdatum. Bitte prüfen.', { field: 'receivedDate' });
        updates.received_date = body.receivedDate;
      }
    }
    if (body.references !== undefined) {
      if (!Array.isArray(body.references) || body.references.length > 20) throw badRequest('Ungültige Aktenzeichen.');
      const refs = body.references
        .map((r) => ({ label: String(r?.label || '').trim().slice(0, 80), value: String(r?.value || '').trim().slice(0, 120), quote: null }))
        .filter((r) => r.value);
      updates.refs_json = JSON.stringify(refs);
      edited.add('references');
    }
    if (body.letterDateConfirmed === true && letter.letter_date && updates.letter_date === undefined) {
      updates.letter_date_status = 'bestaetigt';
    }
    if (!Object.keys(updates).length) return { letter: serializeLetter(letter) };
    updates.user_edited = JSON.stringify([...edited]);
    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    db.run(`UPDATE letters SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), letter.id);
    const fresh = db.get('SELECT * FROM letters WHERE id = ?', letter.id);
    db.run('UPDATE letters SET search_text = ? WHERE id = ?', buildSearchText(fresh), letter.id);
    return { letter: serializeLetter(db.get('SELECT * FROM letters WHERE id = ?', letter.id)) };
  });

  router.post('/api/letters/:id/review', (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const now = new Date().toISOString();
    db.run(
      `UPDATE letters SET reviewed_at = ?, letter_date_status = CASE WHEN letter_date IS NOT NULL THEN 'bestaetigt' ELSE letter_date_status END,
              updated_at = ? WHERE id = ?`,
      now, now, letter.id
    );
    return { ok: true };
  });

  router.post('/api/letters/:id/reanalyze', (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    if (letter.analysis_status === 'laeuft' || letter.analysis_status === 'wartet') throw badRequest('Der Brief wird bereits ausgewertet.');
    if (letter.is_demo_content) throw badRequest('Beispielbriefe haben eine vorbereitete Auswertung und können nicht neu ausgewertet werden.');
    limiter.hit(`reanalyze:${user.id}`, 30, 3600_000);
    db.run("UPDATE letters SET analysis_status = 'wartet', analysis_error = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), letter.id);
    analyzer.enqueue(letter.id);
    return { ok: true };
  });

  router.delete('/api/letters/:id', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const files = db.all('SELECT storage_key FROM files WHERE letter_id = ?', letter.id);
    db.run('DELETE FROM letters WHERE id = ?', letter.id); // Seiten, Aufgaben, Erinnerungen werden mitgelöscht
    for (const f of files) await storage.remove(f.storage_key);
    return { ok: true };
  });

  // ---------- Übersicht (Startseite) ----------
  router.get('/api/overview', (req, res, { user }) => {
    const today = todayIn(user.timezone);
    const taskSelect = `SELECT t.*, l.subject AS letter_subject, l.sender AS letter_sender FROM tasks t LEFT JOIN letters l ON l.id = t.letter_id`;
    const upcoming = db.all(`${taskSelect} WHERE t.user_id = ? AND t.status = 'offen' AND t.due_date IS NOT NULL ORDER BY t.due_date, t.due_time LIMIT 8`, user.id);
    const openWithoutDate = db.all(`${taskSelect} WHERE t.user_id = ? AND t.status = 'offen' AND t.due_date IS NULL ORDER BY t.created_at DESC LIMIT 5`, user.id);
    const recent = db.all(`${LIST_SELECT} WHERE l.user_id = ? ORDER BY l.uploaded_at DESC LIMIT 5`, user.id);
    const fired = db.all(
      `SELECT r.id, r.remind_at, r.label, r.sent_at, t.id AS task_id, t.title, t.kind, t.due_date, t.due_time, t.letter_id
         FROM reminders r JOIN tasks t ON t.id = r.task_id
        WHERE r.user_id = ? AND r.status = 'gesendet' AND r.seen_at IS NULL AND t.status = 'offen'
        ORDER BY r.sent_at DESC LIMIT 5`, user.id
    );
    const count = (sql, ...p) => db.get(sql, user.id, ...p).n;
    return {
      today,
      counts: {
        letters: count('SELECT COUNT(*) AS n FROM letters WHERE user_id = ?'),
        tasksToReview: count("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'zu_pruefen'"),
        lettersToReview: count("SELECT COUNT(*) AS n FROM letters WHERE user_id = ? AND reviewed_at IS NULL AND analysis_status IN ('fertig', 'nicht_moeglich')"),
        analyzing: count("SELECT COUNT(*) AS n FROM letters WHERE user_id = ? AND analysis_status IN ('wartet', 'laeuft')"),
        open: count("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'offen'"),
        overdue: count("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'offen' AND due_date < ?", today),
      },
      upcoming: upcoming.map(serializeTask),
      openWithoutDate: openWithoutDate.map(serializeTask),
      recentLetters: recent.map(serializeLetterSummary),
      reminders: fired.map((r) => ({
        id: r.id, label: r.label, sentAt: r.sent_at, taskId: r.task_id, title: r.title, kind: r.kind,
        dueDate: r.due_date, dueTime: r.due_time, letterId: r.letter_id,
      })),
    };
  });
}
