/* ═══════════════════════════════════════════════════════════════════
   Cacaoboetiek HQ — de serverkant

   Hier staan de sleutels die niet in de app mogen staan. De app roept
   deze functies aan; zij praten met Shopify en schrijven het resultaat
   naar Firebase.

   Wat er naar Firebase gaat: ordernummer, wat erin moet, verzenden of
   afhalen, leverdatum, of er een wenskaart bij hoort.
   Wat er NIET heen gaat: naam, adres, e-mail, telefoon, de tekst van
   de boodschap. Die blijven bij Shopify en worden per keer opgehaald.
   ═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10, timeoutSeconds: 120 });

/* Shopify brengt elk kwartaal een nieuwe versie uit en houdt elke versie
   een jaar in de lucht. Loopt deze af, dan zet je hier een nieuwere neer. */
const SHOPIFY_API = '2026-01';

const db = () => admin.database();
const geheimRef = uid => db().ref('geheim/' + uid);
const werkRef = uid => db().ref('werkvloer/' + uid);

function wieBenJe(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
  return uid;
}

async function leesGeheim(uid, welke) {
  const s = await geheimRef(uid).child(welke).once('value');
  return s.val() || null;
}

/* ─────────────────────────── Shopify ─────────────────────────── */

function netteWinkel(ruw) {
  let s = String(ruw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!s) throw new HttpsError('invalid-argument', 'Vul het adres van je winkel in.');
  if (!/\.myshopify\.com$/.test(s)) s += '.myshopify.com';
  return s;
}

function duiding(status, tekst) {
  if (status === 401 || status === 403) {
    return 'Shopify weigert je Klant-ID of Geheim. Controleer of je ze uit het ' +
      'Dev Dashboard hebt gehaald, en of je app op deze winkel is geïnstalleerd.';
  }
  if (status === 404) {
    return 'Dat winkeladres bestaat niet bij Shopify. Kijk of je het goed hebt ' +
      'overgetypt, zonder https:// ervoor.';
  }
  if (status === 429) return 'Shopify vraagt even te wachten. Probeer het over een minuut opnieuw.';
  return 'Shopify antwoordde met ' + status + '. ' + String(tekst || '').slice(0, 200);
}

/* Sinds januari 2026 geeft Shopify geen vaste tokens meer uit. Je ruilt je
   Klant-ID en Geheim in voor een token dat een tijdje meegaat. Dat token
   bewaren we, zodat we niet bij elke handeling opnieuw hoeven te ruilen. */
async function versToken(winkel, klant_id, geheim) {
  let r;
  try {
    r = await fetch('https://' + winkel + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: klant_id, client_secret: geheim, grant_type: 'client_credentials' })
    });
  } catch (e) {
    throw new HttpsError('unavailable', 'Kon Shopify niet bereiken.');
  }
  const tekst = await r.text();
  if (!r.ok) throw new HttpsError('permission-denied', duiding(r.status, tekst));

  let d;
  try { d = JSON.parse(tekst); }
  catch (e) { throw new HttpsError('internal', 'Shopify gaf geen leesbaar antwoord terug.'); }

  if (!d.access_token) {
    throw new HttpsError('permission-denied',
      'Shopify gaf geen token terug. Meestal betekent dat dat je app en je winkel ' +
      'niet in dezelfde organisatie zitten in het Dev Dashboard.');
  }
  const seconden = Number(d.expires_in) || 86400;
  return { token: d.access_token, verloopt: Date.now() + Math.max(60, seconden - 300) * 1000 };
}

async function token(uid) {
  const g = await leesGeheim(uid, 'shopify');
  if (!g) throw new HttpsError('failed-precondition', 'Shopify is nog niet gekoppeld.');
  if (g.token && g.verloopt && g.verloopt > Date.now()) return { winkel: g.winkel, token: g.token };
  const vers = await versToken(g.winkel, g.klant_id, g.geheim);
  await geheimRef(uid).child('shopify').update(vers);
  return { winkel: g.winkel, token: vers.token };
}

async function shopify(uid, pad) {
  const { winkel, token: t } = await token(uid);
  const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/' + pad, {
    headers: { 'X-Shopify-Access-Token': t, 'Accept': 'application/json' }
  });
  if (r.status === 401 || r.status === 403) {
    /* token afgekeurd: weggooien, dan haalt de volgende poging een verse op */
    await geheimRef(uid).child('shopify/token').remove();
    throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
  }
  if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
  return r.json();
}

/* ─────────── van een Shopify-order naar wat de app mag zien ─────────── */

const AFHALEN = /afhal|afhaal|pickup|ophal/i;

function kenmerken(o) {
  const uit = {};
  (o.note_attributes || []).forEach(a => {
    if (a && a.name) uit[String(a.name).toLowerCase().trim()] = a.value;
  });
  return uit;
}

function boodschapVan(o) {
  const k = kenmerken(o);
  return String(o.note || k['boodschap'] || k['wenskaart'] ||
    k['persoonlijke boodschap'] || k['kaartje'] || '').trim();
}

function veiligeOrder(o) {
  const regels = (o.line_items || [])
    .filter(li => !li.gift_card)
    .map(li => ({
      aantal: Number(li.quantity) || 0,
      naam: String(li.title || ''),
      variant: li.variant_title || null
    }));
  const k = kenmerken(o);
  const verzendwijze = (o.shipping_lines || []).map(x => x.title || '').join(' ');

  return {
    shopifyId: String(o.id),
    nummer: String(o.name || o.order_number || '').replace(/^#/, ''),
    geplaatst: o.created_at || null,
    leverdatum: k['leverdatum'] || k['bezorgdatum'] || k['delivery date'] || null,
    stuks: regels.reduce((s, r) => s + r.aantal, 0),
    regels,
    afhaal: !o.shipping_address || AFHALEN.test(verzendwijze),
    wenskaart_gevraagd: !!boodschapVan(o),
    betaald: o.financial_status === 'paid',
    verwijderNa: Date.now() + 30 * 24 * 3600 * 1000
  };
}

/* ═══════════════════════ wat de app aanroept ═══════════════════════ */

exports.zetKoppeling = onCall(async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};

  if (d.shopify) {
    const winkel = netteWinkel(d.shopify.winkel);
    const klant_id = String(d.shopify.klant_id || '').trim();
    const geheim = String(d.shopify.geheim || '').trim();
    if (!klant_id || !geheim) throw new HttpsError('invalid-argument', 'Vul je Klant-ID en Geheim in.');

    /* meteen uitproberen: lukt het ruilen niet, dan slaan we niets op */
    const vers = await versToken(winkel, klant_id, geheim);
    await geheimRef(uid).child('shopify').set(
      Object.assign({ winkel, klant_id, geheim }, vers));
    await werkRef(uid).child('koppeling').update({ shopify: true });
    return { ok: true, winkel };
  }

  if (d.myparcel) {
    throw new HttpsError('unimplemented',
      'MyParcel staat nog niet op de server. Shopify werkt wel — koppel die eerst.');
  }

  throw new HttpsError('invalid-argument', 'Ik weet niet wat ik moet koppelen.');
});

exports.wisKoppeling = onCall(async req => {
  const uid = wieBenJe(req);
  const welke = String((req.data || {}).welke || '');
  if (!['shopify', 'myparcel'].includes(welke)) {
    throw new HttpsError('invalid-argument', 'Onbekende koppeling.');
  }
  await geheimRef(uid).child(welke).remove();
  await werkRef(uid).child('koppeling/' + welke).remove();
  if (welke === 'shopify') await werkRef(uid).child('orders').remove();
  return { ok: true };
});

exports.haalOrders = onCall(async req => {
  const uid = wieBenJe(req);
  const d = await shopify(uid, 'orders.json?status=open&limit=50');
  const orders = d.orders || [];

  /* wat je zelf hebt bijgehouden — zoals een aangemeld label — blijft staan */
  const bestaand = (await werkRef(uid).child('orders').once('value')).val() || {};
  const nieuw = {};
  orders.forEach(o => {
    const v = veiligeOrder(o);
    nieuw[v.shopifyId] = Object.assign({}, bestaand[v.shopifyId] || {}, v);
  });

  if (Object.keys(nieuw).length) await werkRef(uid).child('orders').update(nieuw);
  await werkRef(uid).update({ laatstOpgehaald: Date.now() });

  /* orders ouder dan een maand ruimen zichzelf op */
  const nu = Date.now();
  const oud = {};
  Object.keys(bestaand).forEach(id => {
    if (!nieuw[id] && bestaand[id] && bestaand[id].verwijderNa < nu) oud[id] = null;
  });
  if (Object.keys(oud).length) await werkRef(uid).child('orders').update(oud);

  return { aantal: orders.length };
});

/* De tekst van de wenskaart halen we per keer op en bewaren we nergens. */
exports.haalBoodschap = onCall(async req => {
  const uid = wieBenJe(req);
  const nr = String((req.data || {}).order || '').replace(/^#/, '').trim();
  if (!nr) throw new HttpsError('invalid-argument', 'Welke order?');

  let o = null;
  if (/^\d+$/.test(nr)) {
    const d = await shopify(uid, 'orders/' + nr + '.json');
    o = d.order || null;
  }
  if (!o) {
    const d = await shopify(uid, 'orders.json?status=any&name=' + encodeURIComponent(nr) + '&limit=1');
    o = (d.orders || [])[0] || null;
  }
  if (!o) throw new HttpsError('not-found', 'Die order kon ik niet vinden bij Shopify.');

  return { boodschap: boodschapVan(o) };
});
