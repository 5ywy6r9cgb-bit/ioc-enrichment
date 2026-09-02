'use strict';
/**
 * server/foia_tracker.js — the escalation ladder.
 *
 * deadline_engine.js answers "is this request past my follow-up cadence?"
 * This file answers the harder question: "given everything I know about this
 * request, what is the next move, and what am I actually entitled to say?"
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS REPLACES foia_agent.py
 *
 * The Python agent this supersedes had three defects, and all three reached
 * the drafted letters, which is the worst place for them to be:
 *
 *  1. IT INVENTED A STATUTORY DEADLINE. It carried
 *     ORC_PROMPT_RESPONSE_BUSINESS_DAYS = 10 and reported requests as having
 *     "crossed the ORC 149.43 benchmark." R.C. 149.43(B)(1) contains no day
 *     count at all — inspection is "promptly," copies come "within a
 *     reasonable period of time," and reasonableness is fact-specific. A
 *     letter asserting a missed statutory deadline that does not exist is a
 *     false claim of legal entitlement made to a public office, and it hands
 *     them the cheapest possible reason to disregard everything else in the
 *     letter. Every Ohio threshold here is therefore OPERATOR CADENCE and is
 *     labelled as such in the output; deadline_engine.assertNoOhioStatutory
 *     enforces the same rule structurally.
 *
 *  2. ITS DAMAGES MATH WAS WRONG IN THREE PLACES AT ONCE. It computed
 *     min(1000, business_days_since_FILING * 100) and reported the result as
 *     "statutory_damages_accrued_estimate" on requests where nothing had been
 *     filed in court. Under R.C. 149.43(C)(2) statutory damages (a) exist only
 *     where the requester has commenced a mandamus action, (b) accrue from the
 *     date that action is filed — not from the date of the records request —
 *     and (c) are available only where the request was transmitted by hand
 *     delivery, electronic submission, or certified mail. They are also
 *     awarded by a court, which may reduce or deny them entirely. The model
 *     below refuses to report accrual until those predicates are recorded as
 *     true, and reports WHY when it declines.
 *
 *  3. A DENIAL PRODUCED NO ACTION. `status in ("produced","denied")` returned
 *     "closed, no clock action needed." A denial is the most actionable state
 *     a request can be in — it is the moment appeal and mandamus options
 *     crystallise and the moment the agency's stated exemption becomes a thing
 *     you can test. Here a denial is the highest priority in the ladder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO
 *
 * It proposes. It does not send, file, or decide. Every rung returns a
 * `sendable` flag and an explicit `operator_decision` note where the next step
 * is a judgment call rather than a mechanical one. Filing in the Court of
 * Claims is never proposed as an action — only ever surfaced as an option the
 * operator may want to discuss with counsel.
 */

const clock = require('./deadline_engine.js');

class TrackerError extends Error {}

/**
 * Delivery methods that satisfy the R.C. 149.43(C)(2) transmission predicate.
 * A request handed over at a counter with no receipt, or made by phone, does
 * not qualify — and the difference is invisible unless you record it, which is
 * exactly why `delivery_method` is a first-class field rather than a note.
 */
const DAMAGES_ELIGIBLE_DELIVERY = new Set([
  'hand_delivery', 'certified_mail', 'electronic',
]);

const DAMAGES_PER_BUSINESS_DAY = 100;
const DAMAGES_CAP = 1000;

/** Terminal states: the clock genuinely stops. */
const CLOSED_STATES = new Set(['closed', 'published', 'withdrawn']);

/**
 * The ladder, in priority order. The FIRST rung whose test passes wins, so
 * order is the policy: a denial outranks an overdue clock, and an overdue
 * clock outranks a routine nudge.
 */
const RUNGS = [
  'denied_needs_review',
  'partial_needs_completion',
  'fee_quote_pending',
  'no_response_escalate',
  'no_response_followup',
  'awaiting_agency',
  'no_action',
];

const RUNG_LABEL = {
  denied_needs_review: 'DENIAL — read the stated exemption',
  partial_needs_completion: 'PARTIAL — press for the remainder',
  fee_quote_pending: 'FEE QUOTED — decide before the clock runs',
  no_response_escalate: 'SILENT — escalate the channel',
  no_response_followup: 'SILENT — routine follow-up',
  awaiting_agency: 'acknowledged, within cadence',
  no_action: 'nothing due',
};

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Statutory-damages posture under R.C. 149.43(C)(2).
 *
 * Returns a shape that always explains itself. `accrued_usd` is null — not
 * zero — when the predicates are not met, because zero reads as "the court
 * awarded nothing" and null reads as "this question is not live yet." That
 * distinction is the whole point of the function.
 *
 * NOT LEGAL ADVICE, and the returned object says so. The cap, the rate and the
 * predicates are mechanical; whether a court awards anything is not, and
 * (C)(2)(c) lets a court reduce or deny where a well-informed public office
 * reasonably believed its conduct was lawful.
 */
function damagesPosture(request, today = new Date()) {
  const delivery = request.delivery_method || null;
  const mandamusFiled = toDate(request.mandamus_filed_on);

  const eligibleDelivery = delivery ? DAMAGES_ELIGIBLE_DELIVERY.has(delivery) : null;

  const out = {
    statute: 'R.C. 149.43(C)(2)',
    rate_usd_per_business_day: DAMAGES_PER_BUSINESS_DAY,
    cap_usd: DAMAGES_CAP,
    delivery_method: delivery,
    delivery_qualifies: eligibleDelivery,
    mandamus_filed_on: mandamusFiled ? mandamusFiled.toISOString().slice(0, 10) : null,
    accruing: false,
    accrued_usd: null,
    business_days_since_mandamus: null,
    basis: '',
    not_legal_advice: true,
  };

  if (!mandamusFiled) {
    out.basis =
      'No mandamus action recorded. Statutory damages under R.C. 149.43(C)(2) '
      + 'do not accrue from the date of a records request — they run from the '
      + 'day a mandamus action is filed. Nothing has accrued and no figure '
      + 'should appear in correspondence.';
    return out;
  }

  if (eligibleDelivery === false) {
    out.basis =
      `Mandamus recorded, but delivery_method='${delivery}' does not satisfy the `
      + 'transmission predicate. R.C. 149.43(C)(2) reaches requests delivered by '
      + 'hand delivery, electronic submission, or certified mail. Treat damages '
      + 'as unavailable unless the delivery record is wrong.';
    return out;
  }

  if (eligibleDelivery === null) {
    out.basis =
      'Mandamus recorded, but delivery_method is not on file. The transmission '
      + 'predicate cannot be confirmed, so no figure is computed. Record how the '
      + 'request was actually delivered.';
    return out;
  }

  const days = clock.businessDaysBetween(mandamusFiled, toDate(today));
  out.accruing = true;
  out.business_days_since_mandamus = days;
  out.accrued_usd = Math.min(DAMAGES_CAP, days * DAMAGES_PER_BUSINESS_DAY);
  out.basis =
    `${days} business day(s) since the mandamus action was filed, at `
    + `$${DAMAGES_PER_BUSINESS_DAY}/business day, capped at $${DAMAGES_CAP}. `
    + 'A court awards this, and R.C. 149.43(C)(2)(c) permits reduction or denial '
    + 'where a well-informed public office reasonably believed its conduct lawful. '
    + 'This is an upper bound on the arithmetic, not a prediction of an award.';
  return out;
}

/**
 * Has the operator already reached out recently enough that another letter
 * would just be noise?
 *
 * Derived from recorded correspondence, never from a hand-maintained
 * `last_followup_date` field. The Python agent depended on the operator
 * remembering to edit that field, which means in practice it nags — the guard
 * silently stops working the first time somebody forgets.
 */
function recentOutreach(request, today, quietBusinessDays) {
  const outbound = (request.correspondence || [])
    .filter((c) => (c.direction || '').toLowerCase() === 'outbound')
    .map((c) => toDate(c.occurred_at || c.date))
    .filter(Boolean)
    .sort((a, b) => b - a);

  const explicit = toDate(request.last_followup_on || request.last_followup_date);
  const latest = outbound[0] && explicit
    ? (outbound[0] > explicit ? outbound[0] : explicit)
    : (outbound[0] || explicit);

  if (!latest) return { quiet: false, last: null, businessDaysSince: null };
  const since = clock.businessDaysBetween(latest, today);
  return {
    quiet: since < quietBusinessDays,
    last: latest.toISOString().slice(0, 10),
    businessDaysSince: since,
  };
}

/**
 * Evaluate one request and return the single next move.
 *
 * `policy` carries the operator's OWN cadence. None of it is law, and the
 * output labels every threshold `operator_policy` so a number cannot be
 * mistaken for an entitlement on its way into a letter.
 */
function evaluate(request, opts = {}) {
  if (!request || !request.request_id) {
    throw new TrackerError('foia_tracker: request_id is required');
  }

  const today = toDate(opts.today) || new Date();
  const policy = Object.assign({
    followup_after_business_days: 10,
    escalate_after_business_days: 20,
    quiet_period_business_days: 5,
    fee_decision_business_days: 5,
  }, opts.policy || {});

  const filed = toDate(request.submitted_on || request.filed_date);
  const status = String(request.status || 'submitted').toLowerCase();
  const jurisdiction = request.jurisdiction_scope || 'OH';

  const base = {
    request_id: request.request_id,
    agency: request.agency_name || request.agency || null,
    account_track: request.account_track || null,
    status,
    jurisdiction_scope: jurisdiction,
    filed_on: filed ? filed.toISOString().slice(0, 10) : null,
    business_days_elapsed: filed ? clock.businessDaysBetween(filed, today) : null,
    // Ohio has no statutory clock. Say so in the payload, every time, so a
    // consumer that renders this cannot accidentally imply one.
    deadline_basis: jurisdiction === 'US'
      ? 'statutory (5 U.S.C. 552(a)(6)(A)(i), 20 business days)'
      : 'operator_policy (R.C. 149.43 sets no fixed day count)',
    damages: damagesPosture(request, today),
  };

  if (CLOSED_STATES.has(status)) {
    return Object.assign(base, {
      rung: 'no_action',
      label: RUNG_LABEL.no_action,
      priority: RUNGS.indexOf('no_action'),
      reason: `Status is '${status}'. The request is closed; the clock is stopped.`,
      sendable: false,
      operator_decision: null,
    });
  }

  if (!filed) {
    return Object.assign(base, {
      rung: 'no_action',
      label: RUNG_LABEL.no_action,
      priority: RUNGS.indexOf('no_action'),
      reason: 'No submission date on file, so no clock can be computed. '
        + 'Record when this was actually sent before relying on any tracker output.',
      sendable: false,
      operator_decision: 'Record the submission date.',
    });
  }

  const elapsed = base.business_days_elapsed;
  const outreach = recentOutreach(request, today, policy.quiet_period_business_days);

  const rung = (name, reason, extra = {}) => Object.assign(base, {
    rung: name,
    label: RUNG_LABEL[name],
    priority: RUNGS.indexOf(name),
    reason,
    last_outreach_on: outreach.last,
    business_days_since_outreach: outreach.businessDaysSince,
    sendable: true,
    operator_decision: null,
  }, extra);

  // ── 1. DENIAL ─────────────────────────────────────────────────────────
  // The rung the old agent treated as "closed, no action." A denial is where
  // the agency finally commits to a position you can actually test.
  if (status === 'denied') {
    const cited = request.denial_basis || null;
    return rung('denied_needs_review',
      cited
        ? `Denied, citing: ${cited}. Read the cited exemption against what was `
          + 'asked for, and check whether R.C. 149.43(B)(1) severability applies — '
          + 'an office must release the portions it can and redact the rest, not '
          + 'refuse the record whole.'
        : 'Denied with no exemption recorded on file. R.C. 149.43(B)(3) requires '
          + 'a denial to explain itself, including the legal authority relied on. '
          + 'A denial with no stated basis is itself the thing to press.',
      {
        sendable: false,
        operator_decision:
          'Judgment call, not mechanical: (a) request the statutory explanation '
          + 'if none was given, (b) narrow and refile, or (c) discuss mandamus '
          + 'with counsel. This tracker does not propose litigation.',
      });
  }

  // ── 2. PARTIAL ────────────────────────────────────────────────────────
  if (status === 'partial') {
    return rung('partial_needs_completion',
      `Partial production received. ${elapsed} business day(s) since filing. `
      + 'A partial response does not close a request — identify precisely what is '
      + 'still outstanding and ask for that, by name, rather than re-sending the '
      + 'original scope.');
  }

  // ── 3. FEE QUOTE ──────────────────────────────────────────────────────
  if (status === 'fee_quoted' || request.fee_quoted_usd != null) {
    const quoted = toDate(request.fee_quoted_on);
    const since = quoted ? clock.businessDaysBetween(quoted, today) : null;
    return rung('fee_quote_pending',
      `Fee of $${request.fee_quoted_usd ?? '?'} quoted`
      + (since != null ? `, ${since} business day(s) ago` : '')
      + '. Ohio permits the actual cost of copies, not staff search time. '
      + 'Decide: pay, narrow the scope, or ask for the itemisation.',
      {
        sendable: false,
        operator_decision: 'Cost decision is yours; the tracker will not spend money.',
      });
  }

  // ── 4/5. SILENCE ──────────────────────────────────────────────────────
  if (outreach.quiet) {
    return Object.assign(base, {
      rung: 'awaiting_agency',
      label: RUNG_LABEL.awaiting_agency,
      priority: RUNGS.indexOf('awaiting_agency'),
      reason: `Follow-up already sent ${outreach.businessDaysSince} business day(s) `
        + `ago (quiet period ${policy.quiet_period_business_days}). Sending again `
        + 'this soon reads as pressure rather than diligence.',
      last_outreach_on: outreach.last,
      business_days_since_outreach: outreach.businessDaysSince,
      sendable: false,
      operator_decision: null,
    });
  }

  if (elapsed >= policy.escalate_after_business_days) {
    return rung('no_response_escalate',
      `${elapsed} business day(s) with no substantive response, past the operator `
      + `cadence of ${policy.escalate_after_business_days}. This is YOUR threshold, `
      + 'not a statutory one. Escalate the channel — named records custodian, or '
      + 'certified mail, which also puts the R.C. 149.43(C)(2) transmission '
      + 'predicate beyond argument if this ever goes further.',
      {
        operator_decision:
          'Whether to involve counsel is a separate decision this tracker does not make.',
      });
  }

  if (elapsed >= policy.followup_after_business_days) {
    return rung('no_response_followup',
      `${elapsed} business day(s) elapsed, past the operator follow-up cadence of `
      + `${policy.followup_after_business_days}. Routine status enquiry — offer to `
      + 'narrow the scope, and do not cite damages at this rung.');
  }

  return Object.assign(base, {
    rung: 'awaiting_agency',
    label: RUNG_LABEL.awaiting_agency,
    priority: RUNGS.indexOf('awaiting_agency'),
    reason: `${elapsed} business day(s) elapsed, inside the operator cadence of `
      + `${policy.followup_after_business_days}.`,
    last_outreach_on: outreach.last,
    business_days_since_outreach: outreach.businessDaysSince,
    sendable: false,
    operator_decision: null,
  });
}

/**
 * Draft the follow-up for a rung.
 *
 * TONE IS A SAFETY FEATURE. The superseded template opened every letter —
 * including a day-16 routine nudge — by quoting the statutory-damages
 * provision. Leading with damages against a clerk who was going to produce
 * anyway converts a cooperative custodian into a defensive one, and it costs
 * you the next five requests as well as this one. Damages are mentioned at
 * exactly one rung, escalation, and only when the posture object says they are
 * actually live.
 */
function draftFollowup(evaluation, request, operator = {}) {
  const name = operator.name || request.requester || 'Requester';
  const id = evaluation.request_id;
  const filed = evaluation.filed_on;
  const days = evaluation.business_days_elapsed;

  if (!evaluation.sendable) return null;

  const head = `Subject: Follow-up — Public Records Request ${id}\n\n`
    + 'To the Records Custodian,\n\n';
  const tail = `\n\nThank you for your time,\n${name}\n`;

  if (evaluation.rung === 'partial_needs_completion') {
    return head
      + `This follows up on request ${id}, filed ${filed} under Ohio's Public `
      + 'Records Act (R.C. 149.43). I have received a partial production and am '
      + 'grateful for it.\n\n'
      + 'Records responsive to the following portion of the request do not appear '
      + 'in what was produced:\n\n'
      + '    [name the specific outstanding items here]\n\n'
      + 'If those records exist, please advise when they will be produced. If they '
      + 'do not exist, or are being withheld, please say which, and — where records '
      + 'are withheld — the legal authority relied on, as R.C. 149.43(B)(3) provides.'
      + tail;
  }

  if (evaluation.rung === 'no_response_followup') {
    return head
      + `This is a routine status enquiry on request ${id}, filed ${filed} under `
      + `Ohio's Public Records Act (R.C. 149.43). ${days} business days have passed `
      + 'and I have not yet received a response.\n\n'
      + 'Could you confirm the request was received, and give an estimated date for '
      + 'production? If the scope is causing difficulty, I am glad to narrow it — '
      + 'please tell me which part is burdensome and I will revise it.'
      + tail;
  }

  if (evaluation.rung === 'no_response_escalate') {
    const d = evaluation.damages;
    const damagesLine = d.accruing
      ? '\n\nAs this office is aware, a mandamus action is pending in this matter.'
      : '';
    return head
      + `I am following up again on request ${id}, filed ${filed} under Ohio's `
      + `Public Records Act (R.C. 149.43). ${days} business days have now passed `
      + 'without a substantive response, and my earlier enquiry has not been '
      + 'answered.\n\n'
      + 'R.C. 149.43(B)(1) requires that records be made available for inspection '
      + 'promptly and that copies be provided within a reasonable period of time. '
      + 'I am asking for one of three things, whichever is accurate: the records; '
      + 'a date certain by which they will be produced; or, if any portion is being '
      + 'withheld, notice of that with the legal authority relied on.\n\n'
      + 'If the request is too broad as written, tell me which part and I will '
      + 'narrow it today.'
      + damagesLine
      + tail;
  }

  return null;
}

/** Rank a portfolio of requests: what needs you, most-urgent first. */
function triage(requests, opts = {}) {
  const evaluated = (requests || []).map((r) => {
    const ev = evaluate(r, opts);
    return { evaluation: ev, request: r };
  });

  const needsAttention = evaluated.filter(
    (e) => e.evaluation.rung !== 'no_action' && e.evaluation.rung !== 'awaiting_agency'
  );
  needsAttention.sort((a, b) => {
    if (a.evaluation.priority !== b.evaluation.priority) {
      return a.evaluation.priority - b.evaluation.priority;
    }
    return (b.evaluation.business_days_elapsed || 0) - (a.evaluation.business_days_elapsed || 0);
  });

  return {
    run_at: (toDate(opts.today) || new Date()).toISOString(),
    total: evaluated.length,
    needs_attention: needsAttention.length,
    // Stated once, at the top, so any renderer inherits it.
    clock_note: 'Ohio thresholds in this report are the operator\'s own follow-up '
      + 'cadence. R.C. 149.43 sets no fixed day count.',
    items: needsAttention.map((e) => e.evaluation),
    all: evaluated.map((e) => e.evaluation),
  };
}

module.exports = {
  evaluate, triage, draftFollowup, damagesPosture, recentOutreach,
  RUNGS, RUNG_LABEL, DAMAGES_ELIGIBLE_DELIVERY,
  DAMAGES_PER_BUSINESS_DAY, DAMAGES_CAP, TrackerError,
};
