#!/usr/bin/env node
/** A10: rows the name test calls SUBSTRING or UNKNOWN stay out of edges by default, and the exclusion is counted. */
const assert = require('assert');
const E = require('./edges.js');
const cap = (connector, subject, names) => ({ connector, subject, file: `live_capture_${connector}_x_2026-10-27T00-00-00-000Z.json`,
  results: names.map((n) => ({ name: n, agency: 'DoD', amount: '1' })) });
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok    ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name}: ${e.message}`); } }

const caps = [cap('usaspending', 'RTX Corporation', ['RTX CORPORATION', 'ARTXOS HOLDINGS'])];
t('a real name match is kept', () => { assert.ok(E.build(caps).some((e) => /RTX CORPORATION/.test(e.entity_a))); });
t('a buried-word substring hit is excluded by default and counted', () => {
  const edges = E.build(caps);
  assert.ok(!edges.some((e) => /ARTXOS/.test(e.entity_a)));
  assert.ok(edges.excludedNoise >= 1);
});
t('includeNoise keeps it, so the exclusion can be audited', () => {
  assert.ok(E.build(caps, { includeNoise: true }).some((e) => /ARTXOS/.test(e.entity_a)));
});
t('docket and identifier connectors are never name-filtered', () => {
  const edges = E.build([cap('cldocket', '0:22-cr-00223', ['SOME PARTY'])]);
  assert.strictEqual(edges.length, 1);
});
console.log(`\n  ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
