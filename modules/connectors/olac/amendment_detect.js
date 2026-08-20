'use strict';
/**
 * modules/connectors/olac/amendment_detect.js
 * Compare an original filing against the amendment that supersedes it.
 *
 *   node modules/connectors/olac/amendment_detect.js 1248002.json 1270720.json
 *
 * WHY THIS IS THE HIGH-VALUE STEP
 *
 * A lobbying filing that is amended months later to ADD travel, gifts, or
 * expenditure is a late disclosure. It is visible only by holding two
 * versions side by side, which nobody does by hand across hundreds of
 * filings. This is the piece that turns an archive into a finding-generator.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not conclude anything. The flag it emits is
 * `late_disclosure_candidate`, and the word candidate is load-bearing: a
 * late-added expenditure has innocent explanations — a corrected error, an
 * invoice that arrived after the deadline, a reclassification — at least as
 * often as it has interesting ones. The output is a prompt to read both
 * filings, not a headline.
 *
 * NO DEPENDENCY. The suggested `deep-diff` package would work, but this
 * comparison is domain-specific: it cares about which disclosure categories
 * appeared, not about generic object deltas. 60 lines here beats a
 * dependency that answers a different question.
 */

const fs = require('fs');
const path = require('path');

/** Categories whose APPEARANCE in an amendment is the signal. */
const DISCLOSURE_FIELDS = [
  ['reports_expenditure', 'added_expenditure', 'expenditure'],
  ['reports_travel',      'added_travel',      'travel'],
  ['reports_gifts',       'added_gifts',       'gifts'],
];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const billSet = (f) => new Set(
  (f.bills || []).map((b) => String(b.bill_number || b).trim().toUpperCase()).filter(Boolean)
);

/**
 * Compare two filing objects.
 *
 * A filing object is whatever the crawler stored, plus optional normalized
 * fields. Missing values are treated as UNKNOWN, never as "none" — the
 * difference matters: a field absent from the original because it was not
 * captured is not the same as a field the filer stated as zero.
 */
function compareFilings(original, amended) {
  const out = {
    original_filing_id: original.filing_id || original.aer || null,
    amended_filing_id: amended.filing_id || amended.aer || null,
    added_expenditure: false,
    added_travel: false,
    added_gifts: false,
    added_bills: [],
    removed_bills: [],
    amount_delta: null,
    unknown_fields: [],
    changes: [],
  };

  for (const [field, flag, label] of DISCLOSURE_FIELDS) {
    const before = original[field];
    const after = amended[field];
    if (before === undefined || before === null || after === undefined || after === null) {
      out.unknown_fields.push(label);
      continue;
    }
    if (!before && after) {
      out[flag] = true;
      out.changes.push(`${label}: absent in original, present in amendment`);
    } else if (before && !after) {
      out.changes.push(`${label}: present in original, absent in amendment`);
    }
  }

  const a = num(original.expenditure_total);
  const b = num(amended.expenditure_total);
  if (a !== null && b !== null) {
    out.amount_delta = Number((b - a).toFixed(2));
    if (out.amount_delta !== 0) {
      out.changes.push(`expenditure total ${a} → ${b} (${out.amount_delta > 0 ? '+' : ''}${out.amount_delta})`);
      if (out.amount_delta > 0) out.added_expenditure = true;
    }
  } else if (a === null || b === null) {
    out.unknown_fields.push('expenditure_total');
  }

  const beforeBills = billSet(original);
  const afterBills = billSet(amended);
  out.added_bills = [...afterBills].filter((x) => !beforeBills.has(x));
  out.removed_bills = [...beforeBills].filter((x) => !afterBills.has(x));
  if (out.added_bills.length) out.changes.push(`bills added: ${out.added_bills.join(', ')}`);
  if (out.removed_bills.length) out.changes.push(`bills removed: ${out.removed_bills.join(', ')}`);

  // Days between, when both dates are known.
  const d1 = Date.parse(original.filing_date || original.date || '');
  const d2 = Date.parse(amended.filing_date || amended.date || '');
  out.days_after_original = (Number.isFinite(d1) && Number.isFinite(d2))
    ? Math.round((d2 - d1) / 86400000) : null;

  // The flag. Note the ordering: anything ADDED outranks a pure removal,
  // and "no material change" is only claimed when nothing at all moved.
  // and "no material change" is a POSITIVE claim, so it is only made when
  // every compared field was actually present in both filings. If a field was
  // missing from a capture there is nothing to say about it, and saying
  // "no material change" would be saying it anyway.
  const addedSomething = out.added_expenditure || out.added_travel || out.added_gifts || out.added_bills.length;
  if (addedSomething) out.flag = 'late_disclosure_candidate';
  else if (out.changes.length) out.flag = 'correction_candidate';
  else if (out.unknown_fields.length) out.flag = 'insufficient_data';
  else out.flag = 'no_material_change';

  return out;
}

/** Human-readable summary. Written to be pasted into a case note. */
function formatReport(diff) {
  const L = [];
  const FLAG_TEXT = {
    late_disclosure_candidate: 'LATE DISCLOSURE CANDIDATE — material appears in the amendment that was absent from the original',
    correction_candidate: 'CORRECTION CANDIDATE — something changed, but nothing was added',
    no_material_change: 'no material change detected in the compared fields',
    insufficient_data: 'NOT COMPARABLE — fields were missing from one or both captures, so nothing can be concluded either way',
  };

  L.push(`  ${diff.original_filing_id || '?'} → ${diff.amended_filing_id || '?'}`);
  if (diff.days_after_original !== null) L.push(`  filed ${diff.days_after_original} days apart`);
  L.push(`  ${FLAG_TEXT[diff.flag]}`);
  L.push('');

  if (diff.changes.length) {
    L.push('  changes:');
    for (const c of diff.changes) L.push(`    · ${c}`);
  } else {
    L.push('  changes: none in the compared fields');
  }

  if (diff.unknown_fields.length) {
    L.push('');
    L.push(`  NOT COMPARED (missing from one or both filings): ${[...new Set(diff.unknown_fields)].join(', ')}`);
    L.push('  A field absent from a capture is UNKNOWN, not zero. Read the filings.');
  }

  L.push('');
  L.push('  This is a prompt to read both filings, not a finding. A late-added');
  L.push('  expenditure has innocent explanations at least as often as not.');
  return L.join('\n');
}

function loadFiling(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Accept either a bare filing object or a crawler output wrapper.
  if (raw.records && Array.isArray(raw.records) && raw.records.length === 1) return raw.records[0];
  return raw;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length !== 2) {
    console.error('usage: amendment_detect.js <original.json> <amended.json>');
    process.exit(2);
  }
  const [a, b] = args;
  for (const f of [a, b]) {
    if (!fs.existsSync(f)) { console.error(`no such file: ${f}`); process.exit(2); }
  }
  const diff = compareFilings(loadFiling(a), loadFiling(b));

  console.log('\n\x1b[1mAmendment comparison\x1b[0m');
  console.log(`  original    ${path.basename(a)}`);
  console.log(`  amendment   ${path.basename(b)}\n`);
  console.log(formatReport(diff));
  console.log('');
  if (process.argv.includes('--json')) console.log(JSON.stringify(diff, null, 2));
}

module.exports = { compareFilings, formatReport, DISCLOSURE_FIELDS };

if (require.main === module) main();
