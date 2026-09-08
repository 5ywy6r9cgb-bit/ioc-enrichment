#!/usr/bin/env node
'use strict';
/**
 * graph.js — push what the captures actually establish into Neo4j.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE PROBLEM WITH DRAWING A GRAPH
 * ─────────────────────────────────────────────────────────────────────
 * A line between two nodes reads as "these two are connected." The eye does
 * not ask how the line got there. So a graph will happily present, in exactly
 * the same visual language:
 *
 *   - AWS and NiSource both retain the same lobbying firm
 *     (a sworn federal filing, 2 U.S.C. 1603-1604)
 *   - AWS and NiSource both turned up in a keyword search for "data center"
 *     (two names in a list)
 *
 * The second is not a relationship. It is a search result. `connect crosslink`
 * says so out loud in the terminal; if the graph then draws both as an edge,
 * the graph has quietly undone that care, and it is the graph people will
 * screenshot.
 *
 * SO THE SHAPE OF THE GRAPH CARRIES THE EVIDENCE, NOT A PROPERTY ON IT:
 *
 *   (:Org)-[:FILED_FOR]->(:Org)        ONE HOP.  A registrant filed for a
 *                                      client. Sworn, dated, has a URL.
 *
 *   (:Org)-[:APPEARS_UNDER]->(:Subject)  Two orgs under the same subject are
 *                                      TWO HOPS apart, through a node that
 *                                      says what they have in common: they
 *                                      were both returned by the same search.
 *
 * That is deliberate. You cannot accidentally draw a direct line between two
 * companies that merely co-occur, because no such edge is ever written. A
 * property saying `basis: "co-occurrence"` would have been ignored; a missing
 * edge cannot be.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THE COUNTS MEAN
 * ─────────────────────────────────────────────────────────────────────
 * Counts are written through toInteger(). A JavaScript number is a double,
 * and the driver maps it to a Neo4j Float -- so a count of 17 comes back out
 * of a query as `17.0`, sorts as a float, and accumulates the usual float
 * error the moment anything adds them up. A count is a whole number of
 * things; storing it as one is not cosmetic. toInteger() does it in Cypher,
 * so no driver-specific integer type is needed here and the module stays
 * testable without the driver.
 *
 * `filings` on FILED_FOR counts filings IN YOUR LIBRARY, not in the world.
 * The senatelda connector searches by client name, captures stop at 25
 * results, and the raw response's `count` tells you what you missed. Where a
 * capture was truncated the node carries `counts_are_floors: true`. A floor
 * that does not say it is a floor is just a wrong number.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TESTABILITY
 * ─────────────────────────────────────────────────────────────────────
 * Nothing here requires neo4j-driver. `build()` and `toCypher()` are pure, and
 * `push()` takes a session object, so the suite runs with a fake one and the
 * repo does not grow a dependency it needs only at the very last step.
 */

const path = require('path');
const fs = require('fs');
const X = require('./crosslink.js');
const L = require('./lobby.js');

/** Hosts that live on this machine. Anything else leaves it. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Is this URI pointed at something on this machine?
 *
 * Not cosmetic. The whole point of this desk is that the library stays on one
 * Mac. A NEO4J_URI pointing at a hosted instance would ship the entire graph
 * of who-lobbies-for-whom to somebody else's server, on one command, with no
 * other visible difference. Remote requires saying so explicitly.
 */
function isLocal(uri) {
  try {
    // neo4j://host:7687 parses fine as a URL; the protocol is unusual, the
    // hostname is not.
    const u = new URL(uri);
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Read KEY=value from a .env next to this file. Same loader the rest uses. */
function readEnv(dir) {
  const file = path.join(dir || __dirname, '.env');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Turn captures into nodes and relationships.
 *
 * Returns plain data. No connection, no side effects — so the terminal can
 * show you exactly what would be written before anything is.
 */
function build(captures) {
  const { byName, edges } = X.index(captures);

  // ---- Org nodes ----------------------------------------------------
  // Keyed on the normalised name so "ALPINE GROUP PARTNERS, LLC." and
  // "Alpine Group Partners LLC" are one node rather than two that never meet.
  const orgs = new Map();
  function org(display, key) {
    if (!orgs.has(key)) orgs.set(key, { key, name: display, subjects: new Set() });
    return orgs.get(key);
  }

  for (const entry of byName.values()) {
    const o = org(entry.display, entry.key);
    for (const s of entry.seen) o.subjects.add(s.subject);
  }

  // ---- Subject nodes ------------------------------------------------
  // A subject is a search you ran, not a thing in the world. Naming it as its
  // own node is what keeps "both matched this query" from looking like a fact
  // about the two companies.
  const subjects = new Map();
  const appears = [];
  for (const entry of byName.values()) {
    const bySubject = new Map();
    for (const s of entry.seen) {
      if (!subjects.has(s.subject)) subjects.set(s.subject, { name: s.subject });
      if (!bySubject.has(s.subject)) bySubject.set(s.subject, { connectors: new Set(), hits: 0 });
      const b = bySubject.get(s.subject);
      b.connectors.add(s.connector);
      b.hits++;
    }
    for (const [subject, b] of bySubject) {
      appears.push({
        org: entry.key,
        subject,
        hits: b.hits,
        connectors: [...b.connectors].sort(),
      });
    }
  }

  // ---- FILED_FOR relationships --------------------------------------
  // Collapsed per (registrant, client) pair. JSON-encoded key, not a glued
  // string: registrant "ALPINE GROUP" + client "PARTNERS LLC" and registrant
  // "ALPINE" + client "GROUP PARTNERS LLC" produce the same string when you
  // join names with a separator, and two unrelated relationships would merge
  // into one. Company names contain every punctuation mark there is.
  const filed = new Map();
  for (const e of edges) {
    org(e.registrant, e.registrant_key);
    org(e.client, e.client_key);
    const k = JSON.stringify([e.registrant_key, e.client_key]);
    if (!filed.has(k)) {
      filed.set(k, {
        registrant: e.registrant_key,
        client: e.client_key,
        filings: 0,
        subjects: new Set(),
        urls: new Set(),
      });
    }
    const f = filed.get(k);
    f.filings++;
    if (e.subject) f.subjects.add(e.subject);
    if (e.url) f.urls.add(e.url);
  }

  // ---- truncation ----------------------------------------------------
  // If any capture was cut off at the page size, every count derived from it
  // is a floor. We do not know WHICH counts, so the flag is global and the
  // summary says so rather than implying per-edge precision we do not have.
  let truncated = 0;
  for (const cap of captures) {
    if (cap.unparsed) continue;
    if (cap.truncated) truncated++;
  }

  return {
    orgs: [...orgs.values()].map((o) => ({
      key: o.key, name: o.name, subject_count: o.subjects.size,
    })),
    subjects: [...subjects.values()],
    filed: [...filed.values()].map((f) => ({
      registrant: f.registrant, client: f.client, filings: f.filings,
      subjects: [...f.subjects].sort(), urls: [...f.urls].sort(),
    })),
    appears,
    truncated_captures: truncated,
    counts_are_floors: truncated > 0,
    unparsed: captures.filter((c) => c.unparsed).length,
  };
}

/**
 * The lobbying layer: people, money, agencies and time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * build() above turns captures into two edge types: a registrant FILED_FOR a
 * client, and an org APPEARS_UNDER a search subject. That is the whole graph.
 *
 * Meanwhile lobby.js has been parsing every Senate LDA capture on disk into
 * filings that carry: the LOBBYISTS by name, the GOVERNMENT ENTITIES they
 * contacted, the INCOME the firm reported receiving, the EXPENSES an
 * organisation reported spending on itself, the ISSUE codes, the filing YEAR
 * and QUARTER, and a URL to the sworn document. All of it. On disk. Parsed.
 *
 * And the graph threw every field of it away except two names.
 *
 * So a question like "who actually lobbied for this client, at which agency,
 * in which quarter, for how much" was unanswerable from a graph built on the
 * exact filings that answer it. This is the bridge. It adds no new source and
 * makes no new request; it stops discarding what was already read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE RULES THAT ARE NOT NEGOTIABLE HERE
 *
 * 1. INCOME AND EXPENSES ARE NOT THE SAME MONEY, and are never added.
 *    `income` is what an outside firm reports RECEIVING from a client.
 *    `expenses` is what an organisation reports SPENDING lobbying for itself.
 *    Summing them double-counts in one direction and invents a payer in the
 *    other. They stay in separate fields, with separate names, forever.
 *
 * 2. AMENDMENTS RESTATE A QUARTER, they do not add to it. Money is summed
 *    over DEDUPED filings only — lobby.js's dedupe() keeps the amendment and
 *    drops the original — or a corrected filing is counted twice and the
 *    total is simply wrong.
 *
 * 3. A LOBBYIST NAME IS NOT A PERSON. "J. Smith" at two firms may be two
 *    people; the LDA carries no identifier. These nodes are keyed on the
 *    name as filed and say so. Treating them as resolved identities is the
 *    error this desk exists to refuse, and it is the operator's call to
 *    make with a document in hand, not this file's to make silently.
 */
function buildLobbyLayer(captureDir, L) {
  const read = L.readFilings(captureDir);
  const filings = L.dedupe(read.filings);

  // THE ORG KEY MUST BE THE SAME ONE build() USED. Org nodes are keyed on the
  // normalised name, so an edge carrying the raw display name matches nothing
  // and the whole layer lands as orphans that no query ever returns — a graph
  // that looks richer and answers exactly as much as before.
  const key = (name) => X.normalise(name);

  const people = new Map();     // name -> {name}
  const agencies = new Map();   // name -> {name}
  const issues = new Map();     // code -> {code}

  const lobbiedFor = new Map();     // person -> client
  const registeredWith = new Map(); // person -> registrant firm
  const contacted = new Map();      // client -> agency
  const onIssue = new Map();        // client -> issue
  const money = new Map();          // registrant|client -> money + time

  const bump = (map, key, seed) => {
    if (!map.has(key)) map.set(key, seed());
    return map.get(key);
  };
  const yr = (f) => (f.year == null ? null : String(f.year));

  for (const f of filings) {
    const client = (f.client || '').trim();
    const registrant = (f.registrant || '').trim();
    if (!client && !registrant) continue;

    // ---- money and time on the registrant→client relationship --------
    if (client && registrant) {
      // KEYED ON THE NORMALISED NAMES, NOT THE RAW ONES, and this was wrong
      // first time. "Vantage Data Centers, LLC" and "Vantage Data Centers
      // LLC" made two money rows; both then MERGE onto the SAME FILED_FOR
      // edge in Cypher, where the second SET overwrites the first — $50,000
      // reported in Q1 silently replaced by $60,000 from Q2, with nothing
      // anywhere saying a quarter had been dropped. build() has always keyed
      // FILED_FOR on the normalised pair; this has to agree with it exactly.
      const k = JSON.stringify([key(registrant), key(client)]);
      const m = bump(money, k, () => ({
        registrant, client,
        registrant_key: key(registrant), client_key: key(client),
        filings: 0,
        income_reported: null, expenses_reported: null,
        years: new Set(), quarters: new Set(), urls: new Set(),
        // Counted, not silently absorbed: a filing that reports no money is
        // a real filing, and "3 filings, $0" and "3 filings, unreported" are
        // different facts about a relationship.
        filings_with_no_income: 0,
      }));
      m.filings += 1;
      if (Number.isFinite(f.income)) m.income_reported = (m.income_reported || 0) + f.income;
      else m.filings_with_no_income += 1;
      if (Number.isFinite(f.expenses)) m.expenses_reported = (m.expenses_reported || 0) + f.expenses;
      if (yr(f)) m.years.add(yr(f));
      if (f.period) m.quarters.add(f.period);
      if (f.url) m.urls.add(f.url);
    }

    // ---- people -------------------------------------------------------
    for (const name of new Set(f.lobbyists || [])) {
      if (!people.has(name)) people.set(name, { name });
      if (client) {
        const k = JSON.stringify([name, key(client)]);
        const e = bump(lobbiedFor, k, () => ({
          person: name, org: client, org_key: key(client),
          filings: 0, years: new Set(), urls: new Set(),
        }));
        e.filings += 1;
        if (yr(f)) e.years.add(yr(f));
        if (f.url) e.urls.add(f.url);
      }
      if (registrant) {
        const k = JSON.stringify([name, key(registrant)]);
        const e = bump(registeredWith, k, () => ({
          person: name, org: registrant, org_key: key(registrant),
          filings: 0, years: new Set(),
        }));
        e.filings += 1;
        if (yr(f)) e.years.add(yr(f));
      }
    }

    // ---- agencies contacted -------------------------------------------
    for (const name of new Set(f.entities || [])) {
      if (!agencies.has(name)) agencies.set(name, { name });
      if (!client) continue;
      const k = JSON.stringify([key(client), name]);
      const e = bump(contacted, k, () => ({
        org: client, org_key: key(client), agency: name,
        filings: 0, years: new Set(), urls: new Set(),
      }));
      e.filings += 1;
      if (yr(f)) e.years.add(yr(f));
      if (f.url) e.urls.add(f.url);
    }

    // ---- issues --------------------------------------------------------
    for (const code of new Set(f.issues || [])) {
      if (!issues.has(code)) issues.set(code, { code });
      if (!client) continue;
      const k = JSON.stringify([key(client), code]);
      const e = bump(onIssue, k, () => ({
        org: client, org_key: key(client), issue: code,
        filings: 0, years: new Set(),
      }));
      e.filings += 1;
      if (yr(f)) e.years.add(yr(f));
    }
  }

  const yrs = (s) => [...s].sort();
  const out = (m, extra) => [...m.values()].map((e) => ({
    ...e, years: yrs(e.years), ...(extra ? extra(e) : {}),
  }));

  return {
    people: [...people.values()],
    agencies: [...agencies.values()],
    issues: [...issues.values()],
    lobbied_for: out(lobbiedFor, (e) => ({ urls: [...e.urls].sort() })),
    registered_with: out(registeredWith),
    contacted: out(contacted, (e) => ({ urls: [...e.urls].sort() })),
    on_issue: out(onIssue),
    money: [...money.values()].map((m) => ({
      registrant: m.registrant,
      client: m.client,
      registrant_key: m.registrant_key,
      client_key: m.client_key,
      filings: m.filings,
      // Two numbers, never one. See rule 1.
      income_reported: m.income_reported,
      expenses_reported: m.expenses_reported,
      filings_with_no_income: m.filings_with_no_income,
      years: yrs(m.years),
      first_year: yrs(m.years)[0] || null,
      last_year: yrs(m.years).slice(-1)[0] || null,
      quarters: [...m.quarters].sort(),
      urls: [...m.urls].sort(),
    })),
    // Coverage, beside the counts rather than under them.
    filings_read: read.filings.length,
    filings_after_dedupe: filings.length,
    truncated_subjects: read.subjects.filter((s) => s.truncated).length,
    unparsed: read.unparsed.length,
  };
}

/**
 * The Cypher that would be run, as parameterised statements.
 *
 * MERGE, never CREATE. Running this twice must leave the same graph, not two
 * copies of it — you will run it again every time you capture more.
 *
 * Names go in as PARAMETERS, never interpolated into the query text. Company
 * names contain quotes and backslashes, and a name is untrusted input no
 * matter how official the source: string-building a query out of it is how
 * you get an injection in your own database.
 */
function toCypher(graph) {
  const stmts = [];

  stmts.push({
    q: 'CREATE CONSTRAINT org_key IF NOT EXISTS FOR (o:Org) REQUIRE o.key IS UNIQUE',
    params: {},
    note: 'one node per normalised org name',
  });
  stmts.push({
    q: 'CREATE CONSTRAINT subject_name IF NOT EXISTS FOR (s:Subject) REQUIRE s.name IS UNIQUE',
    params: {},
    note: 'one node per search subject',
  });

  if (graph.orgs.length) {
    stmts.push({
      q: `UNWIND $rows AS r
          MERGE (o:Org {key: r.key})
          SET o.name = r.name,
              o.subject_count = toInteger(r.subject_count),
              o.counts_are_floors = $floors`,
      params: { rows: graph.orgs, floors: graph.counts_are_floors },
      note: `${graph.orgs.length} organisations`,
    });
  }

  if (graph.subjects.length) {
    stmts.push({
      q: `UNWIND $rows AS r
          MERGE (s:Subject {name: r.name})`,
      params: { rows: graph.subjects },
      note: `${graph.subjects.length} subjects (searches you ran)`,
    });
  }

  if (graph.filed.length) {
    stmts.push({
      q: `UNWIND $rows AS r
          MATCH (reg:Org {key: r.registrant})
          MATCH (cli:Org {key: r.client})
          MERGE (reg)-[f:FILED_FOR]->(cli)
          SET f.filings = toInteger(r.filings),
              f.subjects = r.subjects,
              f.urls = r.urls,
              f.basis = 'senate_lda_filing',
              f.counts_are_floors = $floors`,
      params: { rows: graph.filed, floors: graph.counts_are_floors },
      note: `${graph.filed.length} FILED_FOR relationships (sworn filings)`,
    });
  }

  if (graph.appears.length) {
    stmts.push({
      q: `UNWIND $rows AS r
          MATCH (o:Org {key: r.org})
          MATCH (s:Subject {name: r.subject})
          MERGE (o)-[a:APPEARS_UNDER]->(s)
          SET a.hits = toInteger(r.hits),
              a.connectors = r.connectors,
              a.basis = 'search_result'`,
      params: { rows: graph.appears },
      note: `${graph.appears.length} APPEARS_UNDER relationships (search results, NOT relationships between orgs)`,
    });
  }


  // ── THE LOBBYING LAYER: people, money, agencies, time ────────────────
  //
  // Every edge below comes from a SWORN, DATED filing with a URL. That is
  // what makes them DOCUMENTED rather than derived, and why each carries
  // `basis` and its source urls: an edge you cannot walk back to a document
  // is an assertion, and this graph does not store assertions.
  if (graph.lobby) {
    const g = graph.lobby;

    stmts.push({
      q: 'CREATE CONSTRAINT person_name IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE',
      params: {},
      note: 'one node per lobbyist NAME AS FILED — not per person; the LDA carries no identifier',
    });
    stmts.push({
      q: 'CREATE CONSTRAINT agency_name IF NOT EXISTS FOR (a:Agency) REQUIRE a.name IS UNIQUE',
      params: {}, note: 'one node per government entity lobbied',
    });
    stmts.push({
      q: 'CREATE CONSTRAINT issue_code IF NOT EXISTS FOR (i:Issue) REQUIRE i.code IS UNIQUE',
      params: {}, note: 'one node per general issue code',
    });

    if (g.people.length) stmts.push({
      q: `UNWIND $rows AS r
          MERGE (p:Person {name: r.name})
          SET p.is_resolved_identity = false`,
      params: { rows: g.people },
      note: `${g.people.length} lobbyist name(s) — a NAME, not a resolved person`,
    });
    if (g.agencies.length) stmts.push({
      q: 'UNWIND $rows AS r MERGE (a:Agency {name: r.name})',
      params: { rows: g.agencies }, note: `${g.agencies.length} government entities`,
    });
    if (g.issues.length) stmts.push({
      q: 'UNWIND $rows AS r MERGE (i:Issue {code: r.code})',
      params: { rows: g.issues }, note: `${g.issues.length} issue codes`,
    });

    if (g.lobbied_for.length) stmts.push({
      q: `UNWIND $rows AS r
          MATCH (p:Person {name: r.person})
          MATCH (o:Org {key: r.org_key})
          MERGE (p)-[e:LOBBIED_FOR]->(o)
          SET e.filings = toInteger(r.filings), e.years = r.years,
              e.urls = r.urls, e.basis = 'senate_lda_filing'`,
      params: { rows: g.lobbied_for }, note: `${g.lobbied_for.length} person → client`,
    });
    if (g.registered_with.length) stmts.push({
      q: `UNWIND $rows AS r
          MATCH (p:Person {name: r.person})
          MATCH (o:Org {key: r.org_key})
          MERGE (p)-[e:REGISTERED_WITH]->(o)
          SET e.filings = toInteger(r.filings), e.years = r.years,
              e.basis = 'senate_lda_filing'`,
      params: { rows: g.registered_with }, note: `${g.registered_with.length} person → firm`,
    });
    if (g.contacted.length) stmts.push({
      q: `UNWIND $rows AS r
          MATCH (o:Org {key: r.org_key})
          MATCH (a:Agency {name: r.agency})
          MERGE (o)-[e:LOBBIED]->(a)
          SET e.filings = toInteger(r.filings), e.years = r.years,
              e.urls = r.urls, e.basis = 'senate_lda_filing'`,
      params: { rows: g.contacted }, note: `${g.contacted.length} client → agency` });
    if (g.on_issue.length) stmts.push({
      q: `UNWIND $rows AS r
          MATCH (o:Org {key: r.org_key})
          MATCH (i:Issue {code: r.issue})
          MERGE (o)-[e:ON_ISSUE]->(i)
          SET e.filings = toInteger(r.filings), e.years = r.years,
              e.basis = 'senate_lda_filing'`,
      params: { rows: g.on_issue }, note: `${g.on_issue.length} client → issue` });

    // Money goes onto the EXISTING FILED_FOR edge rather than a new one:
    // it is a property of that relationship, and a second parallel edge
    // would double every count anyone runs over it.
    if (g.money.length) stmts.push({
      q: `UNWIND $rows AS r
          MATCH (reg:Org {key: r.registrant_key})
          MATCH (cli:Org {key: r.client_key})
          MERGE (reg)-[f:FILED_FOR]->(cli)
          SET f.income_reported = r.income_reported,
              f.expenses_reported = r.expenses_reported,
              f.filings_with_no_income = toInteger(r.filings_with_no_income),
              f.years = r.years, f.first_year = r.first_year,
              f.last_year = r.last_year, f.quarters = r.quarters`,
      params: { rows: g.money },
      note: `money and time on ${g.money.length} filing relationship(s) — `
        + 'income and expenses are SEPARATE fields and are never added',
    });
  }

  return stmts;
}

/**
 * QUERIES — reading the graph from the terminal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THESE LIVE IN THE TOOL AND NOT IN A DOCUMENT
 *
 * A guide told the operator to open Neo4j Browser and paste Cypher into it.
 * He pasted it into zsh, because it arrived in the same shape as every other
 * command he had run that day, and got
 *
 *     zsh: no matches found: (o:Org)-[:APPEARS_UNDER]-/dev/fd/12
 *     zsh: command not found: WITH
 *
 * That is not a user error. `(`, `[`, `>` and `*` are all shell metacharacters,
 * so Cypher pasted at a prompt does not fail cleanly -- zsh globs it, opens
 * process substitutions, and reports something that looks like a filesystem
 * problem. The instruction "run this somewhere else" is the weakest guard
 * there is: it depends on being read.
 *
 * So the queries are commands. `connect graph --ask bridges` runs one against
 * the same database `--push` writes to, using the same credentials, and prints
 * a table. There is nothing to paste anywhere.
 *
 * Each carries `why` — what the rows mean and what they do not — because a
 * result set with no denominator beside it is how "bridges 4 of 4 clients"
 * became the strongest finding on this desk and turned out to be arithmetic.
 */
const QUERIES = {
  coverage: {
    what: 'how much of the graph asserts nothing at all',
    why: 'These organisations are in the graph ONLY because a search returned '
      + 'their name. No filing connects them to anything. Run this first: it is '
      + 'the denominator for every other query here.',
    cypher: `
      MATCH (o:Org)
      WITH count(o) AS total
      MATCH (o2:Org) WHERE NOT (o2)-[:FILED_FOR]-()
      RETURN total AS organisations,
             count(o2) AS no_sworn_edge,
             total - count(o2) AS in_a_filing`,
  },

  bridges: {
    what: 'registrants whose sworn filings connect SEVERAL of your threads',
    why: 'Ordered by client count ascending, so the small books come first. '
      + 'Read `from_one_client` before anything else: it is the largest number '
      + 'of subjects reached through a SINGLE client, so when it equals '
      + '`threads`, this firm bridges nothing — one client of theirs is simply '
      + 'a name you searched under many spellings. `filings_in_library` counts '
      + 'what YOU captured, not what exists; the real book size is in '
      + 'evidence/registrant_books.json.',
    cypher: `
      MATCH (reg:Org)-[:FILED_FOR]->(cli:Org)-[:APPEARS_UNDER]->(s:Subject)
      WITH reg, cli, count(DISTINCT s) AS per_client
      WITH reg, count(DISTINCT cli) AS clients, max(per_client) AS from_one_client
      WHERE clients >= 2
      MATCH (reg)-[f:FILED_FOR]->(c2:Org)-[:APPEARS_UNDER]->(s2:Subject)
      WITH reg, clients, from_one_client,
           count(DISTINCT s2)             AS threads,
           sum(f.filings)                 AS filings_in_library,
           collect(DISTINCT s2.name)[..4] AS via
      WHERE threads >= 2
      RETURN reg.name AS registrant, clients, threads, from_one_client,
             filings_in_library, via
      ORDER BY clients ASC, threads DESC
      LIMIT $limit`,
  },

  noise: {
    what: 'names that turn up under everything, which is usually a name problem',
    why: 'An organisation under a dozen unrelated subjects is generally a '
      + 'generic name, a word inside a court caption, or a company so large it '
      + 'appears everywhere. Distrust these rows before any others.',
    cypher: `
      MATCH (o:Org)-[:APPEARS_UNDER]->(s:Subject)
      WITH o, count(DISTINCT s) AS breadth
      WHERE breadth >= 10
      RETURN o.name AS organisation, breadth
      ORDER BY breadth DESC
      LIMIT $limit`,
  },

  firm: {
    what: 'one registrant\'s sworn book, with the filing URLs',
    needsTerm: true,
    why: 'FILED_FOR carries the filings themselves. THAT is what you cite. '
      + 'Never cite the graph.',
    cypher: `
      MATCH (reg:Org)-[f:FILED_FOR]->(cli:Org)
      WHERE toLower(reg.name) CONTAINS toLower($term)
      RETURN reg.name AS registrant, cli.name AS client,
             f.filings AS filings, f.subjects AS subjects, f.urls[0..2] AS cite
      ORDER BY f.filings DESC
      LIMIT $limit`,
  },

  thread: {
    what: 'everything sitting under the subjects matching a word',
    needsTerm: true,
    why: 'These are SEARCH RESULTS. A row here means a source returned this '
      + 'name for that subject, and nothing more.',
    cypher: `
      MATCH (o:Org)-[a:APPEARS_UNDER]->(s:Subject)
      WHERE toLower(s.name) CONTAINS toLower($term)
      RETURN s.name AS subject, o.name AS organisation,
             a.hits AS hits, a.connectors AS sources
      ORDER BY subject, hits DESC
      LIMIT $limit`,
  },

  pair: {
    what: 'organisations that share several subjects, and WHY',
    why: 'The `via` column is the point. Two companies under one subject are '
      + 'two hops apart THROUGH that subject; there is no edge between them. '
      + 'Read `via` and you will often find the answer is "because you searched '
      + 'for both of them".',
    cypher: `
      MATCH (a:Org)-[:APPEARS_UNDER]->(s:Subject)<-[:APPEARS_UNDER]-(b:Org)
      WHERE a.key < b.key
      WITH a, b, count(DISTINCT s) AS shared, collect(DISTINCT s.name)[..4] AS via
      WHERE shared >= 3
      RETURN a.name AS one, b.name AS other, shared, via
      ORDER BY shared DESC
      LIMIT $limit`,
  },
};

/**
 * Run the statements against a session.
 *
 * `session` is anything with `.run(query, params)` returning a promise — the
 * real neo4j-driver session, or a fake in the tests. Statements run in order;
 * the MERGEs on relationships need their nodes to exist first.
 */
async function push(graph, session) {
  const stmts = toCypher(graph);
  const done = [];
  for (const s of stmts) {
    await session.run(s.q, s.params);
    done.push(s.note);
  }
  return done;
}

/**
 * Is this password a placeholder someone copied out of the docs?
 *
 * Without this the mistake surfaces much later as "Neo4j rejected the
 * credentials", which sends you looking at the database instead of at the
 * .env you just wrote. 'neo4j' is included because it is the factory default
 * that Neo4j itself forces you to change on first login -- if it is still
 * that, the database has not been set up yet.
 */
const PLACEHOLDER_PASSWORDS = new Set([
  'whatever-you-set', 'the-password-you-set', 'your-password', 'yourpassword',
  'changeme', 'change-me', 'password', 'neo4j', 'xxx', '...', 'secret',
]);

/**
 * Describe a secret without printing it.
 *
 * "Neo4j rejected the credentials" with no other detail is the same failure
 * shape as `KEY REJECTED — check for a typo` pointing at a key that was never
 * sent: it tells you the database said no, and nothing about what was asked.
 * The three things that actually go wrong here are a value that is empty, one
 * that arrived wrapped in quotes, and one with a stray space on the end --
 * all invisible in a terminal, all diagnosable from length alone.
 */
function describeSecret(pass) {
  if (pass === undefined || pass === null) return 'not set';
  const raw = String(pass);
  if (!raw.length) return 'empty';
  const notes = [];
  if (/^["'].*["']$/.test(raw)) notes.push('wrapped in quotes');
  if (raw !== raw.trim()) notes.push('has leading/trailing whitespace');
  const head = raw.trim().slice(0, 1);
  return `${raw.length} chars, starts with "${head}"${notes.length ? ' — ' + notes.join(', ') : ''}`;
}

// The distinctive ones from the docs. Nobody's real password contains these
// as a substring, so a value merely CONTAINING one is still the placeholder,
// half-edited -- "whatever-you-set" with a character appended is 17 chars
// starting with "w", passes an exact-match check, and fails at the database
// as a plain credentials error.
const PLACEHOLDER_FRAGMENTS = [
  'whatever-you-set', 'the-password-you-set', 'your-password',
  'password-you-set', 'yourpassword', 'change-me', 'changeme',
];

function isPlaceholderPassword(pass) {
  if (!pass) return false;
  const v = String(pass).trim().toLowerCase();
  if (PLACEHOLDER_PASSWORDS.has(v)) return true;
  return PLACEHOLDER_FRAGMENTS.some((frag) => v.includes(frag));
}

/**
 * Read back what is actually in the database.
 *
 * WHY A PUSH IS NOT DONE WHEN THE WRITES RETURN
 *   Every statement can succeed and the graph still be somewhere you are not
 *   looking. Neo4j serves several databases from one instance -- writes land
 *   in the one the session names, Browser reads the one IT is pointed at, and
 *   nothing warns you they differ. `Done.` printed over an empty database is
 *   the calmest possible lie.
 *
 *   So the command counts what is there afterwards and compares it to what it
 *   meant to write, and reports success only if they agree.
 */
async function verify(session) {
  const nodes = await session.run(
    'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n');
  const rels = await session.run(
    'MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS n');

  // The driver returns Integer objects for counts; toNumber() where present.
  const num = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
  const out = { nodes: {}, rels: {} };
  for (const rec of nodes.records || []) out.nodes[rec.get('label')] = num(rec.get('n'));
  for (const rec of rels.records || []) out.rels[rec.get('rel')] = num(rec.get('n'));
  return out;
}

/**
 * Compare what is in the database against what we set out to write.
 * Returns the mismatches, empty when everything agrees.
 */
function reconcile(graph, actual) {
  const expected = {
    nodes: { Org: graph.orgs.length, Subject: graph.subjects.length },
    rels: { FILED_FOR: graph.filed.length, APPEARS_UNDER: graph.appears.length },
  };
  const problems = [];
  for (const kind of ['nodes', 'rels']) {
    for (const [name, want] of Object.entries(expected[kind])) {
      const got = actual[kind][name] || 0;
      // Greater than expected is fine: the database may hold earlier pushes
      // or other data. Fewer than expected means the write did not land.
      if (got < want) problems.push({ kind, name, want, got });
    }
  }
  return problems;
}

module.exports = {
  QUERIES,
  build, buildLobbyLayer, toCypher, push, isLocal, readEnv, LOCAL_HOSTS,
  isPlaceholderPassword, PLACEHOLDER_PASSWORDS, PLACEHOLDER_FRAGMENTS, describeSecret,
  verify, reconcile,
};
