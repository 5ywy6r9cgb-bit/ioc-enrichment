#!/usr/bin/env node
'use strict';
/**
 * scripts/mail.js — the FOIA mailbox.
 *
 *   sentinel pra mail setup                 what to put in .env, and check it
 *   sentinel pra mail queue REQ-ID          draft a letter into the outbox
 *   sentinel pra mail review                read everything awaiting sign-off
 *   sentinel pra mail approve MSG-ID        sign off on ONE letter
 *   sentinel pra mail reject MSG-ID "why"   kill a draft, on the record
 *   sentinel pra mail send [--dry-run]      send ONLY what you approved
 *   sentinel pra mail fetch [--apply]       read replies, log them
 *   sentinel pra mail log                   everything queued, approved, sent
 *   sentinel pra mail unresolved            sends whose outcome is not known
 *   sentinel pra mail reconcile MSG-ID sent|failed "what you checked"
 *
 * THE SHAPE OF IT
 *
 *   queue → review → approve → send
 *
 * Every arrow is a separate command run by a person. There is deliberately no
 * command that does all four, and `send` will not touch anything that has not
 * been approved by its exact text. Reading mail is the one half that runs
 * unattended, because reading changes nothing.
 */

const path = require('path');
const T = require('../server/foia_tracker.js');
const M = require('../server/mail.js');
const { Outbox, OutboxError } = require('../server/outbox.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function wrap(text, width, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + w).trim().length > width) { out.push(pad + line.trim()); line = w; }
      else line += ' ' + w;
    }
    out.push(pad + line.trim());
  }
  return out.join('\n');
}

function store() {
  const { FoiaStore } = require('../server/foia_store.js');
  return new FoiaStore(process.env.PRA_FOIA_STORE || null);
}

function normalise(r) {
  return Object.assign({}, r, {
    request_id: r.request_id || r.id,
    agency_name: r.agency_name || r.agency,
    submitted_on: r.submitted_on || r.filed_date || r.filed_on,
    status: (r.status || 'submitted').toLowerCase(),
  });
}

// ------------------------------------------------------------------ setup
function cmdSetup() {
  const cfg = M.config();
  const missing = M.checkConfig(cfg);

  console.log(`\n  ${C.b('FOIA MAILBOX')}\n`);
  if (missing.length) {
    console.log(`  ${C.y('Not configured yet.')} Add these to ${C.b('modules/pra/.env')}:\n`);
    console.log(C.dim('    PRA_MAIL_ADDRESS=records@yourdomain.com'));
    console.log(C.dim('    PRA_MAIL_PASSWORD=your-app-specific-password'));
    console.log(C.dim('    PRA_MAIL_FROM_NAME=Mark W. Griswold'));
    console.log(C.dim('    # hosts are filled in automatically for icloud, gmail,'));
    console.log(C.dim('    # fastmail, and outlook. Otherwise set them:'));
    console.log(C.dim('    # PRA_SMTP_HOST=  PRA_SMTP_PORT=  PRA_IMAP_HOST=  PRA_IMAP_PORT='));
    console.log('');
    console.log(wrap(C.y('Use an APP-SPECIFIC password, never your account password. '
      + 'iCloud, Gmail, and Fastmail all issue them; each is scoped to one app '
      + 'and revoking it does not lock you out of your own account.'), 74, 2));
    console.log('');
    console.log(wrap(C.r('Use an address that does NOTHING but public records. '
      + 'This tool reads the whole mailbox and logs it into an append-only '
      + 'ledger, so a personal inbox would put private mail somewhere it '
      + 'cannot be removed from.'), 74, 2));
    console.log(C.dim(`\n  Missing: ${missing.join(', ')}\n`));
    return 2;
  }

  console.log(`  address    ${C.g(cfg.address)}`);
  console.log(`  from       ${cfg.fromName || C.dim('(no display name set)')}`);
  console.log(`  smtp       ${cfg.smtpHost}:${cfg.smtpPort}`);
  console.log(`  imap       ${cfg.imapHost}:${cfg.imapPort}  ${C.dim(cfg.mailbox)}`);
  console.log(`  password   ${C.g('set')} ${C.dim('(never printed)')}`);
  console.log(`  ceiling    ${cfg.maxPerRun} message(s) per send run`);

  try {
    M.assertDedicated(cfg, [process.env.PRA_PERSONAL_EMAIL].filter(Boolean));
    console.log(`\n  ${C.g('Looks like a dedicated records mailbox.')}`);
  } catch (e) {
    console.log(`\n  ${C.r(e.message)}`);
    return 2;
  }
  console.log(C.dim('\n  Nothing has been sent or read. Try:  sentinel pra mail fetch --dry-run\n'));
  return 0;
}

// ------------------------------------------------------------------ queue
function cmdQueue(id, argv) {
  const valOf = (n) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    if (hit) return hit.slice(n.length + 3);
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : null;
  };

  const S = store();
  const rec = S.find(id);
  if (!rec) { console.error(`\n  ${C.r(`no request ${id}`)}\n`); return 2; }

  const r = normalise(rec);
  const e = T.evaluate(r, {});
  const to = valOf('to') || r.contact || null;
  if (!to) {
    console.error(`\n  ${C.r('No recipient.')}`);
    console.error(wrap(`Give one with --to, or record it on the request:\n`
      + `  sentinel pra foia set ${id} contact records@agency.gov`, 74, 2));
    console.error('');
    return 2;
  }

  const letter = T.draftFollowup(e, r, {
    name: process.env.PRA_MAIL_FROM_NAME || process.env.PRA_OPERATOR_NAME
      || r.requester || 'Requester',
  });
  if (!letter) {
    console.log(`\n  ${C.y('The desk drafts no letter at this rung.')}`);
    console.log(wrap(e.operator_decision || e.reason, 74, 2));
    console.log(C.dim('\n  This rung needs a decision from you before any letter exists.\n'));
    return 2;
  }

  const subjectLine = (letter.match(/^Subject:\s*(.+)$/m) || [])[1]
    || `Public Records Request ${id}`;
  const body = letter.replace(/^Subject:.*\n+/m, '');

  const ob = new Outbox();
  let msg;
  try {
    msg = ob.queue({ request_id: id, to, cc: valOf('cc'), subject: subjectLine,
      body, rung: e.rung, agency: r.agency_name });
  } catch (err) {
    console.error(`\n  ${C.r(err.message)}\n`);
    return 2;
  }

  console.log(`\n  ${C.g('queued')}  ${C.b(msg.message_id)}  ${C.dim('— NOT sent')}`);
  console.log(`  to        ${msg.to}`);
  console.log(`  subject   ${msg.subject}`);
  console.log(`  rung      ${e.label}`);
  console.log(C.dim(`\n  Read it:     sentinel pra mail review`));
  console.log(C.dim(`  Sign off:    sentinel pra mail approve ${msg.message_id}`));
  console.log(C.dim(`  Then send:   sentinel pra mail send\n`));
  return 0;
}

// ----------------------------------------------------------------- review
function cmdReview() {
  const ob = new Outbox();
  const drafted = ob.list({ state: 'drafted' });
  const approved = ob.list({ state: 'approved' });
  const open = ob.unresolved();

  // First, always. The only state where the desk does not know whether a
  // letter already reached an agency outranks everything waiting behind it.
  if (open.length) printUnresolved(open);

  if (!drafted.length && !approved.length) {
    if (open.length) return 0;
    console.log(`\n  ${C.dim('Nothing waiting. Queue one:  sentinel pra mail queue <REQUEST-ID>')}\n`);
    return 0;
  }

  for (const m of drafted) {
    console.log('\n' + C.dim('  ── awaiting your sign-off ' + '─'.repeat(48)));
    console.log(`  ${C.b(m.message_id)}   ${C.dim(m.request_id)}   ${C.dim(m.agency || '')}`);
    console.log(`  ${C.dim('to')}       ${m.to}`);
    console.log(`  ${C.dim('subject')}  ${m.subject}\n`);
    console.log(wrap(m.body, 74, 4));
    console.log('');
    console.log(C.c(`    approve:  sentinel pra mail approve ${m.message_id}`));
    console.log(C.dim(`    reject:   sentinel pra mail reject ${m.message_id} "reason"`));
  }

  if (approved.length) {
    console.log('\n' + C.dim('  ── approved, will go on the next send ' + '─'.repeat(36)));
    for (const m of approved) {
      const gate = ob.sendable(m);
      console.log(`  ${gate.ok ? C.g('✓') : C.r('✗')} ${C.b(m.message_id)}  `
        + `${C.dim(m.request_id)}  → ${m.to}`);
      if (!gate.ok) console.log(wrap(C.r(gate.reason), 70, 6));
    }
  }
  console.log('');
  return 0;
}

// ------------------------------------------------------------------- send
async function cmdSend(argv) {
  const dryRun = argv.includes('--dry-run');
  const ob = new Outbox();
  const cfg = M.config();

  const approved = ob.list({ state: 'approved' });
  const stranded = ob.list({ state: 'in_flight' });
  // A stranded in_flight message has to reach sendApproved even when nothing
  // is approved — that is where it gets resolved to unknown.
  if (!approved.length && !stranded.length) {
    console.log(`\n  ${C.dim('Nothing approved. Nothing sent.')}`);
    const open = ob.unresolved();
    if (open.length) printUnresolved(open);
    console.log(C.dim('  sentinel pra mail review\n'));
    return 0;
  }

  const missing = M.checkConfig(cfg);
  if (missing.length && !dryRun) {
    console.error(`\n  ${C.r('Mailbox not configured: ' + missing.join(', '))}`);
    console.error(C.dim('  sentinel pra mail setup\n'));
    return 2;
  }

  // Announce before acting, the same discipline the connectors use.
  console.log(`\n  ${C.b('SENDING APPROVED LETTERS')}${dryRun ? C.y('  — DRY RUN') : ''}`);
  console.log(`  from      ${cfg.address || C.dim('(unconfigured)')}`);
  console.log(`  queued    ${approved.length} approved`);
  console.log(`  ceiling   ${cfg.maxPerRun} per run\n`);

  let results;
  try {
    results = await M.sendApproved(ob, cfg, { dryRun });
  } catch (e) {
    console.error(`\n  ${C.r(e.message)}\n`);
    return 2;
  }

  for (const r of results) {
    if (r.sent) console.log(`  ${C.g('SENT')}     ${r.message_id} → ${r.to}`);
    else if (r.dryRun) console.log(`  ${C.y('WOULD SEND')} ${r.message_id} → ${r.to}  ${C.dim(r.subject)}`);
    // Checked BEFORE the catch-all. An unknown outcome printed as a dim
    // "skipped" is the most dangerous line this command could print: it
    // reads as "nothing happened" about a letter that may be in the
    // agency's inbox right now.
    else if (r.unknown) {
      console.log(`  ${C.r(C.b('UNRESOLVED'))} ${r.message_id} → ${r.to || ''}`);
      console.log(wrap(C.r(r.reason || ''), 70, 13));
    }
    else if (r.failed) console.log(`  ${C.r('FAILED')}   ${r.message_id}  ${r.error}`);
    else console.log(`  ${C.dim('skipped')}  ${r.message_id}  ${C.dim(r.reason)}`);
  }

  const unknown = results.filter((r) => r.unknown);
  if (unknown.length) {
    console.log('');
    console.log(wrap(C.r(C.b(`${unknown.length} letter(s) may or may not have reached the agency.`)), 74, 2));
    console.log(wrap(C.r('Do NOT re-send and do NOT queue a replacement. Check the sent folder '
      + 'of the records mailbox, then record what you found:'), 74, 2));
    for (const r of unknown) {
      console.log(C.c(`    sentinel pra mail reconcile ${r.message_id} sent "sent folder shows it at HH:MM"`));
    }
  }

  const sent = results.filter((r) => r.sent).length;
  if (sent) {
    console.log(C.dim(`\n  Log them against the request so the desk stops asking:`));
    for (const r of results.filter((x) => x.sent)) {
      const m = ob.get(r.message_id);
      console.log(C.dim(`    sentinel pra foia sent ${m.request_id} --via email`));
    }
  }
  console.log('');
  return 0;
}

// ------------------------------------------------------------------ fetch
async function cmdFetch(argv) {
  const apply = argv.includes('--apply');
  const cfg = M.config();
  const missing = M.checkConfig(cfg);
  if (missing.length) {
    console.error(`\n  ${C.r('Mailbox not configured: ' + missing.join(', '))}`);
    console.error(C.dim('  sentinel pra mail setup\n'));
    return 2;
  }
  try { M.assertDedicated(cfg, [process.env.PRA_PERSONAL_EMAIL].filter(Boolean)); }
  catch (e) { console.error(`\n  ${C.r(e.message)}\n`); return 2; }

  const S = store();
  const ids = S.list().map((r) => r.request_id || r.id);

  let mail;
  try {
    mail = await M.fetchInbound(cfg, { markSeen: false });
  } catch (e) {
    console.error(`\n  ${C.r(e.message)}\n`);
    return 2;
  }

  console.log(`\n  ${C.b('INBOUND')}  ${C.dim(`${mail.length} unread in ${cfg.mailbox}`)}\n`);
  if (!mail.length) { console.log(C.dim('  Nothing new.\n')); return 0; }

  let logged = 0, ambiguous = 0, unmatched = 0;
  for (const m of mail) {
    const match = M.matchRequest(m, ids);
    const tag = match.confident ? C.g(match.request_id)
      : (match.candidates ? C.y('AMBIGUOUS') : C.dim('unmatched'));
    console.log(`  ${tag.padEnd(30)} ${C.dim(m.date || '')}  ${m.subject.slice(0, 60)}`);
    console.log(C.dim(`  ${' '.repeat(30)} from ${m.fromAddress}`));

    if (match.confident && apply) {
      S.logCorrespondence(match.request_id, {
        direction: 'inbound',
        occurred_at: m.date,
        channel: 'email',
        note: `${m.fromAddress}: ${m.subject}`.slice(0, 300),
      });
      logged++;
      console.log(C.dim(`  ${' '.repeat(30)} logged against ${match.request_id}`));
    } else if (!match.confident) {
      if (match.candidates) ambiguous++; else unmatched++;
      console.log(C.dim(`  ${' '.repeat(30)} ${match.note}`));
    }
  }

  console.log('');
  if (!apply) {
    console.log(C.dim('  Nothing was logged. Re-run with --apply to record the matched ones.'));
  } else {
    console.log(`  ${C.g(`${logged} logged`)}`);
  }
  if (ambiguous || unmatched) {
    console.log(wrap(C.y(`${ambiguous + unmatched} could not be matched to one request. `
      + `Those are never guessed at — two open requests to the same office is `
      + `normal, and filing a reply against the wrong one puts a false fact in `
      + `a ledger that cannot be edited. Log them by hand:`), 74, 2));
    console.log(C.dim('    sentinel pra foia heard <REQUEST-ID> --note "..."'));
  }
  console.log(C.dim('\n  Reading changed nothing in your mailbox — messages are left unread.\n'));
  return 0;
}

// -------------------------------------------------------------------- log
function cmdLog() {
  const ob = new Outbox();
  const all = ob.list();
  if (!all.length) { console.log(`\n  ${C.dim('Outbox is empty.')}\n`); return 0; }
  console.log(`\n  ${C.b('OUTBOX')}  ${C.dim(ob.file)}\n`);
  const colour = { drafted: C.y, approved: C.c, in_flight: C.r, unknown: (x) => C.r(C.b(x)),
    sent: C.g, failed: C.r, rejected: C.dim };
  for (const m of all) {
    const c = colour[m.state] || C.dim;
    console.log(`  ${c(m.state.toUpperCase().padEnd(9))} ${C.b(m.message_id)}  `
      + `${C.dim(m.request_id.padEnd(24))} ${m.to}`);
    console.log(C.dim(`  ${' '.repeat(10)} ${m.subject.slice(0, 66)}`));
    if (m.sent_at) console.log(C.dim(`  ${' '.repeat(10)} sent ${m.sent_at}`));
    if (m.rejected_reason) console.log(C.dim(`  ${' '.repeat(10)} rejected: ${m.rejected_reason}`));
    if (m.error) console.log(C.r(`  ${' '.repeat(10)} ${m.error}`));
    if (m.state === 'unknown') console.log(C.r(`  ${' '.repeat(10)} ${m.unknown_reason || ''}`));
    if (m.reconciled_basis) console.log(C.dim(`  ${' '.repeat(10)} reconciled: ${m.reconciled_basis}`));
  }
  console.log('');
  return 0;
}

// ------------------------------------------------------------- unresolved
function printUnresolved(open) {
  console.log('\n' + C.r(C.b('  ── OUTCOME UNKNOWN — check these before anything else ' + '─'.repeat(20))));
  for (const m of open) {
    console.log(`  ${C.r(C.b(m.state.toUpperCase()))}  ${C.b(m.message_id)}  ${C.dim(m.request_id)}  → ${m.to}`);
    console.log(C.dim(`  ${' '.repeat(10)} ${m.subject.slice(0, 66)}`));
    const why = m.state === 'in_flight'
      ? 'a send run is in progress, or died mid-send. The next `mail send` will mark it unknown.'
      : (m.unknown_reason || '');
    console.log(wrap(C.r(why), 70, 12));
    if (m.state === 'unknown') {
      console.log(C.c(`            sentinel pra mail reconcile ${m.message_id} sent "what you checked"`));
      console.log(C.dim(`            sentinel pra mail reconcile ${m.message_id} failed "what you checked"`));
    }
  }
  console.log(wrap(C.dim('Look in the SENT folder of the records mailbox. If it is there, the '
    + 'agency has it. If it is not there and no bounce arrived, it most likely did not go. '
    + 'Either way, write down what you looked at — that sentence is kept.'), 74, 2));
}

function cmdUnresolved() {
  const open = new Outbox().unresolved();
  if (!open.length) {
    console.log(`\n  ${C.g('Nothing unresolved.')} ${C.dim('Every send has a known outcome.')}\n`);
    return 0;
  }
  printUnresolved(open);
  console.log('');
  return 1;   // non-zero so a script or a morning check can notice
}

function cmdReconcile(positional) {
  const [, id, outcome, ...rest] = positional;
  const basis = rest.join(' ');
  if (!id || !['sent', 'failed'].includes(outcome) || !basis) {
    console.error('\n  usage: mail reconcile <MSG-ID> sent|failed "what you checked, and what it showed"\n');
    return 2;
  }
  const m = new Outbox().reconcile(id, outcome, basis);
  console.log(`\n  ${outcome === 'sent' ? C.g('reconciled: SENT') : C.y('reconciled: FAILED')}  ${C.b(m.message_id)}`);
  console.log(C.dim(`  basis kept on the record: ${m.reconciled_basis}`));
  if (outcome === 'sent') {
    console.log(C.dim(`\n  Log it against the request so the desk's clock starts:`));
    console.log(C.dim(`    sentinel pra foia sent ${m.request_id} --via email\n`));
  } else {
    console.log(C.dim(`\n  It never reached them, so a new letter may now be queued:`));
    console.log(C.dim(`    sentinel pra mail queue ${m.request_id}\n`));
  }
  return 0;
}

// ------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] || 'review';
  const ob = () => new Outbox();

  try {
    switch (cmd) {
      case 'setup':   return process.exit(cmdSetup());
      case 'queue':   return process.exit(cmdQueue(positional[1], argv));
      case 'review':  return process.exit(cmdReview());
      case 'log':     return process.exit(cmdLog());
      case 'unresolved': return process.exit(cmdUnresolved());
      case 'reconcile':  return process.exit(cmdReconcile(positional));
      case 'send':    return process.exit(await cmdSend(argv));
      case 'fetch':   return process.exit(await cmdFetch(argv));
      case 'approve': {
        if (!positional[1]) { console.error('\n  usage: mail approve <MSG-ID>\n'); return process.exit(2); }
        const m = ob().approve(positional[1], process.env.PRA_OPERATOR_NAME);
        console.log(`\n  ${C.g('approved')}  ${C.b(m.message_id)}  ${C.dim(`by ${m.approved_by}`)}`);
        console.log(C.dim(`  Signed against this exact text. If the desk re-drafts it, the`));
        console.log(C.dim(`  sign-off is void and it will refuse to send.`));
        console.log(C.dim(`\n  Send it:  sentinel pra mail send\n`));
        return process.exit(0);
      }
      case 'reject': {
        const why = positional.slice(2).join(' ');
        if (!positional[1] || !why) { console.error('\n  usage: mail reject <MSG-ID> "why"\n'); return process.exit(2); }
        const m = ob().reject(positional[1], why);
        console.log(`\n  ${C.dim('rejected')}  ${C.b(m.message_id)}  ${why}`);
        console.log(C.dim('  Kept on the record — what you chose not to send is also an answer.\n'));
        return process.exit(0);
      }
      default:
        console.error(`\n  unknown: ${cmd}`);
        console.error('  mail subcommands: setup queue review approve reject send fetch log unresolved reconcile\n');
        return process.exit(2);
    }
  } catch (e) {
    if (e instanceof OutboxError || e instanceof M.MailError) {
      console.error(`\n  ${C.r(e.message)}\n`);
      return process.exit(2);
    }
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
