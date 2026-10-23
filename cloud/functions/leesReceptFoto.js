/* ═══════════════════════════════════════════════════════════════════
   Receptfoto lezen — je schrift in HQ zonder overtikken

   De app stuurt één tot vier foto's van een receptpagina (handgeschreven
   of geprint). Claude haalt er de lagen uit (schelp, ganache, karamel…)
   met per laag de ingrediënten en hun grammen. Staan er meerdere recepten
   op een pagina, dan komen ze allemaal terug en kies je in de app.

   Zelfde regel als bij etiketten: niets verzinnen. Een getal dat niet te
   lezen is blijft leeg en komt amber in beeld.
   ═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODELLEN = ['claude-sonnet-5-5', 'claude-haiku-4-5'];
const MAXBEELDEN = 4;
const MAXBEELDGROOTTE = 1400000;

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
  'Je leest receptpagina\'s van een chocolatier die bonbons maakt. De pagina is ' +
  'vaak handgeschreven, soms met doorhalingen of pijlen. Een bonbon bestaat uit ' +
  'lagen: meestal een schelp van chocolade, en vullingen zoals ganache, karamel, ' +
  'gelei, praliné of crunch.\n\n' +
  'Haal per recept de lagen eruit, met per laag de ingrediënten en hoeveel gram. ' +
  'Gebruik voor de laagnaam bij voorkeur een van: Schelp, Ganache, Karamel, Gelei, ' +
  'Praliné, Crunch. Past geen van die, gebruik dan het woord van de pagina.\n\n' +
  'Het allerbelangrijkste: verzin niets. Kun je een getal of woord niet zeker lezen, ' +
  'laat het getal dan null en zet de naam in "twijfel" van die laag. Doorgehaalde ' +
  'regels laat je weg; staat er een verbeterd getal naast, neem dat.\n\n' +
  'Hoeveelheden: altijd in gram. Kilo maal 1000; ml en liter tellen als gram. ' +
  'Staat er geen eenheid, ga dan uit van gram. Een snufje of "naar smaak" geeft null.\n\n' +
  'Ingrediëntnamen: kort, in het Nederlands, met een hoofdletter. {BEKEND}\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg en zonder markdown:\n' +
  '{\n' +
  '  "recepten": [\n' +
  '    {\n' +
  '      "titel": naam van het recept zoals op de pagina, of "",\n' +
  '      "lagen": [\n' +
  '        {\n' +
  '          "naam":    laagnaam,\n' +
  '          "gram":    gram per bonbon als dat er staat, anders null,\n' +
  '          "ing":     [{"naam": ingrediënt, "gram": getal of null}],\n' +
  '          "twijfel": lijst ingrediëntnamen waar je niet zeker van bent\n' +
  '        }\n' +
  '      ]\n' +
  '    }\n' +
  '  ],\n' +
  '  "tip": één korte zin als een foto onleesbaar is, anders ""\n' +
  '}';

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

function leesJson(tekst) {
  const schoon = String(tekst || '').replace(/```json|```/g, '').trim();
  const van = schoon.indexOf('{');
  const tot = schoon.lastIndexOf('}');
  return JSON.parse(van >= 0 && tot > van ? schoon.slice(van, tot + 1) : schoon);
}

const tekst = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);
function getal(x, max) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(String(x).replace(',', '.'));
  return isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null;
}

function schoonRecept(r) {
  r = r || {};
  const lagen = (Array.isArray(r.lagen) ? r.lagen : []).slice(0, 8).map(l => {
    l = l || {};
    const twijfel = schoneLijst(l.twijfel, 30, 60);
    const ing = (Array.isArray(l.ing) ? l.ing : []).slice(0, 30)
      .map(i => ({ naam: tekst(i && i.naam, 60), gram: getal(i && i.gram, 100000) }))
      .filter(i => i.naam);
    return { naam: tekst(l.naam, 40), gram: getal(l.gram, 50), ing, twijfel };
  }).filter(l => l.naam && l.ing.length);
  return { titel: tekst(r.titel, 80), lagen };
}

exports.leesReceptFoto = onCall(
  { region: 'europe-west1', timeoutSeconds: 90, memory: '256MiB' },
  async req => {
    const uid = wieBenJe(req);
    const d = req.data || {};

    const beelden = schoneBeelden(d.beelden);
    /* v866: ook een getypt of ingesproken recept (dan geen foto's) */
    const getypt = String(d.tekst || '').trim().slice(0, 4000);
    if (!beelden.length && getypt.length < 4) throw new HttpsError('invalid-argument', 'Geen foto of tekst ontvangen.');

    const g = await leesGeheim(uid, 'claude');
    if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

    const ingredienten = schoneLijst(d.ingredienten, 400, 60);
    const bekend = ingredienten.length
      ? 'Deze ingrediënten heeft de maker al. Bedoelt de pagina een van deze, ' +
        'gebruik dan precies deze naam: ' + ingredienten.join(' | ') + '.'
      : '';
    const smaak = tekst(d.smaak, 80);

    const inhoud = [];
    beelden.forEach((b, i) => {
      inhoud.push({ type: 'text', text: 'Foto ' + (i + 1) + ':' });
      inhoud.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } });
    });
    if (getypt) inhoud.push({ type: 'text', text:
      'Geen foto: de maker typte of sprak dit recept in (spraak kan rare woorden of ' +
      'getallen als woorden geven, zoals "honderd" = 100). Lees het als receptpagina:\n\n' + getypt });
    inhoud.push({ type: 'text', text: smaak
      ? 'De maker zoekt het recept voor de smaak "' + smaak + '". Geef alle recepten op de pagina.'
      : 'Geef alle recepten op de pagina.' });

    const systeem = OPDRACHT.replace('{BEKEND}', bekend);
    let r = null, laatsteFout = '';
    for (const model of MODELLEN) {
      r = await fetch(CLAUDE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.sleutel, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 3000, system: systeem, messages: [{ role: 'user', content: inhoud }] })
      });
      if (r.ok) break;
      const fout = await r.text().catch(() => '');
      laatsteFout = r.status + ' ' + fout.slice(0, 200);
      if (r.status === 401 || r.status === 403) throw new HttpsError('permission-denied', 'Je Claude-sleutel wordt niet meer geaccepteerd.');
      if (r.status === 429) throw new HttpsError('resource-exhausted', 'Te veel tegelijk. Probeer het zo opnieuw.');
      if (r.status !== 404 && r.status !== 400 && r.status !== 529) break;
    }
    if (!r || !r.ok) throw new HttpsError('internal', 'Claude antwoordde met ' + laatsteFout);

    const uit = await r.json();
    const t = (Array.isArray(uit.content) ? uit.content : []).filter(x => x && x.type === 'text').map(x => x.text).join('\n');
    let o;
    try { o = leesJson(t); }
    catch (e) { throw new HttpsError('internal', 'Onleesbaar antwoord. Probeer een scherpere foto.'); }

    const recepten = (Array.isArray(o.recepten) ? o.recepten : []).slice(0, 10)
      .map(schoonRecept).filter(x => x.lagen.length);
    return { recepten, tip: tekst(o.tip, 140) };
  }
);
