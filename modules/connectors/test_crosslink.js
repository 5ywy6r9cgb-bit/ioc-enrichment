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
    // A name made entirely of suffix words used to fold to the empty string,
    // and every such name then shared one key -- so "Partners Holdings" and
    // "Group Partners Holdings" became a single entity wired to everything
    // either of them had ever been filed beside. Registrants really are named
    // this way.
    // The surname rule was written for court captions and applied everywhere.
    // It ate every single-word company without an Inc or LLC on it: RWE,
    // VERIZON, LEIDOS, SPACEX, DOORDASH. They were silently absent from the
    // index -- never a subject, and reported as "new" on every run.
    for (const co of ['RWE', 'VERIZON', 'LEIDOS', 'SPACEX', 'DOORDASH', 'COVISTA']) {
      check(`${co} survives when the name came from a structured org field`,
        !X.tooGeneric(n(co), co, { assumeOrg: true }));
    }
    check('RWE is not dropped for being three letters',
      !X.tooGeneric(n('RWE'), 'RWE', { assumeOrg: true }));
    for (const person of ['Williams', 'Smith', 'Jones']) {
      check(`${person} is still dropped where names came from a caption`,
        X.tooGeneric(n(person), person));
    }
    check('an empty key is dropped in either context',
      X.tooGeneric('', '', { assumeOrg: true }) && X.tooGeneric('', ''));

    check('a name that is ALL suffix words does not fold to nothing',
      n('PARTNERS HOLDINGS') !== '', `got ${JSON.stringify(n('PARTNERS HOLDINGS'))}`);
    check('two different all-suffix names stay different',
      n('PARTNERS HOLDINGS') !== n('GROUP PARTNERS HOLDINGS'),
      `${JSON.stringify(n('PARTNERS HOLDINGS'))} vs ${JSON.stringify(n('GROUP PARTNERS HOLDINGS'))}`);
    check('the all-suffix fallback does not change names that fold normally',
      n('THE NEW ALBANY COMPANY LLC') === 'new albany',
      n('THE NEW ALBANY COMPANY LLC'));

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
    const gen = (n) => X.tooGeneric(X.normalise(n), n);

    for (const g of ['AWS', 'the', '']) {
      check(`"${g}" is too generic to report as a connection`, gen(g) === true);
    }

    // Regression from a live run on 1023 results: splitting court captions
    // produced the plaintiffs' surnames, and they were reported as
    // connections. A surname on its own connects nothing and matches
    // thousands of unrelated people.
    for (const surname of ['Williams', 'Salter', 'Patterson', 'Woodhouse', 'Myers']) {
      check(`caption surname "${surname}" is not an entity`, gen(surname) === true);
    }

    // And the same run showed an earlier heuristic dropping real companies.
    for (const org of ['COLOGIX, INC.', 'VANTAGEKNIGHT LLC', 'NISOURCE INC.',
                       'ALPINE GROUP PARTNERS, LLC.', 'Meta Platforms, Inc.',
                       'AWS PUBLIC POLICY, AMERICAS', 'THE NEW ALBANY COMPANY LLC',
                       'VADATA, INC.', 'AEP Ohio']) {
      check(`"${org}" is kept`, gen(org) === false);
    }
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

  // ══ a document title is not a party ═══════════════════════════════════
  // A live run reported "Self-Regulatory Organizations; Nasdaq MRX, LLC" as
  // appearing under AWS, Amazon Data Services, and Meta Platforms. That is a
  // Federal Register NOTICE that the full-text search matched three times —
  // a search artifact, not a connection between three companies.
  {
    check('Federal Register is marked as returning document titles',
      require('./registry.js').CONNECTORS.federalregister.entityNames === false);
    check('and Regulations.gov too',
      require('./registry.js').CONNECTORS.regulationsgov.entityNames === false);
    check('while connectors that DO return parties are not marked',
      ['opencorporates', 'senatelda', 'courtlistener', 'usaspending']
        .every((n) => require('./registry.js').CONNECTORS[n].entityNames !== false));

    const cap = fixture({
      'live_capture_federalregister_AWS_2026-08-25T01-00-00-000Z.json':
        { results: [{ document_number: '1', title: 'Self-Regulatory Organizations; Nasdaq MRX, LLC',
                      publication_date: '2026-01-01', agencies: [] }] },
      'live_capture_federalregister_Meta_Platforms_2026-08-25T02-00-00-000Z.json':
        { results: [{ document_number: '2', title: 'Self-Regulatory Organizations; Nasdaq MRX, LLC',
                      publication_date: '2026-01-02', agencies: [] }] },
    });
    const cross = X.crossSubject(X.index(X.readCaptures(cap)).byName, { minSubjects: 2 });
    check('a rulemaking title under two subjects is NOT reported as a link',
      cross.length === 0, cross.map((c) => c.name).join(' | '));
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

  // ══ improbability, not size ═══════════════════════════════════════════
  //
  // The defect this replaces: `sharedRegistrants` sorts by client_count, so a
  // 398-client registrant leads every run forever and the boutique carrying
  // both sides of the actual fight is twenty rows down. These fixtures are
  // that exact situation in miniature.
  {
    // MEGA files for 30 clients; two of them happen to be your subjects.
    // BOUTIQUE files for 3; two of them are your subjects, on two threads.
    const megaRows = [];
    for (let i = 0; i < 28; i++) megaRows.push([`Unrelated Client ${i} LLC`, 'MEGA GROUP LLC']);
    megaRows.push(['AEP Ohio', 'MEGA GROUP LLC']);
    megaRows.push(['Amazon Data Services', 'MEGA GROUP LLC']);

    const dir = fixture({
      'live_capture_senatelda_AEP_Ohio_2026-09-03T10-00-00-000Z.json':
        lda([...megaRows.filter((r) => r[0] === 'AEP Ohio'),
             ['AEP Ohio', 'BOUTIQUE STRATEGIES LLC'],
             ['Some Other Co LLC', 'BOUTIQUE STRATEGIES LLC']]),
      'live_capture_senatelda_Amazon_Data_Services_2026-09-03T10-01-00-000Z.json':
        lda([...megaRows.filter((r) => r[0] === 'Amazon Data Services'),
             ['Amazon Data Services', 'BOUTIQUE STRATEGIES LLC']]),
      'live_capture_senatelda_filler_2026-09-03T10-02-00-000Z.json':
        lda(megaRows.filter((r) => !/AEP|Amazon/.test(r[0]))),
    });

    const { edges } = X.index(X.readCaptures(dir));
    const bySize = X.sharedRegistrants(edges, { minClients: 2 });
    const byOdds = X.concentrated(edges, { minClients: 2, minSubjects: 2 });

    check('by size, the mega-firm leads — the behaviour being corrected',
      bySize[0] && /MEGA/.test(bySize[0].registrant), bySize[0] && bySize[0].registrant);
    check('by improbability, the boutique leads instead',
      byOdds[0] && /BOUTIQUE/.test(byOdds[0].registrant),
      byOdds.map((x) => x.registrant).join(' | '));
    check('and the mega-firm still appears, just lower',
      byOdds.some((x) => /MEGA/.test(x.registrant)));

    const b = byOdds.find((x) => /BOUTIQUE/.test(x.registrant));
    const m = byOdds.find((x) => /MEGA/.test(x.registrant));
    check('the mega-firm bridges MORE threads, and still ranks lower',
      m.threads >= b.threads && byOdds.indexOf(b) < byOdds.indexOf(m),
      `mega ${m.threads} threads @${byOdds.indexOf(m)}, boutique ${b.threads} @${byOdds.indexOf(b)}`);
    check('because the ratio, not the raw count, drives the order',
      b._rank > m._rank, `${b._rank.toFixed(3)} vs ${m._rank.toFixed(3)}`);
    check('no percentage is reported — the denominator is only what was searched',
      b.concentration === undefined);
    check('the row names which clients put it there',
      b.matched.some((x) => /AEP/.test(x.client))
      && b.matched.some((x) => /Amazon/.test(x.client)),
      JSON.stringify(b.matched.map((x) => x.client)));
    check('and which of your subjects each client came from',
      b.subjects.length === 2, b.subjects.join(', '));
  }

  // ══ two engagements two years apart are not "both sides" ═════════════
  //
  // The finding that forced this. Akin Gump filed for ENERGY HARBOR every
  // quarter from 2021 Q2 to 2024 Q1, and for AWS / MICROSOFT / AXON in 2026.
  // Undated, that row reads as one firm carrying the HB6 nuclear beneficiary
  // and the data centers together. It never did. A sequence presented as a
  // simultaneity is the single most defamatory mistake this section can make.
  {
    const dir = fixture({
      'live_capture_senatelda_Energy_Harbor_2026-09-03T10-00-00-000Z.json':
        { results: [2021, 2022, 2023, 2024].map((y, i) => ({
          filing_uuid: `eh${i}`, client: { name: 'ENERGY HARBOR CORP' },
          registrant: { name: 'SEQUENTIAL LLP' }, filing_year: y,
          filing_period_display: '1st Quarter' })) },
      'live_capture_senatelda_Amazon_Web_Services_2026-09-03T10-01-00-000Z.json':
        { results: [{ filing_uuid: 'aws1', client: { name: 'AMAZON WEB SERVICES, INC.' },
          registrant: { name: 'SEQUENTIAL LLP' }, filing_year: 2026,
          filing_period_display: '2nd Quarter' }] },
      // And a firm that really did carry two threads at once.
      'live_capture_senatelda_Skydio_2026-09-03T10-02-00-000Z.json':
        { results: [{ filing_uuid: 'sk1', client: { name: 'SKYDIO, INC.' },
          registrant: { name: 'CONCURRENT LLP' }, filing_year: 2026,
          filing_period_display: '1st Quarter' }] },
      'live_capture_senatelda_Bloom_Energy_2026-09-03T10-03-00-000Z.json':
        { results: [{ filing_uuid: 'be1', client: { name: 'BLOOM ENERGY' },
          registrant: { name: 'CONCURRENT LLP' }, filing_year: 2026,
          filing_period_display: '2nd Quarter' }] },
    });
    const { edges } = X.index(X.readCaptures(dir));
    const rows = X.concentrated(edges, { minClients: 2, minSubjects: 2 });

    const seq = rows.find((r) => /SEQUENTIAL/.test(r.registrant));
    const con = rows.find((r) => /CONCURRENT/.test(r.registrant));
    check('years are carried onto the edges', edges.every((e) => e.year));
    check('engagements that never overlap are marked NOT concurrent',
      seq && seq.concurrent === false, seq && String(seq.concurrent));
    check('engagements in the same year are marked concurrent',
      con && con.concurrent === true, con && String(con.concurrent));
    check('and the concurrent firm ranks above the sequential one',
      rows.indexOf(con) < rows.indexOf(seq),
      rows.map((r) => `${r.registrant}:${r.concurrent}`).join(' | '));
    check('each client carries its own first and last year',
      seq.matched.find((m) => /ENERGY HARBOR/.test(m.client)).from === 2021
      && seq.matched.find((m) => /ENERGY HARBOR/.test(m.client)).to === 2024);
    check('the span covers the whole engagement',
      seq.span.from === 2021 && seq.span.to === 2026,
      JSON.stringify(seq.span));

    // The label must reach the screen, not just the object.
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the terminal prints whether engagements overlapped',
      /OVERLAPPING in time/.test(cli) && /never at the same time/.test(cli));
    check('and no longer prints a concentration percentage',
      !/concentration \$\{pct\}%/.test(cli));
  }

  // ══ one client under two subjects is NOT a concentrated book ══════════
  //
  // AEP Ohio sits in both the `energy` and `ratepayers` subject sets, so a
  // registrant with that ONE client scores 2 subjects / 1 client = 2.0 and
  // would top the list — measuring the operator's duplicate searching rather
  // than anything about the firm. Two distinct clients is the floor.
  {
    const dir = fixture({
      'live_capture_senatelda_AEP_Ohio_2026-09-03T10-00-00-000Z.json':
        lda([['AEP Ohio', 'ONE CLIENT SHOP LLC']]),
      'live_capture_senatelda_Ohio_Power_Company_2026-09-03T10-01-00-000Z.json':
        lda([['AEP Ohio', 'ONE CLIENT SHOP LLC']]),
    });
    const { edges } = X.index(X.readCaptures(dir));
    const byOdds = X.concentrated(edges, { minClients: 2, minSubjects: 2 });
    check('a single client found under two searches does not rank',
      !byOdds.some((x) => /ONE CLIENT SHOP/.test(x.registrant)),
      byOdds.map((x) => `${x.registrant} ${x.concentration}`).join(' | '));
  }

  // ══ ties resolve by something, not by read order ══════════════════════
  {
    const dir = fixture({
      'live_capture_senatelda_A_2026-09-03T10-00-00-000Z.json':
        lda([['Client One', 'FIRM A LLC'], ['Client Two', 'FIRM A LLC'],
             ['Client One', 'FIRM B LLC'], ['Client Two', 'FIRM B LLC']]),
      'live_capture_senatelda_B_2026-09-03T10-01-00-000Z.json':
        lda([['Client Three', 'FIRM A LLC'], ['Client Three', 'FIRM B LLC'],
             ['Client Four', 'FIRM B LLC']]),
    });
    const { edges } = X.index(X.readCaptures(dir));
    const byOdds = X.concentrated(edges, { minClients: 2, minSubjects: 2 });
    check('the order is monotonic and deterministic, never insertion order',
      byOdds.length >= 2
      && byOdds.every((x, i) => i === 0 || byOdds[i - 1]._rank >= x._rank),
      byOdds.map((x) => `${x.registrant}:${x._rank.toFixed(2)}`).join(' | '));
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

  // ══ COUNT FILINGS, NOT HOW OFTEN YOU SEARCHED ═════════════════════════
  //
  // An edge is a ROW IN A CAPTURE. The same filing comes back under
  // "ShotSpotter" and again under "SoundThinking", and again on every re-run
  // of either — so counting edges measured the operator's search history, not
  // the lobbying.
  //
  // It reported Becker & Poliakoff at 98 filings for SoundThinking across
  // 2014-2026, which reads as a deep, sustained engagement and was the number
  // that made the row look like a finding. The registrant-scoped pull of the
  // same firm shows 4.
  {
    const one = (subject, id) => ({
      client: 'SOUNDTHINKING INC.', registrant: 'BECKER & POLIAKOFF, P.A.',
      client_key: 'SOUNDTHINKING', registrant_key: 'BECKER POLIAKOFF',
      filing_id: id, period: '2025 Q1', year: '2025', subject, amount: '', issues: '',
    });
    // One filing, found under two searches, plus a re-run of each.
    const edges = [one('ShotSpotter', 'uuid-1'), one('SoundThinking', 'uuid-1'),
                   one('ShotSpotter', 'uuid-1'), one('SoundThinking', 'uuid-2')];

    const shared = X.sharedRegistrants(edges, { minClients: 1 });
    const c = shared[0].clients[0];
    check('one filing seen under four searches counts once per uuid',
      c.filings === 2, `filings=${c.filings}`);
    check('and the raw row count is still reported, so the fold is checkable',
      c.rows === 4, `rows=${c.rows}`);

    // A row with no uuid must still collapse re-runs of the same quarter,
    // rather than counting each capture again.
    const noId = [one('ShotSpotter', ''), one('SoundThinking', ''), one('ShotSpotter', '')];
    const s2 = X.sharedRegistrants(noId, { minClients: 1 });
    check('with no uuid, registrant+client+period collapses the re-runs',
      s2[0].clients[0].filings === 1, String(s2[0].clients[0].filings));

    // Genuinely different filings must NOT be collapsed — under-counting a
    // real engagement is the other way to get this wrong.
    const two = [one('ShotSpotter', 'uuid-1'), one('ShotSpotter', 'uuid-2')];
    check('two different filings stay two',
      X.sharedRegistrants(two, { minClients: 1 })[0].clients[0].filings === 2);

    const src = fs.readFileSync(require.resolve('./crosslink.js'), 'utf8');
    check('concentrated() counts distinct filings too, not rows',
      /filings: c\.seen\.size/.test(src));
    check('and the edge carries the filing id that makes that possible',
      /filing_id: r\.external_id/.test(src));
  }

  // ══ A PHRASE YOU SEARCHED IS NOT A SUBJECT IT BRIDGES ═════════════════
  //
  // Real defect: searching EDGAR for the disclosure phrase "duplicate accounts"
  // put that phrase in the library as a SUBJECT. Meta -- the company that
  // answered it -- then headed APPEARS UNDER MORE THAN ONE SUBJECT bridging
  // `Clearview AI`, `Meta Platforms`, `duplicate accounts` and `duplicate and
  // false accounts`. Two of those are search strings, and Meta is "under" them
  // only because they were the query. A tautology, printed in the section whose
  // whole claim is that these names connect separate investigations.
  {
    const caps = [
      { connector: 'sec', subject: 'duplicate accounts', results: [
        { name: 'Facebook Inc' }, { name: 'Meta Platforms, Inc.' },
        { name: 'Rush Street Interactive, Inc.' }] },
      { connector: 'sec', subject: 'duplicate and false accounts',
        results: [{ name: 'Meta Platforms, Inc.' }] },
      { connector: 'opencorporates', subject: 'Meta Platforms',
        results: [{ name: 'Meta Platforms, Inc.' }] },
      { connector: 'courtlistener', subject: 'Clearview AI',
        results: [{ name: 'Meta Platforms, Inc. v. Clearview AI' }] },
    ];

    const phrase = X.classifySubjects(caps);
    check('a full-text phrase is recognised as a phrase, not an entity',
      phrase.has('duplicate accounts') && phrase.has('duplicate and false accounts'),
      [...phrase].join(' | '));
    check('a real entity subject is NOT misread as a phrase',
      !phrase.has('Meta Platforms') && !phrase.has('Clearview AI'),
      [...phrase].join(' | '));

    const { byName, phraseSubjects } = X.index(caps);
    const [meta] = X.crossSubject(byName, { minSubjects: 2, phraseSubjects });
    check('the cross-link counts only entity subjects',
      meta.subjects.length === 2 && meta.subjects.includes('Meta Platforms')
        && meta.subjects.includes('Clearview AI'), meta.subjects.join(' | '));
    check('phrase subjects are carried, not deleted',
      meta.phraseSubjects.length === 2, meta.phraseSubjects.join(' | '));
    check('and they add no weight to the ranking',
      meta.weight === 2 * 10 + meta.connectors.length, String(meta.weight));

    // A phrase must not be able to CREATE a cross-link on its own.
    const only = X.index([
      { connector: 'sec', subject: 'duplicate accounts', results: [{ name: 'Rush Street Interactive, Inc.' }] },
      { connector: 'sec', subject: 'false accounts', results: [{ name: 'Rush Street Interactive, Inc.' }] },
    ]);
    check('two phrase subjects alone do not make a company cross-linked',
      X.crossSubject(only.byName, { minSubjects: 2, phraseSubjects: only.phraseSubjects }).length === 0);

    // Losing a true link is as bad as printing a false one. normalise() strips
    // corporate suffixes, so the affidavit's "Structura National Technology"
    // and the sanctions listing's "Structura National Technologies" fold to
    // different strings -- substring matching classified a real entity as a
    // phrase and would have dropped it.
    check('a suffix/plural spelling variant is still read as an entity',
      X.subjectEchoesIn('Structura National Technology', 'Structura National Technologies'));
    check('a genuinely unrelated name does not echo the subject',
      !X.subjectEchoesIn('duplicate accounts', 'ADMINISTAFF INC'));

    // An empty search says nothing about what kind of search it was.
    check('a subject that returned nothing is not classified either way',
      !X.classifySubjects([{ connector: 'sec', subject: 'found nothing', results: [] }])
        .has('found nothing'));

    const src = fs.readFileSync(require.resolve('./crosslink.js'), 'utf8');
    check('the phrase list reaches crossSubject rather than being recomputed',
      /phraseSubjects: classifySubjects\(captures\)/.test(src));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('and the CLI shows phrase subjects on their own line',
      /also answered the search/.test(cli));
  }

  // ══ "BRIDGES 4 OF 4" IS TRUE OF EVERY FIRM ════════════════════════════
  //
  // Real failure, reported to the operator as a finding: Brownstein Hyatt led
  // this section "bridging 4 of your threads across 4 client(s) the library
  // knows" — Skydio, Bloom Energy, American Electric Power, Palantir, all
  // overlapping in time. A registrant-scoped pull then returned 384 clients
  // from the first 500 of the firm's 16,026 filings, including Alibaba,
  // Tencent, NVIDIA, McDonald's and Yale. A firm that size bridges four of
  // anyone's subjects by arithmetic.
  //
  // The tell was in the data and was not printed: every client the library
  // knew for that firm had come from the operator's own subject searches, so
  // the denominator WAS the search list and the ratio is 1.0 for any firm.
  {
    const mk = (reg, cli, subject, year) => ({
      registrant: reg, client: cli,
      registrant_key: X.normalise(reg), client_key: X.normalise(cli),
      subject, year, period: `Q1 ${year}`, filing_id: `${reg}|${cli}|${year}`,
    });

    // Known only through the operator's own searches.
    const searchOnly = [
      mk('BIG FIRM LLP', 'SKYDIO', 'Skydio', 2025),
      mk('BIG FIRM LLP', 'PALANTIR TECHNOLOGIES INC.', 'Palantir Technologies', 2025),
    ];
    // Also holds clients that arrived some other way — a real, partial floor.
    const surveyed = [
      mk('BOUTIQUE LLC', 'AXON ENTERPRISE, INC.', 'Axon Enterprise', 2025),
      mk('BOUTIQUE LLC', 'BRINC DRONES, INC.', 'BRINC Drones', 2025),
      ...Array.from({ length: 26 }, (_, i) => ({
        registrant: 'BOUTIQUE LLC', client: `OTHER CLIENT ${i}`,
        registrant_key: X.normalise('BOUTIQUE LLC'), client_key: `other client ${i}`,
        subject: '', year: 2025, period: 'Q1 2025', filing_id: `o${i}`,
      })),
    ];

    const rows = X.concentrated([...searchOnly, ...surveyed],
      { minClients: 2, minSubjects: 2 });
    const big = rows.find((r) => r.registrant === 'BIG FIRM LLP');
    const bou = rows.find((r) => r.registrant === 'BOUTIQUE LLC');

    check('a firm known only through your own searches is flagged as having no denominator',
      big.denominator_is_search_list === true);
    check('a firm with clients found other ways is NOT flagged',
      bou.denominator_is_search_list === false);
    check('the full client count is carried so the ratio can be seen',
      big.client_count === 2 && bou.client_count === 28,
      `${big.client_count} / ${bou.client_count}`);

    // The boutique bridges the same number of threads off a real denominator,
    // so it must outrank the firm whose denominator is the question itself.
    check('the boutique outranks the firm with no denominator',
      rows.indexOf(bou) < rows.indexOf(big),
      rows.map((r) => r.registrant).join(' > '));

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the CLI prints the warning rather than leaving it in the data',
      /NO DENOMINATOR/.test(cli));
    check('and tells the operator exactly how to get one',
      /--registrant "\$\{g\.registrant\}"/.test(cli));
    check('the displayed count now shows on-subject clients OUT OF clients known',
      /clients_on_subjects\} of \$\{g\.client_count\}/.test(cli));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
