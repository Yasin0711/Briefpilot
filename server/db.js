// Datenbank (SQLite, direkt in Node.js eingebaut) und Datenmodell.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Jede Änderung am Datenmodell bekommt eine neue Nummer. Bereits angewendete
// Schritte werden über PRAGMA user_version erkannt und nicht erneut ausgeführt.
const MIGRATIONS = [
  `
  -- Nutzerkonten
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name            TEXT,
    password_hash   TEXT,                       -- scrypt; bei Demo-Konten NULL
    timezone        TEXT NOT NULL DEFAULT 'Europe/Berlin',
    settings        TEXT NOT NULL DEFAULT '{}', -- JSON: Erinnerungs- und Benachrichtigungseinstellungen
    ai_consent      TEXT,                       -- 'ja' | 'nein' | NULL (noch nicht gefragt)
    ai_consent_at   TEXT,
    privacy_accepted_at TEXT,
    is_demo         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  -- Angemeldete Geräte. Gespeichert wird nur ein Hash des Sitzungsschlüssels.
  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,             -- SHA-256 des Tokens
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device        TEXT,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE password_resets (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );

  -- Briefe. Briefdatum und Upload-Datum werden getrennt gespeichert.
  CREATE TABLE letters (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject             TEXT,
    sender              TEXT,
    document_type       TEXT,
    letter_date         TEXT,                   -- YYYY-MM-DD oder NULL
    letter_date_status  TEXT NOT NULL DEFAULT 'fehlt', -- erkannt | unsicher | fehlt | bestaetigt
    letter_date_quote   TEXT,
    received_date       TEXT,                   -- vom Nutzer bestätigtes Zugangsdatum
    uploaded_at         TEXT NOT NULL,
    category            TEXT NOT NULL DEFAULT 'sonstiges',
    refs_json           TEXT NOT NULL DEFAULT '[]', -- Aktenzeichen, Kundennummern …
    amounts_json        TEXT NOT NULL DEFAULT '[]',
    summary_json        TEXT,                   -- Erklärung: worum, prüfen, Hinweise
    full_text           TEXT,
    search_text         TEXT NOT NULL DEFAULT '',
    analysis_status     TEXT NOT NULL DEFAULT 'wartet', -- wartet | laeuft | fertig | fehler | nicht_moeglich
    analysis_source     TEXT,                   -- ki | regeln | beispiel | manuell
    analysis_model      TEXT,
    analysis_error      TEXT,
    analyzed_at         TEXT,
    injection_warning   INTEGER NOT NULL DEFAULT 0,
    user_edited         TEXT NOT NULL DEFAULT '[]', -- Felder, die der Nutzer selbst geändert hat
    reviewed_at         TEXT,
    is_demo_content     INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX idx_letters_user_date ON letters(user_id, letter_date);
  CREATE INDEX idx_letters_user_uploaded ON letters(user_id, uploaded_at);

  -- Hochgeladene Dateien (Seiten). Vor dem Zuordnen ist letter_id NULL.
  CREATE TABLE files (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id    TEXT REFERENCES letters(id) ON DELETE CASCADE,
    position     INTEGER,
    kind         TEXT NOT NULL,                 -- image | pdf
    mime         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    page_count   INTEGER NOT NULL DEFAULT 1,
    sha256       TEXT NOT NULL,
    storage_key  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX idx_files_user ON files(user_id);
  CREATE INDEX idx_files_letter ON files(letter_id);

  -- Aufgaben, Fristen, Termine und Zahlungen
  CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id       TEXT REFERENCES letters(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    kind            TEXT NOT NULL,              -- zahlung | frist | termin | aufgabe
    status          TEXT NOT NULL,              -- zu_pruefen | offen | erledigt
    origin          TEXT NOT NULL,              -- ki | regeln | beispiel | nutzer
    suggested_date  TEXT,                       -- erkanntes Datum (unbestätigt)
    suggested_time  TEXT,
    is_relative     INTEGER NOT NULL DEFAULT 0,
    relative_text   TEXT,
    relative_rule   TEXT,                       -- JSON {amount, unit, anchor}
    source_quote    TEXT,                       -- wörtliche Textstelle aus dem Brief
    source_page     INTEGER,
    quote_found     INTEGER,                    -- 1 gefunden, 0 nicht gefunden, NULL unbekannt
    check_notes     TEXT NOT NULL DEFAULT '[]', -- Hinweise zur Prüfung
    due_date        TEXT,                       -- bestätigtes Datum
    due_time        TEXT,
    confirmed_at    TEXT,
    completed_at    TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
  CREATE INDEX idx_tasks_letter ON tasks(letter_id);

  -- Erinnerungen (nur für bestätigte Aufgaben)
  CREATE TABLE reminders (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at     TEXT NOT NULL,                -- UTC (ISO 8601)
    label         TEXT,
    status        TEXT NOT NULL DEFAULT 'geplant', -- geplant | gesendet | abgebrochen
    sent_at       TEXT,
    delivery_json TEXT,                         -- Ergebnis je Kanal
    seen_at       TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_reminders_due ON reminders(status, remind_at);
  CREATE INDEX idx_reminders_task ON reminders(task_id);

  CREATE TABLE push_subscriptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        TEXT NOT NULL UNIQUE,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    device          TEXT,
    failures        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    last_success_at TEXT
  );

  -- Zähler für KI-Auswertungen pro Tag (Kostenschutz)
  CREATE TABLE ai_usage (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  -- Sicherheitsereignisse ohne Inhalte (Anmeldung, Export, Löschung …)
  CREATE TABLE security_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  `,

  // ---------- Version 2: Objektakten, Zuordnung, Antworten, Rückfragen, Verlauf ----------
  // Nur neue Tabellen und neue Spalten – vorhandene Briefe, Dateien und Konten bleiben unverändert.
  `
  -- Personen im Haushalt (für Empfänger-Erkennung und Absender von Antwortbriefen)
  CREATE TABLE persons (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    relation    TEXT NOT NULL DEFAULT 'ich',      -- ich | partner | kind | angehoerige | sonstige
    aliases     TEXT NOT NULL DEFAULT '[]',       -- weitere Schreibweisen (JSON)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_persons_user ON persons(user_id);

  -- Adressen: Haushalt, Mietobjekt, Gewerbe, Ferienwohnung … (mit Gültigkeit für Umzüge)
  CREATE TABLE addresses (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'haushalt', -- haushalt | mietobjekt | gewerbe | ferienwohnung | sonstige
    street      TEXT,
    zip         TEXT,
    city        TEXT,
    valid_from  TEXT,
    valid_to    TEXT,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_addresses_user ON addresses(user_id);

  -- Objektakten: Fahrzeug, Zähler, Vertrag, Wohnung … mit dauerhafter Identität
  CREATE TABLE objects (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    name          TEXT NOT NULL,
    provider      TEXT,                           -- Vertragspartner, z. B. „Muster Versicherung AG“
    provider_key  TEXT,                           -- normalisiert, für den Vergleich mit dem Absender
    category      TEXT NOT NULL DEFAULT 'sonstiges',
    person_id     TEXT REFERENCES persons(id) ON DELETE SET NULL,
    address_id    TEXT REFERENCES addresses(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'aktiv',  -- aktiv | beendet
    ended_at      TEXT,
    successor_id  TEXT REFERENCES objects(id) ON DELETE SET NULL,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_objects_user ON objects(user_id);

  -- Vorgänge innerhalb einer Akte (eine Rechnung, ein Schadenfall, ein Antrag …)
  CREATE TABLE cases (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'allgemein',
    status      TEXT NOT NULL DEFAULT 'offen',    -- offen | abgeschlossen
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_cases_object ON cases(object_id);

  -- Kennungen einer Akte oder eines Vorgangs (Kennzeichen, Vertrags-, Zählernummer …)
  -- status/valid_*: alte und neue Nummern, Fahrzeug- und Zählerwechsel, Vertragsverlängerung
  CREATE TABLE identifiers (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_id         TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    case_id           TEXT REFERENCES cases(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    value             TEXT NOT NULL,              -- wie geschrieben
    normalized        TEXT NOT NULL,              -- Vergleichsform
    issuer_key        TEXT,                       -- zu welchem Absender gehört die Nummer (Kontext)
    status            TEXT NOT NULL DEFAULT 'aktuell', -- aktuell | alt
    valid_from        TEXT,
    valid_to          TEXT,
    source            TEXT NOT NULL DEFAULT 'nutzer',  -- nutzer | brief
    source_letter_id  TEXT REFERENCES letters(id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX idx_identifiers_lookup ON identifiers(user_id, normalized);
  CREATE INDEX idx_identifiers_object ON identifiers(object_id);

  -- Verknüpfung Brief ↔ Akte (ein Brief kann mehrere Akten betreffen) mit Nachweis
  CREATE TABLE letter_links (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id      TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    object_id      TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    case_id        TEXT REFERENCES cases(id) ON DELETE SET NULL,
    origin         TEXT NOT NULL,                 -- auto | nutzer
    score          INTEGER,
    evidence_json  TEXT NOT NULL DEFAULT '[]',    -- ausschlaggebende Angaben aus dem Brief
    created_at     TEXT NOT NULL,
    UNIQUE (letter_id, object_id)
  );
  CREATE INDEX idx_links_object ON letter_links(object_id);
  CREATE INDEX idx_links_letter ON letter_links(letter_id);

  ALTER TABLE letters ADD COLUMN assignment_status TEXT NOT NULL DEFAULT 'offen'; -- offen | zugeordnet | pruefen | vorschlag | keine | ohne
  ALTER TABLE letters ADD COLUMN assignment_json TEXT;                              -- Kandidaten mit Begründung
  ALTER TABLE letters ADD COLUMN identifiers_json TEXT NOT NULL DEFAULT '[]';     -- im Brief erkannte Kennungen
  ALTER TABLE letters ADD COLUMN recipient TEXT;
  ALTER TABLE letters ADD COLUMN sender_address TEXT;
  ALTER TABLE letters ADD COLUMN sender_email TEXT;
  ALTER TABLE letters ADD COLUMN person_id TEXT REFERENCES persons(id) ON DELETE SET NULL;
  ALTER TABLE letters ADD COLUMN duplicate_of TEXT REFERENCES letters(id) ON DELETE SET NULL;
  ALTER TABLE letters ADD COLUMN duplicate_status TEXT;                             -- verdacht | kein_duplikat
  CREATE INDEX idx_letters_assignment ON letters(user_id, assignment_status);

  ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'seite';               -- seite | original
  ALTER TABLE files ADD COLUMN image_hash TEXT;                                    -- Bild-Fingerabdruck (Duplikate)

  -- Antwortbriefe: Entwurf → gesendet (PDF, E-Mail, Kopie)
  CREATE TABLE replies (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id       TEXT REFERENCES letters(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    recipient_json  TEXT NOT NULL DEFAULT '{}',   -- {name, address, email}
    sender_json     TEXT NOT NULL DEFAULT '{}',   -- {name, address, email, phone}
    place           TEXT,
    reply_date      TEXT,
    origin          TEXT NOT NULL DEFAULT 'vorlage', -- vorlage | ki | nutzer
    template        TEXT,
    status          TEXT NOT NULL DEFAULT 'entwurf', -- entwurf | gesendet
    sent_via        TEXT,                         -- email | post | eigenes_programm
    sent_to         TEXT,
    sent_at         TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX idx_replies_letter ON replies(letter_id);

  -- Rückfragen an die KI zu einem Brief
  CREATE TABLE letter_messages (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id   TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,                    -- frage | antwort
    content     TEXT NOT NULL,
    meta_json   TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_messages_letter ON letter_messages(letter_id);

  -- Verlauf eines Briefes (Original, Korrekturen, Zuordnung, Entwürfe, versendete Antworten)
  CREATE TABLE letter_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id   TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    detail_json TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_events_letter ON letter_events(letter_id);
  `,
  `
  -- Schlagworte (Tags) je Brief/Dokument
  ALTER TABLE letters ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function clean(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error('Die Datenbank stammt von einer neueren BriefPilot-Version. Bitte die neuere Version verwenden.');
  }
  // Vor einer Aktualisierung des Datenmodells eine vollständige Sicherungskopie anlegen
  if (version > 0 && version < MIGRATIONS.length && dbPath !== ':memory:') {
    const backup = `${dbPath}.vor-update-v${version}-${new Date().toISOString().slice(0, 10)}.bak`;
    if (!fs.existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;
  return {
    raw: db,
    get: (sql, ...params) => stmt(sql).get(...clean(params)),
    all: (sql, ...params) => stmt(sql).all(...clean(params)),
    run: (sql, ...params) => stmt(sql).run(...clean(params)),
    /** Führt fn in einer Transaktion aus (verschachtelbar). */
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

export const nowIso = () => new Date().toISOString();
