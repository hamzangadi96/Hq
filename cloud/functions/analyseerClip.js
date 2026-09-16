/* ================== CLIP BEKIJKEN ==================

   Voor de nieuwe manier van werken in Studio: Hamza knipt zijn clips zelf en
   zet ze erin. Deze functie bekijkt één clip en vertelt drie dingen terug:
   wat er gebeurt, bij welk onderdeel van het werk het hoort, en hoe sterk het
   shot is. Daarmee kan de regie later een logische video bouwen.

   Studio stuurt mee:
     beelden  een paar beelden verspreid over de clip, elk met een tijdstip
     duur     hoe lang de clip is
     spraak   wat hij zegt, als hij praat (uit de ondertitelmotor)
     fases    de onderdelen waaruit gekozen mag worden

   De onderdelen komen uit de app, niet uit dit bestand. Wil je er een
   toevoegen of een naam veranderen, dan hoef je hier niets opnieuw uit te
   rollen.

   Dit bestand staat naast index.js en ziet niets uit dat bestand. Alles wat
   het nodig heeft haalt het zelf binnen, net als beoordeelCode.js. */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLIP_MODEL = 'claude-haiku-4-5';

const MAXBEELDEN = 8;
const MAXBEELDGROOTTE = 600000;   // base64-tekens per beeld, ruim boven wat Studio stuurt
const MAXFASES = 24;
const MAXSPRAAK = 40;

function wieBenJe(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
  return uid;
}

async function leesGeheim(uid, welke) {
  const s = await admin.database().ref('geheim/' + uid + '/' + welke).once('value');
  return s.val() || null;
}

function claudeKoppen(sleutel) {
  return {
    'content-type': 'application/json',
    'x-api-key': sleutel,
    'anthropic-version': '2023-06-01'
  };
}

const OPDRACHT =
  'Je bent de monteur van Cacaoboetiek, een chocolatier die handgemaakte ' +
  'bonbons maakt en daar korte verticale video\'s over post. Je krijgt beelden ' +
  'uit een clip die de maker zelf al heeft uitgeknipt. Elk beeld heeft een ' +
  'tijdstip in seconden. Soms krijg je ook wat hij in de clip zegt.\n\n' +
  'Beschrijf wat er gebeurt en deel de clip in bij precies een onderdeel uit ' +
  'deze lijst:\n{FASES}\n\n' +
  'Wat je ziet gaat voor. Wat hij zegt mag helpen, maar zegt hij "nu gaan we ' +
  'vullen" terwijl je hem ziet tempereren, dan is het tempereren. Praat hij in ' +
  'de camera zonder dat er een handeling te zien is, kies dan vertellen. ' +
  'Twijfel je tussen twee onderdelen, kies dan het onderdeel waar de handeling ' +
  'het meest op lijkt. Kies overig alleen als het echt nergens bij past.\n\n' +
  'Wees streng met het cijfer en durf te onderscheiden. Een 9 of 10 open je ' +
  'een video mee zonder te aarzelen: scherp, goed in beeld, een duidelijke ' +
  'handeling of een mooi product. Een 5 of 6 is bruikbaar vulmateriaal. Onder ' +
  'de 4 is onscherp, te donker, schokkerig, of er gebeurt niets.\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg eromheen en zonder ' +
  'markdown, met deze sleutels:\n' +
  '  wat       wat er te zien is, in het Nederlands, maximaal acht woorden, ' +
  'bijvoorbeeld "spuit karamel in chocoladeschelpen"\n' +
  '  fase      de code van het onderdeel uit de lijst\n' +
  '  cijfer    hoe sterk dit shot is voor een video, 1 tot 10\n' +
  '  opener    true als dit shot een video kan openen: in de eerste seconde ' +
  'duidelijk en pakkend, anders false\n' +
  '  sterkste  het sterkste stuk binnen de clip als {"van": getal, "tot": getal} ' +
  'in seconden, minstens een seconde lang\n' +
  '  zegt      praat hij, dan in maximaal twaalf woorden waar het over gaat, ' +
  'anders een lege tekst';

/* ---------- invoer nakijken ---------- */

function schoneFases(ruw) {
  const uit = [];
  const gezien = new Set();
  (Array.isArray(ruw) ? ruw : []).slice(0, MAXFASES).forEach(f => {
    const code = String((f && f.code) || '').trim().toLowerCase().slice(0, 24);
    if (!code || !/^[a-z0-9_-]+$/.test(code) || gezien.has(code)) return;
    gezien.add(code);
    uit.push({
      code,
      naam: String(f.naam || code).trim().slice(0, 40),
      uitleg: String(f.uitleg || '').trim().slice(0, 200)
    });
  });
  return uit;
}

function schoneBeelden(ruw, duur) {
  return (Array.isArray(ruw) ? ruw : [])
    .slice(0, MAXBEELDEN)
    .map(b => ({
      t: Math.max(0, Math.min(duur || 9999, Number(b && b.t) || 0)),
      data: String((b && b.data) || '')
    }))
    .filter(b => b.data.length > 100 && b.data.length < MAXBEELDGROOTTE);
}

function schoneSpraak(ruw) {
  return (Array.isArray(ruw) ? ruw : [])
    .slice(0, MAXSPRAAK)
    .map(r => ({
      van: Number(r && r.van) || 0,
      tot: Number(r && r.tot) || 0,
      tekst: String((r && r.tekst) || '').trim().slice(0, 200)
    }))
    .filter(r => r.tekst);
}

/* ---------- antwoord nakijken ----------

   Het model hoort zich aan de afspraak te houden, maar we rekenen er niet op.
   Alles wat terugkomt wordt teruggebracht naar wat kan: een bestaande code,
   een cijfer tussen 1 en 10, een stuk binnen de clip. */

function leesJson(tekst) {
  const schoon = String(tekst || '').replace(/```json|```/g, '').trim();
  const van = schoon.indexOf('{');
  const tot = schoon.lastIndexOf('}');
  return JSON.parse(van >= 0 && tot > van ? schoon.slice(van, tot + 1) : schoon);
}

function schoonOordeel(o, fases, duur) {
  const codes = fases.map(f => f.code);
  let fase = String((o && o.fase) || '').trim().toLowerCase();
  if (!codes.includes(fase)) fase = codes.includes('overig') ? 'overig' : codes[codes.length - 1];

  let cijfer = Math.round(Number(o && o.cijfer));
  if (!isFinite(cijfer)) cijfer = 5;
  cijfer = Math.max(1, Math.min(10, cijfer));

  const lengte = duur > 0 ? duur : 0;
  let sterkste = null;
  if (o && o.sterkste && lengte > 0) {
    let a = Math.max(0, Math.min(lengte, Number(o.sterkste.van)));
    let b = Math.max(0, Math.min(lengte, Number(o.sterkste.tot)));
    if (isFinite(a) && isFinite(b) && b > a) {
      if (b - a < 1) {
        // te kort om te gebruiken: ruimer maken, zonder buiten de clip te gaan
        const midden = (a + b) / 2;
        a = Math.max(0, midden - .5);
        b = Math.min(lengte, a + 1);
      }
      sterkste = { van: Math.round(a * 10) / 10, tot: Math.round(b * 10) / 10 };
    }
  }
  if (!sterkste && lengte > 0) sterkste = { van: 0, tot: Math.round(lengte * 10) / 10 };

  return {
    wat: String((o && o.wat) || '').replace(/\s+/g, ' ').trim().slice(0, 70),
    fase,
    cijfer,
    opener: o && o.opener === true,
    sterkste,
    zegt: String((o && o.zegt) || '').replace(/\s+/g, ' ').trim().slice(0, 110)
  };
}

/* ---------- de functie ---------- */

exports.analyseerClip = onCall(
  { region: 'europe-west1', timeoutSeconds: 60, memory: '256MiB' },
  async req => {
    const uid = wieBenJe(req);
    const d = req.data || {};

    const duur = Math.max(0, Math.min(3600, Number(d.duur) || 0));
    const fases = schoneFases(d.fases);
    if (!fases.length) throw new HttpsError('invalid-argument', 'Geen onderdelen meegegeven.');

    const beelden = schoneBeelden(d.beelden, duur);
    if (!beelden.length) throw new HttpsError('invalid-argument', 'Geen beeld ontvangen.');

    const spraak = schoneSpraak(d.spraak);

    const g = await leesGeheim(uid, 'claude');
    if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

    const inhoud = [];
    inhoud.push({
      type: 'text',
      text: 'Deze clip duurt ' + duur.toFixed(1) + ' seconden.'
    });
    beelden.forEach(b => {
      inhoud.push({ type: 'text', text: 't = ' + b.t.toFixed(1) + ' s' });
      inhoud.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b.data }
      });
    });
    if (spraak.length) {
      inhoud.push({
        type: 'text',
        text: 'Wat hij zegt:\n' + spraak
          .map(r => '[' + r.van.toFixed(1) + ' tot ' + r.tot.toFixed(1) + ' s] ' + r.tekst)
          .join('\n')
      });
    } else {
      inhoud.push({ type: 'text', text: 'Er is geen spraak verstaan in deze clip.' });
    }

    const lijst = fases
      .map(f => '  ' + f.code + '  ' + f.naam + (f.uitleg ? ': ' + f.uitleg : ''))
      .join('\n');

    const r = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: claudeKoppen(g.sleutel),
      body: JSON.stringify({
        model: CLIP_MODEL,
        max_tokens: 500,
        system: OPDRACHT.replace('{FASES}', lijst),
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

    let oordeel;
    try {
      oordeel = leesJson(tekst);
    } catch (fout) {
      throw new HttpsError('internal', 'Onleesbaar antwoord van Claude.');
    }

    return schoonOordeel(oordeel, fases, duur);
  }
);
