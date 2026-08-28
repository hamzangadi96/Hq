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

/* Je mag hier van alles neerzetten: het kale adres, of gewoon de hele URL
   uit je browser geplakt. Alles wat naar één winkel wijst wordt hetzelfde. */
function netteWinkel(ruw) {
  let s = String(ruw || '').trim().toLowerCase();

  /* de hele admin-URL geplakt: admin.shopify.com/store/3e6b32-d5/... */
  const admin = s.match(/admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  if (admin) return admin[1] + '.myshopify.com';

  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!s) throw new HttpsError('invalid-argument', 'Vul het adres van je winkel in.');

  if (/\.myshopify\.com$/.test(s)) return s;

  /* een eigen domein zoals cacaoboetiek.nl kan hier niet: de API luistert
     alleen naar het myshopify-adres. Zeg dat dan ook. */
  if (s.includes('.')) {
    throw new HttpsError('invalid-argument',
      'Dat is niet je myshopify-adres. Kijk in je Shopify-admin in de adresbalk: ' +
      'het stukje na /store/ gevolgd door .myshopify.com.');
  }
  return s + '.myshopify.com';
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
  return (await shopifyPagina(uid, pad)).gegevens;
}

/* Shopify geeft maximaal 250 orders per keer en zet de volgende pagina in een
   Link-kop. Die moeten we uitlezen, anders zie je alleen de eerste lading. */
async function shopifyPagina(uid, pad) {
  const { winkel, token: t } = await token(uid);
  const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/' + pad, {
    headers: { 'X-Shopify-Access-Token': t, 'Accept': 'application/json' }
  });
  if (r.status === 401 || r.status === 403) {
    await geheimRef(uid).child('shopify/token').remove();
    throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
  }
  if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));

  const link = r.headers.get('link') || '';
  const m = link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return { gegevens: await r.json(), volgende: m ? m[1] : null };
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

const MAAND = 30 * 24 * 3600 * 1000;

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

  /* Verzonden, geannuleerd of gesloten: die hoeft niet meer in je werklijst.
     Historie bewaren we langer, want daar staat toch geen persoonsgegeven in. */
  const afgehandeld = o.fulfillment_status === 'fulfilled' || !!o.cancelled_at || !!o.closed_at;

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
    afgehandeld,
    verwijderNa: Date.now() + (afgehandeld ? 24 * MAAND : MAAND)
  };
}

/* ─────────────────────────── MyParcel ─────────────────────────── */

/* MyParcel wil de sleutel base64-versleuteld in de header, en staat op een
   eigen User-Agent. Zonder die kop weigert hij zonder uitleg. */
function mpKoppen(sleutel, extra) {
  return Object.assign({
    'Authorization': 'bearer ' + Buffer.from(String(sleutel), 'utf8').toString('base64'),
    'User-Agent': 'CacaoboetiekHQ/1'
  }, extra || {});
}

async function mpRoep(sleutel, pad, opties) {
  const r = await fetch('https://api.myparcel.nl/' + pad, opties);
  if (r.status === 401 || r.status === 403) {
    throw new HttpsError('permission-denied',
      'MyParcel weigert je sleutel. Maak in MyParcel onder Instellingen een nieuwe aan en koppel opnieuw.');
  }
  if (r.status === 402) {
    throw new HttpsError('failed-precondition',
      'MyParcel wil eerst betaald worden voor dit label. Zet je saldo bij in je MyParcel-account.');
  }
  if (r.status === 429) {
    throw new HttpsError('resource-exhausted', 'Te veel verzoeken bij MyParcel. Probeer het over een minuut opnieuw.');
  }
  return r;
}

/* Shopify levert één adresregel, MyParcel wil straat, nummer en toevoeging
   apart. Voor Nederland en België knippen we hem, daarbuiten laten we hem heel. */
function splitsAdres(a) {
  const land = String((a && a.country_code) || 'NL').toUpperCase();
  const regel = [a && a.address1, a && a.address2].filter(Boolean).join(' ').trim();

  if (!['NL', 'BE'].includes(land)) return { straat: regel, nummer: '', toevoeging: '' };

  const m = regel.match(/^(.*?)\s+(\d+)\s*([a-zA-Z0-9\-\/]{0,6})$/);
  if (!m) return { straat: regel, nummer: '', toevoeging: '' };
  return { straat: m[1].trim(), nummer: m[2], toevoeging: (m[3] || '').trim() };
}

function zending(o, nr) {
  const a = o.shipping_address;
  if (!a) throw new HttpsError('failed-precondition', 'Deze order heeft geen verzendadres. Wordt hij afgehaald?');

  const { straat, nummer, toevoeging } = splitsAdres(a);
  if (!straat || !nummer) {
    throw new HttpsError('failed-precondition',
      'Ik kan huisnummer en straat niet uit elkaar halen bij "' + String(a.address1 || '') +
      '". Vul het adres handmatig aan in MyParcel.');
  }

  const ontvanger = {
    cc: String(a.country_code || 'NL').toUpperCase(),
    city: String(a.city || ''),
    street: straat,
    number: nummer,
    postal_code: String(a.zip || '').replace(/\s+/g, '').toUpperCase(),
    person: String(a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Ontvanger')
  };
  if (toevoeging) ontvanger.number_suffix = toevoeging;
  if (a.company) ontvanger.company = String(a.company);
  if (a.phone) ontvanger.phone = String(a.phone);
  if (o.email) ontvanger.email = String(o.email);

  return {
    reference_identifier: nr,
    recipient: ontvanger,
    options: { package_type: 1, label_description: nr },
    carrier: 1                       /* 1 = PostNL */
  };
}



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
    const sleutel = String(d.myparcel.sleutel || '').trim();
    if (!sleutel) throw new HttpsError('invalid-argument', 'Vul je MyParcel-sleutel in.');

    /* meteen uitproberen met een onschuldige vraag */
    const r = await mpRoep(sleutel, 'shipments?size=1', { headers: mpKoppen(sleutel) });
    if (!r.ok) {
      throw new HttpsError('permission-denied',
        'MyParcel antwoordde met ' + r.status + '. Controleer of je de sleutel compleet hebt overgenomen.');
    }
    await geheimRef(uid).child('myparcel').set({ sleutel });
    await werkRef(uid).child('koppeling').update({ myparcel: true });
    return { ok: true };
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

  /* status=any pakt ook wat al verzonden is, zodat je je historie terugziet.
     Shopify geeft standaard maar 60 dagen; wil je verder terug, dan heb je de
     scope read_all_orders nodig en die moet Shopify eerst goedkeuren. */
  const orders = [];
  let pad = 'orders.json?status=any&limit=250';
  for (let ronde = 0; ronde < 12; ronde++) {
    const { gegevens, volgende } = await shopifyPagina(uid, pad);
    (gegevens.orders || []).forEach(o => orders.push(o));
    if (!volgende) break;
    pad = 'orders.json?limit=250&page_info=' + encodeURIComponent(volgende);
  }

  /* wat je zelf hebt bijgehouden — zoals een aangemeld label — blijft staan */
  const bestaand = (await werkRef(uid).child('orders').once('value')).val() || {};
  const nieuw = {};
  orders.forEach(o => {
    const v = veiligeOrder(o);
    nieuw[v.shopifyId] = Object.assign({}, bestaand[v.shopifyId] || {}, v);
  });

  if (Object.keys(nieuw).length) await werkRef(uid).child('orders').update(nieuw);
  await werkRef(uid).update({ laatstOpgehaald: Date.now() });

  /* orders die Shopify niet meer teruggeeft en waarvan de tijd om is, weg */
  const nu = Date.now();
  const oud = {};
  Object.keys(bestaand).forEach(id => {
    if (!nieuw[id] && bestaand[id] && bestaand[id].verwijderNa < nu) oud[id] = null;
  });
  if (Object.keys(oud).length) await werkRef(uid).child('orders').update(oud);

  const open = orders.filter(o => !(o.fulfillment_status === 'fulfilled' || o.cancelled_at || o.closed_at));
  return { aantal: orders.length, open: open.length };
});

/* Een order bij Shopify opzoeken, op id of op ordernummer. */
async function zoekOrder(uid, ruw) {
  const nr = String(ruw || '').replace(/^#/, '').trim();
  if (!nr) throw new HttpsError('invalid-argument', 'Welke order?');

  if (/^\d{6,}$/.test(nr)) {
    const d = await shopify(uid, 'orders/' + nr + '.json');
    if (d.order) return d.order;
  }
  const d = await shopify(uid, 'orders.json?status=any&name=' +
    encodeURIComponent(nr) + '&limit=1');
  const o = (d.orders || [])[0];
  if (!o) throw new HttpsError('not-found', 'Die order kon ik niet vinden bij Shopify.');
  return o;
}

/* De tekst van de wenskaart halen we per keer op en bewaren we nergens. */
exports.haalBoodschap = onCall(async req => {
  const uid = wieBenJe(req);
  const o = await zoekOrder(uid, (req.data || {}).order);
  return { boodschap: boodschapVan(o) };
});

/* Zending aanmelden bij MyParcel. Het adres komt rechtstreeks van Shopify,
   gaat door deze functie heen naar MyParcel, en wordt hier niet bewaard. */
exports.maakLabel = onCall(async req => {
  const uid = wieBenJe(req);
  const g = await leesGeheim(uid, 'myparcel');
  if (!g) throw new HttpsError('failed-precondition', 'MyParcel is nog niet gekoppeld.');

  const o = await zoekOrder(uid, (req.data || {}).order);
  const nr = String(o.name || o.order_number || '').replace(/^#/, '');
  const sleutelPad = werkRef(uid).child('orders/' + o.id);

  /* al aangemeld? dan niet nog een keer, anders betaal je twee labels */
  const bestaand = (await sleutelPad.child('myparcel_id').once('value')).val();
  if (bestaand) return { id: bestaand, alGedaan: true };

  const r = await mpRoep(g.sleutel, 'shipments', {
    method: 'POST',
    headers: mpKoppen(g.sleutel, {
      'Content-Type': 'application/vnd.shipment+json;charset=utf-8;version=1.1'
    }),
    body: JSON.stringify({ data: { shipments: [zending(o, nr)] } })
  });

  const tekst = await r.text();
  if (!r.ok) {
    let uitleg = '';
    try {
      const f = JSON.parse(tekst);
      uitleg = (f.errors && f.errors[0] && (f.errors[0].human || f.errors[0].message)) || f.message || '';
    } catch (e) { /* geen json terug */ }
    throw new HttpsError('invalid-argument',
      'MyParcel wilde de zending niet aannemen. ' + (uitleg || 'Antwoord ' + r.status + '.'));
  }

  let id = null;
  try { id = ((JSON.parse(tekst).data || {}).ids || [])[0]; } catch (e) { /* leeg */ }
  id = id && (id.id || id);
  if (!id) throw new HttpsError('internal', 'MyParcel gaf geen zendingnummer terug.');

  await sleutelPad.update({ myparcel_id: String(id), label: true });
  return { id: String(id) };
});

/* Het label als pdf ophalen en teruggeven, zodat je het op je telefoon
   kunt openen en via het deelmenu naar je printer stuurt. */
exports.labelPdf = onCall(async req => {
  const uid = wieBenJe(req);
  const g = await leesGeheim(uid, 'myparcel');
  if (!g) throw new HttpsError('failed-precondition', 'MyParcel is nog niet gekoppeld.');

  const nr = String((req.data || {}).order || '').replace(/^#/, '').trim();
  let id = null;

  const alle = (await werkRef(uid).child('orders').once('value')).val() || {};
  Object.keys(alle).forEach(k => {
    const o = alle[k] || {};
    if (o.myparcel_id && (k === nr || o.shopifyId === nr || o.nummer === nr)) id = o.myparcel_id;
  });
  if (!id) throw new HttpsError('failed-precondition', 'Voor deze order is nog geen zending aangemeld.');

  const formaat = String((req.data || {}).formaat || 'A6').toUpperCase() === 'A4' ? 'A4' : 'A6';
  const r = await mpRoep(g.sleutel, 'shipment_labels/' + encodeURIComponent(id) + '?format=' + formaat, {
    headers: mpKoppen(g.sleutel, { 'Accept': 'application/pdf' })
  });
  if (!r.ok) throw new HttpsError('internal', 'Het label kwam niet door. MyParcel antwoordde met ' + r.status + '.');

  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw new HttpsError('internal', 'Het label kwam leeg terug.');

  return { pdf: bytes.toString('base64'), naam: 'verzendlabel-' + (nr || id) + '.pdf' };
});
