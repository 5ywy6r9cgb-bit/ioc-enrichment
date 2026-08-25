'use strict';
/**
 * modules/connectors/test_graph.js
 *
 * The risk in a graph is not that an edge is missing. It is that an edge is
 * PRESENT and means less than it looks like it means. A line between two
 * companies is read as "these two are connected" by everyone who sees it,
 * including the person who drew it, six months later.
 *
 * So the load-bearing test in this file is the one asserting that two
 * companies which merely turned up in the same search are NOT joined to each
 * other. Everything else is bookkeeping.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./graph.js');
const X = require('./crosslink.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
  const cap = path.join(dir, 'captures');
  fs.mkdirSync(cap);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(cap, name), JSON.stringify(body));
  }
  return cap;
}

// A Senate LDA response. `count` is what the API says the FULL set is.
const lda = (rows, count) => ({
  count: count === undefined ? rows.length : count,
  results: rows.map((r, i) => ({
    filing_uuid: `f${i}`,
    client: { name: r[0] },
    registrant: { name: r[1] },
    income: r[2] || '',
    filing_year: 2025,
    filing_period: '1st Quarter',
  })),
});

const oc = (names) => ({ results: { companies: names.map((n, i) => ({
  company: { name: n, company_number: String(i), jurisdiction_code: 'us_de',
             incorporation_date: '2020-01-01', opencorporates_url: 'x' } })) } });

/** A session that records what it was asked to run, and runs nothing. */
function fakeSession() {
  const calls = [];
  return { calls, async run(q, params) { calls.push({ q, params }); return { records: [] }; } };
}

module.exports = async function run() {
  console.log('\n  graph\n');

  // ══ 1. CO-OCCURRENCE IS NOT AN EDGE ═══════════════════════════════════
  // Two companies returned by the same search. Nothing connects them but the
  // query. If the graph draws a line between them it has invented a fact.
  {
    const dir = fixture({
      'live_capture_opencorporates_data_center_2026-08-25T01-00-00-000Z.json':
        oc(['CORNFIELD HOLDINGS LLC', 'BUCKEYE POWER PARTNERS LLC']),
      'live_capture_opencorporates_energy_2026-08-25T02-00-00-000Z.json':
        oc(['CORNFIELD HOLDINGS LLC', 'BUCKEYE POWER PARTNERS LLC']),
    });
    const g = G.build(X.readCaptures(dir));

    check('two co-occurring companies both become nodes',
      g.orgs.length >= 2, `${g.orgs.length} orgs`);
    check('CO-OCCURRENCE PRODUCES NO Org->Org EDGE',
      g.filed.length === 0,
      `${g.filed.length} FILED_FOR edges were written from pure co-occurrence`);
    check('they are joined only through the Subject they were found under',
      g.appears.length >= 4 && g.subjects.length === 2,
      `${g.appears.length} appears, ${g.subjects.length} subjects`);

    // The whole design rests on this: there is no relationship type in the
    // generated Cypher that connects one Org directly to another except
    // FILED_FOR. If somebody adds one, this fails.
    const cypher = G.toCypher(g).map((s) => s.q).join('\n');
    const orgToOrg = cypher.match(/\(\s*\w+\s*:Org[^)]*\)\s*-\[[^\]]*\]->\s*\(\s*\w+\s*:Org/g) || [];
    check('the only Org->Org relationship in the schema is FILED_FOR',
      orgToOrg.every((m) => /FILED_FOR/.test(m)),
      orgToOrg.join(' | '));
  }

  // ══ 2. A SWORN FILING IS AN EDGE ══════════════════════════════════════
  {
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-25T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.', '80000']]),
      'live_capture_senatelda_NiSource_2026-08-25T02-00-00-000Z.json':
        lda([['NISOURCE INC.', 'ALPINE GROUP PARTNERS, LLC.', '90000']]),
    });
    const g = G.build(X.readCaptures(dir));

    check('a registrant filing for two clients yields two FILED_FOR edges',
      g.filed.length === 2, `${g.filed.length}`);

    const regs = new Set(g.filed.map((f) => f.registrant));
    check('both edges start at the same registrant node',
      regs.size === 1, [...regs].join(', '));

    const clients = new Set(g.filed.map((f) => f.client));
    check('the two clients are distinct nodes', clients.size === 2);

    check('FILED_FOR carries its evidentiary basis',
      G.toCypher(g).some((s) => /basis = 'senate_lda_filing'/.test(s.q)));
    check('APPEARS_UNDER is labelled a search result, not a relationship',
      G.toCypher(g).some((s) => /basis = 'search_result'/.test(s.q)));
  }

  // ══ 3. THE COMPOSITE KEY MUST NOT COLLIDE ═════════════════════════════
  // registrant "ALPINE GROUP" + client "PARTNERS LLC" and registrant "ALPINE"
  // + client "GROUP PARTNERS LLC" glue to the same string on a separator.
  {
    const dir = fixture({
      'live_capture_senatelda_a_2026-08-25T01-00-00-000Z.json':
        lda([['PARTNERS HOLDINGS', 'ALPINE GROUP']]),
      'live_capture_senatelda_b_2026-08-25T02-00-00-000Z.json':
        lda([['GROUP PARTNERS HOLDINGS', 'ALPINE']]),
    });
    const g = G.build(X.readCaptures(dir));
    check('two differently-split name pairs stay two separate edges',
      g.filed.length === 2, `${g.filed.length} edges — they collided`);
  }

  // ══ 4. TRUNCATION MAKES EVERY COUNT A FLOOR ═══════════════════════════
  {
    const dir = fixture({
      // 60 filings exist; the capture holds 1.
      'live_capture_senatelda_big_2026-08-25T01-00-00-000Z.json':
        lda([['MEGA CLIENT CORP', 'SOME REGISTRANT LLC']], 60),
    });
    const g = G.build(X.readCaptures(dir));
    check('a truncated capture is counted', g.truncated_captures === 1);
    check('truncation marks the counts as floors', g.counts_are_floors === true);
    check('the floor flag is written onto the nodes',
      G.toCypher(g).some((s) => /counts_are_floors/.test(s.q) && s.params.floors === true));
  }
  {
    const dir = fixture({
      'live_capture_senatelda_small_2026-08-25T01-00-00-000Z.json':
        lda([['A CLIENT CORP', 'A REGISTRANT LLC']]),
    });
    const g = G.build(X.readCaptures(dir));
    check('a complete capture is not flagged as a floor',
      g.counts_are_floors === false && g.truncated_captures === 0);
  }

  // ══ 5. RE-RUNNING MUST NOT DUPLICATE THE GRAPH ════════════════════════
  {
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-25T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.']]),
    });
    const g = G.build(X.readCaptures(dir));
    const stmts = G.toCypher(g);
    const writes = stmts.filter((s) => !/^CREATE CONSTRAINT/.test(s.q.trim()));
    check('every write is a MERGE, never a CREATE',
      writes.every((s) => /MERGE/.test(s.q) && !/\bCREATE\b/.test(s.q)),
      writes.filter((s) => /\bCREATE\b/.test(s.q)).map((s) => s.note).join(', '));
  }

  // ══ 6. NAMES ARE PARAMETERS, NEVER QUERY TEXT ═════════════════════════
  // A company name is untrusted input no matter how official its source.
  // Building a query by string-concatenating one is how you get an injection
  // into your own database, and company names really do contain quotes.
  {
    const dir = fixture({
      'live_capture_senatelda_x_2026-08-25T01-00-00-000Z.json':
        lda([["O'BRIEN & SONS \" DROP", 'HONEST REGISTRANT LLC']]),
    });
    const g = G.build(X.readCaptures(dir));
    const cypher = G.toCypher(g).map((s) => s.q).join('\n');
    check('no captured name is interpolated into the query text',
      !/OBRIEN|O'BRIEN|HONEST/i.test(cypher));
    check('the name travels as a parameter instead',
      JSON.stringify(G.toCypher(g).map((s) => s.params)).toLowerCase().includes('brien'));
  }

  // ══ 7. THE GRAPH MUST NOT LEAVE THIS MACHINE BY ACCIDENT ══════════════
  {
    check('localhost is local', G.isLocal('neo4j://localhost:7687'));
    check('127.0.0.1 is local', G.isLocal('bolt://127.0.0.1:7687'));
    check('an Aura instance is NOT local',
      !G.isLocal('neo4j+s://abcd1234.databases.neo4j.io'));
    check('an arbitrary host is NOT local', !G.isLocal('bolt://someone-elses-box:7687'));
    check('an unparseable URI is not treated as local', !G.isLocal('not a uri'));
  }

  // ══ 7b. A PLACEHOLDER PASSWORD IS NOT A PASSWORD ══════════════════════
  // Copying the .env block out of the docs verbatim is the normal thing to
  // do. Caught here, it says "your .env still has the placeholder"; caught by
  // Neo4j, it says "credentials rejected" and you go looking at the database.
  {
    check('the docs placeholder is recognised',
      G.isPlaceholderPassword('whatever-you-set')
      && G.isPlaceholderPassword('the-password-you-set'));
    check('the Neo4j factory default is recognised',
      G.isPlaceholderPassword('neo4j'));
    check('case and surrounding space do not hide a placeholder',
      G.isPlaceholderPassword('  ChangeMe  '));
    check('a real password is not flagged',
      !G.isPlaceholderPassword('correct-horse-battery-staple'));
    check('an empty password is handled separately, not as a placeholder',
      !G.isPlaceholderPassword('') && !G.isPlaceholderPassword(undefined));
  }

  // ══ 7c. AN AUTH FAILURE MUST SAY WHAT IT SENT ═════════════════════════
  {
    check('describeSecret never returns the secret',
      !G.describeSecret('hunter2').includes('unter2'));
    check('length is reported, because that is what diagnoses a typo',
      G.describeSecret('hunter2').includes('7 chars'));
    check('a quoted value is called out',
      /quotes/.test(G.describeSecret('"hunter2"')));
    check('trailing whitespace is called out',
      /whitespace/.test(G.describeSecret('hunter2 ')));
    check('an empty value says empty, not "0 chars"',
      G.describeSecret('') === 'empty');
    check('an unset value says not set',
      G.describeSecret(undefined) === 'not set');
  }

  // ══ 8. push() RUNS THE STATEMENTS, IN ORDER ═══════════════════════════
  {
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-25T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.']]),
    });
    const g = G.build(X.readCaptures(dir));
    const s = fakeSession();
    const notes = await G.push(g, s);

    check('push ran every statement', s.calls.length === G.toCypher(g).length);
    check('constraints are created before the nodes that need them',
      /CREATE CONSTRAINT/.test(s.calls[0].q));
    const orgIdx = s.calls.findIndex((c) => /MERGE \(o:Org/.test(c.q));
    const relIdx = s.calls.findIndex((c) => /FILED_FOR/.test(c.q));
    check('org nodes are merged before the relationships between them',
      orgIdx >= 0 && relIdx > orgIdx, `org@${orgIdx} rel@${relIdx}`);
    check('push reports what it did', Array.isArray(notes) && notes.length > 0);
    check('push connected to nothing on its own',
      s.calls.every((c) => typeof c.q === 'string'));
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
