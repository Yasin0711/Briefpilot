# BriefPilot – Fortschritt der Überarbeitung

Laufendes Arbeitsprotokoll. Wird nach jedem abgeschlossenen Schritt aktualisiert, damit die Arbeit nach einer Pause (z. B. wenn das Nutzungskontingent endet) **ohne Neuanfang** fortgesetzt werden kann.

**Zuletzt aktualisiert:** 28.10.2026, 00:15 Uhr · **Stand:** Überarbeitung abgeschlossen, Abschlussprüfung im App-Ordner bestanden · **Automatische Tests:** 68 von 68 bestanden (`npm test`, im Arbeitsbereich und im App-Ordner) · **Browser-Tests:** Scanner 9/9, Ansichten 11/11, Gesamtablauf 13/13, Barrierefreiheit 0 Verstöße (2705 Textelemente) · **Starttest im App-Ordner:** 21/21

---

## 1. Auftrag (vom Nutzer)

- Die Verbesserungsliste („BriefPilot – To-do- und Informationsliste“) in der **bestehenden** App umsetzen – nichts neu schreiben, keine Funktionen, Daten oder Dateien entfernen.
- Briefe sollen von einer KI ausgelesen werden – **kostenlos (0 $)**. Zum Testen reichen normale API-Schlüssel für den privaten Gebrauch.
- Vorrang: die App zum Laufen bringen. Durchgehend testen; am Ende alle Funktionen prüfen und für Fehler einen neuen Lösungsweg planen.
- Rückfragen an den Nutzer nur bei Richtungsentscheidungen.

## 2. Wo liegt was

| Was | Ort |
|---|---|
| App-Ordner des Nutzers | `C:\Users\Home\Downloads\briefpilot` (in der Claude-App als Ordner verbunden) |
| Sicherung der Originaldateien | `C:\Users\Home\Downloads\briefpilot\_sicherung-original-2026-10-27\` (unverändert, 61 Dateien) |
| Arbeitskopie während der Sitzung | Cloud-Arbeitsbereich `/home/claude/briefpilot` (mit git-Verlauf); Original zum Vergleich: `/home/claude/original/briefpilot` |
| Dieses Protokoll | `FORTSCHRITT.md` im App-Ordner und im Claude-Projekt „Briefpilot“ (`claude/FORTSCHRITT.md`) |

**Fortsetzen nach einer Pause:** App-Ordner einlesen (alle Dateien sind dort auf dem neuesten getesteten Stand), `npm test` ausführen, dann bei „5. Als Nächstes“ weitermachen.

## 3. Getroffene Entscheidungen

| Thema | Entscheidung | Grund |
|---|---|---|
| Kostenlose KI | **Google Gemini, kostenloses Kontingent** (`GEMINI_API_KEY` von aistudio.google.com, keine Kreditkarte). Modell `gemini-3.8-flash`, automatisch Ersatzmodell `gemini-3.5-flash-lite`, wenn das Gratis-Kontingent erschöpft ist. | Liest Fotos und PDFs (auch Scans) direkt; laut Google-Bedingungen gelten für Nutzer in der EU auch im Gratis-Kontingent die Datenregeln des bezahlten Dienstes (keine Produktverbesserung mit den Daten). Ohne Rechnungskonto bei Google entstehen keine Kosten. |
| Weitere KI-Anbieter | OpenAI-kompatible Schnittstelle (Ollama/LM Studio lokal = 100 % kostenlos und offline; Groq, OpenRouter, Mistral) – Claude bleibt wählbar | Wahlfreiheit, kein Anbieter-Zwang |
| Kontingent erschöpft | ehrliche Meldung + Rückfall auf einfache Erkennung (PDFs mit Text) | App bleibt benutzbar |
| Ansprache | durchgehend „Sie“ (wie die bestehende App) – Meldung daher „Bitte wählen Sie den richtigen aus.“ | Einheitlichkeit; Nutzer wurde informiert |
| Antwort per E-Mail | über eingerichteten Mailserver (SMTP, eigenes Postfach) nur nach ausdrücklicher Freigabe; ohne Mailserver: im eigenen E-Mail-Programm öffnen + „als gesendet markieren“ | kein Versand ohne Freigabe |
| E-Mail-Import (IMAP) | **noch nicht umgesetzt** (in der Liste als „festzulegen“ markiert) | offene Richtungsentscheidung |
| Farbpalette | Cloud-Blau, Weiß, Aktionsblau, Post-Gelb, dunkles Blau für Text | Vorschlag aus der Liste |

## 4. Erledigt (jeweils mit automatischen Tests)

1. **Analyse** der bestehenden App (Server Node.js ohne Pakete, SQLite, PWA-Oberfläche). Ausgangslage: 28 von 28 Tests grün.
2. **Datenmodell Version 2** (`server/db.js`): neue Tabellen `persons`, `addresses`, `objects` (Objektakten), `cases` (Vorgänge), `identifiers` (Kennungen mit Status alt/aktuell und Gültigkeit), `letter_links` (Brief ↔ Akte mit Nachweis), `replies`, `letter_messages`, `letter_events`; neue Spalten in `letters` und `files`. Vor dem Update wird automatisch eine Sicherungskopie der Datenbank angelegt. Test: Update einer Datenbank der ersten Version erhält alle Daten (`test/migration.test.js`).
3. **Kennungen** (`public/js/shared/identifiers.js`): 25 Arten (Kennzeichen, FIN, Versicherungsschein, Vertrags-, Kunden-, Zählernummer, MaLo/MeLo, IBAN, Adresse, Rechnungs-, Schadennummer …), Vergleich trotz Leer-/Bindestrichen, Kennzeichen-Gliederung („SB-AB 123“ ≠ „SBA-B 123“), ähnliche Nummern (ein Zeichen/Lesefehler O↔0), Erkennung im Text mit und ohne Bezeichnung, alt/neu.
4. **Zuordnungslogik** (`server/domain/assignment.js`): eindeutige Nummern entscheiden, Absender allein nie; Nummern im Kontext des Absenders; gemeinsam genutzte Nummern (z. B. Kundennummer für 5 Fahrzeuge) unterscheiden nicht; nur genau ein klarer Treffer → automatisch; sonst Eingang „Zur Prüfung“ mit Meldung „Wir haben zwei mögliche Verträge gefunden …“; Nachweis (Textstelle) je Zuordnung; Vorgänge (Rechnung, Schaden) werden gebündelt; Nutzerentscheidungen bleiben; Nummern lernen. Tests: `test/assignment.test.js` (13 Szenarien: 5 Fahrzeuge, 3 Zähler mit Zählerwechsel, alte/neue Vertragsnummer, gleiche Adresse bei zwei Vertragspartnern …).
5. **Duplikate** (`server/domain/duplicates.js`): gleicher Inhalt trotz neuem Scan (Textähnlichkeit) bzw. bytegleiche Dateien; nur Verdacht, nichts wird gelöscht. Beim Hochladen derselben Datei fragt die App nach („Ist dieser Brief schon gespeichert?“). *Bild-Fingerabdrücke werden nicht mehr verglichen:* Messung mit realistischen Testfotos ergab für dieselbe Seite Abstände bis 29 von 64 Bit, für verschiedene Briefe mit gleichem Aufbau nur 3 – also falsche Warnungen und verpasste Duplikate.
6. **Verlauf** je Brief (`server/domain/events.js`): gespeichert, ausgewertet, korrigiert, zugeordnet, Entwurf, versendet, zusammengeführt, getrennt.
7. **KI-Anbieter** (`server/analysis/providers/gemini.js`, `openai.js`, `claude.js`, `client.js`, `ai.js`): Gemini mit Ersatzmodell, Wartezeit bei Minutenlimit, Rückfall ohne JSON-Schema, gesperrte Antworten; OpenAI-kompatibel (Bilder als Daten, PDF als Text); Claude unverändert. KI-Antwort wird geprüft – erfundene Nummern zählen nicht. Tests: `test/ai-providers.test.js`.
8. **Auswertung** (`server/analysis/index.js`): nach jeder Auswertung Person erkennen, Akte zuordnen, Duplikate prüfen, Verlauf schreiben; Originalaufnahmen werden nicht an die KI geschickt.
9. **Prompts** erweitert (`server/analysis/prompt.js`): typisierte Kennungen, Empfänger, Absenderanschrift/-E-Mail; Prompts für Rückfragen und Antwortbriefe.
10. **Antwortbriefe**: Vorlagen ohne KI (`server/domain/replies.js`: Fristverlängerung, Rückfrage, Ratenzahlung, Unterlagen, Widerspruch/Einspruch, Kündigung, Eingangsbestätigung), PDF nach DIN 5008 mit Falzmarken (`server/pdf/letter.js`), E-Mail mit PDF-Anhang (`server/lib/mail.js`).
11. **Neue Schnittstellen**: `server/routes/objects.js` (Akten, Kennungen, Vorgänge, Personen, Adressen, Eingang, Zuordnung), `server/routes/assistant.js` (Rückfragen, Antwortbriefe), Erweiterungen in `server/routes/letters.js` (Upload mit Bild-Fingerabdruck und Originalaufnahmen, Filter nach Akte/Eingang/Duplikat, Suche über Akten-Nummern, Scan als PDF, Zusammenführen, Trennen) und `server/routes/account.js` (Export enthält alle neuen Daten). Tests: `test/features.test.js`.
12. **PDF**: JPEG-Seiten einbetten, Scan als PDF (`server/pdf/write.js`).
13. **Einstellungen** (`server/config.js`): Anbieterwahl (`AI_PROVIDER`), Gemini/OpenAI-kompatibel/Claude; Übersicht „Was funktioniert echt?“ ergänzt.
14. **Demo** (`server/demo/letters.js`, `seed.js`): Haushalt mit 12 Akten (5 Fahrzeuge, Hausrat, Haftpflicht, 3 Stromzähler, Steuer, Wohnung), 2 Personen, 3 Adressen; 5 neue Beispielbriefe (automatisch zugeordnet bzw. 2 im Prüf-Eingang).
15. **Scanner-Bildverarbeitung** (`public/js/scanner/imageproc.js`): Blattkanten (helle Fläche + Hough-Linien, Abgleich mit Untergrund), Perspektivkorrektur, Schatten/Beleuchtung ausgleichen (Farbe, Grau, Schwarzweiß), Fingerabdruck (nur noch für die Kamera: „neue Seite im Bild?“). Tests mit künstlichen Fotos (dunkler/farbiger/heller Untergrund, Rauschen): `test/scanner.test.js`.
16. **Scanner-Oberfläche** (`public/js/views/scan.js`, `public/js/scanner/camera.js`, `editor.js`, `processing.js`, `worker.js`, `overlay.js`): Live-Kamera im Vollbild mit Kanten-Rahmen, automatischer Auslösung (Ring zeigt den Fortschritt), Licht, mehreren Seiten am Stück; Zurück-Taste schließt nur die Kamera. Rückfall: Kamera-App (danach automatischer Zuschnitt; bei unsicherem Zuschnitt öffnet sich der Editor). Import von Fotos/Screenshots/PDFs. Editor: Ecken ziehen (Lupe, Pfeiltasten), drehen, Filter (Verbessert, Graustufen, Schwarzweiß, Original). Seitenliste: bearbeiten, drehen, sortieren, entfernen; Originalfotos auf Wunsch zusätzlich speichern; Warnung beim Schließen des Tabs mit ungespeicherten Seiten. Rechenarbeit im Hintergrund-Thread.
17. **Cloud-Design** (`public/css/app.css`): Cloud-Blau `#EAF3FF`, Weiß, Aktionsblau `#1463D9`, Post-Gelb `#FFCC00`, Navy `#10233A`; Kontraste geprüft (Text 15,9:1, Aktionsblau auf Weiß 5,5:1); Dunkelmodus automatisch oder fest (Einstellungen → Anzeige → Darstellung); neue App-Symbole; Dialog-Schaltflächen auf dem Handy untereinander.
18. **Browser-Test Scanner** (Playwright, Chromium mit simulierter Kamera): Import + Zuschnitt, Editor, Drehen, Sortieren, Live-Kamera mit automatischer Aufnahme, Zurück-Taste, Speichern mit Originalfotos, Rückfrage bei doppelter Datei – alle Schritte bestanden, keine Fehler in der Browser-Konsole.
19. **Neue Ansichten** (`public/js/views/`):
    - `inbox.js` – „Zuordnen“ (`#/zuordnen`): Briefe mit unsicherer Akte; Meldung wie „Wir haben zwei mögliche Verträge gefunden. Bitte wählen Sie den richtigen aus.“
    - `assign.js` – Auswahl-Baustein (Eingang und Brief): Kandidaten mit Nachweisen, mehrere Akten möglich, „andere Akte“, Nummern merken, neue Akte aus dem Brief, „gehört zu keiner Akte“.
    - `objects.js` + `objectDialog.js` – Akten (`#/akten`, `#/akten/:id`): Liste nach Art, Suche nach Kennzeichen/Nummern, Nummern alt/aktuell mit Gültigkeit, Vorgänge, Briefe mit „warum zugeordnet“, Aufgaben; bearbeiten, beenden mit Nachfolger, zusammenführen, löschen (Briefe bleiben).
    - `replies.js` – Antworten (Vorlagen, KI-Entwurf, bearbeiten, PDF, Text kopieren, E-Mail nur nach ausdrücklicher Freigabe bzw. im eigenen E-Mail-Programm, „als versendet markieren“) und Fragen an die KI (Vorschläge, Übernahme als Antwortentwurf).
    - `parts.js` – gemeinsame Bausteine (Briefzeile mit Akten, Nachweise in Worten, Umschalter Briefe/Zuordnen/Akten).
    - `letter.js` erweitert: Akte mit „Warum diese Akte?“, Duplikat-Hinweis, Reiter „Antwort“, Verlauf, Seiten trennen/anhängen, Scan als PDF, Originalfotos, Angaben-Korrektur mit Nummern/Person/Absender-Kontakt.
    - Übersicht (Hinweis auf wartende Entscheidungen, Kennzahl Akten), Briefliste (Filter „Akte wählen“, „Ohne Akte“, „Doppelt?“, Akte als Filter), Einstellungen (Haushalt: Personen und Adressen), Pro-Vorschau (verfügbare Funktionen markiert), Menü-Zähler für „Zuordnen“, Service Worker v3.
20. **Korrigierte Nummern gelten** (`server/routes/letters.js`, `server/domain/assignment.js`, `server/domain/letters.js`): Ändert der Nutzer die Nummern eines Briefes, verwenden Anzeige und Zuordnung nur noch seine Liste – auch nach erneuter Auswertung. Test in `test/features.test.js`; Bezeichnungen ↔ Arten in `test/assignment.test.js`.
21. **Browser-Tests im App-Ordner** (`test/browser/`, optional, braucht Playwright): `scanner.e2e.mjs`, `views.e2e.mjs` (mit nachgebauter Gemini-Schnittstelle `mock-gemini.mjs`), `journey.e2e.mjs` (Registrierung → Haushalt → Akte → KI-Scan → automatische Zuordnung → Zahlung bestätigen, Kalenderdatei, erledigt/wieder öffnen → Seiten trennen und anhängen → Export → Ab-/Anmelden → Passwort ändern → Tastaturbedienung „Zuordnen“ → Konto löschen), `a11y.e2e.mjs` (Namen aller Bedienelemente, Alternativtexte, Farbkontraste WCAG AA; hell/dunkel, Handy/Computer). Testbilder per `make_media.py`. Bildschirmfotos in `test/browser/shots/` (nicht im Repository).
22. **Doku und Start** (`README.md`, `.env.example`, `docs/ARCHITEKTUR.md`, `docs/SICHERHEIT-UND-DATENSCHUTZ.md`, Datenschutzseite in der App): Schnellstart Windows, Gemini kostenlos Schritt für Schritt (Bedingungen geprüft: 18+, EU-Datenregeln auch im Gratis-Kontingent, für öffentlichen Start in der EU kostenpflichtiger Zugang nötig – Quelle ai.google.dev/gemini-api/terms, Stand 28.04.2026; Modelle `gemini-3.8-flash`/`gemini-3.5-flash-lite` laut Google stabil mit kostenlosem Kontingent).
23. **Windows-Dateien:** `BriefPilot-starten.cmd` (prüft Node.js-Version, richtet beim ersten Mal ein – fragt nach dem Gemini-Schlüssel –, startet und öffnet den Browser), `KI-testen.cmd` bzw. `npm run ki-test` (Verbindungstest ohne Briefdaten; geprüft mit nachgebauter Gegenstelle: Erfolg, ungültiger Schlüssel, keine Verbindung, keine KI – mit passendem Tipp je Fehlerart).
24. **Abschlussprüfung im App-Ordner** (28.10.2026):
    - Alle 102 Dateien im App-Ordner inhaltlich gleich mit dem geprüften Arbeitsstand (Prüfsummen verglichen). Ausnahme ohne Wirkung: Die 6 App-Symbole haben bei der Übertragung zusätzlich Herkunfts-Metadaten (C2PA) erhalten; die Bilddaten selbst sind identisch, Browser ignorieren diese Angaben.
    - `npm test` direkt im App-Ordner: 67 von 67 bestanden.
    - Starttest aus dem App-Ordner (eigene Testdatenbank außerhalb des Ordners, danach gelöscht): Server startet, Startseite/Skripte/Stile/Service Worker/Manifest/Symbole werden ausgeliefert, Demo-Anmeldung, Übersicht, Briefliste (13 Demobriefe), Akten (12), Zuordnen-Eingang (2), Briefansicht, Brief als PDF, Aufgaben, Antwortvorlagen (8), Akte anlegen – 21 von 21 bestanden. Im App-Ordner wurden dabei keine Dateien angelegt.
    - Google Gemini ist aus der Testumgebung nicht erreichbar (Netzsperre); `ki-test` meldet das verständlich („Die KI ist gerade nicht erreichbar …“).
25. **Ohne Konto fortfahren** (28.10.2026): Knopf auf der Anmeldeseite legt ein eigenes Gastkonto an (`POST /api/auth/guest`, interne Adresse `gast-…@gast.invalid`, kein Passwort). Sitzung 365 Tage, verlängert sich bei Nutzung. Gäste sehen keine fremden Daten, haben kein Passwort, können ihr Konto ohne Passwort löschen; Einstellungen zeigen einen Hinweis, dass die Daten nur auf diesem Gerät erreichbar sind. KI-Zustimmung wird wie bisher beim ersten Scan abgefragt. Service Worker v4. Test: `test/guest.test.js` – 68 von 68 bestanden. Sicherung vorher: `_sicherung-vor-gastzugang-2026-10-28/` (in `.gitignore`).

## 5. Als Nächstes

1. ~~**Übergabe**: Dateien in den App-Ordner schreiben, Abschlussbericht an den Nutzer.~~ Erledigt (28.10.2026).
2. **Beim Nutzer** (kann nur er): `BriefPilot-starten.cmd` doppelklicken, Gemini-Schlüssel eintragen, `KI-testen.cmd` → echte KI-Auswertung eines Briefes prüfen; auf dem Handy testen.
3. **Offene Richtungsentscheidung:** E-Mail-Postfach anbinden (IMAP oder Anbieter-Login per OAuth, welcher Anbieter?).
4. **Falls beim echten KI-Test etwas hakt** (Plan B): Fehlermeldung von `KI-testen.cmd` ansehen – Schlüssel → neu kopieren; Modell → `GEMINI_MODEL` leer lassen oder anderes Modell aus Google AI Studio; Region/Kontingent → zweiten Anbieter eintragen (`AI_PROVIDER=ollama` mit `OPENAI_COMPAT_BASE_URL`/`OPENAI_COMPAT_MODEL`: Ollama lokal, kostenlos und offline, oder Groq/OpenRouter-Gratisstufe). Die App bleibt in jedem Fall ohne KI benutzbar (PDFs mit Text, Vorlagen).

## 6. Offene Punkte / Risiken

- Echte Anfrage an Gemini mit echtem Schlüssel konnte in der Arbeitsumgebung nicht getestet werden (keine Netzverbindung zu Google) – gegen eine nachgebaute Schnittstelle getestet.
- E-Mail-Import (IMAP) und Antwort-Synchronisierung: noch nicht umgesetzt (Richtungsentscheidung offen).
- Live-Kamera braucht https oder localhost; im WLAN über http öffnet sich die normale Kamera-App (danach trotzdem Kantenerkennung).
