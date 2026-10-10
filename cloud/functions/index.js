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

/* Voor voorraad moet je schrijven, niet alleen lezen. Zelfde token, maar
   dan met een POST en een JSON-lijf erbij. */
async function shopifySchrijf(uid, pad, lijf) {
  const { winkel, token: t } = await token(uid);
  const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/' + pad, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': t, 'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(lijf)
  });
  if (r.status === 401 || r.status === 403) {
    await geheimRef(uid).child('shopify/token').remove();
    throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
  }
  if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
  return r.json();
}

/* Elke winkel heeft minstens één locatie en voorraad hangt daaraan vast.
   Bij een eenmanszaak is dat er meestal precies één; die pakken we en
   onthouden 'm, zodat je niet bij elke aanpassing opnieuw hoeft te wachten. */
async function shopifyLocatie(uid) {
  const bekend = await leesGeheim(uid, 'shopify');
  if (bekend && bekend.locatie_id) return bekend.locatie_id;
  const d = await shopify(uid, 'locations.json');
  const loc = (d.locations || [])[0];
  if (!loc) throw new HttpsError('failed-precondition', 'Shopify geeft geen locatie terug.');
  await geheimRef(uid).child('shopify/locatie_id').set(loc.id);
  return loc.id;
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
  'Regels voor de stukken: minstens {MIN} seconden, binnen {VAN} en {TOT}, ze ' +
  'mogen elkaar niet overlappen, en op volgorde van tijd.\n\n' +
  'Over de lengte: {MAX} seconden is een richtlijn, geen grens. Het eind van de ' +
  'handeling bepaalt waar je knipt. Duurt een handeling langer dan de richtlijn, ' +
  'laat het stuk dan langer duren tot de handeling af is. Kap nooit halverwege ' +
  'af en sla een goede handeling ook niet over omdat hij lang is; een afgekapte ' +
  'beweging is onbruikbaar en dat weegt zwaarder dan de richtlijn.\n\n' +
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

/* Voor als je net rechten hebt bijgezet in het Dev Dashboard en niet tot
   de volgende automatische ververdag wil wachten. Klant-ID en Geheim
   staan al bij ons, dus daar hoef je niets voor over te typen. */
exports.shopifyTokenVersen = onCall(async req => {
  const uid = wieBenJe(req);
  const g = await leesGeheim(uid, 'shopify');
  if (!g) throw new HttpsError('failed-precondition', 'Shopify is nog niet gekoppeld.');
  const vers = await versToken(g.winkel, g.klant_id, g.geheim);
  await geheimRef(uid).child('shopify').update(vers);
  return { ok: true };
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

/* ─────────────── mailinglijst tellen ───────────────
   Telt hoeveel klanten in Shopify mail willen ontvangen. Er gaat ALLEEN een
   getal terug — geen naam, geen e-mailadres. Dat blijft bij Shopify.

   Meegegeven: sinds (YYYY-MM-DD) = start van de campagne. Terug: totaal op de
   lijst, nieuw sinds die datum, en nieuw vandaag. Datums in Nederlandse tijd,
   anders telt een aanmelding om 01:00 bij de verkeerde dag. */
const nlDag = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

exports.telMailinglijst = onCall(async req => {
  /* Elke fout die we niet zelf hebben voorzien, komt toch met uitleg terug —
     anders maakt Firebase er een kale "internal" van en weet niemand iets. */
  try { return await telMailinglijstBinnen(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('telMailinglijst', e);
    throw new HttpsError('internal', 'Tellen mislukt: ' + String((e && e.message) || e).slice(0, 200));
  }
});

async function telMailinglijstBinnen(req) {
  const uid = wieBenJe(req);
  const sinds = /^\d{4}-\d{2}-\d{2}$/.test((req.data || {}).sinds || '') ? req.data.sinds : '2026-10-01';
  const vandaag = nlDag(Date.now());
  const { winkel, token: t } = await token(uid);

  let totaal = 0, nieuw = 0, nieuwVandaag = 0, na = null;
  const perDag = {};
  for (let ronde = 0; ronde < 40; ronde++) {
    const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        query: 'query($na:String){customers(first:250,after:$na){nodes{createdAt defaultEmailAddress{marketingState}} pageInfo{hasNextPage endCursor}}}',
        variables: { na }
      })
    });
    if (r.status === 401) {
      await geheimRef(uid).child('shopify/token').remove();
      throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
    }
    if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
    const d = await r.json();
    if (d.errors && d.errors.length) {
      const tekst = JSON.stringify(d.errors);
      if (/ACCESS_DENIED|read_customers|access/i.test(tekst)) {
        throw new HttpsError('permission-denied',
          'HQ mag nog geen klanten tellen. Zet in het Shopify Dev Dashboard bij je app de scope read_customers aan en installeer de app opnieuw.');
      }
      throw new HttpsError('internal', 'Shopify gaf een fout: ' + tekst.slice(0, 200));
    }
    const c = d.data.customers;
    c.nodes.forEach(k => {
      if (!k.defaultEmailAddress || k.defaultEmailAddress.marketingState !== 'SUBSCRIBED') return;
      totaal++;
      const dag = nlDag(k.createdAt);
      if (dag >= sinds) { nieuw++; perDag[dag] = (perDag[dag] || 0) + 1; }
      if (dag === vandaag) nieuwVandaag++;
    });
    if (!c.pageInfo.hasNextPage) break;
    na = c.pageInfo.endCursor;
  }

  const uit = { totaal, nieuw, vandaag: nieuwVandaag, sinds, perDag, bijgewerkt: Date.now() };
  await werkRef(uid).child('mailinglijst').set(uit);
  return uit;
}

/* ═══════════ Stempelkaarten ═══════════
   De website houdt per klant bij hoeveel er besteed is sinds de start van de
   spaarkaart (cbx.spaarsaldo, zonder verzendkosten) en hoeveel volle kaarten
   al verzilverd zijn (cbx.kaarten_verzilverd). Hier rekenen we dat om naar
   wat HQ nodig heeft voor de productie: hoeveel beloningen klaarliggen en
   hoeveel kaarten bijna vol zijn. Alleen getallen, geen namen. */
const STEMPEL_EURO = 25, STEMPELS_PER_KAART = 6;

exports.telStempels = onCall(async req => {
  try { return await telStempelsBinnen(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('telStempels', e);
    throw new HttpsError('internal', 'Stempels tellen mislukt: ' + String((e && e.message) || e).slice(0, 200));
  }
});

async function telStempelsBinnen(req) {
  const uid = wieBenJe(req);
  const { winkel, token: t } = await token(uid);
  let open = 0, klantenVol = 0, bijna = 0, deelnemers = 0, verzilverd = 0, na = null;
  const klanten = [];
  const aanmeldingen = [];   // aanmelddatums van iedereen op de mailinglijst (geen namen)
  for (let ronde = 0; ronde < 40; ronde++) {
    const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        query: 'query($na:String){customers(first:250,after:$na){nodes{id displayName numberOfOrders createdAt defaultEmailAddress{marketingState} s:metafield(namespace:"cbx",key:"spaarsaldo"){value} v:metafield(namespace:"cbx",key:"kaarten_verzilverd"){value}} pageInfo{hasNextPage endCursor}}}',
        variables: { na }
      })
    });
    if (r.status === 401) {
      await geheimRef(uid).child('shopify/token').remove();
      throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
    }
    if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
    const d = await r.json();
    if (d.errors && d.errors.length) {
      const tekst = JSON.stringify(d.errors);
      if (/ACCESS_DENIED|read_customers|access/i.test(tekst)) {
        throw new HttpsError('permission-denied',
          'HQ mag nog geen klanten lezen. Zet in het Shopify Dev Dashboard bij je app de scope read_customers aan en installeer de app opnieuw.');
      }
      throw new HttpsError('internal', 'Shopify gaf een fout: ' + tekst.slice(0, 200));
    }
    const c = d.data.customers;
    c.nodes.forEach(k => {
      if (k.defaultEmailAddress && k.defaultEmailAddress.marketingState === 'SUBSCRIBED') aanmeldingen.push(k.createdAt);
      const saldo = k.s ? parseFloat(k.s.value) : 0;
      if (!(saldo > 0)) return;
      deelnemers++;
      const stempels = Math.floor(saldo / STEMPEL_EURO + 1e-9);
      const ver = k.v ? (parseInt(k.v.value, 10) || 0) : 0;
      const kl = stempelKlant(k.id, k.displayName, saldo, ver);
      kl.orders = parseInt(k.numberOfOrders, 10) || 0;
      klanten.push(kl);
      verzilverd += ver;
      const o = Math.max(0, Math.floor(stempels / STEMPELS_PER_KAART) - ver);
      if (o) { open += o; klantenVol++; }
      if (stempels % STEMPELS_PER_KAART === STEMPELS_PER_KAART - 1) bijna++;
    });
    if (!c.pageInfo.hasNextPage) break;
    na = c.pageInfo.endCursor;
  }
  /* ── voorspelling ──
     Wie zit nog maar één gemiddelde bestelling van een volle kaart af, en hoe
     groot is de kans dat zo iemand nog eens bestelt? Allebei uit je eigen
     cijfers: de gemiddelde besteding per bestelling en je herhaalpercentage. */
  const besteed = klanten.reduce((n, k) => n + k.saldo, 0);
  const bestellingen = klanten.reduce((n, k) => n + k.orders, 0);
  const gemOrder = bestellingen ? besteed / bestellingen : 0;
  const metOrder = klanten.filter(k => k.orders >= 1).length;
  const herhaal = metOrder ? klanten.filter(k => k.orders >= 2).length / metOrder : 0;
  const kaartEuro = STEMPEL_EURO * STEMPELS_PER_KAART;

  /* Gebruikt iemand zijn volle kaart? Dat doet hij als hij opnieuw bestelt.
     De kans daarop lezen we af uit je eigen klanten: van iedereen met n
     bestellingen, welk deel kwam terug voor een (n+1)e? Vanaf 5 bestellingen
     samengenomen, anders zijn de groepjes te klein. Met een kleine demping
     (+1/+2) zodat één klant in een groep geen 0% of 100% oplevert. */
  const KAP = 5;
  const kansBij = {};
  for (let n = 1; n <= KAP; n++) {
    const basis = klanten.filter(k => (n < KAP ? k.orders === n : k.orders >= n) || k.orders > n).length;
    const verder = klanten.filter(k => k.orders > n).length;
    kansBij[n] = (verder + 1) / (basis + 2);
  }
  const kans = k => kansBij[Math.max(1, Math.min(KAP, k.orders || 1))];
  klanten.forEach(k => { k.kans = Math.round(kans(k) * 100); });

  /* volle kaarten, gewogen met de kans dat ze gebruikt worden */
  const verwachtVol = klanten.reduce((n, k) => n + k.open * kans(k), 0);
  /* bijna-volle kaarten: wie één gemiddelde bestelling van vol zit en terugkomt,
     heeft na die bestelling een volle kaart én is er dus om hem te gebruiken */
  const kandidaatLijst = klanten.filter(k => {
    const volgende = (Math.floor(k.stempels / STEMPELS_PER_KAART) + 1) * kaartEuro;
    return volgende - k.saldo <= gemOrder;
  });
  const kandidaten = kandidaatLijst.length;
  const verwachtNieuw = kandidaatLijst.reduce((n, k) => n + kans(k), 0);
  const verwacht = Math.ceil(verwachtNieuw);

  /* ── welke doos? ──
     Een volle kaart is €24,95: de doos van 16 gratis, of korting op de 25.
     Per klant kijken we wat hij echt kocht: meer 25's dan 16's, dan gebruikt
     hij zijn kaart waarschijnlijk als korting op de 25. Zonder doos in zijn
     historie (of als Shopify de oude orders niet geeft) beslist zijn
     gemiddelde besteding: rond de prijs van de grote doos of meer → 25. */
  const dozen = await telDozenPerKlant(winkel, t);
  const DOOS25 = 34.95;
  klanten.forEach(k => {
    const d = dozen[k.id];
    if (d && d.length) {
      /* Een kans, geen harde keuze. Recente aankopen wegen zwaarder (laatste 1,
         daarvoor 0,7, dan 0,49 …) maar het verleden telt mee: één afwijking
         verschuift de kans, twee op rij draaien hem om. Met ½ won de laatste
         bestelling altijd van alle eerdere samen — te kort door de bocht. */
      let s16 = 0, s25 = 0, w = 1;
      d.slice().sort((a, b) => String(b.datum).localeCompare(String(a.datum))).forEach(o => {
        if (o.d25) s25 += w;
        if (o.d16) s16 += w;
        w *= 0.7;
      });
      const laatste = d.reduce((a, b) => String(a.datum) > String(b.datum) ? a : b);
      k.kans25 = Math.round(s25 / (s25 + s16) * 100);
      k.doos = k.kans25 >= 50 ? 25 : 16;
      k.doosBron = 'historie';
      k.doosLaatst = laatste.d25 && !laatste.d16 ? 25 : laatste.d16 && !laatste.d25 ? 16 : null;
      k.doosVaak = d.filter(o => o.d25).length >= d.filter(o => o.d16).length ? 25 : 16;
    }
    else {
      /* geen doos in zijn historie: een voorzichtige kans uit zijn besteding */
      const gem = k.orders ? k.saldo / k.orders : 0;
      k.kans25 = gem >= DOOS25 * 0.9 ? 70 : 30;
      k.doos = k.kans25 >= 50 ? 25 : 16; k.doosBron = 'besteding';
    }
  });
  let w16 = 0, w25 = 0;
  /* kansen optellen, niet keuzes: tien klanten met 60% op de 25 zijn
     zes grote en vier kleine dozen, niet tien grote */
  klanten.forEach(k => { const w = k.open * kans(k), p = k.kans25 / 100; w25 += w * p; w16 += w * (1 - p); });
  kandidaatLijst.forEach(k => { const w = kans(k), p = k.kans25 / 100; w25 += w * p; w16 += w * (1 - p); });
  const kaartenTotaal = Math.ceil(w16 + w25 - 1e-9);
  /* afronden naar boven, en een overschot gaat naar de grote doos: liever
     negen bonbons over dan een klant die op zijn doos moet wachten */
  let dozen25 = Math.round(w25), dozen16 = Math.round(w16);
  while (dozen16 + dozen25 < kaartenTotaal) { if (w25 - dozen25 >= w16 - dozen16) dozen25++; else dozen16++; }
  const kansTabel = Object.keys(kansBij).map(n => ({ n: +n, pct: Math.round(kansBij[n] * 100) }));
  const uit = { open, klantenVol, bijna, deelnemers, verzilverd,
    kandidaten, verwacht, herhaalPct: Math.round(herhaal * 100), gemOrder: Math.round(gemOrder * 100) / 100,
    verwachtVol: Math.round(verwachtVol * 10) / 10, verwachtNieuw: Math.round(verwachtNieuw * 10) / 10, kansTabel,
    dozen16, dozen25, dozenUitHistorie: klanten.filter(k => k.doosBron === 'historie').length,
    perStempel: STEMPEL_EURO, perKaart: STEMPELS_PER_KAART, bijgewerkt: Date.now() };
  /* Alleen de getallen gaan de database in; de namenlijst komt alleen terug
     naar het scherm dat erom vroeg en blijft verder bij Shopify. */
  await werkRef(uid).child('stempels').set(uit);
  return Object.assign({ klanten, aanmeldingen }, uit);
}

/* Alle bestellingen: datum, klant, bedrag en hoeveel dozen van 16 en 25.
   Een minuut onthouden, zodat stempels en voorspelling niet allebei opnieuw
   alles bij Shopify ophalen. */
let orderGeheugen = { tijd: 0, winkel: '', lijst: null };
async function alleOrders(winkel, t) {
  if (orderGeheugen.lijst && orderGeheugen.winkel === winkel && Date.now() - orderGeheugen.tijd < 60 * 1000) return orderGeheugen.lijst;
  const lijst = [];
  let na = null;
  try {
    for (let ronde = 0; ronde < 20; ronde++) {
      const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          query: 'query($na:String){orders(first:250,after:$na,sortKey:CREATED_AT){nodes{createdAt customer{id} currentSubtotalPriceSet{shopMoney{amount}} lineItems(first:30){nodes{title quantity}}} pageInfo{hasNextPage endCursor}}}',
          variables: { na }
        })
      });
      if (!r.ok) break;
      const d = await r.json();
      if (!d.data || !d.data.orders) break;
      d.data.orders.nodes.forEach(o => {
        const x = {
          datum: o.createdAt,
          klant: o.customer ? String(o.customer.id).split('/').pop() : null,
          bedrag: parseFloat(((o.currentSubtotalPriceSet || {}).shopMoney || {}).amount) || 0,
          d16: 0, d25: 0
        };
        o.lineItems.nodes.forEach(l => {
          if (/\b25\b/.test(l.title)) x.d25 += l.quantity || 1;
          else if (/\b16\b/.test(l.title)) x.d16 += l.quantity || 1;
        });
        lijst.push(x);
      });
      if (!d.data.orders.pageInfo.hasNextPage) break;
      na = d.data.orders.pageInfo.endCursor;
    }
  } catch (e) { console.error('alleOrders', e); }
  orderGeheugen = { tijd: Date.now(), winkel, lijst };
  return lijst;
}

/* per klant de bestellingen met een doos erin: datum en welke doos */
async function telDozenPerKlant(winkel, t) {
  const uit = {};
  (await alleOrders(winkel, t)).forEach(o => {
    if (!o.klant || !(o.d16 || o.d25)) return;
    (uit[o.klant] = uit[o.klant] || []).push({ datum: o.datum, d16: o.d16, d25: o.d25 });
  });
  return uit;
}

/* ═══════════ Productievoorspelling ═══════════
   Hoeveel bonbons moet je maken voor de komende verkoopmaand? Elke maand uit
   je eigen historie wordt toegepast op nu ("als het gaat zoals januari"),
   en het gemiddelde daarvan is het advies.
   - terug: welk deel van je toenmalige klanten kwam terug, en hoe vaak
   - nieuw: hoeveel nieuwe klanten, opgeschaald met de groei van je lijst
   - dozen: dozen per bestelling en de verhouding 16/25
   Plus de stempelkaarten. Afkeur rekent de app er zelf bij, uit je batches. */
const DAG = 864e5;
exports.voorspelProductie = onCall(async req => {
  try { return await voorspelBinnen(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('voorspelProductie', e);
    throw new HttpsError('internal', 'Voorspellen mislukt: ' + String((e && e.message) || e).slice(0, 200));
  }
});

/* Je hele bestelgeschiedenis, per maand (alleen totalen, geen klantgegevens).
   Vast vastgelegd omdat Shopify apps standaard alleen de laatste 60 dagen aan
   bestellingen geeft. Bron: Shopify-analytics, 8 okt 2026.
   nieuw = nieuwe klanten, terug = terugkerende klanten in die maand.
   Dozen: nov '25–mei '26 samen 194× 25 en 182× 16 op 259 bestellingen.
   Nieuwe maanden komen er vanzelf bij zodra ze binnen de 60 dagen vallen. */
const HISTORIE = [
  { maand: '2025-11', naam: 'nov 2025', nieuw: 19, terug: 0 },
  { maand: '2025-12', naam: 'dec 2025', nieuw: 13, terug: 3 },
  { maand: '2026-01', naam: 'jan 2026', nieuw: 67, terug: 7 },
  { maand: '2026-02', naam: 'feb 2026', nieuw: 18, terug: 5 },
  { maand: '2026-03', naam: 'mrt 2026', nieuw: 76, terug: 17 },
  { maand: '2026-04', naam: 'apr 2026', nieuw: 3, terug: 1 },
  { maand: '2026-05', naam: 'mei 2026', nieuw: 21, terug: 9 }
];
const IJKING = { dozenPerOrder: 376 / 259, aandeel25: 194 / 376, ordersPerTerug: 1.1, minKlanten: 10 };

async function voorspelBinnen(req) {
  const uid = wieBenJe(req);
  const st = await telStempelsBinnen(req);
  const aanmeldOp = d => st.aanmeldingen.filter(x => new Date(x).getTime() < new Date(d).getTime()).length;
  const abonneesNu = st.aanmeldingen.length;
  const bestaandNu = st.klanten.filter(k => k.orders >= 1).length;

  /* recente maanden uit Shopify zelf (de laatste 60 dagen) vullen de historie aan */
  const { winkel, token: t } = await token(uid);
  const recent = (await alleOrders(winkel, t)).filter(o => o.bedrag > 0 && o.klant);
  const perMaand = {};
  recent.forEach(o => { const m = String(o.datum).slice(0, 7); (perMaand[m] = perMaand[m] || []).push(o); });
  const historie = HISTORIE.slice();
  Object.keys(perMaand).sort().forEach(m => {
    if (historie.some(h => h.maand === m)) return;
    const kl = new Set(perMaand[m].map(o => o.klant));
    const terug = [...kl].filter(id => { const k = st.klanten.find(x => x.id === id); return k && k.orders > 1; }).length;
    historie.push({ maand: m, naam: new Date(m + '-15').toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' }), nieuw: kl.size - terug, terug });
  });

  /* Per maand: welk deel van je klanten kwam terug (toegepast op je klanten
     van nu) en hoeveel nieuwe klanten er echt bijkwamen. Nieuwe klanten
     schalen we níet op met je mailinglijst: in januari kwamen er 67 nieuwe
     bij terwijl er ±23 op je lijst stonden — die kwamen via lives en TikTok,
     en opschalen gaf onzin (626). Wat er echt gebeurde is eerlijker. */
  let basis = 0;
  const maanden = [];
  historie.forEach(h => {
    if (h.nieuw + h.terug >= IJKING.minKlanten && basis > 0) {
      const terugR = h.terug / basis;
      const terug = bestaandNu * terugR * IJKING.ordersPerTerug, nieuw = h.nieuw;
      maanden.push({ naam: h.naam, terugPct: Math.round(terugR * 100), nieuwToen: h.nieuw,
        terug, nieuw, orders: Math.round(terug + nieuw) });
    }
    basis += h.nieuw;
  });
  if (!maanden.length) throw new HttpsError('failed-precondition', 'Nog te weinig maanden met verkoop om te voorspellen.');

  const gem = k => maanden.reduce((n, m) => n + m[k], 0) / maanden.length;
  const verwachtTerug = gem('terug'), verwachtNieuw = gem('nieuw');

  /* terugkerende klanten: hun eigen kans op de 25, gewogen met hun kans om terug te komen */
  let g = 0, g25 = 0;
  st.klanten.forEach(k => { if (k.orders >= 1 && typeof k.kans25 === 'number') { const w = (k.kans || 0) / 100; g += w; g25 += w * k.kans25 / 100; } });
  const aandeel25Terug = g ? g25 / g : IJKING.aandeel25;
  const dT = verwachtTerug * IJKING.dozenPerOrder, dN = verwachtNieuw * IJKING.dozenPerOrder;
  const w25 = dT * aandeel25Terug + dN * IJKING.aandeel25, w16 = dT + dN - w25;
  const totaal = Math.ceil(w16 + w25 - 1e-9);
  let dozen25 = Math.round(w25), dozen16 = Math.round(w16);
  while (dozen16 + dozen25 < totaal) { if (w25 - dozen25 >= w16 - dozen16) dozen25++; else dozen16++; }

  const sorted = maanden.slice().sort((a, b) => a.orders - b.orders);
  const r1 = x => Math.round(x * 10) / 10;
  const uit = {
    bron: 'historie',
    maanden: maanden.map(m => ({ naam: m.naam, orders: m.orders, terugPct: m.terugPct, nieuwToen: m.nieuwToen })),
    rustig: { naam: sorted[0].naam, orders: sorted[0].orders },
    druk: { naam: sorted[sorted.length - 1].naam, orders: sorted[sorted.length - 1].orders },
    bestaandNu, abonneesNu,
    terugPct: Math.round(gem('terugPct')), verwachtTerug: r1(verwachtTerug), verwachtNieuw: r1(verwachtNieuw),
    dozenPerOrder: Math.round(IJKING.dozenPerOrder * 100) / 100,
    aandeel25Nieuw: Math.round(IJKING.aandeel25 * 100), aandeel25Terug: Math.round(aandeel25Terug * 100),
    dozen16, dozen25, stempel16: st.dozen16 || 0, stempel25: st.dozen25 || 0,
    verwachtOrders: Math.round(verwachtTerug + verwachtNieuw), bijgewerkt: Date.now()
  };
  await werkRef(uid).child('voorspelling').set(uit);
  return uit;
}

function stempelKlant(gid, naam, saldo, ver) {
  const stempels = Math.floor(saldo / STEMPEL_EURO + 1e-9);
  return {
    id: String(gid).split('/').pop(), naam: naam || 'Klant zonder naam',
    saldo: Math.round(saldo * 100) / 100, stempels, ver,
    open: Math.max(0, Math.floor(stempels / STEMPELS_PER_KAART) - ver),
    rest: stempels % STEMPELS_PER_KAART
  };
}

/* Per klant bijstellen: stempels erbij of eraf (dat is €25 saldo per stempel,
   zodat de website en HQ hetzelfde blijven tellen) en een kaart verzilveren
   of dat terugdraaien. */
exports.stempelAanpassen = onCall(async req => {
  try { return await stempelAanpassenBinnen(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('stempelAanpassen', e);
    throw new HttpsError('internal', 'Aanpassen mislukt: ' + String((e && e.message) || e).slice(0, 200));
  }
});

async function stempelAanpassenBinnen(req) {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const id = String(d.id || '');
  if (!/^\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende klant.');
  const ds = Math.max(-6, Math.min(6, parseInt(d.stempels, 10) || 0));
  const dk = Math.max(-1, Math.min(1, parseInt(d.kaarten, 10) || 0));
  if (!ds && !dk) throw new HttpsError('invalid-argument', 'Niets om aan te passen.');
  const { winkel, token: t } = await token(uid);

  const gql = async (query, variables) => {
    const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (r.status === 401) {
      await geheimRef(uid).child('shopify/token').remove();
      throw new HttpsError('permission-denied', 'Shopify weigerde het token. Probeer het nog een keer.');
    }
    if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
    const j = await r.json();
    if (j.errors && j.errors.length) {
      const tekst = JSON.stringify(j.errors);
      if (/ACCESS_DENIED|write_customers|access/i.test(tekst)) {
        throw new HttpsError('permission-denied',
          'HQ mag nog geen klanten aanpassen. Zet in het Shopify Dev Dashboard bij je app de scope write_customers aan en installeer de app opnieuw.');
      }
      throw new HttpsError('internal', 'Shopify gaf een fout: ' + tekst.slice(0, 200));
    }
    return j.data;
  };

  const gid = 'gid://shopify/Customer/' + id;
  const c = (await gql('query($id:ID!){customer(id:$id){id displayName s:metafield(namespace:"cbx",key:"spaarsaldo"){value} v:metafield(namespace:"cbx",key:"kaarten_verzilverd"){value}}}', { id: gid })).customer;
  if (!c) throw new HttpsError('not-found', 'Deze klant bestaat niet (meer) in Shopify.');
  let saldo = c.s ? (parseFloat(c.s.value) || 0) : 0;
  let ver = c.v ? (parseInt(c.v.value, 10) || 0) : 0;
  saldo = Math.max(0, Math.round((saldo + ds * STEMPEL_EURO) * 100) / 100);
  const vol = Math.floor(Math.floor(saldo / STEMPEL_EURO + 1e-9) / STEMPELS_PER_KAART);
  if (dk > 0 && ver >= vol) throw new HttpsError('failed-precondition', 'Deze klant heeft geen volle kaart om te verzilveren.');
  ver = Math.max(0, ver + dk);

  const m = [];
  if (ds) m.push({ ownerId: gid, namespace: 'cbx', key: 'spaarsaldo', type: 'number_decimal', value: saldo.toFixed(2) });
  if (dk) m.push({ ownerId: gid, namespace: 'cbx', key: 'kaarten_verzilverd', type: 'number_integer', value: String(ver) });
  const uit = (await gql('mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){metafields{key value} userErrors{field message}}}', { m })).metafieldsSet;
  if (uit.userErrors && uit.userErrors.length) {
    throw new HttpsError('internal', 'Shopify weigerde: ' + uit.userErrors.map(x => x.message).join(', ').slice(0, 200));
  }
  return stempelKlant(c.id, c.displayName, saldo, ver);
}

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

/* ─────── voorraad die jij invult in HQ, leidend voor de webshop ─────── */

exports.shopifyVoorraadOphalen = onCall(async req => {
  const uid = wieBenJe(req);
  const locatieId = await shopifyLocatie(uid);

  const producten = [];
  let pad = 'products.json?status=active,draft&limit=250';
  for (let ronde = 0; ronde < 4; ronde++) {
    const { gegevens, volgende } = await shopifyPagina(uid, pad);
    (gegevens.products || []).forEach(p => producten.push(p));
    if (!volgende) break;
    pad = 'products.json?limit=250&page_info=' + encodeURIComponent(volgende);
  }

  const regels = [];
  producten.forEach(p => {
    (p.variants || []).forEach(v => {
      regels.push({
        inventoryItemId: v.inventory_item_id,
        titel: p.title,
        variantTitel: v.title === 'Default Title' ? '' : v.title,
        aantal: v.inventory_quantity
      });
    });
  });

  return { locatieId, regels };
});

exports.shopifyVoorraadZetten = onCall(async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const inventoryItemId = Number(d.inventoryItemId);
  const aantal = Number(d.aantal);
  if (!inventoryItemId) throw new HttpsError('invalid-argument', 'Welk product?');
  if (!Number.isFinite(aantal) || aantal < 0) throw new HttpsError('invalid-argument', 'Vul een geldig aantal in.');

  const locatieId = await shopifyLocatie(uid);
  await shopifySchrijf(uid, 'inventory_levels/set.json', {
    location_id: locatieId,
    inventory_item_id: inventoryItemId,
    available: aantal
  });

  /* bewaren wat je hebt ingevuld, zodat je het terugziet zonder opnieuw
     bij Shopify te hoeven vragen */
  await werkRef(uid).child('voorraadShopify/' + inventoryItemId).set({
    aantal, bijgewerkt: Date.now()
  });

  return { ok: true };
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

/* Het indelen tegen je eigen lijst staat ook apart, want de lijst groeit en
   deze functie moet klein blijven. */
Object.assign(exports, require('./beoordeelCode'));

/* Clips bekijken voor de nieuwe videoflow in Studio: wat gebeurt er, bij welk
   onderdeel hoort het, hoe sterk is het shot. Ook apart, om dezelfde reden. */
Object.assign(exports, require('./analyseerClip'));

/* De regie: van bekeken clips een montageplan maken. Ook apart. */
Object.assign(exports, require('./maakRegie'));

/* ═══════════════════════════════════════════════════════════════════
   Claude laten meelezen

   Een connector die je in claude.ai toevoegt. Claude kan daarmee je
   app-gegevens LEZEN — uren, batches, voorraad, alles wat de app bewaart —
   maar nooit iets wijzigen. De sleutels onder geheim blijven buiten bereik.

   Hoe het werkt: in de app maak je bij Koppelingen een link. Die link
   bevat een lange willekeurige sleutel; wie hem heeft, kan lezen. Maak je
   een nieuwe, dan werkt de oude meteen niet meer.
   ═══════════════════════════════════════════════════════════════════ */

const { onRequest } = require('firebase-functions/v2/https');
const crypto = require('crypto');

const connectorRef = sleutel => db().ref('geheim/_connector/' + sleutel);
const TZ = 'Europe/Amsterdam';

exports.claudeMeelezen = onCall(async req => {
  const uid = wieBenJe(req);
  const oud = await leesGeheim(uid, 'meelezen');
  if (oud && oud.sleutel) await connectorRef(oud.sleutel).remove();

  if ((req.data || {}).weg) {
    await geheimRef(uid).child('meelezen').remove();
    await werkRef(uid).child('koppeling/meelezen').remove();
    return { ok: true };
  }

  const sleutel = crypto.randomBytes(24).toString('hex');
  await connectorRef(sleutel).set(uid);
  await geheimRef(uid).child('meelezen').set({ sleutel, gemaakt: Date.now() });
  await werkRef(uid).child('koppeling').update({ meelezen: true });
  const project = process.env.GCLOUD_PROJECT || 'cacaoboetiek-hq';
  return { ok: true, url: `https://europe-west1-${project}.cloudfunctions.net/claudeLees/${sleutel}` };
});

/* ── hulpjes ── */
const alsLijst = v => Array.isArray(v) ? v.filter(Boolean)
  : (v && typeof v === 'object') ? Object.values(v).filter(Boolean) : [];
const dagVan = ms => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ms));
const tijdVan = ms => new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const weekdag = ms => new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, weekday: 'long' }).format(new Date(ms));
const uurGetal = sec => Math.round(sec / 36) / 100;

/* Alle tijdregels uit de app op één hoop: productiestappen in batches en
   losse klussen (zoals mallen wassen op een dag zonder productie). */
function tijdRegels(S) {
  const regels = [];
  const soortNaam = { coderen: 'Coderen', website: 'Website & shop', administratie: 'Administratie',
    inkoop: 'Inkoop', marketing: 'Marketing', onderhoud: 'Onderhoud & checks', overig: 'Overig' };
  alsLijst(S.batches).forEach(b => {
    alsLijst(b.werk).forEach(w => {
      if (!w.start) return;
      const eind = w.eind || null;
      regels.push({ start: w.start, eind, activiteit: w.act || '?',
        bron: 'batch ' + (b.code || b.id || ''),
        sec: Math.max(0, Math.round(((eind || Date.now()) - w.start) / 1000)) });
    });
  });
  const klussen = alsLijst(S.klussen);
  if (S.klus) klussen.push(S.klus);
  klussen.forEach(k => {
    if (!k.start) return;
    const eind = k.eind || null;
    const sec = (k.sec != null) ? k.sec : Math.max(0, Math.round(((eind || Date.now()) - k.start) / 1000));
    regels.push({ start: k.start, eind, activiteit: k.tekst || soortNaam[k.soort] || k.soort || '?',
      bron: 'klus · ' + (soortNaam[k.soort] || k.soort || 'overig'), sec });
  });
  return regels.sort((a, b) => a.start - b.start);
}

function urenRapport(S, a) {
  const zoek = String(a.zoek || '').toLowerCase().trim();
  const van = a.van || '0000-01-01', tot = a.tot || '9999-12-31';
  const rijen = tijdRegels(S).filter(r => {
    const d = dagVan(r.start);
    if (d < van || d > tot) return false;
    return !zoek || (r.activiteit + ' ' + r.bron).toLowerCase().includes(zoek);
  });
  const perDag = {}, perAct = {};
  let totaal = 0;
  rijen.forEach(r => {
    const d = dagVan(r.start);
    const pd = perDag[d] = perDag[d] || { datum: d, dag: weekdag(r.start), van: tijdVan(r.start), tot: null, sec: 0 };
    pd.sec += r.sec;
    pd.tot = r.eind ? tijdVan(r.eind) : 'loopt nog';
    perAct[r.activiteit] = (perAct[r.activiteit] || 0) + r.sec;
    totaal += r.sec;
  });
  /* diensten: van inklokken tot uitklokken */
  const diensten = alsLijst(S.diensten).concat(S.dienst ? [S.dienst] : [])
    .filter(d => d.start && dagVan(d.start) >= van && dagVan(d.start) <= tot)
    .map(d => ({ datum: dagVan(d.start), van: tijdVan(d.start), tot: d.eind ? tijdVan(d.eind) : 'loopt nog',
      uren: uurGetal(d.sec || Math.round(((d.eind || Date.now()) - d.start) / 1000)) }));
  return {
    filter: { van: a.van || null, tot: a.tot || null, zoek: a.zoek || null },
    totaal_uren: uurGetal(totaal),
    per_dag: Object.values(perDag).map(x => ({ datum: x.datum, dag: x.dag, van: x.van, tot: x.tot, uren: uurGetal(x.sec) })),
    per_activiteit: Object.entries(perAct).sort((x, y) => y[1] - x[1]).map(([act, s]) => ({ activiteit: act, uren: uurGetal(s) })),
    regels: rijen.slice(-400).map(r => ({ datum: dagVan(r.start), van: tijdVan(r.start),
      tot: r.eind ? tijdVan(r.eind) : 'loopt nog', uren: uurGetal(r.sec), activiteit: r.activiteit, bron: r.bron })),
    diensten: zoek ? undefined : diensten
  };
}

function beschrijf(v) {
  if (Array.isArray(v)) return 'lijst (' + v.length + ')';
  if (v && typeof v === 'object') return 'object (' + Object.keys(v).length + ' sleutels)';
  return typeof v;
}
function kort(v, max) {
  const s = JSON.stringify(v, null, 1);
  return s.length > max ? s.slice(0, max) + `\n… (afgekapt, ${s.length} tekens in totaal — vraag een dieper pad of gebruik van/aantal)` : s;
}
function zoekIn(v, tekst, pad, uit) {
  if (uit.length >= 60) return;
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) zoekIn(v[k], tekst, pad ? pad + '/' + k : k, uit);
  } else if (v != null && String(v).toLowerCase().includes(tekst)) {
    uit.push({ pad, waarde: String(v).slice(0, 160) });
  }
}

const TOOLS = [
  { name: 'uren',
    description: 'Gewerkte tijd uit Cacaoboetiek HQ: productiestappen in batches en losse klussen. Geeft totaal, per dag (met weekdag en tijden), per activiteit en alle losse regels. Filter optioneel op periode en op activiteit (bijv. "mallen wassen"). Tijden in Europe/Amsterdam.',
    inputSchema: { type: 'object', properties: {
      van: { type: 'string', description: 'Begindatum JJJJ-MM-DD (optioneel)' },
      tot: { type: 'string', description: 'Einddatum JJJJ-MM-DD (optioneel)' },
      zoek: { type: 'string', description: 'Deel van de activiteitsnaam, bijv. "mallen"' } } } },
  { name: 'overzicht',
    description: 'Welke gegevens er in de app staan: elke sleutel met type en aantal. Bron "app" is de hoofdopslag, "werkvloer" de orders/opdrachten-tak.',
    inputSchema: { type: 'object', properties: {
      bron: { type: 'string', enum: ['app', 'werkvloer'] } } } },
  { name: 'lees',
    description: 'Lees een stuk app-data op pad, bijv. "recepten", "batches/3", "voorraad". Lijsten kun je in stukken lezen met van/aantal.',
    inputSchema: { type: 'object', required: ['pad'], properties: {
      pad: { type: 'string' }, bron: { type: 'string', enum: ['app', 'werkvloer'] },
      van: { type: 'integer' }, aantal: { type: 'integer' } } } },
  { name: 'zoek',
    description: 'Zoek tekst door alle app-data heen; geeft paden met de gevonden waarde.',
    inputSchema: { type: 'object', required: ['tekst'], properties: {
      tekst: { type: 'string' }, bron: { type: 'string', enum: ['app', 'werkvloer'] } } } }
];

async function voerUit(uid, naam, a) {
  const bron = (a && a.bron === 'werkvloer') ? 'werkvloer/' : 'cacaoboetiek/';
  const lees = async pad => (await db().ref(bron + uid + (pad ? '/' + pad : '')).once('value')).val();
  if (naam === 'uren') return urenRapport((await db().ref('cacaoboetiek/' + uid).once('value')).val() || {}, a || {});
  if (naam === 'overzicht') {
    const S = (await lees('')) || {};
    const o = {}; Object.keys(S).sort().forEach(k => { o[k] = beschrijf(S[k]) });
    return o;
  }
  if (naam === 'lees') {
    const pad = String(a.pad || '').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '');
    let v = await lees(pad);
    if (v == null) return { pad, waarde: null };
    if (a.van != null || a.aantal != null) {
      const l = Array.isArray(v) ? v : Object.values(v);
      const van = a.van || 0;
      v = { totaal: l.length, van, items: l.slice(van, van + (a.aantal || 20)) };
    }
    return kort(v, 60000);
  }
  if (naam === 'zoek') {
    const uit = []; zoekIn(await lees(''), String(a.tekst || '').toLowerCase(), '', uit);
    return uit;
  }
  throw new Error('Onbekende tool: ' + naam);
}

exports.claudeLees = onRequest({ invoker: 'public', cors: false }, async (req, res) => {
  const sleutel = String(req.path || '').split('/').filter(Boolean)[0] || '';
  const uid = /^[0-9a-f]{48}$/.test(sleutel) ? (await connectorRef(sleutel).once('value')).val() : null;
  if (!uid) return res.status(404).send('Niet gevonden');
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').send('');

  const antwoord = async m => {
    const id = m.id;
    if (id === undefined || id === null) return null;   /* melding, geen antwoord */
    const ok = result => ({ jsonrpc: '2.0', id, result });
    try {
      switch (m.method) {
        case 'initialize':
          return ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'cacaoboetiek-hq', version: '1.0.0' },
            instructions: 'Alleen-lezen toegang tot Cacaoboetiek HQ. Gebruik "uren" voor gewerkte tijd, "overzicht" om te zien wat er is, "lees" en "zoek" voor de rest.' });
        case 'ping': return ok({});
        case 'tools/list': return ok({ tools: TOOLS });
        case 'tools/call': {
          const p = m.params || {};
          try {
            const r = await voerUit(uid, p.name, p.arguments || {});
            return ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] });
          } catch (e) {
            return ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
          }
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Onbekende methode' } };
      }
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
    }
  };

  const body = req.body;
  if (Array.isArray(body)) {
    const uit = (await Promise.all(body.map(antwoord))).filter(Boolean);
    return uit.length ? res.json(uit) : res.status(202).send('');
  }
  const r = await antwoord(body || {});
  return r ? res.json(r) : res.status(202).send('');
});
