#!/usr/bin/env node
'use strict';
/** test_filings.js — the documents, and which one supersedes which. */

const FL = require('./filings.js');

let ran = 0, fails = 0;
function check(label, ok) {
  ran += 1; if (!ok) fails += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
function eq(label, got, want) {
  check(`${label}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
    got === want);
}

async function run() {
  console.log('\n  filings — primary sources, not derived totals\n');

  // ── THE URL THAT WORKS ──────────────────────────────────────────────
  // docquery.fec.gov/cgi-bin/forms/<id>/ answers 403. It is a browser
  // path. The API publishes a pdf_url per filing and that is the one that
  // can be fetched, hashed and cited.
  const u = FL.filingsUrl('C00937797', 'k');
  check('reads the committee filings index',
    u.includes('/committee/C00937797/filings/'));
  check('and not the docquery browser path', !u.includes('docquery'));
  check('newest first, because an amendment is newer than what it amends',
    u.includes('sort=-receipt_date'));
  check('a cycle filter is applied when given',
    FL.filingsUrl('C1', 'k', { cycle: 2026 }).includes('cycle=2026'));
  check('and omitted when not',
    !FL.filingsUrl('C1', 'k').includes('cycle='));
  check('a form filter is exact — F3 must not be sent when F3X was asked for',
    FL.filingsUrl('C1', 'k', { formType: 'F3X' }).includes('form_type=F3X'));
  check('paging is explicit', FL.filingsUrl('C1', 'k', { page: 3 }).includes('page=3'));

  // ── PARSING ─────────────────────────────────────────────────────────
  const rows = FL.parseFilings({ results: [
    { form_type: 'F1', document_type_full: 'Statement of Organization',
      pdf_url: 'https://docquery.fec.gov/pdf/111/FEC-111/FEC-111.pdf',
      receipt_date: '2026-02-05T00:00:00', file_number: 111,
      amendment_indicator: 'N' },
    { form_type: 'F3X', pdf_url: 'https://docquery.fec.gov/pdf/222/x.pdf',
      receipt_date: '2026-07-15T00:00:00', coverage_start_date: '2026-04-01',
      coverage_end_date: '2026-06-30', total_receipts: '3636779',
      total_disbursements: '2952967', file_number: 222, amendment_indicator: 'N' },
    { form_type: 'F3X', pdf_url: 'https://docquery.fec.gov/pdf/333/y.pdf',
      receipt_date: '2026-08-01T00:00:00', file_number: 333,
      amendment_indicator: 'A', amends_file_number: 222 },
    { pdf_url: 'https://example.com/no-form.pdf' },
  ] });

  eq('a row with no form type is dropped', rows.length, 3);
  eq('the pdf url is carried — it is the whole point',
    rows[0].pdf, 'https://docquery.fec.gov/pdf/111/FEC-111/FEC-111.pdf');
  eq('dates are trimmed to a day', rows[0].receipt_date, '2026-02-05');
  eq('the coverage period survives', rows[1].from, '2026-04-01');
  eq('and its end', rows[1].to, '2026-06-30');
  eq('totals become numbers', rows[1].receipts, 3636779);
  eq('an amendment is marked as one', rows[2].amendment, 'A');
  eq('and names what it amends', rows[2].amends, 222);

  // ── SUPERSESSION. The point of carrying amendment fields at all. ────
  // A committee that files then amends has two documents saying different
  // things. Quoting the superseded one is a way to be wrong while holding
  // a real filing.
  const sup = FL.supersession(rows);
  eq('the amended filing is moved to superseded', sup.superseded.length, 1);
  eq('and it is the one that was amended, not the amendment',
    sup.superseded[0].file_number, 222);
  eq('the amendment itself stays current',
    sup.current.some((r) => r.file_number === 333), true);
  eq('as does an unrelated filing',
    sup.current.some((r) => r.file_number === 111), true);
  check('a superseded filing is KEPT, not dropped — a changed figure is often '
    + 'the finding', sup.superseded.length + sup.current.length === rows.length);
  eq('nothing is superseded when nothing amends anything',
    FL.supersession([rows[0]]).superseded.length, 0);

  // ── WHAT EACH FORM IS FOR ───────────────────────────────────────────
  check('F1 is named as the one carrying joint-fundraiser PARTICIPANTS',
    /PARTICIPANTS/.test(FL.purposeOf('F1')));
  check('F3X is named as the one with full disbursement descriptions',
    /disbursement descriptions/.test(FL.purposeOf('F3X')));
  check('F24 is the 24/48-hour independent expenditure report',
    /independent expenditure/i.test(FL.purposeOf('F24')));
  eq('an unknown form gets no invented description', FL.purposeOf('ZZ9'), '');
  eq('and neither does a missing one', FL.purposeOf(undefined), '');
  check('whitespace and case in a form name still resolve',
    FL.purposeOf(' f3x ') === FL.purposeOf('F3X'));

  // ── GROUPING ────────────────────────────────────────────────────────
  const grouped = FL.byForm(rows);
  eq('filings group by form', grouped.length, 2);
  eq('the commonest form leads', grouped[0].form, 'F3X');
  eq('and carries its purpose', /disbursement/.test(grouped[0].purpose), true);
  eq('newest filing first inside a group', grouped[0].rows[0].receipt_date, '2026-08-01');

  // ── PAGING ──────────────────────────────────────────────────────────
  let calls = 0;
  const paged = async () => {
    calls += 1;
    return { results: [{ form_type: 'F3X', receipt_date: '2026-01-01' }],
      pagination: { pages: 3 } };
  };
  const got = await FL.collect(paged, () => 'u', 10);
  eq('every page is read', calls, 3);
  eq('and every row kept', got.rows.length, 3);
  check('a feed that ends is not called truncated', !got.truncated);

  calls = 0;
  const endless = async () => {
    calls += 1;
    return { results: [{ form_type: 'F3X' }], pagination: { pages: 999 } };
  };
  const capped = await FL.collect(endless, () => 'u', 2);
  check('a page cap stops the read', capped.truncated === true);
  eq('at the cap', calls, 2);

  eq('an empty index is empty, not an error',
    (await FL.collect(async () => ({ results: [] }), () => 'u')).rows.length, 0);

  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${ran - fails}/${ran} checks\n`);
  return fails ? 1 : 0;
}

if (require.main === module) run().then((c) => process.exit(c));
module.exports = { run };
