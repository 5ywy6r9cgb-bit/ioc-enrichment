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

  return stmts;
}

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
  build, toCypher, push, isLocal, readEnv, LOCAL_HOSTS,
  isPlaceholderPassword, PLACEHOLDER_PASSWORDS, PLACEHOLDER_FRAGMENTS, describeSecret,
  verify, reconcile,
};
