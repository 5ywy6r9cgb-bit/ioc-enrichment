#!/usr/bin/env node
'use strict';
/**
 * Tests for the notification content guard.
 *
 * This guard is the only thing standing between an investigative system and a
 * lock screen on a phone, so it gets a test that names real addresses from the
 * seed data rather than toy strings. Two of these cases are here because the
 * first version of the guard let them through:
 *
 *   "742 Evergreen Terrace"  — Terrace was missing from the suffix list
 *   "7232 E Main St"         — a single-letter directional broke the name match
 *
 * Both are exactly the shape of address that appears in seed_agencies.csv.
 */

const n = require('./notify.js');

const CASES = [
  // --- signals: a count and an id. These must pass. -----------------------
  ['3 new on WATCH-HB6-01', true],
  ['2 new on WATCH-FLOCK-01 · 1 failed', true],
  ['0 new — all quiet', true],
  ['5 new on WATCH-PUCO-01, 2 failed', true],
  ['1 new on WATCH-WATER-01', true],

  // --- case content: must be refused --------------------------------------
  ['SSN 123-45-6789 found', false],
  ['account number 88213344', false],
  ['card 4111 1111 1111 1111', false],

  // --- addresses, all drawn from the real seed set ------------------------
  ['subject at 742 Evergreen Terrace', false],
  ['office at 7232 E Main St', false],
  ['1520 Davidson Dr', false],
  ['200 S Hamilton Rd, Gahanna', false],
  ['90 W Broad St Columbus OH', false],
  ['373 S High St', false],
  ['1402 Brice Rd', false],

  // --- a summary instead of a signal --------------------------------------
  ['x'.repeat(300), false],
];

(async () => {
  let fail = 0;
  for (const [body, want] of CASES) {
    const r = await n.send({ title: 'Sentinel watch', body, config: { backend: 'none' } });
    const ok = r.ok === want;
    if (!ok) fail += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.ok ? 'ALLOW ' : 'REFUSE'}  ${JSON.stringify(body.slice(0, 44))}`);
  }
  // The title is guarded on the same path as the body.
  const t = await n.send({ title: 'SSN 123-45-6789', body: 'ok', config: { backend: 'none' } });
  const titleOk = !t.ok;
  if (!titleOk) fail += 1;
  console.log(`  ${titleOk ? 'PASS' : 'FAIL'}  ${t.ok ? 'ALLOW ' : 'REFUSE'}  "…title is guarded too"`);

  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${fail} failure(s) of ${CASES.length + 1} checks`);
  process.exit(fail ? 1 : 0);
})();
