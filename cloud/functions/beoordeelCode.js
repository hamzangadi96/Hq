/* ================== INDELEN TEGEN DE LIJST ==================

   beoordeelReeks vindt al waar de bruikbare stukken zitten en geeft er een
   vrij label aan. Deze functie doet het volgende: ze legt elk stuk naast
   Hamza's eigen lijst en geeft er een code uit.

   Waarom dat beter is dan een vrij label: op een code kun je rekenen. De
   reelbouwer weet dan of een shot mag openen (rol), hoe lang het in beeld
   hoort (duur), en of het uberhaupt bruikbaar is (klasse). Een vrij label
   als "handen bezig met chocolade" zegt niets van dat alles.

   Twee trappen, want de lijst is te groot om in een keer mee te sturen:

     trap 1  alleen de groepskoppen, ongeveer 35 regels
             "waar hoort dit bij?"          -> AK
     trap 2  alleen die ene groep, ongeveer 25 regels
             "welke precies?"               -> AK02

   Per aanroep ziet het model dus zestig regels in plaats van vijfhonderd.
   Daardoor kan de lijst blijven groeien zonder dat de indeling slechter wordt.

   De lijst staat in Firebase onder /werkvloer/{uid}/lijst, niet in deze
   functie. Anders zou je opnieuw moeten deployen voor elke regel die je
   goedkeurt, en dat houdt niemand vol. Is hij daar nog leeg, dan zet deze
   functie de meegeleverde startlijst er eenmalig neer. */

/* Dit bestand staat naast index.js en ziet dus niets uit dat bestand. Alles
   wat het nodig heeft haalt het zelf binnen — net als maakOndertitels.js. */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const STARTLIJST = require('./lijst.json');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CODE_MODEL = 'claude-haiku-4-5';
const MAXBEELDEN = 12;

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

/* ---------- de lijst ophalen en zo nodig aanleggen ---------- */

async function haalLijst(uid) {
  const ref = admin.database().ref('werkvloer/' + uid + '/lijst');
  const s = await ref.once('value');
  const v = s.val();
  if (v && Array.isArray(v.regels) && v.regels.length) return v;
  await ref.set(STARTLIJST);
  return STARTLIJST;
}

function groepenTekst(lijst) {
  return (lijst.groepen || [])
    .map(g => g.code + '  ' + g.naam)
    .join('\n');
}

function regelsTekst(lijst, groep) {
  return (lijst.regels || [])
    .filter(r => r.groep === groep)
    .map(r => {
      let s = r.code + '  ' + r.naam;
      if (r.klasse) s += '  [' + r.klasse;
      if (r.rol) s += ' / ' + r.rol;
      if (r.duur) s += ' / ' + r.duur[0] + '-' + r.duur[1] + ' s';
      if (r.klasse) s += ']';
      if (r.let_op) s += '  (' + r.let_op + ')';
      return s;
    })
    .join('\n');
}

/* ---------- de opdrachten ---------- */

const OPDRACHT_GROEP =
  'Je kijkt naar beelden uit een werkplaats van een chocolatier. Bij elk beeld ' +
  'hoort een tijdstip in seconden.\n\n' +
  'Kies per beeld de groep waar het bij hoort. Hieronder staan alle groepen:\n\n' +
  '{GROEPEN}\n\n' +
  'Groepen die met X beginnen zijn onbruikbaar beeld. Wees daar niet zuinig ' +
  'mee: camera pakken, schoonmaken, wachten en rondlopen horen daar echt thuis, ' +
  'ook als het beeld technisch prima is.\n\n' +
  'Weet je het niet, kies dan null in plaats van de best passende groep. Een ' +
  'gok is schadelijker dan een gat, want een verkeerde groep leidt in de ' +
  'volgende stap tot een verkeerde code.\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg en zonder markdown:\n' +
  '  { "beelden": [ { "t": 12.5, "groep": "AK" }, { "t": 18.0, "groep": null } ] }';

const OPDRACHT_CODE =
  'Je kijkt naar beelden uit een werkplaats van een chocolatier. Alle beelden ' +
  'horen bij groep {GROEP}: {GROEPNAAM}.\n\n' +
  'Kies per beeld de regel die er het beste bij past:\n\n' +
  '{REGELS}\n\n' +
  'Tussen blokhaken staat wat de maker ervan vindt: de klasse, de rol in een ' +
  'filmpje en hoe lang het in beeld hoort. Tussen ronde haken staat wanneer het ' +
  'alsnog niets waard is. Neem die voorwaarden serieus: staat er "zakt als: van ' +
  'te ver" en is het van te ver gefilmd, meld dat dan bij let_op.\n\n' +
  'Past geen enkele regel, verzin er dan geen. Geef in plaats daarvan:\n' +
  '  code      null\n' +
  '  onbekend  korte omschrijving in het Nederlands, maximaal zes woorden\n' +
  '  gok       welke klasse je zou geven: GOUD, BRUIK, TWIJFEL of WEG\n' +
  '  lijkt_op  de bestaande code die er het dichtst bij komt\n\n' +
  'Dat laatste is belangrijk: daarmee ziet de maker of het echt iets nieuws is ' +
  'of alleen een variant van iets wat er al staat.\n\n' +
  'Beoordeel daarnaast per beeld hoe het gefilmd is en wat je hoort:\n' +
  '  kader   een van: close, handen, boven, ooghoogte, halftotaal, te_ver, ' +
  'geblokkeerd, half_buiten_beeld, onrustig\n' +
  '  let_op  als een voorwaarde uit de ronde haken van toepassing is, anders ""\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg en zonder markdown:\n' +
  '  { "beelden": [ { "t": 12.5, "code": "AK02", "kader": "close", "let_op": "" } ] }';

/* ---------- antwoord uitpakken ---------- */

function leesJson(tekst) {
  const schoon = String(tekst || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const a = schoon.indexOf('{');
  const z = schoon.lastIndexOf('}');
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(schoon.slice(a, z + 1)); } catch (fout) { return null; }
}

async function vraagClaude(sleutel, opdracht, beelden) {
  const inhoud = [];
  beelden.forEach(b => {
    inhoud.push({ type: 'text', text: 't = ' + Number(b.t).toFixed(1) + ' s' });
    inhoud.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: String(b.data || '') }
    });
  });

  const r = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: claudeKoppen(sleutel),
    body: JSON.stringify({
      model: CODE_MODEL,
      max_tokens: 1200,
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
  return blokken.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
}

/* ---------- de functie ---------- */

exports.beoordeelCode = onCall(
  { region: 'europe-west1', timeoutSeconds: 120, memory: '512MiB' },
  async req => {
  const uid = wieBenJe(req);
  const d = req.data || {};

  const fase = d.fase === 'code' ? 'code' : 'groep';
  const beelden = Array.isArray(d.beelden) ? d.beelden.slice(0, MAXBEELDEN) : [];
  if (!beelden.length) throw new HttpsError('invalid-argument', 'Geen beeld ontvangen.');

  const g = await leesGeheim(uid, 'claude');
  if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

  const lijst = await haalLijst(uid);

  let opdracht;
  if (fase === 'groep') {
    opdracht = OPDRACHT_GROEP.replace('{GROEPEN}', groepenTekst(lijst));
  } else {
    const groep = String(d.groep || '').trim();
    const kop = (lijst.groepen || []).find(x => x.code === groep);
    if (!kop) throw new HttpsError('invalid-argument', 'Onbekende groep: ' + groep);
    const regels = regelsTekst(lijst, groep);
    if (!regels) throw new HttpsError('invalid-argument', 'Groep ' + groep + ' is leeg.');
    opdracht = OPDRACHT_CODE
      .replace('{GROEP}', groep)
      .replace('{GROEPNAAM}', kop.naam)
      .replace('{REGELS}', regels);
  }

  const tekst = await vraagClaude(g.sleutel, opdracht, beelden);
  const uit = leesJson(tekst);
  if (!uit || !Array.isArray(uit.beelden)) {
    throw new HttpsError('internal', 'Onleesbaar antwoord van Claude.');
  }

  /* Alles wat terugkomt naast de lijst leggen. Een model dat een code verzint
     die niet bestaat is erger dan een model dat niets weet: dan verwijst de
     app naar een regel die er niet is en klopt het cijfer nergens op. */
  const bekend = new Set((lijst.regels || []).map(r => r.code));
  const groepen = new Set((lijst.groepen || []).map(x => x.code));

  const beelden_uit = uit.beelden.map(b => {
    const rec = { t: Number(b.t) || 0 };
    if (fase === 'groep') {
      rec.groep = groepen.has(b.groep) ? b.groep : null;
      return rec;
    }
    if (b.code && bekend.has(b.code)) {
      rec.code = b.code;
      if (b.kader) rec.kader = String(b.kader).slice(0, 24);
      if (b.let_op) rec.let_op = String(b.let_op).slice(0, 120);
    } else if (b.onbekend) {
      rec.onbekend = {
        omschrijving: String(b.onbekend).slice(0, 80),
        gok: ['GOUD', 'BRUIK', 'TWIJFEL', 'WEG'].includes(b.gok) ? b.gok : 'TWIJFEL',
        lijkt_op: bekend.has(b.lijkt_op) ? b.lijkt_op : null
      };
    } else {
      rec.code = null;     // model gaf iets onbruikbaars terug
    }
    return rec;
  });

  return { fase, beelden: beelden_uit, lijstversie: lijst.versie || 0 };
});
