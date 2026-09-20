/* Cacaoboetiek HQ — service worker
   Verhoog VERSIE bij elke nieuwe upload. */
const VERSIE = 'hq-v659';

/* ═══════════ een leeg antwoord is geen antwoord ═══════════
   Een mislukte upload leverde een bestand van nul bytes op. De server gaf
   daar netjes HTTP 200 bij, dus dit werd gecachet en daarna bij elke start
   als eerste getoond: een wit scherm dat zichzelf in stand hield. Vanaf nu
   telt een antwoord alleen als het ook inhoud heeft. */
function deugt(r){
  if(!r || !r.ok) return false;
  const n = r.headers.get('content-length');
  return n === null ? true : (+n) > 500;
}

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
      .then(() => caches.keys())
      .then(k => Promise.all(k.filter(n => n !== VERSIE).map(n => caches.delete(n))))
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

  /* Studio is één groot bestand dat bijna dagelijks verandert, en offline kan
     hij toch niets zonder je videobestanden. Dus altijd vers ophalen, met de
     cache alleen als vangnet wanneer je even geen verbinding hebt. */
  if (url.pathname.endsWith('studio.html')) {
    const sleutel = new Request(url.origin + url.pathname);
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(r => {
          if (deugt(r)) {
            const kopie = r.clone();
            caches.open(VERSIE).then(c => c.put(sleutel, kopie));
          }
          return r;
        })
        .catch(() => caches.match(sleutel))
    );
    return;
  }

  const isApp = req.mode === 'navigate' ||
                url.pathname.endsWith('/') ||
                url.pathname.endsWith('index.html') ||
                url.pathname.endsWith('config.js');

  if (isApp) {
    /* Meteen tonen wat er in de cache staat en ondertussen op de achtergrond de
       nieuwe ophalen. De app opent direct; bij de volgende start draai je vanzelf
       de nieuwe. Tik je bewust op vernieuwen, dan staat er ?v= achter het adres
       en slaan we de cache over — dan krijg je hem meteen. */
    const sleutel = new Request(url.origin + url.pathname);

    if (url.search.includes('v=')) {
      e.respondWith(
        fetch(req, { cache: 'no-store' })
          .then(r => {
            if (deugt(r)) {
              const kopie = r.clone();
              caches.open(VERSIE).then(c => c.put(sleutel, kopie));
            }
            return r;
          })
          .catch(() => caches.match(sleutel).then(r => deugt(r) ? r : caches.match('./index.html')))
      );
      return;
    }

    /* ═════ eerst het netwerk, de cache als vangnet ═════
       Dit was andersom: eerst tonen wat er in de cache stond en ondertussen de
       nieuwe ophalen. Handig voor een app die zelden verandert, maar jij rolt
       er meerdere per dag uit — en dan zie je je eigen wijziging pas de
       keér daarna. Nu halen we hem vers op, met vier seconden geduld; lukt
       dat niet, dan pakken we de cache zodat je offline gewoon doorwerkt. */
    e.respondWith(
      new Promise((klaar, mis) => {
        let af = false;
        const val = setTimeout(() => { if (!af) mis(new Error('traag')) }, 4000);
        fetch(req).then(r => {
          if (!deugt(r)) throw new Error('leeg');
          af = true; clearTimeout(val);
          const kopie = r.clone();
          caches.open(VERSIE).then(c => c.put(sleutel, kopie));
          klaar(r);
        }).catch(err => { clearTimeout(val); mis(err) });
      }).catch(() =>
        caches.match(sleutel).then(r => deugt(r) ? r : caches.match('./index.html'))
      )
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
