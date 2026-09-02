/* ================== ONDERTITELS ==================

   Los bestand, zodat je het naast index.js kunt neerzetten in plaats van
   erin te plakken. Onderaan index.js staat één regel die het binnenhaalt.

   Studio stuurt het geluid van één clip als wav mee: mono, zestienduizend
   metingen per seconde, ongecomprimeerd. Dat is wat Google's spraakmotor wil
   en het is klein genoeg om in één keer te versturen.

   We vragen om tijdstempels per woord. Losse woorden zijn onleesbaar als
   ondertitel, dus we plakken ze hier tot regels, en we breken af op een punt,
   dan op een adempauze, en pas als laatste op de bovengrens.

   Er is geen aparte sleutel nodig. De functie draait onder het serviceaccount
   van je eigen project en vraagt daar zelf een token voor op. De Speech-to-Text
   API moet wel aanstaan in de Google Cloud console. */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { GoogleAuth } = require('google-auth-library');

function wieBenJe(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
  return uid;
}

const SPRAAK_URL = 'https://speech.googleapis.com/v1/speech:recognize';
const MAXWOORDEN = 6;        // harde bovengrens per ondertitelregel
const MAXREGEL = 2.6;        // seconden per ondertitelregel
const ADEM = 0.35;           // stilte tussen twee woorden die een regel afsluit
const MAXGELUID = 9000000;   // ruwe bytes; hierboven weigert de synchrone motor

const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

function seconden(t) {
  // Google levert "1.200s" of soms { seconds, nanos }
  if (t == null) return 0;
  if (typeof t === 'string') return parseFloat(t) || 0;
  return (Number(t.seconds) || 0) + (Number(t.nanos) || 0) / 1e9;
}

/* Een ondertitel moet lezen als een zin, niet als vier losse woorden. Dus
   breken we in deze volgorde af: op een punt, dan op een adempauze in de
   spraak, en pas als laatste op de harde bovengrens. Zo begint een regel nooit
   met het slot van de vorige zin. */
function totRegels(woorden) {
  const uit = [];
  let nu = null;

  for (let i = 0; i < woorden.length; i++) {
    const tekst = String(woorden[i].word || '').trim();
    if (!tekst) continue;
    const van = seconden(woorden[i].startTime);
    const tot = seconden(woorden[i].endTime);

    if (!nu) nu = { van, tot, woorden: [] };
    nu.woorden.push(tekst);
    nu.tot = tot;

    const volgende = woorden[i + 1];
    const gat = volgende ? seconden(volgende.startTime) - tot : Infinity;

    const zin = /[.!?]$/.test(tekst);
    const adem = gat > ADEM && nu.woorden.length >= 2;
    const vol = nu.woorden.length >= MAXWOORDEN || (nu.tot - nu.van) >= MAXREGEL;

    if (zin || adem || vol) { uit.push(nu); nu = null; }
  }
  if (nu) uit.push(nu);

  return uit.map(r => ({
    van: Math.round(r.van * 100) / 100,
    tot: Math.round(Math.max(r.tot, r.van + .4) * 100) / 100,
    tekst: r.woorden.join(' ')
  }));
}

exports.maakOndertitels = onCall(
  { region: 'europe-west1', timeoutSeconds: 120, memory: '512MiB' },
  async req => {
  wieBenJe(req);
  const d = req.data || {};

  const geluid = String(d.geluid || '');
  if (!geluid) throw new HttpsError('invalid-argument', 'Geen geluid ontvangen.');
  if (geluid.length * 0.75 > MAXGELUID) {
    throw new HttpsError('invalid-argument', 'Dit stuk is te lang om in één keer te verstaan.');
  }

  const hz = Number(d.hz) || 16000;
  const taal = String(d.taal || 'nl-NL');

  /* Woorden waar de motor extra op moet letten. Zonder dit maakt hij van
     "ganache" een "gasnacht" en van "couverture" iets onherkenbaars. Een
     te hoge nadruk gaat woorden verzinnen die er niet staan, dus twaalf. */
  const woorden = (Array.isArray(d.woorden) ? d.woorden : [])
    .map(w => String(w || '').trim())
    .filter(w => w.length > 1 && w.length < 100)
    .slice(0, 400);

  let token;
  try {
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    token = t && (t.token || t);
  } catch (fout) {
    throw new HttpsError('internal', 'Kon geen toegang krijgen tot de spraakmotor.');
  }

  let antwoord;
  try {
    antwoord = await fetch(SPRAAK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: hz,
          audioChannelCount: 1,
          languageCode: taal,
          enableWordTimeOffsets: true,
          enableAutomaticPunctuation: true,
          // 'latest_short' is gemaakt voor korte fragmenten en verstaat
          // spreektaal beter dan het algemene model
          model: 'latest_short',
          speechContexts: woorden.length ? [{ phrases: woorden, boost: 12 }] : undefined
        },
        audio: { content: geluid }
      })
    });
  } catch (fout) {
    throw new HttpsError('unavailable', 'De spraakmotor is niet bereikbaar.');
  }

  if (!antwoord.ok) {
    const tekst = await antwoord.text().catch(() => '');
    if (antwoord.status === 403) {
      throw new HttpsError('failed-precondition',
        'Zet de Speech-to-Text API aan in je Google Cloud console.');
    }
    throw new HttpsError('internal',
      'Verstaan mislukt (' + antwoord.status + ') ' + tekst.slice(0, 160));
  }

  const uit = await antwoord.json().catch(() => ({}));
  const verstaan = [];
  (uit.results || []).forEach(r => {
    const eerste = (r.alternatives || [])[0];
    if (eerste && Array.isArray(eerste.words)) eerste.words.forEach(w => verstaan.push(w));
  });

  return { regels: totRegels(verstaan) };
  });
