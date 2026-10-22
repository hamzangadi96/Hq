/* ═══════════════════════════════════════════════════════════════════
   Mail — info@cacaoboetiek.nl via Strato (IMAP + SMTP)

   AVG: niets van je mail komt in de database. De lijst en de mails zelf
   worden per keer bij Strato opgehaald en alleen naar de app gestuurd.
   In de database staat alleen je adres en wachtwoord, onder geheim/,
   waar de app zelf niet bij kan.
   ═══════════════════════════════════════════════════════════════════ */

const { HttpsError } = require('firebase-functions/v2/https');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');

const IMAP = { host: 'imap.strato.de', port: 993, secure: true };
const SMTP = { host: 'smtp.strato.de', port: 465, secure: true };

function imapVoor(g) {
  return new ImapFlow(Object.assign({}, IMAP, {
    auth: { user: g.adres, pass: g.wachtwoord },
    logger: false, emitLogs: false, socketTimeout: 30000
  }));
}

/* inloggen, iets doen, altijd netjes uitloggen */
async function metImap(g, doe) {
  const c = imapVoor(g);
  try {
    await c.connect();
  } catch (e) {
    const t = String((e && (e.responseText || e.message)) || e);
    if (/auth|login|credentials|password/i.test(t))
      throw new HttpsError('permission-denied', 'Strato weigert de inlog. Klopt het wachtwoord van info@?');
    throw new HttpsError('unavailable', 'Strato is niet bereikbaar: ' + t.slice(0, 120));
  }
  try { return await doe(c); }
  finally { try { await c.logout(); } catch (e) { /* al weg */ } }
}

async function testInlog(adres, wachtwoord) {
  await metImap({ adres, wachtwoord }, async () => true);
  const t = nodemailer.createTransport(Object.assign({}, SMTP, { auth: { user: adres, pass: wachtwoord } }));
  try { await t.verify(); }
  catch (e) { throw new HttpsError('permission-denied', 'Ophalen lukt, versturen niet: ' + String(e.message || e).slice(0, 120)); }
}

const kortAdres = a => (a && a[0]) ? { naam: a[0].name || '', adres: (a[0].address || '').toLowerCase() } : { naam: '', adres: '' };

/* de laatste mails in je inbox, alleen kop en vlaggen */
async function lijst(g, aantal) {
  return metImap(g, async c => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const tot = c.mailbox.exists || 0;
      if (!tot) return [];
      const van = Math.max(1, tot - aantal + 1);
      const uit = [];
      for await (const m of c.fetch(van + ':*', { uid: true, envelope: true, flags: true, internalDate: true })) {
        const v = kortAdres(m.envelope.from);
        uit.push({
          uid: m.uid, van: v.naam || v.adres, adres: v.adres,
          onderwerp: m.envelope.subject || '(geen onderwerp)',
          datum: (m.internalDate || m.envelope.date || new Date()).getTime(),
          gelezen: m.flags.has('\\Seen'), beantwoord: m.flags.has('\\Answered')
        });
      }
      return uit.sort((a, b) => b.datum - a.datum);
    } finally { lock.release(); }
  });
}

/* één mail volledig, als platte tekst; markeert hem als gelezen */
async function lees(g, uid) {
  return metImap(g, async c => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!m) throw new HttpsError('not-found', 'Deze mail staat niet meer in je inbox.');
      const p = await simpleParser(m.source);
      await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const v = kortAdres(p.from && p.from.value ? p.from.value.map(x => ({ name: x.name, address: x.address })) : []);
      let tekst = (p.text || '').replace(/\r/g, '');
      if (!tekst && p.html) tekst = String(p.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
      return {
        uid, van: v.naam || v.adres, adres: v.adres, onderwerp: p.subject || '(geen onderwerp)',
        datum: (p.date || new Date()).getTime(), tekst: tekst.trim().slice(0, 20000),
        messageId: p.messageId || '', references: [].concat(p.references || []),
        bijlagen: (p.attachments || []).map(a => a.filename || 'bijlage'),
        beantwoord: m.flags.has('\\Answered')
      };
    } finally { lock.release(); }
  });
}

/* antwoord versturen, in Verzonden zetten en het origineel als beantwoord markeren */
async function verstuur(g, mail, tekst) {
  const onderwerp = /^re:/i.test(mail.onderwerp) ? mail.onderwerp : 'Re: ' + mail.onderwerp;
  const refs = mail.references.concat(mail.messageId ? [mail.messageId] : []).filter(Boolean);
  const opts = {
    from: { name: 'Cacaoboetiek', address: g.adres },
    to: mail.adres, subject: onderwerp, text: tekst,
    inReplyTo: mail.messageId || undefined, references: refs.length ? refs.join(' ') : undefined
  };
  const t = nodemailer.createTransport(Object.assign({}, SMTP, { auth: { user: g.adres, pass: g.wachtwoord } }));
  await t.sendMail(opts);
  const ruw = await new MailComposer(Object.assign({ date: new Date() }, opts)).compile().build();
  await metImap(g, async c => {
    try {
      const mappen = await c.list();
      const verz = mappen.find(m => m.specialUse === '\\Sent')
        || mappen.find(m => /^(sent|verzonden|gesendet|gesendete objekte)/i.test(m.name));
      if (verz) await c.append(verz.path, ruw, ['\\Seen']);
    } catch (e) { /* versturen is gelukt; Verzonden is bijzaak */ }
    const lock = await c.getMailboxLock('INBOX');
    try { await c.messageFlagsAdd(String(mail.uid), ['\\Answered'], { uid: true }); }
    finally { lock.release(); }
  });
  return { ok: true };
}

module.exports = { testInlog, lijst, lees, verstuur };
