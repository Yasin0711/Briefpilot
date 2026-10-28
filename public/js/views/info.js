// Informationsseiten: Datenschutz und KI, Systemstatus, Pro-Vorschau.
import { html, mount } from '../html.js';
import { icon } from '../ui.js';

const STATE_BADGE = {
  echt: html`<span class="badge badge-done">${icon('check')}echt</span>`,
  simuliert: html`<span class="badge badge-review">simuliert</span>`,
  aus: html`<span class="badge">nicht eingerichtet</span>`,
  vorschau: html`<span class="badge badge-open">Vorschau</span>`,
};

function backLink(state) {
  return state.me
    ? html`<p><a class="btn btn-ghost btn-small" href="#/einstellungen">${icon('chevronLeft')}Einstellungen</a></p>`
    : html`<p><a class="btn btn-ghost btn-small" href="#/anmelden">${icon('chevronLeft')}Zur Anmeldung</a></p>`;
}

export async function renderStatus({ root, state }) {
  const features = state.status?.features || [];
  mount(root, html`<div class="stack-l">
    ${backLink(state)}
    <div class="page-head"><div><h1>Was funktioniert echt?</h1>
      <p>Diese Übersicht zeigt, welche Funktionen auf diesem Server wirklich arbeiten und welche nur simuliert oder noch nicht eingerichtet sind.</p></div></div>
    <section class="panel"><ul class="status-list">
      ${features.map((f) => html`<li>${STATE_BADGE[f.state] || ''}<div><strong>${f.label}</strong><p class="muted">${f.detail}</p></div></li>`)}
    </ul></section>
    ${state.status?.demoEnabled ? html`<div class="note">${icon('info')}<p>Der Demomodus ist eingeschaltet. Demo-Konten enthalten erfundene Beispielbriefe mit vorbereiteten Auswertungen. Diese sind deutlich als „Beispielauswertung“ gekennzeichnet.</p></div>` : ''}
  </div>`);
}

export async function renderPrivacy({ root, state }) {
  const ai = state.status?.ai;
  const contact = state.status?.privacyContact;
  mount(root, html`<div class="stack-l">
    ${backLink(state)}
    <div class="page-head"><div><h1>Datenschutz und KI</h1>
      <p>Was mit Ihren Briefen passiert – in einfacher Sprache.</p></div></div>
    <div class="note note-warn">${icon('alert')}<p><strong>Entwurf:</strong> Dieser Text beschreibt, wie die App technisch arbeitet. Er ist noch keine rechtlich geprüfte Datenschutzerklärung. Vor einem öffentlichen Start muss der Betreiber ihn rechtlich prüfen lassen und ergänzen.</p></div>

    <section class="panel stack">
      <h2>Kurz gesagt</h2>
      <ul class="tips">
        <li>Ihre Briefe gehören Ihnen. Nur Sie können sie sehen – es gibt keine öffentlichen Links.</li>
        <li>Die Originaldateien werden verschlüsselt gespeichert und verschlüsselt übertragen.</li>
        <li>Gescannte Seiten werden auf Ihrem Gerät zugeschnitten und verbessert – erst danach wird hochgeladen.</li>
        <li>Eine KI liest Ihre Briefe nur, wenn Sie das ausdrücklich erlauben.</li>
        <li>BriefPilot verschickt keine E-Mails und trägt keine Termine ein, ohne dass Sie es auslösen. Antworten per E-Mail gehen erst nach Ihrer ausdrücklichen Bestätigung hinaus.</li>
        <li>Sie können alle Daten jederzeit herunterladen oder vollständig löschen.</li>
      </ul>
    </section>

    <section class="panel stack">
      <h2>Was wird gespeichert?</h2>
      <ul class="tips">
        <li><strong>Konto:</strong> E-Mail-Adresse, freiwillig Ihr Vorname, Ihr Passwort nur als sicherer Prüfwert (nicht im Klartext).</li>
        <li><strong>Briefe:</strong> die gescannten Seiten bzw. PDFs (verschlüsselt), auf Ihren Wunsch zusätzlich die unbearbeiteten Originalfotos, der erkannte Text, die Erklärung, erkannte Angaben wie Absender, Datum und Nummern, der Verlauf (z. B. „zugeordnet“, „Antwort versendet“).</li>
        <li><strong>Akten und Haushalt:</strong> Ihre Akten mit Nummern (z. B. Kennzeichen, Vertrags- oder Zählernummer), Vorgänge, Zuordnungen der Briefe sowie Personen und Adressen, die Sie eintragen.</li>
        <li><strong>Antworten und Fragen:</strong> Ihre Antwortentwürfe, versendete Antworten (mit Empfänger und Zeitpunkt) und Ihre Fragen an die KI mit den Antworten.</li>
        <li><strong>Aufgaben und Erinnerungen:</strong> was Sie bestätigt oder selbst eingetragen haben.</li>
        <li><strong>Geräte:</strong> eine grobe Gerätebezeichnung (z. B. „iPhone · Safari“) und wann Sie zuletzt aktiv waren.</li>
        <li><strong>Sicherheitsereignisse:</strong> z. B. Anmeldungen und Passwortänderungen, ohne Briefinhalte, für 180 Tage.</li>
        <li><strong>Server-Protokolle:</strong> nur technische Angaben (welche Funktion, Erfolg oder Fehler, Dauer) – keine Briefinhalte, keine Suchbegriffe.</li>
      </ul>
    </section>

    <section class="panel stack">
      <h2>Was bekommt die KI?</h2>
      ${ai?.enabled ? html`
        <p>Wenn Sie die KI-Auswertung erlauben, werden die gescannten Seiten oder PDFs <strong>des jeweiligen Briefes</strong> zusammen mit Arbeitsanweisungen an <strong>${ai.provider}</strong> übermittelt (Modell: ${ai.model}). Die KI erkennt den Text und erstellt die Erklärung. Stellen Sie eine Frage zum Brief oder lassen Sie eine Antwort entwerfen, gehen der erkannte Text des Briefes und Ihre Frage bzw. Ihr Wunsch an die KI.</p>
        <p>Nicht übermittelt werden Ihr Name aus dem Konto, Ihre E-Mail-Adresse, Ihr Passwort, Ihre anderen Briefe und Ihre Originalfotos.</p>
        ${ai.local ? html`<p>Die KI läuft auf dem Computer, auf dem BriefPilot installiert ist – Ihre Briefe verlassen ihn dafür nicht.</p>` : ''}
        ${ai.kind === 'gemini' ? html`<p>Für Google Gemini gilt laut Google: Nutzung ab 18 Jahren. Für Nutzer in der EU, der Schweiz und Großbritannien verwendet Google die Inhalte auch beim kostenlosen Kontingent nicht zur Verbesserung seiner Produkte und speichert sie nur befristet zur Missbrauchserkennung (<a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener">Bedingungen von Google</a>).${ai.freeTier ? ' Diese Installation nutzt das kostenlose Kontingent – das ist zum Testen gedacht.' : ''}</p>` : ''}
        <p>Wie lange der KI-Anbieter Daten aufbewahrt und wo sie verarbeitet werden, richtet sich zudem nach dem Vertrag zwischen Betreiber und Anbieter. Diese Angaben muss der Betreiber vor dem Start hier ergänzen.</p>`
      : html`<p>Auf diesem Server ist keine KI eingerichtet. Ihre Briefe werden an keinen KI-Dienst übermittelt. PDFs mit Text werden direkt auf dem Server mit einfachen Regeln gelesen.</p>`}
      <p>Texte in Ihren Briefen werden nur ausgewertet. Steht in einem Brief eine „Anweisung“ an eine KI, wird sie nicht befolgt, und BriefPilot weist Sie darauf hin.</p>
    </section>

    <section class="panel stack">
      <h2>Ihre Rechte</h2>
      <ul class="tips">
        <li>Alle Daten herunterladen: Einstellungen → Meine Daten.</li>
        <li>Einzelne Briefe oder das ganze Konto löschen – die Dateien werden dabei sofort mitgelöscht.</li>
        <li>KI-Auswertung jederzeit erlauben oder nicht mehr verwenden: Einstellungen → Datenschutz und KI.</li>
      </ul>
      <p>Kontakt für Datenschutzfragen: ${contact || html`<span class="muted">noch nicht eingetragen (Betreiber: PRIVACY_CONTACT setzen)</span>`}</p>
    </section>
  </div>`);
}

// Vierter Wert: true = bereits verfügbar (aus der Vorschau in die App übernommen)
const PRO_FEATURES = [
  ['calendar', 'Kalender-Abgleich', 'Bestätigte Termine automatisch mit Apple Kalender, Google Kalender oder Outlook abgleichen – nur nach Ihrer Freigabe. Heute schon möglich: einzelne Termine als Kalenderdatei herunterladen.'],
  ['pen', 'Antwortentwürfe', 'Im Brief unter „Antwort“: Vorlagen (z. B. Fristverlängerung, Widerspruch, Kündigung) oder ein KI-Entwurf, den Sie selbst bearbeiten.', true],
  ['file', 'Antwort als PDF', 'Den Entwurf bearbeiten und als druckfertiges PDF (DIN-Brief mit Falzmarken) herunterladen.', true],
  ['send', 'Antwort per E-Mail', 'Im eigenen E-Mail-Programm öffnen oder – wenn ein Mailserver eingerichtet ist – direkt senden. Immer erst nach Ihrer ausdrücklichen Freigabe.', true],
  ['link', 'Akten und Vorgänge', 'Briefe werden anhand von Kennzeichen, Vertrags- und Zählernummern automatisch der richtigen Akte zugeordnet; zusammengehörige Briefe bilden Vorgänge.', true],
  ['list', 'Fehlende Unterlagen', 'Eine Checkliste, welche Unterlagen ein Amt oder eine Versicherung noch von Ihnen braucht.'],
  ['translate', 'Übersetzen', 'Briefe in Ihre Sprache übersetzen und in einfacher Sprache erklären.'],
  ['users', 'Familienprofile', 'Getrennte Unterlagen für Familienmitglieder – mit gezielten Freigaben. Schon heute: Personen und Adressen im Haushalt (Einstellungen → Haushalt).'],
  ['star', 'Abo', 'Monats- oder Jahresabo für die Pro-Funktionen. Der Preis steht noch nicht fest.'],
];

export async function renderPro({ root }) {
  mount(root, html`<div class="stack-l">
    <p><a class="btn btn-ghost btn-small" href="#/einstellungen">${icon('chevronLeft')}Einstellungen</a></p>
    <div class="page-head"><div><h1>BriefPilot Pro</h1>
      <p>Vorschau auf geplante Funktionen. Was mit „jetzt verfügbar“ markiert ist, können Sie bereits nutzen; alles andere lässt sich hier noch nicht aktivieren.</p></div></div>
    <section class="panel"><ul class="pro-list">
      ${PRO_FEATURES.map(([ic, title, text, available]) => html`<li><span class="cat-tile">${icon(ic)}</span>
        <div><div class="row"><strong>${title}</strong>${available ? html`<span class="badge badge-done">${icon('check')}jetzt verfügbar</span>` : html`<span class="badge badge-open">geplant</span>`}</div><p class="muted">${text}</p></div></li>`)}
    </ul></section>
  </div>`);
}
