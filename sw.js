/* Cacaoboetiek HQ — service worker
   Verhoog VERSIE bij elke nieuwe upload. */
const VERSIE = 'hq-v390';

/* alleen plaatjes en manifest cachen; de app zelf halen we altijd vers op */
const SCHIL = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  /* Firebase staat sinds v341 in je eigen repo in plaats van bij Google.
     Gecachet, want zonder deze bestanden werkt inloggen en synchroniseren niet. */
  './firebase-app-compat.js',
  './firebase-auth-compat.js',
  './firebase-database-compat.js',
  './firebase-functions-compat.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSIE)
      .then(c => c.addAll(SCHIL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(n => n !== VERSIE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* Firebase en lettertypes nooit onderscheppen */
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('firebasedatabase.app') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('firebaseapp.com')) return;

  const isApp = req.mode === 'navigate' ||
                url.pathname.endsWith('/') ||
                url.pathname.endsWith('index.html') ||
                url.pathname.endsWith('config.js');

  if (isApp) {
    /* altijd vers ophalen, buiten elke cache om; alleen als noodgreep uit de cache */
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(r => {
          const kopie = r.clone();
          caches.open(VERSIE).then(c => c.put(req, kopie));
          return r;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  /* plaatjes en manifest: eerst uit de cache */
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok && url.origin === location.origin) {
        const kopie = res.clone();
        caches.open(VERSIE).then(c => c.put(req, kopie));
      }
      return res;
    }))
  );
});
