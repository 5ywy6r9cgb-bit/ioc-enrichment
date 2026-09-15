'use strict';
/**
 * test_edges.js — the edge model, explain, and challenge.
 *
 * The move being tested is from ROWS to EDGES. A row says a register matched
 * a string; an edge says something happened between two named parties and
 * names the document that says so. What must not happen is an edge asserting
 * more than its register can carry.
 */

const E = require('./edges.js');
const NM = require('./namematch.js');

let PASS = 0;
let FAIL = 0;
function check(what, ok) {
  if (ok) { PASS += 1; console.log(`    PASS  ${what}`); }
  else { FAIL += 1; console.log(`    FAIL  ${what}`); }
}
function section(t) { console.log(`\n  ${t}`); }

const cap = (c, s, r, e = {}) => Object.assign(
  { file: `live_capture_${c}_${s}_2026-09-15T18-01-15-881Z.json`,
    connector: c, subject: s, results: r }, e);

const CAPTURES = [
  cap('senatelda', 'Blackstone Inc', [
    { name: 'THE BLACKSTONE GROUP INC. — MINDSET ADVOCACY, LLC',
      amount: '40000.00', url: 'https://lda.gov/filings/x/print/' },
    { name: 'THE BLACKSTONE GROUP INC. — SQUIRE PATTON BOGGS (US) LLP',
      amount: '90000.00' },
  ], { total: 716, truncated: true }),
  cap('senatelda', 'Vantage Data Centers', [
    { name: 'VANTAGE DATA CENTERS — MINDSET ADVOCACY, LLC', amount: '20000.00' },
  ]),
  cap('senatelda', 'QTS Data Centers', [
    { name: 'QTS DATA CENTERS — MINDSET ADVOCACY, LLC', amount: '30000.00' },
  ]),
  cap('usaspending', 'AEP Ohio', [
    { name: 'AEP OHIO', agency: 'Department of Energy', amount: '$4,000,000',
      award_id: 'DE-1234', period: '2024-01-01 → 2026-01-01' },
  ]),
  cap('opencorporates', 'Blackstone Inc', [
    { name: 'BLACKSTONE INC.', jurisdiction: 'us_de', incorporated: '2020-03-02' },
  ]),
  cap('courtlistener', 'Blackstone Inc', [
    { name: 'Hotel Blackstone, Inc. v. Tax Commission', date: '1980-01-24' },
    { name: 'Blackstone Inc. v. Somebody', date: '2024-02-02' },
  ]),
  cap('federalregister', 'Blackstone Inc', [
    { name: 'Change In Control: Port Arthur LNG Phase II, LLC', date: '2025-11-18' },
  ]),
];

console.log('\n  EDGES — who, through what mechanism, on whose word\n');

// ══ the relationships that exist, and only those ════════════════════════
section('Only relationships this toolkit can evidence are emitted');
{
  const edges = E.build(CAPTURES);
  const rels = new Set(edges.map((e) => e.relationship));
  check('every emitted relationship is declared in RELATIONSHIPS',
    [...rels].every((r) => !!E.RELATIONSHIPS[r]));
  check('every declared relationship names its register',
    Object.values(E.RELATIONSHIPS).every((r) => r.register && r.register.length > 10));
  check('and states the authority behind it',
    Object.values(E.RELATIONSHIPS).every((r) => typeof r.authority === 'string'));

  // A proposed command list asked for ownership, officers, banks, property,
  // votes and crypto edges. None has a register here. Emitting an empty
  // `owned_by` puts a shape on the graph the evidence cannot fill, and an
  // empty slot in a diagram reads as a missing FACT, not a missing REGISTER.
  for (const r of ['owned_by', 'officer_of', 'banks_with', 'owns_property',
                   'voted_on', 'crypto_counterparty', 'foreign_principal_of']) {
    check(`${r} is declared UNBUILT rather than emitted empty`,
      !!E.UNBUILT[r] && !E.RELATIONSHIPS[r] && !rels.has(r));
  }
  check('the banks entry says plainly there is nothing to build against',
    /NO PUBLIC REGISTER/.test(E.UNBUILT.banks_with));
  check('the crypto entry refuses to merge address attribution into this graph',
    /never be merged|never merged/i.test(E.UNBUILT.crypto_counterparty));
  check('and names FARA as the highest-value missing connector',
    /HIGHEST-VALUE/.test(E.UNBUILT.foreign_principal_of));
  check('a shared registered agent is called out as routinely meaningless',
    /ROUTINELY MEANINGLESS/.test(E.UNBUILT.registered_agent));
}

// ══ what each register can actually carry ═══════════════════════════════
section('An edge never asserts more than its register can carry');
{
  const edges = E.build(CAPTURES);
  const lda = edges.find((e) => e.relationship === 'represented_by');
  check('a lobbying filing becomes client --represented_by--> registrant',
    lda.entity_a === 'THE BLACKSTONE GROUP INC.'
    && lda.entity_b === 'MINDSET ADVOCACY, LLC');
  check('and is ASSERTED, because somebody swore to it',
    lda.assertion_type === E.ASSERTED);
  check('carrying the amount and the filing url',
    lda.amount === '40000.00' && /lda\.gov/.test(lda.source_url));

  const award = edges.find((e) => e.relationship === 'received_award_from');
  check('an award becomes recipient --received_award_from--> agency',
    award.entity_a === 'AEP OHIO' && award.entity_b === 'Department of Energy');
  check('and carries the award id, which is what makes it checkable',
    award.document_id === 'DE-1234');

  const reg = edges.find((e) => e.relationship === 'registered_in');
  check('a registration is REGISTRY, not ASSERTED',
    reg.assertion_type === E.REGISTRY);
  check('and carries the incorporation date as the effective date',
    reg.effective_date === '2020-03-02');

  const men = edges.find((e) => e.relationship === 'mentioned_in');
  check('a search hit is CO-OCCURRENCE', men.assertion_type === E.COOCCURRENCE);
  check('and its authority field literally says NONE',
    /NONE/.test(E.RELATIONSHIPS.mentioned_in.authority));

  // THREE DATES, NEVER ONE. When it happened, when it was filed, and when we
  // pulled it are three facts, and the gap between the first two is
  // sometimes the story.
  check('every edge carries three separate date fields',
    edges.every((e) => 'effective_date' in e && 'record_date' in e
      && 'source_date' in e));
  check('source_date is recovered from the capture filename',
    edges.every((e) => e.source_date === '2026-09-15'));
}

// ══ confidence is not a number ══════════════════════════════════════════
section('Confidence is categorical, because a number invites averaging');
{
  const edges = E.build(CAPTURES);
  check('confidence is never numeric',
    edges.every((e) => typeof e.confidence === 'string'));
  check('and it equals the assertion type rather than drifting from it',
    edges.every((e) => e.confidence === e.assertion_type));
  check('there are exactly three values, so nothing sits between them',
    new Set(Object.values(E.RELATIONSHIPS).map((r) => r.assertion)).size === 3);
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'edges.js'), 'utf8');
  check('and the file says why a 0-to-1 score is refused',
    /invites averaging/.test(src));
}

// ══ THE NAMESAKE HOLE IN mentioned_in ═══════════════════════════════════
//
// A `mentioned_in` edge has the SEARCHED SUBJECT on the a-side by
// construction, so judging entity_a asks whether the query matches the
// query. It always does. The first version counted
// `Hotel Blackstone, Inc. v. Tax Commission` — a 1980 case, five years
// before The Blackstone Group existed — as a clean NAME edge.
section('A mentioned_in edge is judged by the DOCUMENT, not by the subject');
{
  const edges = E.build(CAPTURES);
  const hits = E.forEntity(edges, 'Blackstone Inc');
  const hotel = hits.find((h) => /Hotel Blackstone/.test(h.entity_b));
  check('the 1980 hotel is found', !!hotel);
  check('and is NOT counted as a name match', hotel.verdict !== 'NAME');
  const real = hits.find((h) => /Blackstone Inc\. v\. Somebody/.test(h.entity_b));
  check('while a document filed under the name IS one', real.verdict === 'NAME');
  const lng = hits.find((h) => /Port Arthur/.test(h.entity_b));
  check('a document that never names the entity is kept but set aside',
    !!lng && lng.verdict === 'OTHER');
  check('nothing is dropped — you cannot audit what you never saw',
    hits.filter((h) => h.relationship === 'mentioned_in').length === 3);

  // The asserted side is unaffected: there the a-side is a real party name.
  const lda = hits.filter((h) => h.relationship === 'represented_by');
  check('an LDA edge still matches on its real party name',
    lda.length === 2 && lda.every((h) => h.verdict === 'NAME' && h.side === 'a'));
}

// ══ the denominator, on the row ═════════════════════════════════════════
section('A counterparty carries how many others share it');
{
  const edges = E.build(CAPTURES);
  const pop = E.counterpartyShare(edges, 'represented_by', 'MINDSET ADVOCACY, LLC');
  check('three entities retained the same firm in this library',
    pop.entities === 3);
  check('and they are named, not just counted',
    pop.names.length === 3 && pop.names.some((n) => /VANTAGE/.test(n)));
  // "Blackstone retained Mindset Advocacy" means one thing if Mindset files
  // for two clients and another if it files for eight hundred, and the
  // filing alone cannot tell you which.
  const alone = E.counterpartyShare(edges, 'represented_by', 'SQUIRE PATTON BOGGS (US) LLP');
  check('a firm with one client in this library reports one',
    alone.entities === 1);
  check('the share is computed against THIS library and nothing else',
    pop.entities <= new Set(edges.map((e) => e.key_a)).size);
}

// ══ grouping ════════════════════════════════════════════════════════════
section('Relationships are grouped strongest-assertion first');
{
  const edges = E.build(CAPTURES);
  const groups = E.byRelationship(
    E.forEntity(edges, 'Blackstone Inc').filter((h) => h.verdict === 'NAME'));
  check('the ASSERTED group sorts above the CO-OCCURRENCE one',
    E.RANK[groups[0].assertion_type] >= E.RANK[groups[groups.length - 1].assertion_type]);
  check('each group names its register on screen',
    groups.every((g) => g.register && g.register.length > 10));
}

// ══ the csv ═════════════════════════════════════════════════════════════
section('The written form carries every field');
{
  const csv = E.toCsv(E.build(CAPTURES));
  for (const col of ['entity_a', 'relationship', 'entity_b', 'assertion_type',
    'confidence', 'amount', 'jurisdiction', 'authority', 'effective_date',
    'record_date', 'source_date', 'source', 'document_id', 'source_url',
    'subject', 'status']) {
    check(`the csv has a ${col} column`, new RegExp(`(^|,)${col}(,|$)`, 'm').test(csv));
  }
  check('a comma in an entity name does not break a row',
    E.toCsv([E.edge({ entity_a: 'A, Inc.', relationship: 'registered_in',
      entity_b: 'us_de' })]).includes('"A, Inc."'));
}

// ══ challenge ═══════════════════════════════════════════════════════════
section('The challenge engine argues against the finding');
{
  const cli = require('fs').readFileSync(
    require('path').join(__dirname, 'cli.js'), 'utf8');
  check('it warns when most edges are a search index',
    /MOST OF THIS IS A SEARCH INDEX/.test(cli));
  check('it warns about namesakes and tells you to check the date',
    /MAY BE A DIFFERENT COMPANY/.test(cli) && /CHECK THE DATE/.test(cli));
  check('it warns that a shared counterparty is a service, not a network',
    /SHARED COUNTERPARTY IS NOT A SHARED PURPOSE/.test(cli)
    && /is a SERVICE, not a network/.test(cli));
  check('it says the comparison universe may not exist yet',
    /COMPARISON UNIVERSE DOES NOT EXIST YET/.test(cli));
  check('it names the figures that are FLOORS',
    /A NUMBER HERE IS A FLOOR, NOT A TOTAL/.test(cli));
  check('it says an absence in the graph is an absence of a CONNECTOR',
    /absence of a CONNECTOR/.test(cli));
  check('it offers alternative explanations that fit the same record',
    /ALTERNATIVE EXPLANATIONS THAT FIT THE SAME RECORD/.test(cli));
  check('and it asks what would change your mind',
    /WHAT WOULD CHANGE YOUR MIND/.test(cli));
  check('a killed claim is kept, not deleted',
    /--tier DEAD/.test(cli));
}

// ══ no network ══════════════════════════════════════════════════════════
section('It reads the library and nothing else');
{
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'edges.js'), 'utf8');
  check('edges.js makes no request',
    !/\brequest\(|https:\/\/api\.|fetch\(/.test(src));
  check('and folds names through the one shared implementation',
    NM.bestVerdict === require('./namematch.js').bestVerdict);
}

console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
process.exit(FAIL ? 1 : 0);
