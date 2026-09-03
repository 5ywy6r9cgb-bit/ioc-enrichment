#!/usr/bin/env node
'use strict';
/**
 * scripts/foia_dash.js — build the records-request screen from the store.
 *
 * Reads the SAME place `sentinel pra foia` reads (evidence/foia_requests.json,
 * or PRA_FOIA_STORE), runs the SAME tracker, and renders the result. The
 * screen therefore cannot disagree with the terminal, which is the entire
 * reason this exists rather than a second query against Postgres.
 *
 * Output goes to evidence/foia_dashboard.html — inside the gitignored evidence
 * tree, because a page listing which agencies the operator is pressing and
 * what he is looking for is working material, not source. The old
 * app/dashboard.html was committed, and that was a mistake nobody had noticed
 * because it happened to hold only seed data.
 *
 * Usage:
 *   node scripts/foia_dash.js            build it, print the path
 *   node scripts/foia_dash.js --open     build it and open it
 *   node scripts/foia_dash.js --out P    write somewhere else
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { FoiaStore } = require('../server/foia_store.js');
const tracker = require('../server/foia_tracker.js');
const view = require('../server/foia_dashboard.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};

/**
 * Mirror of foia.js:normalise(). The store's field names and the tracker's
 * expectations differ by history, and a request that arrives with no clock is
 * reported as "nothing due" — the failure that once printed "Nothing needs
 * you" over a request 22 business days silent. Keep this aligned with
 * scripts/foia.js; test_foia_dash.js asserts the two agree.
 */
function normalise(r) {
  return Object.assign({}, r, {
    request_id: r.request_id || r.id,
    agency_name: r.agency_name || r.agency,
    submitted_on: r.submitted_on || r.filed_on || r.filed_date || null,
  });
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const out = outIdx >= 0 && argv[outIdx + 1]
    ? path.resolve(argv[outIdx + 1])
    : path.join(repoRoot, 'evidence', 'foia_dashboard.html');

  const store = new FoiaStore(process.env.PRA_FOIA_STORE || null);
  const requests = store.list().map(normalise);
  const t = tracker.triage(requests);

  const html = view.render(t, { storePath: path.relative(repoRoot, store.file) });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);

  console.log('');
  console.log(`  ${C.b('Records requests')}  ${C.d(String(t.total) + ' tracked')}`);
  if (t.needs_attention) {
    console.log(`  ${C.y(String(t.needs_attention) + ' need you now')}`);
  } else if (t.total) {
    console.log(`  ${C.g('nothing needs you')} ${C.d('— all inside cadence or closed')}`);
  } else {
    // An empty store is not an error and must not read as a clean desk.
    // "0 tracked" and "0 overdue" look identical on a dashboard; say which.
    console.log(`  ${C.d('no requests recorded yet — this page will be empty')}`);
    console.log(`  ${C.d('add one:  sentinel pra foia add REQ-001 "Agency name"')}`);
  }
  console.log(`  ${C.d('wrote')} ${out}`);
  console.log('');

  if (argv.includes('--open')) {
    // macOS `open`; a failure here is not a failure of the build. The path is
    // already printed, so a headless box just gets the path.
    execFile('open', [out], (err) => {
      if (err) console.log(C.d(`  (open it yourself: ${out})`));
    });
  }
  return out;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, normalise };
