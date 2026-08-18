/* Cacaoboetiek HQ — service worker
   Verhoog VERSIE bij elke nieuwe upload. */
const VERSIE = 'hq-v444';

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
    /* Hier stond: altijd vers ophalen met cache no-store. Dat gaf je gegarandeerd
       de nieuwste versie, maar index.html is inmiddels ruim een megabyte. Elke
       start en elke verversing haalde dat opnieuw over je mobiele verbinding op,
       en je keek net zo lang naar een leeg scherm.

       Nu: meteen tonen wat er in de cache staat en ondertussen op de achtergrond
       de nieuwe ophalen. De app opent direct; bij de volgende start draai je
       vanzelf de nieuwe. Tik je bewust op vernieuwen, dan staat er ?v= achter
       het adres en slaan we de cache over — dan krijg je hem meteen. */
    const sleutel = new Request(url.origin + url.pathname);

    if (url.search.includes('v=')) {
      e.respondWith(
        fetch(req, { cache: 'no-store' })
          .then(r => {
            const kopie = r.clone();
            caches.open(VERSIE).then(c => c.put(sleutel, kopie));
            return r;
          })
          .catch(() => caches.match(sleutel).then(r => r || caches.match('./index.html')))
      );
      return;
    }

    e.respondWith(
      caches.match(sleutel).then(uitCache => {
        const vers = fetch(req)
          .then(r => {
            if (r && r.ok) {
              const kopie = r.clone();
              caches.open(VERSIE).then(c => c.put(sleutel, kopie));
            }
            return r;
          })
          .catch(() => null);
        /* Staat er niets in de cache — eerste bezoek — dan wachten we wel. */
        return uitCache || vers.then(r => r || caches.match('./index.html'));
      })
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
