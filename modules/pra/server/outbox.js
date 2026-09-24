'use strict';
/**
 * server/outbox.js — nothing leaves this machine without a signature.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY AN OUTBOX AND NOT A SEND FUNCTION
 *
 * The operator asked for letters to go out automatically once he signs off on
 * them. Those two halves pull in opposite directions, and this file is the
 * seam between them.
 *
 * A letter to a records custodian cannot be unsent. It goes out over a real
 * person's name, to a public office, and becomes part of a record that may be
 * read back to him adversarially. This repository has already found three
 * defects in the tracker that reached DRAFTED correspondence — an invented
 * statutory deadline, a damages figure for a case nobody had filed, and a
 * denial treated as a closed request. Every one would have become mail under a
 * blanket "send whatever the tracker drafts" rule.
 *
 * So approval is per-letter, and it is bound to the exact bytes approved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HASH IS THE SIGNATURE
 *
 * approve() records the SHA-256 of what it is approving. send refuses any
 * message whose current text does not hash to the approved value.
 *
 * That is not ceremony. Without it this sequence is silently possible:
 *
 *   1. the operator reads and approves a polite status enquiry
 *   2. the request crosses a threshold and the tracker re-drafts it as an
 *      escalation
 *   3. the escalation goes out carrying yesterday's approval
 *
 * With the hash, step 3 refuses and says the text changed since sign-off.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS APPEND-ONLY
 *
 * Every state change appends to history, and nothing is ever deleted —
 * including messages that were rejected or that failed to send. "What did you
 * send them, and when" is a question asked under oath. So is "what did you
 * decide not to send." A queue you can quietly empty answers neither.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS AN 'unknown' STATE
 *
 * The original three outcomes were sent, failed, and nothing. That is two
 * outcomes too few, because SMTP can hand you an error AFTER the message has
 * already been accepted for delivery — a socket reset between the server's
 * 250 and nodemailer returning is indistinguishable, from here, from a socket
 * reset before the envelope was ever written.
 *
 * Recording that as `failed` is a factual claim we cannot support. And because
 * the documented recovery from `failed` is to queue a NEW message, the cost of
 * the wrong guess is the agency receiving the same request twice, over the
 * operator's name, with two different message ids. That is exactly the defect
 * the duplicate-draft guard in queue() exists to prevent, arriving through a
 * door the guard does not watch.
 *
 * So: we say `failed` only when we can name the reason we know nothing was
 * delivered — the server declined with a response code, authentication never
 * succeeded, the connection was never established. Everything else is
 * `unknown`, which is not a failure and not a success. It is a message that
 * needs a human to go look, and it cannot be re-queued until one has.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE ATTEMPT IS RECORDED BEFORE THE TRANSPORT RUNS
 *
 * The send loop used to be: sendMail, then write the result. Between those two
 * statements the process can be killed, the laptop can sleep, the operator can
 * hit Ctrl-C on a hung connection. The letter is gone and the outbox still
 * says `approved` — so the next run sends it again, and this time the outbox
 * is right that it went out, twice.
 *
 * claim() closes that window by writing `in_flight` to disk BEFORE the
 * transport is touched. A message found `in_flight` at the start of a run can
 * only have got there one way: the run that claimed it did not live to record
 * an outcome. sweepStranded() moves those to `unknown`, which is the honest
 * description of what we know about them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class OutboxError extends Error {}

const STATES = ['drafted', 'approved', 'in_flight', 'sent', 'failed', 'unknown', 'rejected'];

/** A message in one of these is not finished, and blocks a second draft. */
const OPEN_STATES = ['drafted', 'approved', 'in_flight', 'unknown'];

/**
 * The only legal transitions. `sent` and `failed` are terminal: a failed
 * attempt is re-queued as a NEW message rather than resurrected, so the
 * failure stays on the record instead of being edited out of it.
 */
const TRANSITIONS = {
  drafted:  ['approved', 'rejected'],
  // approved -> approved is the way back from a voided sign-off. When the desk
  // re-drafts a message the hash no longer matches and sendable() refuses it;
  // without this transition that message is stuck forever — unsendable and
  // unapprovable. Re-approving is not a bypass: it requires the operator to
  // run approve again, against the text as it now stands, and it appends a
  // second signature to the history rather than replacing the first.
  //
  // approved -> sent and approved -> failed stay legal and are NOT the mail
  // loop's path. They are how the operator records a letter he delivered
  // himself — hand-delivered, posted, typed into an agency web portal. That is
  // a real and common way a request gets filed, and the outbox has to be able
  // to hold the fact. The mail loop goes through in_flight; a human recording
  // his own delivery does not, because there was never a window to crash in.
  approved:  ['approved', 'in_flight', 'sent', 'failed', 'rejected'],
  // Only a completed transport attempt leaves in_flight. There is no route
  // back to `approved`: once the bytes may have reached an SMTP server, the
  // question is no longer whether to send but what happened.
  in_flight: ['sent', 'failed', 'unknown'],
  // Reachable only through reconcile(), which demands a stated basis.
  unknown:   ['sent', 'failed'],
  sent:      [],
  failed:    [],
  rejected:  [],
};

/**
 * How long a lock may be held before we stop waiting for it. A transition is
 * three syscalls; anything approaching this means the holder died.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function defaultPath() {
  if (process.env.PRA_OUTBOX) return process.env.PRA_OUTBOX;
  return path.resolve(__dirname, '..', '..', '..', 'evidence', 'outbox.json');
}

function nowIso() { return new Date().toISOString(); }

/** Sleep without going async. The Outbox API is synchronous and stays that way. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Decide, from a transport error, whether we KNOW nothing was delivered.
 *
 * The default is 'unknown' and that is the whole design. Every branch that
 * returns 'failed' has to name the evidence: a response code means the server
 * spoke and declined; an auth error means we never got past the greeting; a
 * connect-phase network error means there was no session to deliver into.
 *
 * Anything else — a timeout, a reset, an error shape nodemailer grew since
 * this was written — is a case where the message may be sitting in an agency's
 * queue right now, and saying otherwise would be inventing a fact.
 *
 * Exported and pure, so the classification can be tested without a network.
 */
function classifyError(e) {
  const code = e && e.code ? String(e.code) : '';
  const rc = e && typeof e.responseCode === 'number' ? e.responseCode : null;

  // Partial delivery is the trap inside EENVELOPE: with a cc, some recipients
  // can be accepted and others rejected, and nodemailer raises. Something went
  // out. Calling that 'failed' is how a "retry" becomes a duplicate for
  // everyone who already received it.
  if (e && Array.isArray(e.accepted) && e.accepted.length > 0) {
    return { outcome: 'unknown',
      detail: `the server accepted ${e.accepted.length} recipient(s) and rejected `
            + `others — part of this message was delivered` };
  }

  if (rc !== null && rc >= 400) {
    return { outcome: 'failed',
      detail: `the mail server declined it with ${rc}${e.response ? `: ${String(e.response).slice(0, 200)}` : ''}` };
  }
  if (code === 'EAUTH') {
    return { outcome: 'failed',
      detail: 'authentication was refused — the session never reached the point of sending' };
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return { outcome: 'failed',
      detail: `no connection to the mail server was established (${code})` };
  }

  return { outcome: 'unknown',
    detail: `the transport failed after the connection was open${code ? ` (${code})` : ''}`
          + `: ${e && e.message ? e.message : String(e)}. Whether the server had already `
          + `accepted the message cannot be determined from here.` };
}

/** The signature covers the body AND the addressing that decides where it lands. */
function bodyHash(msg) {
  const canonical = JSON.stringify({
    to: msg.to, cc: msg.cc || null, subject: msg.subject, body: msg.body,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

class Outbox {
  constructor(file) { this.file = file || defaultPath(); }

  /**
   * Run fn while holding an exclusive lock on this outbox.
   *
   * WHY THIS EXISTS AT ALL
   *   Every mutation here is load → change → save, and save rewrites the whole
   *   file. That is safe for one process and silently wrong for two: A loads,
   *   B loads, A saves, B saves, and A's change is gone. If A's change was
   *   markSent, the letter went out and the outbox no longer knows.
   *
   *   Two processes is not hypothetical. local_service.js is an HTTP server,
   *   and a second terminal window is one Cmd-T away.
   *
   * WHY IT DOES NOT BREAK A STALE LOCK BY ITSELF
   *   A lock that auto-breaks after a timeout is a lock that lets the
   *   double-send back in on exactly the slow, hung, half-dead run where it
   *   matters. So this refuses, loudly, and names the file to delete. Being
   *   wedged is recoverable in one command; sending a records request twice
   *   over the operator's name is not recoverable at all.
   */
  _withLock(fn) {
    const lock = `${this.file}.lock`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd = null;
    for (;;) {
      try { fd = fs.openSync(lock, 'wx'); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw new OutboxError(`cannot lock ${this.file}: ${e.message}`);
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* vanished; retry */ }
        if (age > LOCK_STALE_MS) {
          throw new OutboxError(
            `${lock} has been held for ${Math.round(age / 1000)}s. Either another `
            + `process is still working on this outbox, or one died holding the lock.\n`
            + `  Check first:  ps aux | grep -i pra\n`
            + `  Then, only if nothing is running:  rm ${lock}\n`
            + `This does NOT auto-clear, because breaking a lock held by a live send `
            + `is how the same letter goes out twice.`);
        }
        if (Date.now() > deadline) {
          throw new OutboxError(
            `waited ${LOCK_WAIT_MS}ms for ${lock} and it is still held. Another `
            + `process has this outbox. Try again in a moment.`);
        }
        sleepSync(25);
      }
    }

    try {
      fs.writeSync(fd, `${process.pid} ${nowIso()}\n`);
      fs.closeSync(fd); fd = null;
      return fn();
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { version: 1, messages: [] };
      throw new OutboxError(`cannot read ${this.file}: ${e.message}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      throw new OutboxError(
        `${this.file} is not valid JSON (${e.message}). It has NOT been `
        + `modified. This file records what was approved and what was sent.`);
    }
    if (!Array.isArray(parsed.messages)) {
      throw new OutboxError(`${this.file} has no "messages" array.`);
    }
    return parsed;
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.file;
  }

  list(filter = {}) {
    let msgs = this.load().messages;
    if (filter.state) msgs = msgs.filter((m) => m.state === filter.state);
    if (filter.request_id) msgs = msgs.filter((m) => m.request_id === filter.request_id);
    return msgs;
  }

  get(id) { return this.load().messages.find((m) => m.message_id === id) || null; }

  /** Queue a draft. Drafting is not sending, and never becomes sending on its own. */
  queue({ request_id, to, cc, subject, body, rung, agency }) {
    if (!request_id) throw new OutboxError('request_id is required');
    if (!to) throw new OutboxError('a recipient address is required');
    if (!subject) throw new OutboxError('a subject is required');
    if (!body || body.trim().length < 40) {
      throw new OutboxError('the body is empty or implausibly short — refusing to queue it');
    }

    return this._withLock(() => this._queueLocked({ request_id, to, cc, subject, body, rung, agency }));
  }

  _queueLocked({ request_id, to, cc, subject, body, rung, agency }) {
    const data = this.load();

    // A second pending draft for one request is how an agency receives the
    // same enquiry twice in a morning.
    const pending = data.messages.find(
      (m) => m.request_id === request_id && OPEN_STATES.includes(m.state));
    if (pending) {
      // An unresolved delivery is a different problem from an unsent draft,
      // and the advice for one is wrong for the other. Telling an operator to
      // "send it or reject it" when the last attempt may ALREADY have reached
      // the agency is how the duplicate gets sent deliberately.
      if (pending.state === 'unknown') {
        throw new OutboxError(
          `${request_id} has a message whose delivery is unresolved `
          + `(${pending.message_id}). Find out whether the agency received it — `
          + `check the sent folder of the records mailbox, or ask them — and `
          + `record the answer with reconcile(). Queuing another now risks `
          + `sending the same request twice.`);
      }
      if (pending.state === 'in_flight') {
        throw new OutboxError(
          `${request_id} has a message currently being transmitted `
          + `(${pending.message_id}). Wait for the run to finish.`);
      }
      throw new OutboxError(
        `${request_id} already has a ${pending.state} message (${pending.message_id}). `
        + `Send it, or reject it, before queuing another.`);
    }

    const msg = {
      message_id: `MSG-${Date.now().toString(36).toUpperCase()}-`
                + crypto.randomBytes(2).toString('hex').toUpperCase(),
      request_id,
      agency: agency || null,
      rung: rung || null,
      to, cc: cc || null, subject, body,
      state: 'drafted',
      body_sha256: bodyHash({ to, cc, subject, body }),
      queued_at: nowIso(),
      approved_at: null,
      approved_hash: null,
      sent_at: null,
      history: [{ at: nowIso(), state: 'drafted', note: 'queued by the records desk' }],
    };
    data.messages.push(msg);
    this.save(data);
    return msg;
  }

  /**
   * `patch` may be an object, or a function of the freshly-loaded message.
   * The function form matters for approve(), whose patch contains a hash of
   * the message text: computing that outside the lock would sign off on a
   * version of the letter that a concurrent write had already replaced.
   */
  _transition(id, to, patch, note) {
    return this._withLock(() => {
      const data = this.load();
      const msg = data.messages.find((m) => m.message_id === id);
      if (!msg) throw new OutboxError(`no message ${id}`);
      const allowed = TRANSITIONS[msg.state] || [];
      if (!allowed.includes(to)) {
        throw new OutboxError(
          `${id} is '${msg.state}' and cannot become '${to}'`
          + (msg.state === 'sent' ? ' — it has already gone out.' : '.'));
      }
      const resolved = typeof patch === 'function' ? patch(msg) : patch;
      const noteText = typeof note === 'function' ? note(msg) : note;
      Object.assign(msg, resolved, { state: to });
      msg.history.push(Object.assign({ at: nowIso(), state: to }, noteText ? { note: noteText } : {}));
      this.save(data);
      return msg;
    });
  }

  /**
   * Sign off on one message. Records WHAT was approved, not merely that something was.
   *
   * `expectedHash` is for any approver that is not reading the file at the
   * moment it approves — a browser, above all. The page shows the text, the
   * operator reads it, clicks; meanwhile the desk may have re-drafted it. The
   * page sends the hash of what it DISPLAYED, and approval is refused unless
   * that is still the text on disk, checked inside the lock. Without it, a
   * click approves whatever is there now, which is not what was read.
   */
  approve(id, who, expectedHash) {
    if (!this.get(id)) throw new OutboxError(`no message ${id}`);
    return this._transition(id, 'approved', (msg) => {
      const now = bodyHash(msg);
      if (expectedHash !== undefined && expectedHash !== now) {
        throw new OutboxError(
          `${id} changed after you read it — the text on screen is not the text `
          + `on disk. Reload, read it again, and approve what is there now.`);
      }
      return {
        approved_at: nowIso(),
        approved_hash: now,
        approved_by: who || process.env.PRA_OPERATOR_NAME || 'operator',
      };
    }, `approved by ${who || 'operator'}`);
  }

  reject(id, why) {
    if (!why) throw new OutboxError('say why — a rejected draft with no reason teaches nothing');
    return this._transition(id, 'rejected', { rejected_reason: why }, why);
  }

  /**
   * The gate send() must pass. Separate from sending so it is testable without
   * a mail server, and so a refusal is one readable string.
   */
  sendable(msg) {
    if (!msg) return { ok: false, reason: 'no such message' };
    if (msg.state === 'sent') return { ok: false, reason: 'already sent' };
    if (msg.state === 'rejected') return { ok: false, reason: 'rejected' };
    if (msg.state === 'in_flight') {
      return { ok: false,
        reason: 'a transport attempt for this message is already running — '
              + 'sending it again now is how the agency gets two copies' };
    }
    if (msg.state === 'unknown') {
      return { ok: false,
        reason: 'the last attempt ended without a knowable outcome, so this may '
              + 'already be in the agency\'s inbox. Find out, then record what you '
              + 'found with reconcile() — do not send it again on the assumption '
              + 'that it failed.' };
    }
    if (msg.state !== 'approved') {
      return { ok: false, reason: `not approved (state: ${msg.state})` };
    }
    if (bodyHash(msg) !== msg.approved_hash) {
      return {
        ok: false,
        reason: 'the text changed after it was approved — a sign-off does not '
              + 'carry over to different words. Read it again and re-approve.',
      };
    }
    return { ok: true };
  }

  markSent(id, receipt) {
    return this._transition(id, 'sent', { sent_at: nowIso(), receipt: receipt || null },
      receipt && receipt.messageId ? `accepted as ${receipt.messageId}` : 'sent');
  }

  markFailed(id, error) {
    return this._transition(id, 'failed', { error: String(error) }, String(error));
  }

  /**
   * Record that a transport attempt ended without a knowable outcome.
   *
   * This is not a failure. Nothing here says the message did not arrive — it
   * says we cannot claim either way, which is a different and more honest
   * thing to have written down.
   */
  markUnknown(id, why, extra) {
    if (!why) throw new OutboxError('an unknown outcome needs a reason — what went wrong, and at what point');
    // `extra` carries what the transport DID report — per-recipient
    // acceptance, above all — so the person reconciling sees who already
    // has a copy.
    return this._transition(id, 'unknown',
      Object.assign({ unknown_reason: String(why), unknown_at: nowIso() }, extra || {}),
      String(why));
  }

  /**
   * Claim a message for transport: check the gate and write `in_flight` to
   * disk in one locked step, and hand back the message the caller should send.
   *
   * Check-then-send in two steps is a race with a stale read in the middle;
   * two overlapping runs can both pass a gate that was true when each looked.
   * Claiming is the check. If this returns ok, the caller holds the only
   * outstanding claim on this message and the disk already says so — which is
   * what makes the crash recoverable rather than invisible.
   */
  claim(id) {
    return this._withLock(() => {
      const data = this.load();
      const msg = data.messages.find((m) => m.message_id === id);
      const gate = this.sendable(msg);
      if (!gate.ok) return { ok: false, reason: gate.reason, message: msg || null };

      const attempt = `ATT-${Date.now().toString(36).toUpperCase()}-`
                    + crypto.randomBytes(2).toString('hex').toUpperCase();
      Object.assign(msg, {
        state: 'in_flight',
        attempt_id: attempt,
        attempt_started_at: nowIso(),
      });
      msg.history.push({ at: nowIso(), state: 'in_flight',
        note: `claimed for transport as ${attempt}` });
      this.save(data);
      return { ok: true, message: msg, attempt_id: attempt };
    });
  }

  /**
   * Anything still `in_flight` when a run starts belongs to a run that died.
   *
   * There is no other way to be in that state at rest: claim() writes it
   * immediately before the transport call and every completion path moves out
   * of it. So the correct reading is not "still going" — it is "a process
   * called sendMail and never came back to say what happened", which is the
   * definition of unknown.
   */
  sweepStranded(note) {
    return this._withLock(() => {
      const data = this.load();
      const moved = [];
      for (const msg of data.messages) {
        if (msg.state !== 'in_flight') continue;
        const why = note
          || `a send run ended while this message was in flight (claimed `
             + `${msg.attempt_started_at || 'at an unrecorded time'}). Whether it `
             + `reached the mail server is not recorded anywhere.`;
        Object.assign(msg, { state: 'unknown', unknown_reason: why, unknown_at: nowIso() });
        msg.history.push({ at: nowIso(), state: 'unknown', note: why });
        moved.push(msg);
      }
      if (moved.length) this.save(data);
      return moved;
    });
  }

  /**
   * Resolve an unknown delivery to what actually happened.
   *
   * The basis is required and is not decoration. The only way out of `unknown`
   * is a human who went and looked, and six months from now the question will
   * not be what the outbox says — it will be how the operator knew. "checked
   * the sent folder, the message is there, timestamped 14:02" is an answer.
   * A bare state change is not.
   */
  reconcile(id, outcome, basis) {
    if (!['sent', 'failed'].includes(outcome)) {
      throw new OutboxError(`reconcile to 'sent' or 'failed', not '${outcome}'`);
    }
    const text = basis == null ? '' : String(basis).trim();
    if (text.length < 10) {
      throw new OutboxError(
        'reconciling an unknown delivery requires a basis: what did you check, '
        + 'and what did it show? (e.g. "sent folder of the records mailbox shows '
        + 'it at 14:02, no bounce")');
    }
    const msg = this.get(id);
    if (!msg) throw new OutboxError(`no message ${id}`);
    if (msg.state !== 'unknown') {
      throw new OutboxError(
        `${id} is '${msg.state}', not 'unknown' — there is no unresolved outcome to reconcile.`);
    }
    return this._transition(id, outcome, {
      reconciled_at: nowIso(),
      reconciled_basis: text,
      ...(outcome === 'sent' ? { sent_at: msg.unknown_at || nowIso() } : { error: `unresolved: ${msg.unknown_reason || ''}` }),
    }, `reconciled to ${outcome} — ${text}`);
  }

  /** Everything waiting on a human to establish what happened. */
  unresolved() {
    return this.load().messages.filter((m) => m.state === 'unknown' || m.state === 'in_flight');
  }
}

module.exports = {
  Outbox, OutboxError, bodyHash, classifyError,
  STATES, OPEN_STATES, TRANSITIONS, defaultPath,
};
