// Objektakten (Fahrzeug, Zähler, Vertrag …), ihre Kennungen und Vorgänge, Personen und
// Adressen des Haushalts, der Prüf-Eingang und die Zuordnung von Briefen zu Akten.
import { HttpError, badRequest, notFound, readJson } from '../lib/http.js';
import { newId } from '../lib/security.js';
import {
  IDENTIFIER_KIND_IDS, identifierKind, normalizeIdentifier, orgKey,
} from '../../public/js/shared/identifiers.js';
import {
  OBJECT_TYPE_IDS, objectType, CATEGORY_IDS, CASE_KIND_IDS, PERSON_RELATIONS, ADDRESS_KINDS,
} from '../../public/js/shared/constants.js';
import { isValidIsoDate } from '../../public/js/shared/dates.js';
import { serializeLetterSummary, serializeTask } from '../domain/letters.js';
import { assignLetter, setLetterLinks, reassignOpenLetters } from '../domain/assignment.js';
import { logLetterEvent } from '../domain/events.js';

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const text = (v, max) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);
const optionalDate = (v, field) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isValidIsoDate(v)) throw badRequest('Bitte ein gültiges Datum angeben.', { field });
  return v;
};

function serializeObject(row) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: objectType(row.type).label,
    name: row.name,
    provider: row.provider,
    category: row.category,
    personId: row.person_id,
    personName: row.person_name ?? undefined,
    addressId: row.address_id,
    addressLabel: row.address_label ?? undefined,
    status: row.status,
    endedAt: row.ended_at,
    successorId: row.successor_id,
    notes: row.notes,
    letterCount: row.letter_count ?? undefined,
    openTasks: row.open_tasks ?? undefined,
    lastLetterDate: row.last_letter_date ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeIdentifier(row) {
  return {
    id: row.id,
    objectId: row.object_id,
    caseId: row.case_id,
    kind: row.kind,
    kindLabel: identifierKind(row.kind).label,
    value: row.value,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    source: row.source,
    sourceLetterId: row.source_letter_id,
  };
}

const OBJECT_SELECT = `
  SELECT o.*, p.name AS person_name, a.label AS address_label,
    (SELECT COUNT(*) FROM letter_links ll WHERE ll.object_id = o.id) AS letter_count,
    (SELECT MAX(l.letter_date) FROM letter_links ll JOIN letters l ON l.id = ll.letter_id WHERE ll.object_id = o.id) AS last_letter_date,
    (SELECT COUNT(*) FROM tasks t WHERE t.status IN ('offen', 'zu_pruefen')
       AND t.letter_id IN (SELECT ll.letter_id FROM letter_links ll WHERE ll.object_id = o.id)) AS open_tasks
  FROM objects o
  LEFT JOIN persons p ON p.id = o.person_id
  LEFT JOIN addresses a ON a.id = o.address_id`;

export function registerObjectRoutes(router, ctx) {
  const { db, limiter } = ctx;

  const ownObject = (user, id) => {
    const o = db.get('SELECT * FROM objects WHERE id = ? AND user_id = ?', id, user.id);
    if (!o) throw notFound('Diese Akte wurde nicht gefunden.');
    return o;
  };
  const ownLetter = (user, id) => {
    const l = db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', id, user.id);
    if (!l) throw notFound('Dieser Brief wurde nicht gefunden.');
    return l;
  };
  const checkPerson = (user, id) => {
    if (!id) return null;
    if (!db.get('SELECT id FROM persons WHERE id = ? AND user_id = ?', id, user.id)) throw badRequest('Diese Person wurde nicht gefunden.', { field: 'personId' });
    return id;
  };
  const checkAddress = (user, id) => {
    if (!id) return null;
    if (!db.get('SELECT id FROM addresses WHERE id = ? AND user_id = ?', id, user.id)) throw badRequest('Diese Adresse wurde nicht gefunden.', { field: 'addressId' });
    return id;
  };

  /** Prüft eine Kennung aus einer Eingabe. */
  function cleanIdentifier(input, index = null) {
    const field = index === null ? 'value' : `identifiers.${index}.value`;
    const kind = IDENTIFIER_KIND_IDS.includes(input?.kind) ? input.kind : 'sonstiges';
    const value = text(input?.value, 120);
    if (!value) throw badRequest('Bitte eine Nummer bzw. ein Kennzeichen angeben.', { field });
    const normalized = normalizeIdentifier(kind, value);
    if (normalized.length < 3) throw badRequest('Die Nummer ist zu kurz, um Briefe sicher zuzuordnen (mindestens 3 Zeichen).', { field });
    const status = input?.status === 'alt' ? 'alt' : 'aktuell';
    return { kind, value, normalized, status, validFrom: optionalDate(input?.validFrom, 'validFrom') ?? null, validTo: optionalDate(input?.validTo, 'validTo') ?? null };
  }

  function insertIdentifier(user, object, item, { caseId = null, source = 'nutzer', letterId = null } = {}) {
    const exists = db.get(
      'SELECT id FROM identifiers WHERE object_id = ? AND normalized = ? AND kind = ? AND COALESCE(case_id, \'\') = COALESCE(?, \'\')',
      object.id, item.normalized, item.kind, caseId
    );
    if (exists) return exists.id;
    const id = newId();
    db.run(
      `INSERT INTO identifiers (id, user_id, object_id, case_id, kind, value, normalized, issuer_key, status, valid_from, valid_to, source, source_letter_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.id, object.id, caseId, item.kind, item.value, item.normalized,
      identifierKind(item.kind).scope === 'issuer' ? object.provider_key || null : null,
      item.status, item.validFrom, item.validTo, source, letterId, new Date().toISOString()
    );
    return id;
  }

  /** Hinweise auf gleiche Nummern in anderen Akten (kein Fehler – z. B. gemeinsame Kundennummer). */
  function sharedWarnings(user, objectId, items) {
    const warnings = [];
    for (const item of items) {
      const other = db.get(
        'SELECT o.name FROM identifiers i JOIN objects o ON o.id = i.object_id WHERE i.user_id = ? AND i.normalized = ? AND i.object_id != ? LIMIT 1',
        user.id, item.normalized, objectId
      );
      if (other) warnings.push(`Die Nummer „${item.value}“ ist auch bei „${other.name}“ gespeichert. Sie hilft deshalb nicht, Briefe zwischen diesen Akten zu unterscheiden.`);
    }
    return warnings;
  }

  // ---------- Akten ----------
  router.get('/api/objects', (req, res, { user, query }) => {
    const where = ['o.user_id = ?'];
    const params = [user.id];
    const type = query.get('type');
    if (type && OBJECT_TYPE_IDS.includes(type)) {
      where.push('o.type = ?');
      params.push(type);
    }
    const status = query.get('status');
    if (status === 'aktiv' || status === 'beendet') {
      where.push('o.status = ?');
      params.push(status);
    }
    const q = String(query.get('q') || '').trim().slice(0, 100);
    if (q) {
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const compact = `%${normalizeIdentifier('sonstiges', q)}%`;
      where.push(`(lower(o.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(o.provider, '')) LIKE ? ESCAPE '\\'
                   OR o.id IN (SELECT object_id FROM identifiers WHERE user_id = ? AND normalized LIKE ?))`);
      params.push(like, like, user.id, compact);
    }
    const rows = db.all(`${OBJECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.status, o.type, o.name COLLATE NOCASE`, ...params);
    const ids = db.all(
      "SELECT * FROM identifiers WHERE user_id = ? AND case_id IS NULL ORDER BY CASE status WHEN 'aktuell' THEN 0 ELSE 1 END, created_at",
      user.id
    );
    return {
      objects: rows.map((r) => ({
        ...serializeObject(r),
        identifiers: ids.filter((i) => i.object_id === r.id).slice(0, 6).map(serializeIdentifier),
      })),
      inbox: db.get("SELECT COUNT(*) AS n FROM letters WHERE user_id = ? AND assignment_status IN ('pruefen', 'vorschlag')", user.id).n,
    };
  });

  router.post('/api/objects', async (req, res, { user }) => {
    limiter.hit(`objects:${user.id}`, 200, 3600_000);
    const body = await readJson(req);
    if (!OBJECT_TYPE_IDS.includes(body.type)) throw badRequest('Bitte eine Art der Akte wählen.', { field: 'type' });
    const name = text(body.name, 120);
    if (!name) throw badRequest('Bitte einen Namen für die Akte angeben, z. B. „Fahrzeug 1 · SB-AB 123“.', { field: 'name' });
    const provider = text(body.provider, 160);
    const category = CATEGORY_IDS.includes(body.category) ? body.category : objectType(body.type).category;
    const personId = checkPerson(user, body.personId);
    const addressId = checkAddress(user, body.addressId);
    const items = (Array.isArray(body.identifiers) ? body.identifiers.slice(0, 20) : []).map((i, idx) => cleanIdentifier(i, idx));
    const letter = body.letterId ? ownLetter(user, String(body.letterId)) : null;
    const now = new Date().toISOString();
    const id = newId();
    db.tx(() => {
      db.run(
        `INSERT INTO objects (id, user_id, type, name, provider, provider_key, category, person_id, address_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, user.id, body.type, name, provider, provider ? orgKey(provider) : null, category, personId, addressId, text(body.notes, 1000), now, now
      );
      const object = db.get('SELECT * FROM objects WHERE id = ?', id);
      for (const item of items) insertIdentifier(user, object, item, { source: letter ? 'brief' : 'nutzer', letterId: letter?.id || null });
    });
    const warnings = sharedWarnings(user, id, items);
    if (letter) setLetterLinks(db, user, letter.id, { objectIds: [id] });
    const reassigned = reassignOpenLetters(db, user.id);
    const row = db.get(`${OBJECT_SELECT} WHERE o.id = ?`, id);
    return { object: serializeObject(row), reassigned, warnings };
  });

  router.get('/api/objects/:id', (req, res, { user, params }) => {
    const object = ownObject(user, params.id);
    const row = db.get(`${OBJECT_SELECT} WHERE o.id = ?`, object.id);
    const identifiers = db.all('SELECT * FROM identifiers WHERE object_id = ? ORDER BY case_id IS NOT NULL, status, created_at', object.id);
    const cases = db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM letter_links ll WHERE ll.case_id = c.id) AS letter_count
         FROM cases c WHERE c.object_id = ? ORDER BY c.status, c.created_at DESC`,
      object.id
    );
    const letters = db.all(
      `SELECT l.*, ll.origin AS link_origin, ll.case_id AS link_case_id, ll.evidence_json AS link_evidence, ll.score AS link_score,
         (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'offen') AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'zu_pruefen') AS review_tasks
         FROM letter_links ll JOIN letters l ON l.id = ll.letter_id
        WHERE ll.object_id = ? ORDER BY COALESCE(l.letter_date, substr(l.uploaded_at, 1, 10)) DESC`,
      object.id
    );
    const tasks = db.all(
      `SELECT t.*, l.subject AS letter_subject, l.sender AS letter_sender FROM tasks t JOIN letters l ON l.id = t.letter_id
        WHERE t.status IN ('offen', 'zu_pruefen') AND t.letter_id IN (SELECT letter_id FROM letter_links WHERE object_id = ?)
        ORDER BY COALESCE(t.due_date, t.suggested_date) IS NULL, COALESCE(t.due_date, t.suggested_date)`,
      object.id
    );
    const successor = object.successor_id ? db.get('SELECT id, name, type FROM objects WHERE id = ?', object.successor_id) : null;
    const predecessors = db.all('SELECT id, name, type FROM objects WHERE successor_id = ? AND user_id = ?', object.id, user.id);
    return {
      object: serializeObject(row),
      identifiers: identifiers.map(serializeIdentifier),
      cases: cases.map((c) => ({ id: c.id, title: c.title, kind: c.kind, status: c.status, letterCount: c.letter_count, createdAt: c.created_at })),
      letters: letters.map((l) => ({
        ...serializeLetterSummary(l),
        link: { origin: l.link_origin, caseId: l.link_case_id, score: l.link_score, evidence: parseJson(l.link_evidence, []) },
      })),
      tasks: tasks.map(serializeTask),
      successor,
      predecessors,
    };
  });

  router.patch('/api/objects/:id', async (req, res, { user, params }) => {
    const object = ownObject(user, params.id);
    const body = await readJson(req);
    const updates = {};
    if (body.name !== undefined) {
      const name = text(body.name, 120);
      if (!name) throw badRequest('Der Name darf nicht leer sein.', { field: 'name' });
      updates.name = name;
    }
    if (body.type !== undefined) {
      if (!OBJECT_TYPE_IDS.includes(body.type)) throw badRequest('Unbekannte Art.', { field: 'type' });
      updates.type = body.type;
    }
    if (body.provider !== undefined) {
      updates.provider = text(body.provider, 160);
      updates.provider_key = updates.provider ? orgKey(updates.provider) : null;
    }
    if (body.category !== undefined) {
      if (!CATEGORY_IDS.includes(body.category)) throw badRequest('Unbekannte Kategorie.', { field: 'category' });
      updates.category = body.category;
    }
    if (body.personId !== undefined) updates.person_id = checkPerson(user, body.personId);
    if (body.addressId !== undefined) updates.address_id = checkAddress(user, body.addressId);
    if (body.notes !== undefined) updates.notes = text(body.notes, 1000);
    if (body.status !== undefined) {
      if (!['aktiv', 'beendet'].includes(body.status)) throw badRequest('Unbekannter Status.');
      updates.status = body.status;
      updates.ended_at = body.status === 'beendet' ? optionalDate(body.endedAt, 'endedAt') || new Date().toISOString().slice(0, 10) : null;
    }
    if (body.successorId !== undefined) {
      if (body.successorId) {
        if (body.successorId === object.id) throw badRequest('Eine Akte kann nicht ihr eigener Nachfolger sein.');
        ownObject(user, body.successorId);
      }
      updates.successor_id = body.successorId || null;
    }
    if (Object.keys(updates).length) {
      updates.updated_at = new Date().toISOString();
      const keys = Object.keys(updates);
      db.run(`UPDATE objects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), object.id);
      if (updates.provider_key !== undefined) {
        // Kontext der vom Nutzer eingetragenen Nummern folgt dem Vertragspartner
        db.run("UPDATE identifiers SET issuer_key = ? WHERE object_id = ? AND source = 'nutzer'", updates.provider_key, object.id);
      }
    }
    const reassigned = updates.provider_key !== undefined ? reassignOpenLetters(db, user.id) : null;
    return { object: serializeObject(db.get(`${OBJECT_SELECT} WHERE o.id = ?`, object.id)), reassigned };
  });

  router.delete('/api/objects/:id', (req, res, { user, params }) => {
    const object = ownObject(user, params.id);
    const affected = db.all('SELECT letter_id FROM letter_links WHERE object_id = ?', object.id).map((r) => r.letter_id);
    db.tx(() => {
      db.run('UPDATE objects SET successor_id = NULL WHERE successor_id = ?', object.id);
      db.run('DELETE FROM objects WHERE id = ?', object.id); // Kennungen, Vorgänge, Verknüpfungen – nicht die Briefe
      for (const letterId of affected) {
        const remaining = db.get('SELECT COUNT(*) AS n FROM letter_links WHERE letter_id = ?', letterId).n;
        if (!remaining) db.run("UPDATE letters SET assignment_status = 'offen' WHERE id = ?", letterId);
        logLetterEvent(db, user.id, letterId, 'zuordnung_entfernt', { akte: object.name, grund: 'Akte gelöscht' });
      }
    });
    const reassigned = reassignOpenLetters(db, user.id);
    return { ok: true, lettersKept: affected.length, reassigned };
  });

  router.post('/api/objects/:id/merge', async (req, res, { user, params }) => {
    const source = ownObject(user, params.id);
    const body = await readJson(req);
    const target = ownObject(user, String(body.targetId || ''));
    if (target.id === source.id) throw badRequest('Bitte eine andere Akte wählen.');
    db.tx(() => {
      for (const i of db.all('SELECT * FROM identifiers WHERE object_id = ?', source.id)) {
        const dup = db.get('SELECT id FROM identifiers WHERE object_id = ? AND normalized = ? AND COALESCE(case_id, \'\') = COALESCE(?, \'\')', target.id, i.normalized, i.case_id);
        if (dup) db.run('DELETE FROM identifiers WHERE id = ?', i.id);
        else db.run('UPDATE identifiers SET object_id = ? WHERE id = ?', target.id, i.id);
      }
      db.run('UPDATE cases SET object_id = ? WHERE object_id = ?', target.id, source.id);
      for (const link of db.all('SELECT * FROM letter_links WHERE object_id = ?', source.id)) {
        const dup = db.get('SELECT id FROM letter_links WHERE letter_id = ? AND object_id = ?', link.letter_id, target.id);
        if (dup) db.run('DELETE FROM letter_links WHERE id = ?', link.id);
        else db.run('UPDATE letter_links SET object_id = ? WHERE id = ?', target.id, link.id);
        logLetterEvent(db, user.id, link.letter_id, 'zugeordnet', { akten: [target.name], durch: 'nutzer', grund: `Akte „${source.name}“ zusammengeführt` });
      }
      db.run('UPDATE objects SET successor_id = ? WHERE successor_id = ?', target.id, source.id);
      if (!target.provider && source.provider) db.run('UPDATE objects SET provider = ?, provider_key = ? WHERE id = ?', source.provider, source.provider_key, target.id);
      db.run('DELETE FROM objects WHERE id = ?', source.id);
    });
    return { ok: true, object: serializeObject(db.get(`${OBJECT_SELECT} WHERE o.id = ?`, target.id)) };
  });

  // ---------- Kennungen ----------
  router.post('/api/objects/:id/identifiers', async (req, res, { user, params }) => {
    const object = ownObject(user, params.id);
    const body = await readJson(req);
    const item = cleanIdentifier(body);
    let caseId = null;
    if (body.caseId) {
      if (!db.get('SELECT id FROM cases WHERE id = ? AND object_id = ?', body.caseId, object.id)) throw badRequest('Dieser Vorgang wurde nicht gefunden.');
      caseId = body.caseId;
    }
    const id = insertIdentifier(user, object, item, { caseId });
    const warnings = sharedWarnings(user, object.id, [item]);
    const reassigned = reassignOpenLetters(db, user.id);
    return { identifier: serializeIdentifier(db.get('SELECT * FROM identifiers WHERE id = ?', id)), warnings, reassigned };
  });

  router.patch('/api/identifiers/:id', async (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM identifiers WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Diese Nummer wurde nicht gefunden.');
    const body = await readJson(req);
    const merged = cleanIdentifier({
      kind: body.kind ?? row.kind, value: body.value ?? row.value, status: body.status ?? row.status,
      validFrom: body.validFrom === undefined ? row.valid_from : body.validFrom,
      validTo: body.validTo === undefined ? row.valid_to : body.validTo,
    });
    db.run(
      'UPDATE identifiers SET kind = ?, value = ?, normalized = ?, status = ?, valid_from = ?, valid_to = ? WHERE id = ?',
      merged.kind, merged.value, merged.normalized, merged.status, merged.validFrom, merged.validTo, row.id
    );
    const reassigned = reassignOpenLetters(db, user.id);
    return { identifier: serializeIdentifier(db.get('SELECT * FROM identifiers WHERE id = ?', row.id)), reassigned };
  });

  router.delete('/api/identifiers/:id', (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM identifiers WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Diese Nummer wurde nicht gefunden.');
    db.run('DELETE FROM identifiers WHERE id = ?', row.id);
    const reassigned = reassignOpenLetters(db, user.id);
    return { ok: true, reassigned };
  });

  // ---------- Vorgänge ----------
  router.post('/api/objects/:id/cases', async (req, res, { user, params }) => {
    const object = ownObject(user, params.id);
    const body = await readJson(req);
    const title = text(body.title, 160);
    if (!title) throw badRequest('Bitte einen Titel für den Vorgang angeben.', { field: 'title' });
    const kind = CASE_KIND_IDS.includes(body.kind) ? body.kind : 'allgemein';
    const id = newId();
    const now = new Date().toISOString();
    db.run('INSERT INTO cases (id, user_id, object_id, title, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user.id, object.id, title, kind, 'offen', now, now);
    return { case: { id, title, kind, status: 'offen', letterCount: 0, createdAt: now } };
  });

  router.patch('/api/cases/:id', async (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM cases WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Dieser Vorgang wurde nicht gefunden.');
    const body = await readJson(req);
    const title = body.title !== undefined ? text(body.title, 160) : row.title;
    if (!title) throw badRequest('Der Titel darf nicht leer sein.', { field: 'title' });
    const status = body.status === undefined ? row.status : body.status;
    if (!['offen', 'abgeschlossen'].includes(status)) throw badRequest('Unbekannter Status.');
    const kind = body.kind === undefined ? row.kind : CASE_KIND_IDS.includes(body.kind) ? body.kind : row.kind;
    db.run('UPDATE cases SET title = ?, status = ?, kind = ?, updated_at = ? WHERE id = ?', title, status, kind, new Date().toISOString(), row.id);
    return { ok: true };
  });

  router.delete('/api/cases/:id', (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM cases WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Dieser Vorgang wurde nicht gefunden.');
    db.run('DELETE FROM cases WHERE id = ?', row.id); // Briefe bleiben in der Akte
    return { ok: true };
  });

  router.put('/api/letters/:id/case', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const body = await readJson(req);
    const link = db.get('SELECT * FROM letter_links WHERE letter_id = ? AND object_id = ?', letter.id, String(body.objectId || ''));
    if (!link) throw badRequest('Der Brief gehört nicht zu dieser Akte.');
    let caseId = body.caseId || null;
    if (caseId && !db.get('SELECT id FROM cases WHERE id = ? AND object_id = ?', caseId, link.object_id)) throw badRequest('Dieser Vorgang wurde nicht gefunden.');
    db.run('UPDATE letter_links SET case_id = ? WHERE id = ?', caseId, link.id);
    return { ok: true };
  });

  // ---------- Zuordnung eines Briefes ----------
  router.put('/api/letters/:id/links', async (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    const body = await readJson(req);
    const objectIds = Array.isArray(body.objectIds) ? [...new Set(body.objectIds.map(String))].slice(0, 10) : [];
    const learn = Array.isArray(body.learn) ? body.learn.slice(0, 20).map((l) => ({
      objectId: String(l?.objectId || ''), kind: l?.kind, value: l?.value, status: l?.status,
    })) : [];
    const cases = body.cases && typeof body.cases === 'object' ? body.cases : {};
    let result;
    try {
      result = setLetterLinks(db, user, letter.id, { objectIds, none: body.none === true, learn, cases });
    } catch (err) {
      if (err.status === 404) throw notFound(err.message);
      throw err;
    }
    const fresh = db.get('SELECT assignment_status FROM letters WHERE id = ?', letter.id);
    return { ok: true, assignmentStatus: fresh.assignment_status, ...result };
  });

  router.post('/api/letters/:id/links/auto', (req, res, { user, params }) => {
    const letter = ownLetter(user, params.id);
    db.run('DELETE FROM letter_links WHERE letter_id = ?', letter.id);
    db.run("UPDATE letters SET assignment_status = 'offen' WHERE id = ?", letter.id);
    const decision = assignLetter(db, letter.id, { force: true });
    return { ok: true, status: decision?.status, message: decision?.message || null };
  });

  // ---------- Eingang: Briefe, deren Zuordnung geprüft werden muss ----------
  router.get('/api/inbox', (req, res, { user }) => {
    const rows = db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM tasks t WHERE t.letter_id = l.id AND t.status = 'zu_pruefen') AS review_tasks
         FROM letters l WHERE l.user_id = ? AND l.assignment_status IN ('pruefen', 'vorschlag')
        ORDER BY l.uploaded_at DESC LIMIT 200`,
      user.id
    );
    const names = new Map(db.all('SELECT id, name, type FROM objects WHERE user_id = ?', user.id).map((o) => [o.id, o]));
    return {
      letters: rows.map((l) => {
        const info = parseJson(l.assignment_json, {});
        return {
          ...serializeLetterSummary(l),
          assignment: {
            ...info,
            candidates: (info.candidates || []).filter((c) => names.has(c.objectId)).map((c) => ({ ...c, name: names.get(c.objectId).name, type: names.get(c.objectId).type })),
          },
        };
      }),
    };
  });

  // ---------- Personen und Adressen ----------
  router.get('/api/household', (req, res, { user }) => ({
    persons: db.all('SELECT * FROM persons WHERE user_id = ? ORDER BY relation != \'ich\', created_at', user.id).map((p) => ({
      id: p.id, name: p.name, relation: p.relation, aliases: parseJson(p.aliases, []),
    })),
    addresses: db.all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_primary DESC, created_at', user.id).map((a) => ({
      id: a.id, label: a.label, kind: a.kind, street: a.street, zip: a.zip, city: a.city, validFrom: a.valid_from, validTo: a.valid_to, isPrimary: Boolean(a.is_primary),
    })),
  }));

  router.post('/api/persons', async (req, res, { user }) => {
    const body = await readJson(req);
    const name = text(body.name, 120);
    if (!name) throw badRequest('Bitte einen Namen angeben.', { field: 'name' });
    const relation = PERSON_RELATIONS.some((r) => r.id === body.relation) ? body.relation : 'sonstige';
    const aliases = Array.isArray(body.aliases) ? body.aliases.map((a) => text(a, 120)).filter(Boolean).slice(0, 5) : [];
    if (db.get('SELECT COUNT(*) AS n FROM persons WHERE user_id = ?', user.id).n >= 20) throw badRequest('Es sind höchstens 20 Personen möglich.');
    const id = newId();
    const now = new Date().toISOString();
    db.run('INSERT INTO persons (id, user_id, name, relation, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.id, name, relation, JSON.stringify(aliases), now, now);
    return { person: { id, name, relation, aliases } };
  });

  router.patch('/api/persons/:id', async (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM persons WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Diese Person wurde nicht gefunden.');
    const body = await readJson(req);
    const name = body.name !== undefined ? text(body.name, 120) : row.name;
    if (!name) throw badRequest('Bitte einen Namen angeben.', { field: 'name' });
    const relation = body.relation !== undefined && PERSON_RELATIONS.some((r) => r.id === body.relation) ? body.relation : row.relation;
    const aliases = Array.isArray(body.aliases) ? JSON.stringify(body.aliases.map((a) => text(a, 120)).filter(Boolean).slice(0, 5)) : row.aliases;
    db.run('UPDATE persons SET name = ?, relation = ?, aliases = ?, updated_at = ? WHERE id = ?', name, relation, aliases, new Date().toISOString(), row.id);
    return { ok: true };
  });

  router.delete('/api/persons/:id', (req, res, { user, params }) => {
    const r = db.run('DELETE FROM persons WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!r.changes) throw notFound('Diese Person wurde nicht gefunden.');
    return { ok: true };
  });

  function cleanAddress(body, row = {}) {
    const pick = (key, max) => (body[key] !== undefined ? text(body[key], max) : row[key] ?? null);
    const label = pick('label', 80) || (ADDRESS_KINDS.find((k) => k.id === (body.kind ?? row.kind))?.label) || 'Adresse';
    const kind = ADDRESS_KINDS.some((k) => k.id === body.kind) ? body.kind : row.kind || 'haushalt';
    const zip = pick('zip', 10);
    if (zip && !/^[0-9A-Z -]{3,10}$/i.test(zip)) throw badRequest('Bitte eine gültige Postleitzahl angeben.', { field: 'zip' });
    return {
      label, kind, street: pick('street', 120), zip, city: pick('city', 80),
      valid_from: body.validFrom !== undefined ? optionalDate(body.validFrom, 'validFrom') : row.valid_from ?? null,
      valid_to: body.validTo !== undefined ? optionalDate(body.validTo, 'validTo') : row.valid_to ?? null,
      is_primary: body.isPrimary !== undefined ? (body.isPrimary === true ? 1 : 0) : row.is_primary ?? 0,
    };
  }

  router.post('/api/addresses', async (req, res, { user }) => {
    const body = await readJson(req);
    const a = cleanAddress(body);
    if (!a.street && !a.city) throw badRequest('Bitte Straße oder Ort angeben.', { field: 'street' });
    if (db.get('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', user.id).n >= 30) throw badRequest('Es sind höchstens 30 Adressen möglich.');
    const id = newId();
    const now = new Date().toISOString();
    db.tx(() => {
      const first = !db.get('SELECT id FROM addresses WHERE user_id = ? LIMIT 1', user.id);
      if (a.is_primary || first) db.run('UPDATE addresses SET is_primary = 0 WHERE user_id = ?', user.id);
      db.run(
        `INSERT INTO addresses (id, user_id, label, kind, street, zip, city, valid_from, valid_to, is_primary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, user.id, a.label, a.kind, a.street, a.zip, a.city, a.valid_from, a.valid_to, a.is_primary || first ? 1 : 0, now, now
      );
    });
    return { address: { id, ...a } };
  });

  router.patch('/api/addresses/:id', async (req, res, { user, params }) => {
    const row = db.get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!row) throw notFound('Diese Adresse wurde nicht gefunden.');
    const body = await readJson(req);
    const a = cleanAddress(body, row);
    db.tx(() => {
      if (a.is_primary) db.run('UPDATE addresses SET is_primary = 0 WHERE user_id = ?', user.id);
      db.run(
        'UPDATE addresses SET label = ?, kind = ?, street = ?, zip = ?, city = ?, valid_from = ?, valid_to = ?, is_primary = ?, updated_at = ? WHERE id = ?',
        a.label, a.kind, a.street, a.zip, a.city, a.valid_from, a.valid_to, a.is_primary, new Date().toISOString(), row.id
      );
    });
    return { ok: true };
  });

  router.delete('/api/addresses/:id', (req, res, { user, params }) => {
    const r = db.run('DELETE FROM addresses WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!r.changes) throw notFound('Diese Adresse wurde nicht gefunden.');
    return { ok: true };
  });

  void HttpError;
}
