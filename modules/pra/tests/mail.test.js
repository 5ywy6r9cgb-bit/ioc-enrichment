'use strict';
/**
 * tests/mail.test.js
 *
 * No network, no mail server, no installed mail library. The transport is
 * injected, which is the point: the interesting behaviour is what gets sent
 * and what gets refused, and neither needs SMTP to test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const M = require('../server/mail.js');
const { Outbox } = require('../server/outbox.js');

const LETTER = 'To whom it may concern,\n\nThis follows up on the above public '
  + 'records request. Please provide a status update at your earliest convenience.\n\nThank you,';

function tmpOutbox() {
  return new Outbox(path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mail-')), 'outbox.json'));
}

/** A transport that records rather than sends. */
function fakeTransport(behaviour = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      if (behaviour.throwOn && behaviour.throwOn(m)) throw new Error('SMTP 550 rejected');
      sent.push(m);
      return { messageId: `<${sent.length}@test>`, accepted: [m.to] };
    },
  };
}

const CFG = {
  address: 'records@example.org', fromName: 'Mark W. Rosenburg',
  user: 'records@example.org', pass: 'app-specific',
  smtpHost: 'smtp.example.org', smtpPort: 587,
  imapHost: 'imap.example.org', imapPort: 993, mailbox: 'INBOX',
  maxPerRun: 5,
};

module.exports = async function run() {
  H.suite('mail');

  // ══ presets, so nobody types four hostnames ═══════════════════════════
  {
    const c = M.config({ PRA_MAIL_ADDRESS: 'records@icloud.com', PRA_MAIL_PASSWORD: 'x' });
    H.eq('an icloud address fills in SMTP', c.smtpHost, 'smtp.mail.me.com');
    H.eq('and IMAP', c.imapHost, 'imap.mail.me.com');
    H.eq('gmail too',
      M.config({ PRA_MAIL_ADDRESS: 'a@gmail.com' }).smtpHost, 'smtp.gmail.com');
    H.check('an unknown domain leaves the hosts empty rather than guessing',
      M.config({ PRA_MAIL_ADDRESS: 'a@some-agency.oh.us' }).smtpHost === '');
    H.check('and checkConfig then names what is missing',
      M.checkConfig(M.config({ PRA_MAIL_ADDRESS: 'a@x.io' }))
        .some((s) => /PRA_SMTP_HOST/.test(s)));
    H.check('an explicit host overrides the preset',
      M.config({ PRA_MAIL_ADDRESS: 'a@gmail.com', PRA_SMTP_HOST: 'mine.example' })
        .smtpHost === 'mine.example');
  }

  // ══ the dedicated-mailbox guard ═══════════════════════════════════════
  {
    H.throws('reusing the known personal address is refused',
      () => M.assertDedicated({ address: 'mark@icloud.com' }, ['mark@icloud.com']),
      'personal account');
    H.check('and the refusal explains the append-only consequence',
      (() => { try { M.assertDedicated({ address: 'm@x.com' }, ['m@x.com']); }
        catch (e) { return /append-only ledger/.test(e.message); } })());
    H.throws('a general-purpose local part is refused',
      () => M.assertDedicated({ address: 'me@example.org' }, []), 'general-purpose');
    let ok = true;
    try { M.assertDedicated({ address: 'records@example.org' }, ['mark@icloud.com']); }
    catch { ok = false; }
    H.check('a dedicated records address passes', ok);
  }

  // ══ what actually goes on the wire ════════════════════════════════════
  {
    const built = M.buildMessage({
      request_id: 'PRR-2026-391', to: 'records@gahanna.gov', subject: 'S', body: LETTER,
    }, CFG);
    H.eq('the from address is the FOIA mailbox',
      built.from, '"Mark W. Rosenburg" <records@example.org>');
    H.check('a request signed by a person, not a system',
      /Mark W\. Rosenburg/.test(built.from));
    H.eq('the body goes as plain text, not HTML', built.text, LETTER);
    H.check('there is no html part at all', built.html === undefined);
    H.eq('the request id rides in a header so a mangled subject cannot lose it',
      built.headers['X-Sentinel-Request'], 'PRR-2026-391');
    H.check('an absent cc is omitted rather than sent empty',
      built.cc === undefined);
  }

  // ══ send obeys the outbox gate, not its own judgement ═════════════════
  {
    const ob = tmpOutbox();
    const drafted = ob.queue({ request_id: 'A-1', to: 'a@agency.gov', subject: 'S', body: LETTER });
    const approved = ob.queue({ request_id: 'A-2', to: 'b@agency.gov', subject: 'S', body: LETTER });
    ob.approve(approved.message_id);

    const t = fakeTransport();
    const res = await M.sendApproved(ob, CFG, { transport: t });

    H.eq('exactly one message was sent', t.sent.length, 1);
    H.eq('and it was the approved one', t.sent[0].to, 'b@agency.gov');
    H.check('the unapproved draft is untouched',
      ob.get(drafted.message_id).state === 'drafted');
    H.eq('the sent one is marked sent', ob.get(approved.message_id).state, 'sent');
    H.check('with the provider message id kept',
      /@test>/.test(ob.get(approved.message_id).receipt.messageId));
    H.eq('the result reports one send', res.filter((r) => r.sent).length, 1);
  }

  // ══ a voided approval is not sent, even in a batch ════════════════════
  {
    const ob = tmpOutbox();
    const m = ob.queue({ request_id: 'A-1', to: 'a@agency.gov', subject: 'S', body: LETTER });
    ob.approve(m.message_id);
    const d = ob.load();
    d.messages[0].body = LETTER + '\n\nDamages are accruing.';
    ob.save(d);

    const t = fakeTransport();
    const res = await M.sendApproved(ob, CFG, { transport: t });
    H.eq('nothing was sent', t.sent.length, 0);
    H.check('it was skipped, not failed', res[0].skipped === true);
    H.check('with the reason the operator needs',
      /changed after it was approved/.test(res[0].reason), res[0].reason);
    H.eq('and the message is still approved, awaiting a re-read',
      ob.get(m.message_id).state, 'approved');
  }

  // ══ dry run sends nothing, and needs nothing ══════════════════════════
  {
    const ob = tmpOutbox();
    const m = ob.queue({ request_id: 'A-1', to: 'a@agency.gov', subject: 'S', body: LETTER });
    ob.approve(m.message_id);
    const t = fakeTransport();
    const res = await M.sendApproved(ob, CFG, { transport: t, dryRun: true });
    H.eq('the transport was never called', t.sent.length, 0);
    H.check('but it reports what it would do', res[0].dryRun === true);
    H.eq('and the message is untouched', ob.get(m.message_id).state, 'approved');

    // Regression: building the transport up front made --dry-run fail with
    // "nodemailer is not installed" on precisely the machine where someone is
    // checking what WOULD be sent before installing anything.
    let threw = null;
    try {
      await M.sendApproved(ob, CFG, { dryRun: true });   // no transport at all
    } catch (e) { threw = e; }
    H.check('a dry run needs NO transport and NO mail library', threw === null,
      threw && threw.message);
  }

  // ══ the per-run ceiling ═══════════════════════════════════════════════
  {
    const ob = tmpOutbox();
    for (let i = 0; i < 8; i++) {
      const m = ob.queue({ request_id: `A-${i}`, to: `a${i}@agency.gov`,
        subject: 'S', body: LETTER });
      ob.approve(m.message_id);
    }
    const t = fakeTransport();
    const res = await M.sendApproved(ob, Object.assign({}, CFG, { maxPerRun: 3 }),
      { transport: t });
    H.eq('the ceiling is enforced', t.sent.length, 3);
    H.eq('the rest are skipped, not failed', res.filter((r) => r.skipped).length, 5);
    H.check('and the reason says to run again',
      /run again to continue/.test(res.find((r) => r.skipped).reason));
    H.check('the unsent ones stay approved for the next run',
      ob.list({ state: 'approved' }).length === 5);
  }

  // ══ a failed send is recorded, never retried in the same run ══════════
  {
    const ob = tmpOutbox();
    const m = ob.queue({ request_id: 'A-1', to: 'bad@agency.gov', subject: 'S', body: LETTER });
    ob.approve(m.message_id);
    const t = fakeTransport({ throwOn: () => true });
    const res = await M.sendApproved(ob, CFG, { transport: t });
    H.eq('the failure is reported', res[0].failed, true);
    H.eq('the message is marked failed', ob.get(m.message_id).state, 'failed');
    H.check('with the SMTP error kept', /550/.test(ob.get(m.message_id).error));
    H.check('and it is not resurrected on the next run',
      (await M.sendApproved(ob, CFG, { transport: t })).length === 0);
  }

  // ══ matching a reply to a request ═════════════════════════════════════
  {
    const ids = ['PRR-2026-391', 'TSR-REQ-1-COLUMBUS-PD'];

    const byHeader = M.matchRequest({
      headers: { 'x-sentinel-request': 'PRR-2026-391' },
      subject: 'Re: your inquiry', text: '',
    }, ids);
    H.eq('the header wins', byHeader.request_id, 'PRR-2026-391');
    H.check('and it is confident', byHeader.confident === true);

    const bySubject = M.matchRequest({
      headers: {}, subject: 'RE: Public Records Request PRR-2026-391', text: '',
    }, ids);
    H.eq('an id in the subject matches', bySubject.request_id, 'PRR-2026-391');

    const byBody = M.matchRequest({
      headers: {}, subject: 'Your request', text: 'regarding TSR-REQ-1-COLUMBUS-PD, we...',
    }, ids);
    H.eq('an id in the body matches', byBody.request_id, 'TSR-REQ-1-COLUMBUS-PD');

    // The important refusal.
    const ambiguous = M.matchRequest({
      headers: {}, subject: 'PRR-2026-391 and TSR-REQ-1-COLUMBUS-PD', text: '',
    }, ids);
    H.eq('two ids means NO match rather than a guess', ambiguous.request_id, null);
    H.check('and it lists the candidates', ambiguous.candidates.length === 2);
    H.check('saying a human has to choose', /a human has to say/.test(ambiguous.note));

    const none = M.matchRequest({ headers: {}, subject: 'Hello', text: 'nothing here' }, ids);
    H.eq('no id means no match', none.request_id, null);
    H.check('it is not confident', none.confident === false);
    H.check('and it says why', /no request id/.test(none.note));

    H.check('a sender-only guess is never attempted',
      M.matchRequest({ headers: {}, subject: 'Re: records',
        text: '', fromAddress: 'clerk@gahanna.gov' }, ids).request_id === null);
  }

  // ══ header parsing ════════════════════════════════════════════════════
  {
    const h = M.parseHeaders(Buffer.from(
      'Subject: Re: PRR-2026-391\r\nX-Sentinel-Request: PRR-2026-391\r\nFrom: a@b.c\r\n'));
    H.eq('headers are lowercased for lookup', h['x-sentinel-request'], 'PRR-2026-391');
    H.eq('and values preserved', h.subject, 'Re: PRR-2026-391');
    H.eq('an empty buffer is an empty object', Object.keys(M.parseHeaders(null)).length, 0);
  }

  // ══ the libraries are not required until they are used ════════════════
  {
    const src = fs.readFileSync(require.resolve('../server/mail.js'), 'utf8');
    H.check('nodemailer is required lazily, inside the function',
      !/^const .*require\('nodemailer'\)/m.test(src)
      && /try \{ nodemailer = require\('nodemailer'\)/.test(src));
    H.check('imapflow too',
      !/^const .*require\('imapflow'\)/m.test(src));
    H.check('and a missing library explains itself rather than crashing',
      /npm install nodemailer/.test(src) && /npm install imapflow/.test(src));
  }
};

if (require.main === module) {
  (async () => { await module.exports(); process.exit(H.report()); })();
}
