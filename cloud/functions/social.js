/* ═══════════════════════════════════════════════════════════════════
   Social — één video naar Instagram én TikTok

   Instagram: gaat direct live als Reel (Instagram API met Instagram Login,
   geen Facebook-pagina nodig).
   TikTok: komt als concept in je TikTok-inbox. Direct live zetten mag pas
   als TikTok je app heeft goedgekeurd (audit); tot die tijd wordt alles
   privé. Een concept omzeilt dat: jij tikt zelf op posten in TikTok.

   Wat waar staat:
   - geheim/{uid}/instagram  app-ID, geheim en tokens   (app kan er niet bij)
   - geheim/{uid}/tiktok     client key, geheim, tokens
   - geheim/_oauth/{state}   kort briefje tijdens het inloggen
   - werkvloer/{uid}/koppeling/instagram|tiktok   alleen true/false
   - werkvloer/{uid}/posts/{videoId}              uitslag per kanaal
   - opslag: posts/{uid}/{videoId}.mp4            de video zelf
   ═══════════════════════════════════════════════════════════════════ */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const PROJECT = 'cacaoboetiek-hq';
const REGIO = 'europe-west1';
const TERUG_URL = 'https://' + REGIO + '-' + PROJECT + '.cloudfunctions.net/socialTerug';
const APP_URL = 'https://cacaoboetiek-hq.web.app';
const IG_API = 'https://graph.instagram.com/v23.0';
const TT_API = 'https://open.tiktokapis.com/v2';

const db = () => admin.database();
const geheimRef = uid => db().ref('geheim/' + uid);
const werkRef = uid => db().ref('werkvloer/' + uid);
const KANALEN = ['instagram', 'tiktok'];

function wieBenJe(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
  return uid;
}
function kanaal(x) {
  const k = String(x || '');
  if (!KANALEN.includes(k)) throw new HttpsError('invalid-argument', 'Onbekend kanaal.');
  return k;
}
const lees = async (uid, k) => (await geheimRef(uid).child(k).once('value')).val() || null;
const veiligId = x => String(x || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);

async function json(r) {
  const t = await r.text();
  try { return JSON.parse(t) } catch (e) { return { ruw: t.slice(0, 300) } }
}
function igFout(j, wat) {
  const e = (j && j.error) || {};
  return new Error(wat + ': ' + (e.error_user_msg || e.message || j.error_message || j.ruw || 'onbekende fout'));
}
function ttFout(j, wat) {
  const e = (j && j.error) || {};
  return new Error(wat + ': ' + (e.message || j.error_description || e.code || j.ruw || 'onbekende fout'));
}

/* ─────────── 1. App-gegevens bewaren (één keer) ─────────── */

exports.socialApp = onCall(async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const k = kanaal(d.kanaal);
  const id = String(d.id || '').trim();
  const geheim = String(d.geheim || '').trim();
  if (!id || !geheim) throw new HttpsError('invalid-argument', 'Vul ID en geheim in.');
  /* Nieuwe app-gegevens = opnieuw inloggen, dus oude tokens weg. */
  await geheimRef(uid).child(k).set({ id, geheim });
  await werkRef(uid).child('koppeling/' + k).remove();
  return { ok: true, terug: TERUG_URL };
});

/* ─────────── 2. Inloggen starten ─────────── */

exports.socialStart = onCall(async req => {
  const uid = wieBenJe(req);
  const k = kanaal((req.data || {}).kanaal);
  const g = await lees(uid, k);
  if (!g || !g.id) throw new HttpsError('failed-precondition', 'Vul eerst je app-gegevens in.');

  const state = crypto.randomBytes(24).toString('hex');
  await db().ref('geheim/_oauth/' + state).set({ uid, kanaal: k, tijd: Date.now() });

  let url;
  if (k === 'instagram') {
    url = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
      client_id: g.id, redirect_uri: TERUG_URL, response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state
    });
  } else {
    url = 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
      client_key: g.id, redirect_uri: TERUG_URL, response_type: 'code',
      scope: 'user.info.basic,video.upload',
      state
    });
  }
  return { url };
});

/* ─────────── 3. Terugkomst na inloggen ─────────── */

function pagina(res, ok, tekst) {
  res.status(ok ? 200 : 400).set('Content-Type', 'text/html; charset=utf-8').send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>HQ</title>
     <body style="font-family:Inter,system-ui,sans-serif;background:#f4f4f5;margin:0;
       display:flex;align-items:center;justify-content:center;min-height:100vh">
     <div style="background:#fff;border-radius:18px;padding:28px;max-width:340px;margin:20px;text-align:center">
       <div style="font-size:40px">${ok ? '✓' : '!'}</div>
       <h2 style="margin:8px 0;color:${ok ? '#15803d' : '#c0392b'}">${ok ? 'Gekoppeld' : 'Niet gelukt'}</h2>
       <p style="color:#52525b;line-height:1.5">${tekst}</p>
       <a href="${APP_URL}" style="display:block;margin-top:18px;background:#18181b;color:#fff;
         padding:14px;border-radius:14px;text-decoration:none;font-weight:600">Terug naar HQ</a>
     </div></body>`);
}

async function igWissel(g, code) {
  /* korte token (1 uur) */
  const r1 = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: g.id, client_secret: g.geheim, grant_type: 'authorization_code',
      redirect_uri: TERUG_URL, code
    })
  });
  const j1 = await json(r1);
  if (!r1.ok || !j1.access_token) throw igFout(j1, 'Instagram-token');
  /* lange token (60 dagen) */
  const r2 = await fetch('https://graph.instagram.com/access_token?' + new URLSearchParams({
    grant_type: 'ig_exchange_token', client_secret: g.geheim, access_token: j1.access_token
  }));
  const j2 = await json(r2);
  if (!r2.ok || !j2.access_token) throw igFout(j2, 'Instagram lange token');
  const r3 = await fetch(IG_API + '/me?' + new URLSearchParams({
    fields: 'user_id,username', access_token: j2.access_token
  }));
  const j3 = await json(r3);
  return {
    token: j2.access_token,
    verloopt: Date.now() + (Number(j2.expires_in) || 5184000) * 1000,
    ververst: Date.now(),
    ig_id: String(j3.user_id || j1.user_id || ''),
    naam: j3.username || ''
  };
}

async function ttWissel(g, code) {
  const r = await fetch(TT_API + '/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: g.id, client_secret: g.geheim, code,
      grant_type: 'authorization_code', redirect_uri: TERUG_URL
    })
  });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw ttFout(j, 'TikTok-token');
  return ttBewaarVorm(j);
}
const ttBewaarVorm = j => ({
  token: j.access_token,
  verloopt: Date.now() + (Number(j.expires_in) || 86400) * 1000,
  ververs: j.refresh_token,
  ververs_tot: Date.now() + (Number(j.refresh_expires_in) || 31536000) * 1000,
  open_id: j.open_id || ''
});

exports.socialTerug = onRequest({ invoker: 'public', cors: false }, async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '').replace(/#_$/, '');
  if (!/^[0-9a-f]{48}$/.test(state)) return pagina(res, false, 'Deze link klopt niet. Begin opnieuw vanuit HQ.');

  const ref = db().ref('geheim/_oauth/' + state);
  const b = (await ref.once('value')).val();
  await ref.remove();
  if (!b || Date.now() - b.tijd > 15 * 60 * 1000) {
    return pagina(res, false, 'Te lang gewacht. Begin opnieuw vanuit HQ.');
  }
  if (!code) {
    const w = String(req.query.error_description || req.query.error || 'geen toestemming gegeven');
    return pagina(res, false, 'Inloggen afgebroken: ' + w.replace(/[<>]/g, ''));
  }
  try {
    const g = await lees(b.uid, b.kanaal);
    if (!g) throw new Error('app-gegevens ontbreken');
    const t = b.kanaal === 'instagram' ? await igWissel(g, code) : await ttWissel(g, code);
    await geheimRef(b.uid).child(b.kanaal).update(t);
    await werkRef(b.uid).child('koppeling/' + b.kanaal).set(true);
    return pagina(res, true, (b.kanaal === 'instagram' ? 'Instagram' : 'TikTok') +
      ' hangt nu aan HQ. Je kunt dit venster sluiten.');
  } catch (e) {
    console.error('socialTerug', b.kanaal, e.message);
    return pagina(res, false, String(e.message).replace(/[<>]/g, ''));
  }
});

/* ─────────── tokens vers houden ─────────── */

async function igToken(uid) {
  const g = await lees(uid, 'instagram');
  if (!g || !g.token) throw new Error('Instagram is niet gekoppeld.');
  if (Date.now() > g.verloopt) throw new Error('Instagram-koppeling verlopen. Koppel opnieuw.');
  /* Elke 7 dagen verlengen; dan verloopt hij nooit zolang je HQ gebruikt. */
  if (Date.now() - (g.ververst || 0) > 7 * 86400000) {
    const r = await fetch('https://graph.instagram.com/refresh_access_token?' + new URLSearchParams({
      grant_type: 'ig_refresh_token', access_token: g.token
    }));
    const j = await json(r);
    if (r.ok && j.access_token) {
      g.token = j.access_token;
      g.verloopt = Date.now() + (Number(j.expires_in) || 5184000) * 1000;
      g.ververst = Date.now();
      await geheimRef(uid).child('instagram').update({ token: g.token, verloopt: g.verloopt, ververst: g.ververst });
    }
  }
  return g;
}

async function ttToken(uid) {
  const g = await lees(uid, 'tiktok');
  if (!g || !g.token) throw new Error('TikTok is niet gekoppeld.');
  if (Date.now() < g.verloopt - 120000) return g;
  if (!g.ververs || Date.now() > g.ververs_tot) throw new Error('TikTok-koppeling verlopen. Koppel opnieuw.');
  const r = await fetch(TT_API + '/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: g.id, client_secret: g.geheim,
      grant_type: 'refresh_token', refresh_token: g.ververs
    })
  });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw ttFout(j, 'TikTok verversen');
  const v = ttBewaarVorm(j);
  await geheimRef(uid).child('tiktok').update(v);
  return Object.assign(g, v);
}

/* ─────────── 4. Uploadplek voor de video ───────────
   De telefoon stuurt de video rechtstreeks naar de opslag via een
   eenmalige uploadlink. Zo hoeven er geen opslagregels open en gaat
   de video niet door de functie heen (die heeft een maximum van 32 MB). */

const videoPad = (uid, vid) => 'posts/' + uid + '/' + vid + '.mp4';

exports.socialUploadPlek = onCall(async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const vid = veiligId(d.video);
  if (!vid) throw new HttpsError('invalid-argument', 'Geen video.');
  const type = /^video\/(mp4|quicktime)$/.test(d.type) ? d.type : 'video/mp4';
  const [url] = await admin.storage().bucket().file(videoPad(uid, vid)).createResumableUpload({
    origin: d.origin === 'http://localhost:8765' ? d.origin : APP_URL,
    metadata: { contentType: type }
  });
  return { url };
});

/* ─────────── 5. Posten ─────────── */

const wacht = ms => new Promise(r => setTimeout(r, ms));

async function naarInstagram(uid, videoUrl, caption) {
  const g = await igToken(uid);
  const id = g.ig_id || 'me';
  const r1 = await fetch(IG_API + '/' + id + '/media', {
    method: 'POST',
    body: new URLSearchParams({
      media_type: 'REELS', video_url: videoUrl, caption: caption || '',
      share_to_feed: 'true', access_token: g.token
    })
  });
  const j1 = await json(r1);
  if (!r1.ok || !j1.id) throw igFout(j1, 'Instagram');

  /* Instagram haalt de video zelf op en verwerkt hem. Dat duurt meestal
     30 seconden tot een paar minuten. */
  let status = '';
  for (let i = 0; i < 48; i++) {
    await wacht(i < 6 ? 5000 : 8000);
    const r = await fetch(IG_API + '/' + j1.id + '?' + new URLSearchParams({
      fields: 'status_code,status', access_token: g.token
    }));
    const j = await json(r);
    status = j.status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error('Instagram kon de video niet verwerken (' + (j.status || status) +
        '). Check: mp4, 9:16, 3 sec – 15 min.');
    }
  }
  if (status !== 'FINISHED') throw new Error('Instagram was na 6 minuten nog bezig. Probeer straks opnieuw.');

  const r2 = await fetch(IG_API + '/' + id + '/media_publish', {
    method: 'POST',
    body: new URLSearchParams({ creation_id: j1.id, access_token: g.token })
  });
  const j2 = await json(r2);
  if (!r2.ok || !j2.id) throw igFout(j2, 'Instagram publiceren');
  return { id: j2.id };
}

async function naarTiktok(uid, bestand, grootte) {
  const g = await ttToken(uid);
  /* TikTok wil stukken van 5–64 MB; de rest gaat bij het laatste stuk. */
  const MB = 1024 * 1024;
  const stuk = grootte <= 64 * MB ? grootte : 20 * MB;
  const aantal = Math.max(1, Math.floor(grootte / stuk));

  const r1 = await fetch(TT_API + '/post/publish/inbox/video/init/', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + g.token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: {
      source: 'FILE_UPLOAD', video_size: grootte, chunk_size: stuk, total_chunk_count: aantal
    } })
  });
  const j1 = await json(r1);
  const d = j1.data || {};
  if (!r1.ok || !d.upload_url) throw ttFout(j1, 'TikTok');

  for (let i = 0; i < aantal; i++) {
    const van = i * stuk;
    const tot = i === aantal - 1 ? grootte - 1 : van + stuk - 1;
    const [buf] = await bestand.download({ start: van, end: tot });
    const r = await fetch(d.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes ' + van + '-' + tot + '/' + grootte
      },
      body: buf
    });
    if (!r.ok) throw new Error('TikTok-upload stuk ' + (i + 1) + ' mislukt (' + r.status + ').');
  }
  return { id: d.publish_id || '' };
}

exports.socialPost = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const vid = veiligId(d.video);
  const caption = String(d.caption || '').slice(0, 2200);
  const waar = (Array.isArray(d.kanalen) ? d.kanalen : KANALEN).filter(k => KANALEN.includes(k));
  if (!vid || !waar.length) throw new HttpsError('invalid-argument', 'Geen video of kanaal.');

  const bestand = admin.storage().bucket().file(videoPad(uid, vid));
  const [bestaat] = await bestand.exists();
  if (!bestaat) throw new HttpsError('failed-precondition', 'De video is nog niet geüpload.');
  const [meta] = await bestand.getMetadata();
  const grootte = Number(meta.size);

  /* vaste downloadlink voor Instagram */
  let token = ((meta.metadata || {}).firebaseStorageDownloadTokens || '').split(',')[0];
  if (!token) {
    token = crypto.randomUUID();
    await bestand.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  }
  const videoUrl = 'https://firebasestorage.googleapis.com/v0/b/' + bestand.bucket.name + '/o/' +
    encodeURIComponent(videoPad(uid, vid)) + '?alt=media&token=' + token;

  const uitslagRef = werkRef(uid).child('posts/' + vid);
  const doe = async (k, fn) => {
    await uitslagRef.child(k).set({ status: 'bezig', tijd: Date.now() });
    try {
      const r = await fn();
      const u = { status: 'klaar', tijd: Date.now(), id: r.id || '' };
      await uitslagRef.child(k).set(u);
      return u;
    } catch (e) {
      console.error('socialPost', k, e.message);
      const u = { status: 'fout', tijd: Date.now(), fout: String(e.message).slice(0, 300) };
      await uitslagRef.child(k).set(u);
      return u;
    }
  };

  const [ig, tt] = await Promise.all([
    waar.includes('instagram') ? doe('instagram', () => naarInstagram(uid, videoUrl, caption)) : null,
    waar.includes('tiktok') ? doe('tiktok', () => naarTiktok(uid, bestand, grootte)) : null
  ]);
  return { instagram: ig, tiktok: tt };
});

/* ─────────── 6. Ontkoppelen ─────────── */

exports.socialWis = onCall(async req => {
  const uid = wieBenJe(req);
  const k = kanaal((req.data || {}).kanaal);
  await geheimRef(uid).child(k).remove();
  await werkRef(uid).child('koppeling/' + k).remove();
  return { ok: true };
});

/* Wie de app-gegevens heeft ingevuld maar nog niet ingelogd, ziet dat. */
exports.socialStand = onCall(async req => {
  const uid = wieBenJe(req);
  const uit = {};
  for (const k of KANALEN) {
    const g = await lees(uid, k);
    uit[k] = !g ? 'leeg' : g.token ? 'gekoppeld' : 'app';
    if (g && g.naam) uit[k + '_naam'] = g.naam;
  }
  uit.terug = TERUG_URL;
  return uit;
});
