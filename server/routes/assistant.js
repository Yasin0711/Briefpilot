// Rückfragen an die KI zu einem Brief und Antwortbriefe (Entwurf → PDF / E-Mail / Kopie).
// Grundsatz: Nichts wird ohne ausdrückliche Freigabe des Nutzers verschickt.
import { HttpError, badRequest, notFound, readJson } from '../lib/http.js';
import { newId, isValidEmail, isGuest } from '../lib/security.js';
import { AiError } from '../analysis/ai.js';
import {
  ASK_SYSTEM_PROMPT, ASK_SCHEMA, REPLY_SYSTEM_PROMPT, REPLY_SCHEMA, REPLY_VARIANTS_SCHEMA, letterContext, referenceContext, userContext,
} from '../analysis/prompt.js';
import {
  REPLY_TEMPLATES, REPLY_TEMPLATE_IDS, templateReply, suggestReplyTemplates, suggestQuestions, replyDefaults, serializeReply, replyPlainText, replyReferences, fillUserPlaceholders,
} from '../domain/replies.js';
import { renderReplyPdf } from '../pdf/letter.js';
import { logLetterEvent } from '../domain/events.js';
import { setLetterLinks } from '../domain/assignment.js';
import { refreshSearchText } from '../domain/letters.js';
import crypto from 'node:crypto';
import { todayIn, isValidIsoDate } from '../../public/js/shared/dates.js';

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');

export function serializeMessage(m) {
  const meta = parseJson(m.meta_json, {});
  return { id: m.id, role: m.role, content: m.content, replySubject: meta.replySubject || null, replyBody: meta.replyBody || null, createdAt: m.created_at };
}

export function registerAssistantRoutes(router, ctx) {
  const { db, config, ai, analyzer, limiter, mailer, storage } = ctx;

  /** Gewählte weitere Briefe und Ordner als Bezug (nur eigene; der aktuelle Brief zählt nicht doppelt). */
  function referencesFor(user, body, currentId) {
    const letterIds = new Set((Array.isArray(body.refLetterIds) ? body.refLetterIds : []).slice(0, 20).map(String));
    for (const oid of (Array.isArray(body.refObjectIds) ? body.refObjectIds : []).slice(0, 10).map(String)) {
      db.all(
        `SELECT ll.letter_id FROM letter_links ll JOIN objects o ON o.id = ll.object_id JOIN letters l ON l.id = ll.letter_id
          WHERE o.id = ? AND o.user_id = ? ORDER BY COALESCE(l.letter_date, l.uploaded_at) DESC LIMIT 15`, oid, user.id
      ).forEach((row) => letterIds.add(row.letter_id));
    }
    letterIds.delete(currentId);
    const rows = [...letterIds].slice(0, 25)
      .map((id) => db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', id, user.id))
      .filter(Boolean)
      .sort((a, b) => String(b.letter_date || '').localeCompare(String(a.letter_date || '')));
    return referenceContext(rows);
  }

  const ownLetter = (user, id) => {
    const l = db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', id, user.id);
    if (!l) throw notFound('Dieser Brief wurde nicht gefunden.');
    return l;
  };
  const ownReply = (user, id) => {
    const r = db.get('SELECT * FROM replies WHERE id = ? AND user_id = ?', id, user.id);
    if (!r) throw notFound('Dieser Antwortbrief wurde nicht gefunden.');
    return r;
  };

  /** Prüft Einrichtung, Freigabe und Tageslimit, bevor ein Brief an die KI geht. */
  function requireAi(user) {
    if (!ai?.enabled) throw new HttpError(503, 'Auf diesem Server ist keine KI eingerichtet. Antwortbriefe gibt es als Vorlagen.');
    if (user.ai_consent !== 'ja') throw new HttpError(403, 'Bitte erlauben Sie zuerst die KI-Auswertung (Einstellungen → Datenschutz und KI).', { data: { code: 'consent' } });
    if (!analyzer.takeAiQuota(user)) throw new HttpError(429, 'Das Tageslimit für KI-Anfragen ist erreicht. Morgen geht es weiter.');
  }

  function aiFailure(err) {
    if (err instanceof AiError) {
      const status = err.code === 'kontingent' ? 429 : 502;
      return new HttpError(status, err.message);
    }
    return err;
  }

  // ---------- Rückfragen ----------
  router.post('/api/letters/:id/ask', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    limiter.hit(`ask:${user.id}`, 60, 3600_000, 'Sehr viele Fragen in kurzer Zeit. Bitte warten Sie etwas.');
    const body = await readJson(req);
    const question = str(body.question, 1000);
    if (question.length < 3) throw badRequest('Bitte stellen Sie eine Frage.', { field: 'question' });
    if (!letter.full_text || letter.full_text.trim().length < 20) {
      throw badRequest('Für diesen Brief liegt noch kein erkannter Text vor. Fragen sind möglich, sobald er gelesen wurde.');
    }
    requireAi(user);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letter.id);
    const history = db.all('SELECT role, content FROM letter_messages WHERE letter_id = ? ORDER BY created_at DESC LIMIT 6', letter.id).reverse();
    const me = replyDefaults(db, user, letter);
    const prompt = `${letterContext(letter, tasks)}${userContext(me.sender, me.place)}\n\n${history.length ? `Bisheriges Gespräch:\n${history.map((m) => `${m.role === 'frage' ? 'Nutzer' : 'Assistent'}: ${m.content}`).join('\n')}\n\n` : ''}Frage des Nutzers: ${question}`;
    let result;
    let model;
    try {
      ({ result, model } = await ai.completeJson({ system: ASK_SYSTEM_PROMPT, prompt, schema: ASK_SCHEMA, maxTokens: 4096 }));
    } catch (err) {
      throw aiFailure(err);
    }
    const answer = str(result?.answer, 4000) || 'Dazu konnte ich keine Antwort finden.';
    const replySubject = str(result?.reply_subject, 300) || null;
    const replyBody = fillUserPlaceholders(str(result?.reply_body, 6000), me.sender, me.place) || null;
    const now = Date.now();
    db.tx(() => {
      db.run('INSERT INTO letter_messages (id, user_id, letter_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), user.id, letter.id, 'frage', question, new Date(now).toISOString());
      db.run(
        'INSERT INTO letter_messages (id, user_id, letter_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), user.id, letter.id, 'antwort', answer, JSON.stringify({ replySubject, replyBody: replySubject || replyBody ? replyBody : null, model }), new Date(now + 1).toISOString()
      );
    });
    logLetterEvent(db, user.id, letter.id, 'frage', { zeichen: question.length });
    const messages = db.all('SELECT * FROM letter_messages WHERE letter_id = ? ORDER BY created_at', letter.id).map(serializeMessage);
    return { messages };
  });

  router.delete('/api/letters/:id/messages', (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    db.run('DELETE FROM letter_messages WHERE letter_id = ?', letter.id);
    return { ok: true };
  });

  // ---------- Antwortbriefe ----------
  router.get('/api/reply-templates', () => ({ templates: REPLY_TEMPLATES }));

  // Vorschläge passend zu diesem Brief (Vorlagen sortiert/markiert, Fragen an die KI)
  router.get('/api/letters/:id/reply-suggestions', (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letter.id);
    return { templates: suggestReplyTemplates(letter, tasks), questions: suggestQuestions(letter, tasks) };
  });

  router.post('/api/letters/:id/replies', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    limiter.hit(`reply:${user.id}`, 100, 3600_000);
    const body = await readJson(req);
    const mode = ['vorlage', 'ki', 'text'].includes(body.mode) ? body.mode : 'vorlage';
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letter.id);
    const defaults = replyDefaults(db, user, letter, { profileId: typeof body.profileId === 'string' ? body.profileId : null });
    let subject;
    let text;
    let origin = 'vorlage';
    let template = null;
    if (mode === 'ki') {
      const instruction = str(body.instruction, 1000)
        || REPLY_TEMPLATES.find((t) => t.id === body.template)?.label || 'Eine höfliche, kurze Antwort auf den Brief.';
      requireAi(user);
      try {
        const prompt = `${letterContext(letter, tasks)}${referencesFor(user, body, letter.id)}${userContext(defaults.sender, defaults.place)}\n\nWunsch des Nutzers für das Antwortschreiben: ${instruction}`;
        const { result } = await ai.completeJson({ system: REPLY_SYSTEM_PROMPT, prompt, schema: REPLY_SCHEMA, maxTokens: 4096 });
        subject = str(result?.subject, 300);
        text = str(result?.body, 8000);
      } catch (err) {
        throw aiFailure(err);
      }
      if (!text) throw new HttpError(502, 'Die KI hat keinen Antworttext geliefert. Bitte erneut versuchen oder eine Vorlage verwenden.');
      origin = 'ki';
    } else if (mode === 'text') {
      // Entwurf aus einer KI-Antwort im Gespräch übernehmen
      subject = str(body.subject, 300);
      text = str(body.body, 8000);
      if (!text) throw badRequest('Der Antworttext fehlt.');
      origin = 'ki';
    } else {
      template = REPLY_TEMPLATE_IDS.includes(body.template) ? body.template : 'leer';
      ({ subject, body: text } = templateReply(template, letter, tasks));
    }
    // Eigene Angaben gleich im ersten Entwurf einsetzen (auch bei Vorlagen)
    text = fillUserPlaceholders(text, defaults.sender, defaults.place);
    subject = fillUserPlaceholders(subject, defaults.sender, defaults.place);
    const now = new Date().toISOString();
    const id = newId();
    db.run(
      `INSERT INTO replies (id, user_id, letter_id, subject, body, recipient_json, sender_json, place, reply_date, origin, template, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entwurf', ?, ?)`,
      id, user.id, letter.id, subject || 'Ihr Schreiben', text, JSON.stringify(defaults.recipient), JSON.stringify(defaults.sender),
      defaults.place || null, todayIn(user.timezone), origin, template, now, now
    );
    logLetterEvent(db, user.id, letter.id, 'antwort_entwurf', { herkunft: origin, vorlage: template });
    return { reply: serializeReply(db.get('SELECT * FROM replies WHERE id = ?', id)) };
  });

  /** Entwurf nach Wunsch überarbeiten („Der Name ist falsch“, „Bitte freundlicher“ …). */
  router.post('/api/replies/:id/revise', async (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    if (reply.status === 'gesendet') throw badRequest('Diese Antwort wurde bereits versendet und kann nicht mehr geändert werden.');
    const letter = ownLetter(user, reply.letter_id);
    limiter.hit(`reply:${user.id}`, 100, 3600_000);
    const body = await readJson(req);
    const instruction = str(body.instruction, 1000);
    if (!instruction) throw badRequest('Bitte schreiben Sie, was geändert werden soll.', { field: 'instruction' });
    requireAi(user);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letter.id);
    // Angaben des Profils, mit dem dieser Entwurf angelegt wurde
    const me = { sender: parseJson(reply.sender_json, {}), place: reply.place || '' };
    let subject;
    let text;
    try {
      const prompt = `${letterContext(letter, tasks)}${referencesFor(user, body, letter.id)}${userContext(me.sender, me.place)}\n\nAktueller Entwurf:\nBetreff: ${reply.subject}\n${reply.body}\n\n`
        + `Änderungswunsch des Nutzers: ${instruction}\n\n`
        + 'Überarbeite den Entwurf entsprechend. Ändere nur, was gewünscht ist; alles andere bleibt möglichst gleich. '
        + 'Angaben des Nutzers (z. B. ein korrigierter Name) übernimmst du so, wie er sie schreibt.';
      const { result } = await ai.completeJson({ system: REPLY_SYSTEM_PROMPT, prompt, schema: REPLY_SCHEMA, maxTokens: 4096 });
      subject = str(result?.subject, 300);
      text = str(result?.body, 8000);
    } catch (err) {
      throw aiFailure(err);
    }
    if (!text) throw new HttpError(502, 'Die KI hat keinen geänderten Text geliefert. Bitte erneut versuchen.');
    text = fillUserPlaceholders(text, me.sender, me.place);
    db.run('UPDATE replies SET subject = ?, body = ?, updated_at = ? WHERE id = ?', subject || reply.subject, text, new Date().toISOString(), reply.id);
    logLetterEvent(db, user.id, letter.id, 'antwort_geaendert', { herkunft: 'ki' });
    return { reply: serializeReply(db.get('SELECT * FROM replies WHERE id = ?', reply.id)) };
  });

  /** Weitere, unterschiedlich formulierte Entwürfe zu einem vorhandenen Entwurf (KI, eine Anfrage). */
  router.post('/api/replies/:id/variants', async (req, res, { user, params }) => {
    const base = ownReply(user, params.id);
    const letter = ownLetter(user, base.letter_id);
    limiter.hit(`reply:${user.id}`, 100, 3600_000);
    requireAi(user);
    const body = await readJson(req);
    const count = Math.min(Math.max(parseInt(body.count, 10) || 3, 1), 3);
    const tasks = db.all('SELECT * FROM tasks WHERE letter_id = ? ORDER BY position', letter.id);
    const defaults = replyDefaults(db, user, letter);
    let drafts;
    try {
      const baseSender = base.sender_json ? parseJson(base.sender_json, defaults.sender) : defaults.sender;
      const prompt = `${letterContext(letter, tasks)}${referencesFor(user, body, letter.id)}${userContext(baseSender, base.place || defaults.place)}\n\nBisheriger Entwurf:\nBetreff: ${base.subject}\n${base.body}\n\n`
        + `Schreibe ${count} deutlich unterschiedliche Alternativen zu diesem Entwurf (z. B. kürzer, ausführlicher, bestimmter im Ton). `
        + 'Gleiche Fakten, gleiche Platzhalter-Regeln. Gib sie im Feld drafts zurück.';
      const { result } = await ai.completeJson({ system: REPLY_SYSTEM_PROMPT, prompt, schema: REPLY_VARIANTS_SCHEMA, maxTokens: 6000 });
      drafts = (Array.isArray(result?.drafts) ? result.drafts : [])
        .map((d) => ({ subject: str(d?.subject, 300), body: fillUserPlaceholders(str(d?.body, 8000), base.sender_json ? parseJson(base.sender_json, {}) : defaults.sender, base.place || defaults.place) }))
        .filter((d) => d.body)
        .slice(0, count);
    } catch (err) {
      throw aiFailure(err);
    }
    if (!drafts.length) throw new HttpError(502, 'Die KI hat keine weiteren Entwürfe geliefert. Bitte erneut versuchen.');
    const now = new Date().toISOString();
    const ids = drafts.map((d) => {
      const id = newId();
      db.run(
        `INSERT INTO replies (id, user_id, letter_id, subject, body, recipient_json, sender_json, place, reply_date, origin, template, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ki', NULL, 'entwurf', ?, ?)`,
        id, user.id, letter.id, d.subject || base.subject, d.body, base.recipient_json || JSON.stringify(defaults.recipient),
        base.sender_json || JSON.stringify(defaults.sender), base.place || defaults.place || null, todayIn(user.timezone), now, now
      );
      return id;
    });
    logLetterEvent(db, user.id, letter.id, 'antwort_entwurf', { herkunft: 'ki', varianten: ids.length });
    return { replies: ids.map((id) => serializeReply(db.get('SELECT * FROM replies WHERE id = ?', id))) };
  });

  router.patch('/api/replies/:id', async (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    if (reply.status === 'gesendet') throw badRequest('Dieser Brief wurde bereits versendet und kann nicht mehr geändert werden. Legen Sie bei Bedarf einen neuen Entwurf an.');
    const body = await readJson(req);
    const updates = {};
    if (body.subject !== undefined) updates.subject = str(body.subject, 300);
    if (body.body !== undefined) updates.body = str(body.body, 12000);
    const person = (v) => ({
      name: str(v?.name, 160), address: str(v?.address, 400), email: str(v?.email, 254), phone: str(v?.phone, 60),
    });
    if (body.recipient !== undefined) updates.recipient_json = JSON.stringify(person(body.recipient));
    if (body.sender !== undefined) updates.sender_json = JSON.stringify(person(body.sender));
    if (body.place !== undefined) updates.place = str(body.place, 80) || null;
    if (body.replyDate !== undefined) {
      if (body.replyDate && !isValidIsoDate(body.replyDate)) throw badRequest('Bitte ein gültiges Datum angeben.', { field: 'replyDate' });
      updates.reply_date = body.replyDate || null;
    }
    if (!Object.keys(updates).length) return { reply: serializeReply(reply) };
    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    db.run(`UPDATE replies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), reply.id);
    return { reply: serializeReply(db.get('SELECT * FROM replies WHERE id = ?', reply.id)) };
  });

  router.delete('/api/replies/:id', (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    if (reply.status === 'gesendet') throw badRequest('Versendete Antworten bleiben zur Nachverfolgung erhalten.');
    db.run('DELETE FROM replies WHERE id = ?', reply.id);
    return { ok: true };
  });

  function pdfFor(reply) {
    const letter = reply.letter_id ? db.get('SELECT * FROM letters WHERE id = ?', reply.letter_id) : null;
    return renderReplyPdf({
      subject: reply.subject,
      body: reply.body,
      recipient: parseJson(reply.recipient_json, {}),
      sender: parseJson(reply.sender_json, {}),
      place: reply.place,
      date: reply.reply_date || new Date().toISOString().slice(0, 10),
      references: letter ? replyReferences(letter) : [],
      theirDate: letter?.letter_date || null,
    });
  }

  router.get('/api/replies/:id/pdf', (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    const pdf = pdfFor(reply);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="antwort-${reply.reply_date || 'entwurf'}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  });

  /** Antwort als PDF-Dokument im Ordner des Briefes ablegen (erscheint dort wie ein Brief). */
  router.post('/api/replies/:id/save', async (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    const letter = reply.letter_id ? db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', reply.letter_id, user.id) : null;
    const existing = reply.saved_letter_id ? db.get('SELECT id FROM letters WHERE id = ? AND user_id = ?', reply.saved_letter_id, user.id) : null;
    const pdf = pdfFor(reply);
    const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    const key = await storage.put(user.id, pdf);
    const now = new Date().toISOString();
    const docId = existing?.id || newId();
    const fileId = newId();
    db.tx(() => {
      if (existing) {
        // Erneut gespeichert: alte Fassung ersetzen statt doppelt ablegen
        for (const f of db.all('SELECT id, storage_key FROM files WHERE letter_id = ?', docId)) {
          db.run('DELETE FROM files WHERE id = ?', f.id);
          storage.remove(f.storage_key).catch(() => {});
        }
      } else {
        db.run(
          `INSERT INTO letters (id, user_id, uploaded_at, analysis_status, analysis_source, is_demo_content, created_at, updated_at)
           VALUES (?, ?, ?, 'fertig', 'manuell', 0, ?, ?)`, docId, user.id, now, now, now
        );
      }
      db.run(
        `UPDATE letters SET subject = ?, sender = ?, document_type = 'Antwortschreiben', category = ?, letter_date = ?, letter_date_status = 'bestaetigt',
                full_text = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
        `Antwort: ${reply.subject}`.slice(0, 300), 'Eigene Antwort', letter?.category || 'sonstiges', reply.reply_date || now.slice(0, 10),
        reply.body, now, now, docId
      );
      db.run(
        `INSERT INTO files (id, user_id, letter_id, position, kind, mime, size, page_count, sha256, storage_key, role, created_at)
         VALUES (?, ?, ?, 0, 'pdf', 'application/pdf', ?, 1, ?, ?, 'seite', ?)`, fileId, user.id, docId, pdf.length, sha256, key, now
      );
      db.run('UPDATE replies SET saved_letter_id = ? WHERE id = ?', docId, reply.id);
    });
    refreshSearchText(db, docId);
    const folders = letter ? db.all('SELECT object_id FROM letter_links WHERE letter_id = ?', letter.id).map((r) => r.object_id) : [];
    if (folders.length) setLetterLinks(db, user, docId, { objectIds: folders });
    logLetterEvent(db, user.id, docId, 'hochgeladen', { seiten: 1, ausBrief: 'Antwort' });
    return { ok: true, letterId: docId, folders: folders.length };
  });

  /** E-Mail über den eingerichteten Mailserver – nur mit ausdrücklicher Freigabe (confirm: true). */
  router.post('/api/replies/:id/send', async (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    if (!config.smtp.enabled) {
      throw new HttpError(503, 'Auf diesem Server ist kein Mailserver eingerichtet. Öffnen Sie die Antwort stattdessen in Ihrem E-Mail-Programm oder drucken Sie sie als PDF.');
    }
    if (user.is_demo) throw badRequest('Im Demomodus werden keine E-Mails versendet.');
    if (reply.status === 'gesendet') throw badRequest('Diese Antwort wurde bereits versendet.');
    limiter.hit(`send:${user.id}`, 20, 86400_000, 'Heute wurden bereits viele E-Mails versendet. Bitte morgen erneut versuchen.');
    const body = await readJson(req);
    if (body.confirm !== true) throw badRequest('Bitte bestätigen Sie ausdrücklich, dass die E-Mail jetzt gesendet werden soll.', { field: 'confirm' });
    const to = str(body.to, 254).toLowerCase();
    if (!isValidEmail(to)) throw badRequest('Bitte eine gültige E-Mail-Adresse des Empfängers angeben.', { field: 'to' });
    if (/\[[^\]\n]{2,80}\]/.test(`${reply.subject}\n${reply.body}`)) {
      throw badRequest('Der Brief enthält noch Platzhalter in eckigen Klammern. Bitte ersetzen oder löschen Sie sie vor dem Versand.');
    }
    const sender = parseJson(reply.sender_json, {});
    const attachments = body.attachPdf === false ? [] : [{ filename: `Antwort-${reply.reply_date || 'brief'}.pdf`, contentType: 'application/pdf', data: pdfFor(reply) }];
    const result = await mailer.send({
      to, subject: reply.subject, text: replyPlainText(reply), attachments, fromName: sender.name || null,
      replyTo: !user.is_demo && !isGuest(user) && user.email ? user.email : null, autoGenerated: false,
    });
    if (!result.delivered) throw new HttpError(502, 'Die E-Mail konnte nicht gesendet werden. Bitte später erneut versuchen.');
    const now = new Date().toISOString();
    db.run("UPDATE replies SET status = 'gesendet', sent_via = 'email', sent_to = ?, sent_at = ?, updated_at = ? WHERE id = ?", to, now, now, reply.id);
    if (reply.letter_id) logLetterEvent(db, user.id, reply.letter_id, 'antwort_gesendet', { weg: 'E-Mail', an: to.replace(/^(.{2}).*@/, '$1***@') });
    return { reply: serializeReply(db.get('SELECT * FROM replies WHERE id = ?', reply.id)) };
  });

  /** Nutzer hat die Antwort selbst verschickt (Post, eigenes E-Mail-Programm, kopiert). */
  router.post('/api/replies/:id/mark-sent', async (req, res, { user, params }) => {
    const reply = ownReply(user, params.id);
    const body = await readJson(req);
    const via = ['post', 'eigenes_programm', 'kopiert'].includes(body.via) ? body.via : 'post';
    const now = new Date().toISOString();
    db.run("UPDATE replies SET status = 'gesendet', sent_via = ?, sent_at = ?, updated_at = ? WHERE id = ?", via, now, now, reply.id);
    if (reply.letter_id) logLetterEvent(db, user.id, reply.letter_id, 'antwort_gesendet', { weg: { post: 'Post', eigenes_programm: 'eigenes E-Mail-Programm', kopiert: 'Text kopiert' }[via] });
    return { reply: serializeReply(db.get('SELECT * FROM replies WHERE id = ?', reply.id)) };
  });
}
