# BriefPilot – erste Version

BriefPilot ist ein Briefassistent als Web-App: Briefe fotografieren oder als PDF hochladen, Inhalt erkennen lassen, die Erklärung prüfen, Fristen bestätigen und später alles wiederfinden. Auf dem Handy lässt sich die App wie eine normale App auf den Startbildschirm legen (PWA).

> „BriefPilot“ ist ein Arbeitstitel. Der Name ist noch nicht auf Verfügbarkeit (Marke, Domain) geprüft.

---

## Was funktioniert echt – und was nicht?

| Bereich | Stand |
|---|---|
| Registrierung, Anmeldung, Abmeldung, mehrere Geräte | **echt** |
| Passwort zurücksetzen | **echt** – ohne eingerichteten Mailserver wird der Link aber nur im Server-Fenster angezeigt (Entwicklungsmodus) |
| Fotos aufnehmen, Bilder/PDFs hochladen, mehrere Seiten zu einem Brief | **echt** |
| Verschlüsselte Ablage der Originale | **echt** (AES-256-GCM) |
| KI-Texterkennung und Erklärung in einfacher Sprache | **echt, sobald ein ANTHROPIC_API_KEY eingetragen ist** und der Nutzer zustimmt. Ohne Schlüssel: aus |
| Erkennung ohne KI | **echt, aber einfach**: PDFs mit Textebene werden mit Suchregeln gelesen (Absender, Datum, Beträge, Aktenzeichen, Fristen). Keine Erklärung in einfacher Sprache. Fotos werden ohne KI gar nicht gelesen – das sagt die App auch so |
| Prüfung von Fristen (Textstelle, relative Fristen, Bestätigung) | **echt** |
| Sortieren, Kategorien, Suche (Inhalt, Absender, Datum, Aktenzeichen) | **echt** |
| Erinnerungen | **echt** in der App. Zusätzlich per Push (Schlüssel werden von `npm run setup` erzeugt) und per E-Mail (nur mit Mailserver) |
| Kalenderdatei (.ics) für einen bestätigten Termin | **echt**, nur auf Klick |
| Datenexport (ZIP) und Kontolöschung | **echt** |
| Demomodus mit 8 erfundenen Beispielbriefen | **echt**, Auswertungen sind als „Beispielauswertung (vorbereitet)“ gekennzeichnet |
| Pro-Funktionen (Kalender-Abgleich, Antwortentwürfe, Familienprofile, Abo …) | **nur Vorschau** |

Die App zeigt diese Übersicht auch selbst an: Anmeldeseite → „Was funktioniert echt?“.

**Nicht von mir getestet** (weil in meiner Arbeitsumgebung nicht erreichbar): die echte Anfrage an die Claude-API mit einem echten Schlüssel, die Zustellung von Push-Nachrichten über die Dienste von Google/Apple/Mozilla und der Versand über einen echten Mailserver. Alle drei sind programmiert und gegen nachgebaute Gegenstellen getestet.

---

## Lokal starten – Schritt für Schritt

Sie brauchen nur **Node.js**. Es müssen keine weiteren Pakete installiert werden.

1. **Node.js installieren:** Auf [nodejs.org](https://nodejs.org) die Version mit dem Hinweis „LTS“ herunterladen und installieren. Mindestens Version 22.13 ist nötig.
2. **Projekt entpacken:** Die ZIP-Datei `briefpilot.zip` entpacken, z. B. in „Dokumente“.
3. **Terminal im Projektordner öffnen:**
   - *Mac:* Im Finder Rechtsklick auf den Ordner `briefpilot` → „Neues Terminal beim Ordner“.
   - *Windows:* Den Ordner `briefpilot` öffnen, oben in die Adresszeile klicken, `cmd` eintippen und Enter drücken.
4. **Einrichten** (nur beim ersten Mal):
   ```
   npm run setup
   ```
   Das legt die Datei `.env` mit neuen, geheimen Schlüsseln an.
5. **Starten:**
   ```
   npm start
   ```
   Im Fenster steht jetzt, welche Funktionen echt arbeiten.
6. **Öffnen:** Im Browser `http://localhost:3000` aufrufen.
7. **Ausprobieren:** „Demo mit Beispielbriefen ansehen“ anklicken – oder ein eigenes Konto anlegen.

Beenden: im Terminal `Strg + C`.

### KI-Auswertung einschalten

1. Bei Anthropic ein Konto für die API anlegen und einen API-Schlüssel erzeugen (platform.claude.com).
2. Die Datei `.env` mit einem Texteditor öffnen und den Schlüssel eintragen:
   `ANTHROPIC_API_KEY=…`
3. Server neu starten (`Strg + C`, dann `npm start`).

Danach fragt die App jeden Nutzer vor dem ersten Scannen, ob seine Briefe an den KI-Dienst übermittelt werden dürfen. Ein Tageslimit pro Nutzer (`AI_DAILY_LIMIT`) schützt vor hohen Kosten.

### Auf dem Handy ausprobieren

- Gleiches WLAN: In `.env` `HOST=0.0.0.0` setzen, Server neu starten und auf dem Handy `http://<IP-Adresse-des-Computers>:3000` öffnen. Fotografieren und Hochladen funktionieren so.
- „Zum Startbildschirm hinzufügen“ und Push-Benachrichtigungen verlangen eine sichere **https**-Verbindung. Dafür die App auf einem Server mit https betreiben (siehe `docs/ARCHITEKTUR.md`, Abschnitt „Betrieb“).

### E-Mail einrichten (optional)

In `.env` die Zugangsdaten Ihres E-Mail-Anbieters eintragen (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). Ohne diese Angaben werden E-Mails nicht verschickt, sondern im Terminal angezeigt.

### Tests ausführen

```
npm test
```
28 automatische Tests prüfen unter anderem: Trennung der Nutzerkonten, Upload-Prüfungen, Fristbestätigung, Umgang mit manipulierten KI-Antworten, Erinnerungen, Export und Löschung.

---

## Wichtig zur Sicherheit

- **`FILE_ENCRYPTION_KEY` sichern!** Geht dieser Schlüssel verloren, sind alle gespeicherten Briefe unlesbar. Bewahren Sie ihn getrennt von Datensicherungen auf.
- Die Datei `.env` niemals weitergeben, hochladen oder in eine Versionsverwaltung legen.
- Der Ordner `data/` enthält alle Nutzerdaten (Datenbank und verschlüsselte Dateien).
- Vor einem öffentlichen Start: `docs/SICHERHEIT-UND-DATENSCHUTZ.md` durcharbeiten. Die App ist **nicht** als „DSGVO-konform“ zu bezeichnen, bevor diese Punkte geprüft sind.

---

## Projektstruktur

```
briefpilot/
├── package.json            Startbefehle (setup, start, test) – keine externen Pakete
├── .env.example            Vorlage für Einstellungen (ohne echte Zugangsdaten)
├── scripts/setup.js        erzeugt .env mit neuen Schlüsseln
├── server/                 Server (Node.js)
│   ├── index.js            Start, Erinnerungs-Takt, Wartung
│   ├── app.js              Sicherheits-Header, Anmeldung, CSRF-Schutz, Routing
│   ├── config.js           Einstellungen und „Was ist echt?“-Übersicht
│   ├── db.js               Datenmodell (SQLite)
│   ├── routes/             Schnittstellen: auth, account, letters, tasks
│   ├── analysis/           KI-Anbindung, Regel-Erkennung, Prüfung der Ergebnisse
│   ├── domain/             Briefe speichern/suchen, Erinnerungen planen/zustellen
│   ├── pdf/                PDF lesen/prüfen, Beispiel-PDFs erzeugen
│   ├── lib/                HTTP, Sicherheit, verschlüsselte Ablage, E-Mail, Push, ZIP
│   └── demo/               erfundene Beispielbriefe
├── public/                 Oberfläche (PWA)
│   ├── index.html, sw.js, manifest.webmanifest, icons/
│   ├── css/app.css
│   └── js/                 app.js (Seitenwechsel), views/ (je Bildschirm), shared/ (gemeinsame Datumslogik)
├── test/                   automatische Tests
└── docs/
    ├── ARCHITEKTUR.md      technische Wahl, Datenmodell, Ausbau zu Pro
    └── SICHERHEIT-UND-DATENSCHUTZ.md   Umgesetztes und offene Prüfpunkte vor dem Start
```
