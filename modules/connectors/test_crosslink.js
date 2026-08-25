'use strict';
/**
 * modules/connectors/test_crosslink.js
 *
 * The risk in this module is not that it misses a connection. It is that it
 * ASSERTS one — that a name overlap gets presented as a relationship and
 * someone believes it. Most of these tests are about the difference.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('./crosslink.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlink-'));
  const cap = path.join(dir, 'captures');
  fs.mkdirSync(cap);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(cap, name), JSON.stringify(body));
  }
  return cap;
}

const lda = (rows) => ({ results: rows.map((r, i) => ({
  filing_uuid: `f${i}`, client: { name: r[0] }, registrant: { name: r[1] },
  income: r[2] || '', filing_year: 2025 })) });

const oc = (names) => ({ results: { companies: names.map((n, i) => ({
  company: { name: n, company_number: String(i), jurisdiction_code: 'us_de',
             incorporation_date: '2020-01-01', opencorporates_url: 'x' } })) } });

module.exports = function run() {
  console.log('\n  crosslink\n');

  // ══ name folding ══════════════════════════════════════════════════════
  {
    const n = X.normalise;
    check('corporate suffixes fold away',
      n('COLOGIX, INC.') === n('Cologix Inc') && n('COLOGIX, INC.') === 'cologix');
    check('"The ... Company LLC" folds to the distinctive part',
      n('THE NEW ALBANY COMPANY LLC') === n('New Albany Company'), n('THE NEW ALBANY COMPANY LLC'));
    check('punctuation does not split an entity',
      n("O'BRIEN & SONS, L.L.C.") === n('OBrien & Sons LLC'),
      `${n("O'BRIEN & SONS, L.L.C.")} vs ${n('OBrien & Sons LLC')}`);

    // The error that matters: folding two DIFFERENT entities into one.
    check('two genuinely different companies do NOT fold together',
      n('Energy Harbor LLC') !== n('Energy Harbor Nuclear LLC'));
    check('nor do a parent and a numbered subsidiary',
      n('COLOGIX, INC.') !== n('COLOGIX MTL8, LLC'));
  }

  // ══ generic names are refused ═════════════════════════════════════════
  {
    for (const g of ['AWS', 'the', 'City', 'United States', '']) {
      check(`"${g}" is too generic to report as a connection`,
        X.tooGeneric(X.normalise(g)) === true);
    }
    check('but a real short-ish name is kept',
      X.tooGeneric(X.normalise('Cologix')) === false);
  }

  // ══ THE POINT: a registrant filing for several clients ════════════════
  {
    const cap = fixture({
      'live_capture_senatelda_first_energy_2026-08-25T01-00-00-000Z.json':
        lda([['FIRSTENERGY CORP', 'VANTAGEKNIGHT LLC', '80000'],
             ['AEP OHIO', 'VANTAGEKNIGHT LLC', '60000']]),
      'live_capture_senatelda_Amazon_Data_Services_2026-08-25T02-00-00-000Z.json':
        lda([['AMAZON DATA SERVICES, INC.', 'VANTAGEKNIGHT LLC', '90000'],
             ['AMAZON DATA SERVICES INC', 'ALPINE GROUP PARTNERS, LLC.', '60000']]),
    });
    const caps = X.readCaptures(cap);
    check('both captures load', caps.length === 2);
    check('the connector is recovered from the filename',
      caps.every((c) => c.connector === 'senatelda'));
    check('and so is the subject',
      caps.map((c) => c.subject).sort().join('|') === 'Amazon Data Services|first energy',
      caps.map((c) => c.subject).join('|'));

    const { edges } = X.index(caps);
    check('client — registrant is split into an edge', edges.length === 4);
    const shared = X.sharedRegistrants(edges, { minClients: 2 });
    check('the shared registrant is found', shared.length === 1);
    check('it is VANTAGEKNIGHT', /VANTAGEKNIGHT/.test(shared[0].registrant));
    check('with three distinct clients', shared[0].client_count === 3, String(shared[0].client_count));
    check('the two spellings of Amazon Data Services counted once',
      shared[0].clients.filter((c) => /AMAZON/i.test(c.client)).length === 1);
    check('and each client says which search surfaced it',
      shared[0].clients.every((c) => c.subjects.length >= 1));

    // A registrant with ONE client is not a connection.
    check('a single-client registrant is not reported',
      X.sharedRegistrants(edges.slice(0, 1), { minClients: 2 }).length === 0);
  }

  // ══ co-occurrence across subjects ═════════════════════════════════════
  {
    const cap = fixture({
      'live_capture_opencorporates_Vadata_2026-08-25T01-00-00-000Z.json':
        oc(['VADATA, INC.', 'AMAZON DATA SERVICES, INC.']),
      'live_capture_opencorporates_Amazon_Data_Services_2026-08-25T02-00-00-000Z.json':
        oc(['AMAZON DATA SERVICES, INC.']),
    });
    const { byName } = X.index(X.readCaptures(cap));
    const cross = X.crossSubject(byName, { minSubjects: 2 });
    check('a name under two subjects is surfaced', cross.length === 1);
    check('it is the one that actually spans them',
      /AMAZON DATA SERVICES/i.test(cross[0].name), cross[0] && cross[0].name);
    check('and it names both subjects', cross[0].subjects.length === 2);

    // The critical negative: one subject, twice, is not a connection.
    const same = fixture({
      'live_capture_opencorporates_Cologix_2026-08-25T01-00-00-000Z.json':
        oc(['COLOGIX, INC.', 'COLOGIX, INC.']),
    });
    check('the same name twice under ONE subject is not a connection',
      X.crossSubject(X.index(X.readCaptures(same)).byName, { minSubjects: 2 }).length === 0);
  }

  // ══ a court caption is two parties, not one name ══════════════════════
  {
    const sp = X.splitParties;
    check('"A v. B" splits into two parties',
      sp('WIDE REACH SYSTEMS v. Someone').length === 2);
    check('and the plaintiff is indexable on its own',
      X.normalise(sp('COLOGIX, INC. v. City of Columbus')[0]) === 'cologix');
    check('"In re" is stripped',
      sp('In re AEP Ohio Tariff')[0] === 'AEP Ohio Tariff');
    check('"State ex rel." too',
      /^Holmes/.test(sp('State ex rel. Holmes v. Indus. Comm.')[0]));
    check('", et al." is stripped from a party',
      sp('United States et al. v. Live Nation Entertainment, Inc.')[1]
        === 'Live Nation Entertainment, Inc.');
    check('a name with no separator is left alone',
      sp('AMAZON DATA SERVICES, INC.').length === 1);
    check('and client — registrant still splits',
      sp('META PLATFORMS, INC. — DCI GROUP, L.L.C.').length === 2);
    check('a sentence with many "v" fragments is not shredded',
      sp('a v b v c v d v e').length === 1);
  }

  // ══ ranking ═══════════════════════════════════════════════════════════
  {
    const cap = fixture({
      'live_capture_opencorporates_a_2026-08-25T01-00-00-000Z.json': oc(['WIDE REACH SYSTEMS']),
      'live_capture_opencorporates_b_2026-08-25T02-00-00-000Z.json': oc(['WIDE REACH SYSTEMS', 'NARROW THING LTD']),
      'live_capture_courtlistener_c_2026-08-25T03-00-00-000Z.json':
        { results: [{ id: 1, caseName: 'WIDE REACH SYSTEMS v. Someone', dateFiled: '2025-01-01' }] },
      'live_capture_opencorporates_d_2026-08-25T04-00-00-000Z.json': oc(['NARROW THING LTD']),
    });
    const cross = X.crossSubject(X.index(X.readCaptures(cap)).byName, { minSubjects: 2 });
    check('more subjects and more sources ranks higher',
      /WIDE REACH/i.test(cross[0].name), cross.map((c) => c.name).join(' | '));
    check('independent sources are counted',
      cross[0].connectors.length === 2, String(cross[0].connectors));
  }

  // ══ a corrupt capture is reported, not fatal ══════════════════════════
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlink-bad-'));
    const cap = path.join(dir, 'captures');
    fs.mkdirSync(cap);
    fs.writeFileSync(path.join(cap, 'live_capture_opencorporates_x_2026-08-25T01-00-00-000Z.json'),
      '{ not json');
    fs.writeFileSync(path.join(cap, 'live_capture_opencorporates_y_2026-08-25T02-00-00-000Z.json'),
      JSON.stringify(oc(['REAL COMPANY LLC'])));
    const caps = X.readCaptures(cap);
    check('an unparseable capture does not throw', caps.length === 2);
    check('it is marked rather than silently dropped',
      caps.filter((c) => c.unparsed).length === 1);
    check('and the good one still parses',
      caps.find((c) => !c.unparsed).results.length === 1);
  }

  // ══ an empty store is not an error ════════════════════════════════════
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlink-empty-'));
    check('a missing captures directory reads as empty',
      X.readCaptures(path.join(dir, 'nope')).length === 0);
  }

  // ══ the disclaimer is not optional ════════════════════════════════════
  {
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the output states that co-occurrence is not a relationship',
      /A CO-OCCURRENCE IS NOT A RELATIONSHIP/.test(cli));
    check('and distinguishes lobbying filings as asserted relationships',
      /asserted relationships, not name overlaps/.test(cli));
    // Strip comments. This is the fourth guard in this repo to match the
    // comment explaining the thing it guards against; crosslink.js mentions
    // runConnector by name when describing the filename convention.
    const code = fs.readFileSync(require.resolve('./crosslink.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    check('crosslink makes no network call',
      !/runConnector\(|R\.request\(|https\.request/.test(code));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
