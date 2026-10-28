// Einstellungen: Konto, Erinnerungen, Benachrichtigungen, Anzeige, Datenschutz, Geräte, Daten.
import { html, mount } from '../html.js';
import { api, download } from '../api.js';
import { icon, toast, formValues, showError, clearErrors, busy, openDialog, confirmDialog } from '../ui.js';
import { REMINDER_OFFSETS, PERSON_RELATIONS, ADDRESS_KINDS } from '../shared/constants.js';
import { loadHousehold, forgetHousehold } from './objectDialog.js';
import { formatDateTime } from '../shared/dates.js';
import { applyTextSize, applyTheme, themeChoice } from '../app.js';

const EVENT_LABELS = {
  registriert: 'Konto erstellt', angemeldet: 'Angemeldet', anmeldung_fehlgeschlagen: 'Anmeldung fehlgeschlagen',
  passwort_link_angefordert: 'Link zum Zurücksetzen angefordert', passwort_zurueckgesetzt: 'Passwort zurückgesetzt',
  passwort_geaendert: 'Passwort geändert', ki_freigegeben: 'KI-Auswertung erlaubt', ki_abgelehnt: 'KI-Auswertung abgelehnt',
  daten_exportiert: 'Daten exportiert', andere_geraete_abgemeldet: 'Andere Geräte abgemeldet',
};

function b64ToUint8(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function pushState(status) {
  if (!status?.push?.enabled) return { available: false, reason: 'Auf diesem Server sind Push-Benachrichtigungen nicht eingerichtet.' };
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return {
      available: false,
      reason: ios
        ? 'Auf iPhone und iPad funktionieren Benachrichtigungen nur, wenn Sie BriefPilot zum Home-Bildschirm hinzufügen (Teilen → „Zum Home-Bildschirm“) und von dort öffnen.'
        : 'Dieser Browser unterstützt hier keine Benachrichtigungen (eine sichere https-Verbindung ist nötig).',
    };
  }
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
  ]);
  const sub = await reg.pushManager.getSubscription();
  return { available: true, subscribed: Boolean(sub), permission: Notification.permission, sub, reg };
}

export async function render({ root, state, navigate, refreshMe, isCurrent }) {
  const current = { household: { persons: [], addresses: [] } };

  function personDialog(person = null) {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>${person ? 'Person bearbeiten' : 'Person hinzufügen'}</h2>
      <div class="field"><label for="pe-name">Name</label><input class="input" id="pe-name" name="name" value="${person?.name || ''}" maxlength="120" placeholder="z. B. Lena Beispiel"></div>
      <div class="field"><label for="pe-rel">Beziehung</label><select class="input" id="pe-rel" name="relation">
        ${PERSON_RELATIONS.map((r) => html`<option value="${r.id}" ${r.id === (person?.relation || 'sonstige') ? 'selected' : ''}>${r.label}</option>`)}</select></div>
      <div class="field"><label for="pe-alias">Weitere Schreibweisen <span class="muted">(freiwillig)</span></label>
        <input class="input" id="pe-alias" name="aliases" value="${(person?.aliases || []).join(', ')}" maxlength="400" placeholder="z. B. L. Beispiel, Lena Muster (Geburtsname)">
        <p class="hint">Mit Komma trennen. So wird die Person auch erkannt, wenn der Name im Brief anders geschrieben ist.</p></div>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const v = formValues(form);
        const body = { name: v.name, relation: v.relation, aliases: v.aliases.split(',').map((x) => x.trim()).filter(Boolean) };
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            if (person) await api.patch(`/api/persons/${person.id}`, body);
            else await api.post('/api/persons', body);
            close();
            forgetHousehold();
            toast('Gespeichert.');
            await draw();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function addressDialog(address = null) {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>${address ? 'Adresse bearbeiten' : 'Adresse hinzufügen'}</h2>
      <div class="field-pair">
        <div class="field"><label for="ad-label">Bezeichnung</label><input class="input" id="ad-label" name="label" value="${address?.label || ''}" maxlength="80" placeholder="z. B. Zuhause, Ferienwohnung"></div>
        <div class="field"><label for="ad-kind">Art</label><select class="input" id="ad-kind" name="kind">
          ${ADDRESS_KINDS.map((k) => html`<option value="${k.id}" ${k.id === (address?.kind || 'haushalt') ? 'selected' : ''}>${k.label}</option>`)}</select></div>
      </div>
      <div class="field"><label for="ad-street">Straße und Hausnummer</label><input class="input" id="ad-street" name="street" value="${address?.street || ''}" maxlength="120" autocomplete="street-address"></div>
      <div class="field-pair">
        <div class="field"><label for="ad-zip">PLZ</label><input class="input" id="ad-zip" name="zip" value="${address?.zip || ''}" maxlength="10" inputmode="numeric" autocomplete="postal-code"></div>
        <div class="field"><label for="ad-city">Ort</label><input class="input" id="ad-city" name="city" value="${address?.city || ''}" maxlength="80" autocomplete="address-level2"></div>
      </div>
      <div class="field-pair">
        <div class="field"><label for="ad-from">Gültig ab <span class="muted">(freiwillig)</span></label><input class="input" type="date" id="ad-from" name="validFrom" value="${address?.validFrom || ''}"></div>
        <div class="field"><label for="ad-to">Gültig bis <span class="muted">(z. B. nach Umzug)</span></label><input class="input" type="date" id="ad-to" name="validTo" value="${address?.validTo || ''}"></div>
      </div>
      <label class="check"><input type="checkbox" name="isPrimary" ${address?.isPrimary ? 'checked' : ''}><span>Hauptadresse (wird als Absender in Antwortbriefen verwendet)</span></label>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const v = formValues(form);
        const body = { label: v.label, kind: v.kind, street: v.street, zip: v.zip, city: v.city, validFrom: v.validFrom || null, validTo: v.validTo || null, isPrimary: v.isPrimary === true };
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            if (address) await api.patch(`/api/addresses/${address.id}`, body);
            else await api.post('/api/addresses', body);
            close();
            forgetHousehold();
            toast('Gespeichert.');
            await draw();
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  async function draw() {
    const me = state.me;
    const s = me.settings;
    const [sessions, push, household] = await Promise.all([
      api.get('/api/me/sessions'),
      pushState(state.status).catch(() => ({ available: false, reason: 'Benachrichtigungen konnten nicht geprüft werden.' })),
      loadHousehold({ fresh: true }).catch(() => ({ persons: [], addresses: [] })),
    ]);
    current.household = household;
    if (!isCurrent()) return;
    let textSize = 'normal';
    try {
      textSize = localStorage.getItem('bp-textsize') || 'normal';
    } catch {
      textSize = 'normal';
    }
    const mailOn = state.status?.mail?.enabled;

    mount(root, html`<div class="stack-l">
      <div class="page-head"><div><h1>Einstellungen</h1></div></div>

      <section class="panel stack settings-section" aria-labelledby="s-konto">
        <h2 id="s-konto">Konto</h2>
        ${me.isDemo ? html`<p class="muted">Sie nutzen ein Demo-Konto. Es wird nach 24 Stunden mit allen Daten gelöscht.</p>` : me.isGuest ? html`
        <div class="note note-warn">${icon('info')}<div class="stack"><p><strong>Sie nutzen BriefPilot ohne Konto.</strong> Ihre Briefe sind nur auf diesem Gerät in dieser App erreichbar.</p>
          <p>Wenn Sie sich abmelden oder die Websitedaten löschen, kommen Sie nicht mehr an Ihre Briefe. Laden Sie Ihre Daten bei Bedarf vorher herunter.</p></div></div>` : html`
        <form class="stack" data-form="profile" novalidate>
          <div class="field"><label for="p-name">Vorname</label><input class="input" id="p-name" name="name" value="${me.name || ''}" maxlength="80"></div>
          <div class="field"><span class="field-label">E-Mail-Adresse</span><p>${me.email}</p></div>
          <div class="row"><button class="btn btn-secondary" type="submit">Speichern</button>
            <button class="btn btn-ghost" type="button" data-action="password">${icon('lock')}Passwort ändern</button></div>
        </form>`}
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-haushalt">
        <h2 id="s-haushalt">Haushalt</h2>
        <p class="muted">Personen und Adressen helfen beim Zuordnen: Briefe an „Max Beispiel“ landen bei Max, Strom- oder Gasbriefe für die Ferienwohnung bei deren Zähler.</p>
        <h3>Personen</h3>
        ${household.persons.length ? html`<ul class="id-list">${household.persons.map((x) => html`<li>
          <span class="cat-tile">${icon('user')}</span>
          <span class="grow"><span class="row-title">${x.name}</span>
            <span class="row-sub">${PERSON_RELATIONS.find((r) => r.id === x.relation)?.label || ''}${x.aliases?.length ? ` · auch: ${x.aliases.join(', ')}` : ''}</span></span>
          <button class="icon-btn" type="button" data-person-edit="${x.id}" aria-label="${x.name} bearbeiten">${icon('edit')}</button>
          <button class="icon-btn" type="button" data-person-delete="${x.id}" aria-label="${x.name} entfernen">${icon('trash')}</button></li>`)}</ul>`
          : html`<p class="small muted">Noch keine Personen eingetragen.</p>`}
        <p><button class="btn btn-small btn-secondary" type="button" data-action="person-add">${icon('plus')}Person hinzufügen</button></p>
        <h3>Adressen</h3>
        ${household.addresses.length ? html`<ul class="id-list">${household.addresses.map((a) => html`<li>
          <span class="cat-tile">${icon('mapPin')}</span>
          <span class="grow"><span class="row-title">${a.label}${a.isPrimary ? html` <span class="badge badge-done">Hauptadresse</span>` : ''}</span>
            <span class="row-sub">${[a.street, [a.zip, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}${a.validTo ? ` · bis ${a.validTo.split('-').reverse().join('.')}` : ''}</span></span>
          <button class="icon-btn" type="button" data-address-edit="${a.id}" aria-label="${a.label} bearbeiten">${icon('edit')}</button>
          <button class="icon-btn" type="button" data-address-delete="${a.id}" aria-label="${a.label} entfernen">${icon('trash')}</button></li>`)}</ul>`
          : html`<p class="small muted">Noch keine Adressen eingetragen.</p>`}
        <p><button class="btn btn-small btn-secondary" type="button" data-action="address-add">${icon('plus')}Adresse hinzufügen</button></p>
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-erinnerung">
        <h2 id="s-erinnerung">Erinnerungen</h2>
        <p class="muted">So erinnert BriefPilot Sie standardmäßig an bestätigte Fristen und Termine. Für einzelne Aufgaben können Sie das ändern.</p>
        <form class="stack" data-form="reminders" novalidate>
          <fieldset class="field"><legend class="field-label">Wann erinnern?</legend>
            <div class="chips">${REMINDER_OFFSETS.map((o) => html`<label class="chip"><input type="checkbox" name="reminderOffsets" value="${o.id}" ${s.reminderOffsets.includes(o.id) ? 'checked' : ''}>${o.label}</label>`)}</div></fieldset>
          <div class="field"><label for="r-time">Uhrzeit der Erinnerung</label><input class="input" type="time" id="r-time" name="reminderTime" value="${s.reminderTime}"></div>
          <label class="check"><input type="checkbox" name="emailReminders" ${s.emailReminders ? 'checked' : ''}>
            <span>Zusätzlich per E-Mail erinnern${mailOn ? '' : html`<br><span class="small muted">Hinweis: Auf diesem Server ist kein E-Mail-Versand eingerichtet – es würde keine E-Mail ankommen.</span>`}</span></label>
          <label class="check"><input type="checkbox" name="notificationDetails" ${s.notificationDetails ? 'checked' : ''}>
            <span>Aufgabe in Benachrichtigungen nennen<br><span class="small muted">Aus: Es erscheint nur „Sie haben eine anstehende Aufgabe“ – besser, wenn andere Ihren Bildschirm sehen können.</span></span></label>
          <p><button class="btn btn-secondary" type="submit">Erinnerungen speichern</button></p>
        </form>
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-push">
        <h2 id="s-push">Benachrichtigungen auf diesem Gerät</h2>
        <p class="muted">Erinnerungen erscheinen immer in der App auf der Startseite. Zusätzlich kann dieses Gerät eine Benachrichtigung zeigen.</p>
        ${push.available ? html`
          <p>${push.subscribed ? html`<span class="badge badge-done">${icon('check')}Eingeschaltet</span>` : html`<span class="badge">Ausgeschaltet</span>`}</p>
          ${push.permission === 'denied' ? html`<div class="note note-warn">${icon('alert')}<p>Benachrichtigungen sind in Ihrem Browser für diese Seite blockiert. Bitte erlauben Sie sie in den Browser-Einstellungen.</p></div>` : ''}
          <div class="row">
            ${push.subscribed
              ? html`<button class="btn btn-secondary" type="button" data-action="push-test">${icon('bell')}Test senden</button>
                <button class="btn btn-ghost" type="button" data-action="push-off">Ausschalten</button>`
              : html`<button class="btn" type="button" data-action="push-on" ${push.permission === 'denied' ? 'disabled' : ''}>${icon('bell')}Benachrichtigungen einschalten</button>`}
          </div>` : html`<div class="note">${icon('info')}<p>${push.reason}</p></div>`}
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-anzeige">
        <h2 id="s-anzeige">Anzeige</h2>
        <fieldset class="field"><legend class="field-label">Schriftgröße</legend>
          <div class="chips" role="radiogroup">
            ${[['sehr-klein', 'Sehr klein'], ['klein', 'Klein'], ['normal', 'Normal'], ['gross', 'Groß'], ['sehr-gross', 'Sehr groß']].map(([v, l]) => html`<label class="chip"><input type="radio" name="textsize" value="${v}" ${textSize === v ? 'checked' : ''}>${l}</label>`)}
          </div></fieldset>
        <fieldset class="field"><legend class="field-label">Darstellung</legend>
          <div class="chips" role="radiogroup">
            ${[['auto', 'Automatisch', 'contrast'], ['hell', 'Hell', 'sun'], ['dunkel', 'Dunkel', 'moon']].map(([v, l, ic]) => html`<label class="chip"><input type="radio" name="theme" value="${v}" ${themeChoice() === v ? 'checked' : ''}>${icon(ic)}${l}</label>`)}
          </div>
          <p class="hint">„Automatisch“ folgt der Einstellung Ihres Geräts (hell am Tag, dunkel am Abend).</p></fieldset>
        <p class="small muted">Gilt für dieses Gerät.</p>
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-ki">
        <h2 id="s-ki">Datenschutz und KI</h2>
        ${state.status?.ai?.enabled ? html`
          <p>KI-Auswertung: ${me.aiConsent === 'ja' ? html`<span class="badge badge-done">${icon('check')}erlaubt</span>` : me.aiConsent === 'nein' ? html`<span class="badge">abgelehnt</span>` : html`<span class="badge badge-review">noch nicht entschieden</span>`}</p>
          <p class="muted">Erlaubt: Ihre Briefe werden zur Auswertung an ${state.status.ai.provider} übermittelt. Abgelehnt: Fotos werden nur gespeichert, PDFs mit Text einfach erkannt.</p>
          <div class="row">
            ${me.aiConsent !== 'ja' ? html`<button class="btn btn-secondary" type="button" data-consent="ja">KI-Auswertung erlauben</button>` : ''}
            ${me.aiConsent !== 'nein' ? html`<button class="btn btn-ghost" type="button" data-consent="nein">KI-Auswertung nicht mehr verwenden</button>` : ''}
          </div>` : html`<p class="muted">Auf diesem Server ist keine KI eingerichtet. Ihre Briefe werden nicht an einen KI-Dienst übermittelt.</p>`}
        <p><a href="#/datenschutz">Was passiert mit meinen Daten?</a> · <a href="#/status">Was funktioniert echt?</a></p>
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-geraete">
        <h2 id="s-geraete">Angemeldete Geräte</h2>
        <ul class="list">${sessions.sessions.map((x) => html`<li class="list-row">
          <span class="cat-tile">${icon('phone')}</span>
          <span class="grow"><span class="row-title">${x.device || 'Unbekanntes Gerät'}${x.current ? ' (dieses Gerät)' : ''}</span>
            <span class="row-sub">Zuletzt aktiv: ${formatDateTime(x.lastSeenAt, me.timezone)}</span></span>
          ${x.current ? '' : html`<button class="btn btn-small btn-ghost" type="button" data-logout-session="${x.id}">Abmelden</button>`}</li>`)}</ul>
        ${sessions.sessions.length > 1 ? html`<p><button class="btn btn-secondary" type="button" data-action="logout-others">Alle anderen Geräte abmelden</button></p>` : ''}
        ${sessions.events.length ? html`<details><summary>Letzte Sicherheitsereignisse</summary>
          <ul class="list small">${sessions.events.map((ev) => html`<li class="list-row"><span class="grow">${EVENT_LABELS[ev.event] || ev.event}</span><span class="muted">${formatDateTime(ev.at, me.timezone)}</span></li>`)}</ul></details>` : ''}
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-daten">
        <h2 id="s-daten">Meine Daten</h2>
        <p class="muted">Laden Sie alle Ihre Briefe und Angaben als ZIP-Datei herunter oder löschen Sie Ihr Konto vollständig.</p>
        <div class="row">
          <button class="btn btn-secondary" type="button" data-action="export">${icon('download')}Alle Daten herunterladen</button>
          <button class="btn btn-danger" type="button" data-action="delete-account">${icon('trash')}Konto löschen</button>
        </div>
      </section>

      <section class="panel stack settings-section" aria-labelledby="s-pro">
        <h2 id="s-pro">BriefPilot Pro</h2>
        <p class="muted">Kalender-Abgleich, Familienprofile mit Freigaben und mehr – als Vorschau.</p>
        <p><a class="btn btn-secondary" href="#/pro">${icon('star')}Pro-Vorschau ansehen</a></p>
      </section>

      <p><button class="btn btn-ghost" type="button" data-action="logout">${icon('logout')}Abmelden</button></p>
    </div>`);
  }

  root.addEventListener('change', (e) => {
    if (e.target.name === 'textsize') {
      try {
        localStorage.setItem('bp-textsize', e.target.value);
      } catch {
        /* Speicher nicht verfügbar */
      }
      applyTextSize();
    }
    if (e.target.name === 'theme') {
      try {
        localStorage.setItem('bp-theme', e.target.value);
      } catch {
        /* Speicher nicht verfügbar */
      }
      applyTheme();
    }
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    clearErrors(form);
    const v = formValues(form);
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        if (form.dataset.form === 'profile') {
          await api.patch('/api/me', { name: v.name });
        } else if (form.dataset.form === 'reminders') {
          await api.patch('/api/me', { settings: { reminderOffsets: v.reminderOffsets || [], reminderTime: v.reminderTime, emailReminders: v.emailReminders, notificationDetails: v.notificationDetails } });
        }
        await refreshMe();
        toast('Gespeichert.');
      } catch (err) {
        showError(form, err);
      }
    });
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action], [data-consent], [data-logout-session], [data-person-edit], [data-person-delete], [data-address-edit], [data-address-delete]');
    if (!el) return;
    try {
      const { persons, addresses } = current.household;
      if (el.dataset.personEdit) {
        personDialog(persons.find((x) => x.id === el.dataset.personEdit));
        return;
      }
      if (el.dataset.addressEdit) {
        addressDialog(addresses.find((x) => x.id === el.dataset.addressEdit));
        return;
      }
      if (el.dataset.personDelete || el.dataset.addressDelete) {
        const isPerson = Boolean(el.dataset.personDelete);
        const item = isPerson ? persons.find((x) => x.id === el.dataset.personDelete) : addresses.find((x) => x.id === el.dataset.addressDelete);
        if (await confirmDialog({
          title: isPerson ? 'Person entfernen?' : 'Adresse entfernen?',
          body: `„${isPerson ? item.name : item.label}“ wird aus dem Haushalt entfernt. Briefe und Akten bleiben erhalten.`,
          confirmLabel: 'Entfernen', danger: true,
        })) {
          await api.del(isPerson ? `/api/persons/${item.id}` : `/api/addresses/${item.id}`);
          forgetHousehold();
          toast('Entfernt.');
          await draw();
        }
        return;
      }
      if (el.dataset.consent) {
        await api.post('/api/me/ai-consent', { consent: el.dataset.consent });
        await refreshMe();
        toast(el.dataset.consent === 'ja' ? 'KI-Auswertung ist erlaubt.' : 'KI-Auswertung wird nicht mehr verwendet.');
        await draw();
        return;
      }
      if (el.dataset.logoutSession) {
        await api.del(`/api/me/sessions/${el.dataset.logoutSession}`);
        toast('Gerät abgemeldet.');
        await draw();
        return;
      }
      const action = el.dataset.action;
      if (action === 'logout') {
        await api.post('/api/auth/logout');
        state.me = null;
        navigate('/anmelden');
      } else if (action === 'logout-others') {
        const r = await api.post('/api/me/sessions/logout-others');
        toast(`${r.removed} Gerät(e) abgemeldet.`);
        await draw();
      } else if (action === 'export') {
        await busy(el, () => download('/api/me/export', 'briefpilot-export.zip'));
        toast('Export heruntergeladen.');
      } else if (action === 'push-on') {
        const ps = await pushState(state.status);
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          toast('Benachrichtigungen wurden nicht erlaubt.', { error: true });
          return;
        }
        const sub = await ps.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(state.status.push.publicKey) });
        await api.post('/api/push/subscribe', sub.toJSON());
        toast('Benachrichtigungen sind eingeschaltet.');
        await draw();
      } else if (action === 'push-off') {
        const ps = await pushState(state.status);
        if (ps.sub) {
          await api.post('/api/push/unsubscribe', { endpoint: ps.sub.endpoint });
          await ps.sub.unsubscribe();
        }
        toast('Benachrichtigungen sind ausgeschaltet.');
        await draw();
      } else if (action === 'push-test') {
        const r = await api.post('/api/push/test');
        toast(r.sent ? 'Test gesendet. Die Benachrichtigung sollte gleich erscheinen.' : 'Der Test konnte nicht zugestellt werden.', { error: !r.sent });
      } else if (action === 'password') {
        changePassword();
      } else if (action === 'delete-account') {
        deleteAccount();
      } else if (action === 'person-add') {
        personDialog();
      } else if (action === 'address-add') {
        addressDialog();
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  function changePassword() {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Passwort ändern</h2>
      <div class="field"><label for="pw-old">Aktuelles Passwort</label><input class="input" type="password" id="pw-old" name="currentPassword" autocomplete="current-password"></div>
      <div class="field"><label for="pw-new">Neues Passwort</label><input class="input" type="password" id="pw-new" name="newPassword" autocomplete="new-password"><p class="hint">Mindestens 10 Zeichen.</p></div>
      <p class="small muted">Andere Geräte werden danach abgemeldet.</p>
      <div class="row"><button class="btn" type="submit">Passwort ändern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post('/api/me/password', formValues(form));
            close();
            toast('Passwort geändert.');
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function deleteAccount() {
    const demo = state.me.isDemo || state.me.isGuest;
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Konto endgültig löschen</h2>
      <p>Alle Briefe, Erklärungen, Aufgaben, Erinnerungen und Ihr Konto werden sofort gelöscht. Das kann nicht rückgängig gemacht werden.</p>
      <p class="muted">Tipp: Laden Sie vorher Ihre Daten herunter.</p>
      ${demo ? '' : html`<div class="field"><label for="d-pw">Ihr Passwort</label><input class="input" type="password" id="d-pw" name="password" autocomplete="current-password"></div>`}
      <div class="field"><label for="d-confirm">Zur Bestätigung LÖSCHEN eingeben</label><input class="input" id="d-confirm" name="confirm" autocomplete="off"></div>
      <div class="row"><button class="btn btn-danger" type="submit">Konto endgültig löschen</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = formValues(form);
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post('/api/me/delete', { password: v.password, confirm: v.confirm.trim().toUpperCase() });
            close();
            state.me = null;
            toast('Ihr Konto und alle Daten wurden gelöscht.');
            navigate('/anmelden');
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  void confirmDialog;
  await draw();
}
