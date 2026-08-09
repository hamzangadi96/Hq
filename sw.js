/* Cacaoboetiek HQ - service worker
   Doel: de app start ook zonder verbinding. Verhoog VERSIE bij elke nieuwe deploy. */
const VERSIE = 'hq-v2';
const SCHIL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIE).then(c => c.addAll(SCHIL)).then(() => self.skipWaiting()));
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

  /* Firebase en fonts nooit uit de cache serveren */
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseapp.com')) return;

  /* de app zelf: eerst het netwerk, anders de cache */
  if (req.mode === 'navigate' || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(req).then(r => {
        const kopie = r.clone();
        caches.open(VERSIE).then(c => c.put(req, kopie));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* de rest: eerst de cache, anders het netwerk */
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok && url.origin === location.origin) {
        const kopie = res.clone();
        caches.open(VERSIE).then(c => c.put(req, kopie));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
