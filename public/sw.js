// Service Worker: macht BriefPilot installierbar, hält die App-Oberfläche offline bereit
// und zeigt Push-Benachrichtigungen. Briefe und persönliche Daten werden bewusst NICHT
// zwischengespeichert – sie liegen nur auf dem Server.
const VERSION = 'briefpilot-v5';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/app.js', '/js/api.js', '/js/html.js', '/js/ui.js',
  '/js/shared/dates.js', '/js/shared/constants.js', '/js/shared/identifiers.js',
  '/js/views/auth.js', '/js/views/overview.js', '/js/views/letters.js', '/js/views/letter.js',
  '/js/views/scan.js', '/js/views/tasks.js', '/js/views/settings.js', '/js/views/info.js',
  '/js/views/parts.js', '/js/views/assign.js', '/js/views/inbox.js', '/js/views/objects.js',
  '/js/views/objectDialog.js', '/js/views/replies.js',
  '/js/scanner/imageproc.js', '/js/scanner/processing.js', '/js/scanner/worker.js',
  '/js/scanner/camera.js', '/js/scanner/editor.js', '/js/scanner/overlay.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // Daten nie zwischenspeichern
  // Erst Netz (immer aktuelle Version), bei fehlender Verbindung die gespeicherte Oberfläche
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'BriefPilot', {
      body: data.body || 'Sie haben eine Erinnerung.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'briefpilot',
      data: { url: data.url || '/#/aufgaben' },
      lang: 'de',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
