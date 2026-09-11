'use strict';

/** test_reconcile — the same money, read from both ends. */

const R = require('./reconcile.js');

let pass = 0; let fail = 0;
function check(what, ok) {
  if (ok) { pass += 1; console.log(`    PASS  ${what}`); }
  else { fail += 1; console.log(`    FAIL  ${what}`); }
}
function eq(what, got, want) {
  check(`${what}  (${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));
}

const sb = (date, amount, extra = {}) => ({
  recipient: 'OHIO FLYER PAC', recipient_committee_id: 'C00912865',
  date, amount, ...extra,
});
const sa = (date, amount, extra = {}) => ({
  from: 'TEAM HUSTED', from_id: 'C00896928', date, amount, ...extra,
});

console.log('\n  filtering to one counterparty');
{
  const rows = [sb('2026-03-01', 100), { ...sb('2026-03-02', 200), recipient_committee_id: 'C99999999' }];
  eq('an id that does not match is dropped', R.sentTo(rows, 'C00912865').length, 1);

  // A name is not an identity, and this desk has been burned by that once.
  const blank = [{ recipient: 'Ohio Flyer PAC', recipient_committee_id: '', date: '2026-03-01', amount: 100 }];
  eq('a blank id falls back to an exact name match', R.sentTo(blank, 'C00912865', 'OHIO FLYER PAC').length, 1);
  eq('and is labelled as such', R.sentTo(blank, 'C00912865', 'OHIO FLYER PAC')[0].matched_on, 'name');
  eq('a blank id with no name given matches nothing', R.sentTo(blank, 'C00912865').length, 0);
  // The id wins even when the name would also match, so a row is never
  // counted twice and never attributed on the weaker evidence.
  const both = [{ recipient: 'OHIO FLYER PAC', recipient_committee_id: 'C00000000', date: '2026-03-01', amount: 1 }];
  eq('an id that disagrees with the name is NOT rescued by the name',
    R.sentTo(both, 'C00912865', 'OHIO FLYER PAC').length, 0);
}

console.log('\n  pairing');
{
  const p = R.pair([sb('2026-03-01', 100), sb('2026-04-01', 250)],
    [sa('2026-03-01', 100), sa('2026-04-01', 250)]);
  eq('identical rows pair exactly', [p.exact.length, p.near.length], [2, 0]);
  eq('and nothing is left over', [p.onlySent.length, p.onlyReceived.length], [0, 0]);
}
{
  // The period-boundary shape: same money, each side filing in its own period.
  const p = R.pair([sb('2026-06-29', 5000)], [sa('2026-07-02', 5000)]);
  eq('same amount a few days apart pairs as NEAR', p.near.length, 1);
  eq('and the lag is reported, signed', p.near[0].lag, 3);
}
{
  const p = R.pair([sb('2026-01-01', 900)], [sa('2026-09-01', 900)]);
  eq('far apart does not pair', [p.exact.length, p.near.length], [0, 0]);
  eq('both sides are reported unmatched', [p.onlySent.length, p.onlyReceived.length], [1, 1]);
}
{
  // An exact partner must never be spent on a near one, or a real match is
  // reported as a discrepancy and a discrepancy as a match.
  const p = R.pair([sb('2026-03-05', 100)], [sa('2026-03-01', 100), sa('2026-03-05', 100)]);
  eq('pass 1 completes before pass 2 begins', p.exact.length, 1);
  eq('the unused row is reported, not silently paired', p.onlyReceived.length, 1);
  eq('and it is the one that was NOT the exact partner', p.onlyReceived[0].date, '2026-03-01');
}
{
  const p = R.pair([sb('2026-03-01', 100)], [sa('2026-03-03', 100), sa('2026-03-10', 100)]);
  eq('the NEAREST near partner wins', p.near[0].received.date, '2026-03-03');
}
{
  const p = R.pair([sb('', 100)], [sa('', 100)]);
  eq('two blank dates still pair exactly', p.exact.length, 1);
  const q = R.pair([sb('', 100)], [sa('2026-03-01', 100)]);
  eq('an unusable date does not pair as near', q.near.length, 0);
}

console.log('\n  memo rows are not the filer\'s money');
{
  const got = R.reconcile(
    [sb('2026-03-01', 100), sb('2026-03-02', 500, { memo_code: 'X' })],
    [sa('2026-03-01', 100)]);
  eq('a memo row is excluded from the total', got.sentTotal, 100);
  eq('and counted where the reader can see it', got.passThrough.sent, 1);
  eq('its amount is kept too', got.passThrough.sentAmount, 500);
  eq('so the sides reconcile instead of showing a phantom $500', got.verdict, 'reconciled');
  const t = R.reconcile([sb('2026-03-01', 1, { memo_text: 'EARMARKED FOR X' })], []);
  eq('memo TEXT counts as pass-through even with no memo code', t.passThrough.sent, 1);
}

console.log('\n  verdicts, and which way the error runs');
{
  const a = R.reconcile([sb('2026-03-01', 100)], [sa('2026-03-01', 100)]);
  eq('agreement is reported plainly', [a.verdict, a.gap, a.direction], ['reconciled', 0, 'level']);

  const b = R.reconcile([sb('2026-03-01', 100), sb('2026-05-01', 50)], [sa('2026-03-01', 100)]);
  eq('the sender reporting more is named as such', b.verdict, 'sender_reports_more');
  eq('and the direction is stated, not left to be worked out', b.direction, 'sender_higher');
  eq('the gap is the difference', b.gap, 50);

  const c = R.reconcile([sa('2026-03-01', 100)].map(() => sb('2026-03-01', 100)),
    [sa('2026-03-01', 100), sa('2026-05-01', 50)]);
  eq('and the other way round', [c.verdict, c.direction], ['recipient_reports_more', 'recipient_higher']);

  // The case that matters most: the columns agree and the rows do not.
  const d = R.reconcile([sb('2026-03-01', 100)], [sa('2026-08-01', 100)]);
  eq('equal totals with unmatched rows is its own verdict', d.verdict, 'totals_agree_rows_do_not');

  eq('nothing to compare says so', R.reconcile([], []).verdict, 'no_rows');
}

console.log('\n  the gap needs a denominator');
{
  const got = R.reconcile([sb('2026-03-01', 604861)], [sa('2026-03-01', 513230)]);
  eq('gap', got.gap, 91631);
  check('expressed against the larger side, not against nothing',
    Math.abs(R.gapShare(got) - (91631 / 604861)) < 1e-12);
  check('no denominator, no share', R.gapShare(R.reconcile([], [])) === null);
}

console.log('\n  what would settle it');
{
  const steps = R.nextSteps(R.reconcile([sb('2026-06-29', 500)], [sa('2026-07-02', 500)]));
  check('a near match names the reporting-period reading',
    steps.some((s) => /reporting-period boundary/i.test(s)));
  const un = R.nextSteps(R.reconcile([sb('2026-01-01', 5)], [sa('2026-09-01', 5)]));
  check('unmatched rows send the reader to the filings, not to a conclusion',
    un.some((s) => /amendment restates a period/i.test(s)));
  check('and hand over a command that runs',
    un.some((s) => /connect filings --committee/.test(s)));
  const nm = R.nextSteps(R.reconcile(
    [{ recipient: 'OHIO FLYER PAC', recipient_committee_id: '', date: '2026-03-01', amount: 5 }]
      .map((r) => ({ ...r, matched_on: 'name' })), []));
  check('a name match is flagged as the weaker evidence it is',
    nm.some((s) => /name is not an identity/i.test(s)));
}

console.log(`\n  ${fail ? 'FAIL' : 'PASS'} — ${pass}/${pass + fail} checks\n`);
process.exit(fail ? 1 : 0);
