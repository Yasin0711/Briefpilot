// Datenmigration: Eine Datenbank der ersten Version wird beim Start aktualisiert,
// ohne dass Konten, Briefe, Dateien, Aufgaben oder Erinnerungen verloren gehen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../server/db.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // funktioniert auch unter Windows

test('Update von Version 1: alle Daten bleiben erhalten, neue Felder haben sinnvolle Startwerte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefpilot-migration-'));
  const dbPath = path.join(dir, 'briefpilot.sqlite');
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(fs.readFileSync(path.join(here, 'fixtures', 'schema-v1.sql'), 'utf8'));
    old.exec('PRAGMA user_version = 1');
    const t = '2026-01-01T10:00:00.000Z';
    old.prepare('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'alt@example.org', 'Alt', 'scrypt$1$1$1$a$b', t, t);
    old.prepare(`INSERT INTO letters (id, user_id, subject, sender, letter_date, letter_date_status, uploaded_at, category, refs_json,
                 full_text, search_text, analysis_status, analysis_source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('l1', 'u1', 'Jahresabrechnung', 'Stadtwerke', '2025-12-01', 'bestaetigt', t, 'rechnungen',
        JSON.stringify([{ label: 'Zählernummer', value: '1ESY 1160 4421', quote: null }]), 'Zählernummer: 1ESY 1160 4421', 'x', 'fertig', 'regeln', t, t);
    old.prepare(`INSERT INTO files (id, user_id, letter_id, position, kind, mime, size, page_count, sha256, storage_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('f1', 'u1', 'l1', 0, 'pdf', 'application/pdf', 1234, 1, 'abc', 'u1/f1.bin', t);
    old.prepare(`INSERT INTO tasks (id, user_id, letter_id, title, kind, status, origin, due_date, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', 'u1', 'l1', '89,40 € überweisen', 'zahlung', 'offen', 'regeln', '2026-02-01', t, t);
    old.prepare('INSERT INTO reminders (id, user_id, task_id, remind_at, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('r1', 'u1', 't1', '2026-01-25T07:00:00.000Z', '1 Woche vorher', 'geplant', t);
    old.close();

    const db = openDatabase(dbPath);
    assert.equal(db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
    assert.equal(db.get('SELECT email FROM users WHERE id = ?', 'u1').email, 'alt@example.org');
    const letter = db.get('SELECT * FROM letters WHERE id = ?', 'l1');
    assert.equal(letter.subject, 'Jahresabrechnung');
    assert.equal(letter.letter_date_status, 'bestaetigt');
    assert.equal(letter.assignment_status, 'offen', 'neue Spalte mit Startwert');
    assert.equal(letter.identifiers_json, '[]');
    assert.equal(db.get('SELECT role FROM files WHERE id = ?', 'f1').role, 'seite');
    assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', 't1').status, 'offen');
    assert.equal(db.get('SELECT status FROM reminders WHERE id = ?', 'r1').status, 'geplant');
    // Neue Tabellen sind nutzbar
    db.run(`INSERT INTO objects (id, user_id, type, name, created_at, updated_at) VALUES ('o1', 'u1', 'strom', 'Strom', ?, ?)`, t, t);
    db.run(`INSERT INTO letter_links (id, user_id, letter_id, object_id, origin, created_at) VALUES ('k1', 'u1', 'l1', 'o1', 'nutzer', ?)`, t);
    // Sicherungskopie vor dem Update wurde angelegt
    const backups = fs.readdirSync(dir).filter((f) => f.includes('vor-update-v1'));
    assert.equal(backups.length, 1);
    const copy = new DatabaseSync(path.join(dir, backups[0]));
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM letters').get().n, 1);
    copy.close();
    // Löschen eines Briefes entfernt seine Verknüpfungen, nicht die Akte
    db.run('DELETE FROM letters WHERE id = ?', 'l1');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM letter_links').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM objects').n, 1);
    db.close();
    // Erneutes Öffnen: keine weitere Migration, keine neue Sicherung
    const again = openDatabase(dbPath);
    again.close();
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('vor-update')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
