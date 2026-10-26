'use strict';
/**
 * test_graph_full.js — the typed graph must not say more than the edges do.
 * The load-bearing checks: a mention never becomes an Org-to-Org line, money is
 * carried as the register printed it and never parsed, and nothing is merged.
 */
const F = require('./graph_full.js');
const E = require('./edges.js');

let PASS = 0, FAIL = 0;
const check = (l, c, d) => { if (c) { PASS++; console.log(`    PASS  ${l}`); } else { FAIL++; console.log(`    FAIL  ${l}${d ? `\n          ${d}` : ''}`); } };

const e = (o) => E.build([{ file: 'x_2026-10-01T00.json', connector: o.c, subject: o.s, results: [o.r] }])[0];
const edges = [
  e({ c: 'senatelda', s: 'Kalshi', r: { name: 'KALSHI — ALPINE GROUP PARTNERS, LLC', amount: '$485,000', external_id: 'a1', url: 'https://lda.gov/a1', period: '2025 Q3' } }),
  e({ c: 'usaspending', s: 'Intel', r: { name: 'INTEL CORPORATION', agency: 'Department of Defense', amount: '$16,800,000', award_id: 'H982300820011' } }),
  e({ c: 'usaspending', s: 'Intel', r: { name: 'INTEL FEDERAL LLC', agency: 'Department of Energy', amount: '$8,353,806', award_id: 'DESC0008717' } }),
  e({ c: 'opencorporates', s: 'Cologix', r: { name: 'COLOGIX, INC.', jurisdiction: 'us_de', incorporated: '2010-10-20' } }),
  e({ c: 'cldocket', s: 'Flock', r: { name: 'Flock Group Inc', docket: '5:23-cv-02198', court: 'ohnd' } }),
  e({ c: 'federalregister', s: 'Cologix', r: { name: 'Some Notice About "Quotes" and \\backslashes' } }),
  e({ c: 'federalregister', s: 'Intel', r: { name: 'Some Notice About "Quotes" and \\backslashes' } }),
];
// the same filing seen twice must not double
edges.push(edges[0]);

console.log('\n  graph_full.js');
const g = F.build(edges);
check('REPRESENTED_BY is one hop between orgs', g.rels.REPRESENTED_BY.length === 1);
check('award edge goes to an Agency node, not an Org', g.rels.RECEIVED_AWARD_FROM.length === 2 && g.nodes.Agency.length === 2);
check('Intel Corporation and Intel Federal LLC are NOT merged',
  g.nodes.Org.filter((o) => /intel/i.test(o.name)).length === 2);
check('registry edge goes to a Jurisdiction', g.rels.REGISTERED_IN.length === 1 && g.nodes.Jurisdiction.length === 1);
check('party edge goes to a Docket', g.rels.PARTY_TO.length === 1 && g.nodes.Docket.length === 1);
check('duplicate of the same filing does not double', g.rels.REPRESENTED_BY.length === 1);
check('mentions join Subject to Record only', g.rels.SEARCH_RETURNED.length === 2
  && g.rels.SEARCH_RETURNED.every((r) => g.nodes.Subject.some((n) => n.key === r.a) && g.nodes.Record.some((n) => n.key === r.b)));
check('a mention creates NO Org node', !g.nodes.Org.some((o) => /notice about/i.test(o.name)));
check('amount is carried as printed, not a number', g.rels.REPRESENTED_BY[0].p.amount_text === '$485,000'
  && typeof g.rels.REPRESENTED_BY[0].p.amount_text === 'string');
check('tier is on every edge', Object.values(g.rels).flat().every((r) => r.p.tier));
check('registry tier is REGISTRY, not ASSERTED', g.rels.REGISTERED_IN[0].p.tier === 'REGISTRY');
check('mention tier is CO-OCCURRENCE', g.rels.SEARCH_RETURNED.every((r) => r.p.tier === 'CO-OCCURRENCE'));

const stmts = F.toCypher(g);
check('every write is MERGE, never CREATE of data', stmts.filter((s) => !/CONSTRAINT/.test(s.q)).every((s) => /MERGE/.test(s.q) && !/\bCREATE \(/.test(s.q)));
check('names go in as parameters, not in the query text',
  stmts.every((s) => !/Quotes|backslashes|Kalshi|Intel/.test(s.q)));
check('no SUM or arithmetic on money anywhere', stmts.every((s) => !/\bsum\(|toFloat|toInteger\(r\.p\.amount/i.test(s.q)));
check('nodes are marked NAME_ONLY', stmts.some((s) => /NAME_ONLY/.test(s.q)));
const ci = stmts.findIndex((s) => /CONSTRAINT/.test(s.q));
const ni = stmts.findIndex((s) => /MERGE \(n:Org/.test(s.q));
const ri = stmts.findIndex((s) => /MERGE \(a\)-\[x:REPRESENTED_BY/.test(s.q));
check('constraints, then nodes, then relationships', ci >= 0 && ni > ci && ri > ni);

(async () => {
  const calls = [];
  const notes = await F.push(g, { run: async (q, p) => { calls.push({ q, p }); return { records: [] }; } });
  check('push runs every statement against the session', calls.length === stmts.length && notes.length === stmts.length);
  check('reconcile passes when the database holds what we wrote',
    F.reconcile(g, { REPRESENTED_BY: 1, RECEIVED_AWARD_FROM: 2, REGISTERED_IN: 1, PARTY_TO: 1, SEARCH_RETURNED: 2 }).length === 0);
  check('reconcile catches a write that did not land', F.reconcile(g, { REPRESENTED_BY: 0 }).length > 0);
  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exit(1);
})();
