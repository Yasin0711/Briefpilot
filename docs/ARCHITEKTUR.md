# Architektur von BriefPilot

## Technische Wahl – kurz erklärt

| Entscheidung | Warum |
|---|---|
| **Responsive Web-App als PWA** | Ein Code für Handy, Tablet und Computer. Auf dem Handy installierbar, Live-Kamera (bei https/localhost) oder normaler Foto-Dialog, Push-Benachrichtigungen möglich. Kein App-Store nötig. |
| **Node.js ohne externe Pakete** | Einfache Installation (nur Node.js), keine Abhängigkeiten von Dritten, die regelmäßig Sicherheitsupdates brauchen. Nachteil: Einige Bausteine sind selbst geschrieben (HTTP-Router, SMTP, Web-Push, PDF-Text). Sie sind klein, getestet und in eigenen Dateien gekapselt, sodass sie später durch etablierte Bibliotheken ersetzt werden können (z. B. Fastify/Express, nodemailer, web-push, pdf.js). |
| **SQLite** (in Node.js eingebaut) | Eine Datei, kein Datenbankserver. Für den Start ausreichend. Alle Datenbankzugriffe laufen über `server/db.js`; ein Wechsel zu PostgreSQL ist vorbereitet (Standard-SQL, keine SQLite-Sonderfunktionen außer `ON CONFLICT`). |
| **Austauschbare KI-Anbieter** – Standard: **Google Gemini (kostenloses Kontingent)** | Ein einziger Aufruf liest Fotos und PDFs (auch Scans) und liefert ein festes JSON-Format. `server/analysis/client.js` wählt den Anbieter (`AI_PROVIDER`): `providers/gemini.js` (Gemini-API, `responseJsonSchema`, Ersatzmodell bei erschöpftem Tageskontingent, Rückfall ohne Schema), `providers/openai.js` (OpenAI-kompatibel, z. B. Ollama lokal – Bilder als Daten-URL, PDFs als Text), `claude.js` (Claude-API, `output_config.format`). Gemeinsame Bausteine (Fehlerklassen, Zeitlimits, JSON-Auswertung) in `ai.js`. |
| **Scanner im Browser** (ohne Bibliotheken) | Kantenerkennung, Perspektivkorrektur und Bildverbesserung laufen auf dem Gerät (`public/js/scanner/`), in einem Hintergrund-Thread (Web Worker). Nichts davon verlässt das Gerät vor dem Hochladen. |
| **Oberfläche ohne Framework** (ES-Module, keine Build-Schritte) | Keine Werkzeugkette nötig. Alle Inhalte werden über eine Vorlagenfunktion (`public/js/html.js`) automatisch maskiert – Text aus Briefen kann keinen Code ausführen. |

## Aufbau

```
 Browser (PWA)                         Server (Node.js)                         Außen
┌──────────────────────┐  HTTPS   ┌───────────────────────────────┐
│ views/*.js           │ ───────▶ │ app.js: Header, CSRF, Sitzung │
│ scanner/: Kamera,    │  JSON +  │ routes/: auth, account,       │
│ Kanten, Perspektive, │ Dateien  │   letters, tasks, objects,    │
│ Schatten → JPEG      │          │   assistant                   │
│ (ohne Standortdaten) │          │ domain/: Briefe, Zuordnung,   │
│ sw.js: Offline-Hülle,│ ◀─────── │   Duplikate, Verlauf,         │
│ Push-Anzeige         │          │   Antworten, Erinnerungen     │
└──────────────────────┘          │ analysis/: Warteschlange      │──▶ KI (nur mit Zustimmung):
                                   │   client.js → gemini | openai │     Gemini-API, OpenAI-kompatibel
                                   │   | claude ; rules.js         │     (z. B. Ollama lokal), Claude-API
                                   │   validate.js (Prüfung!)      │
                                   │ lib/storage.js (AES-256-GCM)  │──▶ data/files/<nutzer>/
                                   │ db.js (SQLite)                │──▶ data/briefpilot.sqlite
                                   │ lib/push.js, lib/mail.js      │──▶ Push-Dienste, SMTP
                                   └───────────────────────────────┘
```

### Ablauf eines Briefes

1. **Erfassen** (`views/scan.js`, `scanner/`): Live-Kamera mit Blatterkennung und automatischer Auslösung oder Foto/Screenshot/PDF auswählen. Jede Seite wird zugeschnitten, entzerrt, verbessert und als JPEG neu gespeichert (dabei fallen Standortdaten aus dem Foto weg). Auf Wunsch wird das unbearbeitete Foto zusätzlich hochgeladen (`X-File-Role: original`). PDFs werden unverändert übertragen.
2. **Hochladen** (`POST /api/files`, je Seite): Prüfung von Größe, echtem Dateityp (erste Bytes, nicht Endung), PDF-Seitenzahl, Verschlüsselung und aktiven Inhalten (JavaScript u. Ä. – solche PDFs werden neu geschrieben und entschärft, siehe `server/pdf/sanitize.js`; Antwort enthält dann `sanitized`). Speicherung verschlüsselt. Ist genau diese Datei schon in einem Brief gespeichert, meldet die Antwort `duplicateOf` – die Oberfläche fragt dann nach.
3. **Brief anlegen** (`POST /api/letters`): Seiten in Reihenfolge zuordnen, Auswertung in die Warteschlange.
4. **Auswerten** (`analysis/index.js`): Mit KI-Zustimmung → eingestellter KI-Anbieter (nur die Seiten, keine Originalfotos); ist das kostenlose Kontingent erschöpft → Ersatzmodell, danach ehrlicher Hinweis und Regel-Erkennung; ohne KI Text aus PDFs lesen → Regel-Erkennung; sonst ehrlich „nicht möglich“.
5. **Prüfen** (`analysis/validate.js`) – gilt für KI und Regeln gleichermaßen:
   - Relative Fristen bekommen nie ein Enddatum (auch wenn die KI eines liefert).
   - Jede Textstelle wird im erkannten Brieftext gesucht; nicht gefundene werden markiert.
   - Ein Datum, das nicht zur Textstelle passt, wird verworfen.
   - Briefdatum in der Zukunft oder vor 1990 wird verworfen; fehlendes Datum wird markiert.
   - Text, der wie eine Anweisung an eine KI aussieht, löst eine Warnung aus.
   - Alle Felder werden auf Typ, erlaubte Werte und Länge begrenzt.
   - Nummern (Kennungen) zählen nur, wenn sie wirklich im Brieftext stehen; von der KI erfundene Nummern landen als Prüfhinweis in „Was muss ich noch prüfen?“.
5a. **Zuordnen** (`domain/assignment.js`, Details unten): Person erkennen, Akte bestimmen, Vorgang bündeln, Duplikate prüfen (`domain/duplicates.js`), Verlauf schreiben (`domain/events.js`).
6. **Bestätigen** (`POST /api/tasks/:id/confirm`): Ohne Häkchen „mit dem Original verglichen“ keine Bestätigung. Relative Fristen nur mit Zugangsdatum (nicht in der Zukunft, nicht vor dem Briefdatum).
7. **Erinnern** (`domain/reminders.js`): Erinnerungen entstehen nur für bestätigte, offene Aufgaben. Ein Takt (standardmäßig jede Minute) stellt fällige Erinnerungen zu: immer in der App, zusätzlich per Push/E-Mail, wenn eingerichtet. Jede Zustellung wird mit Ergebnis je Kanal gespeichert.
8. **Wiederfinden** (`GET /api/letters?q=…`): Suche über Absender, Betreff, Volltext, Beträge, Aktenzeichen (auch ohne Trennzeichen) und Datum („12.10.2026“).

## Datenmodell

| Tabelle | Inhalt | Wichtige Felder |
|---|---|---|
| `users` | Nutzerkonten | `email`, `password_hash` (scrypt), `timezone`, `settings` (Erinnerungen, Benachrichtigungen), `ai_consent` (`ja`/`nein`/leer), `is_demo` |
| `sessions` | angemeldete Geräte | `id` = SHA-256 des Sitzungsschlüssels, `device`, `expires_at` |
| `password_resets` | Links zum Zurücksetzen | nur Hash des Tokens, 60 Minuten gültig, einmalig |
| `letters` | Briefe | `letter_date` + `letter_date_status` (`erkannt`/`unsicher`/`fehlt`/`bestaetigt`), `uploaded_at` (getrennt), `received_date` (Zugangsdatum), `category`, `refs_json`, `amounts_json`, `summary_json`, `full_text`, `search_text`, `analysis_status`, `analysis_source` (`ki`/`regeln`/`beispiel`), `user_edited`, `reviewed_at` |
| `files` | Seiten/Dateien | `letter_id` (leer bis zur Zuordnung), `position`, `kind`, `mime`, `sha256` (Doppelte erkennen), `storage_key` |
| `tasks` | Aufgaben, Fristen, Termine, Zahlungen | `status` (`zu_pruefen`/`offen`/`erledigt`), `origin`, `suggested_date` (erkannt) vs. `due_date` (bestätigt), `is_relative`, `relative_rule`, `source_quote`, `source_page`, `quote_found`, `check_notes`, `confirmed_at` |
| `reminders` | Erinnerungen | `remind_at` (UTC), `status` (`geplant`/`gesendet`/`abgebrochen`), `delivery_json`, `seen_at` |
| `push_subscriptions` | Geräte für Push | nur bekannte Push-Dienste erlaubt |
| `ai_usage` | KI-Aufrufe pro Tag | Kostenschutz |
| `security_events` | Anmeldung, Export … | ohne Inhalte, 180 Tage |

| `persons` | Personen im Haushalt | `name`, `relation` (`ich`/`partner`/`kind` …), `aliases` (weitere Schreibweisen) |
| `addresses` | Adressen | `label`, `kind` (Haushalt, Mietobjekt, Ferienwohnung …), `street`, `zip`, `city`, `valid_from`/`valid_to` (Umzug), `is_primary` |
| `objects` | Akten (Fahrzeug, Zähler, Vertrag, Amt …) | `type`, `name`, `provider` + `provider_key` (Vertragspartner, normalisiert), `person_id`, `address_id`, `status` (`aktiv`/`beendet`), `ended_at`, `successor_id` |
| `identifiers` | Nummern einer Akte oder eines Vorgangs | `kind` (25 Arten), `value`, `normalized`, `issuer_key` (Absender-Kontext), `status` (`aktuell`/`alt`), `valid_from`/`valid_to`, `source` (`nutzer`/`brief`) |
| `cases` | Vorgänge in einer Akte | `title`, `kind` (Rechnung, Schaden, Bescheid …), `status` |
| `letter_links` | Brief ↔ Akte | `origin` (`auto`/`nutzer`), `score`, `evidence_json` (Nachweise mit Textstelle), `case_id`; eindeutig je Brief und Akte |
| `replies` | Antwortbriefe | `subject`, `body`, `recipient_json`, `sender_json`, `place`, `reply_date`, `origin` (`vorlage`/`ki`), `status` (`entwurf`/`gesendet`), `sent_via`, `sent_to`, `sent_at` |
| `letter_messages` | Fragen an die KI und Antworten | `role` (`frage`/`antwort`), `content`, `meta_json` (Antwortentwurf) |
| `letter_events` | Verlauf je Brief | `type` (gespeichert, ausgewertet, zugeordnet, korrigiert, Antwort …), `detail_json` |

Neue Felder in `letters`: `assignment_status` (`offen`/`zugeordnet`/`pruefen`/`vorschlag`/`keine`/`ohne`), `assignment_json` (Kandidaten mit Nachweisen und Meldung), `identifiers_json`, `recipient`, `sender_address`, `sender_email`, `person_id`, `duplicate_of`, `duplicate_status` (`verdacht`/`kein_duplikat`). In `files`: `role` (`seite`/`original`).

**Datenbank-Update** (`server/db.js`): Versionen über `PRAGMA user_version`. Vor jedem Update entsteht eine vollständige Sicherungskopie (`VACUUM INTO …vor-update-v<alt>-<Datum>.bak`); bestehende Daten werden nur ergänzt, nie gelöscht (Test: `test/migration.test.js` mit einer Datenbank der ersten Version).

Alle abhängigen Daten hängen per `ON DELETE CASCADE` am Nutzer – eine Kontolöschung entfernt alles in einem Schritt; die Dateien werden mit ihrem Ordner gelöscht.

## Zuordnung zu Akten (`server/domain/assignment.js`)

Ziel: Ein Brief landet nur dann automatisch in einer Akte, wenn das **eindeutig** ist. Sonst entscheidet der Nutzer im Bereich „Zuordnen“.

1. **Nummern im Brief** (`public/js/shared/identifiers.js`): aus der KI-Auswertung (nur wenn im Text vorhanden), aus erkannten Aktenzeichen und per Regeln direkt aus dem Text (mit und ohne Bezeichnung, z. B. Kennzeichen „SB-AB 123“, FIN, IBAN, Messlokation). Vergleich nach Normalisierung (ohne Leer- und Trennzeichen); Kennzeichen zusätzlich nach Gliederung („SB-AB 123“ ≠ „SBA-B 123“); „ähnlich“ = ein Zeichen Unterschied oder typische Lesefehler (O↔0) – zählt nie automatisch.
2. **Kontext:** Jede Art hat einen Geltungsbereich. Weltweit eindeutige Nummern (Kennzeichen, FIN, Zählernummer, MaLo-ID) zählen immer; Kunden-, Vertrags- oder Rechnungsnummern nur, wenn der Absender zum Vertragspartner der Akte passt (gleiche Nummer bei einer anderen Firma = kein Treffer).
3. **Gewichtung:** Grundgewicht je Art (z. B. Kennzeichen 100, Kundennummer 85); geteilt durch die Zahl der Akten, die dieselbe Nummer im selben Kontext tragen (eine Kundennummer für 5 Fahrzeuge unterscheidet nicht); frühere Nummern zählen etwas weniger; der Absender allein ist nur ein schwacher Hinweis.
4. **Entscheidung:** Genau eine Akte mit unterscheidender, exakter Nummer → zugeordnet. Mehrere gleich starke Kandidaten, nur ähnliche Nummern oder nur der Absender → „Zuordnen“ mit verständlicher Meldung („Wir haben zwei mögliche Verträge gefunden. Bitte wählen Sie den richtigen aus.“) und vorausgewählten Kandidaten, wo sinnvoll.
5. **Nachweise:** Jede Zuordnung speichert, welche Nummer wo im Brief stand (Textstelle, Seite) – in der App unter „Warum diese Akte?“.
6. **Lernen:** Wählt der Nutzer eine Akte, kann er neue Nummern aus dem Brief übernehmen (z. B. neue Vertragsnummer nach Verlängerung, neuer Zähler); danach werden offene Briefe automatisch neu geprüft. Entscheidungen des Nutzers werden nie automatisch überschrieben. Korrigiert der Nutzer die Nummern eines Briefes, gilt nur noch seine Liste.
7. **Vorgänge:** Nummern wie Rechnungs-, Schaden- oder Aktenzeichen bündeln Briefe innerhalb einer Akte (z. B. Rechnung → Mahnung).

Tests mit ähnlichen Verträgen: `test/assignment.test.js` (u. a. 5 Fahrzeuge mit gemeinsamer Kundennummer, 3 Zähler mit Zählerwechsel, alte/neue Vertragsnummer, gleiche Adresse bei zwei Vertragspartnern, gleiche Nummer bei anderer Firma).

## Scanner (`public/js/scanner/`)

| Datei | Aufgabe |
|---|---|
| `imageproc.js` | reine Bildverarbeitung ohne Browser-Abhängigkeit (auch im Server-Test nutzbar): Blattkanten über helle Fläche (Otsu-Schwelle, größte zusammenhängende Fläche, konvexe Hülle) und Hough-Linien, Bewertung über Kantenstärke gegenüber dem Untergrund, Homographie und Entzerrung, Hintergrund-Ausgleich gegen Schatten (Farbe, Graustufen, Schwarzweiß), Fingerabdruck |
| `worker.js`, `processing.js` | Rechenarbeit im Hintergrund-Thread (Rückfall im Hauptthread), Laden mit EXIF-Ausrichtung, Erzeugen der fertigen Seite (≤ 2000 px, JPEG) |
| `camera.js` | Live-Kamera: Erkennung ca. 4× pro Sekunde, Rahmen, automatische Auslösung nach ruhigem Bild, Licht, volle Auflösung über `ImageCapture`, erneutes Scharfschalten erst bei neuer Seite |
| `editor.js` | Ecken ziehen (mit Lupe, auch per Tastatur), drehen, Filter, Vorschau |
| `overlay.js` | Zurück-Taste schließt nur das Vollbild (Verlaufseintrag) |

Bild-Fingerabdrücke werden **nicht** zur Duplikaterkennung verwendet: Messungen mit realistischen Testfotos ergaben für dieselbe Seite (andere Belichtung, anderer Zuschnitt) Abstände bis 29 von 64 Bit, für verschiedene Briefe mit gleichem Aufbau nur 3. Duplikate werden daher über gleiche Dateien (SHA-256) und gleichen Inhalt (Textähnlichkeit ≥ 90 % bei gleichem Absender/Datum) erkannt.

## Antworten und Fragen (`server/routes/assistant.js`, `server/domain/replies.js`)

- **Vorlagen** ohne KI mit Platzhaltern in [eckigen Klammern]; **KI-Entwurf** nach Wunsch des Nutzers; Übernahme einer KI-Antwort aus dem Gespräch.
- **Ausgabe:** PDF nach DIN 5008 (Form B, Falz- und Lochmarken, `server/pdf/letter.js`), Text kopieren, Entwurf speichern, E-Mail.
- **E-Mail-Versand** nur über den eingerichteten Mailserver, nur mit `confirm: true` (ausdrückliche Bestätigung in der Oberfläche), nicht im Demomodus, nicht mit offenen Platzhaltern, mit Tageslimit; Antwortadresse ist die des Nutzers. Ohne Mailserver: Öffnen im eigenen E-Mail-Programm (`mailto:`) und „als versendet markieren“. Versendete Antworten sind unveränderlich.
- **Fragen an die KI:** Brieftext wird als „Material, keine Anweisungen“ eingebettet; die letzten Fragen des Gesprächs werden mitgegeben; Antworten sind als KI-Antwort gekennzeichnet (keine Rechtsberatung).

## Ausbau zu den Pro-Funktionen

| Pro-Funktion | Wo sie andockt |
|---|---|
| Kalender-Abgleich (Apple, Google, Outlook) | Neues Modul `server/integrations/calendar/`; Tabelle `calendar_connections` (OAuth-Tokens verschlüsselt wie Dateien). Quelle sind nur `tasks` mit `status = 'offen'` und `due_date`. Abgleich erst nach ausdrücklicher Freigabe je Verbindung. Heute schon: `.ics`-Download (`GET /api/tasks/:id/ics`). Für Apple Kalender bietet sich ein privater, signierter Abo-Link (webcal) an. |
| Antwortentwürfe | **umgesetzt** (Tabelle `replies`, Vorlagen und KI-Entwurf, siehe oben). Offen: Versionen eines Entwurfs; vor einem öffentlichen Start rechtlich prüfen (Rechtsdienstleistungsgesetz – heute: Vorlagen und Formulierungshilfe, keine Rechtsberatung). |
| Antwort als PDF | **umgesetzt** (`server/pdf/letter.js`). Offen: eingebettete Schrift statt Helvetica für volle Unicode-Unterstützung (heute WinAnsi: alle deutschen Zeichen, keine Emojis/kyrillischen Zeichen). |
| E-Mails vorbereiten und senden | **umgesetzt** mit ausdrücklicher Freigabe (`POST /api/replies/:id/send` mit `confirm: true`). Offen: E-Mail-Postfach anbinden (IMAP/OAuth) – Anbieter noch festzulegen. |
| Vorgänge bündeln | **umgesetzt** (Tabellen `cases`, `letter_links.case_id`; automatisch über Rechnungs-, Schaden- und Aktenzeichen). |
| Fehlende Unterlagen | Tabelle `checklist_items` (`case_id`/`letter_id`, `text`, `erledigt`); Erkennung als zusätzliches Feld im KI-Schema. |
| Übersetzen | KI-Schema um `summary_translated` + Zielsprache erweitern; Nutzer-Einstellung `language`. Das Feld `language` (Sprache des Briefes) wird bereits erkannt. |
| Familienprofile | Tabellen `profiles` und `profile_members` (Rolle, Freigaben); `letters.profile_id`. Alle Abfragen, die heute `user_id` prüfen, prüfen dann die Mitgliedschaft – die Prüfung ist an wenigen Stellen gebündelt (`ownLetter`, `ownTask`). |
| Abo | Tabelle `subscriptions` (Anbieter-Kunden-ID, Status, Laufzeit); Zahlungsanbieter mit Webhook. Freischaltung über eine zentrale Funktion `hasPro(user)`. |

## Betrieb (später)

- **https ist Pflicht** (auch für die Live-Kamera). Empfehlung für den Anfang: ein EU-Server mit Caddy als Reverse-Proxy (automatische Zertifikate). In `.env`: `NODE_ENV=production`, `BASE_URL=https://…`, `TRUST_PROXY=1`, `DEMO_ENABLED=false`.
- **KI im öffentlichen Betrieb:** Für Nutzer in der EU verlangt Google den kostenpflichtigen Gemini-Zugang (`GEMINI_PAID=true`, Rechnungskonto im Google-Projekt) – siehe `docs/SICHERHEIT-UND-DATENSCHUTZ.md`.
- **Datensicherung** von `data/` (Datenbank + Dateien) täglich, verschlüsselt; Schlüssel `FILE_ENCRYPTION_KEY` getrennt aufbewahren; Wiederherstellung testen.
- **Wachstum:** SQLite → PostgreSQL; Dateien → S3-kompatibler Speicher in der EU; Warteschlange im Arbeitsspeicher → Job-Queue mit eigenem Worker-Prozess; Anfragebegrenzung im Arbeitsspeicher → Redis (nötig, sobald mehr als ein Server läuft).
- **PDF-Verarbeitung** für fremde Dateien in einen eigenen Worker-Thread mit Zeitlimit auslagern.
