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
const { onSchedule } = require('firebase-functions/v2/scheduler');
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

/* ═══════════ Wenskaarten (v950) ═══════════
   De webshop zet de kaarttekst bij de doos zelf, als eigenschap van de
   orderregel: "Tekst kaartje" (nu) of "Persoonlijke boodschap" (ouder).
   Eén order kan dus meerdere kaarten hebben: één per doos.
   De ordernotitie gebruiken we NIET meer: daar staan ook factuurgegevens
   in, en die horen niet op een kaart. */
const KAARTTEKST = ['tekst kaartje', 'persoonlijke boodschap', 'boodschap', 'wenskaart', 'kaartje', 'kaarttekst'];
const KAARTREGEL = /kaartje|wenskaart/i;

function regelKenmerken(li) {
  const uit = {};
  (li.properties || []).forEach(a => {
    if (a && a.name && !String(a.name).startsWith('_')) uit[String(a.name).toLowerCase().trim()] = a.value;
  });
  return uit;
}

function kaartTekstUit(k) {
  for (const sl of KAARTTEKST) {
    const v = String(k[sl] || '').trim();
    if (v) return v;
  }
  return '';
}

/* Alle kaarten van één order: tekst, voor wie, bij welke doos.
   Een betaald kaartje zonder tekst telt ook mee — dan weet je dat er
   nog iets ontbreekt in plaats van dat je hem vergeet. */
function kaartenVan(o) {
  const kaarten = [];
  (o.line_items || []).filter(li => !li.gift_card).forEach(li => {
    const k = regelKenmerken(li);
    const tekst = kaartTekstUit(k);
    if (!tekst) return;
    const n = Math.max(1, Number(li.quantity) || 1);
    for (let i = 0; i < n; i++) {
      kaarten.push({ tekst, voor: String(k['voor'] || '').trim(), bij: String(li.title || '') });
    }
  });
  const ok = kaartTekstUit(kenmerken(o));
  if (ok && !kaarten.some(x => x.tekst === ok)) kaarten.push({ tekst: ok, voor: '', bij: 'order' });

  if (!kaarten.length) {
    (o.line_items || []).filter(li => KAARTREGEL.test(String(li.title || ''))).forEach(li => {
      kaarten.push({ tekst: '', voor: '', bij: String(li.title || ''), ontbreekt: true });
    });
  }
  return kaarten;
}

function boodschapVan(o) {
  const k = kaartenVan(o).find(x => x.tekst);
  return k ? k.tekst : '';
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
    wenskaart_gevraagd: kaartenVan(o).length > 0,
    wenskaarten: kaartenVan(o).length,
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

  /* v979: reserve-mailbox (bijv. h.ngadi@) voor als info@ aan de verzendlimiet zit */
  if (d.mail2) {
    const adres = String(d.mail2.adres || '').trim().toLowerCase();
    const wachtwoord = String(d.mail2.wachtwoord || '');
    if (!adres || !wachtwoord) throw new HttpsError('invalid-argument', 'Vul het mailadres en wachtwoord in.');
    await MAIL.testInlog(adres, wachtwoord);
    await geheimRef(uid).child('mail2').set({ adres, wachtwoord });
    await werkRef(uid).child('koppeling').update({ mail2: true });
    return { ok: true, adres };
  }

  if (d.mail) {
    const adres = String(d.mail.adres || '').trim().toLowerCase();
    const wachtwoord = String(d.mail.wachtwoord || '');
    if (!adres || !wachtwoord) throw new HttpsError('invalid-argument', 'Vul je mailadres en wachtwoord in.');
    await MAIL.testInlog(adres, wachtwoord);   /* lukt dit niet, dan slaan we niets op */
    await geheimRef(uid).child('mail').set({ adres, wachtwoord });
    await werkRef(uid).child('koppeling').update({ mail: true });
    return { ok: true, adres };
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
  if (!['shopify', 'myparcel', 'claude', 'mail', 'mail2'].includes(welke)) {
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
/* Het moment van aanmelden = wanneer de mail-toestemming op "ja" ging
   (marketingUpdatedAt). createdAt is wanneer de klant ooit ontstond: een
   klant van vorig jaar die zich vandaag aanmeldt, telde anders op die oude dag.
   Het laatste van de twee, zodat een nieuwe pop-up-aanmelding gewoon klopt. */
const aanmeldMoment = k => {
  const c = k.createdAt, m = k.defaultEmailAddress && k.defaultEmailAddress.marketingUpdatedAt;
  return m && m > c ? m : c;
};

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
        query: 'query($na:String){customers(first:250,after:$na){nodes{createdAt defaultEmailAddress{marketingState marketingUpdatedAt}} pageInfo{hasNextPage endCursor}}}',
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
      const dag = nlDag(aanmeldMoment(k));
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

/* ═══════════ Mailinglijst: wie ═══════════
   Op verzoek van Hamza: de adressen zelf, alleen voor hem in HQ.
   Ze gaan rechtstreeks naar het scherm en worden nergens opgeslagen. */
exports.mailAdressen = onCall(async req => {
  try {
    const uid = wieBenJe(req);
    /* v812: weghalen loopt via deze functie, die al bereikbaar is */
    if ((req.data || {}).weg) return await adresWeghalen(uid, req.data.weg);
    /* v982: tikfout in een klantadres verbeteren (bijv. hotmail.comm → hotmail.com) */
    if ((req.data || {}).wijzig) {
      const w = req.data.wijzig, nr = String(w.id || '').replace(/\D/g, ''), email = String(w.email || '').trim().toLowerCase();
      if (!nr || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new HttpsError('invalid-argument', 'Dat mailadres klopt niet.');
      const gql = await shopifyGql(uid, 'write_customers');
      const r = (await gql('mutation($i:CustomerInput!){customerUpdate(input:$i){customer{id} userErrors{field message}}}', { i: { id: 'gid://shopify/Customer/' + nr, email } })).customerUpdate;
      if (r.userErrors && r.userErrors.length) throw new HttpsError('invalid-argument', 'Shopify: ' + r.userErrors.map(x => x.message).join(', ').slice(0, 200));
      await werkRef(uid).child('dropMail').child('drop-8-nov').child('ongeldig').child(nr).remove();
      return { ok: true, email };
    }
    const sinds = /^\d{4}-\d{2}-\d{2}$/.test((req.data || {}).sinds || '') ? req.data.sinds : '2000-01-01';
    const { winkel, token: t } = await token(uid);
    const uit = []; let na = null;
    for (let ronde = 0; ronde < 40; ronde++) {
      const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          query: 'query($na:String){customers(first:250,after:$na){nodes{id createdAt firstName lastName numberOfOrders lastOrder{createdAt} defaultEmailAddress{emailAddress marketingState marketingUpdatedAt}} pageInfo{hasNextPage endCursor}}}',
          variables: { na }
        })
      });
      if (!r.ok) throw new HttpsError('internal', duiding(r.status, await r.text()));
      const d = await r.json();
      if (d.errors && d.errors.length) throw new HttpsError('internal', 'Shopify gaf een fout: ' + JSON.stringify(d.errors).slice(0, 200));
      const c = d.data.customers;
      c.nodes.forEach(k => {
        const e = k.defaultEmailAddress;
        if (!e || e.marketingState !== 'SUBSCRIBED') return;
        const moment = aanmeldMoment(k), dag = nlDag(moment);
        if (dag < sinds) return;
        uit.push({ id: String(k.id).split('/').pop(), email: e.emailAddress, naam: [k.firstName, k.lastName].filter(Boolean).join(' '), voornaam: k.firstName || '', datum: dag, tijd: moment,
          orders: parseInt(k.numberOfOrders, 10) || 0, laatsteOrder: (k.lastOrder && k.lastOrder.createdAt) || null });
      });
      if (!c.pageInfo.hasNextPage) break;
      na = c.pageInfo.endCursor;
    }
    uit.sort((a, b) => String(b.tijd).localeCompare(String(a.tijd)));
    return { sinds, lijst: uit };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('mailAdressen', e);
    throw new HttpsError('internal', 'Ophalen mislukt: ' + String((e && e.message) || e).slice(0, 200));
  }
});

/* ═══════════ Mailinglijst: testadres weghalen (v811) ═══════════
   Voor adressen die Hamza zelf als test heeft ingevuld.
   Nooit besteld → klant helemaal wissen uit Shopify (niet terug te draaien).
   Wel besteld → Shopify laat wissen niet toe; dan alleen afmelden van mail.
   De client vraagt eerst om bevestiging en geeft het e-mailadres mee; dat
   moet kloppen met wat Shopify bij dit id heeft, anders gebeurt er niets. */
async function adresWeghalen(uid, d) {
  d = d || {};
  const id = String(d.id || '');
  if (!/^\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende klant.');
  let { winkel, token: t } = await token(uid);
  let vers = false;
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
        if (!vers) {
          vers = true;
          await geheimRef(uid).child('shopify/token').remove();
          ({ winkel, token: t } = await token(uid));
          return gql(query, variables);
        }
        throw new HttpsError('permission-denied',
          'HQ mag nog geen klanten aanpassen. Zet in het Shopify Dev Dashboard bij je app de scope write_customers aan en installeer de app opnieuw.');
      }
      throw new HttpsError('internal', 'Shopify gaf een fout: ' + tekst.slice(0, 200));
    }
    return j.data;
  };
  const gid = 'gid://shopify/Customer/' + id;
  const c = (await gql('query($id:ID!){customer(id:$id){id numberOfOrders defaultEmailAddress{emailAddress}}}', { id: gid })).customer;
  if (!c) return { actie: 'al-weg' };
  const mail = ((c.defaultEmailAddress || {}).emailAddress || '').toLowerCase();
  if (!d.email || mail !== String(d.email).toLowerCase()) {
    throw new HttpsError('failed-precondition', 'Dit adres klopt niet meer met Shopify. Ververs de lijst en probeer opnieuw.');
  }
  const fout = ue => { if (ue && ue.length) throw new HttpsError('failed-precondition', 'Shopify: ' + ue.map(x => x.message).join(', ')); };
  if ((parseInt(c.numberOfOrders, 10) || 0) === 0) {
    const r = await gql('mutation($id:ID!){customerDelete(input:{id:$id}){deletedCustomerId userErrors{message}}}', { id: gid });
    fout(r.customerDelete.userErrors);
    return { actie: 'gewist' };
  }
  const r = await gql('mutation($id:ID!){customerEmailMarketingConsentUpdate(input:{customerId:$id,emailMarketingConsent:{marketingState:UNSUBSCRIBED}}){userErrors{message}}}', { id: gid });
  fout(r.customerEmailMarketingConsentUpdate.userErrors);
  return { actie: 'afgemeld' };
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
  const overig = [];         // klanten zonder stempels, alleen om op naam te kunnen zoeken
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
      if (!(saldo > 0)) {
        overig.push({ id: String(k.id).split('/').pop(), naam: k.displayName || 'Klant zonder naam', orders: parseInt(k.numberOfOrders, 10) || 0 });
        return;
      }
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
    giftcards: await telGiftcards(uid),
    perStempel: STEMPEL_EURO, perKaart: STEMPELS_PER_KAART, bijgewerkt: Date.now() };
  /* Alleen de getallen gaan de database in; de namenlijst komt alleen terug
     naar het scherm dat erom vroeg en blijft verder bij Shopify. */
  await werkRef(uid).child('stempels').set(uit);
  return Object.assign({ klanten, overig, aanmeldingen }, uit);
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
  let { winkel, token: t } = await token(uid);
  let vers = false;

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
        /* v788: het token wordt een dag bewaard. Zet je de scope net aan, dan
           heeft het oude token hem nog niet. Eén keer een vers token halen. */
        if (!vers) {
          vers = true;
          await geheimRef(uid).child('shopify/token').remove();
          ({ winkel, token: t } = await token(uid));
          return gql(query, variables);
        }
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

/* ═══════════ Giftcards voor volle spaarkaarten (v789) ═══════════
   Eén handeling vanuit HQ: Shopify maakt een giftcard van €24,95 op naam
   van de klant, mailt hem de code, en de kaart telt als verzilverd.
   Terugdraaien zet de giftcard uit (Shopify kan hem daarna niet meer aan)
   en de teller één terug — maar alleen zolang er nog niets van besteed is. */
const GIFTCARD_EURO = '25.00';
const GIFTCARD_NOTITIE = 'Volle spaarkaart (HQ)';
const CADEAU_NOTITIE = 'Cadeau (HQ)';

/* Shopify-vraag met jouw token. Bij een scope-fout eerst één keer een vers
   token halen: het oude wordt een dag bewaard en kent nieuwe rechten nog niet. */
async function shopifyGql(uid, scope) {
  let { winkel, token: t } = await token(uid);
  let vers = false;
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
      if (/ACCESS_DENIED|access/i.test(tekst)) {
        if (!vers) {
          vers = true;
          await geheimRef(uid).child('shopify/token').remove();
          ({ winkel, token: t } = await token(uid));
          return gql(query, variables);
        }
        throw new HttpsError('permission-denied',
          'HQ mag dit nog niet in Shopify. Zet in het Shopify Dev Dashboard bij je app de scope ' + scope +
          ' aan, geef de versie vrij en keur hem goed via App openen in je Shopify-admin.');
      }
      throw new HttpsError('internal', 'Shopify gaf een fout: ' + tekst.slice(0, 200));
    }
    return j.data;
  };
  return gql;
}

function fouten(lijst) {
  return (lijst || []).map(x => x.message).join(', ').slice(0, 200);
}

function netteGiftcard(g) {
  return {
    id: String(g.id).split('/').pop(),
    datum: g.createdAt,
    bedrag: parseFloat(g.initialValue.amount),
    saldo: parseFloat(g.balance.amount),
    aan: !!g.enabled,
    laatste: g.lastCharacters,
    spaarkaart: g.note === GIFTCARD_NOTITIE,
    cadeau: g.note === CADEAU_NOTITIE
  };
}

const GIFTCARD_VELDEN = 'id createdAt enabled lastCharacters note initialValue{amount} balance{amount}';

async function giftcardsVan(gql, klantId) {
  const d = await gql('query($q:String){giftCards(first:20,sortKey:CREATED_AT,reverse:true,query:$q){nodes{' + GIFTCARD_VELDEN + '}}}',
    { q: 'customer_id:' + klantId });
  return d.giftCards.nodes.map(netteGiftcard);
}

function klantId(req) {
  const id = String((req.data || {}).id || '');
  if (!/^\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende klant.');
  return id;
}

function binnen(naam, fn, opties) {
  return onCall(opties || {}, async req => {
    try { return await fn(req); }
    catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(naam, e);
      throw new HttpsError('internal', 'Dat lukte niet: ' + String((e && e.message) || e).slice(0, 200));
    }
  });
}

async function leesKlant(gql, gid) {
  const c = (await gql('query($id:ID!){customer(id:$id){id displayName defaultEmailAddress{emailAddress} s:metafield(namespace:"cbx",key:"spaarsaldo"){value} v:metafield(namespace:"cbx",key:"kaarten_verzilverd"){value}}}', { id: gid })).customer;
  if (!c) throw new HttpsError('not-found', 'Deze klant bestaat niet (meer) in Shopify.');
  return {
    c,
    saldo: c.s ? (parseFloat(c.s.value) || 0) : 0,
    ver: c.v ? (parseInt(c.v.value, 10) || 0) : 0,
    heeftMail: !!(c.defaultEmailAddress && c.defaultEmailAddress.emailAddress)
  };
}

async function zetVerzilverd(gql, gid, ver) {
  const uit = (await gql('mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}',
    { m: [{ ownerId: gid, namespace: 'cbx', key: 'kaarten_verzilverd', type: 'number_integer', value: String(ver) }] })).metafieldsSet;
  if (uit.userErrors && uit.userErrors.length) throw new HttpsError('internal', 'Shopify weigerde: ' + fouten(uit.userErrors));
}

/* De giftcards van één klant, voor zijn kaartje in HQ. */
exports.klantGiftcards = binnen('klantGiftcards', async req => {
  const uid = wieBenJe(req);
  const id = klantId(req);
  const gql = await shopifyGql(uid, 'read_gift_cards');
  /* v799: ook het mailadres, zodat je in HQ ziet waar de giftcard heen gaat.
     Alleen voor deze ene klant, niet voor de hele lijst. */
  const [giftcards, k] = await Promise.all([
    giftcardsVan(gql, id),
    gql('query($id:ID!){customer(id:$id){defaultEmailAddress{emailAddress}}}', { id: 'gid://shopify/Customer/' + id })
  ]);
  const email = k.customer && k.customer.defaultEmailAddress ? k.customer.defaultEmailAddress.emailAddress || '' : '';
  return { giftcards, email };
});

exports.giftcardSturen = binnen('giftcardSturen', async req => {
  const uid = wieBenJe(req);
  const id = klantId(req);
  const gid = 'gid://shopify/Customer/' + id;
  const gql = await shopifyGql(uid, 'write_gift_cards');

  const { c, saldo, ver, heeftMail } = await leesKlant(gql, gid);
  const vol = Math.floor(Math.floor(saldo / STEMPEL_EURO + 1e-9) / STEMPELS_PER_KAART);
  /* Volle kaart: telt als verzilverd. Geen volle kaart: een cadeau van
     Hamza, de stempels blijven dan gewoon staan. */
  const kaartVol = ver < vol;
  if (!heeftMail) throw new HttpsError('failed-precondition',
    'Deze klant heeft geen e-mailadres in Shopify, dus Shopify kan de giftcard niet mailen. Zet eerst een e-mailadres bij de klant.');

  const maak = (await gql('mutation($i:GiftCardCreateInput!){giftCardCreate(input:$i){giftCard{' + GIFTCARD_VELDEN + '} userErrors{message}}}',
    { i: { initialValue: GIFTCARD_EURO, customerId: gid, note: kaartVol ? GIFTCARD_NOTITIE : CADEAU_NOTITIE } })).giftCardCreate;
  if (maak.userErrors && maak.userErrors.length) throw new HttpsError('internal', 'Giftcard maken lukte niet: ' + fouten(maak.userErrors));
  const kaart = maak.giftCard;

  /* eerst tellen, dan mailen: lukt de mail niet, dan staat de kaart er wel
     en kun je hem opnieuw laten sturen */
  const nieuwVer = kaartVol ? ver + 1 : ver;
  if (kaartVol) await zetVerzilverd(gql, gid, nieuwVer);

  let gemaild = true, mailFout = '';
  try {
    const s = (await gql('mutation($id:ID!){giftCardSendNotificationToCustomer(id:$id){userErrors{message}}}', { id: kaart.id }))
      .giftCardSendNotificationToCustomer;
    if (s.userErrors && s.userErrors.length) { gemaild = false; mailFout = fouten(s.userErrors); }
  } catch (e) { gemaild = false; mailFout = String((e && e.message) || e).slice(0, 200); }

  return { klant: stempelKlant(c.id, c.displayName, saldo, nieuwVer), giftcard: netteGiftcard(kaart), gemaild, mailFout, cadeau: !kaartVol };
});

/* De mail nog eens laten sturen (kwijt, in de spam, of de eerste keer mislukt). */
exports.giftcardOpnieuw = binnen('giftcardOpnieuw', async req => {
  const uid = wieBenJe(req);
  const gc = String((req.data || {}).giftcard || '');
  if (!/^\d+$/.test(gc)) throw new HttpsError('invalid-argument', 'Onbekende giftcard.');
  const gql = await shopifyGql(uid, 'write_gift_cards');
  const s = (await gql('mutation($id:ID!){giftCardSendNotificationToCustomer(id:$id){userErrors{message}}}',
    { id: 'gid://shopify/GiftCard/' + gc })).giftCardSendNotificationToCustomer;
  if (s.userErrors && s.userErrors.length) throw new HttpsError('failed-precondition', 'Mailen lukte niet: ' + fouten(s.userErrors));
  return { ok: true };
});

/* ═══════════ Cadeaubon naar een los mailadres (v800) ═══════════
   Voor iemand zonder account of zonder mailadres in Shopify. HQ zoekt de
   klant op mailadres; bestaat hij niet, dan maakt HQ hem aan (zonder
   nieuwsbrief-toestemming). Daarna een giftcard op zijn naam, en Shopify
   mailt de code. */
const CADEAU_MIN = 5, CADEAU_MAX = 250;
exports.cadeaubonMailen = binnen('cadeaubonMailen', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const email = String(d.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200)
    throw new HttpsError('invalid-argument', 'Dat mailadres klopt nog niet.');
  const bedrag = Math.round(parseFloat(String(d.bedrag || '').replace(',', '.')) * 100) / 100;
  if (!(bedrag >= CADEAU_MIN && bedrag <= CADEAU_MAX))
    throw new HttpsError('invalid-argument', 'Kies een bedrag tussen €' + CADEAU_MIN + ' en €' + CADEAU_MAX + '.');
  const naam = String(d.naam || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const gql = await shopifyGql(uid, 'write_gift_cards');

  /* 1. bestaande klant met dit adres? */
  const zoek = await gql('query($q:String){customers(first:5,query:$q){nodes{id displayName defaultEmailAddress{emailAddress}}}}',
    { q: 'email:"' + email.replace(/"/g, '') + '"' });
  let klant = zoek.customers.nodes.find(c => c.defaultEmailAddress && String(c.defaultEmailAddress.emailAddress).toLowerCase() === email);
  let nieuw = false;

  /* 2. zo niet: aanmaken */
  if (!klant) {
    const delen = naam.split(' ');
    const input = { email, tags: ['hq-cadeau'] };
    if (naam) { input.firstName = delen[0]; if (delen.length > 1) input.lastName = delen.slice(1).join(' '); }
    const m = (await gql('mutation($i:CustomerInput!){customerCreate(input:$i){customer{id displayName} userErrors{field message}}}',
      { i: input })).customerCreate;
    if (m.userErrors && m.userErrors.length) {
      if (/taken|already/i.test(fouten(m.userErrors))) throw new HttpsError('already-exists',
        'Dit mailadres hoort al bij een klant in Shopify. Zoek hem op naam en stuur de giftcard vanuit zijn kaartje.');
      throw new HttpsError('internal', 'Klant aanmaken lukte niet: ' + fouten(m.userErrors));
    }
    klant = m.customer; nieuw = true;
  }

  /* 3. giftcard op zijn naam, dan mailen */
  const maak = (await gql('mutation($i:GiftCardCreateInput!){giftCardCreate(input:$i){giftCard{' + GIFTCARD_VELDEN + '} userErrors{message}}}',
    { i: { initialValue: bedrag.toFixed(2), customerId: klant.id, note: CADEAU_NOTITIE } })).giftCardCreate;
  if (maak.userErrors && maak.userErrors.length) throw new HttpsError('internal', 'Giftcard maken lukte niet: ' + fouten(maak.userErrors));

  let gemaild = true, mailFout = '';
  try {
    const s = (await gql('mutation($id:ID!){giftCardSendNotificationToCustomer(id:$id){userErrors{message}}}', { id: maak.giftCard.id }))
      .giftCardSendNotificationToCustomer;
    if (s.userErrors && s.userErrors.length) { gemaild = false; mailFout = fouten(s.userErrors); }
  } catch (e) { gemaild = false; mailFout = String((e && e.message) || e).slice(0, 200); }

  return {
    klant: { id: String(klant.id).split('/').pop(), naam: klant.displayName || naam || email, orders: 0 },
    nieuw, email, giftcard: netteGiftcard(maak.giftCard), gemaild, mailFout
  };
});

/* Terugdraaien: de nieuwste spaarkaart-giftcard die nog onaangeroerd is uit,
   en de teller één terug. Is er al iets van besteed, dan niet. */
exports.giftcardTerug = binnen('giftcardTerug', async req => {
  const uid = wieBenJe(req);
  const id = klantId(req);
  const gid = 'gid://shopify/Customer/' + id;
  const gql = await shopifyGql(uid, 'write_gift_cards');

  const kaarten = await giftcardsVan(gql, id);
  const laatste = kaarten.find(k => k.spaarkaart && k.aan);
  if (!laatste) throw new HttpsError('failed-precondition', 'Er staat geen actieve spaarkaart-giftcard op naam van deze klant.');
  if (laatste.saldo < laatste.bedrag - 0.001) throw new HttpsError('failed-precondition',
    'De klant heeft deze giftcard al (deels) gebruikt, dus terugdraaien kan niet meer.');

  const uit = (await gql('mutation($id:ID!){giftCardDeactivate(id:$id){userErrors{message}}}',
    { id: 'gid://shopify/GiftCard/' + laatste.id })).giftCardDeactivate;
  if (uit.userErrors && uit.userErrors.length) throw new HttpsError('internal', 'Uitzetten lukte niet: ' + fouten(uit.userErrors));

  const { c, saldo, ver } = await leesKlant(gql, gid);
  const nieuw = Math.max(0, ver - 1);
  await zetVerzilverd(gql, gid, nieuw);
  return { klant: stempelKlant(c.id, c.displayName, saldo, nieuw), giftcards: await giftcardsVan(gql, id) };
});

/* ═══════════ Verzilveringen controleren (v791) ═══════════
   Twee wegen naar een giftcard: de klant verzilvert zelf op de website
   (Cacaoboetiek Loyalty maakt en mailt hem meteen), of Hamza stuurt er een
   vanuit HQ. Achteraf kijkt HQ per giftcard of het klopt: heeft deze klant
   genoeg besteed voor het aantal spaarkaart-giftcards dat hij kreeg?
   Rekenregel van de website: €150 aan producten (na korting, zonder
   verzendkosten, min terugbetalingen) = één giftcard. Wat je hebt
   nagekeken wordt onthouden, alleen het giftcard-nummer. */
const KAART_DREMPEL = 150;

/* Wat heeft de klant in totaal bij je uitgegeven? Shopify houdt dat zelf bij
   (amountSpent), ook voor bestellingen ouder dan 60 dagen — die mag HQ niet
   per stuk lezen. Inclusief verzending, dus een ruwe bovengrens: wie
   hieronder blijft, heeft zeker te veel gekregen. */
async function totaalBesteed(gql, klantGid) {
  const d = await gql('query($id:ID!){customer(id:$id){amountSpent{amount}}}', { id: klantGid });
  return d.customer ? Math.round((parseFloat(d.customer.amountSpent.amount) || 0) * 100) / 100 : null;
}

exports.giftcardsControle = binnen('giftcardsControle', async req => {
  const uid = wieBenJe(req);
  const gql = await shopifyGql(uid, 'read_gift_cards');
  const sinds = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const d = await gql('query($q:String){giftCards(first:100,sortKey:CREATED_AT,reverse:true,query:$q){nodes{' + GIFTCARD_VELDEN + ' customer{id displayName}}}}',
    { q: "created_at:>='" + sinds + "' AND (source:api_client OR source:manual)" });
  const kaarten = d.giftCards.nodes;
  const nagekeken = (await werkRef(uid).child('giftcardControle').once('value')).val() || {};

  /* per klant: besteding en hoeveel beloning-giftcards hij in totaal kreeg */
  const perKlant = {};
  for (const g of kaarten) {
    const c = g.customer; if (!c || perKlant[c.id]) continue;
    const besteed = await totaalBesteed(gql, c.id);
    const alle = await gql('query($q:String){giftCards(first:100,query:$q){nodes{id enabled}}}',
      { q: 'customer_id:' + String(c.id).split('/').pop() + ' AND (source:api_client OR source:manual)' });
    const gekregen = alle.giftCards.nodes.filter(x => x.enabled).length;
    const verdiend = besteed === null ? null : Math.floor(besteed / KAART_DREMPEL + 1e-9);
    perKlant[c.id] = { besteed, gekregen, verdiend };
  }

  const lijst = kaarten.map(g => {
    const n = netteGiftcard(g);
    const k = g.customer ? perKlant[g.customer.id] : null;
    n.bron = g.note === GIFTCARD_NOTITIE || g.note === CADEAU_NOTITIE ? 'hq' : 'website';
    n.klant = g.customer ? { id: String(g.customer.id).split('/').pop(), naam: g.customer.displayName || 'Klant zonder naam' } : null;
    if (k) Object.assign(n, k);
    /* klopt: genoeg besteed voor alle giftcards die hij kreeg. Wat jij zelf
       vanuit HQ gaf is jouw keuze en hoeft niet te kloppen met de rekenregel. */
    n.klopt = n.bron === 'hq' ? true : !!(k && k.verdiend !== null && k.gekregen <= k.verdiend);
    n.nagekeken = !!nagekeken[n.id];
    return n;
  });
  const open = lijst.filter(x => x.bron === 'website' && !x.nagekeken).length;
  await werkRef(uid).child('giftcardTeControleren').set(open);
  return { lijst, open };
});

exports.giftcardNagekeken = binnen('giftcardNagekeken', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const lijst = (Array.isArray(d.giftcards) ? d.giftcards : [d.giftcard]).map(String).filter(x => /^\d+$/.test(x)).slice(0, 200);
  if (!lijst.length) throw new HttpsError('invalid-argument', 'Onbekende giftcard.');
  const aan = d.aan !== false, upd = {};
  lijst.forEach(gc => { upd[gc] = aan ? Date.now() : null; });
  await werkRef(uid).child('giftcardControle').update(upd);
  const rest = Math.max(0, ((await werkRef(uid).child('giftcardTeControleren').once('value')).val() || 0) + (aan ? -lijst.length : lijst.length));
  await werkRef(uid).child('giftcardTeControleren').set(rest);
  return { ok: true };
});

/* Een giftcard uitzetten na controle. Kan niet terug: Shopify zet hem nooit weer aan. */
exports.giftcardUitzetten = binnen('giftcardUitzetten', async req => {
  const uid = wieBenJe(req);
  const gc = String((req.data || {}).giftcard || '');
  if (!/^\d+$/.test(gc)) throw new HttpsError('invalid-argument', 'Onbekende giftcard.');
  const gql = await shopifyGql(uid, 'write_gift_cards');
  const uit = (await gql('mutation($id:ID!){giftCardDeactivate(id:$id){giftCard{' + GIFTCARD_VELDEN + '} userErrors{message}}}',
    { id: 'gid://shopify/GiftCard/' + gc })).giftCardDeactivate;
  if (uit.userErrors && uit.userErrors.length) throw new HttpsError('internal', 'Uitzetten lukte niet: ' + fouten(uit.userErrors));
  await werkRef(uid).child('giftcardControle/' + gc).set(Date.now());
  return { giftcard: netteGiftcard(uit.giftCard) };
});

/* Hoeveel spaarkaart-giftcards staan er nog open, en voor welk bedrag?
   Alleen getallen. Zonder de rechten voor giftcards geeft dit gewoon niets. */
async function telGiftcards(uid) {
  try {
    const gql = await shopifyGql(uid, 'read_gift_cards');
    let na = null, aantal = 0, bedrag = 0;
    for (let ronde = 0; ronde < 10; ronde++) {
      /* alle beloning-giftcards: van de website én uit HQ, niet de gekochte */
      const d = await gql('query($na:String){giftCards(first:250,after:$na,query:"status:enabled AND balance_status:full_or_partial AND (source:api_client OR source:manual)"){nodes{balance{amount}} pageInfo{hasNextPage endCursor}}}', { na });
      d.giftCards.nodes.forEach(g => {
        aantal++; bedrag += parseFloat(g.balance.amount) || 0;
      });
      if (!d.giftCards.pageInfo.hasNextPage) break;
      na = d.giftCards.pageInfo.endCursor;
    }
    return { aantal, bedrag: Math.round(bedrag * 100) / 100 };
  } catch (e) { return null; }
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

/* Alle wenskaarten van een rij orders in één keer, om samen te printen.
   Alleen tekst en voor wie — geen adres. Wordt nergens bewaard. */
exports.haalKaarten = onCall(async req => {
  const uid = wieBenJe(req);
  const lijst = ((req.data || {}).orders || []).slice(0, 40);
  if (!lijst.length) throw new HttpsError('invalid-argument', 'Welke orders?');
  const uit = [];
  for (const nr of lijst) {
    const o = await zoekOrder(uid, nr);
    const nummer = String(o.name || o.order_number || '').replace(/^#/, '');
    kaartenVan(o).forEach((k, i) => uit.push(Object.assign({ nummer, shopifyId: String(o.id), volg: i + 1 }, k)));
  }
  return { kaarten: uit };
});

/* Alles wat je documenten nodig hebben, in één keer opgehaald bij Shopify.
   Hier zit wél naam en adres in — dat moet, want een factuur zonder adres is
   geen geldige factuur. Het gaat rechtstreeks naar jouw toestel en wordt
   nergens bewaard: niet in deze functie, niet in de database. */
/* v993: factuurregels met inhoud. Bij een doos staan de smaken en de kleur eronder,
   bij een kaartje de tekst, bij een lintje kleur en tekst. Kaartjes, lintjes en
   inpakken zijn kado-opties en vallen onder 21% btw; bonbons onder 9%. */
const KADO_OPTIE = /kado|cadeau|gift|inpak|wrap|wenskaart|kaartje|lint/i;
function factuurRegelsVan(o) {
  const regels = [], kadoRegels = [];
  (o.line_items || []).filter(li => !li.gift_card).forEach(li => {
    const m = {}; (li.properties || []).forEach(p => { if (p && p.name) m[p.name] = p.value; });
    const stuk = parseFloat(li.price) || 0;
    const korting = (li.discount_allocations || []).reduce((n, d) => n + (parseFloat(d.amount) || 0), 0);
    const naam = String(li.title || '').replace(/\s*-\s*(\d+) pralines$/i, ' · $1 bonbons') + (li.variant_title && !/standaard|default/i.test(li.variant_title) && !String(li.title).includes(li.variant_title.replace(/ bonbons/, '')) ? ' · ' + li.variant_title : '');
    const det = [];
    if (m.Ontvanger && m.Ontvanger !== 'Voor mezelf') det.push(m.Ontvanger);
    if (m.Dooskleur) det.push('Kleur: ' + m.Dooskleur);
    if (m.Bonbons) det.push(String(m.Bonbons).replace(/;\s*/g, ', '));
    if (m.Boodschap) det.push('Tekst: “' + String(m.Boodschap).replace(/\s*\n\s*/g, ' / ') + '”');
    if (m.Lintkleur) det.push('Kleur: ' + m.Lintkleur);
    if (m.Tekst) det.push('Tekst: “' + m.Tekst + '”');
    const regel = { naam, aantal: Number(li.quantity) || 0, prijs: stuk, korting, detail: det.join('\n') };
    (KADO_OPTIE.test(naam) ? kadoRegels : regels).push(regel);
  });
  const kado = kadoRegels.reduce((n, r) => n + r.prijs * r.aantal - (r.korting || 0), 0);
  return { regels, kadoRegels, kado };
}
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
  const { regels, kadoRegels, kado } = factuurRegelsVan(o);

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
    kadoRegels,
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

/* ═══════════ Verzonden melden met track & trace (v950) ═══════════
   Na het printen van het label: de barcode bij MyParcel ophalen, de order
   in Shopify op verzonden zetten met die barcode, en Shopify mailt de klant
   de track & trace. Zo zijn Shopify en MyParcel aan elkaar gekoppeld zonder
   de losse MyParcel-app — die zou dubbele zendingen kunnen maken. */
exports.meldVerzonden = onCall(async req => {
  const uid = wieBenJe(req);
  const g = await leesGeheim(uid, 'myparcel');
  if (!g) throw new HttpsError('failed-precondition', 'MyParcel is nog niet gekoppeld.');

  const o = await zoekOrder(uid, (req.data || {}).order);
  const pad = werkRef(uid).child('orders/' + o.id);
  const mpId = (await pad.child('myparcel_id').once('value')).val();
  if (!mpId) throw new HttpsError('failed-precondition', 'Meld eerst een zending aan bij MyParcel.');

  const r = await mpRoep(g.sleutel, 'shipments/' + encodeURIComponent(mpId), { headers: mpKoppen(g.sleutel) });
  if (!r.ok) throw new HttpsError('internal', 'MyParcel antwoordde met ' + r.status + '.');
  const z = (((await r.json()).data || {}).shipments || [])[0] || {};
  const barcode = String(z.barcode || '').trim();
  if (!barcode) throw new HttpsError('failed-precondition', 'Er is nog geen barcode. Print eerst het label, dan maakt MyParcel hem aan.');

  const a = o.shipping_address || {};
  const pc = String(a.zip || '').replace(/\s+/g, '').toUpperCase();
  const land = String(a.country_code || 'NL').toUpperCase();
  const url = 'https://jouw.postnl.nl/track-and-trace/' + encodeURIComponent(barcode) + '-' + land + '-' + encodeURIComponent(pc);

  if (o.fulfillment_status === 'fulfilled') {
    await pad.update({ verzonden: true, barcode, afgehandeld: true });
    return { ok: true, alGedaan: true, barcode };
  }

  let fo;
  try { fo = await shopify(uid, 'orders/' + o.id + '/fulfillment_orders.json'); }
  catch (e) {
    throw new HttpsError('permission-denied',
      'Shopify laat HQ nog geen orders op verzonden zetten. Zet in het Dev Dashboard bij je app de rechten ' +
      'read_merchant_managed_fulfillment_orders en write_merchant_managed_fulfillment_orders aan, ' +
      'en tik daarna bij Koppelingen op Token verversen.');
  }
  const open = (fo.fulfillment_orders || []).filter(f => ['open', 'in_progress'].includes(f.status));
  if (!open.length) throw new HttpsError('failed-precondition', 'Shopify heeft voor deze order niets meer open staan om te verzenden.');

  await shopifySchrijf(uid, 'fulfillments.json', {
    fulfillment: {
      line_items_by_fulfillment_order: open.map(f => ({ fulfillment_order_id: f.id })),
      tracking_info: { number: barcode, company: 'PostNL', url },
      notify_customer: true
    }
  });

  await pad.update({ verzonden: true, barcode, afgehandeld: true, verzondenOp: Date.now() });
  return { ok: true, barcode };
});

/* ═══════════════════════════════════════════════════════════════════
   Betaallinks (v952)
   Een conceptorder in Shopify met een eigen afrekenlink. HQ stuurt die link
   via WhatsApp; betaalt de klant, dan wordt het een gewone Shopify-order.
   Naam en telefoonnummer gaan niet via deze functie en niet naar Firebase.
   ═══════════════════════════════════════════════════════════════════ */
const blTekst = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);
function blBedrag(x, max) {
  const n = Number(String(x == null ? '' : x).replace(',', '.'));
  return isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
}
const DRAFT_VELDEN = 'id name status invoiceUrl totalPriceSet{shopMoney{amount}} createdAt order{name}';
const netteDraft = d => ({ id: d.id, naam: d.name, status: d.status, url: d.invoiceUrl,
  totaal: Number(((d.totalPriceSet || {}).shopMoney || {}).amount || 0), order: d.order ? d.order.name : '' });

/* v960: klant aan een betaallink hangen via zijn mailadres, zodat de order
   (en dus de stempels) bij die klant terechtkomt. Bestaat de klant nog niet,
   dan maken we hem aan, zonder hem op de mailinglijst te zetten. */
const goedMail = m => { m = String(m || '').trim().toLowerCase(); return /^[^\s@"]+@[^\s@"]+\.[a-z]{2,}$/.test(m) && m.length < 120 ? m : ''; };
async function klantVoorMail(gql, email, naam) {
  const z = await gql('query($q:String!){customers(first:1,query:$q){nodes{id displayName cb:metafield(namespace:"custom",key:"cb_stamps"){value}}}}', { q: 'email:"' + email + '"' });
  const al = z.customers && z.customers.nodes && z.customers.nodes[0];
  if (al) {
    let spaar = 0;
    try { spaar = Math.max(0, Math.min(15000, parseInt(JSON.parse(al.cb.value).cardCents, 10) || 0)); } catch (e) { spaar = 0; }
    return { id: al.id, naam: al.displayName, nieuw: false, spaar };
  }
  const input = { email };
  const n = blTekst(naam, 80);
  if (n) { const d = n.split(' '); input.firstName = d.shift(); if (d.length) input.lastName = d.join(' '); }
  const c = (await gql('mutation($i:CustomerInput!){customerCreate(input:$i){customer{id displayName} userErrors{message}}}', { i: input })).customerCreate;
  if (c.userErrors && c.userErrors.length) throw new HttpsError('internal', 'Klant aanmaken lukte niet: ' + fouten(c.userErrors));
  return { id: c.customer.id, naam: c.customer.displayName, nieuw: true, spaar: 0 };
}

exports.betaallinkKlant = binnen('betaallinkKlant', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const id = String(d.id || '');
  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende betaallink.');
  const email = goedMail(d.email);
  if (!email) throw new HttpsError('invalid-argument', 'Dit mailadres klopt niet.');
  const gql = await shopifyGql(uid, 'write_draft_orders');
  const k = await klantVoorMail(gql, email, d.naam);
  const r = (await gql('mutation($id:ID!,$i:DraftOrderInput!){draftOrderUpdate(id:$id,input:$i){draftOrder{' + DRAFT_VELDEN + '} userErrors{message}}}',
    { id, i: { email, purchasingEntity: { customerId: k.id } } })).draftOrderUpdate;
  if (r.userErrors && r.userErrors.length) throw new HttpsError('internal', 'Koppelen lukte niet: ' + fouten(r.userErrors));
  return { link: netteDraft(r.draftOrder), klant: k.naam, nieuw: k.nieuw, spaar: k.spaar };
});

/* v962: een betaallink terugdraaien vanuit HQ.
   info        status + wat er nog terug kan
   intrekken   nog niet betaald: concept weggooien, de link werkt dan niet meer
   annuleren   betaald: order annuleren en alles terug naar de klant
   terugbetalen betaald: (deel)bedrag terug, order blijft staan (retour)
   Annuleren en terugbetalen vragen de scope write_orders. */
const TERUG_ORDER = 'id name cancelledAt displayFinancialStatus totalPriceSet{shopMoney{amount}} totalRefundedSet{shopMoney{amount}} transactions{id kind status gateway amountSet{shopMoney{amount}}}';
function terugInfo(d) {
  const o = d.order;
  if (!o) return { status: d.status, betaald: false };
  const tot = Number(o.totalPriceSet.shopMoney.amount || 0), terug = Number(o.totalRefundedSet.shopMoney.amount || 0);
  return { status: d.status, betaald: true, order: o.name, geannuleerd: !!o.cancelledAt, financieel: o.displayFinancialStatus,
    totaal: tot, terugbetaald: terug, kanTerug: Math.max(0, Math.round((tot - terug) * 100) / 100) };
}
const schrijfFout = e => /ACCESS_DENIED|write_orders|access/i.test(String(e && e.message || e))
  ? new HttpsError('permission-denied', 'HQ mag nog geen orders terugbetalen. Zet in het Shopify Dev Dashboard de scope write_orders aan, geef een nieuwe versie vrij en keur hem goed in je Shopify-admin. Tik daarna in HQ bij Shopify op Ververs.')
  : e;
/* v963: korte link op je eigen domein, bijv. www.cacaoboetiek.nl/betalen/d14.
   Shopify stuurt die door naar de echte betaalpagina. Vraagt de scope
   write_online_store_navigation; lukt het niet, dan blijft de lange link gewoon werken. */
async function korteLink(gql, draft) {
  try {
    const u = new URL(draft.invoiceUrl);
    const pad = '/betalen/' + String(draft.name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (pad === '/betalen/') return '';
    const r = (await gql('mutation($r:UrlRedirectInput!){urlRedirectCreate(urlRedirect:$r){urlRedirect{path} userErrors{message}}}',
      { r: { path: pad, target: u.pathname + u.search } })).urlRedirectCreate;
    if (r.userErrors && r.userErrors.length && !/already|bestaat|taken/i.test(fouten(r.userErrors))) return '';
    return u.host + pad;
  } catch (e) { return ''; }
}
exports.betaallinkKort = binnen('betaallinkKort', async req => {
  const uid = wieBenJe(req);
  const id = String((req.data || {}).id || '');
  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende betaallink.');
  const gql = await shopifyGql(uid, 'write_online_store_navigation');
  const d = (await gql('query($id:ID!){draftOrder(id:$id){name invoiceUrl}}', { id })).draftOrder;
  if (!d) return { kort: '' };
  return { kort: await korteLink(gql, d) };
});

exports.betaallinkTerug = binnen('betaallinkTerug', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const id = String(d.id || '');
  if (!/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(id)) throw new HttpsError('invalid-argument', 'Onbekende betaallink.');
  const gql = await shopifyGql(uid, 'write_draft_orders');
  const dr = (await gql('query($id:ID!){draftOrder(id:$id){id status order{' + TERUG_ORDER + '}}}', { id })).draftOrder;
  if (!dr) return { status: 'WEG', betaald: false };
  const actie = d.actie || 'info';
  if (actie === 'info') return terugInfo(dr);

  if (actie === 'intrekken') {
    if (dr.order) throw new HttpsError('failed-precondition', 'Deze link is al betaald. Kies terugbetalen of annuleren.');
    const r = (await gql('mutation($i:DraftOrderDeleteInput!){draftOrderDelete(input:$i){deletedId userErrors{message}}}', { i: { id } })).draftOrderDelete;
    if (r.userErrors && r.userErrors.length) throw new HttpsError('internal', 'Intrekken lukte niet: ' + fouten(r.userErrors));
    return { status: 'WEG', betaald: false };
  }

  const o = dr.order;
  if (!o) throw new HttpsError('failed-precondition', 'Deze link is nog niet betaald. Je kunt hem alleen intrekken.');
  if (o.cancelledAt) throw new HttpsError('failed-precondition', 'Deze order is al geannuleerd.');
  const bericht = d.bericht !== false;
  const gqlO = await shopifyGql(uid, 'write_orders');

  if (actie === 'annuleren') {
    let r;
    try {
      r = (await gqlO('mutation($o:ID!,$n:Boolean){orderCancel(orderId:$o,reason:CUSTOMER,restock:true,notifyCustomer:$n,refundMethod:{originalPaymentMethodsRefund:true},staffNote:"Geannuleerd via HQ"){job{id} orderCancelUserErrors{message}}}', { o: o.id, n: bericht })).orderCancel;
    } catch (e) { throw schrijfFout(e); }
    if (r.orderCancelUserErrors && r.orderCancelUserErrors.length) throw schrijfFout(new HttpsError('internal', 'Annuleren lukte niet: ' + fouten(r.orderCancelUserErrors)));
    return Object.assign(terugInfo(dr), { geannuleerd: true, bezig: true, terugbetaald: terugInfo(dr).totaal, kanTerug: 0 });
  }

  if (actie === 'terugbetalen') {
    const info = terugInfo(dr);
    const bedrag = Math.round(Number(d.bedrag) * 100) / 100;
    if (!(bedrag > 0)) throw new HttpsError('invalid-argument', 'Vul een bedrag in.');
    if (bedrag > info.kanTerug + 0.001) throw new HttpsError('invalid-argument', 'Er kan nog maximaal € ' + info.kanTerug.toFixed(2).replace('.', ',') + ' terug.');
    const ouder = (o.transactions || []).find(t => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS');
    if (!ouder) throw new HttpsError('failed-precondition', 'Ik vind de betaling bij deze order niet.');
    let r;
    try {
      r = (await gqlO('mutation($i:RefundInput!){refundCreate(input:$i){refund{id totalRefundedSet{shopMoney{amount}}} userErrors{message}}}', { i: {
        orderId: o.id, notify: bericht, note: blTekst(d.reden, 200) || 'Terugbetaald via HQ',
        transactions: [{ orderId: o.id, parentId: ouder.id, gateway: ouder.gateway, kind: 'REFUND', amount: bedrag.toFixed(2) }] } })).refundCreate;
    } catch (e) { throw schrijfFout(e); }
    if (r.userErrors && r.userErrors.length) throw schrijfFout(new HttpsError('internal', 'Terugbetalen lukte niet: ' + fouten(r.userErrors)));
    return Object.assign(info, { terugbetaald: Math.round((info.terugbetaald + bedrag) * 100) / 100, kanTerug: Math.round((info.kanTerug - bedrag) * 100) / 100 });
  }
  throw new HttpsError('invalid-argument', 'Onbekende actie.');
});

/* ═══════════ v968: cadeaustempels voor alle aangemelde mensen ═══════════
   Iedereen die zich voor de mail heeft aangemeld (marketing: SUBSCRIBED) krijgt
   X stempels cadeau. Per stempel €25 erbij op cbx.spaarsaldo (zoals HQ altijd
   telt) én op de stempelkaart van de website (custom.cb_stamps), met een
   berichtje dat op de kaart verschijnt. Een kaart gaat nooit boven de 6.
   Per actie (campagne) houdt HQ bij wie hem al kreeg, dus twee keer drukken
   geeft niemand dubbel. Werkt in porties van 50, zodat niets vastloopt. */
const CADEAU_PORTIE = 50;
exports.stempelsCadeau = binnen('stempelsCadeau', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const aantal = Math.max(1, Math.min(6, parseInt(d.aantal, 10) || 2));
  const campagne = String(d.campagne || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'cadeau';
  const proef = d.proef !== false;
  const gql = await shopifyGql(uid, 'write_customers');
  const klaarRef = werkRef(uid).child('cadeauStempels').child(campagne);
  const al = (await klaarRef.child('klanten').once('value')).val() || {};

  const r = (await gql('query($n:Int!,$na:String){customers(first:$n,after:$na){pageInfo{hasNextPage endCursor} nodes{id emailMarketingConsent{marketingState} eerste:orders(first:1,sortKey:CREATED_AT){nodes{createdAt}} s:metafield(namespace:"cbx",key:"spaarsaldo"){value} cb:metafield(namespace:"custom",key:"cb_stamps"){value}}}}',
    { n: CADEAU_PORTIE, na: d.vanaf || null })).customers;
  /* v973: wie vóór 1 oktober 2026 al eens bestelde, krijgt geen cadeaustempels */
  const grens = Date.parse(d.klantSinds || '2026-10-01T00:00:00+02:00');
  let oudeKlant = 0;
  const nodes = (r.nodes || []).filter(c => c.emailMarketingConsent && c.emailMarketingConsent.marketingState === 'SUBSCRIBED')
    .filter(c => { const o = c.eerste && c.eerste.nodes && c.eerste.nodes[0]; if (o && Date.parse(o.createdAt) < grens) { oudeKlant++; return false; } return true; });

  let nieuw = 0, overgeslagen = 0, vol = 0;
  const m = [], klaar = {};
  nodes.forEach(c => {
    const nr = String(c.id).split('/').pop();
    if (al[nr]) { overgeslagen++; return; }
    nieuw++;
    const saldo = c.s ? (parseFloat(c.s.value) || 0) : 0;
    let st = {}; try { st = c.cb ? JSON.parse(c.cb.value) || {} : {}; } catch (e) { st = {}; }
    const kaart = Math.max(0, Math.min(15000, parseInt(st.cardCents, 10) || 0));
    const naKaart = Math.min(15000, kaart + aantal * 2500);
    if (naKaart >= 15000) vol++;
    if (proef) return;
    const nst = Object.assign({ version: 1 }, st, {
      cardCents: naKaart, remainingCents: 15000 - naKaart,
      status: naKaart >= 15000 && (!st.status || st.status === 'active') ? 'claim_available' : (st.status || 'active'),
      courtesyMessage: 'Cadeau van Cacaoboetiek: ' + aantal + ' ' + (aantal === 1 ? 'stempel' : 'stempels') + ' erbij.'
    });
    m.push({ ownerId: c.id, namespace: 'cbx', key: 'spaarsaldo', type: 'number_decimal', value: (Math.round((saldo + aantal * STEMPEL_EURO) * 100) / 100).toFixed(2) });
    m.push({ ownerId: c.id, namespace: 'custom', key: 'cb_stamps', type: 'json', value: JSON.stringify(nst) });
    klaar[nr] = Date.now();
  });

  if (!proef && m.length) {
    for (let i = 0; i < m.length; i += 24) {
      const u = (await gql('mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}', { m: m.slice(i, i + 24) })).metafieldsSet;
      if (u.userErrors && u.userErrors.length) throw new HttpsError('internal', 'Shopify weigerde: ' + u.userErrors.map(x => x.message).join(', ').slice(0, 200));
    }
    await klaarRef.child('klanten').update(klaar);
    await klaarRef.update({ aantal, laatst: Date.now() });
  }
  return { nieuw, overgeslagen, vol, oudeKlant, verder: r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null, aantal, campagne };
});

exports.betaalProducten = binnen('betaalProducten', async req => {
  const uid = wieBenJe(req);
  const gql = await shopifyGql(uid, 'read_products');
  const d = await gql('query{products(first:100,query:"status:active",sortKey:TITLE){nodes{title variants(first:20){nodes{id title price}}}}}');
  const uit = [];
  ((d.products || {}).nodes || []).forEach(p => ((p.variants || {}).nodes || []).forEach(v => uit.push({
    variantId: v.id, titel: p.title, variant: v.title === 'Default Title' ? '' : v.title, prijs: Number(v.price) })));
  return { producten: uit };
});

exports.maakBetaallink = binnen('maakBetaallink', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const lineItems = (Array.isArray(d.regels) ? d.regels : []).slice(0, 30).map(r => {
    r = r || {};
    const aantal = Math.max(1, Math.min(500, parseInt(r.aantal, 10) || 1));
    if (typeof r.variantId === 'string' && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(r.variantId))
      return { variantId: r.variantId, quantity: aantal };
    const titel = blTekst(r.titel, 80), prijs = blBedrag(r.prijs, 5000);
    if (!titel || !prijs) return null;
    return { title: titel, quantity: aantal, taxable: true, requiresShipping: true,
      originalUnitPriceWithCurrency: { amount: String(prijs), currencyCode: 'EUR' } };
  }).filter(Boolean);
  if (!lineItems.length) throw new HttpsError('invalid-argument', 'Kies minstens één product of vul een bedrag in.');

  const input = { lineItems, tags: d.geenStempels ? ['hq-betaallink', 'geen-stempels'] : ['hq-betaallink'] };
  const notitie = blTekst(d.notitie, 400);
  if (notitie) input.note = notitie;
  /* korting over de producten (niet over de verzending) */
  const kt = d.korting || {};
  const kw = blBedrag(kt.waarde, kt.soort === 'pct' ? 100 : 5000);
  if (kw && kw > 0) input.appliedDiscount = { title: blTekst(kt.titel, 40) || 'Korting', value: kw,
    valueType: kt.soort === 'pct' ? 'PERCENTAGE' : 'FIXED_AMOUNT' };
  const vz = d.verzending || {};
  if (vz.soort === 'verzenden') {
    const prijs = blBedrag(vz.prijs, 100);
    input.shippingLine = { title: blTekst(vz.titel, 60) || 'Verzending', priceWithCurrency: { amount: String(prijs || 0), currencyCode: 'EUR' } };
  } else if (vz.soort === 'ophalen') {
    input.shippingLine = { title: 'Ophalen in Drunen', priceWithCurrency: { amount: '0', currencyCode: 'EUR' } };
  }

  const gql = await shopifyGql(uid, 'write_draft_orders');
  const email = goedMail(d.email);
  let klant = null;
  if (email) { klant = await klantVoorMail(gql, email, d.naam); input.email = email; input.purchasingEntity = { customerId: klant.id }; }
  const r = (await gql('mutation($i:DraftOrderInput!){draftOrderCreate(input:$i){draftOrder{' + DRAFT_VELDEN + '} userErrors{message}}}', { i: input })).draftOrderCreate;
  if (r.userErrors && r.userErrors.length) throw new HttpsError('internal', 'Betaallink maken lukte niet: ' + fouten(r.userErrors));
  const kort = await korteLink(gql, r.draftOrder);
  return { link: Object.assign(netteDraft(r.draftOrder), { kort }), klant: klant ? klant.naam : '', nieuw: !!(klant && klant.nieuw), spaar: klant ? klant.spaar : null };
});

exports.betaallinkStatus = binnen('betaallinkStatus', async req => {
  const uid = wieBenJe(req);
  /* v987: alle open betaallinks rechtstreeks uit Shopify, ook als de app ze kwijt is */
  if ((req.data || {}).open) {
    const gql0 = await shopifyGql(uid, 'read_draft_orders');
    const r = await gql0('query{draftOrders(first:30,sortKey:UPDATED_AT,reverse:true,query:"status:open tag:hq-betaallink"){nodes{' + DRAFT_VELDEN +
      ' tags appliedDiscount{amountSet{shopMoney{amount}} valueType value} shippingLine{title originalPriceSet{shopMoney{amount}}} lineItems(first:40){nodes{title variantTitle quantity originalUnitPriceSet{shopMoney{amount}}}}}}}');
    const geld = x => Number(((x || {}).shopMoney || {}).amount || 0);
    return { open: (r.draftOrders.nodes || []).map(d => Object.assign(netteDraft(d), {
      datum: String(d.createdAt || '').slice(0, 10),
      geenStempels: (d.tags || []).includes('geen-stempels'),
      regels: (d.lineItems.nodes || []).filter(x => !/^verzend/i.test(x.title)).map(x => ({ titel: x.title + (x.variantTitle && x.variantTitle !== 'Default Title' ? ' · ' + x.variantTitle : ''), aantal: x.quantity, prijs: geld(x.originalUnitPriceSet) })),
      verzending: d.shippingLine ? geld(d.shippingLine.originalPriceSet) : 0,
      ophalen: !!(d.shippingLine && /ophalen/i.test(d.shippingLine.title || '')),
      korting: d.appliedDiscount ? geld(d.appliedDiscount.amountSet) : 0,
      kortingPct: d.appliedDiscount && d.appliedDiscount.valueType === 'PERCENTAGE' ? Number(d.appliedDiscount.value) || 0 : 0
    })) };
  }
  const ids = (Array.isArray((req.data || {}).ids) ? req.data.ids : [])
    .filter(x => typeof x === 'string' && /^gid:\/\/shopify\/DraftOrder\/\d+$/.test(x)).slice(0, 50);
  if (!ids.length) return { links: [] };
  const gql = await shopifyGql(uid, 'read_draft_orders');
  const d = await gql('query($ids:[ID!]!){nodes(ids:$ids){... on DraftOrder{' + DRAFT_VELDEN + '}}}', { ids });
  return { links: (d.nodes || []).filter(Boolean).map(netteDraft) };
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

/* Etiketten lezen: een levering inboeken met de camera. Ook apart. */
Object.assign(exports, require('./leesEtiket'));

/* Receptfoto lezen: je schrift in HQ. */
Object.assign(exports, require('./leesReceptFoto'));

/* Bedrijfsgegevens van een screenshot: factuur bij een betaallink. */
Object.assign(exports, require('./leesBedrijf'));

/* Eén video naar Instagram en TikTok — zie social.js */
Object.assign(exports, require('./social'));

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


/* ═══════════ Dagelijkse back-up (v784) ═══════════
   Elke nacht om 03:00 een kopie van ieders HQ-data naar reservekopie/{uid}/{datum}.
   30 dagen bewaard. Zo kun je terug naar gisteren als een oud toestel of een
   fout iets overschrijft. Alleen de server schrijft hier; jij kunt alleen lezen. */
const telVoorBackup = d => ({
  smaken: (d.recepten || []).length || Object.keys(d.recepten || {}).length,
  batches: Object.keys(d.batches || {}).length,
  orders: Object.keys(d.orders || {}).length,
  diensten: Object.keys(d.diensten || {}).length,
  bijgewerkt: d.bijgewerkt || 0
});
async function maakDagBackup(uid, data, datum) {
  if (!data) return;
  const grootte = Buffer.byteLength(JSON.stringify(data));
  await db().ref('reservekopie/' + uid + '/' + datum).set(data);
  await db().ref('reservekopieLijst/' + uid + '/' + datum).set(Object.assign(telVoorBackup(data), { grootte, gemaakt: Date.now() }));
  /* ouder dan 30 dagen opruimen */
  const lijst = (await db().ref('reservekopieLijst/' + uid).once('value')).val() || {};
  const dagen = Object.keys(lijst).sort();
  const weg = dagen.slice(0, Math.max(0, dagen.length - 30));
  for (const d of weg) {
    await db().ref('reservekopie/' + uid + '/' + d).remove();
    await db().ref('reservekopieLijst/' + uid + '/' + d).remove();
  }
}
exports.dagelijkseBackup = onSchedule({ schedule: '0 3 * * *', timeZone: 'Europe/Amsterdam', timeoutSeconds: 300, memory: '512MiB' }, async () => {
  const datum = nlDag(Date.now());
  const alles = (await db().ref('cacaoboetiek').once('value')).val() || {};
  for (const uid of Object.keys(alles)) {
    try { await maakDagBackup(uid, alles[uid], datum); }
    catch (e) { console.error('backup', uid, e); }
  }
});
/* ook met de hand vanuit de app: "Nu een back-up maken" */
exports.backupNu = onCall(async req => {
  const uid = wieBenJe(req);
  const data = (await db().ref('cacaoboetiek/' + uid).once('value')).val();
  if (!data) throw new HttpsError('not-found', 'Er staat nog niets om te bewaren.');
  const datum = nlDag(Date.now());
  await maakDagBackup(uid, data, datum);
  return { datum };
});

/* ─────────────────────────── Mail (v830) ───────────────────────────
   info@ bij Strato. Lijst en mails gaan per keer rechtstreeks van Strato
   naar de app; er wordt niets van je mail in de database bewaard. */
const MAIL = require('./mail');
const MAILMODEL = 'claude-sonnet-4-5';

async function mailGeheim(uid) {
  const g = await leesGeheim(uid, 'mail');
  if (!g || !g.adres) throw new HttpsError('failed-precondition', 'Koppel eerst je mailbox.');
  return g;
}

exports.mailLijst = onCall({ timeoutSeconds: 60 }, async req => {
  const uid = wieBenJe(req);
  const aantal = Math.min(80, Math.max(5, Number((req.data || {}).aantal) || 40));
  return { mails: await MAIL.lijst(await mailGeheim(uid), aantal) };
});

exports.mailLees = onCall({ timeoutSeconds: 60 }, async req => {
  const uid = wieBenJe(req);
  const id = Number((req.data || {}).uid);
  if (!id) throw new HttpsError('invalid-argument', 'Welke mail?');
  return await MAIL.lees(await mailGeheim(uid), id);
});

/* laatste orders van deze klant, als hij in Shopify staat */
async function ordersVan(uid, adres) {
  try {
    const { winkel, token: t } = await token(uid);
    const r = await fetch('https://' + winkel + '/admin/api/' + SHOPIFY_API + '/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': t, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        query: 'query($q:String){orders(first:5,query:$q,sortKey:CREATED_AT,reverse:true){nodes{name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount}} lineItems(first:10){nodes{title quantity}}}}}',
        variables: { q: 'email:' + adres }
      })
    });
    const j = await r.json();
    const n = (((j || {}).data || {}).orders || {}).nodes || [];
    return n.map(o => o.name + ' van ' + String(o.createdAt).slice(0, 10) + ': ' +
      o.lineItems.nodes.map(l => l.quantity + '× ' + l.title).join(', ') +
      ' · €' + o.totalPriceSet.shopMoney.amount + ' · betaling ' + o.displayFinancialStatus +
      ' · verzending ' + o.displayFulfillmentStatus).join('\n');
  } catch (e) { return ''; }
}

const MAILOPDRACHT =
  'Je schrijft een antwoord op een klantmail namens Hamza van Cacaoboetiek, een kleine ' +
  'zaak in handgemaakte halal bonbons uit Drunen. Schrijf in het Nederlands, tenzij de klant ' +
  'een andere taal gebruikt; antwoord dan in die taal.\n\n' +
  'Toon: zakelijk en vriendelijk, kort en duidelijk. Niet overdreven warm, geen uitroeptekens ' +
  'achter elkaar, geen emoji, niet pronken. Begin met "Beste [voornaam]," of "Hallo [voornaam]," ' +
  'als de naam bekend is. Sluit af met:\nMet vriendelijke groet,\nHamza\nCacaoboetiek\n\n' +
  'Gebruik alleen de feiten hieronder en wat in de mail of de orders staat. Verzin nooit ' +
  'levertijden, prijzen, voorraad of toezeggingen. Weet je iets niet, zet dan op die plek ' +
  '[INVULLEN: wat er moet komen], zodat Hamza het zelf aanvult. Noem nooit alcohol als ' +
  'ingrediënt of optie.\n\nVaste informatie:\n{INFO}\n\nOrders van deze klant:\n{ORDERS}\n\n' +
  'Geef alleen de tekst van de mail terug, zonder onderwerpregel en zonder uitleg.';

exports.mailConcept = onCall({ timeoutSeconds: 90 }, async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const id = Number(d.uid);
  if (!id) throw new HttpsError('invalid-argument', 'Welke mail?');
  const c = await leesGeheim(uid, 'claude');
  if (!c || !c.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');
  const mail = await MAIL.lees(await mailGeheim(uid), id);
  const orders = mail.adres ? await ordersVan(uid, mail.adres) : '';
  const systeem = MAILOPDRACHT
    .replace('{INFO}', String(d.info || '').slice(0, 4000) || '(geen)')
    .replace('{ORDERS}', orders || '(geen orders gevonden bij dit adres)');
  const vraag = 'Van: ' + mail.van + ' <' + mail.adres + '>\nOnderwerp: ' + mail.onderwerp + '\n\n' +
    mail.tekst.slice(0, 8000) + (d.wens ? '\n\n---\nWat Hamza in het antwoord wil: ' + String(d.wens).slice(0, 1000) : '');
  const r = await fetch(CLAUDE_URL, {
    method: 'POST', headers: claudeKoppen(c.sleutel),
    body: JSON.stringify({ model: MAILMODEL, max_tokens: 1200, system: systeem, messages: [{ role: 'user', content: vraag }] })
  });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new HttpsError('permission-denied', 'Je Claude-sleutel wordt niet meer geaccepteerd.');
    throw new HttpsError('unavailable', 'Claude antwoordde met ' + r.status + '. Probeer het zo nog eens.');
  }
  const j = await r.json();
  const tekst = ((j.content || []).find(x => x.type === 'text') || {}).text || '';
  return { tekst: tekst.trim(), orders: !!orders };
});

exports.mailVerstuur = onCall({ timeoutSeconds: 90 }, async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const id = Number(d.uid), tekst = String(d.tekst || '').trim();
  if (!id || !tekst) throw new HttpsError('invalid-argument', 'Er is niets om te versturen.');
  if (/\[INVULLEN/i.test(tekst)) throw new HttpsError('failed-precondition', 'Er staat nog een [INVULLEN] in je antwoord.');
  const g = await mailGeheim(uid);
  const mail = await MAIL.lees(g, id);
  return await MAIL.verstuur(g, mail, tekst);
});

/* ═══════════ v969: orders vanzelf binnen + melding op je telefoon ═══════════
   Elke 5 minuten kijkt HQ bij Shopify of er orders zijn bijgekomen of
   veranderd, ook als de app dicht is. Een nieuwe order zet hij meteen in je
   orderlijst en je krijgt een melding (pushbericht) op je telefoon.
   In de melding staat geen klantnaam: alleen ordernummer en wat erin zit. */
const webpush = require('web-push');
const pushRef = uid => geheimRef(uid).child('push');

async function vapid() {
  const ref = db().ref('geheim/_systeem/vapid');
  let v = (await ref.once('value')).val();
  if (!v || !v.publicKey) { v = webpush.generateVAPIDKeys(); await ref.set(v); }
  return v;
}

exports.pushSleutel = onCall(async req => {
  wieBenJe(req);
  return { sleutel: (await vapid()).publicKey };
});

exports.pushAanmelden = binnen('pushAanmelden', async req => {
  const uid = wieBenJe(req);
  const sub = (req.data || {}).sub;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    throw new HttpsError('invalid-argument', 'Ongeldige aanmelding.');
  const sleutel = require('crypto').createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);
  await pushRef(uid).child(sleutel).set({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, sinds: Date.now() });
  await werkRef(uid).child('meldingen').update({ aan: true, sinds: Date.now() });
  return { ok: true };
});

async function stuurPush(uid, bericht) {
  const v = await vapid();
  webpush.setVapidDetails('mailto:info@cacaoboetiek.nl', v.publicKey, v.privateKey);
  const subs = (await pushRef(uid).once('value')).val() || {};
  let n = 0;
  for (const k of Object.keys(subs)) {
    try { await webpush.sendNotification(subs[k], JSON.stringify(bericht), { TTL: 24 * 3600, urgency: 'high' }); n++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await pushRef(uid).child(k).remove();
      else console.error('push', e && e.statusCode, e && e.body);
    }
  }
  return n;
}

exports.pushTest = binnen('pushTest', async req => {
  const uid = wieBenJe(req);
  const n = await stuurPush(uid, { titel: 'Meldingen staan aan', tekst: 'Zo ziet een melding van een nieuwe order eruit.', url: './#orders' });
  if (!n) throw new HttpsError('failed-precondition', 'Er is nog geen telefoon aangemeld voor meldingen.');
  return { n };
});

function orderMelding(v) {
  const wat = (v.regels || []).slice(0, 3).map(r => r.aantal + '× ' + r.naam).join(', ');
  return {
    titel: 'Nieuwe order #' + v.nummer,
    tekst: (wat || v.stuks + ' stuks') + (v.afhaal ? ' · afhalen' : ' · verzenden') + (v.wenskaart_gevraagd ? ' · met wenskaart' : ''),
    url: './#orders', tag: 'order-' + v.shopifyId
  };
}

async function ordersBijwerken(uid) {
  const w = werkRef(uid);
  const laatst = (await w.child('laatstOpgehaald').once('value')).val() || (Date.now() - 2 * 3600 * 1000);
  const vanaf = new Date(laatst - 10 * 60 * 1000).toISOString();
  const { gegevens } = await shopifyPagina(uid, 'orders.json?status=any&limit=250&updated_at_min=' + encodeURIComponent(vanaf));
  const orders = gegevens.orders || [];
  const bestaand = (await w.child('orders').once('value')).val() || {};
  const upd = {}, nieuw = [];
  orders.forEach(o => {
    const v = veiligeOrder(o);
    if (!bestaand[v.shopifyId] && !v.afgehandeld && Date.parse(o.created_at || 0) > Date.now() - 24 * 3600 * 1000) nieuw.push(v);
    upd[v.shopifyId] = Object.assign({}, bestaand[v.shopifyId] || {}, v);
  });
  if (Object.keys(upd).length) await w.child('orders').update(upd);
  await w.update({ laatstOpgehaald: Date.now() });
  for (const v of nieuw) await stuurPush(uid, orderMelding(v));
  try { await webVoorraadVerwerk(uid, orders); } catch (e) { console.error('webVoorraad', uid, e && e.message); }
  return { bijgewerkt: orders.length, nieuw: nieuw.length };
}

exports.ordersBewaken = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Europe/Amsterdam', timeoutSeconds: 120 }, async () => {
  const g = (await db().ref('geheim').once('value')).val() || {};
  for (const uid of Object.keys(g)) {
    if (uid.startsWith('_') || !g[uid] || !g[uid].shopify) continue;
    try { await ordersBijwerken(uid); } catch (e) { console.error('ordersBewaken', uid, e && e.message); }
  }
});

/* Overzicht voor de app: wat is er gekoppeld en werkt het? */
exports.koppelingCheck = binnen('koppelingCheck', async req => {
  const uid = wieBenJe(req);
  const g = (await geheimRef(uid).once('value')).val() || {};
  const w = (await werkRef(uid).once('value')).val() || {};
  const uit = { shopify: { gekoppeld: !!g.shopify }, myparcel: { gekoppeld: !!g.myparcel }, meldingen: { telefoons: Object.keys(g.push || {}).length } };
  if (g.shopify) {
    try { const r = await ordersBijwerken(uid); uit.shopify.ok = true; uit.shopify.nieuw = r.nieuw; }
    catch (e) { uit.shopify.fout = String(e && e.message || e).slice(0, 200); }
    const os = Object.values(w.orders || {});
    uit.shopify.open = os.filter(o => o && !o.afgehandeld).length;
    uit.shopify.kaarten = os.filter(o => o && !o.afgehandeld && o.wenskaart_gevraagd && !o.kaart_geprint).length;
    uit.shopify.laatste = os.map(o => o && o.geplaatst).filter(Boolean).sort().pop() || null;
  }
  if (g.myparcel) {
    try {
      const r = await mpRoep(g.myparcel.sleutel, 'shipments?size=1', { headers: mpKoppen(g.myparcel.sleutel) });
      uit.myparcel.ok = r.ok; if (!r.ok) uit.myparcel.fout = 'MyParcel antwoordde met ' + r.status + '.';
    } catch (e) { uit.myparcel.fout = String(e && e.message || e).slice(0, 200); }
  }
  return uit;
});

/* ═══════════ v970: webshop-voorraad per smaak ═══════════
   De samensteller op de website leest per smaak cbx_smaak.voorraad en laat
   niemand meer kiezen dan er is. HQ houdt dat getal bij:
   - elke webshop-order: de smaken uit _cbx_configuration eraf
   - geannuleerde order: weer erbij
   - daarna de dozen: 16 = totaal ÷ 16, 25 = totaal ÷ 25
   Jij past in HQ per smaak aan (nieuwe batch, reserve, betaallink). */
const DOOS_HANDLES = { 16: 'stel-zelf-samen-16-pralines', 25: 'coffret-vert-foret-25-pralines-stel-zelf-samen' };

async function webSmaken(gql) {
  const r = (await gql('{metaobjects(type:"cbx_smaak",first:50){nodes{id handle naam:field(key:"naam"){value} sleutel:field(key:"sleutel"){value} v:field(key:"voorraad"){value} l:field(key:"leverbaar"){value} c:field(key:"chocolade"){value}}}}')).metaobjects.nodes;
  return r.map(m => ({ id: m.id, sleutel: (m.sleutel && m.sleutel.value) || m.handle, naam: (m.naam && m.naam.value) || m.handle,
    voorraad: m.v && m.v.value !== null && m.v.value !== '' ? parseInt(m.v.value, 10) : null,
    leverbaar: !!(m.l && m.l.value === 'true'), chocolade: (m.c && m.c.value) || '' }));
}
async function webZetSmaak(gql, s, aantal) {
  const n = Math.max(0, Math.round(aantal));
  const u = (await gql('mutation($id:ID!,$f:[MetaobjectFieldInput!]!){metaobjectUpdate(id:$id,metaobject:{fields:$f}){userErrors{message}}}',
    { id: s.id, f: [{ key: 'voorraad', value: String(n) }] })).metaobjectUpdate;
  if (u.userErrors && u.userErrors.length) throw new HttpsError('internal', 'Voorraad zetten lukte niet: ' + fouten(u.userErrors));
  s.voorraad = n;
}
async function webDozen(uid, gql, smaken) {
  const tot = smaken.filter(s => s.leverbaar && s.voorraad !== null).reduce((n, s) => n + Math.max(0, s.voorraad), 0);
  const uit = { totaal: tot };
  const loc = await shopifyLocatie(uid);
  for (const maat of [16, 25]) {
    const p = (await gql('query($h:String!){productByIdentifier(identifier:{handle:$h}){variants(first:1){nodes{inventoryItem{legacyResourceId}}}}}', { h: DOOS_HANDLES[maat] })).productByIdentifier;
    const ii = p && p.variants.nodes[0] && p.variants.nodes[0].inventoryItem.legacyResourceId;
    if (!ii) continue;
    const n = Math.floor(tot / maat);
    await shopifySchrijf(uid, 'inventory_levels/set.json', { location_id: loc, inventory_item_id: Number(ii), available: n });
    uit['doos' + maat] = n;
  }
  return uit;
}
function kleurenUitOrder(o) {
  const tel = {};
  (o.line_items || []).forEach(li => {
    const p = (li.properties || []).find(x => x && x.name === '_cbx_configuration');
    if (!p) return;
    let c = {}; try { c = JSON.parse(p.value) || {}; } catch (e) { return; }
    if (c.color) tel[c.color] = (tel[c.color] || 0) + (Number(li.quantity) || 1);
  });
  return tel;
}
async function kleurVoorraad(gql) {
  const s = (await gql('{shop{id m:metafield(namespace:"cbx",key:"dooskleur_voorraad"){value}}}')).shop;
  let v = {}; try { v = s.m ? JSON.parse(s.m.value) || {} : {}; } catch (e) { v = {}; }
  return { shopId: s.id, v };
}
async function kleurZet(gql, shopId, v) {
  const u = (await gql('mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}',
    { m: [{ ownerId: shopId, namespace: 'cbx', key: 'dooskleur_voorraad', type: 'json', value: JSON.stringify(v) }] })).metafieldsSet;
  if (u.userErrors && u.userErrors.length) throw new HttpsError('internal', 'Dooskleuren opslaan lukte niet: ' + fouten(u.userErrors));
}
function smakenUitOrder(o) {
  const tel = {};
  (o.line_items || []).forEach(li => {
    const p = (li.properties || []).find(x => x && x.name === '_cbx_configuration');
    if (!p) return;
    let c = {}; try { c = JSON.parse(p.value) || {}; } catch (e) { return; }
    const q = Number(li.quantity) || 1;
    Object.keys(c.counts || {}).forEach(k => { const n = parseInt(c.counts[k], 10) || 0; if (n > 0) tel[k] = (tel[k] || 0) + n * q; });
  });
  return tel;
}
/* aangeroepen vanuit ordersBijwerken met de orders die Shopify net gaf */
async function webVoorraadVerwerk(uid, orders) {
  const ref = werkRef(uid).child('webVoorraad/geteld');
  /* alleen orders van ná de start tellen: oudere zitten al in je beginstand */
  const startRef = werkRef(uid).child('webVoorraad/start');
  let start = (await startRef.once('value')).val();
  if (!start) { start = Date.parse('2026-11-08T08:00:00Z'); await startRef.set(start); }
  orders = orders.filter(o => Date.parse(o.created_at || 0) >= start);
  const geteld = (await ref.once('value')).val() || {};
  const mut = {}, kmut = {}, upd = {};
  orders.forEach(o => {
    const id = String(o.id), tel = smakenUitOrder(o), kl = kleurenUitOrder(o);
    if (!Object.keys(tel).length && !Object.keys(kl).length) return;
    const g = geteld[id];
    if (!g && !o.cancelled_at && o.financial_status !== 'voided') {
      Object.keys(tel).forEach(k => { mut[k] = (mut[k] || 0) - tel[k]; });
      Object.keys(kl).forEach(k => { kmut[k] = (kmut[k] || 0) - kl[k]; });
      upd[id] = { tel, kl, t: Date.now() };
    } else if (g && !g.terug && o.cancelled_at) {
      Object.keys(g.tel || {}).forEach(k => { mut[k] = (mut[k] || 0) + g.tel[k]; });
      Object.keys(g.kl || {}).forEach(k => { kmut[k] = (kmut[k] || 0) + g.kl[k]; });
      upd[id] = Object.assign({}, g, { terug: Date.now() });
    }
  });
  if (!Object.keys(mut).length && !Object.keys(kmut).length) return null;
  const gql = await shopifyGql(uid, 'write_metaobjects');
  if (Object.keys(kmut).length) {
    const { shopId, v } = await kleurVoorraad(gql);
    Object.keys(kmut).forEach(k => { if (typeof v[k] === 'number') v[k] = Math.max(0, v[k] + kmut[k]); });
    await kleurZet(gql, shopId, v);
  }
  const smaken = await webSmaken(gql);
  for (const k of Object.keys(mut)) {
    const s = smaken.find(x => x.sleutel === k);
    if (s && s.voorraad !== null) await webZetSmaak(gql, s, s.voorraad + mut[k]);
  }
  await ref.update(upd);
  return webDozen(uid, gql, smaken);
}

exports.webVoorraadLees = binnen('webVoorraadLees', async req => {
  const uid = wieBenJe(req);
  const gql = await shopifyGql(uid, 'read_metaobjects');
  const smaken = await webSmaken(gql);
  const tot = smaken.filter(s => s.leverbaar && s.voorraad !== null).reduce((n, s) => n + Math.max(0, s.voorraad), 0);
  let kleuren = {}; try { kleuren = (await kleurVoorraad(gql)).v; } catch (e) { kleuren = {}; }
  /* v989: ook de echte dozenvoorraad uit Shopify */
  let dozen = {};
  try {
    const gp = await shopifyGql(uid, 'read_products');
    const r = await gp('query{a:productByIdentifier(identifier:{handle:"stel-zelf-samen-16-pralines"}){totalInventory} b:productByIdentifier(identifier:{handle:"coffret-vert-foret-25-pralines-stel-zelf-samen"}){totalInventory}}');
    dozen = { d16: r.a ? r.a.totalInventory : null, d25: r.b ? r.b.totalInventory : null };
  } catch (e) { dozen = {}; }
  return { smaken: smaken.map(({ id, ...s }) => s), kleuren, dozen, totaal: tot, doos16: Math.floor(tot / 16), doos25: Math.floor(tot / 25), op: Date.now() };
});

/* per smaak: {sleutel, aantal} (precies zetten) of {sleutel, erbij} (erbij/eraf) */
exports.webVoorraadZet = binnen('webVoorraadZet', async req => {
  const uid = wieBenJe(req);
  const lijst = ((req.data || {}).wijzigingen || []).slice(0, 50);
  if (!lijst.length && !(req.data || {}).kleuren) throw new HttpsError('invalid-argument', 'Niets om aan te passen.');
  const gql = await shopifyGql(uid, 'write_metaobjects');
  const smaken = await webSmaken(gql);
  for (const w of lijst) {
    const s = smaken.find(x => x.sleutel === w.sleutel);
    if (!s) continue;
    const nieuw = typeof w.aantal === 'number' ? w.aantal : (s.voorraad || 0) + (Number(w.erbij) || 0);
    await webZetSmaak(gql, s, nieuw);
  }
  const kw = (req.data || {}).kleuren;
  let kleuren = null;
  if (kw && typeof kw === 'object') {
    const { shopId, v } = await kleurVoorraad(gql);
    Object.keys(kw).forEach(k => { if (/^[a-z]{2,20}$/.test(k)) v[k] = Math.max(0, Math.round(Number(kw[k]) || 0)); });
    await kleurZet(gql, shopId, v); kleuren = v;
  }
  const d = await webDozen(uid, gql, smaken);
  if (kleuren) d.kleuren = kleuren;
  await werkRef(uid).child('webVoorraad').update({ bijgewerkt: Date.now() });
  return Object.assign({ smaken: smaken.map(({ id, ...s }) => s) }, d);
});

/* ═══ Eenmalig (8 nov): TESTmail drop 8 november, alleen naar h.ngadi@cacaoboetiek.nl ═══
   Draait elke minuut maar verstuurt maar één keer (vlag in geheim/_systeem).
   Gaat via info@ (Strato). Wordt na de test weer verwijderd. */

/* ═══════════ v975: drop-mail vanuit HQ naar adressen die jij aanvinkt ═══════════
   Abonnees › vink aan › Drop-mail sturen. Optioneel eerst 2 cadeaustempels (zelfde
   boekhouding als de HQ-knop, campagne drop-8-nov, dus nooit dubbel). Mail gaat via
   info@ met een eigen afmeldlink. In de database alleen klantnummers + tijdstip
   (zodat niemand hem twee keer krijgt), geen namen of adressen. */
async function afmeldSleutel() {
  const r = db().ref('geheim/_systeem/afmeldSleutel');
  let k = (await r.once('value')).val();
  if (!k) { k = crypto.randomBytes(24).toString('hex'); await r.set(k); }
  return k;
}
const afmeldHash = (k, nr) => crypto.createHmac('sha256', k).update('afmelden:' + nr).digest('hex').slice(0, 24);

exports.afmelden = onRequest({ invoker: 'public', cors: false }, async (req, res) => {
  const nr = String(req.query.k || '').replace(/\D/g, ''), t = String(req.query.t || '');
  const pagina = (kop, tekst) => res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cacaoboetiek</title>' +
    '<body style="margin:0;font-family:Georgia,serif;background:#f7f3ee;color:#512f25;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">' +
    '<div><p style="letter-spacing:.3em;font-size:13px;margin:0 0 18px">CACAOBOETIEK</p><h1 style="font-weight:400;font-size:26px;margin:0 0 12px">' + kop + '</h1>' +
    '<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;margin:0">' + tekst + '</p>' +
    '<p style="margin:26px 0 0"><a href="https://www.cacaoboetiek.nl" style="color:#512f25">www.cacaoboetiek.nl</a></p></div>');
  try {
    if (!nr || afmeldHash(await afmeldSleutel(), nr) !== t) return pagina('Deze link klopt niet', 'Afmelden kan ook door te mailen naar info@cacaoboetiek.nl.');
    const g = (await db().ref('geheim').once('value')).val() || {};
    const uid = Object.keys(g).find(k => !k.startsWith('_') && g[k] && g[k].shopify);
    const gql = await shopifyGql(uid, 'write_customers');
    const u = (await gql('mutation($i:CustomerEmailMarketingConsentUpdateInput!){customerEmailMarketingConsentUpdate(input:$i){userErrors{message}}}',
      { i: { customerId: 'gid://shopify/Customer/' + nr, emailMarketingConsent: { marketingState: 'UNSUBSCRIBED' } } })).customerEmailMarketingConsentUpdate;
    if (u.userErrors && u.userErrors.length) throw new Error(u.userErrors[0].message);
    await db().ref('geheim/_systeem/afmeldingen').transaction(n => (n || 0) + 1);
    return pagina('Je bent afgemeld', 'Je ontvangt geen nieuwsbrieven meer van Cacaoboetiek. Je stempels blijven gewoon staan.');
  } catch (e) {
    return pagina('Dat lukte even niet', 'Mail ons op info@cacaoboetiek.nl, dan melden we je direct af.');
  }
});

const CAMPAGNES = {
  'drop-8-nov': { campagne: 'drop-8-nov', stempels: true, html: 'https://cacaoboetiek-hq.web.app/shopify/mail/drop-8-november.html',
    onderwerp: 'Vanavond om 19:00 gaat de drop live',
    tekst: 'Vanavond om 19:00 gaat de drop live op www.cacaoboetiek.nl. Voor je aanmelding krijg je twee gratis stempels.' },
  /* v985: herinnering voor aanmelders die nog niet bestelden */
  'herinnering-9-nov': { campagne: 'herinnering-9-nov', stempels: false, html: 'https://cacaoboetiek-hq.web.app/shopify/mail/herinnering-9-november.html',
    onderwerp: 'Je 2 stempels staan klaar',
    tekst: 'De drop is live op www.cacaoboetiek.nl en de eerste smaken raken op. Je 2 gratis stempels staan klaar op je stempelkaart.' }
};
exports.dropMailStuur = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const DROPMAIL = CAMPAGNES[d.campagne || 'drop-8-nov'];
  if (!DROPMAIL) throw new HttpsError('invalid-argument', 'Onbekende mail.');
  const ref = werkRef(uid).child('dropMail').child(DROPMAIL.campagne);
  const al = (await ref.child('verstuurd').once('value')).val() || {};
  const alOngeldig = (await ref.child('ongeldig').once('value')).val() || {};
  /* v980: wie de drop-mail kreeg en zich daarna afmeldde (via onze link of anders) */
  if (d.afgemeld) {
    const nrs = Object.keys(al), gql0 = await shopifyGql(uid, 'read_customers'), uit = [];
    for (let i = 0; i < nrs.length; i += 100) {
      const r0 = await gql0('query($i:[ID!]!){nodes(ids:$i){... on Customer{id defaultEmailAddress{emailAddress marketingState marketingUpdatedAt}}}}',
        { i: nrs.slice(i, i + 100).map(n => 'gid://shopify/Customer/' + n) });
      (r0.nodes || []).forEach(c => {
        if (!c || !c.id) return;
        const e = c.defaultEmailAddress, nr = String(c.id).split('/').pop();
        if (!e) uit.push({ id: nr, email: '(verwijderd)', op: null, gemaild: al[nr] });
        else if (e.marketingState !== 'SUBSCRIBED') uit.push({ id: nr, email: e.emailAddress, op: e.marketingUpdatedAt || null, gemaild: al[nr] });
      });
    }
    uit.sort((a, b) => String(b.op || '').localeCompare(String(a.op || '')));
    return { afgemeld: uit, gemaild: nrs.length };
  }
  if (!Array.isArray(d.ids) || !d.ids.length) return { verstuurdIds: Object.keys(al), verstuurdOp: al, ongeldigIds: Object.keys(alOngeldig) };
  const ids = [...new Set(d.ids.map(x => String(x).replace(/\D/g, '')).filter(Boolean))].slice(0, 25);
  const mg = await leesGeheim(uid, 'mail');
  if (!mg || !mg.adres) throw new HttpsError('failed-precondition', 'Koppel eerst info@ bij Koppelingen › Mail.');
  const mg2 = await leesGeheim(uid, 'mail2');
  const gql = await shopifyGql(uid, 'write_customers');
  const r = await gql('query($i:[ID!]!){nodes(ids:$i){... on Customer{id defaultEmailAddress{emailAddress marketingState} eerste:orders(first:1,sortKey:CREATED_AT){nodes{createdAt}} s:metafield(namespace:"cbx",key:"spaarsaldo"){value} cb:metafield(namespace:"custom",key:"cb_stamps"){value}}}}',
    { i: ids.map(n => 'gid://shopify/Customer/' + n) });
  const klanten = (r.nodes || []).filter(c => c && c.id && c.defaultEmailAddress && c.defaultEmailAddress.emailAddress);
  let overgeslagen = ids.length - klanten.length, nietIngeschreven = 0;
  const lijst = klanten.filter(c => {
    const nr = String(c.id).split('/').pop();
    if (al[nr]) { overgeslagen++; return false; }
    if (c.defaultEmailAddress.marketingState !== 'SUBSCRIBED') { nietIngeschreven++; return false; }
    return true;
  });

  /* 1. stempels (optioneel) */
  let stempels = 0, oudeKlant = 0;
  if (d.stempels && DROPMAIL.stempels) {
    const sRef = werkRef(uid).child('cadeauStempels').child(DROPMAIL.campagne);
    const sAl = (await sRef.child('klanten').once('value')).val() || {};
    const m = [], klaar = {};
    lijst.forEach(c => {
      const nr = String(c.id).split('/').pop();
      if (sAl[nr]) return;
      /* zoals afgesproken: wie vóór 1 oktober al eens bestelde, krijgt geen cadeaustempels */
      const o1 = c.eerste && c.eerste.nodes && c.eerste.nodes[0];
      if (o1 && Date.parse(o1.createdAt) < Date.parse('2026-10-01T00:00:00+02:00')) { oudeKlant++; return; }
      const saldo = c.s ? (parseFloat(c.s.value) || 0) : 0;
      let st = {}; try { st = c.cb ? JSON.parse(c.cb.value) || {} : {}; } catch (e) { st = {}; }
      const kaart = Math.max(0, Math.min(15000, parseInt(st.cardCents, 10) || 0));
      const na = Math.min(15000, kaart + 2 * 2500);
      const nst = Object.assign({ version: 1 }, st, { cardCents: na, remainingCents: 15000 - na,
        status: na >= 15000 && (!st.status || st.status === 'active') ? 'claim_available' : (st.status || 'active'),
        courtesyMessage: 'Cadeau van Cacaoboetiek: 2 stempels erbij.' });
      m.push({ ownerId: c.id, namespace: 'cbx', key: 'spaarsaldo', type: 'number_decimal', value: (Math.round((saldo + 2 * STEMPEL_EURO) * 100) / 100).toFixed(2) });
      m.push({ ownerId: c.id, namespace: 'custom', key: 'cb_stamps', type: 'json', value: JSON.stringify(nst) });
      klaar[nr] = Date.now();
    });
    for (let i = 0; i < m.length; i += 24) {
      const u = (await gql('mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}', { m: m.slice(i, i + 24) })).metafieldsSet;
      if (u.userErrors && u.userErrors.length) throw new HttpsError('internal', 'Stempels lukten niet: ' + u.userErrors.map(x => x.message).join(', ').slice(0, 200));
    }
    if (Object.keys(klaar).length) { await sRef.child('klanten').update(klaar); await sRef.update({ aantal: 2, laatst: Date.now() }); }
    stempels = Object.keys(klaar).length;
  }

  /* 2. mail */
  const k = await afmeldSleutel();
  const basis = await (await fetch(DROPMAIL.html + '?t=' + Date.now())).text();
  const nodemailer = require('nodemailer');
  /* v979: eerst info@; weigert die (limiet), dan door met de reserve-mailbox */
  const afzenders = [mg, mg2].filter(x => x && x.adres && x.wachtwoord).map(x => ({ adres: x.adres,
    t: nodemailer.createTransport({ host: 'smtp.strato.de', port: 465, secure: true, pool: true, maxConnections: 1, auth: { user: x.adres, pass: x.wachtwoord } }) }));
  let ai = 0, ok = 0, mis = 0, fout = '';
  const gelukt = {}, perAfzender = {}, ongeldig = {};
  for (const c of lijst) {
    const nr = String(c.id).split('/').pop();
    const url = 'https://europe-west1-cacaoboetiek-hq.cloudfunctions.net/afmelden?k=' + nr + '&t=' + afmeldHash(k, nr);
    let klaar = false;
    while (!klaar && ai < afzenders.length) {
      const a = afzenders[ai];
      try {
        await a.t.sendMail({ from: { name: 'Cacaoboetiek', address: a.adres }, replyTo: 'info@cacaoboetiek.nl', to: c.defaultEmailAddress.emailAddress,
          subject: DROPMAIL.onderwerp,
          headers: { 'List-Unsubscribe': '<' + url + '>, <mailto:info@cacaoboetiek.nl?subject=Afmelden>' },
          html: basis.split('{{ unsubscribe_url }}').join(url),
          text: DROPMAIL.tekst + ' Afmelden: ' + url });
        ok++; gelukt[nr] = Date.now(); perAfzender[a.adres] = (perAfzender[a.adres] || 0) + 1; klaar = true;
      } catch (e) {
        const msg = String(e && e.message || e);
        /* v981: ligt het aan het ADRES van de klant (bestaat niet, tikfout)? Dan alleen
           die overslaan en gewoon doorgaan met dezelfde afzender. */
        if ((e && e.code === 'EENVELOPE' && e.rejected && e.rejected.length) || /\b5\.1\.[0-9]\b|does not exist|user unknown|no such user|mailbox unavailable/i.test(msg)) {
          ongeldig[nr] = Date.now(); klaar = true; break;
        }
        fout = a.adres.split('@')[0] + ': ' + msg.replace(/[^\s<>@]+@[^\s<>]+/g, '[adres]').slice(0, 200);
        console.warn('dropMailStuur fout', (e && e.responseCode) || '', fout);
        ai++;   /* deze afzender weigert: volgende proberen voor dezelfde ontvanger */
      }
    }
    if (!klaar) { mis = lijst.length - ok - Object.keys(ongeldig).length; break; }
    await new Promise(z => setTimeout(z, 1200));
  }
  afzenders.forEach(a => a.t.close());
  if (ok) await ref.child('verstuurd').update(gelukt);
  if (Object.keys(ongeldig).length) await ref.child('ongeldig').update(ongeldig);
  if (mis) await ref.update({ laatsteFout: fout, laatsteFoutOp: Date.now() });
  return { verstuurd: ok, mislukt: mis, fout, perAfzender, overgeslagen, nietIngeschreven, stempels, oudeKlant, verstuurdIds: Object.keys(Object.assign({}, al, gelukt)), verstuurdOp: Object.assign({}, al, gelukt), ongeldig: Object.keys(ongeldig).length, ongeldigIds: Object.keys(Object.assign({}, alOngeldig, ongeldig)) };
});

/* 8 nov: wekker voor de drop. Shopify heeft geen API om het winkelwachtwoord uit te
   zetten, dus HQ seint je: 18:55 klaarzetten, 19:00 nu uitzetten. */
async function dropWekker(titel, tekst) {
  const g = (await db().ref('geheim').once('value')).val() || {};
  for (const uid of Object.keys(g).filter(k => !k.startsWith('_') && g[k] && g[k].push)) {
    await stuurPush(uid, { titel, tekst, url: 'https://admin.shopify.com/store/3e6b32-d5/online_store/preferences' });
  }
}
exports.dropWekker1855 = onSchedule({ schedule: '55 18 8 11 *', timeZone: 'Europe/Amsterdam' }, async () =>
  dropWekker('Drop over 5 minuten', 'Open nu Shopify › Online Store › Voorkeuren, zodat je om 19:00 alleen nog het wachtwoord hoeft uit te zetten.'));
exports.dropWekker1900 = onSchedule({ schedule: '0 19 8 11 *', timeZone: 'Europe/Amsterdam' }, async () =>
  dropWekker('19:00 — zet de winkel open!', 'Tik hier: wachtwoordbeveiliging uitvinken en opslaan.'));

/* v983: Shopify-order annuleren vanuit HQ. Shopify zet de doos terug op voorraad;
   de smaken en dooskleur zet HQ zelf terug bij de volgende ronde (binnen een minuut),
   via webVoorraadVerwerk, die geannuleerde orders terugboekt. */
exports.orderAnnuleer = binnen('orderAnnuleer', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  const nr = String(d.order || '').replace(/\D/g, '');
  if (!nr) throw new HttpsError('invalid-argument', 'Welke order?');
  const gql = await shopifyGql(uid, 'write_orders');
  const o = (await gql('query($id:ID!){order(id:$id){id name cancelledAt displayFinancialStatus}}', { id: 'gid://shopify/Order/' + nr })).order;
  if (!o) throw new HttpsError('not-found', 'Order niet gevonden in Shopify.');
  if (o.cancelledAt) return { alGedaan: true, naam: o.name };
  let r;
  try {
    r = (await gql('mutation($o:ID!,$n:Boolean,$t:Boolean!){orderCancel(orderId:$o,reason:CUSTOMER,restock:true,notifyCustomer:$n,refundMethod:{originalPaymentMethodsRefund:$t},staffNote:"Geannuleerd via HQ"){job{id} orderCancelUserErrors{message}}}',
      { o: o.id, n: d.bericht === true, t: d.terugbetalen !== false })).orderCancel;
  } catch (e) { throw schrijfFout(e); }
  if (r.orderCancelUserErrors && r.orderCancelUserErrors.length) throw schrijfFout(new HttpsError('internal', 'Annuleren lukte niet: ' + fouten(r.orderCancelUserErrors)));
  return { ok: true, naam: o.name, terugbetaald: d.terugbetalen !== false };
});

/* ═══════════ v991: voorbereiden — alles voor de open orders in één keer ═══════════
   Haalt de open, nog niet verzonden orders op met wat je nodig hebt om te printen:
   dozen met smaken en inpakvolgorde, kaartjes, lintjes, factuurregels en het
   verzendadres zoals MyParcel het zou lezen. Naam en adres gaan rechtstreeks naar
   jouw toestel en worden nergens bewaard. */
exports.voorbereid = binnen('voorbereid', async req => {
  const uid = wieBenJe(req);
  const orders = [];
  let pad = 'orders.json?status=open&fulfillment_status=unfulfilled&limit=250';
  for (let ronde = 0; ronde < 4; ronde++) {
    const { gegevens, volgende } = await shopifyPagina(uid, pad);
    (gegevens.orders || []).forEach(o => orders.push(o));
    if (!volgende) break;
    pad = 'orders.json?limit=250&page_info=' + encodeURIComponent(volgende);
  }
  const KADO = /kado|cadeau|gift|inpak|wrap|wenskaart|kaartje|lint/i;
  const attr = li => { const m = {}; (li.properties || []).forEach(p => { if (p && p.name) m[p.name] = p.value; }); return m; };
  const uit = orders.filter(o => !o.cancelled_at && o.financial_status !== 'voided').map(o => {
    const nummer = String(o.name || o.order_number || '').replace(/^#/, '');
    const a = o.shipping_address || null;
    const ophalenLijn = (o.shipping_lines || []).some(s => /ophalen|afhalen|pick/i.test(String(s.title || '')));
    const afhaal = !a || ophalenLijn;
    let adres = null;
    if (a) {
      let sp = {}; try { sp = splitsAdres(a); } catch (e) { sp = {}; }
      adres = {
        naam: String(a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || ''),
        bedrijf: a.company || '', regel1: a.address1 || '', regel2: a.address2 || '',
        straat: sp.straat || '', nummer: sp.nummer || '', toevoeging: sp.toevoeging || '',
        postcode: String(a.zip || '').replace(/\s+/g, '').toUpperCase(), plaats: a.city || '',
        land: String(a.country_code || 'NL').toUpperCase(), landNaam: a.country || ''
      };
      adres.probleem = !adres.straat || !adres.nummer ? 'straat en huisnummer niet te scheiden' : (!adres.postcode ? 'geen postcode' : '');
    }
    const dozen = {}, volgorde = [];
    const kaarten = [], linten = [];
    (o.line_items || []).filter(li => !li.gift_card).forEach(li => {
      const m = attr(li), rol = m._cbx_role, id = m._cbx_id || ('li' + li.id);
      if (rol === 'box' || m._cbx_configuration) {
        let c = {}; try { c = JSON.parse(m._cbx_configuration || '{}') || {}; } catch (e) { c = {}; }
        for (let q = 0; q < (Number(li.quantity) || 1); q++) {
          const k = id + (q ? '-' + q : '');
          dozen[k] = { id: k, maat: Number(c.size) || (/25/.test(li.title) ? 25 : 16), kleur: c.color || String(m.Dooskleur || '').toLowerCase(),
            ontvanger: m.Ontvanger || '', counts: c.counts || {}, volgorde: Array.isArray(c.packingOrder) ? c.packingOrder : [],
            allergenen: m.Allergenen && m.Allergenen !== 'Niet opgegeven' ? m.Allergenen : '', kaart: null, lint: null };
          volgorde.push(k);
        }
      } else if (rol === 'card' || /kaartje/i.test(li.title || '')) {
        kaarten.push({ id, tekst: m.Boodschap || '', voor: m.Ontvanger || '' });
      } else if (rol === 'ribbon' || /lint/i.test(li.title || '')) {
        linten.push({ id, tekst: m.Tekst || '', kleur: m.Lintkleur || '', voor: m.Ontvanger || '' });
      }
    });
    kaarten.forEach(k => { if (dozen[k.id]) dozen[k.id].kaart = k; });
    linten.forEach(l => { if (dozen[l.id]) dozen[l.id].lint = l; });
    /* factuurregels zoals bij één order, met inhoud */
    const { regels, kadoRegels, kado } = factuurRegelsVan(o);
    const b = o.billing_address || a || {};
    return {
      shopifyId: String(o.id), nummer, datum: (o.created_at || '').slice(0, 10), betaald: o.financial_status === 'paid',
      afhaal, adres,
      klant: { naam: String(b.name || [o.customer && o.customer.first_name, o.customer && o.customer.last_name].filter(Boolean).join(' ') || 'Klant'),
        adres: [b.address1, b.address2, [String(b.zip || '').toUpperCase(), b.city].filter(Boolean).join('  '), (b.country_code || 'NL') !== 'NL' ? b.country : null].filter(Boolean).join('\n') },
      dozen: volgorde.map(k => dozen[k]),
      losseKaarten: kaarten.filter(k => !dozen[k.id]), losseLinten: linten.filter(l => !dozen[l.id]),
      regels, kado, kadoRegels, verzending: (o.shipping_lines || []).reduce((n, s) => n + (parseFloat(s.price) || 0), 0),
      kortingOrder: parseFloat(o.total_discounts || 0) || 0, totaal: parseFloat(o.total_price || 0) || 0
    };
  });
  /* status uit HQ: label al aangemaakt, ingepakt, stappen afgevinkt */
  const werk = (await werkRef(uid).child('orders').once('value')).val() || {};
  uit.forEach(x => { const w = werk[x.shopifyId] || {}; x.myparcel_id = w.myparcel_id || null; x.ingepakt = w.ingepakt || null; });
  const stappen = (await werkRef(uid).child('voorbereid').once('value')).val() || {};
  return { orders: uit.sort((p, q) => String(p.datum).localeCompare(String(q.datum)) || Number(p.nummer) - Number(q.nummer)), stappen };
}, { timeoutSeconds: 120 });

/* stap afvinken, of een order als ingepakt markeren */
exports.voorbereidZet = binnen('voorbereidZet', async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};
  if (d.stap) {
    const stap = String(d.stap).replace(/[^a-z]/g, '').slice(0, 20);
    const ids = (d.ids || []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 300);
    await werkRef(uid).child('voorbereid').child(stap).set(d.wis ? null : { op: Date.now(), ids });
  }
  if (d.ingepakt) {
    const id = String(d.ingepakt).replace(/\D/g, '');
    await werkRef(uid).child('orders').child(id).update({ ingepakt: d.uit ? null : Date.now() });
  }
  return { ok: true };
});

/* alle verzendlabels: eerst aanmelden wat nog niet is aangemeld, dan één pdf */
exports.labelsMaken = binnen('labelsMaken', async req => {
  const uid = wieBenJe(req);
  const g = await leesGeheim(uid, 'myparcel');
  if (!g) throw new HttpsError('failed-precondition', 'MyParcel is nog niet gekoppeld.');
  const ids = ((req.data || {}).orders || []).map(String).slice(0, 60);
  const ok = [], fout = [];
  for (const id of ids) {
    try {
      const pad = werkRef(uid).child('orders/' + id);
      let mp = (await pad.child('myparcel_id').once('value')).val();
      if (!mp) {
        const o = await zoekOrder(uid, id);
        const nr = String(o.name || o.order_number || '').replace(/^#/, '');
        const r = await mpRoep(g.sleutel, 'shipments', { method: 'POST',
          headers: mpKoppen(g.sleutel, { 'Content-Type': 'application/vnd.shipment+json;charset=utf-8;version=1.1' }),
          body: JSON.stringify({ data: { shipments: [zending(o, nr)] } }) });
        const t = await r.text();
        if (!r.ok) { let u = ''; try { const f = JSON.parse(t); u = (f.errors && f.errors[0] && (f.errors[0].human || f.errors[0].message)) || f.message || ''; } catch (e) {} throw new Error(u || 'MyParcel antwoordde ' + r.status); }
        let n = null; try { n = ((JSON.parse(t).data || {}).ids || [])[0]; } catch (e) {}
        mp = n && (n.id || n);
        if (!mp) throw new Error('geen zendingnummer');
        await pad.update({ myparcel_id: String(mp), label: true });
      }
      ok.push({ id, mp: String(mp) });
    } catch (e) { fout.push({ id, fout: String(e && e.message || e).slice(0, 160) }); }
  }
  if (!ok.length) return { pdf: null, fout };
  const formaat = String((req.data || {}).formaat || 'A6').toUpperCase() === 'A4' ? 'A4' : 'A6';
  const r = await mpRoep(g.sleutel, 'shipment_labels/' + ok.map(x => encodeURIComponent(x.mp)).join(';') + '?format=' + formaat + (formaat === 'A4' ? '&positions=1;2;3;4' : ''), {
    headers: mpKoppen(g.sleutel, { 'Accept': 'application/pdf' }) });
  if (!r.ok) throw new HttpsError('internal', 'De labels zijn aangemaakt, maar de pdf kwam niet door (MyParcel ' + r.status + '). Probeer het zo nog eens; er worden geen dubbele labels gemaakt.');
  const bytes = Buffer.from(await r.arrayBuffer());
  return { pdf: bytes.toString('base64'), naam: 'verzendlabels-' + new Date().toISOString().slice(0, 10) + '.pdf', aantal: ok.length, fout };
}, { timeoutSeconds: 300, memory: '512MiB' });
