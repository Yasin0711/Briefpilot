// Hochladen, Briefe anlegen, anzeigen, suchen, bearbeiten, löschen; Übersicht.
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, readBody, readJson } from '../lib/http.js';
import { newId } from '../lib/security.js';
import { detectFileType } from '../lib/storage.js';
import { extractOfficeText, OFFICE_TYPES } from '../lib/office.js';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { inspectPdf } from '../pdf/extract.js';
import { sanitizePdf, hasActiveObjects } from '../pdf/sanitize.js';
import { buildScanPdf } from '../pdf/write.js';
import {
  serializeLetter, serializeLetterSummary, serializeTask, buildSearchText, compact,
} from '../domain/letters.js';
import { letterEvents, logLetterEvent } from '../domain/events.js';
import { serializeReply } from '../domain/replies.js';
import { serializeMessage } from './assistant.js';
import { assignLetter } from '../domain/assignment.js';
import { normalizeIdentifier, kindFromLabel, identifierKindLabel } from '../../public/js/shared/identifiers.js';
import { CATEGORY_IDS } from '../../public/js/shared/constants.js';
import { isValidIsoDate, parseGermanDates, todayIn, daysBetween } from '../../public/js/shared/dates.js';

const LIST_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'offen') AS open_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'zu_pruefen') AS review_tasks,
    (SELECT MIN(t.due_date) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'offen' AND t.due_date IS NOT NULL) AS next_due,
    (SELECT COALESCE(SUM(f.page_count), 0) FROM files f WHERE f.letter_id = l.id AND f.role = 'seite') AS page_count
  FROM letters l`;

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

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

  // ---------- Datei hochladen ----------
  // Gemeinsame Prüfung und Ablage – für den direkten Upload und den Upload in Stücken.
  async function storeUpload(user, inputData, { declared = '', role = 'seite' } = {}) {
    let data = inputData;
    if (data.length < 100) throw badRequest('Die Datei ist leer oder beschädigt.');
    const type = detectFileType(data);
    if (!type) throw new HttpError(415, 'Dieses Dateiformat wird nicht unterstützt. Erlaubt sind Fotos (JPG, PNG, WebP), PDF-Dateien sowie PowerPoint, Word und Excel (.pptx, .docx, .xlsx).');
    if (type.kind === 'unsupported') {
      if (type.reason === 'macros') throw new HttpError(415, `Diese ${type.label}-Datei enthält Makros und wird aus Sicherheitsgründen nicht angenommen. Bitte speichern Sie sie ohne Makros (z. B. als .${type.label === 'Word' ? 'docx' : type.label === 'Excel' ? 'xlsx' : 'pptx'}) oder als PDF.`);
      throw new HttpError(415, 'HEIC-Fotos (iPhone-Format) werden noch nicht unterstützt. Bitte fotografieren Sie direkt in BriefPilot oder stellen Sie die Kamera auf „Maximale Kompatibilität“.');
    }
    if (declared && declared !== 'application/octet-stream' && declared !== type.mime && !(type.kind === 'office' && /zip|officedocument|ms-powerpoint|msword|ms-excel/.test(declared))) {
      throw new HttpError(415, 'Der Dateityp passt nicht zum Inhalt der Datei.');
    }
    let pageCount = 1;
    let sanitized = null;
    if (type.kind === 'office') {
      try {
        pageCount = extractOfficeText(data).pageCount;
      } catch {
        throw badRequest('Die Office-Datei ist beschädigt oder lässt sich nicht lesen.');
      }
    }
    if (type.kind === 'pdf') {
      let info = inspectPdf(data);
      if (!info.valid) throw badRequest('Die PDF-Datei ist beschädigt oder unvollständig.');
      if (info.encrypted) throw badRequest('Passwortgeschützte PDF-Dateien können nicht verarbeitet werden. Bitte entfernen Sie den Schutz und laden Sie die Datei erneut hoch.');
      if (info.activeContent || hasActiveObjects(data)) {
        // PDF mit JavaScript, Startaktion o. Ä.: neu schreiben, ohne aktive Inhalte.
        // Gespeichert, angezeigt und an die KI gegeben wird nur die entschärfte Fassung.
        const pagesBefore = info.pageCount;
        let result;
        try {
          result = sanitizePdf(data);
        } catch {
          result = null;
        }
        const after = result ? inspectPdf(result.pdf) : null;
        if (!result || !after.valid || after.activeContent || after.pageCount !== pagesBefore || hasActiveObjects(result.pdf)) {
          throw badRequest('Diese PDF-Datei enthält ausführbare Inhalte (z. B. JavaScript), die sich nicht sicher entfernen ließen. Bitte drucken Sie die Datei als neue PDF („Als PDF drucken“) und laden Sie diese hoch.');
        }
        if (result.pdf.length > config.limits.maxFileBytes) throw new HttpError(413, 'Die PDF-Datei ist zu groß.');
        data = result.pdf;
        info = after;
        sanitized = { removed: result.removed };
      }
      if (info.pageCount > config.limits.maxPdfPages) throw badRequest(`Die PDF-Datei hat mehr als ${config.limits.maxPdfPages} Seiten. Bitte teilen Sie sie auf.`);
      pageCount = info.pageCount;
    }
    const used = db.get('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?', user.id).total;
    if (used + data.length > config.limits.maxStorageBytesPerUser) {
      throw new HttpError(413, 'Ihr Speicherplatz ist voll. Bitte löschen Sie ältere Briefe oder exportieren Sie Ihre Daten.');
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    // Exakt dieselbe Datei schon in einem Brief? (z. B. dasselbe PDF zweimal hochgeladen)
    const duplicate = role === 'seite' ? db.get(
      `SELECT l.id, l.subject, l.uploaded_at FROM files f JOIN letters l ON l.id = f.letter_id
        WHERE f.user_id = ? AND f.sha256 = ? AND f.role = 'seite' LIMIT 1`, user.id, sha256
    ) : null;
    const storageKey = await storage.put(user.id, data);
    const id = newId();
    db.run(
      `INSERT INTO files (id, user_id, kind, mime, size, page_count, sha256, storage_key, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.id, type.kind, type.mime, data.length, pageCount, sha256, storageKey, role, new Date().toISOString()
    );
    return {
      id, kind: type.kind, size: data.length, pageCount, role,
      sanitized: sanitized ? { removed: sanitized.removed, message: 'Die PDF enthielt aktive Inhalte (z. B. JavaScript). Sie wurden entfernt – Text und Seiten bleiben erhalten.' } : null,
      duplicateOf: duplicate ? { letterId: duplicate.id, subject: duplicate.subject, uploadedAt: duplicate.uploaded_at } : null,
    };
  }

  router.post('/api/files', async (req, res, { user }) => {
    limiter.hit(`upload:${user.id}`, 600, 3600_000, 'Sie haben sehr viele Dateien hochgeladen. Bitte warten Sie etwas.');
    const data = await readBody(req, Math.min(config.limits.maxFileBytes, 32 * 1024 * 1024));
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return storeUpload(user, data, { declared, role: req.headers['x-file-role'] === 'original' ? 'original' : 'seite' });
  });

  // ---------- Große Dateien in Stücken hochladen ----------
  // 1) POST /api/uploads {size, type, role} → id  2) PUT /api/uploads/:id/:index (je ≤ 4 MB)
  // 3) POST /api/uploads/:id/complete → wie /api/files. Teile liegen nur kurz im Datenordner.
  const uploads = new Map();
  const uploadDir = path.join(config.dataDir, 'uploads-tmp');
  const cleanupUpload = async (id) => {
    uploads.delete(id);
    await fsp.rm(path.join(uploadDir, id), { recursive: true, force: true });
  };
  const sweeper = setInterval(() => {
    for (const [id, u] of uploads) if (Date.now() - u.touched > 3600_000) cleanupUpload(id).catch(() => {});
  }, 600_000);
  sweeper.unref?.();

  router.post('/api/uploads', async (req, res, { user }) => {
    limiter.hit(`upload:${user.id}`, 600, 3600_000, 'Sie haben sehr viele Dateien hochgeladen. Bitte warten Sie etwas.');
    const body = await readJson(req);
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 100) throw badRequest('Die Datei ist leer oder beschädigt.');
    if (size > config.limits.maxFileBytes) throw new HttpError(413, `Die Datei ist zu groß (maximal ${Math.round(config.limits.maxFileBytes / 1024 / 1024)} MB).`);
    if ([...uploads.values()].filter((u) => u.userId === user.id).length >= 6) throw new HttpError(429, 'Zu viele gleichzeitige Uploads. Bitte warten Sie, bis die laufenden fertig sind.');
    const id = newId();
    const chunkSize = config.limits.uploadChunkBytes;
    await fsp.mkdir(path.join(uploadDir, id), { recursive: true, mode: 0o700 });
    uploads.set(id, {
      userId: user.id, size, chunkSize, chunks: Math.ceil(size / chunkSize), received: new Set(), touched: Date.now(),
      declared: String(body.type || '').slice(0, 200).toLowerCase(), role: body.role === 'original' ? 'original' : 'seite',
    });
    return { id, chunkSize, chunks: Math.ceil(size / chunkSize) };
  });

  router.put('/api/uploads/:id/:index', async (req, res, { user, params }) => {
    const u = uploads.get(params.id);
    if (!u || u.userId !== user.id) throw notFound('Dieser Upload ist abgelaufen. Bitte erneut versuchen.');
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= u.chunks) throw badRequest('Ungültiger Teil.');
    const data = await readBody(req, u.chunkSize);
    const expected = index === u.chunks - 1 ? u.size - index * u.chunkSize : u.chunkSize;
    if (data.length !== expected) throw badRequest('Dieser Teil ist unvollständig angekommen. Bitte erneut senden.');
    await fsp.writeFile(path.join(uploadDir, params.id, String(index)), data, { mode: 0o600 });
    u.received.add(index);
    u.touched = Date.now();
    return { ok: true, received: u.received.size, chunks: u.chunks };
  });

  router.post('/api/uploads/:id/complete', async (req, res, { user, params }) => {
    const u = uploads.get(params.id);
    if (!u || u.userId !== user.id) throw notFound('Dieser Upload ist abgelaufen. Bitte erneut versuchen.');
    if (u.received.size !== u.chunks) throw badRequest(`Es fehlen noch ${u.chunks - u.received.size} Teile.`);
    try {
      const parts = [];
      for (let i = 0; i < u.chunks; i++) parts.push(await fsp.readFile(path.join(uploadDir, params.id, String(i))));
      const data = Buffer.concat(parts);
      parts.length = 0;
      if (data.length !== u.size) throw badRequest('Die Datei ist unvollständig angekommen. Bitte erneut versuchen.');
      return await storeUpload(user, data, { declared: u.declared, role: u.role });
    } finally {
      await cleanupUpload(params.id);
    }
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
    const office = file.kind === 'office' ? Object.values(OFFICE_TYPES).find((t) => t.mime === file.mime) : null;
    const ext = file.kind === 'pdf' ? 'pdf' : office ? office.ext : file.mime.split('/')[1].replace('jpeg', 'jpg');
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': data.length,
      // Office-Dateien nur zum Herunterladen, nie im Browser ausführen
      'Content-Disposition': `${office ? 'attachment' : 'inline'}; filename="${office ? 'dokument' : 'brief-seite'}-${(file.position ?? 0) + 1}.${ext}"`,
      'X-Content-Type-Options': 'nosniff',
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
    if (files.some((f) => f.role !== 'seite')) throw badRequest('Originalaufnahmen gehören in „originalIds“, nicht zu den Seiten.');
    const totalPages = files.reduce((n, f) => n + f.page_count, 0);
    if (totalPages > config.limits.maxPdfPages) throw badRequest(`Das Dokument hat zu viele Seiten (höchstens ${config.limits.maxPdfPages}).`);
    // Auf Wunsch aufbewahrte Originalaufnahmen (vor Zuschnitt und Bildverbesserung)
    const originalIds = Array.isArray(body.originalIds) ? body.originalIds.map(String).slice(0, config.limits.maxFilesPerLetter) : [];
    const originals = originalIds.map((id) => db.get("SELECT * FROM files WHERE id = ? AND user_id = ? AND letter_id IS NULL AND role = 'original'", id, user.id));
    if (originals.some((f) => !f)) throw badRequest('Mindestens eine Originalaufnahme wurde nicht gefunden. Bitte erneut hochladen.');
    const now = new Date().toISOString();
    const letterId = newId();
    db.tx(() => {
      db.run(
        `INSERT INTO letters (id, user_id, uploaded_at, analysis_status, is_demo_content, created_at, updated_at)
         VALUES (?, ?, ?, 'wartet', 0, ?, ?)`,
        letterId, user.id, now, now, now
      );
      files.forEach((f, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', letterId, i, f.id));
      originals.forEach((f, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', letterId, 1000 + i, f.id));
    });
    logLetterEvent(db, user.id, letterId, 'hochgeladen', { seiten: totalPages, originale: originals.length || undefined });
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
        // Name der Akte oder eine ihrer Nummern (z. B. Kennzeichen), auch wenn sie im Brief selbst nicht steht
        alternatives.push(`l.id IN (SELECT ll.letter_id FROM letter_links ll JOIN objects o ON o.id = ll.object_id
                                     WHERE o.user_id = ? AND lower(o.name) LIKE ? ESCAPE '\\')`);
        params.push(user.id, `%${escapeLike(word)}%`);
        const norm = normalizeIdentifier('sonstiges', word);
        if (norm.length >= 4 && /\d/.test(norm)) {
          alternatives.push(`l.id IN (SELECT ll.letter_id FROM letter_links ll JOIN identifiers i ON i.object_id = ll.object_id
                                       WHERE i.user_id = ? AND i.normalized LIKE ?)`);
          params.push(user.id, `%${escapeLike(norm)}%`);
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
    if (filter === 'zuordnung') where.push("l.assignment_status IN ('pruefen', 'vorschlag', 'neue_akte')");
    if (filter === 'ohne_akte') where.push('NOT EXISTS (SELECT 1 FROM letter_links ll WHERE ll.letter_id = l.id)');
    if (filter === 'doppelt') where.push("l.duplicate_status = 'verdacht'");
    const objectId = query.get('object');
    if (objectId) {
      where.push('l.id IN (SELECT letter_id FROM letter_links WHERE object_id = ? AND user_id = ?)');
      params.push(objectId, user.id);
    }
    const personId = query.get('person');
    if (personId) {
      where.push('l.person_id = ?');
      params.push(personId);
    }
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
    const links = linkedObjects(user.id);
    return { letters: rows.map((r) => ({ ...serializeLetterSummary(r), objects: links.get(r.id) || [] })), total };
  });

  /** Akten je Brief (für Listen) */
  function linkedObjects(userId) {
    const map = new Map();
    for (const l of db.all(
      `SELECT ll.letter_id, o.id, o.name, o.type, ll.origin FROM letter_links ll JOIN objects o ON o.id = ll.object_id
        WHERE ll.user_id = ? ORDER BY o.name`, userId
    )) {
      if (!map.has(l.letter_id)) map.set(l.letter_id, []);
      map.get(l.letter_id).push({ id: l.id, name: l.name, type: l.type, origin: l.origin });
    }
    return map;
  }

  router.get('/api/letters/:id', (req, res, { user, params }) => {
    ownLetter(user, params.id);
    const letter = db.get(`${LIST_SELECT} WHERE l.id = ?`, params.id);
    const files = db.all('SELECT id, kind, mime, size, page_count, position, role FROM files WHERE letter_id = ? ORDER BY position', params.id);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? AND user_id = ? ORDER BY position, created_at', params.id, user.id);
    const reminders = db.all(
      "SELECT id, task_id, remind_at, label, status FROM reminders WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE letter_id = ?) AND status IN ('geplant', 'gesendet') ORDER BY remind_at",
      user.id, params.id
    );
    const links = db.all(
      `SELECT ll.*, o.name, o.type, o.provider, c.title AS case_title FROM letter_links ll
         JOIN objects o ON o.id = ll.object_id LEFT JOIN cases c ON c.id = ll.case_id
        WHERE ll.letter_id = ? ORDER BY o.name`, params.id
    );
    const duplicate = letter.duplicate_of ? db.get('SELECT id, subject, sender, letter_date, uploaded_at FROM letters WHERE id = ? AND user_id = ?', letter.duplicate_of, user.id) : null;
    const assignment = parseJson(letter.assignment_json, null);
    if (assignment?.candidates) {
      const names = new Map(db.all('SELECT id, name, type FROM objects WHERE user_id = ?', user.id).map((o) => [o.id, o]));
      assignment.candidates = assignment.candidates.filter((c) => names.has(c.objectId)).map((c) => ({ ...c, name: names.get(c.objectId).name, type: names.get(c.objectId).type }));
    }
    return {
      letter: { ...serializeLetter(letter), assignment },
      files: files.map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, size: f.size, pageCount: f.page_count, position: f.position, role: f.role })),
      tasks: tasks.map((t) => ({
        ...serializeTask(t),
        reminders: reminders.filter((r) => r.task_id === t.id).map((r) => ({ id: r.id, remindAt: r.remind_at, label: r.label, status: r.status })),
      })),
      links: links.map((l) => ({
        objectId: l.object_id, name: l.name, type: l.type, provider: l.provider, caseId: l.case_id, caseTitle: l.case_title,
        origin: l.origin, score: l.score, evidence: parseJson(l.evidence_json, []),
      })),
      duplicate: duplicate ? { id: duplicate.id, subject: duplicate.subject, sender: duplicate.sender, letterDate: duplicate.letter_date, uploadedAt: duplicate.uploaded_at } : null,
      replies: db.all('SELECT * FROM replies WHERE letter_id = ? ORDER BY created_at DESC', params.id).map(serializeReply),
      messages: db.all('SELECT * FROM letter_messages WHERE letter_id = ? ORDER BY created_at', params.id).map(serializeMessage),
      events: letterEvents(db, params.id),
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
      // Die korrigierte Liste gilt: Anzeige und Zuordnung verwenden nur noch diese Nummern
      updates.identifiers_json = JSON.stringify(refs.map((r) => {
        const kind = kindFromLabel(r.label);
        return { kind, label: r.label || identifierKindLabel(kind), value: r.value, normalized: normalizeIdentifier(kind, r.value), quote: null, page: null, status: null, source: 'nutzer' };
      }).filter((i) => i.normalized.length >= 3));
      edited.add('references');
    }
    if (body.senderAddress !== undefined) { updates.sender_address = text(body.senderAddress, 300); edited.add('sender_address'); }
    if (body.senderEmail !== undefined) {
      const email = text(body.senderEmail, 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.', { field: 'senderEmail' });
      updates.sender_email = email;
      edited.add('sender_email');
    }
    if (body.personId !== undefined) {
      if (body.personId && !db.get('SELECT id FROM persons WHERE id = ? AND user_id = ?', body.personId, user.id)) throw badRequest('Diese Person wurde nicht gefunden.', { field: 'personId' });
      updates.person_id = body.personId || null;
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
    const changed = Object.keys(updates).filter((k) => !['user_edited', 'updated_at'].includes(k));
    logLetterEvent(db, user.id, letter.id, 'korrigiert', { felder: changed });
    // Geänderte Nummern oder Absender können die Zuordnung ändern (Entscheidungen des Nutzers bleiben)
    if (updates.refs_json !== undefined || updates.sender !== undefined) assignLetter(db, letter.id);
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
    logLetterEvent(db, user.id, letter.id, 'geprueft');
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

  // ---------- Scan als PDF ----------
  router.get('/api/letters/:id/pdf', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const files = db.all("SELECT * FROM files WHERE letter_id = ? AND role = 'seite' ORDER BY position", letter.id);
    if (!files.length) throw notFound('Dieser Brief hat keine Seiten.');
    let pdf;
    if (files.length === 1 && files[0].kind === 'pdf') {
      pdf = await storage.get(files[0].storage_key);
    } else {
      const jpegs = [];
      for (const f of files) if (f.mime === 'image/jpeg') jpegs.push(await storage.get(f.storage_key));
      if (!jpegs.length) throw badRequest('Für diesen Brief kann keine PDF-Datei erstellt werden (keine Fotos im JPEG-Format). Bitte die Originaldateien verwenden.');
      pdf = buildScanPdf(jpegs, { title: letter.subject || 'Brief' });
    }
    const name = `${letter.letter_date || letter.uploaded_at.slice(0, 10)}_${String(letter.sender || 'brief').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40)}.pdf`;
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  });

  // ---------- Zusammenführen und Trennen ----------
  function checkEditable(letter) {
    if (letter.is_demo_content) throw badRequest('Beispielbriefe haben eine vorbereitete Auswertung und können nicht zusammengeführt oder getrennt werden.');
    if (letter.analysis_status === 'wartet' || letter.analysis_status === 'laeuft') throw badRequest('Der Brief wird gerade ausgewertet. Bitte kurz warten.');
  }

  /** Hängt die Seiten eines anderen Briefes an (z. B. Seite 2, die als eigener Brief gescannt wurde). */
  router.post('/api/letters/:id/merge', async (req, res, { user, params }) => {
    const target = ownLetter(user, params.id);
    const body = await readJson(req);
    const source = ownLetter(user, String(body.sourceId || ''));
    if (source.id === target.id) throw badRequest('Bitte einen anderen Brief wählen.');
    checkEditable(target);
    checkEditable(source);
    const now = new Date().toISOString();
    db.tx(() => {
      const maxPos = db.get("SELECT COALESCE(MAX(position), -1) AS p FROM files WHERE letter_id = ? AND role = 'seite'", target.id).p;
      const pages = db.all("SELECT id FROM files WHERE letter_id = ? AND role = 'seite' ORDER BY position", source.id);
      pages.forEach((f, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', target.id, maxPos + 1 + i, f.id));
      const maxOrig = db.get("SELECT COALESCE(MAX(position), 999) AS p FROM files WHERE letter_id = ? AND role = 'original'", target.id).p;
      db.all("SELECT id FROM files WHERE letter_id = ? AND role = 'original' ORDER BY position", source.id)
        .forEach((f, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', target.id, maxOrig + 1 + i, f.id));
      // Bestätigte und erledigte Aufgaben, Antworten und Fragen wandern mit
      db.run("UPDATE tasks SET letter_id = ? WHERE letter_id = ? AND status != 'zu_pruefen'", target.id, source.id);
      db.run('UPDATE replies SET letter_id = ? WHERE letter_id = ?', target.id, source.id);
      db.run('UPDATE letter_messages SET letter_id = ? WHERE letter_id = ?', target.id, source.id);
      for (const link of db.all("SELECT * FROM letter_links WHERE letter_id = ? AND origin = 'nutzer'", source.id)) {
        if (!db.get('SELECT id FROM letter_links WHERE letter_id = ? AND object_id = ?', target.id, link.object_id)) {
          db.run('UPDATE letter_links SET letter_id = ? WHERE id = ?', target.id, link.id);
        }
      }
      db.run('UPDATE letters SET duplicate_of = NULL, duplicate_status = NULL WHERE duplicate_of = ?', source.id);
      db.run('DELETE FROM letters WHERE id = ?', source.id); // nur der Datensatz – die Seiten gehören jetzt zum Ziel
      db.run("UPDATE letters SET analysis_status = 'wartet', analysis_error = NULL, updated_at = ? WHERE id = ?", now, target.id);
    });
    logLetterEvent(db, user.id, target.id, 'zusammengefuehrt', { mit: source.subject || source.sender || 'Brief' });
    analyzer.enqueue(target.id);
    return { ok: true, id: target.id };
  });

  /** Verschiebt ausgewählte Seiten in einen neuen Brief. */
  router.post('/api/letters/:id/split', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    checkEditable(letter);
    const body = await readJson(req);
    const ids = Array.isArray(body.fileIds) ? [...new Set(body.fileIds.map(String))] : [];
    const pages = db.all("SELECT id, position FROM files WHERE letter_id = ? AND role = 'seite' ORDER BY position", letter.id);
    const moving = pages.filter((p) => ids.includes(p.id));
    if (!moving.length || moving.length !== ids.length) throw badRequest('Bitte die Seiten auswählen, die ein eigener Brief werden sollen.');
    if (moving.length === pages.length) throw badRequest('Mindestens eine Seite muss im bisherigen Brief bleiben.');
    const now = new Date().toISOString();
    const newLetterId = newId();
    db.tx(() => {
      db.run(
        `INSERT INTO letters (id, user_id, uploaded_at, analysis_status, is_demo_content, created_at, updated_at) VALUES (?, ?, ?, 'wartet', 0, ?, ?)`,
        newLetterId, user.id, letter.uploaded_at, now, now
      );
      moving.forEach((p, i) => db.run('UPDATE files SET letter_id = ?, position = ? WHERE id = ?', newLetterId, i, p.id));
      pages.filter((p) => !ids.includes(p.id)).forEach((p, i) => db.run('UPDATE files SET position = ? WHERE id = ?', i, p.id));
      db.run("UPDATE letters SET analysis_status = 'wartet', analysis_error = NULL, updated_at = ? WHERE id = ?", now, letter.id);
    });
    logLetterEvent(db, user.id, letter.id, 'getrennt', { seiten: moving.length });
    logLetterEvent(db, user.id, newLetterId, 'hochgeladen', { seiten: moving.length, ausBrief: letter.subject || 'Brief' });
    analyzer.enqueue(letter.id);
    analyzer.enqueue(newLetterId);
    return { ok: true, id: letter.id, newId: newLetterId };
  });

  // ---------- Duplikate ----------
  router.post('/api/letters/:id/duplicate', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const body = await readJson(req);
    if (body.decision !== 'kein_duplikat') throw badRequest('Unbekannte Entscheidung.');
    db.run("UPDATE letters SET duplicate_status = 'kein_duplikat', duplicate_of = NULL WHERE id = ?", letter.id);
    logLetterEvent(db, user.id, letter.id, 'duplikat_verworfen');
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
        inbox: count("SELECT COUNT(*) AS n FROM letters WHERE user_id = ? AND assignment_status IN ('pruefen', 'vorschlag', 'neue_akte')"),
        objects: count('SELECT COUNT(*) AS n FROM objects WHERE user_id = ?'),
        duplicates: count("SELECT COUNT(*) AS n FROM letters WHERE user_id = ? AND duplicate_status = 'verdacht'"),
      },
      upcoming: upcoming.map(serializeTask),
      openWithoutDate: openWithoutDate.map(serializeTask),
      recentLetters: (() => {
        const links = linkedObjects(user.id);
        return recent.map((r) => ({ ...serializeLetterSummary(r), objects: links.get(r.id) || [] }));
      })(),
      reminders: fired.map((r) => ({
        id: r.id, label: r.label, sentAt: r.sent_at, taskId: r.task_id, title: r.title, kind: r.kind,
        dueDate: r.due_date, dueTime: r.due_time, letterId: r.letter_id,
      })),
    };
  });
}
