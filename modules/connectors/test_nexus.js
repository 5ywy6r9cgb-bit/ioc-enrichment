'use strict';
/**
 * test_nexus.js — the bridge layer.
 *
 * The thing under test is not "does it find connections". It is whether it
 * refuses to CALL them connections. Every check here is about a way this
 * command could produce a confident wrong answer, because that is what a
 * cross-domain tool is for and it is what this desk has been caught doing
 * five separate times.
 */

const N = require('./nexus.js');
const R = require('./registry.js');

let PASS = 0;
let FAIL = 0;
function check(what, ok) {
  if (ok) { PASS += 1; console.log(`    PASS  ${what}`); }
  else { FAIL += 1; console.log(`    FAIL  ${what}`); }
}
function section(t) { console.log(`\n  ${t}`); }

// ── fixtures ────────────────────────────────────────────────────────────
//
// Shaped like real captures: the connector parses the raw body, so the
// fixture must be the PARSED shape crosslink.readCaptures produces.
const SUBJECTS = {
  datacenters: { subjects: ['Amazon Data Services', 'Vantage Data Centers', 'Cologix'] },
  lobbying: { subjects: ['Alpine Group Partners', 'Squire Patton Boggs'] },
  energy: { subjects: ['AEP Ohio', 'American Electric Power'] },
  newalbany: { subjects: ['New Albany Company'] },
  neverswept: { subjects: ['Something Nobody Asked'] },
};

function cap(connector, subject, results) {
  return { file: `live_capture_${connector}_x.json`, connector, subject, results };
}

const CAPTURES = [
  // A sworn lobbying filing: Alpine Group files for Vantage Data Centers.
  cap('senatelda', 'Alpine Group Partners', [
    { name: 'VANTAGE DATA CENTERS — ALPINE GROUP PARTNERS, LLC', amount: '$120,000' },
    { name: 'AEP OHIO — ALPINE GROUP PARTNERS, LLC', amount: '$90,000' },
  ]),
  // The data-centre side, from a company registry.
  cap('opencorporates', 'Vantage Data Centers', [
    { name: 'VANTAGE DATA CENTERS, LLC', jurisdiction: 'us_de' },
  ]),
  // The energy side, from a federal award.
  cap('usaspending', 'AEP Ohio', [
    { name: 'AEP OHIO', amount: '$4,000,000', agency: 'Department of Energy' },
  ]),
  // A pure search-index sighting: two names inside one document title.
  cap('federalregister', 'New Albany Company', [
    { name: 'Notice of Intent; New Albany Company and Cologix Holdings' },
  ]),
  cap('courtlistener', 'Cologix', [
    { name: 'Cologix Holdings v. Somebody' },
  ]),
];

console.log('\n  NEXUS — bridges, grades and the denominator\n');

// ══ domains ═════════════════════════════════════════════════════════════
section('A subject maps to the set(s) that contain it');
{
  const idx = N.domainIndex(SUBJECTS);
  check('an exact subject lands in its set',
    N.domainsFor('AEP Ohio', idx).join() === 'energy');
  check('punctuation and case do not matter — capture filenames flatten both',
    N.domainsFor('vantage  data   centers', idx).join() === 'datacenters');
  check('a subject in two sets reports both, rather than picking one',
    N.domainsFor('Amazon Data Services',
      N.domainIndex({ a: { subjects: ['Amazon Data Services'] },
                      b: { subjects: ['Amazon Data Services'] } })).sort().join() === 'a,b');
  check('a subject in no set is ad-hoc, not dropped',
    N.domainsFor('Fors Marsh Group', idx).join() === 'ad-hoc');
  // A slug truncated at 60 characters still has a recoverable head.
  check('a truncated subject matches on its head, longest first',
    N.domainsFor('American Electric Power Company Of Ohio', idx).join() === 'energy');
}

// ══ grades ══════════════════════════════════════════════════════════════
section('A register is graded by what a row from it IS');
{
  check('a Senate LDA filing is ASSERTED — somebody swore to it',
    N.gradeOf('senatelda') === 'ASSERTED');
  check('a federal award is ASSERTED — it has an award id',
    N.gradeOf('usaspending') === 'ASSERTED');
  check('a company registration is REGISTRY — it says the thing exists',
    N.gradeOf('opencorporates') === 'REGISTRY');
  check('a full-text search hit is CO-OCCURRENCE, the weakest thing here',
    N.gradeOf('federalregister') === 'CO-OCCURRENCE');
  // §78: the party field on a RECAP SEARCH result was truncated and
  // cross-contaminated. The DOCKET and PARTIES endpoints are not the same
  // thing and must not be graded the same.
  check('the courtlistener SEARCH index is CO-OCCURRENCE, per §78',
    N.gradeOf('courtlistener') === 'CO-OCCURRENCE');
  check('but the docket record itself is ASSERTED',
    N.gradeOf('cldocket') === 'ASSERTED' && N.gradeOf('clparties') === 'ASSERTED');
  check('an unknown connector is graded down, never up',
    N.gradeOf('something-new') === 'CO-OCCURRENCE');
  check('every connector in the registry has a grade',
    Object.keys(R.CONNECTORS).every((k) => typeof N.GRADE[k] === 'string'));
}

// ══ the bridge ══════════════════════════════════════════════════════════
section('A bridge is an entity in two domains');
const built = N.build(CAPTURES, SUBJECTS);
{
  const bs = N.bridges(built);
  check('something bridges', bs.length > 0);
  const vantage = bs.find((b) => /vantage/i.test(b.name));
  check('Vantage crosses datacenters and lobbying',
    !!vantage && [vantage.a, vantage.b].sort().join() === 'datacenters,lobbying');
  check('and the row names the register on each side',
    !!vantage && vantage.connectors.includes('senatelda')
    && vantage.connectors.includes('opencorporates'));

  // THE CHAIN IS ONLY AS STRONG AS THE LINK THAT HAS TO HOLD.
  check('a bridge takes the WEAKER of its two sides, not the stronger',
    !!vantage && vantage.grade === 'REGISTRY');
  const aep = bs.find((b) => /aep/i.test(b.name));
  check('two ASSERTED sides give an ASSERTED bridge',
    !!aep && aep.grade === 'ASSERTED');

  check('an entity seen only in one domain is not a bridge',
    !bs.some((b) => b.a === b.b));
}

// ══ TWO DOMAINS REACHED BY ONE SEARCH IS NOT A BRIDGE ═══════════════════
//
// The first version of this command reported AEP OHIO bridging
// energy↔ratepayers, energy↔intel_newalbany and intel_newalbany↔ratepayers
// off ONE USAspending award — because `subjects.json` lists "AEP Ohio" under
// all three sets. Three findings, and every one of them was the subject
// file's own filing system printed back as a discovery. That is the defect
// this entire repository is about.
section('A bridge needs an independent sighting on each side');
{
  const SETS = {
    energy: { subjects: ['AEP Ohio'] },
    ratepayers: { subjects: ['AEP Ohio'] },     // the SAME subject, filed twice
    lobbying: { subjects: ['Alpine Group Partners'] },
  };
  const oneSearch = [
    cap('usaspending', 'AEP Ohio', [{ name: 'AEP OHIO', amount: '$4,000,000' }]),
  ];
  const b1 = N.bridges(N.build(oneSearch, SETS));
  check('one award filed under two sets produces NO bridge', b1.length === 0);
  check('and the taxonomy artefact is visible on request, not deleted',
    N.bridges(N.build(oneSearch, SETS), { allowTaxonomy: true }).length === 1);

  const twoSearches = oneSearch.concat([
    cap('senatelda', 'Alpine Group Partners',
      [{ name: 'AEP OHIO — ALPINE GROUP PARTNERS, LLC' }]),
  ]);
  const b2 = N.bridges(N.build(twoSearches, SETS));
  check('a second, independent search DOES produce a bridge',
    b2.some((b) => [b.a, b.b].sort().join() === 'energy,lobbying'));
  check('but still not between the two sets one search reached',
    !b2.some((b) => [b.a, b.b].sort().join() === 'energy,ratepayers'));
  check('each side records which search put it there',
    b2.every((b) => b.sides[b.a].sightings.length && b.sides[b.b].sightings.length));
  check('and a sighting is connector AND subject, not either alone',
    b2[0].sides[b2[0].a].sightings.every((s) => s.includes('|')));
}

// ══ the denominator ═════════════════════════════════════════════════════
section('The count of entities crossing the same pair goes ON the row');
{
  const bs = N.bridges(built);
  check('every bridge carries its pair population',
    bs.every((b) => Number.isInteger(b.pairPopulation) && b.pairPopulation >= 1));
  const pairs = N.pairTable(bs);
  check('the pair table is sorted RAREST first',
    pairs.every((p, i) => i === 0 || pairs[i - 1].count <= p.count));
  check('and counts entities, not rows',
    pairs.every((p) => p.count <= bs.length));

  // A pair crossed by many is what an industry looks like. It must sort DOWN.
  const many = [];
  for (let i = 0; i < 30; i += 1) {
    many.push(cap('opencorporates', 'Cologix', [{ name: `FILLER ${i} LLC` }]));
    many.push(cap('opencorporates', 'Alpine Group Partners', [{ name: `FILLER ${i} LLC` }]));
  }
  const big = N.bridges(N.build(CAPTURES.concat(many), SUBJECTS));
  const common = big.find((b) => /FILLER 0/.test(b.name));
  const rare = big.find((b) => /aep/i.test(b.name));
  check('a crowded pair ranks below a rare one of the same grade',
    !!common && !!rare && big.indexOf(rare) < big.indexOf(common));
  check('and the crowded pair reports how crowded it is',
    !!common && common.pairPopulation >= 30);
}

// ══ filters ═════════════════════════════════════════════════════════════
section('The filters ask different questions and say which');
{
  check('--side given twice asks for bridges BETWEEN those two',
    N.bridges(built, { sides: ['datacenters', 'lobbying'] })
      .every((b) => [b.a, b.b].sort().join() === 'datacenters,lobbying'));
  check('--side given once asks for every bridge TOUCHING that one',
    N.bridges(built, { sides: ['lobbying'] })
      .every((b) => b.a === 'lobbying' || b.b === 'lobbying'));
  check('--require drops bridges no filing carries',
    N.bridges(built, { require: 'senatelda' })
      .every((b) => b.connectors.includes('senatelda')));
  check('--asserted drops everything resting on a search index',
    N.bridges(built, { minGrade: 'ASSERTED' }).every((b) => b.grade === 'ASSERTED'));
  check('and it actually drops something, or the filter is decorative',
    N.bridges(built, { minGrade: 'ASSERTED' }).length < N.bridges(built).length);
}

// ══ coverage ════════════════════════════════════════════════════════════
section('An empty domain is named BEFORE any result is shown');
{
  const cov = N.coverage(built, SUBJECTS);
  check('a set that was never swept is reported empty',
    cov.empty.includes('neverswept'));
  check('a populated domain reports its entity count and registers',
    cov.rows.some((r) => r.domain === 'lobbying' && r.entities > 0
      && r.connectors.includes('senatelda')));
  // Nothing can bridge to a domain with nothing in it. If that is not said
  // out loud, a missing bridge reads as a missing relationship — which is
  // §42, §61, §66 and §74 of this investigation, in one command.
  const cli = require('fs').readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8');
  check('and the display says an empty domain cannot be bridged to',
    /Nothing can bridge to a\s*\n?\s*\+ 'domain with nothing in it/.test(cli)
    || /domain with nothing in it/.test(cli));
  check('coverage is printed before the bridges, not after',
    cli.indexOf('WHAT THE LIBRARY ACTUALLY HOLDS') < cli.indexOf('BRIDGE SOMETHING'));
}

// ══ the negative space ══════════════════════════════════════════════════
section('The joins this toolkit cannot make are named, with the office');
{
  const j = N.UNREACHABLE.map((u) => u.join).join(' | ').toLowerCase();
  check('Ohio officeholders are named as unreachable', /ohio official/.test(j));
  check('parcels and prices are named as unreachable', /parcel/.test(j));
  check('tax abatement and TIF are named', /abatement|tif/.test(j));
  check('the ratepayer docket is named', /ratepayer/.test(j));
  check('and UNIONS are named, because nothing here touches labour',
    /union/.test(j));

  const union = N.UNREACHABLE.find((u) => /union/.test(u.join));
  check('the union entry names OLMS as the register that holds it',
    /OLMS|LM-2/.test(union.register));
  check('and says plainly that bls is not a substitute',
    /bls/i.test(union.why));
  check('every unreachable join names a specific register',
    N.UNREACHABLE.every((u) => u.register && u.register.length > 20));
  check('and says what to do about it',
    N.UNREACHABLE.every((u) => u.how && u.how.length > 10));

  const ohio = N.UNREACHABLE.find((u) => /ohio official/i.test(u.join));
  check('the Ohio entry says FEC covers FEDERAL candidates only',
    /FEDERAL candidates only|federal candidates only/i.test(ohio.why));
  check('and names the Ohio Ethics Commission, not just the SoS',
    /Ethics Commission/.test(ohio.register));

  const land = N.UNREACHABLE.find((u) => /parcel/.test(u.join));
  check('the parcel entry says it is free and nobody has to grant it',
    /Free, online/.test(land.how));

  // JobsOhio being outside the Public Records Act is the fact that explains
  // why half the Ohio thread cannot be FOIA'd, and it belongs in the tool.
  const tax = N.UNREACHABLE.find((u) => /abatement/.test(u.join));
  check('and JobsOhio is named as exempt from the Public Records Act',
    /JobsOhio/.test(tax.register) && /187\.04|PRIVATE/.test(tax.register));
}

// ══ output ══════════════════════════════════════════════════════════════
section('The written forms carry the same caveats as the screen');
{
  const bs = N.bridges(built);
  const csv = N.toCsv(bs);
  check('the csv has a header', /^entity,domain_a,domain_b,grade/.test(csv));
  check('the csv carries the grade, not just the pair', /,REGISTRY,|,ASSERTED,/.test(csv));
  check('and the pair population, so a sorted spreadsheet keeps its denominator',
    /entities_crossing_this_pair/.test(csv));
  check('a comma in a name does not break a row',
    N.toCsv([{ name: 'VANTAGE DATA CENTERS, LLC', a: 'x', b: 'y', grade: 'REGISTRY',
      pairPopulation: 1, connectors: [],
      sides: { x: { subjects: [] }, y: { subjects: [] } } }])
      .includes('"VANTAGE DATA CENTERS, LLC"'));

  const dot = N.toDot(bs);
  check('the dot file is a graph', /^graph nexus \{/.test(dot) && /\}$/.test(dot.trim()));
  check('and the edge style encodes the grade, so a picture cannot launder it',
    /style=dotted/.test(dot) || /style=dashed/.test(dot));
  check('graphviz, because the Neo4j password is still a placeholder',
    /dot -Tsvg/.test(require('fs').readFileSync(
      require('path').join(__dirname, 'cli.js'), 'utf8')));
}

// ══ no network ══════════════════════════════════════════════════════════
section('It reads the library and nothing else');
{
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'nexus.js'), 'utf8');
  check('nexus makes no request', !/request\(|https:\/\/api\./.test(src));
  check('and folds names through crosslink, not a second normaliser',
    /require\('\.\/crosslink\.js'\)/.test(src) && !/function normalise\b/.test(src));
}

console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
process.exit(FAIL ? 1 : 0);
