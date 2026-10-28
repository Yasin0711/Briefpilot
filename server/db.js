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
];

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
