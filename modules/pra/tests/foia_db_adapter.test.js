'use strict';
/**
 * tests/foia_db_adapter.test.js
 *
 * The first block is a regression guard against a shipped bug that produced
 * the single worst output this system can produce: a calm green sentence
 * saying "Nothing needs you right now" over a request that was 22 business
 * days overdue. Nothing crashed and nothing warned. `foia --db` mapped
 * `submitted_on`, the table stores `submitted_at`, and a request with no
 * submission date correctly has no clock.
 *
 * A tracker that reports a quiet morning it has not verified is worse than no
 * tracker, because it is believed.
 */

const H = require('./_harness.js');
const A = require('../server/foia_db_adapter.js');
const T = require('../server/foia_tracker.js');

const TODAY = new Date('2026-08-25T12:00:00Z');

/** A row shaped like the real requests table. */
function row(over = {}) {
  return Object.assign({
    request_id: 'REQ-TEST-001',
    agency_id: 'franklin-county-board-of-elections',
    status: 'submitted',
    subject: 'Campaign finance — county officeholders',
    submitted_at: '2026-07-25T10:18:38.791Z',
    submission_method: null,
    delivery_method: null,
    mandamus_filed_on: null,
    appeal_filed_at: null,
    exemption_cited: null,
    denial_reason: null,
    fee_quoted: null,
  }, over);
}

module.exports = async function run() {
  H.suite('foia_db_adapter');

  // ══ REGRESSION: the silent no-clock ═══════════════════════════════════
  {
    const m = A.map(row());
    H.eq('submitted_at maps to submitted_on', m.submitted_on, '2026-07-25');
    H.check('a timestamp is truncated to a date, not passed through whole',
      !/T/.test(m.submitted_on), m.submitted_on);

    const e = T.evaluate(m, { today: TODAY });
    H.eq('and the request therefore HAS a clock', e.rung, 'no_response_escalate');
    H.eq('22 business days, not zero', e.business_days_elapsed, 22);
    H.check('it is emphatically not no_action', e.rung !== 'no_action');

    // The structural guard: an unparseable submission column must throw,
    // never yield a request that quietly has no clock.
    H.throws('a submission column that does not parse is a hard failure',
      () => A.map(row({ submitted_at: 'last Tuesday' })),
      'Refusing to return a request with no clock');
    H.check('and the message says why that matters',
      (() => { try { A.map(row({ submitted_at: 'sometime' })); } catch (err) {
        return /nothing needs you/i.test(err.message); } })());

    // A row that genuinely has no submission date is fine — that is a real
    // state (drafted, not yet sent), not a mapping failure.
    const draft = A.map(row({ submitted_at: null }));
    H.eq('a genuinely unsent request maps to a null date', draft.submitted_on, null);
    H.eq('and the tracker reports no clock, correctly',
      T.evaluate(draft, { today: TODAY }).rung, 'no_action');

    // Every recognised spelling of the column must work, since the whole bug
    // was one name being absent from the list.
    for (const col of A.SUBMITTED_COLUMNS) {
      const r = row({ submitted_at: null });
      r[col] = '2026-07-25';
      H.eq(`'${col}' is recognised as a submission date`,
        A.map(r).submitted_on, '2026-07-25');
    }
  }

  // ══ appeal_filed_at is NOT a mandamus filing ══════════════════════════
  {
    const m = A.map(row({ appeal_filed_at: '2026-08-01T00:00:00Z' }));
    H.eq('an administrative appeal does NOT become a mandamus date',
      m.mandamus_filed_on, null);
    H.check('the mapped object carries no mandamus field from the appeal',
      m.mandamus_filed_on == null);

    const d = T.damagesPosture(Object.assign(m, { delivery_method: 'certified_mail' }), TODAY);
    H.eq('so damages do not accrue off an appeal', d.accrued_usd, null);
    H.check('and the reason names the real trigger', /mandamus/i.test(d.basis));

    // The real column, from migration 0007, DOES map.
    const live = A.map(row({
      mandamus_filed_on: '2026-08-18', delivery_method: 'certified_mail',
    }));
    H.eq('the real mandamus column maps', live.mandamus_filed_on, '2026-08-18');
    const d2 = T.damagesPosture(live, TODAY);
    H.check('and with the transmission predicate met, damages accrue',
      d2.accruing === true);
    H.eq('from the mandamus date', d2.business_days_since_mandamus, 5);
  }

  // ══ delivery method: map the certain, never guess the rest ════════════
  {
    H.eq('the CHECK-constrained column wins over free text',
      A.map(row({ delivery_method: 'certified_mail', submission_method: 'email' }))
        .delivery_method, 'certified_mail');

    for (const [raw, want] of [
      ['certified mail', 'certified_mail'], ['Certified', 'certified_mail'],
      ['USPS Certified', 'certified_mail'], ['email', 'electronic'],
      ['portal', 'web_form'], ['hand delivery', 'hand_delivery'],
    ]) {
      H.eq(`'${raw}' maps to ${want}`,
        A.map(row({ submission_method: raw })).delivery_method, want);
    }

    for (const raw of ['dropped it off', 'idk', 'fax', '']) {
      H.eq(`'${raw}' is NOT guessed at — it maps to null`,
        A.map(row({ submission_method: raw })).delivery_method, null);
    }

    // The consequence of refusing to guess, stated as a test: an unrecognised
    // method blocks damages rather than silently enabling them.
    const d = T.damagesPosture(
      A.map(row({ submission_method: 'fax', mandamus_filed_on: '2026-08-18' })), TODAY);
    H.eq('an unmapped method blocks accrual', d.accrued_usd, null);
    H.check('and asks for the missing fact', /not on file/i.test(d.basis));
  }

  // ══ the rest of the mapping ═══════════════════════════════════════════
  {
    H.eq('exemption_cited becomes the denial basis',
      A.map(row({ status: 'denied', exemption_cited: 'R.C. 149.43(A)(1)(h)' }))
        .denial_basis, 'R.C. 149.43(A)(1)(h)');
    H.eq('denial_reason is the fallback',
      A.map(row({ denial_reason: 'not a public record' })).denial_basis,
      'not a public record');
    H.eq('a fee quote becomes a number, not a string',
      A.map(row({ fee_quoted: '47.50' })).fee_quoted_usd, 47.5);
    H.eq('a null fee stays null, not 0',
      A.map(row({ fee_quoted: null })).fee_quoted_usd, null);
    H.eq('agency name is preferred over the id',
      A.map(row(), { agency_name: 'Franklin County BOE' }).agency_name,
      'Franklin County BOE');
    H.eq('and the id is the fallback when the join found nothing',
      A.map(row()).agency_name, 'franklin-county-board-of-elections');
    H.eq('status is lowercased',
      A.map(row({ status: 'DENIED' })).status, 'denied');
    H.throws('a row with no request_id is refused',
      () => A.map({}), 'no request_id');
  }

  // ══ correspondence drives the dedupe, so it must arrive ═══════════════
  {
    const m = A.map(row(), { correspondence: [
      { direction: 'outbound', occurred_at: '2026-08-24' },
    ] });
    H.eq('followups attach as correspondence', m.correspondence.length, 1);
    H.eq('a recent outbound letter suppresses another',
      T.evaluate(m, { today: TODAY }).rung, 'awaiting_agency');
    H.eq('and with none, it does not',
      T.evaluate(A.map(row()), { today: TODAY }).rung, 'no_response_escalate');
  }

  // ══ one bad row must not hide the good ones ═══════════════════════════
  {
    const fakeDb = {
      async query(sql) {
        if (/FROM requests/i.test(sql)) {
          return { rows: [
            row({ request_id: 'GOOD-1', agency_name: 'A' }),
            row({ request_id: 'BAD-1', submitted_at: 'whenever' }),
            row({ request_id: 'GOOD-2', agency_name: 'B' }),
          ] };
        }
        return { rows: [] };
      },
    };
    let threw = null;
    try { await A.loadAll(fakeDb); } catch (e) { threw = e; }
    H.check('by default an unmappable row fails the load loudly', threw !== null);
    H.check('and the message names the request', /BAD-1/.test(threw.message), threw && threw.message);

    const tolerant = await A.loadAll(fakeDb, { tolerant: true });
    H.eq('in tolerant mode the good rows still load', tolerant.requests.length, 2);
    H.eq('and the failure is reported, not swallowed', tolerant.errors.length, 1);
  }
};

if (require.main === module) {
  (async () => { await module.exports(); process.exit(H.report()); })();
}
