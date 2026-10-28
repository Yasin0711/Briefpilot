# Sicherheit und Datenschutz

Diese Datei beschreibt, was in der ersten Version technisch umgesetzt ist – und was vor einem öffentlichen Start noch geprüft werden muss. **BriefPilot ist in diesem Stand nicht „DSGVO-konform“ im Sinne einer abgeschlossenen Prüfung.** Die Liste ersetzt keine Rechtsberatung; die rechtlichen Punkte sollten mit einer Fachanwältin oder einem Fachanwalt für IT-/Datenschutzrecht durchgegangen werden.

## Bereits umgesetzt

**Anmeldung und Konten**
- Passwörter mit scrypt (speicherintensiv) und zufälligem Salz; Mindestlänge 10 Zeichen, häufige Passwörter abgelehnt.
- Sitzungs-Cookie `HttpOnly`, `SameSite=Strict`, im https-Betrieb `Secure`; in der Datenbank liegt nur ein Hash des Sitzungsschlüssels.
- Begrenzung von Anmeldeversuchen pro IP und pro Konto; gleiche Antwortzeit auch für unbekannte Adressen.
- „Passwort vergessen“: gleiche Antwort für bekannte und unbekannte Adressen; Link 60 Minuten gültig, nur einmal verwendbar; danach Abmeldung auf allen Geräten.
- Übersicht der angemeldeten Geräte, einzelne Geräte abmelden, Sicherheitsereignisse (ohne Inhalte).

**Trennung der Konten**
- Jede Abfrage prüft die Zugehörigkeit zum angemeldeten Nutzer. Fremde Briefe, Dateien und Aufgaben liefern „nicht gefunden“ (404), damit sich nicht einmal ihre Existenz erkennen lässt. Automatisch getestet (`test/api.test.js`).
- Hochgeladene Seiten können nur dem eigenen Konto zugeordnet werden.

**Dateien**
- Jede Datei einzeln mit AES-256-GCM verschlüsselt; der Speicherpfad ist kryptografisch an die Datei gebunden.
- Keine öffentlichen Links: Originale werden nur über `GET /api/files/:id` mit gültiger Sitzung ausgeliefert (`Cache-Control: private, no-store`).
- Upload-Prüfung: echter Dateityp anhand der ersten Bytes; Größen-, Seiten- und Speicherlimit; PDFs mit JavaScript/Launch-Aktionen und verschlüsselte PDFs werden abgelehnt; Entpacken von PDF-Inhalten ist auf 64 MB begrenzt.
- Fotos werden im Browser neu kodiert – dabei entfallen Metadaten wie der Aufnahmeort. Zuschnitt, Entzerrung und Bildverbesserung laufen vollständig auf dem Gerät.
- Unbearbeitete Originalfotos werden nur gespeichert, wenn der Nutzer das beim Scannen ausdrücklich wählt; sie gehen nicht an die KI.
- Zwischen-Uploads, die nie einem Brief zugeordnet wurden, werden beim Entfernen einer Seite sofort und sonst nach 24 Stunden gelöscht.

**Übertragung und Browser**
- Content-Security-Policy ohne Inline-Skripte, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS im https-Betrieb.
- Schutz vor Cross-Site-Request-Forgery: ändernde Anfragen brauchen einen eigenen Header und die eigene Herkunft.
- Alle Inhalte (auch KI-Antworten) werden in der Oberfläche maskiert ausgegeben.
- Der Service Worker speichert nur die App-Oberfläche, nie Briefe oder persönliche Daten.

**KI**
- API-Schlüssel nur auf dem Server; wird nie an den Browser geschickt (getestet). Er steht in `.env` und gehört nicht in Datensicherungen, die weitergegeben werden.
- Übermittlung an den KI-Dienst nur nach ausdrücklicher Zustimmung des Nutzers, jederzeit widerrufbar. Übermittelt wird nur der jeweilige Brief (Seiten als Bild bzw. PDF; bei Fragen und KI-Antwortentwürfen der erkannte Text, die Aufgaben und die Frage bzw. der Wunsch des Nutzers) – nie Name, E-Mail-Adresse oder Passwort des Kontos.
- Wählbare Anbieter (`AI_PROVIDER`): Google Gemini (Standard), OpenAI-kompatibel (z. B. Ollama auf dem eigenen Rechner – dann verlässt kein Brief den Computer) oder Claude. Die App nennt den Anbieter bei der Zustimmung und bei jeder KI-Funktion.
- Brieftext gilt ausschließlich als Daten: Systemanweisung, festes Antwortformat (JSON-Schema), Einbettung als „Material, keine Anweisungen“, anschließende Prüfung jeder Antwort (`validate.js`; erfundene Nummern zählen nicht), Erkennung von „Anweisungen an KI“ im Brief. Die KI kann keine Aktionen auslösen – sie erzeugt nur Vorschläge im Status „Zu prüfen“ bzw. Entwürfe.
- Tageslimit für KI-Aufrufe pro Nutzer (auch für Fragen und Entwürfe).

**Google Gemini – was die Bedingungen sagen** (Stand der [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms): 28.04.2026)
- Nutzung der API erst ab **18 Jahren**; die App darf sich nicht an Minderjährige richten.
- Für Nutzer **in der EU, der Schweiz und Großbritannien** gelten auch beim kostenlosen Kontingent die Datenregeln des bezahlten Dienstes: Google verwendet Eingaben und Antworten nicht zur Produktverbesserung; Speicherung nur befristet zur Missbrauchserkennung.
- Wer eine App **anderen Nutzern in der EU, der Schweiz oder Großbritannien** anbietet, darf laut Google **nur den kostenpflichtigen Dienst** verwenden. Das kostenlose Kontingent eignet sich daher für Tests und den eigenen Gebrauch, nicht für einen öffentlichen Start.

**Zuordnung, Antworten, E-Mail**
- Zuordnungen zu Akten sind nachvollziehbar (gespeicherter Nachweis mit Textstelle); Entscheidungen des Nutzers werden nie automatisch überschrieben; beim Löschen einer Akte bleiben alle Briefe erhalten.
- Duplikate werden nur markiert, nie automatisch gelöscht.
- Antworten werden nur nach ausdrücklicher Bestätigung per E-Mail versendet (eigener Bestätigungsschritt, Server prüft `confirm: true`), nicht im Demomodus, nicht mit offenen Platzhaltern und mit Tageslimit; versendete Antworten sind unveränderlich und im Verlauf dokumentiert (Empfängeradresse gekürzt).

**Keine Aktionen ohne Zustimmung**
- Erinnerungen nur für bestätigte Aufgaben. E-Mail-Erinnerungen nur, wenn der Nutzer sie einschaltet. Kalenderdatei nur auf Klick. Es gibt keinen automatischen E-Mail-Versand an Dritte – Antworten verschickt nur der Nutzer selbst nach ausdrücklicher Bestätigung.
- Benachrichtigungen enthalten standardmäßig keine Details (abschaltbar).

**Protokolle**
- Protokolliert werden nur Methode, Routenmuster (ohne IDs und Suchbegriffe), Statuscode und Dauer; bei Fehlern nur die Fehlerart. Keine Briefinhalte, keine E-Mail-Adressen im Klartext.

**Nutzerrechte**
- Vollständiger Export (ZIP mit `daten.json` – inkl. Akten, Nummern, Vorgängen, Zuordnungen, Personen, Adressen, Antworten, Fragen und Verlauf – und allen Originalen).
- Löschen einzelner Briefe und des ganzen Kontos (Datenbank und Dateien sofort).
- Demo-Konten werden nach 24 Stunden gelöscht.

## Vor einem öffentlichen Start zu prüfen

### Technisch
- [ ] **https-Betrieb** auf einem Server in der EU; `NODE_ENV=production`, `DEMO_ENABLED=false`.
- [ ] **E-Mail-Bestätigung bei der Registrierung** fehlt noch (heute kann man sich mit jeder Adresse registrieren). Einbauen.
- [ ] **Zwei-Faktor-Anmeldung** oder Passkeys anbieten.
- [ ] **Datenbank-Inhalte** (erkannter Text, Erklärungen) liegen unverschlüsselt in SQLite. Mindestens Festplattenverschlüsselung des Servers; Feldverschlüsselung prüfen (Zielkonflikt mit der Suche).
- [ ] **Schlüsselverwaltung:** `FILE_ENCRYPTION_KEY` sicher verwahren (z. B. Secret-Manager), Notfallzugang regeln, Schlüsselwechsel planen.
- [ ] **Datensicherung** verschlüsselt, mit Löschfristen und getesteter Wiederherstellung.
- [ ] **Eigene Bausteine prüfen lassen** (SMTP, Web-Push, PDF-Leser, Router) oder durch etablierte Bibliotheken ersetzen. Unabhängiger Sicherheitstest (Penetrationstest).
- [ ] **PDF-Verarbeitung** in einen Worker-Thread mit Zeitlimit auslagern; optional Virenprüfung der Uploads.
- [ ] Anfragebegrenzung liegt im Arbeitsspeicher – bei mehreren Servern zentral (z. B. Redis) umsetzen.
- [ ] Überwachung, Alarmierung und ein Notfallplan für Sicherheitsvorfälle.
- [ ] Echte Ende-zu-Ende-Tests mit KI-Schlüssel (Gemini), Push-Diensten (Android, iOS ab Home-Bildschirm, Desktop) und Mailserver.
- [ ] Barrierefreiheit mit Screenreader prüfen (Ziel: WCAG 2.2 AA). Bereits geprüft: automatische Stichprobe für Namen aller Bedienelemente, Alternativtexte und Farbkontraste (hell/dunkel, Handy/Computer – keine Verstöße, `test/browser/a11y.e2e.mjs`), Tastaturbedienung der Zuordnung und des Seiten-Editors.
- [ ] **Gemini kostenpflichtig** einrichten (Rechnungskonto im Google-Projekt, `GEMINI_PAID=true`), bevor die App anderen Nutzern angeboten wird.
- [ ] E-Mail-Postfach-Anbindung (IMAP/OAuth), falls gewünscht: Zugangsdaten verschlüsselt speichern, nur lesend, ausdrückliche Freigabe je Postfach.

### Organisatorisch
- [ ] **Verzeichnis von Verarbeitungstätigkeiten** (Art. 30 DSGVO) anlegen.
- [ ] **Technische und organisatorische Maßnahmen (TOM)** dokumentieren (diese Datei ist ein Ausgangspunkt).
- [ ] **Auftragsverarbeitungsverträge** (Art. 28 DSGVO) mit Hoster, KI-Anbieter (bei Google: Datenschutz-Zusatz zum kostenpflichtigen Gemini-Dienst), E-Mail-Dienst und ggf. Zahlungsanbieter.
- [ ] **Löschkonzept**: Fristen für Briefe inaktiver Konten, Protokolle, Backups.
- [ ] **Meldeprozess für Datenpannen** (72 Stunden, Art. 33 DSGVO) festlegen.
- [ ] Prüfen, ob ein **Datenschutzbeauftragter** benannt werden muss (u. a. § 38 BDSG – z. B. wenn eine Datenschutz-Folgenabschätzung erforderlich ist).

### Rechtlich
- [ ] **Datenschutz-Folgenabschätzung** (Art. 35 DSGVO): Briefe enthalten oft besondere Kategorien personenbezogener Daten (Gesundheit; Religionszugehörigkeit z. B. im Steuerbescheid) und werden mit KI verarbeitet – eine DSFA ist sehr wahrscheinlich nötig.
- [ ] **Rechtsgrundlagen** festlegen, insbesondere für besondere Kategorien (Art. 9 DSGVO) – ob die bestehende Einwilligung zur KI-Auswertung den Anforderungen an eine *ausdrückliche* Einwilligung genügt.
- [ ] **Drittlandübermittlung** (Art. 44 ff. DSGVO) zum KI-Anbieter: Angemessenheitsbeschluss / Zertifizierung, Standardvertragsklauseln, Transfer-Folgenabschätzung. Alternativ Verarbeitung in einer EU-Region prüfen (z. B. Claude über einen Cloud-Anbieter mit EU-Rechenzentrum, sofern das Modell dort verfügbar ist).
- [ ] **Speicherdauer beim KI-Anbieter** und Nutzung der Daten zum Training vertraglich klären; prüfen, ob eine Vereinbarung ohne Datenspeicherung (Zero Data Retention) möglich ist.
- [ ] **Datenschutzerklärung** (Art. 13 DSGVO) – die Seite „Datenschutz und KI“ in der App ist nur ein Entwurf. Kontaktadresse (`PRIVACY_CONTACT`) eintragen.
- [ ] **Impressum** (§ 5 Digitale-Dienste-Gesetz) und **Nutzungsbedingungen** mit klarem Hinweis: keine Rechts- oder Steuerberatung, keine Gewähr für erkannte Fristen.
- [ ] **Rechtsdienstleistungsgesetz (RDG):** prüfen, wo Erklärungen, Antworten der KI auf Fragen und insbesondere die Antwortentwürfe (z. B. Widerspruch/Einspruch) die Grenze zur Rechtsdienstleistung berühren. Heute: Vorlagen mit Platzhaltern und Formulierungshilfe, Hinweis „keine Rechtsberatung“.
- [ ] **EU-KI-Verordnung:** Transparenzpflichten (Hinweis auf KI-Einsatz) und deren Zeitplan prüfen.
- [ ] **Cookies/Endgerätezugriff** (§ 25 TDDDG): Es wird nur ein technisch notwendiges Sitzungs-Cookie und lokaler Speicher für Anzeige-Einstellungen (Schriftgröße, hell/dunkel, automatische Kamera-Auslösung, Originalfotos aufbewahren) verwendet – Einordnung bestätigen lassen. Kamerazugriff nur nach Freigabe durch den Browser.
- [ ] **Barrierefreiheitsstärkungsgesetz (BFSG):** prüfen, ob die kostenpflichtige App als Dienstleistung im elektronischen Geschäftsverkehr darunter fällt.
- [ ] **Mindestalter** in die Registrierung aufnehmen: Art. 8 DSGVO (in Deutschland 16 Jahre) und – bei Nutzung von Gemini – 18 Jahre laut Google-Bedingungen.
- [ ] **Abo:** Preisangaben, Widerrufsbelehrung, Kündigungsbutton (§ 312k BGB).
- [ ] **Name „BriefPilot“:** Marken- und Domainrecherche (DPMA, EUIPO).
