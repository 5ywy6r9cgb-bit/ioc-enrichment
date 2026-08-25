'use strict';
/**
 * server/mail.js — the FOIA mailbox: sending approved letters, reading replies.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A DEDICATED ADDRESS IS A SECURITY DECISION, NOT A TIDINESS ONE
 *
 * This is built to talk to ONE mailbox used for nothing but public-records
 * correspondence. That constraint does real work:
 *
 *   - Every message in it is in scope. The inbound reader can log the whole
 *     mailbox without ever deciding whether a message is private, which means
 *     it never has to read a personal email to find out it should not have.
 *   - The blast radius of the stored credential is one mailbox that contains
 *     only letters to and from public offices.
 *   - Subject-line matching is reliable, because nothing else is in there.
 *
 * Point this at a personal inbox and every one of those properties inverts.
 * `assertDedicated()` below refuses the obvious cases, but it cannot know
 * everything — the discipline is the operator's.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CREDENTIALS
 *
 * Read from .env, never logged, never written to the outbox or any capture.
 * Use an app-specific password, not the account password: iCloud, Gmail, and
 * Fastmail all issue them, they are scoped to one app, and revoking one does
 * not lock you out of your own account.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES ARE LOADED LAZILY, ON PURPOSE
 *
 * nodemailer and imapflow are required only when a send or fetch actually
 * happens. Every test suite in this repo runs on a clean checkout with nothing
 * installed, and that property is worth more than the convenience of a
 * top-level require. The transport is injectable so the outbox and its gate
 * can be tested end to end without a mail server or a network.
 */

const path = require('path');
const fs = require('fs');

class MailError extends Error {}

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Read .env the same way the connectors do. Never echo a value. */
function loadEnv() {
  const env = Object.assign({}, process.env);
  for (const candidate of [path.join(ROOT, '.env'),
                           path.join(ROOT, 'modules', 'pra', '.env')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

/**
 * Provider presets, so an operator sets an address and a password rather than
 * four hostnames and two port numbers. Anything not listed here still works —
 * set the hosts explicitly.
 */
const PRESETS = {
  'icloud.com':  { smtp: 'smtp.mail.me.com',   smtpPort: 587, imap: 'imap.mail.me.com',   imapPort: 993 },
  'me.com':      { smtp: 'smtp.mail.me.com',   smtpPort: 587, imap: 'imap.mail.me.com',   imapPort: 993 },
  'gmail.com':   { smtp: 'smtp.gmail.com',     smtpPort: 587, imap: 'imap.gmail.com',     imapPort: 993 },
  'fastmail.com':{ smtp: 'smtp.fastmail.com',  smtpPort: 587, imap: 'imap.fastmail.com',  imapPort: 993 },
  'proton.me':   { smtp: '127.0.0.1',          smtpPort: 1025, imap: '127.0.0.1',         imapPort: 1143 },
  'outlook.com': { smtp: 'smtp-mail.outlook.com', smtpPort: 587, imap: 'outlook.office365.com', imapPort: 993 },
  'hotmail.com': { smtp: 'smtp-mail.outlook.com', smtpPort: 587, imap: 'outlook.office365.com', imapPort: 993 },
};

/**
 * Addresses that are almost certainly NOT a dedicated records mailbox. This
 * catches the specific mistake of pointing it at a personal inbox, where the
 * inbound reader would start logging private mail into an append-only ledger.
 */
const PERSONAL_SHAPES = [
  /^(me|info|contact|hello|hi)@/i,
];

function config(env = loadEnv()) {
  const address = env.PRA_MAIL_ADDRESS || '';
  const domain = address.split('@')[1] || '';
  const preset = PRESETS[domain.toLowerCase()] || {};

  return {
    address,
    // The display name on outgoing mail. A records request signed by a person
    // gets answered more often than one signed by a system.
    fromName: env.PRA_MAIL_FROM_NAME || env.PRA_OPERATOR_NAME || '',
    user: env.PRA_MAIL_USER || address,
    pass: env.PRA_MAIL_PASSWORD || '',
    smtpHost: env.PRA_SMTP_HOST || preset.smtp || '',
    smtpPort: Number(env.PRA_SMTP_PORT || preset.smtpPort || 587),
    imapHost: env.PRA_IMAP_HOST || preset.imap || '',
    imapPort: Number(env.PRA_IMAP_PORT || preset.imapPort || 993),
    mailbox: env.PRA_IMAP_MAILBOX || 'INBOX',
    // A hard ceiling on how many messages one `send` run may deliver. The
    // point is not throughput; it is that a bug in the queue cannot become
    // forty letters before anyone notices.
    maxPerRun: Number(env.PRA_MAIL_MAX_PER_RUN || 5),
  };
}

/** What is missing, in words, rather than a crash three frames deep. */
function checkConfig(cfg) {
  const missing = [];
  if (!cfg.address) missing.push('PRA_MAIL_ADDRESS');
  if (!cfg.pass) missing.push('PRA_MAIL_PASSWORD');
  if (!cfg.smtpHost) missing.push('PRA_SMTP_HOST (no preset for that domain)');
  if (!cfg.imapHost) missing.push('PRA_IMAP_HOST (no preset for that domain)');
  return missing;
}

/**
 * Refuse the obvious personal-inbox mistakes. This cannot be complete — an
 * operator who insists can always point it anywhere — but the common error is
 * reusing the address already in the address book, and that one is catchable.
 */
function assertDedicated(cfg, knownPersonal = []) {
  const a = (cfg.address || '').toLowerCase();
  if (!a) return;
  for (const p of knownPersonal) {
    if (p && a === String(p).toLowerCase()) {
      throw new MailError(
        `${cfg.address} is the address already on file as a personal account. `
        + `This mailbox is read in full and logged into an append-only ledger, `
        + `so it must be one used for public-records correspondence and nothing `
        + `else. Create a separate address.`);
    }
  }
  for (const re of PERSONAL_SHAPES) {
    if (re.test(a)) {
      throw new MailError(
        `${cfg.address} looks like a general-purpose address. This mailbox is `
        + `read in full, so use one dedicated to records requests — something `
        + `like records@ or foia@ — and nothing else.`);
    }
  }
}

// ---------------------------------------------------------------- sending

/**
 * Build the message an SMTP transport will send. Separate from sending so the
 * exact bytes can be asserted in a test without a network.
 */
function buildMessage(msg, cfg) {
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.address}>` : cfg.address;
  return {
    from,
    to: msg.to,
    cc: msg.cc || undefined,
    subject: msg.subject,
    text: msg.body,
    // The request id in a header survives an agency's reply mangling the
    // subject line, which is how a thread gets lost.
    headers: { 'X-Sentinel-Request': msg.request_id },
  };
}

/**
 * An SMTP transport. Injectable: pass one in for tests, or let it build a real
 * nodemailer transport lazily.
 */
async function smtpTransport(cfg) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch {
    throw new MailError(
      'nodemailer is not installed. From modules/pra run:  npm install nodemailer\n'
      + '  (It is needed only to send. Every test suite still runs with nothing installed.)');
  }
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    requireTLS: cfg.smtpPort !== 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

/**
 * Send the approved messages in an outbox. Returns a per-message result.
 *
 * The gate is the outbox's, not this function's: `sendable()` decides, and
 * anything it refuses is skipped with its reason recorded. This function's
 * only judgement is the per-run ceiling.
 */
async function sendApproved(outbox, cfg, opts = {}) {
  // A dry run must never need a mail library or a credential. Building the
  // transport up front made `--dry-run` fail with "nodemailer is not
  // installed" on exactly the machine where someone is trying to check what
  // WOULD be sent before installing anything — which is the one moment the
  // dry run exists to serve.
  const transport = opts.dryRun
    ? null
    : (opts.transport || await smtpTransport(cfg));
  const approved = outbox.list({ state: 'approved' });
  const results = [];
  let sent = 0;

  for (const msg of approved) {
    if (sent >= cfg.maxPerRun) {
      results.push({ message_id: msg.message_id, skipped: true,
        reason: `per-run ceiling of ${cfg.maxPerRun} reached — run again to continue` });
      continue;
    }
    const gate = outbox.sendable(msg);
    if (!gate.ok) {
      results.push({ message_id: msg.message_id, skipped: true, reason: gate.reason });
      continue;
    }
    if (opts.dryRun) {
      results.push({ message_id: msg.message_id, dryRun: true, to: msg.to,
        subject: msg.subject });
      continue;
    }
    try {
      const receipt = await transport.sendMail(buildMessage(msg, cfg));
      outbox.markSent(msg.message_id, {
        messageId: receipt.messageId || null,
        accepted: receipt.accepted || null,
      });
      results.push({ message_id: msg.message_id, sent: true, to: msg.to,
        messageId: receipt.messageId || null });
      sent++;
    } catch (e) {
      // A failed send is recorded, never silently retried. The operator
      // decides whether it goes out at all after a failure.
      outbox.markFailed(msg.message_id, e.message);
      results.push({ message_id: msg.message_id, failed: true, error: e.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------- reading

/**
 * Match an inbound message to a request.
 *
 * Header first, because it survives whatever the agency's mail client does to
 * the subject. Then an explicit id anywhere in subject or body. A sender-only
 * guess is deliberately NOT attempted: two open requests to the same office is
 * the normal case, and filing a reply against the wrong one puts a false fact
 * in a ledger that cannot be edited.
 */
function matchRequest(mail, requestIds) {
  const header = mail.headers && (mail.headers['x-sentinel-request']
    || mail.headers['X-Sentinel-Request']);
  if (header && requestIds.includes(String(header).trim())) {
    return { request_id: String(header).trim(), how: 'header', confident: true };
  }
  const haystack = `${mail.subject || ''}\n${mail.text || ''}`;
  const hits = requestIds.filter((id) => haystack.includes(id));
  if (hits.length === 1) return { request_id: hits[0], how: 'id in text', confident: true };
  if (hits.length > 1) {
    return { request_id: null, how: 'ambiguous', confident: false,
      candidates: hits,
      note: `names ${hits.length} request ids — a human has to say which` };
  }
  return { request_id: null, how: 'no match', confident: false,
    note: 'no request id in the header, subject, or body' };
}

async function imapClient(cfg) {
  let ImapFlow;
  try { ({ ImapFlow } = require('imapflow')); }
  catch {
    throw new MailError(
      'imapflow is not installed. From modules/pra run:  npm install imapflow\n'
      + '  (It is needed only to read mail. Every test suite still runs with nothing installed.)');
  }
  return new ImapFlow({
    host: cfg.imapHost, port: cfg.imapPort, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
}

/**
 * Fetch unread mail. Read-only by default: `markSeen` is opt-in, because the
 * unread flag is the operator's own place-marker in his own mailbox and this
 * tool should not move it without being asked.
 */
async function fetchInbound(cfg, opts = {}) {
  const client = opts.client || await imapClient(cfg);
  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      for await (const m of client.fetch({ seen: false },
          { envelope: true, source: true, headers: true, bodyStructure: true })) {
        out.push({
          uid: m.uid,
          from: m.envelope && m.envelope.from && m.envelope.from[0]
            ? `${m.envelope.from[0].name || ''} <${m.envelope.from[0].address}>`.trim() : '',
          fromAddress: m.envelope && m.envelope.from && m.envelope.from[0]
            ? m.envelope.from[0].address : '',
          subject: (m.envelope && m.envelope.subject) || '',
          date: m.envelope && m.envelope.date
            ? new Date(m.envelope.date).toISOString().slice(0, 10) : null,
          text: m.source ? m.source.toString('utf8') : '',
          headers: parseHeaders(m.headers),
        });
        if (out.length >= (opts.limit || 100)) break;
      }
      if (opts.markSeen && out.length) {
        await client.messageFlagsAdd({ uid: out.map((m) => m.uid).join(',') }, ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }
  return out;
}

function parseHeaders(buf) {
  const h = {};
  if (!buf) return h;
  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  return h;
}

module.exports = {
  loadEnv, config, checkConfig, assertDedicated, buildMessage,
  sendApproved, fetchInbound, matchRequest, smtpTransport, imapClient,
  parseHeaders, PRESETS, MailError,
};
