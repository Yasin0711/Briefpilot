# BriefPilot

BriefPilot ist ein Briefassistent als Web-App: Briefe mit dem Handy scannen oder als PDF hochladen, von einer KI lesen und in einfacher Sprache erklären lassen, Fristen bestätigen, Briefe automatisch der richtigen Akte zuordnen (Auto, Zähler, Vertrag …), Fragen zum Brief stellen und Antworten schreiben. Auf dem Handy lässt sich die App wie eine normale App auf den Startbildschirm legen (PWA).

> „BriefPilot“ ist ein Arbeitstitel. Der Name ist noch nicht auf Verfügbarkeit (Marke, Domain) geprüft.

---

## Schnellstart unter Windows

1. **Node.js installieren:** Auf [nodejs.org](https://nodejs.org) die Version „LTS“ herunterladen und installieren (mindestens Version 22.13).
2. **Doppelklick auf `BriefPilot-starten.cmd`** im Ordner `briefpilot`.
   - Beim ersten Start wird alles eingerichtet. Dabei fragt das Fenster nach einem **kostenlosen Gemini-Schlüssel** für die KI (siehe unten) – mit Enter überspringen Sie das und tragen ihn später ein.
   - Danach öffnet sich der Browser mit `http://localhost:3000`.
3. **Ausprobieren:** „Demo mit Beispielbriefen ansehen“ – oder ein eigenes Konto anlegen.

Beenden: das schwarze Fenster schließen (oder darin `Strg + C`).

Mac und Linux (oder Windows im Terminal): im Ordner `briefpilot` einmal `npm run setup`, danach jeweils `npm start` und `http://localhost:3000` öffnen.

---

## KI kostenlos einschalten (Google Gemini)

Die KI liest Fotos und PDFs, erklärt den Brief, erkennt Fristen und Nummern, beantwortet Fragen und entwirft Antworten.

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) öffnen und mit einem Google-Konto anmelden.
2. **„API-Schlüssel erstellen“** (Create API key) wählen und den Schlüssel kopieren.
3. Den Schlüssel beim ersten Start einfügen – oder später die Datei `.env` mit dem Editor öffnen und eintragen: `GEMINI_API_KEY=…`
4. **Prüfen:** Doppelklick auf `KI-testen.cmd` (oder `npm run ki-test`). Die Meldung „✓ Verbindung klappt“ zeigt, dass alles stimmt; sonst steht dort in Worten, was nicht passt (z. B. Schlüssel ungültig, Kontingent für heute aufgebraucht).
5. BriefPilot neu starten.

Gut zu wissen:

- **Kosten:** keine, solange für das Google-Projekt kein Rechnungskonto verknüpft ist. Das kostenlose Kontingent ist pro Tag begrenzt. Ist es aufgebraucht, wechselt BriefPilot automatisch auf ein zweites kostenloses Modell (`GEMINI_FALLBACK_MODEL`). Ist auch das erschöpft, sagt die App das ehrlich und liest PDFs mit Text vorerst ohne KI; Fotos werden gespeichert und können später erneut ausgewertet werden.
- **Datenschutz:** Für Nutzer in der EU, der Schweiz und Großbritannien gelten laut Google auch beim kostenlosen Kontingent die Datenregeln des bezahlten Dienstes (keine Verwendung der Briefe zur Produktverbesserung). Die Gemini-API ist ab 18 Jahren freigegeben. Jeder Nutzer muss in der App zustimmen, bevor ein Brief an die KI geht.
- **Öffentlicher Start:** Wer BriefPilot anderen Menschen in der EU anbietet, muss laut den Google-Bedingungen den **kostenpflichtigen** Zugang nutzen (`GEMINI_PAID=true`). Das kostenlose Kontingent ist zum Testen und für den eigenen Gebrauch gedacht. Quelle: [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms).
- **Modelle:** `gemini-3.8-flash` (Standard) und `gemini-3.5-flash-lite` (Ersatz) – beide laut Google stabil und im kostenlosen Kontingent enthalten. Änderbar in `.env`.

### Alternativen

| Anbieter | Kosten | Einstellung in `.env` |
|---|---|---|
| **Ollama / LM Studio** auf dem eigenen Computer | 100 % kostenlos, Briefe verlassen den Computer nicht (braucht ein Modell mit Bildverständnis und einen leistungsfähigen Rechner) | `AI_PROVIDER=openai`, `OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1`, `OPENAI_COMPAT_MODEL=…` |
| Andere OpenAI-kompatible Dienste (z. B. Groq, OpenRouter, Mistral) | je nach Anbieter | wie oben, mit `OPENAI_COMPAT_API_KEY` |
| Claude-API (Anthropic) | kostenpflichtig | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=…` |
| Ohne KI | – | `AI_PROVIDER=aus` |

Ein Tageslimit pro Nutzer (`AI_DAILY_LIMIT`, Demo: `DEMO_AI_DAILY_LIMIT`) schützt das Kontingent.

---

## Was kann BriefPilot – und was ist echt?

| Bereich | Stand |
|---|---|
| Registrierung, Anmeldung, mehrere Geräte, Passwort ändern/zurücksetzen | **echt** (Zurücksetzen-Link ohne Mailserver nur im Server-Fenster) |
| **Ohne Konto fortfahren** (Gastzugang ohne E-Mail und Passwort, Sitzung 1 Jahr, Daten nur auf diesem Gerät erreichbar) | **echt** |
| **Scanner:** Live-Kamera mit Kantenerkennung und automatischer Auslösung, Perspektivkorrektur, Aufhellen von Schatten, Kontrast, Filter (Verbessert, Graustufen, Schwarzweiß, Original), Ecken von Hand anpassen, drehen, Seiten sortieren, mehrere Seiten, Import von Fotos/Screenshots/PDFs, Originalfotos auf Wunsch zusätzlich speichern, Scan als PDF | **echt**, läuft komplett auf dem Gerät. Live-Kamera braucht `https` oder `localhost`; sonst öffnet sich die Kamera-App, der Zuschnitt erfolgt danach automatisch |
| Verschlüsselte Ablage der Originale | **echt** (AES-256-GCM) |
| KI liest und erklärt Briefe (Absender, Empfänger, Datum, Nummern, Beträge, Fristen, nächste Schritte) | **echt, sobald ein KI-Schlüssel eingetragen ist** und der Nutzer zustimmt |
| Erkennung ohne KI | **echt, aber einfach:** PDFs mit Textebene werden mit Suchregeln gelesen; Fotos ohne KI nicht |
| **Akten und automatische Zuordnung:** Fahrzeuge, Zähler, Verträge, Ämter … mit Nummern (Kennzeichen, Vertrags-, Kunden-, Zähler-, Rechnungsnummer …); Vergleich trotz Leerzeichen/Bindestrichen; Nummern nur im passenden Absender-Kontext; alte/neue Nummern, Zählerwechsel, Umzug, Nachfolger; Vorgänge (Rechnung, Schaden); Nachweis „warum diese Akte?“ mit Textstelle | **echt** |
| **Zuordnen:** Ist die Akte unsicher („Wir haben zwei mögliche Verträge gefunden. Bitte wählen Sie den richtigen aus.“), entscheidet der Nutzer – BriefPilot merkt sich Nummern für künftige Briefe | **echt** |
| Briefe zusammenführen/trennen, Akten zusammenführen, Verlauf je Brief | **echt** |
| Doppelte Briefe erkennen (gleicher Inhalt oder gleiche Datei) | **echt** – nur Hinweis, nichts wird gelöscht |
| **Fragen an die KI** zum Brief, Übernahme als Antwortentwurf | **echt** mit KI-Schlüssel |
| **Antworten:** Vorlagen (Fristverlängerung, Rückfrage, Ratenzahlung, Unterlagen, Widerspruch/Einspruch, Kündigung, Eingangsbestätigung) oder KI-Entwurf → bearbeiten → PDF (DIN-Brief) / Text kopieren / Entwurf speichern / E-Mail | **echt.** E-Mail direkt aus BriefPilot nur mit eingerichtetem Mailserver und nach ausdrücklicher Bestätigung; sonst im eigenen E-Mail-Programm öffnen |
| Personen und Adressen im Haushalt | **echt** |
| Fristen prüfen und bestätigen, Erinnerungen, Kalenderdatei (.ics) | **echt** (Push nur mit Schlüsseln aus `npm run setup`, E-Mail nur mit Mailserver) |
| Suche (Inhalt, Absender, Datum, Aktenzeichen, Kennzeichen und Nummern der Akten) | **echt** |
| Design: Cloud-Farben, große Bedienelemente, Hell- und Dunkelmodus (automatisch oder fest), Schriftgröße | **echt** |
| Datenexport (ZIP inkl. Akten, Nummern, Antworten, Verlauf) und Kontolöschung | **echt** |
| Demomodus: 13 erfundene Beispielbriefe, Beispiel-Haushalt mit 12 Akten (5 Fahrzeuge, 3 Stromzähler …), 2 Briefe zum Zuordnen | **echt**, Auswertungen als „Beispielauswertung (vorbereitet)“ gekennzeichnet |
| E-Mails abrufen (Postfach-Anbindung, IMAP) | **noch nicht umgesetzt** – Anbieter und Weg sind noch festzulegen |
| Kalender-Abgleich, getrennte Familienprofile, Abo | **nur Vorschau** (Einstellungen → Pro-Vorschau) |

Die App zeigt diese Übersicht auch selbst an: Anmeldeseite → „Was funktioniert echt?“.

**Nicht mit echten Gegenstellen getestet** (in der Entwicklungsumgebung nicht erreichbar): Anfragen an Google Gemini mit einem echten Schlüssel, Push-Zustellung über die Dienste von Google/Apple/Mozilla und Versand über einen echten Mailserver. Alle drei sind programmiert und gegen nachgebaute Gegenstellen getestet.

---

## Auf dem Handy ausprobieren

- Gleiches WLAN: In `.env` `HOST=0.0.0.0` setzen, BriefPilot neu starten und auf dem Handy `http://<IP-Adresse-des-Computers>:3000` öffnen. Scannen funktioniert dann über die Kamera-App des Handys (mit automatischem Zuschnitt).
- **Live-Kamera** mit automatischer Auslösung, „Zum Startbildschirm hinzufügen“ und Push-Benachrichtigungen brauchen eine sichere **https**-Verbindung. Für den Betrieb: Server mit https (siehe `docs/ARCHITEKTUR.md`, „Betrieb“). Nur zum Testen in Chrome auf Android: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` aktivieren und die Adresse `http://<IP>:3000` eintragen.
- Unter Windows fragt die Firewall beim ersten Start mit `HOST=0.0.0.0` eventuell nach – „Private Netzwerke“ erlauben.

## E-Mail einrichten (optional)

In `.env` die Zugangsdaten Ihres E-Mail-Anbieters eintragen (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). Ohne diese Angaben werden E-Mails nicht verschickt, sondern im Server-Fenster angezeigt; Antworten lassen sich dann im eigenen E-Mail-Programm öffnen.

## Daten aus der vorherigen Version

Beim ersten Start mit dieser Version wird die Datenbank automatisch erweitert. Vorher legt BriefPilot eine Sicherungskopie an (`data/briefpilot.sqlite.vor-update-v1-<Datum>.bak`). Briefe, Aufgaben, Erinnerungen und Konten bleiben vollständig erhalten.

---

## Tests

```
npm test
```

68 automatische Tests prüfen unter anderem: Trennung der Nutzerkonten, Upload-Prüfungen, Fristbestätigung, Umgang mit manipulierten KI-Antworten, KI-Anbieter (nachgebaute Gemini-, OpenAI- und Claude-Schnittstellen, Kontingent erschöpft), Zuordnung mit ähnlichen Verträgen (5 Fahrzeuge mit gemeinsamer Kundennummer, 3 Zähler mit Zählerwechsel, alte/neue Vertragsnummer, gleiche Adresse bei zwei Vertragspartnern), korrigierte Nummern, Antwortbriefe und E-Mail nur mit Freigabe, Duplikate, Datenbank-Update ohne Datenverlust, Scanner-Bildverarbeitung, Export und Löschung.

**Browser-Tests (optional, für Entwickler)** in `test/browser/`: Scanner mit simulierter Kamera, alle neuen Ansichten, kompletter Ablauf von der Registrierung bis zur Kontolöschung und eine Stichprobe zur Barrierefreiheit (Namen von Bedienelementen, Farbkontraste hell/dunkel). Sie brauchen Playwright (`npm install --no-save playwright` und `npx playwright install chromium`) sowie für die Testbilder Python mit Pillow und NumPy (`python3 test/browser/make_media.py test/browser/media`). Start z. B. mit `node test/browser/journey.e2e.mjs`.

---

## Wichtig zur Sicherheit

- **`FILE_ENCRYPTION_KEY` sichern!** Geht dieser Schlüssel verloren, sind alle gespeicherten Briefe unlesbar. Bewahren Sie ihn getrennt von Datensicherungen auf.
- Die Datei `.env` niemals weitergeben, hochladen oder in eine Versionsverwaltung legen – sie enthält auch Ihren KI-Schlüssel.
- Der Ordner `data/` enthält alle Nutzerdaten (Datenbank und verschlüsselte Dateien).
- Vor einem öffentlichen Start: `docs/SICHERHEIT-UND-DATENSCHUTZ.md` durcharbeiten. Die App ist **nicht** als „DSGVO-konform“ zu bezeichnen, bevor diese Punkte geprüft sind.

---

## Projektstruktur

```
briefpilot/
├── BriefPilot-starten.cmd  Start unter Windows (Doppelklick)
├── KI-testen.cmd           prüft den KI-Schlüssel (Doppelklick; sonst „npm run ki-test“)
├── package.json            Startbefehle (setup, start, test) – keine externen Pakete
├── .env.example            Vorlage für Einstellungen (ohne echte Zugangsdaten)
├── FORTSCHRITT.md          Arbeitsprotokoll der Überarbeitung
├── scripts/setup.js        erzeugt .env mit neuen Schlüsseln (fragt optional nach dem Gemini-Schlüssel)
├── scripts/ki-test.js      Verbindungstest zum KI-Anbieter
├── server/                 Server (Node.js)
│   ├── index.js, app.js    Start, Sicherheits-Header, Anmeldung, CSRF-Schutz, Routing
│   ├── config.js           Einstellungen, KI-Anbieter und „Was ist echt?“-Übersicht
│   ├── db.js               Datenmodell (SQLite) mit automatischem Update und Sicherungskopie
│   ├── routes/             Schnittstellen: auth, account, letters, tasks, objects (Akten), assistant (Fragen, Antworten)
│   ├── analysis/           KI-Anbieter (providers/: Gemini, OpenAI-kompatibel), Claude, Regel-Erkennung, Prüfung der Ergebnisse
│   ├── domain/             Briefe, Zuordnung (assignment.js), Duplikate, Verlauf, Antwortbriefe, Erinnerungen
│   ├── pdf/                PDF lesen/prüfen, PDF schreiben (Scan als PDF, Antwortbrief nach DIN 5008)
│   ├── lib/                HTTP, Sicherheit, verschlüsselte Ablage, E-Mail (mit Anhängen), Push, ZIP
│   └── demo/               erfundene Beispielbriefe und Beispiel-Haushalt
├── public/                 Oberfläche (PWA)
│   ├── index.html, sw.js, manifest.webmanifest, icons/
│   ├── css/app.css         Cloud-Design, Hell/Dunkel
│   └── js/
│       ├── app.js          Seitenwechsel, Menü, Darstellung
│       ├── views/          je Bildschirm: Übersicht, Briefe, Brief, Zuordnen, Akten, Scannen, Aufgaben, Einstellungen …
│       ├── scanner/        Kamera, Editor, Bildverarbeitung (Kanten, Perspektive, Schatten), Hintergrund-Thread
│       └── shared/         gemeinsame Logik für Server und Oberfläche (Datum, Kennungen, Konstanten)
├── test/                   automatische Tests (npm test); browser/ = optionale Browser-Tests
└── docs/
    ├── ARCHITEKTUR.md      technische Wahl, Datenmodell, Zuordnung, Scanner, Betrieb
    └── SICHERHEIT-UND-DATENSCHUTZ.md   Umgesetztes und offene Prüfpunkte vor dem Start
```
