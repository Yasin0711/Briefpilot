// Einstiegspunkt der Oberfläche: Seitenwechsel (Router), Navigation, Anmeldestatus.
import { html, mount } from './html.js';
import { api, setUnauthorizedHandler } from './api.js';
import { icon, LOGO } from './ui.js';
import * as auth from './views/auth.js';
import * as overview from './views/overview.js';
import * as letters from './views/letters.js';
import * as letter from './views/letter.js';
import * as scan from './views/scan.js';
import * as tasks from './views/tasks.js';
import * as settings from './views/settings.js';
import * as info from './views/info.js';
import * as inbox from './views/inbox.js';
import * as objects from './views/objects.js';

export const state = { me: null, status: null, counts: { tasksToReview: 0, inbox: 0 } };

const ROUTES = [
  { path: /^\/$/, view: overview.render, nav: 'uebersicht', title: 'Übersicht' },
  { path: /^\/briefe$/, view: letters.render, nav: 'briefe', title: 'Briefe' },
  { path: /^\/briefe\/([\w-]+)$/, view: letter.render, nav: 'briefe', title: 'Brief', keys: ['id'], wide: true },
  { path: /^\/zuordnen$/, view: inbox.render, nav: 'briefe', title: 'Briefe zuordnen' },
  { path: /^\/akten$/, view: objects.renderList, nav: 'briefe', title: 'Akten' },
  { path: /^\/akten\/([\w-]+)$/, view: objects.renderDetail, nav: 'briefe', title: 'Akte', keys: ['id'] },
  { path: /^\/scannen$/, view: scan.render, nav: 'scannen', title: 'Brief scannen' },
  { path: /^\/aufgaben$/, view: tasks.render, nav: 'aufgaben', title: 'Aufgaben und Termine' },
  { path: /^\/einstellungen$/, view: settings.render, nav: 'einstellungen', title: 'Einstellungen' },
  { path: /^\/pro$/, view: info.renderPro, nav: 'einstellungen', title: 'Pro-Vorschau' },
  { path: /^\/datenschutz$/, view: info.renderPrivacy, public: true, title: 'Datenschutz und KI' },
  { path: /^\/status$/, view: info.renderStatus, public: true, title: 'Was funktioniert echt?' },
  { path: /^\/anmelden$/, view: auth.renderLogin, public: true, guestOnly: true, title: 'Anmelden' },
  { path: /^\/registrieren$/, view: auth.renderRegister, public: true, guestOnly: true, title: 'Konto erstellen' },
  { path: /^\/passwort-vergessen$/, view: auth.renderForgot, public: true, guestOnly: true, title: 'Passwort vergessen' },
  { path: /^\/passwort-neu$/, view: auth.renderReset, public: true, title: 'Neues Passwort' },
];

const NAV = [
  { id: 'uebersicht', href: '#/', label: 'Übersicht', icon: 'home' },
  { id: 'briefe', href: '#/briefe', label: 'Briefe', icon: 'mail', badge: 'inbox', badgeLabel: 'Briefe zuordnen' },
  { id: 'scannen', href: '#/scannen', label: 'Scannen', icon: 'camera', scan: true },
  { id: 'aufgaben', href: '#/aufgaben', label: 'Aufgaben', icon: 'tasks', badge: 'tasksToReview', badgeLabel: 'zu prüfen' },
  { id: 'einstellungen', href: '#/einstellungen', label: 'Einstellungen', icon: 'settings' },
];

let cleanup = null;
let renderToken = 0;

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

export async function refreshMe() {
  try {
    const { user } = await api.get('/api/me');
    state.me = user;
  } catch {
    state.me = null;
  }
  return state.me;
}

function setCount(key, n) {
  state.counts[key] = n || 0;
  const badge = document.querySelector(`.nav-badge[data-count="${key}"]`);
  if (badge) {
    badge.textContent = n || 0;
    badge.hidden = !n;
  }
}

/** Anzahl der zu prüfenden Angaben (Aufgaben) im Menü. */
export function setReviewCount(n) {
  setCount('tasksToReview', n);
}

/** Anzahl der Briefe, die auf eine Zuordnung warten (Briefe → Zuordnen). */
export function setInboxCount(n) {
  setCount('inbox', n);
}

function renderNav(active) {
  const nav = document.getElementById('nav');
  nav.hidden = !state.me;
  if (!state.me) return;
  mount(nav, html`
    <a class="nav-brand" href="#/">${LOGO}<span>BriefPilot</span></a>
    <ul class="nav-list">
      ${NAV.map((item) => html`<li>
        <a class="nav-item ${item.scan ? 'nav-scan' : ''}" href="${item.href}" ${active === item.id ? html`aria-current="page"` : ''}>
          ${item.scan ? html`<span class="nav-scan-disc">${icon(item.icon)}</span>` : icon(item.icon)}
          <span>${item.scan ? html`<span class="nav-scan-label">${item.label}</span>` : item.label}</span>
          ${item.badge ? html`<span class="nav-badge" data-count="${item.badge}" ${state.counts[item.badge] ? '' : html`hidden`} aria-label="${item.badgeLabel}">${state.counts[item.badge]}</span>` : ''}
        </a></li>`)}
    </ul>`);
}

function renderBanner() {
  const slot = document.getElementById('banner');
  if (state.me?.isDemo) {
    mount(slot, html`<div class="banner" role="note">${icon('info')}<span>Demomodus mit erfundenen Beispielbriefen. Bitte laden Sie hier keine echten Briefe hoch. Dieses Demo-Konto wird nach 24 Stunden automatisch gelöscht.</span></div>`);
  } else {
    mount(slot, '');
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(queryString || '') };
}

async function route() {
  const token = ++renderToken;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignorieren */
    }
    cleanup = null;
  }
  const { path, query } = parseHash();
  let match = null;
  let params = {};
  for (const r of ROUTES) {
    const m = r.path.exec(path);
    if (m) {
      match = r;
      (r.keys || []).forEach((k, i) => {
        params[k] = m[i + 1];
      });
      break;
    }
  }
  if (!match) {
    navigate('/');
    return;
  }
  if (!match.public && !state.me) {
    navigate('/anmelden');
    return;
  }
  if (match.guestOnly && state.me) {
    navigate('/');
    return;
  }
  document.title = `${match.title} – BriefPilot`;
  renderNav(match.nav);
  renderBanner();
  const main = document.getElementById('main');
  main.classList.toggle('wide', Boolean(match.wide));
  const root = document.createElement('div');
  main.replaceChildren(root);
  window.scrollTo(0, 0);
  try {
    const result = await match.view({ root, params, query, state, navigate, refreshMe, isCurrent: () => token === renderToken });
    if (token === renderToken && typeof result === 'function') cleanup = result;
  } catch (err) {
    if (token !== renderToken) return;
    mount(root, html`<div class="note note-danger" role="alert">${icon('alert')}<div><strong>Die Seite konnte nicht geladen werden.</strong><p>${err.message}</p>
      <p class="row"><a class="btn btn-secondary btn-small" href="#/">Zur Übersicht</a></p></div></div>`);
  }
  if (token === renderToken && document.activeElement === document.body) main.focus({ preventScroll: true });
}

function applyTextSize() {
  let size = 'normal';
  try {
    size = localStorage.getItem('bp-textsize') || 'normal';
  } catch {
    size = 'normal';
  }
  document.documentElement.classList.toggle('ts-gross', size === 'gross');
  document.documentElement.classList.toggle('ts-sehr-gross', size === 'sehr-gross');
}

/** Hell, Dunkel oder automatisch (Systemeinstellung) – gilt für dieses Gerät. */
export function themeChoice() {
  try {
    const v = localStorage.getItem('bp-theme');
    return v === 'hell' || v === 'dunkel' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

function applyTheme() {
  const choice = themeChoice();
  const root = document.documentElement;
  if (choice === 'hell') root.dataset.theme = 'light';
  else if (choice === 'dunkel') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  const dark = choice === 'dunkel' || (choice === 'auto' && darkQuery?.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1726' : '#eaf3ff');
}
darkQuery?.addEventListener?.('change', applyTheme);

async function start() {
  applyTextSize();
  applyTheme();
  setUnauthorizedHandler(() => {
    state.me = null;
    navigate('/anmelden');
  });
  try {
    state.status = await api.get('/api/status');
  } catch {
    state.status = null;
  }
  await refreshMe();
  if (state.me) {
    api.get('/api/overview').then((o) => {
      setReviewCount(o.counts.tasksToReview);
      setInboxCount(o.counts.inbox);
    }).catch(() => {});
  }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

export { applyTextSize, applyTheme };
start();
