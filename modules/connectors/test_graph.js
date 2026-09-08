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

  // ══ 2b. COUNTS ARE WHOLE NUMBERS ══════════════════════════════════════
  // A JS number is a double and the driver maps it to a Neo4j Float, so a
  // count of 17 returns as 17.0 and drags float arithmetic behind it.
  {
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-25T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.']]),
    });
    const g = G.build(X.readCaptures(dir));
    const cypher = G.toCypher(g).map((s2) => s2.q).join('\n');
    for (const prop of ['filings', 'hits', 'subject_count']) {
      check(`${prop} is written through toInteger()`,
        new RegExp(`${prop} = toInteger\\(`).test(cypher),
        cypher.match(new RegExp(`.*${prop} = .*`)) || '');
    }
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
    check('a HALF-EDITED placeholder is caught too',
      G.isPlaceholderPassword('whatever-you-set1')
      && G.isPlaceholderPassword('Xwhatever-you-set')
      && G.isPlaceholderPassword('the-password-you-set!'));
    check('a real password is not flagged',
      !G.isPlaceholderPassword('correct-horse-battery-staple')
      && !G.isPlaceholderPassword('wG7-tunnel-vault-91')
      && !G.isPlaceholderPassword('Sentinel!2026#graph'));
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

  // ══ 7d. "DONE" OVER AN EMPTY DATABASE IS THE CALMEST LIE ══════════════
  // Every write can return without error and the graph still not be there --
  // wrong database, a rolled-back transaction, a silently ignored statement.
  // The command counts it back and compares.
  {
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-25T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.']]),
    });
    const g = G.build(X.readCaptures(dir));

    // A session whose writes "succeed" and whose database is empty.
    const empty = {
      async run(q) {
        if (/RETURN labels|RETURN type/.test(q)) return { records: [] };
        return { records: [] };
      },
    };
    const actual = await G.verify(empty);
    const problems = G.reconcile(g, actual);
    check('an empty database after a "successful" push is reported as a problem',
      problems.length > 0, `${problems.length} problems`);
    check('the problem names what was expected and what was found',
      problems.every((p) => typeof p.want === 'number' && typeof p.got === 'number')
      && problems.some((p) => p.name === 'Org' && p.got === 0));

    // A session that reports back exactly what was written.
    const full = {
      async run(q) {
        const rec = (o) => ({ get: (k) => o[k] });
        if (/RETURN labels/.test(q)) {
          return { records: [
            rec({ label: 'Org', n: g.orgs.length }),
            rec({ label: 'Subject', n: g.subjects.length }),
          ] };
        }
        if (/RETURN type/.test(q)) {
          return { records: [
            rec({ rel: 'FILED_FOR', n: g.filed.length }),
            rec({ rel: 'APPEARS_UNDER', n: g.appears.length }),
          ] };
        }
        return { records: [] };
      },
    };
    const good = G.reconcile(g, await G.verify(full));
    check('a database holding what was written reports no problems',
      good.length === 0, JSON.stringify(good));

    // More than expected is fine -- earlier pushes, other data.
    const more = {
      async run(q) {
        const rec = (o) => ({ get: (k) => o[k] });
        if (/RETURN labels/.test(q)) {
          return { records: [
            rec({ label: 'Org', n: g.orgs.length + 500 }),
            rec({ label: 'Subject', n: g.subjects.length + 3 }),
          ] };
        }
        if (/RETURN type/.test(q)) {
          return { records: [
            rec({ rel: 'FILED_FOR', n: g.filed.length + 9 }),
            rec({ rel: 'APPEARS_UNDER', n: g.appears.length + 9 }),
          ] };
        }
        return { records: [] };
      },
    };
    check('a database holding MORE than this push is not a failure',
      G.reconcile(g, await G.verify(more)).length === 0);

    // The driver hands back Integer objects, not numbers.
    const wrapped = {
      async run(q) {
        const rec = (o) => ({ get: (k) => o[k] });
        const int = (v) => ({ toNumber: () => v });
        if (/RETURN labels/.test(q)) {
          return { records: [rec({ label: 'Org', n: int(g.orgs.length) })] };
        }
        return { records: [] };
      },
    };
    const w = await G.verify(wrapped);
    check('driver Integer counts are unwrapped, not stringified',
      w.nodes.Org === g.orgs.length, JSON.stringify(w.nodes));
  }

  // ══ 9. THE DASHBOARD MUST NOT OUTRUN THE DATA ═════════════════════════
  {
    const D = require('./graph_dashboard.js');
    const dir = fixture({
      'live_capture_senatelda_AWS_2026-08-26T01-00-00-000Z.json':
        lda([['AWS PUBLIC POLICY, AMERICAS', 'ALPINE GROUP PARTNERS, LLC.'],
             ['NISOURCE INC.', 'ALPINE GROUP PARTNERS, LLC.'],
             ['SOLO CLIENT CORP', 'ONE CLIENT FIRM LLC']], 900),
    });
    const g = G.build(X.readCaptures(dir));

    const multi = D.multiClientRegistrants(g);
    check('only firms with two or more clients are listed',
      multi.length === 1 && multi[0].clientCount === 2,
      JSON.stringify(multi.map((m) => [m.name, m.clientCount])));

    const both = D.straddling(multi, /NISOURCE|ENERGY|GAS/, /AWS|AMAZON/);
    check('a firm carrying both sides is found', both.length === 1);
    check('the two patterns must BOTH match, not either',
      D.straddling(multi, /NISOURCE/, /NOTHINGMATCHESTHIS/).length === 0);

    const html = D.renderDashboard(g, { sideA: /NISOURCE/, sideB: /AWS/ });
    check('the page says every number is a floor when captures were truncated',
      /a floor/i.test(html));
    check('APPEARS_UNDER is described as a fact about the searching',
      /your searching/i.test(html));
    check('the page says a filing is not evidence the clients know each other',
      /know each other/i.test(html));

    // Same rules as the lobbying chart: it has to survive with no network.
    check('the dashboard runs no script', !/<script/i.test(html));
    check('the dashboard pulls in no external resource', !/\ssrc\s*=/i.test(html));
    check('the dashboard links no stylesheet or font host', !/<link\b/i.test(html));
    check('the dashboard imports nothing', !/@import/i.test(html));
    check('the dashboard makes no request of its own',
      !/\b(fetch|XMLHttpRequest|cdn\.)/i.test(html));

    // A name from a capture is untrusted text going into HTML.
    // Both render paths have to escape: the bar labels carry REGISTRANT names,
    // the straddle table carries CLIENT names, and only the table renders when
    // patterns are supplied. Testing one and assuming the other is how an
    // escaping bug survives a green suite.
    const nasty = fixture({
      'live_capture_senatelda_x_2026-08-26T01-00-00-000Z.json':
        lda([['<img src=x onerror=alert(1)> CORP', '<svg onload=alert(2)> LLC'],
             ['SECOND CLIENT LLC', '<svg onload=alert(2)> LLC']]),
    });
    const gh = D.renderDashboard(G.build(X.readCaptures(nasty)),
      { sideA: /IMG|CORP/, sideB: /SECOND/ });
    check('a client name in the table cannot inject markup',
      !/<img src=x/.test(gh) && /&lt;img/.test(gh), gh.match(/.{0,40}img.{0,40}/) || '');
    check('a registrant name in the bar labels cannot inject markup',
      !/<svg onload/.test(gh), gh.match(/.{0,40}svg.{0,40}/) || '');

    check('one client reads "1 client", not "1 clients"',
      !/\b1 clients\b/.test(html) && !/\b1 names\b/.test(html));
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

  
// ── THE NAMED QUERIES ─────────────────────────────────────────────────
//
// A guide told the operator to open Neo4j Browser and paste Cypher. He pasted
// it into zsh and got "no matches found" and "command not found: WITH",
// because parentheses, brackets and > are shell metacharacters -- so Cypher at
// a prompt does not fail cleanly, it globs. "Run this somewhere else" is the
// weakest guard there is. These make the queries commands instead.
{
  // THE ALLOW-LIST IS DERIVED FROM push(), NOT TYPED OUT BESIDE IT.
  //
  // It used to be four hardcoded strings. When the lobbying layer added
  // Person, Agency, Issue, LOBBIED_FOR and the rest, this list did not know
  // and every query over them would have been rejected by a test that was
  // itself out of date -- the guard drifting from the thing it guards.
  // Reading the labels and properties out of the emitted Cypher means the
  // schema and the queries cannot disagree without the disagreement failing.
  const SCHEMA_G = (() => {
    const dir = fixture({
      'live_capture_senatelda_SCHEMA_2026-08-25T01-00-00-000Z.json':
        lda([['A CLIENT', 'A REGISTRANT']]),
    });
    const base = G.build(X.readCaptures(dir));
    const F2 = (o) => Object.assign({
      uuid: '', subject: 's', client: 'A CLIENT', registrant: 'A REGISTRANT',
      year: 2024, period: 'Q1', type: 'Q1', typeDisplay: '', amended: false,
      posted: '', income: 1, expenses: 1, issues: ['Energy'],
      lobbyists: ['A Person'], entities: ['An Agency'], url: 'u',
    }, o);
    const stub = {
      readFilings: () => ({ filings: [F2({})], subjects: [{ truncated: false }], unparsed: [] }),
      dedupe: (f) => ({ filings: f, superseded: 0 }),
    };
    base.lobby = G.buildLobbyLayer('/unused', stub);
    return base;
  })();
  const SCHEMA_CY = G.toCypher(SCHEMA_G).map((c) => c.q).join('\n');
  const WRITTEN_LABELS = new Set(
    (SCHEMA_CY.match(/:[A-Z][A-Za-z_]+/g) || []).map((m) => m.slice(1)));
  const WRITTEN_PROPS = new Set([
    ...(SCHEMA_CY.match(/\b\w+\.([a-z_]+)\s*=/g) || [])
      .map((m) => m.trim().split('.')[1].split(/\s*=/)[0]),
    ...(SCHEMA_CY.match(/\{\s*([a-z_]+)\s*:/g) || [])
      .map((m) => m.replace(/[{:\s]/g, '')),
  ]);
  check('the derived schema knows the lobbying layer exists',
    WRITTEN_LABELS.has('Person') && WRITTEN_LABELS.has('Agency')
    && WRITTEN_LABELS.has('LOBBIED_FOR'),
    [...WRITTEN_LABELS].sort().join(' '));
  check('and knows quarters is a property push() sets',
    WRITTEN_PROPS.has('quarters'), [...WRITTEN_PROPS].sort().join(' '));

  const names = Object.keys(G.QUERIES);
  check(`named queries exist (${names.join(' ')})`, names.length >= 5);

  for (const [name, q] of Object.entries(G.QUERIES)) {
    check(`${name}: says what it is for`, typeof q.what === 'string' && q.what.length > 10);
    // A result set with no denominator beside it is how "bridges 4 of 4
    // clients" became the strongest finding on this desk and turned out to be
    // arithmetic. Every query states what its rows do NOT mean.
    check(`${name}: states what the rows do not establish`,
      typeof q.why === 'string' && q.why.length > 40);
    check(`${name}: has cypher`, typeof q.cypher === 'string' && q.cypher.trim().length > 20);

    // Every query is capped. An uncapped MATCH over 5,956 organisations and
    // 7,331 relationships is how a terminal session becomes unusable.
    check(`${name}: is limited`, /LIMIT/.test(q.cypher) || name === 'coverage');

    // Parameters, never interpolation. A term spliced into Cypher is an
    // injection, and the operator's search terms are free text.
    check(`${name}: takes its term as a parameter, not by interpolation`,
      !/\$\{/.test(q.cypher));
    if (q.needsTerm) {
      check(`${name}: actually reads $term`, /\$term/.test(q.cypher));
    }

    // The schema these run against must be the schema push() writes. A query
    // naming a label or relationship that does not exist returns zero rows and
    // reads as "no answer" rather than "wrong query".
    for (const m of q.cypher.match(/:[A-Z][A-Za-z_]+/g) || []) {
      check(`${name}: ${m} is a label or relationship push() creates`,
        WRITTEN_LABELS.has(m.slice(1)),
        `known: ${[...WRITTEN_LABELS].sort().join(' ')}`);
    }
    // Same for properties, which is where a rename would silently empty a
    // column rather than fail.
    for (const m of q.cypher.match(/\b(?:o|o1|o2|a|b|x|y|s|p|ag|i|reg|cli|f|target|other)\.[a-z_]+/g) || []) {
      const prop = m.split('.')[1];
      check(`${name}: property ${prop} is one push() sets`,
        WRITTEN_PROPS.has(prop),
        `known: ${[...WRITTEN_PROPS].sort().join(' ')}`);
    }
  }

  check('coverage does not silently cap the number it is counting',
    !/LIMIT/.test(G.QUERIES.coverage.cypher));
  // ── A ONE-CLIENT FIRM CANNOT BRIDGE ANYTHING ────────────────────────
  //
  // Shipped without a client floor, so MCGINLEY LLC -- one client, Meta
  // Platforms -- appeared in a list called "bridges" with 17 threads. Those
  // 17 were Meta's own breadth, and Meta topped the noise query at 17 for the
  // same reason: it had been searched under many spellings. The row was the
  // operator's subject list reflected back at him, which is the exact defect
  // the book-size ledger fixed in crosslink one commit earlier.
  check('bridges requires at least two clients, since one cannot bridge',
    /clients >= 2/.test(G.QUERIES.bridges.cypher));
  check('bridges sorts by client count FIRST, so the floor is not a dead tiebreaker',
    /ORDER BY clients ASC/.test(G.QUERIES.bridges.cypher));
  // ORDER BY threads DESC, clients ASC put the megafirms straight back on top:
  // thread counts are almost never tied, so the ascending clause never fired.
  check('bridges does not order by threads first',
    !/ORDER BY threads/.test(G.QUERIES.bridges.cypher));
  // And when one client accounts for every thread, the row must say so on its
  // face rather than leaving the operator to notice.
  check('bridges shows how much comes through a single client',
    /from_one_client/.test(G.QUERIES.bridges.cypher));
  check('and explains what that column means',
    /from_one_client/.test(G.QUERIES.bridges.why));
  check('firm returns the filing urls, since that is what gets cited',
    /urls/.test(G.QUERIES.firm.cypher));
  check('pair returns via, so the reason for the overlap is visible',
    /AS via/.test(G.QUERIES.pair.cypher));
}

// ══ THE LOBBYING LAYER: people, money, agencies, time ════════════════════
//
// lobby.js has been parsing every LDA capture into filings carrying the
// lobbyists by name, the agencies they contacted, the income reported, the
// issue codes and the quarter. build() used two fields of it and discarded
// the rest, so the graph could not answer a question the filings answer.
{
  // THE STUB MUST MATCH THE REAL MODULE OR IT TESTS ITSELF.
  //
  // This stub shipped with `dedupe: (f) => f` while the real lobby.dedupe
  // returns { filings, superseded }, and with period '2024Q1' while the real
  // periodKey returns 'Q1'. Nineteen checks passed and buildLobbyLayer threw
  // `filings is not iterable` the first time it met the real module. The
  // contract assertions below this stub exist so that cannot happen twice.
  const F = (o) => Object.assign({
    uuid: '', subject: 's', client: '', registrant: '', year: 2024,
    period: 'Q1', type: 'Q1', typeDisplay: '', amended: false, posted: '',
    income: null, expenses: null, issues: [], lobbyists: [], entities: [], url: '',
  }, o);
  const fakeLobby = (filings) => ({
    readFilings: () => ({ filings, subjects: [{ truncated: false }], unparsed: [] }),
    dedupe: (f) => ({ filings: f, superseded: 0 }),
  });

  // ---- the stub's contract, checked against the real module -----------
  {
    const REAL = require('./lobby.js');
    const d = REAL.dedupe([]);
    check('the real dedupe returns an OBJECT with filings, not a bare array',
      d && !Array.isArray(d) && Array.isArray(d.filings) && 'superseded' in d,
      JSON.stringify(d));
    const stub = fakeLobby([]).dedupe([]);
    check('and the stub returns the same shape',
      stub && !Array.isArray(stub) && Array.isArray(stub.filings) && 'superseded' in stub);
    check('the real periodKey returns a BARE quarter, which the stub must mirror',
      REAL.periodKey({ filing_period: '1st Quarter' }) === 'Q1'
      && F({}).period === REAL.periodKey({ filing_period: '1st Quarter' }),
      `real=${REAL.periodKey({ filing_period: '1st Quarter' })} stub=${F({}).period}`);
    const r = REAL.readFilings('/definitely-not-a-directory');
    check('the real readFilings returns filings/subjects/unparsed, as the stub does',
      Array.isArray(r.filings) && Array.isArray(r.subjects) && Array.isArray(r.unparsed));
  }

  const g = G.buildLobbyLayer('/unused', fakeLobby([
    F({ client: 'Vantage Data Centers, LLC', registrant: 'CORNERSTONE GOVERNMENT AFFAIRS, INC.',
        income: 50000, issues: ['Energy'], lobbyists: ['Michael Cuzzi', 'Colleen Moss'],
        entities: ['U.S. Senate', 'DOE'], url: 'https://lda.gov/f/1', period: '2024Q1' }),
    F({ client: 'Vantage Data Centers LLC', registrant: 'Cornerstone Government Affairs Inc',
        income: 60000, issues: ['Energy', 'Taxation'], lobbyists: ['Michael Cuzzi'],
        entities: ['U.S. House'], url: 'https://lda.gov/f/2', period: '2024Q2' }),
  ]));

  check('lobbyists become Person nodes', g.people.length === 2,
    g.people.map((p) => p.name).join(', '));
  check('government entities become Agency nodes', g.agencies.length === 3,
    g.agencies.map((a) => a.name).join(', '));
  check('issue codes become Issue nodes', g.issues.length === 2);

  // ── THE BUG THIS CAUGHT, AND IT LOST MONEY ─────────────────────────
  //
  // The money map was first keyed on the RAW names, so "Vantage Data
  // Centers, LLC" and "Vantage Data Centers LLC" produced two rows. Both
  // then MERGE onto the SAME FILED_FOR edge in Cypher, where the second SET
  // overwrites the first: $50,000 reported in Q1 silently replaced by
  // $60,000 from Q2, with nothing saying a quarter had been dropped.
  check('two spellings of one client are ONE money relationship',
    g.money.length === 1, JSON.stringify(g.money.map((m) => m.client)));
  check('and the quarters are summed, not overwritten',
    g.money[0].income_reported === 110000, String(g.money[0].income_reported));
  check('both quarters are named on the edge',
    g.money[0].quarters.join(',') === '2024Q1,2024Q2', g.money[0].quarters.join(','));

  // ── THE ORG KEY MUST MATCH build() ──────────────────────────────────
  // An edge carrying the raw display name MATCHes no Org node, and the whole
  // layer lands as orphans no query ever returns.
  check('money rows carry the same normalised key build() uses for Org',
    g.money[0].client_key === X.normalise('Vantage Data Centers, LLC')
    && g.money[0].registrant_key === X.normalise('CORNERSTONE GOVERNMENT AFFAIRS, INC.'),
    `${g.money[0].client_key} / ${g.money[0].registrant_key}`);
  check('so do person→org and org→agency edges',
    g.lobbied_for.every((e) => e.org_key === X.normalise(e.org))
    && g.contacted.every((e) => e.org_key === X.normalise(e.org)));

  check('one person on two filings is one edge with a count',
    g.lobbied_for.filter((e) => e.person === 'Michael Cuzzi').length === 1
    && g.lobbied_for.find((e) => e.person === 'Michael Cuzzi').filings === 2);
  check('every documented edge carries the filing URLs it came from',
    g.lobbied_for.every((e) => Array.isArray(e.urls))
    && g.contacted.every((e) => Array.isArray(e.urls))
    && g.money.every((m) => m.urls.length > 0));

  // ── INCOME AND EXPENSES ARE NOT THE SAME MONEY ──────────────────────
  const inhouse = G.buildLobbyLayer('/unused', fakeLobby([
    F({ client: 'Self Lobbying Corp', registrant: 'Self Lobbying Corp', expenses: 90000, url: 'u' }),
  ]));
  check('expenses land in their own field, never added to income',
    inhouse.money[0].expenses_reported === 90000
    && inhouse.money[0].income_reported === null,
    JSON.stringify(inhouse.money[0]));

  const noMoney = G.buildLobbyLayer('/unused', fakeLobby([
    F({ client: 'A Co', registrant: 'B LLC', income: null, url: 'u' }),
  ]));
  check('a filing reporting NO income is counted, not absorbed as zero',
    noMoney.money[0].income_reported === null
    && noMoney.money[0].filings_with_no_income === 1,
    JSON.stringify(noMoney.money[0]));

  // ── A NAME IS NOT A PERSON ──────────────────────────────────────────
  const cy = G.toCypher({ orgs: [], subjects: [], filed: [], appears: [],
    counts_are_floors: false, lobby: g });
  const personStmt = cy.find((c) => /MERGE \(p:Person/.test(c.q));
  check('Person nodes are written flagged as unresolved identities',
    /is_resolved_identity = false/.test(personStmt.q), personStmt.q);
  check('and the note says a name is not a person',
    /not a resolved person/.test(personStmt.note), personStmt.note);
  check('the constraint note says the same, where a reader meets it first',
    /not per person/.test(cy.find((c) => /CONSTRAINT person_name/.test(c.q)).note));

  check('every lobbying edge records its basis',
    cy.filter((c) => /MERGE \((p|o)\)-\[e:/.test(c.q))
      .every((c) => /basis = 'senate_lda_filing'/.test(c.q)));
  check('names travel as PARAMETERS, never interpolated into the query',
    cy.every((c) => !/Cuzzi|Vantage|Cornerstone/.test(c.q)));
  check('money is SET on the existing FILED_FOR edge, not a parallel one',
    /MERGE \(reg\)-\[f:FILED_FOR\]->\(cli\)[\s\S]*income_reported/.test(
      cy.find((c) => /income_reported/.test(c.q)).q));

  // Coverage travels with the layer, not under it.
  check('the layer reports what it read and what it deduped',
    g.filings_read === 2 && g.filings_after_dedupe === 2);
}

// ══ THE PERSON LAYER: quarter resolution and the three convergence queries ══
//
// `bridges` says which FIRM connects several threads. On a firm with 15,124
// filings that is nearly content-free -- a firm that size carries a
// data-centre operator, a utility and the National Wild Turkey Federation.
// A named lobbyist on two filings IN THE SAME QUARTER is the narrow version,
// and the graph carried the people since c611af0 with nothing to ask it.
{
  const cap = fixture({
    'live_capture_senatelda_stack_2026-09-08T12-00-00-000Z.json': {
      count: 3,
      results: [
        { filing_uuid: 'a', client: { name: 'Vantage Data Centers LLC' },
          registrant: { name: 'Cornerstone Government Affairs' },
          income: '50000', filing_year: 2025, filing_period: '2nd Quarter',
          filing_document_url: 'https://lda.gov/a',
          lobbying_activities: [{ general_issue_code_display: 'Energy/Nuclear',
            government_entities: [{ name: 'Dept of Energy' }],
            lobbyists: [{ lobbyist: { first_name: 'Jane', last_name: 'Doe' } }] }] },
        // SAME lobbyist, SAME quarter, different client.
        { filing_uuid: 'b', client: { name: 'Treaty Oak Clean Energy, LLC' },
          registrant: { name: 'Cornerstone Government Affairs' },
          income: '60000', filing_year: 2025, filing_period: '2nd Quarter',
          filing_document_url: 'https://lda.gov/b',
          lobbying_activities: [{ general_issue_code_display: 'Energy/Nuclear',
            government_entities: [{ name: 'Dept of Energy' }],
            lobbyists: [{ lobbyist: { first_name: 'Jane', last_name: 'Doe' } }] }] },
        // Same lobbyist, DIFFERENT year -- must not count as a shared quarter.
        { filing_uuid: 'c', client: { name: 'Unrelated Charity' },
          registrant: { name: 'Cornerstone Government Affairs' },
          income: '5000', filing_year: 2019, filing_period: '1st Quarter',
          filing_document_url: 'https://lda.gov/c',
          lobbying_activities: [{ general_issue_code_display: 'Education',
            government_entities: [{ name: 'Dept of Education' }],
            lobbyists: [{ lobbyist: { first_name: 'Jane', last_name: 'Doe' } }] }] },
      ],
    },
  });
  const L = require('./lobby.js');
  const g = G.buildLobbyLayer(cap, L);

  const vantage = g.lobbied_for.find((e) => /Vantage/.test(e.org));
  const treaty = g.lobbied_for.find((e) => /Treaty Oak/.test(e.org));
  const charity = g.lobbied_for.find((e) => /Charity/.test(e.org));

  check('a person→client edge now carries QUARTERS, not just years',
    Array.isArray(vantage.quarters) && vantage.quarters.includes('2025Q2'),
    JSON.stringify(vantage.quarters));
  check('two clients of one lobbyist in one quarter share that quarter',
    vantage.quarters.some((q) => treaty.quarters.includes(q)));
  check('and a client six years earlier shares NO quarter with them',
    !charity.quarters.some((q) => vantage.quarters.includes(q)),
    JSON.stringify(charity.quarters));

  const contacted = g.contacted.find((e) => /Vantage/.test(e.org));
  check('an org→agency edge carries quarters too',
    contacted.quarters.includes('2025Q2'), JSON.stringify(contacted.quarters));

  const cy = G.toCypher({ orgs: [], subjects: [], appears: [], filed: [],
    cases: [], lobby: g });
  check('quarters are actually written to the LOBBIED_FOR edge',
    cy.some((c) => /LOBBIED_FOR/.test(c.q) && /e\.quarters = r\.quarters/.test(c.q)));
  check('and to the LOBBIED edge',
    cy.some((c) => /\[e:LOBBIED\]/.test(c.q) && /e\.quarters = r\.quarters/.test(c.q)));

  // ---- the queries themselves ----------------------------------------
  const Q = G.QUERIES;
  for (const name of ['lobbyist', 'agency', 'converge']) {
    check(`${name} is a named query`, !!Q[name]);
    check(`${name} says what it does NOT establish`,
      /not|never|no /i.test(Q[name].why), Q[name].why.slice(0, 60));
  }
  check('converge needs a term — it is about ONE client',
    Q.converge.needsTerm === true);
  check('lobbyist and agency do NOT need a term — they scan the library',
    !Q.lobbyist.needsTerm && !Q.agency.needsTerm);

  // THE ONE THAT MATTERS. A pair query that does not compare quarters is
  // the weak finding wearing the strong finding's name: two clients "in
  // 2025" may be ten months apart.
  for (const name of ['lobbyist', 'agency', 'converge']) {
    check(`${name} compares QUARTERS, not just years`,
      /quarters/.test(Q[name].cypher), name);
  }
  // Each side of a pair must be ordered so a pair appears once, not twice
  // mirrored -- otherwise every finding is silently doubled.
  for (const name of ['lobbyist', 'agency']) {
    check(`${name} emits each pair once, not mirrored`,
      /key <|key <>/.test(Q[name].cypher), name);
  }
  check('converge excludes the target from its own results',
    /other\.key <> target\.key/.test(Q.converge.cypher));

  // A shared lobbyist NAME is not a resolved person, and the query that
  // trades on it must say so where it will be read.
  check('the lobbyist query warns a shared name is not a resolved person',
    /not a resolved person|no identifier/i.test(Q.lobbyist.why));
  check('the agency query refuses to imply the parties met',
    /who was in the room|coordinated|never as a link/i.test(Q.agency.why));
}

console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
