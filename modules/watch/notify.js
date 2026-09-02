'use strict';
/**
 * modules/watch/notify.js — how the system gets your attention.
 *
 * THE CONTENT RULE, which is not negotiable and is enforced below:
 *
 *   A notification carries a COUNT, a LABEL, and an ID. Never a name, never a
 *   quote, never a finding, never anything from a capture.
 *
 * The reason is the whole reason this system is local. A push notification
 * leaves your machine, crosses a third party's servers, and lands on a lock
 * screen — three places your investigative material has no business being.
 * "3 new hits on WATCH-HB6-01" tells you to go look. "Larry Householder matched
 * a sanctions list" is a claim about a person, sitting unencrypted on someone
 * else's server, before you have confirmed it is even the same individual.
 *
 * So the notification is a doorbell, not a delivery. You open the desk to see
 * what arrived.
 *
 * Backends:
 *   none     do nothing (default when unconfigured)
 *   macos    local desktop notification via osascript — ZERO outbound
 *   file     append to a log — for testing and for headless machines
 *   ntfy     HTTPS POST to an ntfy topic — reaches your phone, OPT-IN, and a
 *            THIRD PARTY (ntfy.sh, unless self-hosted) relays every message.
 *   webpush  POSTs to YOUR OWN local_service (server/local_service.js's
 *            /push/notify), which fans out via server/push_notify.js to
 *            devices YOU subscribed with server/local_service's /push/*
 *            routes, using VAPID keys only you hold. Nothing but the
 *            browser vendor's push relay (Apple/Google — unavoidable
 *            infrastructure for Web Push, same as the mobile shell already
 *            uses) sees even the count. This is the backend for "only I can
 *            see this, and it still reaches my phone."
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// The content guard. Anything a caller hands us passes through here first.
// ---------------------------------------------------------------------------

/**
 * Patterns that suggest case content rather than a signal. This is a
 * belt-and-suspenders check: callers are already supposed to send counts only,
 * and this catches the day someone edits a template without thinking.
 */
const CONTENT_SMELLS = [
  /\b\d{3}-\d{2}-\d{4}\b/,                 // SSN shape
  /\b(?:\d[ -]*?){13,16}\b/,               // card shape
  /account\s*(?:number|no|#)/i,
  // Street address: a number, a name, and a thoroughfare suffix. The suffix
  // list has to be generous — the first version missed "742 Evergreen Terrace"
  // because Terrace was not on it, which is exactly the kind of near-miss that
  // makes a guard worse than useless.
  new RegExp(
    '\\b\\d+\\s+'                              // house number
    + '(?:[NSEW]{1,2}\\.?\\s+)?'               // optional directional: E, S, NW…
    + '(?:[A-Za-z][A-Za-z.\\-]*\\s+){0,3}'     // 0-3 name words
    + '('                                      // thoroughfare suffix
    + 'St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court'
    + '|Pl|Place|Ter|Terr|Terrace|Cir|Circle|Way|Pkwy|Parkway|Hwy|Highway'
    + '|Trl|Trail|Loop|Sq|Square|Aly|Alley|Xing|Crossing'
    + ')\\.?\\b', 'i'
  ),
];

const MAX_LEN = 240;

/**
 * Returns { ok, text, reason? }. Refuses rather than truncating a suspicious
 * message, because a truncated leak is still a leak.
 */
function guard(text) {
  const t = String(text == null ? '' : text);
  for (const re of CONTENT_SMELLS) {
    if (re.test(t)) {
      return { ok: false, reason: 'notification body looks like case content, not a signal' };
    }
  }
  if (t.length > MAX_LEN) {
    return { ok: false, reason: `notification body is ${t.length} chars; the cap is ${MAX_LEN}. Send a count, not a summary.` };
  }
  return { ok: true, text: t };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function notifyMacos(title, body) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      return resolve({ ok: false, reason: 'macos backend requires macOS' });
    }
    // Quote-escape for AppleScript: the only injection surface here.
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${esc(body)}" with title "${esc(title)}" sound name "Submarine"`;
    execFile('osascript', ['-e', script], (err) => {
      resolve(err ? { ok: false, reason: err.message } : { ok: true, via: 'macos' });
    });
  });
}

function notifyFile(title, body, cfg) {
  // Honour SENTINEL_EVIDENCE_DIR the way every other writer does, so a run
  // pointed at an alternate evidence root does not scatter its log back into
  // the default one.
  const evidence = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
  const target = cfg.path || path.join(evidence, 'watch', 'notifications.log');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${new Date().toISOString()}  ${title} — ${body}\n`, 'utf8');
  return Promise.resolve({ ok: true, via: 'file', path: target });
}

/**
 * ntfy.sh — the only backend that sends anything off this machine.
 *
 * Reaches iOS and Android with no account. Two things to understand before
 * turning it on: a public topic name is effectively a password (anyone who
 * guesses it can read your notifications), and the ntfy server sees every
 * message. Both are survivable precisely because the content rule above means
 * the messages say "3 new hits" and nothing else. Self-host via `server` if you
 * want even that to stay yours.
 */
function notifyNtfy(title, body, cfg) {
  return new Promise((resolve) => {
    if (!cfg.topic) return resolve({ ok: false, reason: 'ntfy backend needs a topic' });
    const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    let u;
    try { u = new URL(`${server}/${cfg.topic}`); } catch { return resolve({ ok: false, reason: 'bad ntfy server url' }); }

    const payload = Buffer.from(body, 'utf8');
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': payload.length,
      Title: title,
      Priority: cfg.priority || 'default',
      Tags: cfg.tags || 'mag',
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname, headers, timeout: 15000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(
        res.statusCode >= 200 && res.statusCode < 300
          ? { ok: true, via: 'ntfy' }
          : { ok: false, reason: `ntfy HTTP ${res.statusCode}` }
      ));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'ntfy timed out' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * POST title+body to this machine's own local_service — no third party,
 * no outbound host beyond 127.0.0.1. Fails soft (never throws) if the
 * service isn't running: a missed doorbell must not lose the run that
 * rang it, same rule every other backend follows.
 */
function notifyWebpush(title, body, cfg) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(cfg.serviceUrl || 'http://127.0.0.1:4317/push/notify'); }
    catch { return resolve({ ok: false, reason: 'bad webpush serviceUrl' }); }
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) {
      // The whole point of this backend is that it never leaves the
      // machine. A misconfigured serviceUrl pointing elsewhere is refused
      // outright rather than silently sending your doorbell off-box.
      return resolve({ ok: false, reason: `webpush backend refuses a non-loopback serviceUrl: ${u.hostname}` });
    }
    const payload = Buffer.from(JSON.stringify({ title, body, path: cfg.path, tag: cfg.tag }), 'utf8');
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port || 4317, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(
        res.statusCode >= 200 && res.statusCode < 300
          ? { ok: true, via: 'webpush' }
          : { ok: false, reason: `local_service HTTP ${res.statusCode}` }
      ));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'local_service not responding — is it running?' }); });
    req.on('error', (e) => resolve({ ok: false, reason: `local_service unreachable (${e.code || e.message}) — is it running?` }));
    req.write(payload);
    req.end();
  });
}

const BACKENDS = {
  none: () => Promise.resolve({ ok: true, via: 'none' }),
  macos: notifyMacos, file: notifyFile, ntfy: notifyNtfy, webpush: notifyWebpush,
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * send({ title, body, config }) -> { ok, via?, reason? }
 *
 * config: { backend: 'none'|'macos'|'file'|'ntfy', ...backend options }
 * A failure to notify is never fatal to the caller — a missed doorbell must not
 * lose the run that rang it.
 */
async function send({ title, body, config }) {
  const cfg = config || {};
  const backendName = cfg.backend || 'none';
  const backend = BACKENDS[backendName];
  if (!backend) return { ok: false, reason: `unknown notify backend: ${backendName}` };

  const gt = guard(title);
  const gb = guard(body);
  if (!gt.ok) return { ok: false, reason: `title refused: ${gt.reason}` };
  if (!gb.ok) return { ok: false, reason: `body refused: ${gb.reason}` };

  try {
    return await backend(gt.text, gb.text, cfg);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { send, guard, BACKENDS, MAX_LEN };
