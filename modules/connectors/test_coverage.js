'use strict';
/**
 * test_coverage.js — the denominator layer, and the box.
 *
 * What is under test is the one distinction the whole desk rests on:
 * "we found nothing" and "we did not look" must never produce the same
 * output. Every check here is a way that could stop being true.
 */

const V = require('./coverage.js');
const B = require('./box.js');
const N = require('./nexus.js');
const NM = require('./namematch.js');

let PASS = 0;
let FAIL = 0;
function check(what, ok) {
  if (ok) { PASS += 1; console.log(`    PASS  ${what}`); }
  else { FAIL += 1; console.log(`    FAIL  ${what}`); }
}
function section(t) { console.log(`\n  ${t}`); }

const cap = (c, s, r, extra = {}) => Object.assign(
  { file: `live_capture_${c}_x.json`, connector: c, subject: s, results: r }, extra);

const SUBJECTS = {
  datacenters: { subjects: ['Vantage Data Centers', 'Cologix', 'QTS Data Centers'] },
  lobbying: { subjects: ['Alpine Group Partners', 'Squire Patton Boggs'] },
  neverswept: { subjects: ['Nobody Asked', 'Nor This One'] },
};

const CAPTURES = [
  cap('senatelda', 'Alpine Group Partners', [
    { name: 'VANTAGE DATA CENTERS — ALPINE GROUP PARTNERS, LLC' },
    { name: 'AEP OHIO — ALPINE GROUP PARTNERS, LLC' },
  ], { total: 400, truncated: true }),
  cap('opencorporates', 'Vantage Data Centers', [{ name: 'VANTAGE DATA CENTERS, LLC' }]),
  cap('courtlistener', 'Cologix', [
    { name: 'Cologix Holdings v. Somebody' },
    { name: 'Totally Unrelated Matter' },
  ]),
];

console.log('\n  COVERAGE — of how many, out of what, and is it a total\n');

// ══ the distinction the desk rests on ═══════════════════════════════════
section('A set never asked is not a set with nothing in it');
{
  const sets = V.setCoverage(CAPTURES, SUBJECTS);
  const never = V.neverAsked(sets);
  check('a set nobody swept is reported as never asked',
    never.includes('neverswept'));
  check('and is NOT reported as zero findings',
    sets.find((s) => s.set === 'neverswept').asked === 0
    && sets.find((s) => s.set === 'neverswept').defined === 2);
  check('the emptiest sets sort FIRST, because they are the misreadable ones',
    sets[0].share === 0);
  check('a partly-asked set reports which subjects were missed by name',
    sets.find((s) => s.set === 'datacenters').missing.includes('QTS Data Centers'));
  check('and which registers answered for the ones that were asked',
    sets.find((s) => s.set === 'lobbying').connectors.includes('senatelda'));
  check('share is asked-over-defined, not a share of anything real-world',
    Math.abs(sets.find((s) => s.set === 'datacenters').share - 2 / 3) < 1e-9);
}

// ══ the shapes ══════════════════════════════════════════════════════════
section('A number carries what shape it is');
{
  check('an exhausted register is a TOTAL',
    V.shapeOf({ truncated: false }) === V.TOTAL);
  check('a page cap makes a FLOOR — the real number is LARGER',
    V.shapeOf({ truncated: true }) === V.FLOOR);
  check('a fuzzy search that still holds namesakes is a CEILING',
    V.shapeOf({ truncated: false, fuzzy: true, nameShare: 0.4 }) === V.CEILING);
  // Picking the friendlier of the two is how a number gets to be wrong in
  // both directions at once and say neither.
  check('fuzzy AND capped is both, and says so',
    V.shapeOf({ truncated: true, fuzzy: true }) === 'FLOOR AND CEILING');
  check('unknown truncation is UNKNOWN, not assumed complete',
    V.shapeOf({}) === V.UNKNOWN);
}

// ══ the floor detector ══════════════════════════════════════════════════
section('The page cap was already parsed and never reported');
{
  const floors = V.flooredCaptures(CAPTURES);
  check('a truncated capture is named individually', floors.length === 1);
  check('with how many rows were never fetched',
    floors[0].missing === 398 && floors[0].held === 2 && floors[0].declared === 400);
  check('and an untruncated one is not in the list',
    !floors.some((f) => f.connector === 'opencorporates'));
}

// ══ A COMPOUND ROW IS TWO NAMES ═════════════════════════════════════════
//
// A live coverage run printed `Senate LDA · 5 rows · 0 filed under it`, on a
// register where every row named the registrant that had been asked for. An
// LDA row is `CLIENT — REGISTRANT`; judged as one string the query is never
// at the front, of a string that was never one name. The tool was reporting
// THE SHAPE OF ITS OWN ROWS as a fact about the subject — the same defect
// this repository exists to catch, produced by the fix for the previous one.
section('A compound row is judged by its parts, not as one string');
{
  const row = 'VANTAGE DATA CENTERS — ALPINE GROUP PARTNERS, LLC';
  check('the registrant side scores NAME',
    NM.bestVerdict('Alpine Group Partners', row) === 'NAME');
  check('and so does the client side',
    NM.bestVerdict('Vantage Data Centers', row) === 'NAME');
  check('judged as ONE string the registrant would have been demoted',
    NM.nameVerdict('Alpine Group Partners', row) === 'CONTAINS');
  check('a row with no separator is unaffected',
    NM.bestVerdict('Blackstone Inc', 'Hotel Blackstone, Inc. v. Tax Commission')
    === NM.nameVerdict('Blackstone Inc', 'Hotel Blackstone, Inc. v. Tax Commission'));
  check('and a genuine non-match is still OTHER',
    NM.bestVerdict('Axon', 'TASER INTERNATIONAL INC') === 'OTHER');

  const conns = V.connectorCoverage(CAPTURES);
  const lda = conns.find((c) => c.connector === 'senatelda');
  check('so the LDA register reports its rows as filed under the subject',
    lda.NAME === 2 && lda.CONTAINS === 0);
  check('and the capped capture is counted as capped', lda.capped === 1);
}

// ══ per-register ════════════════════════════════════════════════════════
section('A register is judged on what it carried, not on how much');
{
  const conns = V.connectorCoverage(CAPTURES);
  const cl = conns.find((c) => c.connector === 'courtlistener');
  check('a row that never names the subject counts as OTHER',
    cl.OTHER === 1);
  check('and the one that does is separated from it',
    cl.NAME + cl.CONTAINS === 1);
  check('rows always equal the sum of the verdicts — nothing is dropped',
    conns.every((c) => c.rows === c.NAME + c.CONTAINS + c.OTHER
      + c.SUBSTRING + c.UNKNOWN));
  check('subjects is a count of DISTINCT subjects, not of captures',
    conns.every((c) => typeof c.subjects === 'number'));
}

// ══ the figures ═════════════════════════════════════════════════════════
section('Every figure carries its denominator and its shape');
{
  const figs = V.figures(CAPTURES, SUBJECTS);
  check('there is at least one figure', figs.length > 0);
  check('every figure has a label, a value and a shape',
    figs.every((f) => f.label && typeof f.value === 'number' && f.shape));
  check('every figure has a note saying what it is a number OF',
    figs.every((f) => f.note && f.note.length > 20));
  check('a figure with a denominator states it, and it is not zero',
    figs.filter((f) => f.of !== null).every((f) => f.of >= 0));
  check('no figure claims a share it cannot compute',
    figs.every((f) => f.of === null || f.value <= f.of || f.of === 0));

  const asked = figs.find((f) => /subjects asked/.test(f.label));
  check('partial subject coverage is reported as a FLOOR, not a total',
    asked.shape === V.FLOOR);
  check('and the note says a set is a list somebody typed, not a census',
    /not a census/.test(asked.note));

  const named = figs.find((f) => /FILED UNDER/.test(f.label));
  check('the named-rows figure is the one a lead count should be',
    /THIS is the number a lead count should be/.test(named.note));
}

// ══ the box ═════════════════════════════════════════════════════════════
section('The box is one file and fetches nothing');
{
  const html = B.render(CAPTURES, SUBJECTS, {});
  check('it is a document', /^<!doctype html>/i.test(html));
  // A page about provenance that phones out for a stylesheet is not making
  // the point, and cannot be opened from an archive in five years.
  check('no external stylesheet, script, font or image',
    !/<script\s+src=/i.test(html) && !/<link\b/i.test(html)
    && !/https?:\/\//.test(html.replace(/<title>[^<]*<\/title>/, '')));
  check('the coverage warning is ABOVE the findings, not below',
    html.indexOf('we did not look') < html.indexOf('Connection chart'));
  check('an unasked set is called out at the top',
    /never asked/i.test(html) && /unasked questions/.test(html));
  check('every shape is rendered with its own badge',
    /class="shape TOTAL"/.test(html) && /class="shape FLOOR"/.test(html));
  check('the chart legend states the grade rule',
    /weaker/.test(html) && /CO-OCCURRENCE/.test(html));
  check('and says a co-occurrence is never a finding on its own',
    /never a finding on its own/.test(html));
  check('the unreachable joins are on the page, with their registers',
    /What no command here can reach/.test(html) && /REGISTER/.test(html));
  check('the standard is the last thing on the page',
    html.lastIndexOf('Conclusions last') > html.lastIndexOf('<table'));

  // ESCAPING, ON THE PATHS THAT ACTUALLY CARRY CAPTURE TEXT.
  //
  // A row name is whatever a register handed back and a subject is whatever
  // was typed or swept. Both reach the page: entity names into the chart and
  // its <title> tooltips, subjects into the page-cap table. The first
  // version of this check used a fixture whose nasty name never bridged, so
  // it asserted escaping on content the page does not render — a test that
  // passes because nothing happened is not a test.
  const EVIL = 'Evil <script>alert(1)</script> & "Co"';
  const nastySets = { a: { subjects: ['Alpha'] }, b: { subjects: ['Beta'] } };
  const nasty = [
    cap('senatelda', 'Alpha', [{ name: EVIL }]),
    cap('opencorporates', 'Beta', [{ name: EVIL }]),
    cap('senatelda', EVIL, [{ name: 'Something' }], { total: 99, truncated: true }),
  ];
  const h2 = B.render(nasty, nastySets, {});
  check('the nasty name actually reaches the page — or this tests nothing',
    /Evil/.test(h2));
  check('markup in a row name is escaped, never rendered',
    !/<script>alert/.test(h2) && /&lt;script&gt;/.test(h2));
  check('markup in a SUBJECT is escaped too — it reaches the page-cap table',
    (h2.match(/&lt;script&gt;/g) || []).length >= 2);
  check('ampersands and quotes become entities',
    /&amp;/.test(h2) && /&quot;/.test(h2));
  check('and the svg tooltip carries the escaped form, not the raw one',
    /<title>[^<]*&lt;script&gt;/.test(h2));

  const empty = B.render([], SUBJECTS, {});
  check('an empty library says so rather than showing zeros',
    /Nothing bridges two domains yet/.test(empty));
}

// ══ no network ══════════════════════════════════════════════════════════
section('Neither one touches the network');
{
  const fs = require('fs');
  const p = require('path');
  for (const f of ['coverage.js', 'box.js']) {
    const src = fs.readFileSync(p.join(__dirname, f), 'utf8');
    check(`${f} makes no request`,
      !/\brequest\(|https:\/\/api\.|fetch\(/.test(src));
  }
  check('and both fold names through one implementation',
    require('./coverage.js') && NM.bestVerdict === require('./namematch.js').bestVerdict);
}

console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
process.exit(FAIL ? 1 : 0);
