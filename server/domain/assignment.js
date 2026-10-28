// Zuordnung von Briefen zu Objektakten (Fahrzeug, Zähler, Vertrag …) und Vorgängen.
//
// Sicherheitsregeln (siehe docs/ARCHITEKTUR.md):
//  1. Der Absender allein entscheidet nie – ausschlaggebend sind eindeutige Kennungen.
//  2. Nummern, die nur beim jeweiligen Absender eindeutig sind (Rechnungs-, Kundennummer …),
//     zählen nur, wenn der Absender zum Vertragspartner der Akte passt.
//  3. Automatisch zugeordnet wird nur bei genau EINEM klaren Treffer. Ähnliche Nummern,
//     mehrere Treffer oder nur gleicher Absender → neutraler Eingang „Zur Prüfung“.
//  4. Jede Zuordnung speichert, welche Angaben im Brief ausschlaggebend waren.
//  5. Entscheidungen des Nutzers werden nie automatisch überschrieben.
import { newId } from '../lib/security.js';
import {
  identifierKind, normalizeIdentifier, compareIdentifiers, extractIdentifiers, kindFromLabel, orgMatches, orgKey,
  IDENTIFIER_KIND_IDS, identifierKindLabel,
} from '../../public/js/shared/identifiers.js';
import { objectType } from '../../public/js/shared/constants.js';
import { logLetterEvent } from './events.js';

export const STRONG_SCORE = 80;
const COMPETITOR_SCORE = 30;
const MIN_SCORE = 10;
const FUZZY_WEIGHT = 35;
const PROVIDER_WEIGHT = 10;

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

// Familien von Kennungen, die miteinander verglichen werden dürfen
const FAMILY = {
  kennzeichen: 'kennzeichen', fin: 'fin', malo_id: 'malo', melo_id: 'melo', iban: 'iban', objektadresse: 'adresse',
};
function kindsCompatible(a, b) {
  if (a === 'sonstiges' || b === 'sonstiges') return a !== 'objektadresse' && b !== 'objektadresse';
  const fa = FAMILY[a] || 'nummer';
  const fb = FAMILY[b] || 'nummer';
  return fa === fb;
}

/** Alle im Brief erkannten Kennungen (KI, Aktenzeichen-Liste, Regel-Erkennung) ohne Doppelte. */
export function letterIdentifiers(letter) {
  const out = [];
  const add = (item, source) => {
    const kind = IDENTIFIER_KIND_IDS.includes(item.kind) && item.kind !== 'sonstiges' ? item.kind : kindFromLabel(item.label);
    const value = String(item.value || '').trim().slice(0, 120);
    if (!value) return;
    const normalized = normalizeIdentifier(kind, value);
    if (normalized.length < 3) return;
    const existing = out.find((o) => o.normalized === normalized && kindsCompatible(o.kind, kind));
    if (existing) {
      if (existing.kind === 'sonstiges' && kind !== 'sonstiges') existing.kind = kind;
      if (!existing.quote && item.quote) existing.quote = item.quote;
      if (!existing.page && item.page) existing.page = item.page;
      if (!existing.status && item.status) existing.status = item.status;
      return;
    }
    out.push({
      kind, label: String(item.label || identifierKindLabel(kind)).slice(0, 80), value, normalized,
      quote: item.quote ? String(item.quote).slice(0, 300) : null, page: Number.isInteger(item.page) ? item.page : null,
      status: ['alt', 'neu', 'aktuell'].includes(item.status) ? item.status : null, source,
    });
  };
  // Hat der Nutzer die Nummern korrigiert, gilt nur seine Liste (auch gegen Treffer im erkannten Text)
  if (parseJson(letter.user_edited, []).includes('references')) {
    for (const r of parseJson(letter.refs_json, [])) add({ kind: r.kind, label: r.label, value: r.value }, 'nutzer');
    return out.slice(0, 40);
  }
  for (const i of parseJson(letter.identifiers_json, [])) add(i, i.source || 'brief');
  for (const r of parseJson(letter.refs_json, [])) add({ kind: r.kind, label: r.label, value: r.value, quote: r.quote }, 'brief');
  if (letter.full_text) for (const i of extractIdentifiers(letter.full_text)) add(i, 'regeln');
  return out.slice(0, 40);
}

/** Lädt Akten und Kennungen eines Nutzers einmal (für viele Briefe hintereinander). */
export function loadAssignmentContext(db, userId) {
  const objects = db.all('SELECT id, name, type, provider, provider_key, status FROM objects WHERE user_id = ?', userId);
  const known = db.all(
    `SELECT i.id, i.object_id, i.case_id, i.kind, i.value, i.normalized, i.issuer_key, i.status, i.valid_from, i.valid_to,
            c.title AS case_title
       FROM identifiers i LEFT JOIN cases c ON c.id = i.case_id
      WHERE i.user_id = ?`,
    userId
  );
  return { userId, objects, objectById: new Map(objects.map((o) => [o.id, o])), known };
}

function issuerContext(sender, identifier, object) {
  const issuer = identifier.issuer_key || object.provider_key || orgKey(object.provider);
  return orgMatches(sender, issuer);
}

/**
 * Bewertet, zu welchen Akten ein Brief passen könnte.
 * @returns {{ identifiers: Array, candidates: Array<{objectId,name,type,score,exactScore,fuzzy,strongIds,caseId,evidence}> }}
 */
export function scoreLetter(db, letter, ctx = loadAssignmentContext(db, letter.user_id)) {
  const ids = letterIdentifiers(letter);
  if (!ctx.objects.length) return { identifiers: ids, candidates: [] };
  const sender = letter.sender || '';
  const cand = new Map();
  const get = (objectId) => {
    if (!cand.has(objectId)) {
      const o = ctx.objectById.get(objectId);
      cand.set(objectId, {
        objectId, name: o.name, type: o.type, status: o.status, score: 0, exactScore: 0, fuzzy: false,
        strongIds: [], caseId: null, caseTitle: null, evidence: [],
      });
    }
    return cand.get(objectId);
  };

  for (const li of ids) {
    const exact = [];
    const fuzzy = [];
    for (const k of ctx.known) {
      if (!kindsCompatible(li.kind, k.kind)) continue;
      const type = compareIdentifiers(
        { kind: li.kind, value: li.value, normalized: li.normalized },
        { kind: k.kind, value: k.value, normalized: k.normalized }
      );
      if (!type) continue;
      (type === 'aehnlich' ? fuzzy : exact).push({ k, type });
    }

    if (exact.length) {
      // 1. Kontext je Treffer bestimmen (passt der Absender zur Akte?)
      const scored = [];
      for (const { k, type } of exact) {
        const object = ctx.objectById.get(k.object_id);
        if (!object) continue;
        const info = identifierKind(k.kind === 'sonstiges' ? li.kind : k.kind);
        let factor = type === 'exakt' ? 1 : 0.9;
        let context = 'nicht_noetig';
        if (info.scope === 'issuer') {
          context = issuerContext(sender, k, object);
          if (context === 'nein') factor = 0;
          else if (context === 'unbekannt') factor *= 0.65;
        }
        const expired = k.status === 'alt' || (k.valid_to && letter.letter_date && k.valid_to < letter.letter_date);
        if (expired) factor *= 0.9;
        scored.push({ k, type, info, factor, context, expired });
      }
      // 2. Wie viele Akten teilen sich diese Nummer im passenden Kontext? (Unterscheidet sie überhaupt?)
      const shared = new Set(scored.filter((x) => x.factor > 0).map((x) => x.k.object_id)).size || 1;
      const byObject = new Map();
      for (const { k, type, info, factor, context, expired } of scored) {
        const weight = Math.round((info.weight * factor) / shared);
        const ev = {
          type: 'kennung', kind: k.kind === 'sonstiges' ? li.kind : k.kind, letterValue: li.value, value: k.value, identifierId: k.id,
          match: type, context, shared, weight, quote: li.quote, page: li.page, expired: Boolean(expired),
          caseId: k.case_id || null, caseTitle: k.case_title || null,
        };
        if (factor === 0) ev.note = 'Gleiche Nummer, aber anderer Absender – zählt nicht.';
        else if (shared > 1) ev.note = `Diese Nummer gehört zu ${shared} Akten und unterscheidet sie nicht.`;
        else if (context === 'unbekannt') ev.note = 'Absender nicht sicher erkannt – Nummer zählt nur eingeschränkt.';
        else if (expired) ev.note = 'Frühere Nummer dieser Akte.';
        const prev = byObject.get(k.object_id);
        if (!prev || prev.weight < ev.weight) byObject.set(k.object_id, ev);
      }
      for (const [objectId, ev] of byObject) {
        if (ev.weight === 0) continue; // anderer Absender: kein Kandidat
        const c = get(objectId);
        c.evidence.push(ev);
        c.score += ev.weight;
        c.exactScore += ev.weight;
        if (ev.weight >= STRONG_SCORE && ev.shared === 1) c.strongIds.push(li.normalized);
        if (ev.caseId && ev.weight > 0 && !c.caseId) {
          c.caseId = ev.caseId;
          c.caseTitle = ev.caseTitle;
        }
      }
    } else if (fuzzy.length) {
      const byObject = new Map();
      for (const { k } of fuzzy) {
        const object = ctx.objectById.get(k.object_id);
        if (!object || byObject.has(k.object_id)) continue;
        if (identifierKind(k.kind).scope === 'issuer' && issuerContext(sender, k, object) === 'nein') continue;
        byObject.set(k.object_id, {
          type: 'kennung', kind: k.kind, letterValue: li.value, value: k.value, identifierId: k.id, match: 'aehnlich',
          weight: FUZZY_WEIGHT, quote: li.quote, page: li.page, note: 'Nur ähnlich, nicht gleich – bitte genau vergleichen.',
        });
      }
      for (const [objectId, ev] of byObject) {
        const c = get(objectId);
        c.evidence.push(ev);
        c.score += ev.weight;
        c.fuzzy = true;
      }
    }
  }

  // Gleicher Absender wie der Vertragspartner: schwacher Hinweis, entscheidet nie allein
  if (sender) {
    for (const o of ctx.objects) {
      if (!o.provider || orgMatches(sender, o.provider) !== 'ja') continue;
      const c = get(o.id);
      c.evidence.push({ type: 'absender', value: o.provider, letterValue: sender, weight: PROVIDER_WEIGHT, quote: letter.sender });
      c.score += PROVIDER_WEIGHT;
      c.exactScore += PROVIDER_WEIGHT;
    }
  }

  const candidates = [...cand.values()]
    .filter((c) => c.score >= MIN_SCORE || c.fuzzy)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'));
  return { identifiers: ids, candidates };
}

const NUMBER_WORDS = ['null', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];

function pluralPhrase(candidates) {
  const types = new Set(candidates.map((c) => c.type));
  const t = types.size === 1 ? objectType([...types][0]) : objectType('sonstiges');
  const n = candidates.length;
  return { count: NUMBER_WORDS[n] || String(n), plural: t.plural, pick: t.pick };
}

/**
 * Entscheidet anhand der Bewertung, ob automatisch zugeordnet wird.
 * Nur Hinweise, die eine Akte von den anderen UNTERSCHEIDEN (eigene, nicht geteilte Nummern),
 * zählen für „eindeutig“ bzw. „Konkurrenz“. Gemeinsame Kundennummern und der Absender helfen
 * allen Akten gleich viel und entscheiden deshalb nie.
 * @returns {{ status: 'zugeordnet'|'pruefen'|'vorschlag'|'keine', reason, message, chosen: string[], preselected: string[], shown: string[] }}
 */
export function decideAssignment(candidates) {
  const list = candidates.filter((c) => c.score >= MIN_SCORE || c.fuzzy);
  const none = { status: 'keine', reason: 'keine_treffer', message: null, chosen: [], preselected: [], shown: [] };
  if (!list.length) return none;
  const distinct = (c) => c.evidence
    .filter((e) => e.type === 'kennung' && e.match !== 'aehnlich' && e.shared === 1)
    .reduce((n, e) => n + e.weight, 0);
  const strong = list.filter((c) => distinct(c) >= STRONG_SCORE && c.strongIds.length > 0);
  const nameList = (cs) => cs.map((c) => `„${c.name}“`).join(', ');
  const ids = (cs) => cs.map((c) => c.objectId);

  if (strong.length === 1) {
    const best = strong[0];
    const competitors = list.filter((c) => c !== best && (distinct(c) >= COMPETITOR_SCORE || c.fuzzy));
    if (!competitors.length) {
      return {
        status: 'zugeordnet', reason: 'eindeutig', message: `Automatisch zugeordnet zu ${nameList([best])}.`,
        chosen: [best.objectId], preselected: [best.objectId], shown: [best.objectId],
      };
    }
    const all = [best, ...competitors];
    const p = pluralPhrase(all);
    return {
      status: 'pruefen', reason: 'mehrdeutig',
      message: `Wir haben ${p.count} mögliche ${p.plural} gefunden. Bitte wählen Sie ${p.pick} aus.`,
      chosen: [], preselected: [best.objectId], shown: ids(all),
    };
  }
  if (strong.length > 1) {
    return {
      status: 'pruefen', reason: 'mehrere',
      message: `Dieser Brief nennt mehrere Ihrer Akten (${nameList(strong)}). Bitte bestätigen Sie, zu welchen er gehört.`,
      chosen: [], preselected: ids(strong), shown: ids(strong),
    };
  }
  const fuzzy = list.filter((c) => c.fuzzy);
  if (fuzzy.length) {
    const values = [...new Set(fuzzy.flatMap((c) => c.evidence.filter((e) => e.match === 'aehnlich').map((e) => e.letterValue)))];
    const p = pluralPhrase(fuzzy);
    const quoted = values.map((v) => `„${v}“`).join(', ');
    return {
      status: 'pruefen', reason: 'aehnlich',
      message: fuzzy.length > 1
        ? `Die Nummer ${quoted} stimmt mit keiner gespeicherten Nummer genau überein. Wir haben ${p.count} mögliche ${p.plural} gefunden. Bitte wählen Sie ${p.pick} aus.`
        : `Die Nummer ${quoted} ähnelt einer Nummer von ${nameList(fuzzy)}, stimmt aber nicht genau überein. Bitte prüfen Sie, ob der Brief dazugehört.`,
      chosen: [], preselected: [], shown: ids(fuzzy),
    };
  }
  const relevant = list.filter((c) => c.score >= MIN_SCORE);
  if (!relevant.length) return none;
  if (relevant.length === 1) {
    const only = relevant[0];
    const viaProvider = only.evidence.every((e) => e.type === 'absender');
    return {
      status: 'vorschlag', reason: viaProvider ? 'nur_absender' : 'schwach',
      message: viaProvider
        ? `Der Absender passt zu ${nameList([only])}, aber der Brief enthält keine Nummer dieser Akte. Gehört er dazu?`
        : `Der Brief passt möglicherweise zu ${nameList([only])}. Bitte bestätigen Sie die Zuordnung.`,
      chosen: [], preselected: [only.objectId], shown: [only.objectId],
    };
  }
  const p = pluralPhrase(relevant);
  return {
    status: 'pruefen', reason: 'mehrdeutig',
    message: `Wir haben ${p.count} mögliche ${p.plural} gefunden. Bitte wählen Sie ${p.pick} aus.`,
    chosen: [], preselected: [], shown: ids(relevant),
  };
}

function publicCandidate(c, preselected) {
  return {
    objectId: c.objectId, name: c.name, type: c.type, score: c.score, caseId: c.caseId, caseTitle: c.caseTitle,
    fuzzy: c.fuzzy, preselected: preselected.includes(c.objectId), evidence: c.evidence,
  };
}

function insertLink(db, { userId, letterId, objectId, caseId = null, origin, score = null, evidence = [] }) {
  db.run(
    `INSERT INTO letter_links (id, user_id, letter_id, object_id, case_id, origin, score, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(letter_id, object_id) DO UPDATE SET case_id = excluded.case_id, origin = excluded.origin,
       score = excluded.score, evidence_json = excluded.evidence_json`,
    newId(), userId, letterId, objectId, caseId, origin, score, JSON.stringify(evidence.slice(0, 20)), new Date().toISOString()
  );
}

const CASE_KIND_FOR = { rechnungsnummer: 'rechnung', schadennummer: 'schaden', bestellnummer: 'bestellung', aktenzeichen: 'bescheid', kassenzeichen: 'bescheid' };

/**
 * Ordnet einen Brief einem Vorgang seiner Akte zu: vorhandener Vorgang mit gleicher Nummer
 * oder – wenn der Brief eine Vorgangsnummer enthält (Rechnung, Schaden …) – ein neuer Vorgang.
 */
export function ensureCase(db, letter, objectId, letterIds, { create = true } = {}) {
  const caseIds = letterIds.filter((i) => identifierKind(i.kind).level === 'vorgang');
  if (!caseIds.length) return null;
  const existing = db.all(
    'SELECT i.case_id, i.kind, i.value, i.normalized FROM identifiers i WHERE i.object_id = ? AND i.case_id IS NOT NULL', objectId
  );
  for (const li of caseIds) {
    const hit = existing.find((k) => compareIdentifiers({ kind: li.kind, value: li.value, normalized: li.normalized }, k) === 'exakt');
    if (hit) return hit.case_id;
  }
  if (!create) return null;
  const now = new Date().toISOString();
  const caseId = newId();
  const main = caseIds[0];
  const object = db.get('SELECT provider_key, provider FROM objects WHERE id = ?', objectId);
  db.run(
    'INSERT INTO cases (id, user_id, object_id, title, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    caseId, letter.user_id, objectId, `${identifierKindLabel(main.kind)} ${main.value}`.slice(0, 160), CASE_KIND_FOR[main.kind] || 'allgemein', 'offen', now, now
  );
  for (const li of caseIds.slice(0, 5)) {
    db.run(
      `INSERT INTO identifiers (id, user_id, object_id, case_id, kind, value, normalized, issuer_key, status, source, source_letter_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aktuell', 'brief', ?, ?)`,
      newId(), letter.user_id, objectId, caseId, li.kind, li.value, li.normalized,
      orgKey(letter.sender) || object?.provider_key || null, letter.id, now
    );
  }
  return caseId;
}

/**
 * Führt die automatische Zuordnung für einen Brief aus. Entscheidungen des Nutzers
 * (Verknüpfungen „nutzer“ oder „ohne Akte“) bleiben unangetastet, außer force = true.
 */
export function assignLetter(db, letterId, { force = false, ctx = null, log = true } = {}) {
  const letter = db.get('SELECT * FROM letters WHERE id = ?', letterId);
  if (!letter) return null;
  if (!['fertig', 'nicht_moeglich'].includes(letter.analysis_status) && !force) return { status: letter.assignment_status, skipped: true };
  const userLinks = db.get("SELECT COUNT(*) AS n FROM letter_links WHERE letter_id = ? AND origin = 'nutzer'", letterId).n;
  if (!force && (userLinks > 0 || letter.assignment_status === 'ohne')) return { status: letter.assignment_status, skipped: true };

  const context = ctx || loadAssignmentContext(db, letter.user_id);
  const { identifiers, candidates } = scoreLetter(db, letter, context);
  const decision = decideAssignment(candidates);
  const now = new Date().toISOString();
  const previous = letter.assignment_status;
  const previousLinks = db.all("SELECT object_id FROM letter_links WHERE letter_id = ? AND origin = 'auto'", letterId).map((l) => l.object_id).sort();
  const info = {
    status: decision.status,
    reason: decision.reason,
    message: decision.message,
    candidates: candidates.filter((c) => decision.shown.includes(c.objectId)).slice(0, 12).map((c) => publicCandidate(c, decision.preselected)),
    identifiers,
    evaluatedAt: now,
  };
  db.tx(() => {
    db.run("DELETE FROM letter_links WHERE letter_id = ? AND origin = 'auto'", letterId);
    if (decision.status === 'zugeordnet') {
      for (const objectId of decision.chosen) {
        const c = candidates.find((x) => x.objectId === objectId);
        const caseId = c.caseId || ensureCase(db, letter, objectId, identifiers);
        insertLink(db, { userId: letter.user_id, letterId, objectId, caseId, origin: 'auto', score: c.score, evidence: c.evidence });
      }
    }
    db.run('UPDATE letters SET assignment_status = ?, assignment_json = ?, updated_at = ? WHERE id = ?', decision.status, JSON.stringify(info), now, letterId);
  });
  const nowLinks = [...decision.chosen].sort();
  if (log && (previous !== decision.status || previousLinks.join() !== nowLinks.join())) {
    if (decision.status === 'zugeordnet') {
      logLetterEvent(db, letter.user_id, letterId, 'zugeordnet', { akten: decision.chosen.map((id) => context.objectById.get(id)?.name), durch: 'automatisch' });
    } else if (decision.status === 'pruefen' || decision.status === 'vorschlag') {
      logLetterEvent(db, letter.user_id, letterId, 'zuordnung_pruefen', { grund: decision.message });
    }
  }
  return decision;
}

/** Nach Änderungen an Akten: alle noch nicht vom Nutzer entschiedenen Briefe neu bewerten. */
export function reassignOpenLetters(db, userId) {
  const ctx = loadAssignmentContext(db, userId);
  const rows = db.all(
    `SELECT l.id FROM letters l
      WHERE l.user_id = ? AND l.assignment_status IN ('offen', 'keine', 'pruefen', 'vorschlag', 'zugeordnet')
        AND l.analysis_status IN ('fertig', 'nicht_moeglich')
        AND NOT EXISTS (SELECT 1 FROM letter_links ll WHERE ll.letter_id = l.id AND ll.origin = 'nutzer')`,
    userId
  );
  const result = { checked: rows.length, zugeordnet: 0, pruefen: 0 };
  for (const r of rows) {
    const d = assignLetter(db, r.id, { ctx });
    if (d?.status === 'zugeordnet') result.zugeordnet++;
    if (d?.status === 'pruefen' || d?.status === 'vorschlag') result.pruefen++;
  }
  return result;
}

/**
 * Zuordnung durch den Nutzer: ersetzt alle Verknüpfungen des Briefes.
 * learn: [{ objectId, kind, value, status }] – Nummern aus dem Brief, die künftig zur Akte gehören
 * cases: { [objectId]: caseId | 'neu' | null }
 */
export function setLetterLinks(db, user, letterId, { objectIds = [], none = false, learn = [], cases = {} } = {}) {
  const letter = db.get('SELECT * FROM letters WHERE id = ? AND user_id = ?', letterId, user.id);
  if (!letter) return null;
  const objects = objectIds.map((id) => db.get('SELECT * FROM objects WHERE id = ? AND user_id = ?', id, user.id));
  if (objects.some((o) => !o)) throw Object.assign(new Error('Mindestens eine Akte wurde nicht gefunden.'), { status: 404 });
  const info = parseJson(letter.assignment_json, {});
  const identifiersInLetter = letterIdentifiers(letter);
  const now = new Date().toISOString();
  let learned = 0;
  db.tx(() => {
    db.run('DELETE FROM letter_links WHERE letter_id = ?', letterId);
    for (const o of objects) {
      const candidate = (info.candidates || []).find((c) => c.objectId === o.id);
      let caseId = cases[o.id] === undefined ? candidate?.caseId || null : cases[o.id];
      if (caseId === 'neu') caseId = ensureCase(db, letter, o.id, identifiersInLetter, { create: true });
      else if (caseId) {
        const ok = db.get('SELECT id FROM cases WHERE id = ? AND object_id = ?', caseId, o.id);
        if (!ok) caseId = null;
      } else caseId = ensureCase(db, letter, o.id, identifiersInLetter, { create: false });
      insertLink(db, {
        userId: user.id, letterId, objectId: o.id, caseId, origin: 'nutzer', score: candidate?.score ?? null,
        evidence: candidate?.evidence?.length ? candidate.evidence : [{ type: 'nutzer', note: 'Vom Nutzer zugeordnet.' }],
      });
      // Akte ohne Vertragspartner: Absender des Briefes übernehmen (Kontext für künftige Briefe)
      if (!o.provider && letter.sender) {
        db.run('UPDATE objects SET provider = ?, provider_key = ?, updated_at = ? WHERE id = ?', letter.sender, orgKey(letter.sender), now, o.id);
      }
    }
    for (const item of learn) {
      if (!objects.some((o) => o.id === item.objectId)) continue;
      const kind = IDENTIFIER_KIND_IDS.includes(item.kind) ? item.kind : 'sonstiges';
      const value = String(item.value || '').trim().slice(0, 120);
      const normalized = normalizeIdentifier(kind, value);
      if (normalized.length < 3) continue;
      const exists = db.get('SELECT id FROM identifiers WHERE object_id = ? AND normalized = ? AND case_id IS NULL', item.objectId, normalized);
      if (exists) continue;
      const object = objects.find((o) => o.id === item.objectId);
      db.run(
        `INSERT INTO identifiers (id, user_id, object_id, kind, value, normalized, issuer_key, status, valid_from, source, source_letter_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'brief', ?, ?)`,
        newId(), user.id, item.objectId, kind, value, normalized,
        identifierKind(kind).scope === 'issuer' ? orgKey(letter.sender) || object.provider_key || null : null,
        item.status === 'alt' ? 'alt' : 'aktuell', item.status === 'neu' ? letter.letter_date || null : null, letterId, now
      );
      learned++;
    }
    const status = objects.length ? 'zugeordnet' : none ? 'ohne' : 'offen';
    db.run(
      'UPDATE letters SET assignment_status = ?, assignment_json = ?, updated_at = ? WHERE id = ?',
      status, JSON.stringify({ ...info, status, decidedBy: 'nutzer', decidedAt: now }), now, letterId
    );
  });
  if (objects.length) logLetterEvent(db, user.id, letterId, 'zugeordnet', { akten: objects.map((o) => o.name), durch: 'nutzer' });
  else logLetterEvent(db, user.id, letterId, 'zuordnung_entfernt', { ohneAkte: none });
  if (learned) logLetterEvent(db, user.id, letterId, 'kennung_gelernt', { anzahl: learned });
  if (!objects.length && !none) assignLetter(db, letterId, { force: true });
  // Neue Nummern können weitere, noch offene Briefe eindeutig machen
  const others = learned ? reassignOpenLetters(db, user.id) : null;
  return { learned, reassigned: others };
}

/** Erkennt die betroffene Person (Empfänger) anhand gespeicherter Namen. */
export function detectPerson(db, letter) {
  const persons = db.all('SELECT id, name, aliases FROM persons WHERE user_id = ?', letter.user_id);
  if (!persons.length) return null;
  const haystack = `${letter.recipient || ''}\n${String(letter.full_text || '').slice(0, 3000)}`.toLowerCase();
  const hits = persons.filter((p) => {
    const names = [p.name, ...parseJson(p.aliases, [])].filter(Boolean);
    return names.some((n) => {
      const tokens = String(n).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      return tokens.length && haystack.split('\n').some((line) => tokens.every((t) => line.includes(t)));
    });
  });
  return hits.length === 1 ? hits[0].id : null;
}
