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
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class OutboxError extends Error {}

const STATES = ['drafted', 'approved', 'sent', 'failed', 'rejected'];

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
  approved: ['approved', 'sent', 'failed', 'rejected'],
  sent:     [],
  failed:   [],
  rejected: [],
};

function defaultPath() {
  if (process.env.PRA_OUTBOX) return process.env.PRA_OUTBOX;
  return path.resolve(__dirname, '..', '..', '..', 'evidence', 'outbox.json');
}

function nowIso() { return new Date().toISOString(); }

/** The signature covers the body AND the addressing that decides where it lands. */
function bodyHash(msg) {
  const canonical = JSON.stringify({
    to: msg.to, cc: msg.cc || null, subject: msg.subject, body: msg.body,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

class Outbox {
  constructor(file) { this.file = file || defaultPath(); }

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

    const data = this.load();

    // A second pending draft for one request is how an agency receives the
    // same enquiry twice in a morning.
    const pending = data.messages.find(
      (m) => m.request_id === request_id && ['drafted', 'approved'].includes(m.state));
    if (pending) {
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

  _transition(id, to, patch, note) {
    const data = this.load();
    const msg = data.messages.find((m) => m.message_id === id);
    if (!msg) throw new OutboxError(`no message ${id}`);
    const allowed = TRANSITIONS[msg.state] || [];
    if (!allowed.includes(to)) {
      throw new OutboxError(
        `${id} is '${msg.state}' and cannot become '${to}'`
        + (msg.state === 'sent' ? ' — it has already gone out.' : '.'));
    }
    Object.assign(msg, patch, { state: to });
    msg.history.push(Object.assign({ at: nowIso(), state: to }, note ? { note } : {}));
    this.save(data);
    return msg;
  }

  /** Sign off on one message. Records WHAT was approved, not merely that something was. */
  approve(id, who) {
    const msg = this.get(id);
    if (!msg) throw new OutboxError(`no message ${id}`);
    return this._transition(id, 'approved', {
      approved_at: nowIso(),
      approved_hash: bodyHash(msg),
      approved_by: who || process.env.PRA_OPERATOR_NAME || 'operator',
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
}

module.exports = { Outbox, OutboxError, bodyHash, STATES, TRANSITIONS, defaultPath };
