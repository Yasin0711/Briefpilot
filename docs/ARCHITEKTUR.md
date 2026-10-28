# Architektur von BriefPilot

## Technische Wahl – kurz erklärt

| Entscheidung | Warum |
|---|---|
| **Responsive Web-App als PWA** | Ein Code für Handy, Tablet und Computer. Auf dem Handy installierbar, Kamera über den normalen Foto-Dialog, Push-Benachrichtigungen möglich. Kein App-Store nötig. |
| **Node.js ohne externe Pakete** | Einfache Installation (nur Node.js), keine Abhängigkeiten von Dritten, die regelmäßig Sicherheitsupdates brauchen. Nachteil: Einige Bausteine sind selbst geschrieben (HTTP-Router, SMTP, Web-Push, PDF-Text). Sie sind klein, getestet und in eigenen Dateien gekapselt, sodass sie später durch etablierte Bibliotheken ersetzt werden können (z. B. Fastify/Express, nodemailer, web-push, pdf.js). |
| **SQLite** (in Node.js eingebaut) | Eine Datei, kein Datenbankserver. Für den Start ausreichend. Alle Datenbankzugriffe laufen über `server/db.js`; ein Wechsel zu PostgreSQL ist vorbereitet (Standard-SQL, keine SQLite-Sonderfunktionen außer `ON CONFLICT`). |
| **Claude-API (Anthropic) für Texterkennung und Erklärung** | Ein einziger Aufruf liest Fotos und PDFs (auch Scans) und liefert ein festes JSON-Format (`output_config.format`). Die Anbindung liegt allein in `server/analysis/claude.js`; ein anderer Anbieter (oder Claude über eine EU-Cloud-Region) kann dort eingesetzt werden. |
| **Oberfläche ohne Framework** (ES-Module, keine Build-Schritte) | Keine Werkzeugkette nötig. Alle Inhalte werden über eine Vorlagenfunktion (`public/js/html.js`) automatisch maskiert – Text aus Briefen kann keinen Code ausführen. |

## Aufbau

```
 Browser (PWA)                         Server (Node.js)                         Außen
┌──────────────────────┐  HTTPS   ┌───────────────────────────────┐
│ views/*.js           │ ───────▶ │ app.js: Header, CSRF, Sitzung │
│ Kamera → JPEG (EXIF  │  JSON +  │ routes/: auth, account,       │
│ entfernt, verkleinert)│ Dateien │         letters, tasks         │
│ sw.js: Offline-Hülle,│          │ domain/: Briefe, Erinnerungen │
│ Push-Anzeige         │ ◀─────── │ analysis/: Warteschlange      │──▶ Claude-API (nur mit
└──────────────────────┘          │   claude.js | rules.js        │     Zustimmung)
                                   │   validate.js (Prüfung!)      │
                                   │ lib/storage.js (AES-256-GCM)  │──▶ data/files/<nutzer>/
                                   │ db.js (SQLite)                │──▶ data/briefpilot.sqlite
                                   │ lib/push.js, lib/mail.js      │──▶ Push-Dienste, SMTP
                                   └───────────────────────────────┘
```

### Ablauf eines Briefes

1. **Erfassen** (`views/scan.js`): Jede Seite wird im Browser verkleinert und als JPEG neu gespeichert (dabei fallen Standortdaten aus dem Foto weg). PDFs werden unverändert übertragen.
2. **Hochladen** (`POST /api/files`, je Seite): Prüfung von Größe, echtem Dateityp (erste Bytes, nicht Endung), PDF-Seitenzahl, Verschlüsselung und aktiven Inhalten (JavaScript). Speicherung verschlüsselt.
3. **Brief anlegen** (`POST /api/letters`): Seiten in Reihenfolge zuordnen, Auswertung in die Warteschlange.
4. **Auswerten** (`analysis/index.js`): Mit KI-Zustimmung → Claude; sonst Text aus PDFs lesen → Regel-Erkennung; sonst ehrlich „nicht möglich“.
5. **Prüfen** (`analysis/validate.js`) – gilt für KI und Regeln gleichermaßen:
   - Relative Fristen bekommen nie ein Enddatum (auch wenn die KI eines liefert).
   - Jede Textstelle wird im erkannten Brieftext gesucht; nicht gefundene werden markiert.
   - Ein Datum, das nicht zur Textstelle passt, wird verworfen.
   - Briefdatum in der Zukunft oder vor 1990 wird verworfen; fehlendes Datum wird markiert.
   - Text, der wie eine Anweisung an eine KI aussieht, löst eine Warnung aus.
   - Alle Felder werden auf Typ, erlaubte Werte und Länge begrenzt.
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

Alle abhängigen Daten hängen per `ON DELETE CASCADE` am Nutzer – eine Kontolöschung entfernt alles in einem Schritt; die Dateien werden mit ihrem Ordner gelöscht.

## Ausbau zu den Pro-Funktionen

| Pro-Funktion | Wo sie andockt |
|---|---|
| Kalender-Abgleich (Apple, Google, Outlook) | Neues Modul `server/integrations/calendar/`; Tabelle `calendar_connections` (OAuth-Tokens verschlüsselt wie Dateien). Quelle sind nur `tasks` mit `status = 'offen'` und `due_date`. Abgleich erst nach ausdrücklicher Freigabe je Verbindung. Heute schon: `.ics`-Download (`GET /api/tasks/:id/ics`). Für Apple Kalender bietet sich ein privater, signierter Abo-Link (webcal) an. |
| Antwortentwürfe | Tabelle `replies` (`letter_id`, `body`, `status`, Versionen). Ein zweiter KI-Aufruf in `analysis/`, der nur bestätigte Angaben und Nutzereingaben verwendet. Vorher rechtlich prüfen (Rechtsdienstleistungsgesetz). |
| Antwort als PDF | `server/pdf/write.js` erweitern (eingebettete Schrift statt Helvetica für volle Unicode-Unterstützung). |
| E-Mails vorbereiten und senden | `lib/mail.js` ist vorhanden. Neue Tabelle `outgoing_messages` mit Status `entwurf` → `freigegeben` → `gesendet`; Versand ausschließlich über einen eigenen Freigabe-Endpunkt mit erneuter Bestätigung. |
| Vorgänge bündeln | Tabelle `cases` und Feld `letters.case_id`; KI kann Zuordnungen vorschlagen (Aktenzeichen-Abgleich), Nutzer bestätigt. |
| Fehlende Unterlagen | Tabelle `checklist_items` (`case_id`/`letter_id`, `text`, `erledigt`); Erkennung als zusätzliches Feld im KI-Schema. |
| Übersetzen | KI-Schema um `summary_translated` + Zielsprache erweitern; Nutzer-Einstellung `language`. Das Feld `language` (Sprache des Briefes) wird bereits erkannt. |
| Familienprofile | Tabellen `profiles` und `profile_members` (Rolle, Freigaben); `letters.profile_id`. Alle Abfragen, die heute `user_id` prüfen, prüfen dann die Mitgliedschaft – die Prüfung ist an wenigen Stellen gebündelt (`ownLetter`, `ownTask`). |
| Abo | Tabelle `subscriptions` (Anbieter-Kunden-ID, Status, Laufzeit); Zahlungsanbieter mit Webhook. Freischaltung über eine zentrale Funktion `hasPro(user)`. |

## Betrieb (später)

- **https ist Pflicht.** Empfehlung für den Anfang: ein EU-Server mit Caddy als Reverse-Proxy (automatische Zertifikate). In `.env`: `NODE_ENV=production`, `BASE_URL=https://…`, `TRUST_PROXY=1`, `DEMO_ENABLED=false`.
- **Datensicherung** von `data/` (Datenbank + Dateien) täglich, verschlüsselt; Schlüssel `FILE_ENCRYPTION_KEY` getrennt aufbewahren; Wiederherstellung testen.
- **Wachstum:** SQLite → PostgreSQL; Dateien → S3-kompatibler Speicher in der EU; Warteschlange im Arbeitsspeicher → Job-Queue mit eigenem Worker-Prozess; Anfragebegrenzung im Arbeitsspeicher → Redis (nötig, sobald mehr als ein Server läuft).
- **PDF-Verarbeitung** für fremde Dateien in einen eigenen Worker-Thread mit Zeitlimit auslagern.
