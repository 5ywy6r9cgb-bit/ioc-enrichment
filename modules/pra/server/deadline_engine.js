'use strict';
/**
 * server/deadline_engine.js — the clock.
 *
 * THE THING THIS FILE EXISTS TO GET RIGHT
 *
 * Ohio R.C. 149.43 sets no fixed day count. Inspection is "promptly"; copies
 * come "within a reasonable period of time." So every Ohio number in
 * deadline_rules is the OPERATOR'S OWN follow-up cadence, and this engine
 * refuses to describe one as a legal deadline.
 *
 * That is not pedantry. If a letter over your name says "you have missed the
 * statutory deadline" and Ohio has no such deadline, you have made a false
 * claim of legal entitlement to a public office — and handed them the easiest
 * possible reason to dismiss everything else you said. The engine therefore
 * asserts, on every evaluation, that no Ohio rule is marked statutory, and
 * throws if one ever is.
 *
 * Day math is done in whole calendar days on UTC dates, so a run at 23:00 and a
 * run at 01:00 the next morning do not disagree about how many days old
 * something is.
 */

class ClockError extends Error {}

/** Whole days between two dates, ignoring time of day. */
function daysBetween(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / 86400000);
}

/**
 * Business days between two dates, counting Mon–Fri only.
 *
 * Federal holidays are NOT subtracted. That is deliberate and stated rather
 * than hidden: a holiday calendar that is wrong is worse than one that is
 * absent, because it produces a confidently incorrect date. This count is
 * therefore an upper bound on elapsed business days — it can only make you
 * follow up slightly early, never late.
 */
function businessDaysBetween(from, to) {
  let count = 0;
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cur.getTime() < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) count += 1;
  }
  return count;
}

/**
 * The anchor a rule counts from, for a given request.
 * A rule that applies to a status counts from when the request ENTERED that
 * state — not from creation — so an acknowledgement re-baselines the clock
 * instead of leaving a request permanently "30 days late".
 */
function anchorFor(request, rule) {
  switch (rule.applies_to_status) {
    case 'submitted':     return request.submitted_at || null;
    case 'acknowledged':  return request.acknowledged_at || null;
    case 'denied':
    case 'partial':       return request.first_response_at || null;
    default:              return request.submitted_at || request.created_at || null;
  }
}

/**
 * A rule is live for a request only if the request is actually in that state.
 * Without this, a denied request would still be evaluated against the
 * "no acknowledgement" rule and produce a nonsense action.
 */
function ruleApplies(request, rule) {
  if (!rule.active) return false;
  if (rule.applies_to_status && request.status !== rule.applies_to_status) return false;
  // Once the office has answered, the "silence" rules stop applying.
  if (['submitted'].includes(rule.applies_to_status) && request.first_response_at) return false;
  if (['closed', 'published'].includes(request.status)) return false;
  return true;
}

/** Jurisdiction match: 'OH' rules apply to Ohio requests, 'US' to federal. */
function scopeMatches(rule, jurisdictionScope) {
  if (!rule.jurisdiction_scope) return true;
  return rule.jurisdiction_scope === (jurisdictionScope || 'OH');
}

/**
 * The safety assertion. Called on every evaluation, not just at seed time,
 * because a rule can be edited in the database after seeding.
 */
function assertNoOhioStatutory(rules) {
  const offenders = rules.filter((r) => r.jurisdiction_scope === 'OH' && r.rule_basis === 'statutory');
  if (offenders.length) {
    throw new ClockError(
      'deadline_engine: an Ohio rule is marked rule_basis=statutory: '
      + offenders.map((r) => r.rule_id).join(', ')
      + '\n  Ohio R.C. 149.43 sets NO fixed day count. Labelling a cadence as statutory '
      + 'would put a false claim of legal entitlement into a letter. Fix the rule row.'
    );
  }
}

/**
 * Evaluate one request against all rules.
 * Returns the breaches, most overdue first. Never throws for ordinary data.
 */
function evaluateRequest(request, rules, { now = new Date(), jurisdictionScope = 'OH' } = {}) {
  assertNoOhioStatutory(rules);
  const out = [];

  for (const rule of rules) {
    if (!scopeMatches(rule, jurisdictionScope)) continue;
    if (!ruleApplies(request, rule)) continue;

    const anchorRaw = anchorFor(request, rule);
    if (!anchorRaw) continue;
    const anchor = anchorRaw instanceof Date ? anchorRaw : new Date(anchorRaw);
    if (Number.isNaN(anchor.getTime())) continue;

    const elapsed = rule.day_basis === 'business'
      ? businessDaysBetween(anchor, now)
      : daysBetween(anchor, now);

    if (rule.days == null || elapsed < rule.days) continue;

    out.push({
      request_id: request.request_id,
      rule_id: rule.rule_id,
      label: rule.label,
      // The words that go in front of the operator. Never "deadline" for Ohio.
      basis: rule.rule_basis,
      basis_label: rule.rule_basis === 'statutory'
        ? `statutory (${rule.statute_citation || 'citation missing'})`
        : 'your cadence — not a legal deadline',
      days_elapsed: elapsed,
      days_threshold: rule.days,
      days_over: elapsed - rule.days,
      day_basis: rule.day_basis,
      action: rule.action_on_breach,
      template_id: rule.template_id || null,
      anchored_on: rule.applies_to_status || 'submitted',
      anchor_date: anchor.toISOString(),
    });
  }

  // Most overdue first; then by severity of action.
  const SEVERITY = { appeal: 0, escalate: 1, followup: 2, review: 3 };
  out.sort((a, b) => (b.days_over - a.days_over)
    || ((SEVERITY[a.action] ?? 9) - (SEVERITY[b.action] ?? 9)));
  return out;
}

/**
 * Evaluate every request. Returns a triage list: one entry per request that
 * has at least one breach, carrying only its most urgent one plus the count.
 */
function triage(requests, rules, opts = {}) {
  const rows = [];
  for (const req of requests) {
    const breaches = evaluateRequest(req, rules, opts);
    if (!breaches.length) continue;
    rows.push({
      request_id: req.request_id,
      subject: req.subject,
      status: req.status,
      agency_id: req.agency_id,
      top: breaches[0],
      breach_count: breaches.length,
      all: breaches,
    });
  }
  const SEVERITY = { appeal: 0, escalate: 1, followup: 2, review: 3 };
  rows.sort((a, b) => ((SEVERITY[a.top.action] ?? 9) - (SEVERITY[b.top.action] ?? 9))
    || (b.top.days_over - a.top.days_over));
  return rows;
}

/** The next date a request will trip a rule it has not already tripped. */
function nextActionDate(request, rules, { now = new Date(), jurisdictionScope = 'OH' } = {}) {
  assertNoOhioStatutory(rules);
  let best = null;
  for (const rule of rules) {
    if (!scopeMatches(rule, jurisdictionScope) || !ruleApplies(request, rule)) continue;
    const anchorRaw = anchorFor(request, rule);
    if (!anchorRaw || rule.days == null) continue;
    const anchor = anchorRaw instanceof Date ? anchorRaw : new Date(anchorRaw);
    if (Number.isNaN(anchor.getTime())) continue;

    // Business-day rules are approximated forward by calendar weeks; the exact
    // trip date is recomputed on the next evaluation anyway.
    const addDays = rule.day_basis === 'business'
      ? Math.ceil(rule.days * 7 / 5)
      : rule.days;
    const due = new Date(anchor.getTime() + addDays * 86400000);
    if (due > now && (!best || due < best)) best = due;
  }
  return best;
}

module.exports = {
  evaluateRequest, triage, nextActionDate,
  daysBetween, businessDaysBetween, anchorFor, ruleApplies,
  assertNoOhioStatutory, ClockError,
};
