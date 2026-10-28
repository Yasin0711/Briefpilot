// Zuordnung von Briefen zu Objektakten: mehrere sehr ähnliche Fahrzeuge, Zähler und Verträge.
// Grundregel: Nur ein eindeutiger Treffer wird automatisch zugeordnet; alles Unklare landet zur Prüfung.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { assignLetter, setLetterLinks, reassignOpenLetters, letterIdentifiers, detectPerson } from '../server/domain/assignment.js';
import { normalizeIdentifier, orgKey } from '../public/js/shared/identifiers.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function setup() {
  const db = openDatabase(':memory:');
  const userId = id();
  db.run('INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)', userId, `${userId}@example.org`, now(), now());
  const objects = {};
  const addObject = (key, { type, name, provider }, identifiers) => {
    const oid = id();
    db.run(
      'INSERT INTO objects (id, user_id, type, name, provider, provider_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      oid, userId, type, name, provider || null, provider ? orgKey(provider) : null, now(), now()
    );
    for (const i of identifiers) {
      db.run(
        `INSERT INTO identifiers (id, user_id, object_id, kind, value, normalized, issuer_key, status, valid_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id(), userId, oid, i.kind, i.value, normalizeIdentifier(i.kind, i.value), provider ? orgKey(provider) : null,
        i.status || 'aktuell', i.validTo || null, now()
      );
    }
    objects[key] = oid;
    return oid;
  };
  // Fünf Fahrzeuge bei derselben Versicherung – gemeinsame Kundennummer
  const ins = 'Muster Versicherung AG';
  [['SB-AB 123', 'KFZ-001'], ['SB-CD 456', 'KFZ-002'], ['SB-EF 789', 'KFZ-003'], ['SB-GH 234', 'KFZ-004'], ['SB-JK 567', 'KFZ-005']]
    .forEach(([plate, policy], i) => addObject(`kfz${i + 1}`, { type: 'fahrzeug', name: `Fahrzeug ${i + 1} · ${plate}`, provider: ins }, [
      { kind: 'kennzeichen', value: plate }, { kind: 'versicherungsnummer', value: policy }, { kind: 'kundennummer', value: '778-112' },
    ]));
  // Zwei weitere Verträge derselben Versicherung mit sehr ähnlichen Nummern
  addObject('hausrat', { type: 'versicherung', name: 'Hausratversicherung', provider: ins }, [
    { kind: 'versicherungsnummer', value: 'HR-2024-778812' }, { kind: 'kundennummer', value: '778-112' },
  ]);
  addObject('haftpflicht', { type: 'versicherung', name: 'Privathaftpflicht', provider: ins }, [
    { kind: 'versicherungsnummer', value: 'HR-2024-778813' }, { kind: 'kundennummer', value: '778-112' },
  ]);
  // Drei Stromzähler bei denselben Stadtwerken
  const sw = 'Stadtwerke Musterstadt GmbH';
  addObject('stromHaus', { type: 'strom', name: 'Strom Haushalt', provider: sw }, [
    { kind: 'zaehlernummer', value: '1ESY 1160 4421' }, { kind: 'malo_id', value: '51238696781' }, { kind: 'vertragskonto', value: '2006 5512 3' }, { kind: 'kundennummer', value: '4711-0815-23' },
  ]);
  addObject('stromMiet', { type: 'strom', name: 'Strom Mietwohnung', provider: sw }, [
    { kind: 'zaehlernummer', value: '1ESY 1160 4422' }, { kind: 'malo_id', value: '51238696799' }, { kind: 'vertragskonto', value: '2006 5512 4' }, { kind: 'kundennummer', value: '4711-0815-23' },
  ]);
  addObject('stromFerien', { type: 'strom', name: 'Strom Ferienwohnung', provider: sw }, [
    { kind: 'zaehlernummer', value: '7KSY 0001 1234', status: 'alt', validTo: '2026-06-30' }, { kind: 'zaehlernummer', value: '7KSY 0009 9876' },
    { kind: 'vertragskonto', value: '2006 9999 1' }, { kind: 'kundennummer', value: '4711-0815-23' },
  ]);
  // Mobilfunk mit alter und neuer Vertragsnummer
  addObject('handy', { type: 'internet', name: 'Mobilfunk', provider: 'Funkfix Telekommunikation GmbH' }, [
    { kind: 'vertragsnummer', value: 'V-2019-12', status: 'alt' }, { kind: 'vertragsnummer', value: 'V-2026-55' },
  ]);

  const letter = ({ sender, text, date = '2026-10-01', refs = [] }) => {
    const lid = id();
    db.run(
      `INSERT INTO letters (id, user_id, sender, letter_date, letter_date_status, uploaded_at, refs_json, full_text, analysis_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'erkannt', ?, ?, ?, 'fertig', ?, ?)`,
      lid, userId, sender, date, now(), JSON.stringify(refs), text, now(), now()
    );
    return lid;
  };
  const state = (lid) => {
    const l = db.get('SELECT assignment_status, assignment_json FROM letters WHERE id = ?', lid);
    const links = db.all('SELECT object_id, case_id, origin, evidence_json FROM letter_links WHERE letter_id = ?', lid);
    return { status: l.assignment_status, info: JSON.parse(l.assignment_json || '{}'), links };
  };
  return { db, userId, objects, letter, state, user: { id: userId } };
}

test('Fünf Fahrzeuge, ein Versicherer: eindeutiges Kennzeichen bzw. Versicherungsschein ordnet automatisch zu', () => {
  const { db, objects, letter, state } = setup();
  const a = letter({ sender: 'Muster Versicherung AG', text: 'Muster Versicherung AG\nVersicherungsschein-Nr.: KFZ-002\nKundennummer: 778-112\namtl. Kennzeichen: SB-CD 456\nIhr Beitrag ändert sich.' });
  assert.equal(assignLetter(db, a).status, 'zugeordnet');
  const s = state(a);
  assert.deepEqual(s.links.map((l) => l.object_id), [objects.kfz2]);
  const evidence = JSON.parse(s.links[0].evidence_json);
  assert.ok(evidence.some((e) => e.kind === 'kennzeichen' && e.quote.includes('SB-CD 456')), 'Nachweis enthält die Textstelle');
  const kunde = evidence.find((e) => e.kind === 'kundennummer');
  assert.ok(kunde.shared > 1 && kunde.note.includes('unterscheidet'), 'gemeinsame Kundennummer wird als nicht unterscheidend erklärt');

  // Nur Versicherungsschein, ohne Kennzeichen
  const b = letter({ sender: 'Muster Versicherung AG', text: 'Versicherungsschein-Nr.: KFZ-004\nSehr geehrte Frau Beispiel, anbei Ihre Beitragsrechnung.' });
  assert.equal(assignLetter(db, b).status, 'zugeordnet');
  assert.deepEqual(state(b).links.map((l) => l.object_id), [objects.kfz4]);
});

test('Kennzeichen in anderer Schreibweise wird erkannt – aber andere Gliederung ist ein anderes Kennzeichen', () => {
  const { db, objects, letter, state } = setup();
  for (const plate of ['SB CD 456', 'sb-cd456', 'SB-CD-456']) {
    const l = letter({ sender: 'Muster Versicherung AG', text: `Betrifft Ihr Fahrzeug mit dem Kennzeichen: ${plate}` });
    assert.equal(assignLetter(db, l).status, 'zugeordnet', plate);
    assert.deepEqual(state(l).links.map((x) => x.object_id), [objects.kfz2], plate);
  }
  const other = letter({ sender: 'Muster Versicherung AG', text: 'Kennzeichen: SBC-D 456' });
  const d = assignLetter(db, other);
  assert.notEqual(d.status, 'zugeordnet', 'SBC-D 456 ist nicht SB-CD 456');
  assert.equal(state(other).links.length, 0);
});

test('Nur die gemeinsame Kundennummer oder nur der Absender: kein Raten, sondern Prüf-Eingang', () => {
  const { db, letter, state } = setup();
  const a = letter({ sender: 'Muster Versicherung AG', text: 'Kundennummer: 778-112\nWir haben unsere Versicherungsbedingungen aktualisiert.' });
  const d = assignLetter(db, a);
  assert.equal(d.status, 'pruefen');
  assert.equal(state(a).links.length, 0, 'nichts wird blind abgelegt');
  assert.equal(state(a).info.candidates.length, 7);
  assert.match(d.message, /Wir haben sieben mögliche Akten gefunden\. Bitte wählen Sie die richtige aus\./);

  const b = letter({ sender: 'Muster Versicherung AG', text: 'Wichtige Information zu Ihren Verträgen bei uns.' });
  assert.equal(assignLetter(db, b).status, 'pruefen', 'gleicher Absender allein entscheidet nicht');
});

test('Zwei ähnliche Versicherungsnummern: „Wir haben zwei mögliche Verträge gefunden“', () => {
  const { db, letter, state, objects } = setup();
  const l = letter({ sender: 'Muster Versicherung AG', text: 'Versicherungsschein-Nr.: HR-2024-778814\nIhre Jahresrechnung.' });
  const d = assignLetter(db, l);
  assert.equal(d.status, 'pruefen');
  assert.equal(d.reason, 'aehnlich');
  assert.match(d.message, /zwei mögliche Verträge gefunden\. Bitte wählen Sie den richtigen aus/);
  const ids = state(l).info.candidates.map((c) => c.objectId).sort();
  assert.deepEqual(ids, [objects.hausrat, objects.haftpflicht].sort());
  assert.equal(state(l).links.length, 0);
});

test('Lesefehler (O statt 0) und ein Zeichen Unterschied werden nie automatisch zugeordnet', () => {
  const { db, letter, state, objects } = setup();
  const l = letter({ sender: 'Muster Versicherung AG', text: 'Versicherungsschein-Nr.: KFZ-0O3' });
  const d = assignLetter(db, l);
  assert.equal(d.status, 'pruefen');
  assert.deepEqual(state(l).info.candidates.map((c) => c.objectId), [objects.kfz3]);
  const plate = letter({ sender: 'Muster Versicherung AG', text: 'Kennzeichen: SB-CD 457' });
  assert.equal(assignLetter(db, plate).status, 'pruefen');
  assert.equal(state(plate).links.length, 0);
});

test('Mehrere Kennzeichen in einem Brief: alle betroffenen Akten werden zur Bestätigung vorgeschlagen', () => {
  const { db, letter, state, objects } = setup();
  const l = letter({ sender: 'Muster Versicherung AG', text: 'Ihre Fahrzeuge SB-AB 123 und SB-EF 789 sind ab 1.1. in einem Flottenvertrag versichert.' });
  const d = assignLetter(db, l);
  assert.equal(d.status, 'pruefen');
  assert.equal(d.reason, 'mehrere');
  assert.deepEqual(d.preselected.sort(), [objects.kfz1, objects.kfz3].sort());
});

test('Gleiche Rechnungsnummer bei einer anderen Firma zählt nicht (Kontext)', () => {
  const { db, letter, state, user, objects } = setup();
  // Erster Brief der Stadtwerke mit Rechnungsnummer → wird dem Zähler zugeordnet, Vorgang entsteht
  const first = letter({ sender: 'Stadtwerke Musterstadt GmbH', text: 'Zählernummer: 1ESY 1160 4421\nRechnungsnummer: 12345\nIhre Abrechnung.' });
  assert.equal(assignLetter(db, first).status, 'zugeordnet');
  const caseId = state(first).links[0].case_id;
  assert.ok(caseId, 'Vorgang für die Rechnung angelegt');
  // Mahnung zur selben Rechnung ohne Zählernummer → gleicher Vorgang
  const reminder = letter({ sender: 'Stadtwerke Musterstadt', text: 'Zahlungserinnerung\nRechnungsnummer: 12345\nBitte begleichen Sie den offenen Betrag.' });
  assert.equal(assignLetter(db, reminder).status, 'zugeordnet');
  assert.equal(state(reminder).links[0].object_id, objects.stromHaus);
  assert.equal(state(reminder).links[0].case_id, caseId, 'Mahnung landet im selben Vorgang');
  // Gleiche Rechnungsnummer, anderer Absender
  const shop = letter({ sender: 'Beispielhaus Versand GmbH', text: 'Rechnungsnummer: 12345\nVielen Dank für Ihre Bestellung.' });
  assert.equal(assignLetter(db, shop).status, 'keine');
  void user;
});

test('Drei Stromzähler: Zählernummer, MaLo-ID und Zählerwechsel', () => {
  const { db, letter, state, objects } = setup();
  const a = letter({ sender: 'Stadtwerke Musterstadt GmbH', text: 'Marktlokations-ID: 51238696799\nKundennummer: 4711-0815-23\nAbschlagsplan' });
  assert.equal(assignLetter(db, a).status, 'zugeordnet');
  assert.equal(state(a).links[0].object_id, objects.stromMiet);
  // Alter Zähler (bis 30.06.2026) – Brief aus der Zeit davor
  const old = letter({ sender: 'Stadtwerke Musterstadt GmbH', date: '2026-03-01', text: 'Zählernummer: 7KSY 0001 1234\nJahresabrechnung' });
  assert.equal(assignLetter(db, old).status, 'zugeordnet');
  assert.equal(state(old).links[0].object_id, objects.stromFerien);
  // Neuer Zähler derselben Wohnung
  const fresh = letter({ sender: 'Stadtwerke Musterstadt GmbH', text: 'Zählernummer: 7KSY 0009 9876\nZählerwechsel abgeschlossen' });
  assert.equal(assignLetter(db, fresh).status, 'zugeordnet');
  assert.equal(state(fresh).links[0].object_id, objects.stromFerien);
  // Nur gemeinsame Kundennummer → Prüfung
  const generic = letter({ sender: 'Stadtwerke Musterstadt GmbH', text: 'Kundennummer: 4711-0815-23\nPreisänderung zum 1. Januar.' });
  const d = assignLetter(db, generic);
  assert.equal(d.status, 'pruefen');
  assert.match(d.message, /drei mögliche Stromzähler gefunden\. Bitte wählen Sie den richtigen aus/);
});

test('Alte und neue Vertragsnummer führen zur selben Akte', () => {
  const { db, letter, state, objects } = setup();
  const oldNo = letter({ sender: 'Funkfix Telekommunikation GmbH', text: 'Vertragsnummer: V-2019-12\nIhre Rechnung' });
  assert.equal(assignLetter(db, oldNo).status, 'zugeordnet');
  assert.equal(state(oldNo).links[0].object_id, objects.handy);
  const ev = JSON.parse(state(oldNo).links[0].evidence_json).find((e) => e.kind === 'vertragsnummer');
  assert.equal(ev.expired, true);
  const newNo = letter({ sender: 'Funkfix', text: 'Ihre neue Vertragsnummer: V-2026-55' });
  assert.equal(assignLetter(db, newNo).status, 'zugeordnet');
});

test('Entscheidung des Nutzers bleibt erhalten; gelernte Nummern helfen bei weiteren Briefen', () => {
  const { db, letter, state, objects, user } = setup();
  // Schadenbrief mit unbekannter Schadennummer, ohne Kennzeichen → nur Absender → Prüfung
  const damage = letter({ sender: 'Muster Versicherung AG', text: 'Schaden-Nr.: S-2026-0815\nWir haben Ihren Schaden vom 3.9. aufgenommen.' });
  assert.equal(assignLetter(db, damage).status, 'pruefen');
  const follow = letter({ sender: 'Muster Versicherung AG', text: 'Schaden-Nr.: S-2026-0815\nDer Gutachter meldet sich bei Ihnen.' });
  assert.equal(assignLetter(db, follow).status, 'pruefen');
  // Nutzer ordnet den ersten Brief Fahrzeug 3 zu und übernimmt die Schadennummer
  const res = setLetterLinks(db, user, damage, { objectIds: [objects.kfz3], cases: { [objects.kfz3]: 'neu' } });
  assert.equal(state(damage).status, 'zugeordnet');
  assert.equal(state(damage).links[0].origin, 'nutzer');
  assert.ok(state(damage).links[0].case_id, 'Vorgang für den Schadenfall');
  void res;
  // Der Folgebrief wird jetzt über die Schadennummer eindeutig
  reassignOpenLetters(db, user.id);
  assert.equal(state(follow).status, 'zugeordnet');
  assert.equal(state(follow).links[0].object_id, objects.kfz3);
  assert.equal(state(follow).links[0].case_id, state(damage).links[0].case_id);
  // Automatische Neubewertung ändert die Entscheidung des Nutzers nicht
  assignLetter(db, damage);
  assert.equal(state(damage).links[0].origin, 'nutzer');
  // „Ohne Akte“ bleibt bestehen
  const misc = letter({ sender: 'Muster Versicherung AG', text: 'Newsletter' });
  setLetterLinks(db, user, misc, { objectIds: [], none: true });
  reassignOpenLetters(db, user.id);
  assert.equal(state(misc).status, 'ohne');
});

test('Nummern lernen: Nutzer übernimmt eine neue Nummer in die Akte', () => {
  const { db, letter, state, objects, user } = setup();
  const l = letter({ sender: 'Muster Versicherung AG', text: 'Ihre neue Versicherungsschein-Nr.: KFZ-002-B\nKennzeichen: SB-CD 456' });
  assert.equal(assignLetter(db, l).status, 'zugeordnet');
  const ids = letterIdentifiers(db.get('SELECT * FROM letters WHERE id = ?', l));
  const neu = ids.find((i) => i.value === 'KFZ-002-B');
  assert.equal(neu.status, 'neu');
  setLetterLinks(db, user, l, { objectIds: [objects.kfz2], learn: [{ objectId: objects.kfz2, kind: neu.kind, value: neu.value, status: 'neu' }] });
  const stored = db.get('SELECT * FROM identifiers WHERE object_id = ? AND normalized = ?', objects.kfz2, 'KFZ002B');
  assert.ok(stored);
  assert.equal(stored.source, 'brief');
  const next = letter({ sender: 'Muster Versicherung AG', text: 'Versicherungsschein-Nr.: KFZ-002-B\nBeitragsrechnung' });
  assert.equal(assignLetter(db, next).status, 'zugeordnet');
  assert.equal(state(next).links[0].object_id, objects.kfz2);
});

test('Gleiche Adresse bei zwei Vertragspartnern: der Absender entscheidet, welche Akte gemeint ist', () => {
  const { db, userId, letter, state } = setup();
  const add = (name, provider) => {
    const oid = id();
    db.run('INSERT INTO objects (id, user_id, type, name, provider, provider_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', oid, userId, 'wohnen', name, provider, orgKey(provider), now(), now());
    db.run(
      `INSERT INTO identifiers (id, user_id, object_id, kind, value, normalized, issuer_key, created_at) VALUES (?, ?, ?, 'objektadresse', ?, ?, ?, ?)`,
      id(), userId, oid, 'Lindenweg 12', normalizeIdentifier('objektadresse', 'Lindenweg 12'), orgKey(provider), now()
    );
    return oid;
  };
  const gas = add('Gas Lindenweg', 'Gaswerke Beispiel GmbH');
  const flat = add('Wohnung Lindenweg', 'Hausverwaltung Sonnig & Partner GmbH');
  const a = letter({ sender: 'Hausverwaltung Sonnig & Partner GmbH', text: 'Mietobjekt: Lindenweg 12, Whg. 3\nNebenkostenabrechnung' });
  assert.equal(assignLetter(db, a).status, 'zugeordnet');
  assert.equal(state(a).links[0].object_id, flat);
  const b = letter({ sender: 'Gaswerke Beispiel', text: 'Lieferadresse: Lindenweg 12, 12345 Musterstadt\nAbschlag' });
  assert.equal(assignLetter(db, b).status, 'zugeordnet');
  assert.equal(state(b).links[0].object_id, gas);
  // Andere Hausnummer ist eine andere Adresse
  const c = letter({ sender: 'Gaswerke Beispiel', text: 'Lieferadresse: Lindenweg 123' });
  assert.notEqual(assignLetter(db, c).status, 'zugeordnet');
});

test('Empfänger-Person wird nur bei eindeutigem Namen erkannt', () => {
  const { db, userId } = setup();
  const p1 = id();
  const p2 = id();
  db.run('INSERT INTO persons (id, user_id, name, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', p1, userId, 'Lena Beispiel', 'ich', now(), now());
  db.run('INSERT INTO persons (id, user_id, name, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', p2, userId, 'Max Beispiel', 'partner', now(), now());
  assert.equal(detectPerson(db, { user_id: userId, full_text: 'Frau\nLena Beispiel\nLindenweg 12' }), p1);
  assert.equal(detectPerson(db, { user_id: userId, full_text: 'Herrn\nMax Beispiel\nLindenweg 12' }), p2);
  assert.equal(detectPerson(db, { user_id: userId, full_text: 'Familie Beispiel\nLindenweg 12' }), null);
});

test('Bezeichnungen der Nummernarten werden wieder der richtigen Art zugeordnet (Korrektur-Dialog)', async () => {
  const { IDENTIFIER_KINDS, kindFromLabel } = await import('../public/js/shared/identifiers.js');
  for (const k of IDENTIFIER_KINDS) assert.equal(kindFromLabel(k.label), k.id, k.label);
  assert.equal(kindFromLabel('amtl. Kennzeichen'), 'kennzeichen');
  assert.equal(kindFromLabel('Patientennummer'), 'mitgliedsnummer');
});
