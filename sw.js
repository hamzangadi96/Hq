/* Cacaoboetiek HQ — service worker
   Verhoog VERSIE bij elke nieuwe upload. */
const VERSIE = 'hq-v923';

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

/* ═══════════ een half antwoord is ook geen antwoord (v806) ═══════════
   index.html is 2 MB. Bij één streepje bereik kwam het begin binnen (opmaak
   en de twee ronde knoppen) en brak de verbinding af vóór het script. Dat
   halve bestand werd gewoon getoond: een grijs scherm met twee lege rondjes.
   Nu lezen we het hele bestand eerst in en kijken of het echt af is (eindigt
   op </html>). Pas dan tonen en cachen we het; anders de laatste goede kopie. */
async function heel(r, isHtml){
  if(!r || !r.ok) throw new Error('fout');
  const tekst = await r.text();               /* wacht op het hele bestand */
  if(isHtml){
    if(tekst.length < 500 || !/<\/html>\s*$/i.test(tekst)) throw new Error('half');
  } else if(tekst.length < 50) throw new Error('leeg');
  return new Response(tekst, { status: 200, headers: {
    'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8'
  }});
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

  /* Adressen (PDOK, OpenStreetMap) en routes (OSRM) gaan rechtstreeks naar
     het netwerk: die horen niet in de cache en mogen nooit vastlopen in de
     service worker (v719). */
  if (url.origin !== self.location.origin) return;

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
    const sleutel = new Request(url.origin + url.pathname);
    const isHtml = !url.pathname.endsWith('config.js');
    /* de laatste kopie waarvan we zeker weten dat hij heel is */
    const uitCache = () => caches.match(sleutel).then(r => r ||
      (isHtml ? caches.match(new Request(url.origin + '/index.html')) : undefined));
    const vers = (opties) => fetch(req, opties).then(r => heel(r, isHtml)).then(r => {
      const kopie = r.clone();
      caches.open(VERSIE).then(c => c.put(sleutel, kopie));
      return r;
    });

    /* Bewust op vernieuwen getikt (?v= achter het adres): geen cache-geduld,
       wel nog steeds alleen een heel bestand. */
    if (url.search.includes('v=')) {
      e.respondWith(vers({ cache: 'no-store' }).catch(() =>
        uitCache().then(r => r || fetch(req))));
      return;
    }

    /* ═════ eerst het netwerk, de cache als vangnet ═════
       Acht seconden voor het héle bestand (vroeger vier seconden tot de eerste
       bytes — daarna kon het alsnog halverwege afbreken). Lukt dat niet, dan de
       laatste goede kopie. Is er nog geen kopie, dan wachten we gewoon door. */
    e.respondWith((async () => {
      const netwerk = vers();
      const binnenTijd = new Promise((klaar, mis) => {
        const val = setTimeout(() => mis(new Error('traag')), 8000);
        netwerk.then(r => { clearTimeout(val); klaar(r) }, err => { clearTimeout(val); mis(err) });
      });
      try { return await binnenTijd }
      catch (err) {
        const oud = await uitCache();
        if (oud) return oud;
        try { return await netwerk } catch (e2) { return fetch(req) }
      }
    })());
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
