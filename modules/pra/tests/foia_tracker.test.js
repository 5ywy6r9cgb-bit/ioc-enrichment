'use strict';
/**
 * tests/foia_tracker.test.js
 *
 * The first three blocks are REGRESSION GUARDS against defects that shipped in
 * the foia_agent.py this module replaces. They are written as tests rather than
 * comments because all three reached drafted correspondence, and a defect that
 * reaches a letter over the operator's name is not a style question.
 */

const H = require('./_harness.js');
const T = require('../server/foia_tracker.js');

const TODAY = new Date('2026-08-24T12:00:00Z');

function req(over = {}) {
  return Object.assign({
    request_id: 'TSR-REQ-1',
    agency_name: 'Columbus Division of Police',
    submitted_on: '2026-08-01',
    status: 'submitted',
    jurisdiction_scope: 'OH',
  }, over);
}

module.exports = function run() {
  H.suite('foia_tracker');

  // ══ REGRESSION 1: the invented statutory deadline ═════════════════════
  {
    const e = T.evaluate(req({ submitted_on: '2026-06-23' }), { today: TODAY });
    H.check('an Ohio request never reports a statutory deadline basis',
      /operator_policy/.test(e.deadline_basis) && !/statutory/.test(e.deadline_basis),
      e.deadline_basis);
    H.check('the Ohio payload states plainly that no fixed day count exists',
      /no fixed day count/i.test(e.deadline_basis), e.deadline_basis);
    H.check('an overdue Ohio request calls the threshold the operator\'s own',
      /operator cadence/i.test(e.reason) && !/statutory deadline/i.test(e.reason),
      e.reason);

    // A federal request is the one place a statutory clock is real.
    const fed = T.evaluate(req({ jurisdiction_scope: 'US' }), { today: TODAY });
    H.check('a federal request DOES report its statutory basis',
      /statutory/.test(fed.deadline_basis) && /552/.test(fed.deadline_basis),
      fed.deadline_basis);

    const tri = T.triage([req()], { today: TODAY });
    H.check('the portfolio report carries the clock note once, at the top',
      /no fixed day count/i.test(tri.clock_note), tri.clock_note);
  }

  // ══ REGRESSION 2: damages accruing from the wrong date, with no case ═══
  {
    // 44 business days since filing, no mandamus. The old agent reported $1,000.
    const d = T.damagesPosture(req({ submitted_on: '2026-06-23' }), TODAY);
    H.eq('no mandamus on file means NOTHING has accrued', d.accrued_usd, null);
    H.check('accrued is null rather than 0 — the question is not live yet',
      d.accrued_usd === null && d.accruing === false);
    H.check('and it says why, naming the real trigger',
      /do not accrue from the date of a records request/i.test(d.basis)
      && /mandamus/i.test(d.basis), d.basis);

    // Mandamus filed, but the request went by a method the statute doesn't reach.
    const bad = T.damagesPosture(req({
      mandamus_filed_on: '2026-08-10', delivery_method: 'web_form',
    }), TODAY);
    H.eq('a non-qualifying delivery method blocks accrual', bad.accrued_usd, null);
    H.check('and names the transmission predicate',
      /hand delivery, electronic submission, or certified mail/i.test(bad.basis), bad.basis);

    // Delivery unknown: refuse to guess.
    const unk = T.damagesPosture(req({ mandamus_filed_on: '2026-08-10' }), TODAY);
    H.eq('unknown delivery method also blocks accrual', unk.accrued_usd, null);
    H.check('and asks for the missing fact', /not on file/i.test(unk.basis));

    // All predicates met: accrue from the MANDAMUS date, not the filing date.
    const live = T.damagesPosture(req({
      submitted_on: '2026-06-23',
      mandamus_filed_on: '2026-08-17',
      delivery_method: 'certified_mail',
    }), TODAY);
    H.check('with predicates met, damages accrue', live.accruing === true);
    H.eq('5 business days Aug 17 → Aug 24', live.business_days_since_mandamus, 5);
    H.eq('$100/business day from the mandamus date, not the request date',
      live.accrued_usd, 500);
    H.check('the cap is enforced',
      T.damagesPosture(req({
        mandamus_filed_on: '2026-01-01', delivery_method: 'hand_delivery',
      }), TODAY).accrued_usd === T.DAMAGES_CAP);
    H.check('it never claims to predict an award',
      /not a prediction of an award/i.test(live.basis) && live.not_legal_advice === true);
  }

  // ══ REGRESSION 3: a denial produced no_action ═════════════════════════
  {
    const e = T.evaluate(req({ status: 'denied', denial_basis: 'R.C. 149.43(A)(1)(h)' }),
      { today: TODAY });
    H.eq('a denial is the TOP rung, not a closed request', e.rung, 'denied_needs_review');
    H.eq('and outranks every other rung', e.priority, 0);
    H.check('it surfaces the cited exemption for testing',
      /149\.43\(A\)\(1\)\(h\)/.test(e.reason), e.reason);
    H.check('and raises severability rather than accepting a whole-record refusal',
      /severab/i.test(e.reason), e.reason);

    const bare = T.evaluate(req({ status: 'denied' }), { today: TODAY });
    H.check('a denial with no stated basis is itself flagged',
      /149\.43\(B\)\(3\)/.test(bare.reason), bare.reason);

    H.check('a denial is never auto-sendable — it is a judgment call',
      e.sendable === false && /counsel/i.test(e.operator_decision));
    H.check('the tracker refuses to propose litigation itself',
      /does not propose litigation/i.test(e.operator_decision));
  }

  // ══ the ladder ════════════════════════════════════════════════════════
  {
    const within = T.evaluate(req({ submitted_on: '2026-08-20' }), { today: TODAY });
    H.eq('inside cadence: wait', within.rung, 'awaiting_agency');
    H.check('and nothing is sent', within.sendable === false);

    const nudge = T.evaluate(req({ submitted_on: '2026-08-07' }), { today: TODAY });
    H.eq('past follow-up cadence: routine nudge', nudge.rung, 'no_response_followup');

    const esc = T.evaluate(req({ submitted_on: '2026-07-01' }), { today: TODAY });
    H.eq('well past cadence: escalate', esc.rung, 'no_response_escalate');

    const partial = T.evaluate(req({ status: 'partial' }), { today: TODAY });
    H.eq('a partial does not close a request', partial.rung, 'partial_needs_completion');

    const fee = T.evaluate(req({ status: 'fee_quoted', fee_quoted_usd: 47.5 }),
      { today: TODAY });
    H.eq('a fee quote is its own rung', fee.rung, 'fee_quote_pending');
    H.check('spending money is never automatic',
      fee.sendable === false && /will not spend money/i.test(fee.operator_decision));

    for (const st of ['closed', 'published', 'withdrawn']) {
      H.eq(`'${st}' genuinely stops the clock`,
        T.evaluate(req({ status: st }), { today: TODAY }).rung, 'no_action');
    }

    const nofile = T.evaluate(req({ submitted_on: null }), { today: TODAY });
    H.eq('no submission date means no clock', nofile.rung, 'no_action');
    H.check('and it asks for the missing date',
      /Record the submission date/i.test(nofile.operator_decision));
  }

  // ══ dedupe from recorded correspondence, not a hand-edited field ══════
  {
    const quiet = T.evaluate(req({
      submitted_on: '2026-07-01',
      correspondence: [{ direction: 'outbound', occurred_at: '2026-08-21' }],
    }), { today: TODAY });
    H.eq('a recent outbound letter suppresses another', quiet.rung, 'awaiting_agency');
    H.check('and says how recently', /business day\(s\) ago/i.test(quiet.reason));

    const stale = T.evaluate(req({
      submitted_on: '2026-07-01',
      correspondence: [{ direction: 'outbound', occurred_at: '2026-07-15' }],
    }), { today: TODAY });
    H.eq('an old letter does not suppress escalation', stale.rung, 'no_response_escalate');

    const inbound = T.evaluate(req({
      submitted_on: '2026-07-01',
      correspondence: [{ direction: 'inbound', occurred_at: '2026-08-21' }],
    }), { today: TODAY });
    H.eq('an INBOUND message is not our outreach', inbound.rung, 'no_response_escalate');
  }

  // ══ the letters ═══════════════════════════════════════════════════════
  {
    const nudge = T.evaluate(req({ submitted_on: '2026-08-07' }), { today: TODAY });
    const nudgeLetter = T.draftFollowup(nudge, req(), { name: 'The Sentinel Report' });
    H.check('a routine nudge NEVER mentions damages',
      !/damages/i.test(nudgeLetter) && !/\$100/.test(nudgeLetter), nudgeLetter);
    H.check('it offers to narrow the scope',
      /narrow it/i.test(nudgeLetter));
    H.check('and quotes the statute it can actually rely on',
      /149\.43/.test(nudgeLetter));

    const esc = T.evaluate(req({ submitted_on: '2026-07-01' }), { today: TODAY });
    const escLetter = T.draftFollowup(esc, req(), {});
    H.check('escalation without a live case still does not invoke damages',
      !/damages/i.test(escLetter) && !/\$1,000/.test(escLetter), escLetter);
    H.check('it asks for records, a date, or a stated withholding',
      /date certain/i.test(escLetter) && /legal authority/i.test(escLetter));

    const withCase = T.evaluate(req({
      submitted_on: '2026-07-01',
      mandamus_filed_on: '2026-08-17',
      delivery_method: 'certified_mail',
    }), { today: TODAY });
    const caseLetter = T.draftFollowup(withCase, req(), {});
    H.check('only a live mandamus adds the pending-action line',
      /mandamus action is pending/i.test(caseLetter), caseLetter);

    H.eq('a denial drafts no letter — it needs a human first',
      T.draftFollowup(T.evaluate(req({ status: 'denied' }), { today: TODAY }), req(), {}),
      null);
  }

  // ══ triage ordering ═══════════════════════════════════════════════════
  {
    const t = T.triage([
      req({ request_id: 'A', submitted_on: '2026-08-07' }),
      req({ request_id: 'B', status: 'denied' }),
      req({ request_id: 'C', submitted_on: '2026-08-22' }),
      req({ request_id: 'D', submitted_on: '2026-06-01' }),
    ], { today: TODAY });

    H.eq('four in, one inside cadence, three need attention', t.needs_attention, 3);
    H.eq('the denial sorts first', t.items[0].request_id, 'B');
    H.eq('then the most-overdue silence', t.items[1].request_id, 'D');
    H.check('the one inside cadence is excluded from the action list',
      !t.items.some((i) => i.request_id === 'C'));
    H.eq('but every request is still accounted for', t.all.length, 4);
  }

  H.throws('a request with no id is refused',
    () => T.evaluate({}), 'request_id is required');
};

if (require.main === module) { module.exports(); process.exit(H.report()); }
