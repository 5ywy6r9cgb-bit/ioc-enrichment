'use strict';
/**
 * tests/olac_lobbying.test.js — the OLAC crawler's parsing half and the
 * amendment detector, both without a browser and without a network call.
 *
 * WHY THESE TWO TOGETHER
 *
 * The crawler's value is not that it fetches pages; it is that it turns a
 * results grid into records whose column meanings survive OLAC reordering its
 * columns, and that it can hold two versions of a filing side by side. Both
 * of those are pure functions over data, so both are testable offline — which
 * is the only way they get tested at all, since a suite that needs the live
 * site is a suite nobody runs.
 *
 * The detector's flag is the thing under test. It says CANDIDATE, and the
 * cases below pin that word down: material added late flags, a pure removal
 * does not, and a field missing from a capture is UNKNOWN rather than zero.
 * An UNKNOWN silently read as "none" would manufacture a late disclosure out
 * of a gap in the capture, and that is exactly the error that must never ship.
 */

const H = require('./_harness.js');
const olac = require('../../connectors/olac/olac_crawler.js');
const { compareFilings, formatReport } = require('../../connectors/olac/amendment_detect.js');

module.exports = function run() {
  H.suite('olac_lobbying');

  // ------------------------------------------------------- table → records
  const grid = {
    index: 0,
    rowCount: 3,
    rows: [
      ['Agent Name', 'Employer', 'Legislative', 'Executive'],
      ['Byers, John', 'Acme Energy LLC', 'Yes', 'No'],
      ['Minton, Ann', 'Acme Energy LLC', 'Yes', 'Yes'],
    ],
    links: [],
  };
  {
    const recs = olac.tableToRecords(grid);
    H.eq('header cells become snake_case keys',
      Object.keys(recs[0]), ['agent_name', 'employer', 'legislative', 'executive']);
    H.eq('rows map by header, not by position', recs[1].employer, 'Acme Energy LLC');
    H.check('every data row is emitted', recs.length === 2);
  }
  {
    // OLAC reorders columns between reports. The parser must follow the
    // header, so the same record reads the same either way.
    const swapped = {
      ...grid,
      rows: [
        ['Employer', 'Agent Name', 'Legislative', 'Executive'],
        ['Acme Energy LLC', 'Byers, John', 'Yes', 'No'],
      ],
    };
    const a = olac.tableToRecords(grid)[0];
    const b = olac.tableToRecords(swapped)[0];
    H.eq('column order does not change the parsed record',
      [b.agent_name, b.employer], [a.agent_name, a.employer]);
  }
  H.eq('a header-only table yields no records', olac.tableToRecords({ rows: [['A', 'B']] }), []);
  H.eq('a null table yields no records', olac.tableToRecords(null), []);
  {
    const ragged = olac.tableToRecords({
      rows: [['Agent Name', 'Employer', 'Notes'], ['Byers, John', 'Acme']],
    });
    H.eq('a short row leaves the missing cell null, never shifted',
      ragged[0], { agent_name: 'Byers, John', employer: 'Acme', notes: null });
  }
  {
    const t = olac.pickResultsTable([
      { index: 0, rowCount: 2, rows: [] },
      { index: 1, rowCount: 40, rows: [] },
    ]);
    H.eq('the largest table is picked as the results grid', t.index, 1);
    H.eq('no tables means no pick', olac.pickResultsTable([]), null);
  }
  H.check('crawler declares a politeness delay', olac.MIN_DELAY_MS >= 1000, `${olac.MIN_DELAY_MS}ms`);

  // ---------------------------------------------------- amendment detector
  const base = {
    filing_id: '1248002',
    filing_date: '2023-09-15',
    reports_expenditure: false,
    reports_travel: false,
    reports_gifts: false,
    expenditure_total: '0',
    bills: [{ bill_number: 'HB6' }],
  };

  {
    // The signal: expenditure absent in the original, present in the amendment.
    const d = compareFilings(base, {
      ...base, filing_id: '1270720', filing_date: '2024-02-01',
      reports_expenditure: true, expenditure_total: '12,500.00',
    });
    H.eq('late-added expenditure flags as a candidate', d.flag, 'late_disclosure_candidate');
    H.check('added_expenditure is set', d.added_expenditure === true);
    H.eq('amount delta is computed', d.amount_delta, 12500);
    H.eq('days between filings is computed', d.days_after_original, 139);
    H.eq('nothing is left unknown when both filings are complete', d.unknown_fields, []);
  }

  {
    const d = compareFilings(base, {
      ...base, filing_id: '2', reports_travel: true,
    });
    H.check('late-added travel flags', d.added_travel === true && d.flag === 'late_disclosure_candidate');
  }
  {
    const d = compareFilings(base, { ...base, filing_id: '2', reports_gifts: true });
    H.check('late-added gifts flags', d.added_gifts === true && d.flag === 'late_disclosure_candidate');
  }

  {
    const d = compareFilings(base, { ...base, filing_id: '2', bills: [{ bill_number: 'HB6' }, { bill_number: 'sb52' }] });
    H.eq('a bill added by the amendment is caught, case-normalized', d.added_bills, ['SB52']);
    H.eq('adding a bill is itself a late-disclosure candidate', d.flag, 'late_disclosure_candidate');
  }

  {
    // A pure REMOVAL is a correction, not a late disclosure. Conflating the
    // two would put "late disclosure" on a filer who disclosed less, which is
    // a different — and unsupported — claim.
    const d = compareFilings({ ...base, reports_travel: true }, { ...base, filing_id: '2' });
    H.eq('a removal is a correction candidate, not a late disclosure', d.flag, 'correction_candidate');
    H.check('nothing is marked as added', !d.added_travel && !d.added_expenditure && !d.added_gifts);
  }

  {
    const d = compareFilings(base, { ...base, filing_id: '2' });
    H.eq('identical filings report no material change', d.flag, 'no_material_change');
    H.eq('no changes are listed', d.changes, []);
  }

  {
    // THE LOAD-BEARING CASE. The original never captured reports_expenditure.
    // Reading that absence as "none" would invent a late disclosure.
    const partial = { filing_id: '1', filing_date: '2023-09-15', bills: [] };
    const d = compareFilings(partial, {
      filing_id: '2', filing_date: '2024-02-01',
      reports_expenditure: true, reports_travel: true, reports_gifts: true,
      expenditure_total: '9000', bills: [],
    });
    H.check('a field missing from the original is UNKNOWN, not zero',
      d.unknown_fields.includes('expenditure') && d.unknown_fields.includes('travel')
      && d.unknown_fields.includes('gifts'), d.unknown_fields.join(','));
    H.check('no add is claimed from a missing field',
      !d.added_expenditure && !d.added_travel && !d.added_gifts);
    H.eq('an uncomparable pair is flagged insufficient_data, not "no change"', d.flag, 'insufficient_data');
    H.check('the missing expenditure total is also reported unknown',
      d.unknown_fields.includes('expenditure_total'));
  }

  {
    // false means "stated as none" and IS comparable — the distinction the
    // schema comment insists on. Same shape as above but with explicit false.
    const d = compareFilings(
      { ...base, expenditure_total: null },
      { ...base, filing_id: '2', reports_expenditure: true, expenditure_total: null });
    H.eq('stated-as-none in the original is comparable and flags', d.flag, 'late_disclosure_candidate');
  }

  {
    const d = compareFilings(base, { ...base, filing_id: '2', filing_date: null });
    H.eq('an unparseable date yields null days, not NaN', d.days_after_original, null);
  }

  {
    const d = compareFilings(base, { ...base, filing_id: '2', reports_expenditure: true });
    const text = formatReport(d);
    H.check('the report states the flag is a prompt, not a finding',
      /prompt to read both filings, not a finding/.test(text));
    H.check('the report names innocent explanations',
      /innocent explanations/.test(text));
  }
  {
    const partial = { filing_id: '1', bills: [] };
    const text = formatReport(compareFilings(partial, { filing_id: '2', bills: [] }));
    H.check('the report says an absent field is UNKNOWN, not zero',
      /UNKNOWN, not zero/.test(text), text);
  }
};

if (require.main === module) { module.exports(); process.exit(H.report()); }
