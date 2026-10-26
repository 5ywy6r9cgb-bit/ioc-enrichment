#!/usr/bin/env node
'use strict';
/**
 * graph_full.js — the typed entity graph: every edge edges.js can evidence,
 * pushed to Neo4j with its evidence tier on the SHAPE, not only on a property.
 *
 * Built on edges.js, so it inherits that file's refusals: no owned_by, no
 * officer_of, no banks_with, no crypto edges. An absent edge type is an absent
 * register, and the graph does not draw a slot for it.
 *
 *   (:Org)-[:REPRESENTED_BY]->(:Org)         ASSERTED   sworn LDA filing
 *   (:Org)-[:RECEIVED_AWARD_FROM]->(:Agency) ASSERTED   federal award record
 *   (:Org)-[:REGISTERED_IN]->(:Jurisdiction) REGISTRY   company registry
 *   (:Org)-[:PARTY_TO]->(:Docket)            ASSERTED   court party table
 *   (:Subject)-[:SEARCH_RETURNED]->(:Record) CO-OCCURRENCE  a string in an index
 *
 * A mention never touches an Org node. It joins a search SUBJECT to a RECORD
 * the index returned, so two companies that merely co-occur are never one hop
 * apart. Nodes are NAMES: `identity: 'NAME_ONLY'`. Nothing is merged, and a
 * subsidiary and a namesake look identical here, as the register itself cannot
 * tell them apart.
 *
 * Money is carried as `amount_text`, exactly as the register printed it. It is
 * never parsed, converted or summed. Different measures never add.
 *
 * Pure: build() and toCypher() need no driver, so the suite runs with a fake.
 */

const crypto = require('crypto');
const X = require('./crosslink.js');

const REL_TYPE = {
  represented_by: { type: 'REPRESENTED_BY', toLabel: 'Org' },
  received_award_from: { type: 'RECEIVED_AWARD_FROM', toLabel: 'Agency' },
  registered_in: { type: 'REGISTERED_IN', toLabel: 'Jurisdiction' },
  party_to: { type: 'PARTY_TO', toLabel: 'Docket' },
};

function docKey(e) {
  if (e.document_id) return `${e.source}:${e.document_id}`;
  if (e.source_url) return `${e.source}:${e.source_url}`;
  const h = crypto.createHash('sha1')
    .update([e.source, e.subject, e.entity_a, e.relationship, e.entity_b,
      e.amount, e.effective_date].join('|')).digest('hex').slice(0, 16);
  return `${e.source}:h:${h}`;
}

function props(e) {
  return {
    doc: docKey(e),
    tier: e.assertion_type,
    register: e.register,
    authority: e.authority,
    amount_text: e.amount,
    jurisdiction: e.jurisdiction,
    effective_date: e.effective_date,
    record_date: e.record_date,
    source_date: e.source_date,
    source: e.source,
    source_url: e.source_url,
    subject: e.subject,
    status: e.status,
  };
}

function build(edges) {
  const nodes = { Org: new Map(), Agency: new Map(), Jurisdiction: new Map(),
    Docket: new Map(), Subject: new Map(), Record: new Map() };
  const rels = { REPRESENTED_BY: [], RECEIVED_AWARD_FROM: [], REGISTERED_IN: [],
    PARTY_TO: [], SEARCH_RETURNED: [] };
  const seen = new Set();

  const put = (label, name) => {
    const key = X.normalise(name);
    if (!key) return null;
    if (!nodes[label].has(key)) nodes[label].set(key, { key, name });
    return key;
  };

  for (const e of edges || []) {
    const spec = REL_TYPE[e.relationship];
    if (spec) {
      const a = put('Org', e.entity_a);
      const b = put(spec.toLabel, e.entity_b);
      if (!a || !b) continue;
      const p = props(e);
      const id = `${spec.type}|${a}|${b}|${p.doc}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rels[spec.type].push({ a, b, p });
    } else if (e.relationship === 'mentioned_in') {
      const s = put('Subject', e.entity_a);
      const r = put('Record', e.entity_b);
      if (!s || !r) continue;
      const p = props(e);
      const id = `SEARCH_RETURNED|${s}|${r}|${p.doc}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rels.SEARCH_RETURNED.push({ a: s, b: r, p });
    }
  }

  return {
    nodes: Object.fromEntries(Object.entries(nodes).map(([k, m]) => [k, [...m.values()]])),
    rels,
    edge_count: Object.values(rels).reduce((n, r) => n + r.length, 0),
  };
}

/** Parameterised, MERGE-only Cypher. Names are never interpolated. */
function toCypher(g) {
  const stmts = [];
  const cons = [['Org', 'key'], ['Agency', 'key'], ['Jurisdiction', 'key'],
    ['Docket', 'key'], ['Record', 'key'], ['Subject', 'name']];
  for (const [label, prop] of cons) {
    stmts.push({
      q: `CREATE CONSTRAINT ${label.toLowerCase()}_${prop}_full IF NOT EXISTS `
        + `FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`,
      params: {}, note: `constraint ${label}.${prop}`,
    });
  }
  for (const label of ['Org', 'Agency', 'Jurisdiction', 'Docket', 'Record']) {
    const rows = g.nodes[label];
    if (!rows.length) continue;
    stmts.push({
      q: `UNWIND $rows AS r MERGE (n:${label} {key: r.key})
          SET n.name = r.name, n.identity = 'NAME_ONLY'`,
      params: { rows }, note: `${rows.length} ${label} node(s)`,
    });
  }
  if (g.nodes.Subject.length) {
    stmts.push({
      q: 'UNWIND $rows AS r MERGE (s:Subject {name: r.name})',
      params: { rows: g.nodes.Subject }, note: `${g.nodes.Subject.length} Subject node(s)`,
    });
  }
  const labelOf = { REPRESENTED_BY: ['Org', 'Org'], RECEIVED_AWARD_FROM: ['Org', 'Agency'],
    REGISTERED_IN: ['Org', 'Jurisdiction'], PARTY_TO: ['Org', 'Docket'] };
  for (const [type, [la, lb]] of Object.entries(labelOf)) {
    const rows = g.rels[type];
    if (!rows.length) continue;
    stmts.push({
      q: `UNWIND $rows AS r
          MATCH (a:${la} {key: r.a}) MATCH (b:${lb} {key: r.b})
          MERGE (a)-[x:${type} {doc: r.p.doc}]->(b)
          SET x += r.p`,
      params: { rows }, note: `${rows.length} ${type} edge(s)`,
    });
  }
  if (g.rels.SEARCH_RETURNED.length) {
    stmts.push({
      q: `UNWIND $rows AS r
          MATCH (s:Subject {name: r.a}) MATCH (rec:Record {key: r.b})
          MERGE (s)-[x:SEARCH_RETURNED {doc: r.p.doc}]->(rec)
          SET x += r.p`,
      params: { rows: g.rels.SEARCH_RETURNED.map((x) => ({ ...x, a: g.nodes.Subject.find((n) => n.key === x.a).name })) },
      note: `${g.rels.SEARCH_RETURNED.length} SEARCH_RETURNED edge(s) (a string in an index, NOT a relationship)`,
    });
  }
  return stmts;
}

async function push(g, session) {
  const done = [];
  for (const s of toCypher(g)) {
    await session.run(s.q, s.params);
    done.push(s.note);
  }
  return done;
}

/** Fewer in the database than we wrote means the write did not land. */
function reconcile(g, actualRels) {
  const problems = [];
  for (const [type, rows] of Object.entries(g.rels)) {
    const got = actualRels[type] || 0;
    if (got < rows.length) problems.push({ name: type, want: rows.length, got });
  }
  return problems;
}

module.exports = { build, toCypher, push, reconcile, docKey, REL_TYPE };
