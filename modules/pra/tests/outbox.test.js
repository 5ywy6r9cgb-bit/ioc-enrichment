'use strict';
/**
 * tests/outbox.test.js — the approval gate.
 *
 * Every test here is about something that must NOT be possible. A letter to a
 * records custodian cannot be unsent, and this repository has already found
 * three tracker defects that reached drafted correspondence. The gate is the
 * only thing standing between the next such defect and the operator's mail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const { Outbox, OutboxError, bodyHash, TRANSITIONS } = require('../server/outbox.js');

function tmp() {
  return new Outbox(path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-')), 'outbox.json'));
}

const LETTER = 'To whom it may concern,\n\nThis follows up on the above public '
  + 'records request. Please provide a status update at your earliest convenience.\n\nThank you,';

function draft(ob, over = {}) {
  return ob.queue(Object.assign({
    request_id: 'PRR-2026-391',
    to: 'records@gahanna.gov',
    subject: 'Follow-up — Public Records Request PRR-2026-391',
    body: LETTER,
  }, over));
}

module.exports = function run() {
  H.suite('outbox');

  // ══ nothing sends without a signature ═════════════════════════════════
  {
    const ob = tmp();
    const m = draft(ob);
    H.eq('a queued message starts as a draft', m.state, 'drafted');
    H.check('and a draft is NOT sendable', ob.sendable(m).ok === false);
    H.check('the refusal says it is unapproved',
      /not approved/.test(ob.sendable(m).reason), ob.sendable(m).reason);

    ob.approve(m.message_id, 'Mark');
    const approved = ob.get(m.message_id);
    H.check('an approved message is sendable', ob.sendable(approved).ok === true);
    H.eq('and records who signed it', approved.approved_by, 'Mark');
    H.check('and when', /^\d{4}-\d{2}-\d{2}T/.test(approved.approved_at));
  }

  // ══ THE ONE THAT MATTERS: approval is bound to the exact text ═════════
  {
    const ob = tmp();
    const m = draft(ob);
    ob.approve(m.message_id);

    // Simulate the desk re-drafting after the request crosses a threshold:
    // the polite enquiry becomes an escalation, carrying the old sign-off.
    const data = ob.load();
    const live = data.messages.find((x) => x.message_id === m.message_id);
    live.body = LETTER + '\n\nStatutory damages continue to accrue.';
    ob.save(data);

    const gate = ob.sendable(ob.get(m.message_id));
    H.check('a message edited after approval is REFUSED', gate.ok === false);
    H.check('and the reason says the text changed',
      /changed after it was approved/.test(gate.reason), gate.reason);
    H.check('it tells you to read it again',
      /read it again/i.test(gate.reason), gate.reason);

    // The recipient is covered too — redirecting an approved letter is worse
    // than editing it.
    const ob2 = tmp();
    const m2 = draft(ob2);
    ob2.approve(m2.message_id);
    const d2 = ob2.load();
    d2.messages[0].to = 'someone.else@example.com';
    ob2.save(d2);
    H.check('changing the RECIPIENT also voids the approval',
      ob2.sendable(ob2.get(m2.message_id)).ok === false);

    // Re-approving the new text is the correct path back.
    ob2.approve(m2.message_id);
    H.check('re-approving the changed text restores sendability',
      ob2.sendable(ob2.get(m2.message_id)).ok === true);
  }

  // ══ a sent message is finished ════════════════════════════════════════
  {
    const ob = tmp();
    const m = draft(ob);
    ob.approve(m.message_id);
    ob.markSent(m.message_id, { messageId: '<abc@mail>' });
    const sent = ob.get(m.message_id);
    H.eq('it is marked sent', sent.state, 'sent');
    H.check('with the provider receipt kept', sent.receipt.messageId === '<abc@mail>');
    H.check('and it is no longer sendable', ob.sendable(sent).ok === false);
    H.check('the reason is that it already went',
      /already sent/.test(ob.sendable(sent).reason));
    H.throws('a sent message cannot be re-approved',
      () => ob.approve(m.message_id), 'already gone out');
    H.throws('nor re-sent',
      () => ob.markSent(m.message_id), 'already gone out');
    H.eq('sent is a terminal state', TRANSITIONS.sent.length, 0);
  }

  // ══ failure is recorded, never silently retried ═══════════════════════
  {
    const ob = tmp();
    const m = draft(ob);
    ob.approve(m.message_id);
    ob.markFailed(m.message_id, 'connection refused');
    const failed = ob.get(m.message_id);
    H.eq('a failed send is recorded', failed.state, 'failed');
    H.check('with the error kept', /connection refused/.test(failed.error));
    H.eq('and failed is terminal — a retry is a NEW message', TRANSITIONS.failed.length, 0);
    H.check('a failed message is not sendable', ob.sendable(failed).ok === false);
  }

  // ══ rejection is on the record ════════════════════════════════════════
  {
    const ob = tmp();
    const m = draft(ob);
    H.throws('a rejection must carry a reason',
      () => ob.reject(m.message_id, ''), 'say why');
    ob.reject(m.message_id, 'tone too aggressive for a first follow-up');
    const r = ob.get(m.message_id);
    H.eq('the message is kept, not deleted', r.state, 'rejected');
    H.check('with the reason attached', /tone too aggressive/.test(r.rejected_reason));
    H.check('and it can never be sent', ob.sendable(r).ok === false);
    H.throws('nor approved afterwards', () => ob.approve(m.message_id), 'cannot become');
    H.check('there is no delete method',
      typeof ob.delete === 'undefined' && typeof ob.remove === 'undefined');
  }

  // ══ one pending letter per request ════════════════════════════════════
  {
    const ob = tmp();
    draft(ob);
    H.throws('a second pending draft for one request is refused',
      () => draft(ob), 'already has a drafted message');
    // Once it is out of the way, another may be queued.
    const first = ob.list()[0];
    ob.reject(first.message_id, 'superseded');
    H.check('after the first is resolved, a new one may be queued',
      draft(ob).state === 'drafted');
  }

  // ══ input the queue refuses outright ══════════════════════════════════
  {
    const ob = tmp();
    H.throws('no request id', () => ob.queue({ to: 'a@b.c', subject: 's', body: LETTER }),
      'request_id is required');
    H.throws('no recipient', () => ob.queue({ request_id: 'R', subject: 's', body: LETTER }),
      'recipient address is required');
    H.throws('no subject', () => ob.queue({ request_id: 'R', to: 'a@b.c', body: LETTER }),
      'subject is required');
    H.throws('an empty body is refused rather than mailed',
      () => ob.queue({ request_id: 'R', to: 'a@b.c', subject: 's', body: '' }),
      'implausibly short');
    H.throws('and so is a suspiciously short one',
      () => ob.queue({ request_id: 'R', to: 'a@b.c', subject: 's', body: 'ok thanks' }),
      'implausibly short');
  }

  // ══ the store itself ══════════════════════════════════════════════════
  {
    const ob = tmp();
    H.eq('a missing outbox reads as empty', ob.list().length, 0);
    draft(ob);
    H.check('the file is written owner-only',
      (fs.statSync(ob.file).mode & 0o077) === 0,
      (fs.statSync(ob.file).mode & 0o777).toString(8));

    const bad = tmp();
    fs.mkdirSync(path.dirname(bad.file), { recursive: true });
    fs.writeFileSync(bad.file, '{ not json');
    H.throws('a corrupt outbox refuses to load', () => bad.list(), 'not valid JSON');
    H.check('and says what the file is for',
      (() => { try { bad.list(); } catch (e) {
        return /what was approved and what was sent/.test(e.message); } })());
    H.eq('and is left untouched', fs.readFileSync(bad.file, 'utf8'), '{ not json');

    H.throws('an unknown message id is refused',
      () => ob.approve('MSG-NOPE'), 'no message MSG-NOPE');
  }

  // ══ every state change is appended, never overwritten ═════════════════
  {
    const ob = tmp();
    const m = draft(ob);
    ob.approve(m.message_id, 'Mark');
    ob.markSent(m.message_id, { messageId: '<x@y>' });
    const h = ob.get(m.message_id).history;
    H.eq('three transitions, three entries', h.length, 3);
    H.eq('in order', h.map((x) => x.state).join(','), 'drafted,approved,sent');
    H.check('each timestamped', h.every((x) => /^\d{4}-\d{2}-\d{2}T/.test(x.at)));
    H.check('the approver is named in the history',
      /approved by Mark/.test(h[1].note), h[1].note);
  }

  // ══ the hash covers what decides where it lands ═══════════════════════
  {
    const base = { to: 'a@b.c', cc: null, subject: 's', body: LETTER };
    const h = bodyHash(base);
    H.check('body changes the hash',
      bodyHash(Object.assign({}, base, { body: LETTER + '!' })) !== h);
    H.check('recipient changes the hash',
      bodyHash(Object.assign({}, base, { to: 'x@y.z' })) !== h);
    H.check('cc changes the hash',
      bodyHash(Object.assign({}, base, { cc: 'x@y.z' })) !== h);
    H.check('subject changes the hash',
      bodyHash(Object.assign({}, base, { subject: 'other' })) !== h);
    H.check('and it is stable across calls', bodyHash(base) === h);
  }
};

if (require.main === module) { module.exports(); process.exit(H.report()); }
