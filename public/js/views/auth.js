// Anmelden, Registrieren, Passwort vergessen / neu setzen.
import { html, mount } from '../html.js';
import { api } from '../api.js';
import { icon, LOGO, formValues, showError, clearErrors, busy, toast } from '../ui.js';
import { PASSWORD_MIN_LENGTH } from '../shared/constants.js';

function brand(subtitle) {
  return html`<div class="brand-mark">${LOGO}<div><strong>BriefPilot</strong><span>${subtitle}</span></div></div>`;
}

function statusHint(state) {
  const ai = state.status?.ai?.enabled;
  return html`<p class="small muted">${ai
    ? 'Briefe werden auf diesem Server mit KI ausgewertet – nur, wenn Sie zustimmen.'
    : 'Auf diesem Server ist keine KI-Auswertung eingerichtet.'}
    <a href="#/status">Was funktioniert echt?</a> · <a href="#/datenschutz">Datenschutz</a></p>`;
}

export async function renderLogin({ root, state, navigate, refreshMe }) {
  mount(root, html`<div class="auth stack-l">
    ${brand('Post verstehen. Fristen im Blick.')}
    <form class="stack" novalidate>
      <h1>Anmelden</h1>
      <div class="field"><label for="email">E-Mail-Adresse</label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
      <div class="field"><label for="password">Passwort</label>
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-block" type="submit">Anmelden</button>
      <p class="row"><a href="#/passwort-vergessen">Passwort vergessen?</a></p>
    </form>
    <div class="stack">
      <div class="divider">oder</div>
      <button class="btn btn-block" type="button" data-guest>${icon('check')}Ohne Konto fortfahren</button>
      <p class="small muted">Ihre Briefe bleiben dann nur auf diesem Gerät erreichbar. Kein Passwort nötig.</p>
      <a class="btn btn-secondary btn-block" href="#/registrieren">${icon('plus')}Neues Konto erstellen</a>
      ${state.status?.demoEnabled ? html`
        <div class="divider">oder</div>
        <button class="btn btn-ghost btn-block" type="button" data-demo>${icon('eye')}Demo mit Beispielbriefen ansehen</button>
        <p class="small muted">Die Demo nutzt erfundene Briefe. Sie brauchen dafür kein Konto. Bitte keine echten Briefe in der Demo hochladen.</p>` : ''}
    </div>
    ${statusHint(state)}
  </div>`);

  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const v = formValues(form);
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        await api.post('/api/auth/login', { email: v.email, password: v.password });
        await refreshMe();
        navigate('/');
      } catch (err) {
        showError(form, err);
      }
    });
  });
  root.querySelector('[data-guest]')?.addEventListener('click', async (e) => {
    await busy(e.currentTarget, async () => {
      try {
        await api.post('/api/auth/guest');
        await refreshMe();
        navigate('/');
      } catch (err) {
        toast(err.message || 'Das hat nicht geklappt. Bitte erneut versuchen.', { error: true });
      }
    });
  });
  root.querySelector('[data-demo]')?.addEventListener('click', async (e) => {
    await busy(e.currentTarget, async () => {
      try {
        await api.post('/api/auth/demo');
        await refreshMe();
        navigate('/');
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  });
}

export async function renderRegister({ root, state, navigate, refreshMe }) {
  mount(root, html`<div class="auth stack-l">
    ${brand('Konto erstellen')}
    <form class="stack" novalidate>
      <h1>Neues Konto</h1>
      <p class="muted">Mit einem Konto sind Ihre Briefe auf Handy, Tablet und Computer verfügbar.</p>
      <div class="field"><label for="name">Ihr Vorname <span class="muted">(freiwillig)</span></label>
        <input class="input" id="name" name="name" autocomplete="given-name" maxlength="80"></div>
      <div class="field"><label for="email">E-Mail-Adresse</label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
      <div class="field"><label for="password">Passwort</label>
        <input class="input" id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
        <p class="hint">Mindestens ${PASSWORD_MIN_LENGTH} Zeichen. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.</p></div>
      <div class="field"><label for="password2">Passwort wiederholen</label>
        <input class="input" id="password2" name="password2" type="password" autocomplete="new-password" required></div>
      <label class="check check-strong"><input type="checkbox" name="acceptPrivacy">
        <span>Ich habe die <a href="#/datenschutz" target="_blank" rel="noopener">Hinweise zum Datenschutz</a> gelesen.</span></label>
      <p class="small muted">Ob Ihre Briefe mit KI ausgewertet werden dürfen, fragen wir Sie separat vor dem ersten Scannen.</p>
      <button class="btn btn-block" type="submit">Konto erstellen</button>
    </form>
    <p><a href="#/anmelden">Ich habe schon ein Konto</a></p>
    ${statusHint(state)}
  </div>`);
  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const v = formValues(form);
    if (v.password !== v.password2) {
      showError(form, { message: 'Die beiden Passwörter stimmen nicht überein.', field: 'password2' });
      return;
    }
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        await api.post('/api/auth/register', { name: v.name, email: v.email, password: v.password, acceptPrivacy: v.acceptPrivacy });
        await refreshMe();
        toast('Ihr Konto ist eingerichtet.');
        navigate('/');
      } catch (err) {
        showError(form, err);
      }
    });
  });
}

export async function renderForgot({ root, state }) {
  mount(root, html`<div class="auth stack-l">
    ${brand('Passwort zurücksetzen')}
    <form class="stack" novalidate>
      <h1>Passwort vergessen</h1>
      <p class="muted">Geben Sie Ihre E-Mail-Adresse ein. Wir schicken Ihnen einen Link, mit dem Sie ein neues Passwort festlegen können.</p>
      <div class="field"><label for="email">E-Mail-Adresse</label>
        <input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
      <button class="btn btn-block" type="submit">Link anfordern</button>
    </form>
    <div data-result></div>
    <p><a href="#/anmelden">Zurück zur Anmeldung</a></p>
    ${statusHint(state)}
  </div>`);
  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        const res = await api.post('/api/auth/forgot', { email: formValues(form).email });
        const extra = res.mail === 'simuliert'
          ? html`<p class="small"><strong>Entwicklungsmodus:</strong> Auf diesem Server ist kein E-Mail-Versand eingerichtet. Es wurde keine E-Mail verschickt. Den Link finden Sie im Server-Fenster (Terminal).</p>`
          : res.mail === 'nicht_eingerichtet'
            ? html`<p class="small"><strong>Hinweis:</strong> Auf diesem Server ist kein E-Mail-Versand eingerichtet. Bitte wenden Sie sich an den Betreiber.</p>`
            : '';
        mount(root.querySelector('[data-result]'), html`<div class="note note-ok" role="status">${icon('mail')}<div class="stack">
          <p>Wenn es ein Konto mit dieser Adresse gibt, ist ein Link unterwegs. Er ist 60 Minuten gültig. Schauen Sie auch im Spam-Ordner nach.</p>${extra}</div></div>`);
        form.hidden = true;
      } catch (err) {
        showError(form, err);
      }
    });
  });
}

export async function renderReset({ root, query, navigate }) {
  const token = query.get('token') || '';
  mount(root, html`<div class="auth stack-l">
    ${brand('Neues Passwort festlegen')}
    ${token ? html`<form class="stack" novalidate>
      <h1>Neues Passwort</h1>
      <div class="field"><label for="password">Neues Passwort</label>
        <input class="input" id="password" name="password" type="password" autocomplete="new-password" required>
        <p class="hint">Mindestens ${PASSWORD_MIN_LENGTH} Zeichen.</p></div>
      <div class="field"><label for="password2">Passwort wiederholen</label>
        <input class="input" id="password2" name="password2" type="password" autocomplete="new-password" required></div>
      <p class="small muted">Aus Sicherheitsgründen werden Sie danach auf allen Geräten abgemeldet.</p>
      <button class="btn btn-block" type="submit">Passwort speichern</button>
    </form>` : html`<div class="note note-danger">${icon('alert')}<p>Dieser Link ist unvollständig. Bitte fordern Sie einen neuen an.</p></div>
      <a class="btn btn-secondary" href="#/passwort-vergessen">Neuen Link anfordern</a>`}
  </div>`);
  const form = root.querySelector('form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const v = formValues(form);
    if (v.password !== v.password2) {
      showError(form, { message: 'Die beiden Passwörter stimmen nicht überein.', field: 'password2' });
      return;
    }
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        await api.post('/api/auth/reset', { token, password: v.password });
        toast('Ihr neues Passwort ist gespeichert. Bitte melden Sie sich an.');
        history.replaceState(null, '', '#/anmelden');
        navigate('/anmelden');
      } catch (err) {
        showError(form, err);
      }
    });
  });
}
