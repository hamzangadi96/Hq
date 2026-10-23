/* ═══════════════════════════════════════════════════════════════════
   Etiket lezen — een levering inboeken met je camera

   De app stuurt één tot zes foto's: een overzicht van de dozen en
   close-ups van de etiketten. Claude leest per partij wat erop staat:
   product, artikelcode, lotnummer, THT, productiedatum, gewicht.

   Wat Claude niet zeker weet, laat hij leeg of markeert hij als twijfel.
   De app kleurt die velden amber en jij kijkt ze na. Liever een leeg veld
   dan een verzonnen lotnummer: dat lot volg je later terug naar een klant.

   Dezelfde Claude-sleutel als Studio (geheim/<uid>/claude).
   ═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
/* Kleine print vraagt een scherp model. Kent je account het eerste niet,
   dan valt hij terug op het model dat Studio al gebruikt. */
const MODELLEN = ['claude-sonnet-5-5', 'claude-haiku-4-5'];

const MAXBEELDEN = 6;
const MAXBEELDGROOTTE = 1400000;   // base64-tekens per beeld (~1 MB foto)
const MAXBEKEND = 300;

function wieBenJe(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
  return uid;
}

async function leesGeheim(uid, welke) {
  const s = await admin.database().ref('geheim/' + uid + '/' + welke).once('value');
  return s.val() || null;
}

const OPDRACHT =
  'Je leest etiketten van leveringen voor Cacaoboetiek, een kleine chocolatier. ' +
  'Je krijgt foto\'s van dozen, zakken of potten met grondstoffen of verpakking. ' +
  'Sommige foto\'s tonen meerdere dozen, andere een close-up van één etiket. ' +
  'Combineer alles tot één lijst partijen.\n\n' +
  'Een partij is één product met één lotnummer. Twee dozen van hetzelfde product ' +
  'met hetzelfde lot zijn één partij met aantal 2. Zelfde product met ander lot ' +
  'zijn twee partijen. Een close-up en een overzichtsfoto van dezelfde doos zijn ' +
  'dezelfde partij, tel die niet dubbel.\n\n' +
  'Het allerbelangrijkste: verzin niets. Lotnummer en THT worden gebruikt voor ' +
  'voedselveiligheid. Kun je een teken niet met zekerheid lezen, zet dan het veld ' +
  'leeg of zet het in "twijfel". Een leeg veld is goed, een fout veld is slecht.\n\n' +
  'Datums: geef ze als JJJJ-MM-DD. Europese etiketten schrijven meestal ' +
  'dag-maand-jaar. Staat er alleen maand en jaar, neem dan de laatste dag van ' +
  'die maand. THT is "best before", "ten minste houdbaar tot", "BBE", "MHD", ' +
  '"DLUO" of "à consommer de préférence avant".\n\n' +
  'Voedingswaarde en ingrediënten staan vaak op een andere zijde van de verpakking. ' +
  'Neem ze alleen over als ze echt op een foto staan en horen bij dit product. ' +
  'Is het etiket meertalig, gebruik dan de Nederlandse tekst; is die er niet, vertaal de ' +
  'ingrediënten naar het Nederlands. Per 100 g, nooit per portie.\n\n' +
  'Productnaam: kort en in het Nederlands, zoals een chocolatier het zou ' +
  'noemen, bijvoorbeeld "Melkchocolade callets" of "Witte chocolade". ' +
  '{BEKEND}\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg en zonder markdown:\n' +
  '{\n' +
  '  "partijen": [\n' +
  '    {\n' +
  '      "product":        korte naam,\n' +
  '      "omschrijving":   wat er letterlijk als productnaam op staat,\n' +
  '      "artikelcode":    de artikelcode/referentie van de fabrikant, of "",\n' +
  '      "leverancier":    fabrikant of leverancier als die leesbaar is, of "",\n' +
  '      "lot":            lotnummer precies zoals gedrukt, of "",\n' +
  '      "tht":            JJJJ-MM-DD of "",\n' +
  '      "productiedatum": JJJJ-MM-DD of "",\n' +
  '      "hoeveel":        netto inhoud van één verpakking als getal, of null,\n' +
  '      "eenheid":        "kg", "g", "l", "ml" of "st",\n' +
  '      "aantal":         hoeveel verpakkingen van deze partij je ziet,\n' +
  '      "voeding":        voedingswaarde per 100 g als die op een foto staat, anders null:\n' +
  '                        {"kj","kcal","vet","verz","koolh","suik","eiwit","zout"} als getallen,\n' +
  '                        verz = waarvan verzadigd, suik = waarvan suikers; onleesbaar = null,\n' +
  '      "ingredienten":   de ingrediëntenlijst in het Nederlands zoals gedrukt, met percentages,\n' +
  '                        zonder het woord "Ingrediënten:", of "" als die niet op een foto staat,\n' +
  '      "allergenen":     allergenen die erin ZITTEN (niet "kan sporen bevatten"), alleen codes uit:\n' +
  '                        gluten schaaldier ei vis pinda soja melk noten selderij mosterd sesam\n' +
  '                        sulfiet lupine weekdier,\n' +
  '      "twijfel":        lijst veldnamen waar je niet zeker van bent (ook "voeding" of "ingredienten")\n' +
  '    }\n' +
  '  ],\n' +
  '  "tip": één korte zin als een foto onscherp of te ver weg is, anders ""\n' +
  '}';

/* ---------- invoer nakijken ---------- */

function schoneBeelden(ruw) {
  return (Array.isArray(ruw) ? ruw : [])
    .slice(0, MAXBEELDEN)
    .map(b => String(typeof b === 'string' ? b : (b && b.data) || '')
      .replace(/^data:image\/\w+;base64,/, ''))
    .filter(b => b.length > 100 && b.length < MAXBEELDGROOTTE);
}

function schoneLijst(ruw, max, lang) {
  return (Array.isArray(ruw) ? ruw : [])
    .slice(0, max)
    .map(x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, lang))
    .filter(Boolean);
}

/* ---------- antwoord nakijken ---------- */

function leesJson(tekst) {
  const schoon = String(tekst || '').replace(/```json|```/g, '').trim();
  const van = schoon.indexOf('{');
  const tot = schoon.lastIndexOf('}');
  return JSON.parse(van >= 0 && tot > van ? schoon.slice(van, tot + 1) : schoon);
}

const VELDEN = ['product', 'artikelcode', 'leverancier', 'lot', 'tht', 'productiedatum', 'hoeveel', 'eenheid', 'aantal', 'voeding', 'ingredienten'];
const VOEDING = ['kj', 'kcal', 'vet', 'verz', 'koolh', 'suik', 'eiwit', 'zout'];
const ALLERGENEN = ['gluten', 'schaaldier', 'ei', 'vis', 'pinda', 'soja', 'melk', 'noten', 'selderij',
  'mosterd', 'sesam', 'sulfiet', 'lupine', 'weekdier'];

function schoneVoeding(v) {
  if (!v || typeof v !== 'object') return null;
  const uit = {};
  VOEDING.forEach(k => {
    const n = Number(String(v[k] == null ? '' : v[k]).replace(',', '.'));
    if (v[k] !== null && v[k] !== '' && isFinite(n) && n >= 0 && n <= 4000) uit[k] = n;
  });
  return Object.keys(uit).length ? uit : null;
}
const EENHEDEN = ['kg', 'g', 'l', 'ml', 'st'];

function datum(d) {
  const s = String(d || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const t = new Date(s + 'T12:00:00Z');
  if (isNaN(t)) return '';
  const j = t.getUTCFullYear();
  return j >= 2020 && j <= 2040 ? s : '';
}

function tekst(x, max) {
  return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);
}

function schonePartij(p) {
  p = p || {};
  const twijfel = (Array.isArray(p.twijfel) ? p.twijfel : [])
    .map(x => String(x || '').trim()).filter(x => VELDEN.includes(x));
  const tht = datum(p.tht);
  if (p.tht && !tht && !twijfel.includes('tht')) twijfel.push('tht');
  let hoeveel = Number(String(p.hoeveel == null ? '' : p.hoeveel).replace(',', '.'));
  if (!isFinite(hoeveel) || hoeveel <= 0 || hoeveel > 100000) hoeveel = null;
  let eenheid = String(p.eenheid || '').trim().toLowerCase();
  if (!EENHEDEN.includes(eenheid)) eenheid = 'kg';
  let aantal = Math.round(Number(p.aantal));
  if (!isFinite(aantal) || aantal < 1) aantal = 1;
  aantal = Math.min(aantal, 99);
  return {
    product: tekst(p.product, 60),
    omschrijving: tekst(p.omschrijving, 80),
    artikelcode: tekst(p.artikelcode, 40),
    leverancier: tekst(p.leverancier, 40),
    lot: tekst(p.lot, 40),
    tht,
    productiedatum: datum(p.productiedatum),
    hoeveel,
    eenheid,
    aantal,
    voeding: schoneVoeding(p.voeding),
    ingredienten: tekst(p.ingredienten, 1500),
    allergenen: (Array.isArray(p.allergenen) ? p.allergenen : [])
      .map(x => String(x || '').trim().toLowerCase()).filter(x => ALLERGENEN.includes(x)),
    twijfel
  };
}

async function vraagClaude(sleutel, model, systeem, inhoud) {
  return fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': sleutel,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      system: systeem,
      messages: [{ role: 'user', content: inhoud }]
    })
  });
}

/* ---------- de functie ---------- */

exports.leesEtiket = onCall(
  { region: 'europe-west1', timeoutSeconds: 90, memory: '256MiB' },
  async req => {
    const uid = wieBenJe(req);
    const d = req.data || {};

    const beelden = schoneBeelden(d.beelden);
    if (!beelden.length) throw new HttpsError('invalid-argument', 'Geen foto ontvangen.');

    const g = await leesGeheim(uid, 'claude');
    if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

    const producten = schoneLijst(d.producten, MAXBEKEND, 60);
    const leveranciers = schoneLijst(d.leveranciers, 60, 40);
    const bekend = (producten.length
      ? 'Deze producten staan al in de voorraad. Is het etiket een van deze, ' +
        'gebruik dan precies deze naam: ' + producten.join(' | ') + '. '
      : '') +
      (leveranciers.length
        ? 'Bekende leveranciers: ' + leveranciers.join(' | ') + '.'
        : '');

    const inhoud = [];
    beelden.forEach((b, i) => {
      inhoud.push({ type: 'text', text: 'Foto ' + (i + 1) + ':' });
      inhoud.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } });
    });
    inhoud.push({ type: 'text', text: 'Lees de etiketten en geef de partijen.' });

    const systeem = OPDRACHT.replace('{BEKEND}', bekend);

    let r = null, laatsteFout = '';
    for (const model of MODELLEN) {
      r = await vraagClaude(g.sleutel, model, systeem, inhoud);
      if (r.ok) break;
      const fout = await r.text().catch(() => '');
      laatsteFout = r.status + ' ' + fout.slice(0, 200);
      if (r.status === 401 || r.status === 403) {
        throw new HttpsError('permission-denied', 'Je Claude-sleutel wordt niet meer geaccepteerd.');
      }
      if (r.status === 429) {
        throw new HttpsError('resource-exhausted', 'Te veel tegelijk. Probeer het zo opnieuw.');
      }
      /* onbekend model of overbelast: probeer het volgende */
      if (r.status !== 404 && r.status !== 400 && r.status !== 529) break;
    }
    if (!r || !r.ok) throw new HttpsError('internal', 'Claude antwoordde met ' + laatsteFout);

    const uit = await r.json();
    const blokken = Array.isArray(uit.content) ? uit.content : [];
    const tekstUit = blokken.filter(x => x && x.type === 'text').map(x => x.text).join('\n');

    let o;
    try { o = leesJson(tekstUit); }
    catch (e) { throw new HttpsError('internal', 'Onleesbaar antwoord. Probeer een scherpere foto.'); }

    const partijen = (Array.isArray(o.partijen) ? o.partijen : [])
      .slice(0, 20).map(schonePartij).filter(p => p.product || p.lot || p.artikelcode);

    return { partijen, tip: tekst(o.tip, 140) };
  }
);
