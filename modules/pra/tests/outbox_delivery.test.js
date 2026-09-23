'use strict';
/**
 * tests/outbox_delivery.test.js — what happens when we do not know what happened.
 *
 * The existing outbox suite proves a letter cannot go out unsigned and cannot
 * go out altered. This one proves the thing that comes after: that a send
 * whose outcome is not knowable is not filed as a failure, and that the
 * documented recovery from a failure — queue it again — cannot be reached from
 * a state where the agency may already have the letter.
 *
 * No network, no mail server, no database. A crashed run is simulated by
 * leaving a message in the state a crash would leave it in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const M = require('../server/mail.js');
const { Outbox, OutboxError, classifyError, TRANSITIONS } = require('../server/outbox.js');

const LETTER = 'To whom it may concern,\n\nThis is a request for records under '
  + 'R.C. 149.43. Please acknowledge receipt at your earliest convenience.\n\nThank you,';

function tmp() {
  return new Outbox(path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-')), 'outbox.json'));
}

function approved(ob, over = {}) {
  const m = ob.queue(Object.assign({
    request_id: 'OH-2026-0001', to: 'records@agency.oh.gov',
    subject: 'Public records request', body: LETTER,
  }, over));
  ob.approve(m.message_id, 'Mark');
  return ob.get(m.message_id);
}

const CFG = {
  address: 'records@example.org', fromName: 'Mark W. Griswold',
  user: 'records@example.org', pass: 'app-specific',
  smtpHost: 'smtp.example.org', smtpPort: 587,
  imapHost: 'imap.example.org', imapPort: 993, mailbox: 'INBOX',
  maxPerRun: 5,
};

/** Throws whatever it is given, so the classifier can be driven from a test. */
function throwingTransport(err) {
  return { sent: [], async sendMail() { throw err; } };
}

module.exports = async function run() {
  H.suite('outbox — unresolved delivery');

  // ══ the classifier says 'failed' only when it can name the evidence ════
  {
    const cases = [
      ['a 550 from the server is a rejection we can stand behind',
        Object.assign(new Error('rejected'), { code: 'EENVELOPE', responseCode: 550 }), 'failed'],
      ['a 4xx is the server declining, not an open question',
        Object.assign(new Error('try later'), { responseCode: 421 }), 'failed'],
      ['a refused authentication never reached the sending stage',
        Object.assign(new Error('bad login'), { code: 'EAUTH' }), 'failed'],
      ['a connection that was never established delivered nothing',
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'failed'],
      ['an unresolvable host delivered nothing',
        Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), 'failed'],

      ['a timeout could have happened after the server accepted it',
        Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'unknown'],
      ['a reset socket could have happened after the server accepted it',
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'unknown'],
      ['a bare Error carries no evidence either way',
        new Error('SMTP 550 rejected'), 'unknown'],
      ['an error shape nobody anticipated is unknown, not failed',
        Object.assign(new Error('?'), { code: 'ESOMETHINGNEW' }), 'unknown'],
    ];
    for (const [label, err, want] of cases) {
      H.eq(label, classifyError(err).outcome, want);
    }

    // The trap inside EENVELOPE. With a cc, some recipients can be accepted
    // and others rejected, and nodemailer still raises.
    const partial = Object.assign(new Error('some rejected'), {
      code: 'EENVELOPE', responseCode: 550,
      accepted: ['clerk@agency.oh.gov'], rejected: ['legal@agency.oh.gov'],
    });
    H.eq('a partial delivery is never "failed" — somebody got it',
      classifyError(partial).outcome, 'unknown');
    H.check('and the reason says so',
      /part of this message was delivered/.test(classifyError(partial).detail));
  }

  // ══ the attempt is on disk BEFORE the transport is touched ═════════════
  {
    const ob = tmp();
    const m = approved(ob);

    let stateDuringSend = null;
    const watcher = {
      async sendMail() {
        // Read the file from scratch, as a separate process would. This is the
        // instant a kill -9 would land.
        stateDuringSend = new Outbox(ob.file).get(m.message_id).state;
        return { messageId: '<ok@test>', accepted: ['x'] };
      },
    };
    const res = await M.sendApproved(ob, CFG, { transport: watcher });

    H.eq('while the transport runs, the outbox already says in_flight',
      stateDuringSend, 'in_flight');
    H.eq('and on success it becomes sent', ob.get(m.message_id).state, 'sent');
    H.eq('which is what the run reports', res[0].sent, true);
  }

  // ══ a run that died mid-transport does not look like one that never ran ═
  {
    const ob = tmp();
    const m = approved(ob);
    ob.claim(m.message_id);          // the claim a dead run would have written
    H.eq('the crashed run left it in_flight', ob.get(m.message_id).state, 'in_flight');

    const res = await M.sendApproved(ob, CFG, { transport: throwingTransport(new Error('unused')) });

    H.eq('the next run resolves it to unknown, not to a retry',
      ob.get(m.message_id).state, 'unknown');
    H.check('and says why in words',
      /ended while this message was in flight/.test(ob.get(m.message_id).unknown_reason));
    H.check('the run reports it as unresolved', res.some((r) => r.unknown));
    H.eq('nothing was sent', res.filter((r) => r.sent).length, 0);
  }

  // ══ THE ONE THAT MATTERS: unknown is not a licence to send again ═══════
  {
    const ob = tmp();
    const m = approved(ob);
    const res = await M.sendApproved(ob, CFG, {
      transport: throwingTransport(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    });

    H.eq('a reset mid-send is recorded as unknown', ob.get(m.message_id).state, 'unknown');
    H.eq('the run does NOT report it as failed', res[0].failed, undefined);
    H.check('it reports it as unresolved', res[0].unknown === true);

    const gate = ob.sendable(ob.get(m.message_id));
    H.check('an unknown message is not sendable', gate.ok === false);
    H.check('and the refusal warns it may already be there',
      /may already be in the agency/.test(gate.reason), gate.reason);

    // The documented recovery from `failed` is a new message. That path must
    // be closed here, or the recovery becomes the duplicate.
    H.throws('and a replacement cannot be queued for that request',
      () => ob.queue({ request_id: 'OH-2026-0001', to: 'records@agency.oh.gov',
        subject: 'Public records request', body: LETTER }),
      'delivery is unresolved');

    // A second run must not pick it up either.
    const again = await M.sendApproved(ob, CFG, { transport: throwingTransport(new Error('x')) });
    H.eq('and a second run sends nothing', again.filter((r) => r.sent).length, 0);
  }

  // ══ a knowable rejection still behaves exactly as it always did ════════
  {
    const ob = tmp();
    const m = approved(ob);
    await M.sendApproved(ob, CFG, {
      transport: throwingTransport(Object.assign(
        new Error('Message failed: 550 5.1.1 user unknown'),
        { code: 'EENVELOPE', responseCode: 550, accepted: [] })),
    });
    H.eq('a server rejection is still a failure', ob.get(m.message_id).state, 'failed');
    H.check('with the code kept', /550/.test(ob.get(m.message_id).error));
    H.eq('failed stays terminal', TRANSITIONS.failed.length, 0);
    // And a failure IS a clean slate — that was always the design.
    const replacement = ob.queue({ request_id: 'OH-2026-0001', to: 'records@agency.oh.gov',
      subject: 'Public records request', body: LETTER });
    H.eq('so a replacement can be queued after one', replacement.state, 'drafted');
  }

  // ══ the way out of unknown is a human who went and looked ══════════════
  {
    const ob = tmp();
    const m = approved(ob);
    await M.sendApproved(ob, CFG, {
      transport: throwingTransport(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    });

    H.throws('reconciling with no basis is refused',
      () => ob.reconcile(m.message_id, 'sent', ''), 'requires a basis');
    H.throws('and so is a token one',
      () => ob.reconcile(m.message_id, 'sent', 'ok'), 'requires a basis');
    H.throws('the outcome must be sent or failed, not a third guess',
      () => ob.reconcile(m.message_id, 'maybe', 'checked the sent folder at 14:02'), 'not \'maybe\'');

    const r = ob.reconcile(m.message_id, 'sent',
      'sent folder of records@ shows it delivered 14:02, no bounce received');
    H.eq('with a basis it resolves', r.state, 'sent');
    H.check('and the basis is kept, not just the verdict',
      /no bounce received/.test(ob.get(m.message_id).reconciled_basis));
    H.check('the history records who decided and on what',
      ob.get(m.message_id).history.some((h) => /reconciled to sent/.test(h.note || '')));
    H.throws('a resolved message cannot be reconciled twice',
      () => ob.reconcile(m.message_id, 'failed', 'changed my mind about the sent folder'),
      'no unresolved outcome');
  }

  // ══ two overlapping runs cannot both claim the same letter ═════════════
  {
    const ob = tmp();
    const m = approved(ob);

    // A second process with its own handle on the same file — which is what
    // a second terminal window, or a second HTTP request, actually is.
    const other = new Outbox(ob.file);

    const first = ob.claim(m.message_id);
    const second = other.claim(m.message_id);

    H.check('the first run claims it', first.ok === true);
    H.check('the second is refused', second.ok === false);
    H.check('and told an attempt is already running',
      /already running/.test(second.reason), second.reason);
    H.check('the claim carries an attempt id', /^ATT-/.test(first.attempt_id));
  }

  // ══ a dry run reports the mess and creates none ════════════════════════
  {
    const ob = tmp();
    const m = approved(ob);
    ob.claim(m.message_id);

    const res = await M.sendApproved(ob, CFG, { dryRun: true });
    H.eq('a dry run leaves a stranded message exactly as it found it',
      ob.get(m.message_id).state, 'in_flight');
    H.check('but says a real run will mark it unresolved',
      res.some((r) => /mark it unresolved/.test(r.reason || '')));
  }

  // ══ the lock is refused, not broken ════════════════════════════════════
  {
    const ob = tmp();
    approved(ob);
    fs.writeFileSync(`${ob.file}.lock`, '99999 held\n');
    // Age it past the staleness threshold.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${ob.file}.lock`, old, old);

    H.throws('a long-held lock stops the write rather than overriding it',
      () => ob.queue({ request_id: 'B-1', to: 'x@y.gov', subject: 'S', body: LETTER }),
      'has been held for');
    H.throws('and the message says what to check before clearing it',
      () => ob.queue({ request_id: 'B-1', to: 'x@y.gov', subject: 'S', body: LETTER }),
      'ps aux');
    fs.unlinkSync(`${ob.file}.lock`);
    H.check('and once cleared, work resumes',
      ob.queue({ request_id: 'B-1', to: 'x@y.gov', subject: 'S', body: LETTER }).state === 'drafted');
  }

  // ══ unresolved work is findable without reading the whole file ═════════
  {
    const ob = tmp();
    const a = approved(ob, { request_id: 'R-1' });
    const b = approved(ob, { request_id: 'R-2' });
    approved(ob, { request_id: 'R-3' });
    ob.claim(a.message_id);
    ob.claim(b.message_id);
    ob.markUnknown(b.message_id, 'connection dropped after DATA');

    const open = ob.unresolved();
    H.eq('both the in-flight and the unknown are listed', open.length, 2);
    H.check('and the untouched approved message is not',
      !open.some((m) => m.request_id === 'R-3'));
  }

  H.throws('an unknown outcome still has to say what went wrong',
    () => { const ob = tmp(); const m = approved(ob); ob.claim(m.message_id);
            ob.markUnknown(m.message_id, ''); }, 'needs a reason');
};
