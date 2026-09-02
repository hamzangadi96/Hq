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



/* ─────────────────────── Beeld beoordelen ───────────────────────

   Studio stuurt drie beelden uit hetzelfde stuk: begin, midden, eind.
   Eén beeld liegt te makkelijk — bij drie zie je of er echt iets gebeurt.
   De maatstaf komt uit de app mee, want dat is Hamza's smaak en niet de mijne. */

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5';

function claudeKoppen(sleutel) {
  return {
    'content-type': 'application/json',
    'x-api-key': sleutel,
    'anthropic-version': '2023-06-01'
  };
}

const OPDRACHT =
  'Je bent monteur. Je krijgt beelden uit een aaneengesloten stuk ruwe opname ' +
  'van een chocolatier, bedoeld voor korte verticale filmpjes. Elk beeld heeft ' +
  'een tijdstip in seconden. Jij bepaalt zelf waar de bruikbare stukken beginnen ' +
  'en eindigen.\n\n' +
  'Knip op natuurlijke grenzen: waar een handeling af is, waar een blik wisselt, ' +
  'waar een beweging tot rust komt. Knip nooit midden in een beweging. ' +
  'Je krijgt een lijst rustpunten mee, gemeten momenten waarop het beeld even ' +
  'tot stilstand komt. Gebruik die waar ze passen, maar je mag ervan afwijken ' +
  'als het beeld daarom vraagt.\n\n' +
  'Hieronder staat wat de maker bruikbaar vindt. Houd je daar strikt aan.\n\n' +
  '{REGELS}\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg eromheen en zonder ' +
  'markdown, met deze twee sleutels:\n' +
  '  stukken  lijst van bruikbare stukken, elk met:\n' +
  '             van    begintijd in seconden\n' +
  '             tot    eindtijd in seconden\n' +
  '             label  wat er te zien is, in het Nederlands, maximaal zes ' +
  'woorden, bijvoorbeeld "handen vullen bonbonvorm"\n' +
  '             cijfer hoe sterk dit stuk op zichzelf is, 1 tot 10\n' +
  '             waarom in maximaal acht woorden waarom je dat cijfer geeft\n' +
  '  afval    lijst van stukken die je overslaat, elk met van, tot en ' +
  'reden (maximaal acht woorden)\n\n' +
  'Regels voor de stukken: minstens {MIN} en hoogstens {MAX} seconden, binnen ' +
  '{VAN} en {TOT}, ze mogen elkaar niet overlappen, en op volgorde van tijd. ' +
  'Liever drie goede stukken dan tien halve. Is er niets bruikbaars, geef dan ' +
  'een lege lijst stukken en zet alles in afval.\n\n' +
  'Wees streng en durf te onderscheiden bij het cijfer. Een 9 of 10 is een ' +
  'shot dat je zonder aarzelen als opening gebruikt: scherp, goed in kader, ' +
  'een duidelijke handeling of uitdrukking, met een natuurlijk begin en eind. ' +
  'Een 5 of 6 is bruikbaar vulmateriaal. Onder de 4 hoort in afval. ' +
  'Geef niet alles hetzelfde cijfer: als twee stukken op elkaar lijken, ' +
  'kies dan welke de sterkste is en zet de ander lager.';

exports.beoordeelReeks = onCall(async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};

  const beelden = Array.isArray(d.beelden) ? d.beelden.slice(0, 24) : [];
  if (!beelden.length) throw new HttpsError('invalid-argument', 'Geen beeld ontvangen.');

  const regels = String(d.regels || '').trim();
  if (!regels) throw new HttpsError('invalid-argument', 'Geen maatstaf meegegeven.');

  const van = Number(d.van) || 0;
  const tot = Number(d.tot) || 0;
  const min = Number(d.min) || 2;
  const max = Number(d.max) || 5;
  const rust = Array.isArray(d.rustpunten) ? d.rustpunten.slice(0, 20) : [];

  const g = await leesGeheim(uid, 'claude');
  if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

  const inhoud = [];
  inhoud.push({
    type: 'text',
    text: 'Deze reeks loopt van ' + van.toFixed(1) + ' tot ' + tot.toFixed(1) + ' seconden.' +
          (rust.length ? '\nRustpunten: ' + rust.map(x => Number(x).toFixed(1)).join(', ') : '')
  });
  beelden.forEach(b => {
    inhoud.push({ type: 'text', text: 't = ' + Number(b.t).toFixed(1) + ' s' });
    inhoud.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: String(b.data || '') }
    });
  });

  const opdracht = OPDRACHT
    .replace('{REGELS}', regels)
    .replace('{MIN}', String(min))
    .replace('{MAX}', String(max))
    .replace('{VAN}', van.toFixed(1))
    .replace('{TOT}', tot.toFixed(1));

  const r = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: claudeKoppen(g.sleutel),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: opdracht,
      messages: [{ role: 'user', content: inhoud }]
    })
  });

  if (!r.ok) {
    const tekst = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) {
      throw new HttpsError('permission-denied', 'Je Claude-sleutel wordt niet meer geaccepteerd.');
    }
    if (r.status === 429) {
      throw new HttpsError('resource-exhausted', 'Te veel tegelijk. Probeer het zo opnieuw.');
    }
    throw new HttpsError('internal', 'Claude antwoordde met ' + r.status + '. ' + tekst.slice(0, 200));
  }

  const uit = await r.json();
  const blokken = Array.isArray(uit.content) ? uit.content : [];
  const tekst = blokken.filter(x => x && x.type === 'text').map(x => x.text).join('\n');

  /* Het model hoort kaal JSON te sturen, maar we halen er nog even
     eventuele backticks omheen weg voor we het proberen te lezen. */
  let oordeel = null;
  try {
    const schoon = tekst.replace(/```json|```/g, '').trim();
    const van = schoon.indexOf('{'), tot = schoon.lastIndexOf('}');
    oordeel = JSON.parse(van >= 0 && tot > van ? schoon.slice(van, tot + 1) : schoon);
  } catch (fout) {
    throw new HttpsError('internal', 'Onleesbaar antwoord van Claude.');
  }

  /* Het model mag zich vergissen in de randen, dus we snijden alles terug
     naar wat er echt kan: binnen de reeks, lang genoeg, kort genoeg, en
     op volgorde zonder overlap. */
  const schoonStuk = s => {
    let a = Math.max(van, Math.min(tot, Number(s.van)));
    let b = Math.max(van, Math.min(tot, Number(s.tot)));
    if (!isFinite(a) || !isFinite(b) || b - a < min) return null;
    if (b - a > max) b = a + max;
    let cijfer = Math.round(Number(s.cijfer));
    if (!isFinite(cijfer)) cijfer = 5;
    cijfer = Math.max(1, Math.min(10, cijfer));
    return {
      van: a, tot: b,
      label: String(s.label || '').trim().slice(0, 60),
      cijfer,
      waarom: String(s.waarom || '').trim().slice(0, 80)
    };
  };

  const stukken = [];
  let laatste = van;
  (Array.isArray(oordeel.stukken) ? oordeel.stukken : [])
    .map(schoonStuk)
    .filter(Boolean)
    .sort((x, y) => x.van - y.van)
    .forEach(s => {
      if (s.van < laatste) s.van = laatste;
      if (s.tot - s.van < min) return;
      stukken.push(s);
      laatste = s.tot;
    });

  const afval = (Array.isArray(oordeel.afval) ? oordeel.afval : []).map(a => ({
    van: Math.max(van, Math.min(tot, Number(a.van) || van)),
    tot: Math.max(van, Math.min(tot, Number(a.tot) || van)),
    reden: String(a.reden || '').trim().slice(0, 80) || 'overgeslagen'
  })).filter(a => a.tot - a.van >= .4);

  return { stukken, afval };
});

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

  if (d.claude) {
    const sleutel = String(d.claude.sleutel || '').trim();
    if (!sleutel) throw new HttpsError('invalid-argument', 'Vul je sleutel in.');

    /* meteen uitproberen met de kleinst mogelijke vraag */
    const r = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: claudeKoppen(sleutel),
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 1,
        messages: [{ role: 'user', content: 'hoi' }]
      })
    });
    if (!r.ok) {
      throw new HttpsError('permission-denied',
        'Claude antwoordde met ' + r.status + '. Controleer of je de sleutel compleet hebt overgenomen.');
    }
    await geheimRef(uid).child('claude').set({ sleutel });
    await werkRef(uid).child('koppeling').update({ claude: true });
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', 'Ik weet niet wat ik moet koppelen.');
});

exports.wisKoppeling = onCall(async req => {
  const uid = wieBenJe(req);
  const welke = String((req.data || {}).welke || '');
  if (!['shopify', 'myparcel', 'claude'].includes(welke)) {
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

/* Alles wat je documenten nodig hebben, in één keer opgehaald bij Shopify.
   Hier zit wél naam en adres in — dat moet, want een factuur zonder adres is
   geen geldige factuur. Het gaat rechtstreeks naar jouw toestel en wordt
   nergens bewaard: niet in deze functie, niet in de database. */
exports.haalOrderDocumenten = onCall(async req => {
  const uid = wieBenJe(req);
  const o = await zoekOrder(uid, (req.data || {}).order);

  const a = o.shipping_address || o.billing_address || null;
  const adres = a ? [
    a.address1,
    a.address2,
    [String(a.zip || '').toUpperCase(), a.city].filter(Boolean).join('  '),
    (a.country_code || 'NL') !== 'NL' ? a.country : null
  ].filter(Boolean).join('\n') : '';

  /* Shopify rekent per regel; verzending en kado-opties staan apart en vallen
     onder het hoge btw-tarief. De rest is voedsel en dus laag. */
  const KADO = /kado|cadeau|gift|inpak|wrap|wenskaart|kaartje/i;
  const regels = [];
  let kado = 0;
  (o.line_items || []).filter(li => !li.gift_card).forEach(li => {
    const stuk = parseFloat(li.price) || 0;
    const naam = String(li.title || '') + (li.variant_title ? ' · ' + li.variant_title : '');
    if (KADO.test(naam)) { kado += stuk * (li.quantity || 0); return; }
    regels.push({ naam, aantal: Number(li.quantity) || 0, prijs: stuk });
  });

  const verzending = (o.shipping_lines || [])
    .reduce((n, s) => n + (parseFloat(s.price) || 0), 0);

  return {
    nummer: String(o.name || o.order_number || '').replace(/^#/, ''),
    datum: (o.created_at || '').slice(0, 10),
    betaald: o.financial_status === 'paid',
    klant: {
      naam: (a && a.name) || [o.customer && o.customer.first_name, o.customer && o.customer.last_name]
        .filter(Boolean).join(' ') || 'Klant',
      adres,
      email: o.email || ''
    },
    regels,
    verzending,
    kado,
    boodschap: boodschapVan(o),
    afhaal: !o.shipping_address
  };
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

/* Ondertitels staan in een eigen bestand ernaast, zodat dit bestand niet nog
   langer wordt. Deze regel haalt ze binnen. */
Object.assign(exports, require('./maakOndertitels'));
