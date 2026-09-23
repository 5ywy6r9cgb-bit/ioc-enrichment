#!/usr/bin/env node
'use strict';
/**
 * demo_duplicate.js — the defect, demonstrated, then the same scenario after
 * the patch. No assertions, no framework: just two runs and what the agency
 * would have received.
 *
 * The scenario is one moment: nodemailer's sendMail resolves on the wire — the
 * SMTP server has accepted the message — and the process dies before the
 * outbox is written. A laptop lid, a Ctrl-C on a slow connection, an OOM kill.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Outbox } = require('./modules/pra/server/outbox.js');
const M = require('./modules/pra/server/mail.js');

const LETTER = 'To whom it may concern,\n\nThis is a request for records under '
  + 'R.C. 149.43 concerning automated licence plate reader deployments.\n\nThank you,';

const CFG = { address: 'records@example.org', fromName: 'Mark W. Griswold',
  user: 'u', pass: 'p', smtpHost: 'h', smtpPort: 587, imapHost: 'h',
  imapPort: 993, mailbox: 'INBOX', maxPerRun: 5 };

function freshOutbox() {
  const ob = new Outbox(path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')), 'outbox.json'));
  const m = ob.queue({ request_id: 'OH-FLOCK-001', to: 'records@agency.oh.gov',
    subject: 'Public records request — ALPR', body: LETTER });
  ob.approve(m.message_id, 'Mark');
  return { ob, id: m.message_id };
}

/** Counts what the agency actually receives across both runs. */
function agencyInbox() {
  const received = [];
  return {
    received,
    transport: {
      async sendMail(msg) {
        received.push(msg.subject);
        return { messageId: `<${received.length}@agency>`, accepted: [msg.to] };
      },
    },
  };
}

// ──────────────────────────────────────────────────────────── the old loop
// Reproduced exactly as it was: gate, send, then record.
async function oldSendLoop(outbox, cfg, transport, dieAfterSend) {
  for (const msg of outbox.list({ state: 'approved' })) {
    if (!outbox.sendable(msg).ok) continue;
    const receipt = await transport.sendMail({ to: msg.to, subject: msg.subject });
    if (dieAfterSend) return 'process died here';        // ← the whole defect
    outbox.markSent(msg.message_id, { messageId: receipt.messageId });
  }
  return 'completed';
}

(async () => {
  console.log('\n  BEFORE — gate, send, then record\n  ' + '─'.repeat(64));
  {
    const { ob, id } = freshOutbox();
    const agency = agencyInbox();

    console.log(`  run 1: sends, then the process is killed before recording`);
    await oldSendLoop(ob, CFG, agency.transport, true);
    console.log(`         outbox now says: ${ob.get(id).state}`);

    console.log(`  run 2: the operator runs send again`);
    await oldSendLoop(ob, CFG, agency.transport, false);
    console.log(`         outbox now says: ${ob.get(id).state}`);

    console.log(`\n  the agency received ${agency.received.length} copies of `
      + `"${agency.received[0]}"`);
    console.log(`  the outbox reports: one message, sent once.\n`);
  }

  console.log('\n  AFTER — claim, send, then record\n  ' + '─'.repeat(64));
  {
    const { ob, id } = freshOutbox();
    const agency = agencyInbox();

    console.log(`  run 1: sends, then the process is killed before recording`);
    // claim() writes in_flight to disk; then the transport runs; then nothing,
    // because this is where the process died.
    const claim = ob.claim(id);
    await agency.transport.sendMail({ to: claim.message.to, subject: claim.message.subject });
    console.log(`         outbox now says: ${ob.get(id).state}`);

    console.log(`  run 2: the operator runs send again`);
    const res = await M.sendApproved(ob, CFG, { transport: agency.transport });
    console.log(`         outbox now says: ${ob.get(id).state}`);
    console.log(`         run 2 reported: ${res.map((r) => r.unknown ? 'unresolved' : (r.sent ? 'sent' : 'skipped')).join(', ')}`);

    console.log(`\n  the agency received ${agency.received.length} copy of `
      + `"${agency.received[0]}"`);
    console.log(`  the outbox reports: ${ob.get(id).unknown_reason}`);

    console.log(`\n  and the operator cannot paper over it:`);
    try {
      ob.queue({ request_id: 'OH-FLOCK-001', to: 'records@agency.oh.gov',
        subject: 'Public records request — ALPR', body: LETTER });
      console.log('    (a replacement was queued — this should not happen)');
    } catch (e) {
      console.log(`    ${e.message.split('\n')[0]}`);
    }

    const r = ob.reconcile(id, 'sent',
      'sent folder of records@ shows it at 14:02, agency acknowledged by reply 14:31');
    console.log(`\n  after checking, he records what he found:`);
    console.log(`    state: ${r.state}`);
    console.log(`    basis: ${r.reconciled_basis}`);
    console.log(`  the agency still received ${agency.received.length} copy.\n`);
  }
})();
