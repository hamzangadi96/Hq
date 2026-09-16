/* ================== REGIE ==================

   Stap twee van de nieuwe manier van werken in Studio. De clips zijn al
   bekeken door analyseerClip: van elke clip weten we wat erop staat, bij
   welk onderdeel van de werkdag hij hoort, hoe sterk hij is en wat Hamza
   zegt. Deze functie legt alles naast elkaar en maakt er een montageplan
   van: welke clips, in welke volgorde, en welk stuk uit elke clip.

   Hier geen beelden meer, alleen tekst. Daarom kan het een sterker model
   zijn dan bij het bekijken: het is denkwerk, en maar één aanvraag per video.

   Studio controleert het plan daarna nog zelf: zinnen heel houden en de
   lengte laten kloppen. Deze functie zorgt alleen dat wat terugkomt bruikbaar
   is: bestaande clips, geen dubbele, stukken die binnen de clip vallen.

   Dit bestand staat naast index.js en ziet niets uit dat bestand. */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const REGIE_MODEL = 'claude-sonnet-5';

const MAXCLIPS = 80;
const MINSTUK = 0.8;          // korter leest niet als shot

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

const SOORTEN = {
  vlog:
    'Vlog. Een persoonlijk verhaal van de dag. Stukken waarin hij praat zijn ' +
    'de ruggengraat: die vertellen het verhaal, de beelden ertussen laten zien ' +
    'waar hij het over heeft. Beelden zonder praten duren 2 tot 4 seconden. ' +
    'Een praatstuk mag langer duren, zolang de zinnen heel blijven.',
  reel:
    'Snelle reel. Het ambacht in beeld, strak op tempo. Gebruik vooral beelden ' +
    'zonder praten, elk 1,5 tot 3 seconden. Neem een praatstuk alleen mee als ' +
    'het kort is en echt iets toevoegt.'
};

const OPDRACHT =
  'Je bent de regisseur van Cacaoboetiek, een chocolatier die handgemaakte ' +
  'halal bonbons maakt. Van losse clips die de maker zelf heeft gefilmd en die ' +
  'al bekeken zijn, maak jij een montageplan voor een verticale video op TikTok.\n\n' +
  'Per clip krijg je: een id, de duur, wat er te zien is, bij welk onderdeel ' +
  'van de werkdag hij hoort, een cijfer voor hoe sterk het shot is, of hij een ' +
  'video kan openen, het sterkste stuk, wanneer hij is opgenomen ten opzichte ' +
  'van de andere clips, en wat hij zegt met tijdstippen.\n\n' +
  'De onderdelen van de werkdag, in volgorde:\n{FASES}\n\n' +
  'Soort video: {SOORT}\n\n' +
  'Regels:\n' +
  '1. De eerste twee seconden beslissen of iemand blijft kijken. Open met het ' +
  'sterkste shot dat een opener is. Is er geen opener, open dan met het ' +
  'hoogste cijfer. Dat shot komt later niet nog eens terug.\n' +
  '2. Vertel daarna het verhaal in de volgorde van de werkdag. Binnen een ' +
  'onderdeel volg je de opnamevolgorde. Spring niet terug in het proces: eerst ' +
  'vullen en daarna tempereren kan niet.\n' +
  '3. Eindig met het resultaat als dat er is.\n' +
  '4. Knip nooit midden in een zin. Gebruik je een stuk waarin hij praat, neem ' +
  'dan hele zinnen mee, van het begin van de eerste zin tot het eind van de ' +
  'laatste.\n' +
  '5. Knip niet midden in een handeling. Neem het sterkste stuk van een clip ' +
  'als uitgangspunt.\n' +
  '6. Zet geen twee clips achter elkaar die hetzelfde laten zien. Kies de ' +
  'sterkste en laat de andere weg.\n' +
  '7. Laat clips met een cijfer van 3 of lager weg, tenzij het verhaal zonder ' +
  'die clip niet klopt.\n' +
  '8. De totale lengte komt zo dicht mogelijk bij {DOEL} seconden en is nooit ' +
  'meer dan {MAX} seconden. Is er te weinig goed beeld, maak de video dan ' +
  'korter. Vul nooit op met slechte shots en gebruik geen clip twee keer.\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg eromheen en zonder ' +
  'markdown:\n' +
  '  plan    lijst in de volgorde van de video, elk item met:\n' +
  '            id   de id van de clip\n' +
  '            van  begin in seconden binnen die clip\n' +
  '            tot  eind in seconden binnen die clip\n' +
  '  uitleg  in maximaal twintig woorden hoe het verhaal loopt';

/* ---------- invoer ---------- */

const getal = (x, standaard) => {
  const n = Number(x);
  return isFinite(n) ? n : standaard;
};
const een = n => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');

function schoneClips(ruw) {
  const uit = [];
  const gezien = new Set();
  (Array.isArray(ruw) ? ruw : []).slice(0, MAXCLIPS).forEach(c => {
    const id = String((c && c.id) || '').trim().slice(0, 12);
    const duur = getal(c && c.duur, 0);
    if (!id || gezien.has(id) || !(duur > 0)) return;
    gezien.add(id);
    const sterkste = c.sterkste && isFinite(Number(c.sterkste.van)) && isFinite(Number(c.sterkste.tot))
      ? { van: Math.max(0, Number(c.sterkste.van)), tot: Math.min(duur, Number(c.sterkste.tot)) }
      : { van: 0, tot: duur };
    uit.push({
      id,
      duur: Math.min(3600, duur),
      wat: String(c.wat || '').trim().slice(0, 80),
      fase: String(c.fase || '').trim().slice(0, 24),
      cijfer: Math.max(1, Math.min(10, Math.round(getal(c.cijfer, 5)))),
      opener: c.opener === true,
      sterkste,
      zegt: String(c.zegt || '').trim().slice(0, 120),
      tijd: c.tijd == null ? null : Math.max(0, Math.round(getal(c.tijd, 0))),
      spraak: (Array.isArray(c.spraak) ? c.spraak : []).slice(0, 40).map(r => ({
        van: Math.max(0, getal(r && r.van, 0)),
        tot: Math.max(0, getal(r && r.tot, 0)),
        tekst: String((r && r.tekst) || '').trim().slice(0, 200)
      })).filter(r => r.tekst)
    });
  });
  return uit;
}

function clipRegels(c) {
  let s = c.id + ' | ' + een(c.duur) + ' s | ' + (c.fase || 'onbekend') +
          ' | cijfer ' + c.cijfer + ' | ' + (c.opener ? 'opener' : 'geen opener') +
          ' | sterkste ' + een(c.sterkste.van) + ' tot ' + een(c.sterkste.tot) +
          ' | opname ' + (c.tijd == null ? 'onbekend' : 'nummer ' + c.tijd);
  s += '\n   ziet: ' + (c.wat || 'onbekend');
  if (c.spraak.length) {
    s += '\n   zegt: ' + c.spraak
      .map(r => '[' + een(r.van) + ' tot ' + een(r.tot) + '] ' + r.tekst)
      .join(' ');
  } else {
    s += '\n   zegt: niets';
  }
  return s;
}

/* ---------- antwoord ---------- */

function leesJson(tekst) {
  const schoon = String(tekst || '').replace(/```json|```/g, '').trim();
  const van = schoon.indexOf('{');
  const tot = schoon.lastIndexOf('}');
  return JSON.parse(van >= 0 && tot > van ? schoon.slice(van, tot + 1) : schoon);
}

function schoonPlan(o, clips) {
  const perId = new Map(clips.map(c => [c.id, c]));
  const gebruikt = new Set();
  const plan = [];
  (Array.isArray(o && o.plan) ? o.plan : []).forEach(p => {
    const id = String((p && p.id) || '').trim();
    const c = perId.get(id);
    if (!c || gebruikt.has(id)) return;
    let van = Math.max(0, Math.min(c.duur, getal(p.van, 0)));
    let tot = Math.max(0, Math.min(c.duur, getal(p.tot, c.duur)));
    if (tot < van) { const x = van; van = tot; tot = x; }
    if (tot - van < MINSTUK) return;
    gebruikt.add(id);
    plan.push({ id, van: Math.round(van * 100) / 100, tot: Math.round(tot * 100) / 100 });
  });
  return {
    plan,
    uitleg: String((o && o.uitleg) || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  };
}

/* ---------- de functie ---------- */

exports.maakRegie = onCall(
  { region: 'europe-west1', timeoutSeconds: 120, memory: '256MiB' },
  async req => {
    const uid = wieBenJe(req);
    const d = req.data || {};

    const soort = SOORTEN[d.soort] ? d.soort : 'vlog';
    const doel = Math.max(10, Math.min(180, Math.round(getal(d.doel, 60))));
    const max = Math.round(doel * 1.1);

    const clips = schoneClips(d.clips);
    if (clips.length < 2) throw new HttpsError('invalid-argument', 'Minstens twee bekeken clips nodig.');

    const fases = (Array.isArray(d.fases) ? d.fases : []).slice(0, 24)
      .map(f => '  ' + String((f && f.code) || '').slice(0, 24) + '  ' + String((f && f.naam) || '').slice(0, 40))
      .filter(r => r.trim())
      .join('\n');

    const g = await leesGeheim(uid, 'claude');
    if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

    const systeem = OPDRACHT
      .replace('{FASES}', fases || '  onbekend')
      .replace('{SOORT}', SOORTEN[soort])
      .replace('{DOEL}', String(doel))
      .replace('{MAX}', String(max));

    const vraag = 'Doel: ' + doel + ' seconden, nooit meer dan ' + max + '.\n' +
                  'Samen hebben deze clips ' + Math.round(clips.reduce((s, c) => s + c.duur, 0)) +
                  ' seconden beeld.\n\n' + clips.map(clipRegels).join('\n\n');

    const r = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: claudeKoppen(g.sleutel),
      body: JSON.stringify({
        model: REGIE_MODEL,
        max_tokens: 3000,
        system: systeem,
        messages: [{ role: 'user', content: vraag }]
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

    const schoon = schoonPlan(oordeel, clips);
    if (schoon.plan.length < 2) {
      throw new HttpsError('internal', 'Claude kwam met te weinig bruikbare clips terug.');
    }
    return schoon;
  }
);
