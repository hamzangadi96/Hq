/* ═══════════════════════════════════════════════════════════════════
   Bedrijfsgegevens van een screenshot lezen — voor de factuur bij een
   betaallink. Claude leest naam, adres, KvK, btw-id en contact van de
   klant. Niets wordt bewaard: het antwoord gaat alleen terug naar de app.
   Dezelfde Claude-sleutel als de rest (geheim/<uid>/claude).
   ═══════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODELLEN = ['claude-sonnet-5-5', 'claude-haiku-4-5'];

const OPDRACHT =
  'Je leest bedrijfsgegevens van een klant van Cacaoboetiek van een screenshot of foto ' +
  '(bijvoorbeeld een KvK-uittreksel, een mailhandtekening, een website of een factuur). ' +
  'Let op: Cacaoboetiek zelf (Alcoalaan 8D, Drunen, KvK 93971818) is NIET de klant; ' +
  'neem die gegevens nooit over.\n\n' +
  'Verzin niets. Wat je niet zeker kunt lezen, laat je leeg.\n\n' +
  'Antwoord met alleen een JSON-object, zonder uitleg en zonder markdown:\n' +
  '{"naam": statutaire naam of handelsnaam zoals op de factuur hoort,\n' +
  ' "tav": contactpersoon als die er duidelijk bij staat, anders "",\n' +
  ' "straat": straat en huisnummer (of postbus), of "",\n' +
  ' "postcode": bijvoorbeeld "5151 RW", of "",\n' +
  ' "plaats": plaatsnaam, of "",\n' +
  ' "land": alleen invullen als het niet Nederland is,\n' +
  ' "kvk": 8 cijfers, of "",\n' +
  ' "btw": btw-id zonder spaties (bijv. NL123456789B01), of "",\n' +
  ' "mail": mailadres, of "",\n' +
  ' "tel": telefoonnummer, of ""}\n' +
  'Bij een KvK-uittreksel: neem het bezoekadres, tenzij er een apart postadres staat ' +
  'voor correspondentie; dan dat postadres.';

const tekst = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max || 120);

exports.leesBedrijf = onCall(
  { region: 'europe-west1', timeoutSeconds: 60, memory: '256MiB' },
  async req => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Log eerst in.');
    let foto = String((req.data || {}).foto || '');
    let soort = 'image/jpeg';
    const m = foto.match(/^data:(image\/[a-z]+);base64,/);
    if (m) { soort = m[1]; foto = foto.slice(m[0].length); }
    if (!foto || foto.length > 2000000) throw new HttpsError('invalid-argument', 'Geen (of te grote) foto ontvangen.');

    const g = (await admin.database().ref('geheim/' + uid + '/claude').once('value')).val();
    if (!g || !g.sleutel) throw new HttpsError('failed-precondition', 'Koppel eerst je Claude-sleutel.');

    const inhoud = [
      { type: 'image', source: { type: 'base64', media_type: soort, data: foto } },
      { type: 'text', text: 'Lees de bedrijfsgegevens van de klant.' }
    ];
    let r = null, laatste = '';
    for (const model of MODELLEN) {
      r = await fetch(CLAUDE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.sleutel, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 600, system: OPDRACHT, messages: [{ role: 'user', content: inhoud }] })
      });
      if (r.ok) break;
      laatste = r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200);
      if (r.status === 401 || r.status === 403) throw new HttpsError('permission-denied', 'Je Claude-sleutel wordt niet meer geaccepteerd.');
      if (r.status === 429) throw new HttpsError('resource-exhausted', 'Te veel tegelijk. Probeer het zo opnieuw.');
      if (r.status !== 404 && r.status !== 400 && r.status !== 529) break;
    }
    if (!r || !r.ok) throw new HttpsError('internal', 'Claude antwoordde met ' + laatste);

    const uit = await r.json();
    const t = (uit.content || []).filter(x => x && x.type === 'text').map(x => x.text).join('\n');
    let j;
    try {
      const s = t.replace(/```json|```/g, '').trim();
      j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    } catch (e) { throw new HttpsError('internal', 'Kon de screenshot niet lezen. Probeer een scherpere.'); }

    const kvk = tekst(j.kvk).replace(/\D/g, '');
    return {
      naam: tekst(j.naam), tav: tekst(j.tav), straat: tekst(j.straat), postcode: tekst(j.postcode, 12).toUpperCase(),
      plaats: tekst(j.plaats, 60), land: tekst(j.land, 40),
      kvk: kvk.length === 8 && kvk !== '93971818' ? kvk : '',
      btw: tekst(j.btw, 20).replace(/[\s.]/g, '').toUpperCase(),
      mail: tekst(j.mail, 80), tel: tekst(j.tel, 30)
    };
  });
