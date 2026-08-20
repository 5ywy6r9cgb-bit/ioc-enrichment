#!/usr/bin/env node
'use strict';
/**
 * tests/run_all.js — every suite, no database required.
 *
 * That constraint is deliberate. A suite that needs a running Postgres is a
 * suite that gets skipped on the machine where it matters most. Everything
 * here runs on a clean checkout with `npm install` and nothing else.
 */

const H = require('./_harness.js');

const SUITES = [
  ['db_policy',                 require('./db_policy.test.js')],
  ['schema_metadata_only',      require('./schema_metadata_only.test.js')],
  ['seed_integrity',            require('./seed_integrity.test.js')],
  ['load_seeds',                require('./load_seeds.test.js')],
  ['deadline_engine',           require('./deadline_engine.test.js')],
  ['request_drafter',           require('./request_drafter.test.js')],
  ['repo_atomicity',            require('./repo_atomicity.test.js')],
  ['audit_export_ledger',       require('./audit_export_ledger.test.js')],
  ['upload_review_history',     require('./upload_review_history.test.js')],
  ['json_export_metadata_only', require('./json_export_metadata_only.test.js')],
  ['json_import_tamper_strip',  require('./json_import_tamper_strip.test.js')],
  ['fallback_behavior',         require('./fallback_behavior.test.js')],
  ['intel_repo',                require('./intel_repo.test.js')],
  ['olac_lobbying',             require('./olac_lobbying.test.js')],
  ['push_notify',                require('./push_notify.test.js')],
];

(async () => {
  console.log(`\n  Sentinel PRA — ${SUITES.length} suites`);
  for (const [name, fn] of SUITES) {
    try {
      await fn();
    } catch (e) {
      H.suite(name);
      H.check(`suite ${name} ran without crashing`, false, e.stack ? e.stack.split('\n')[0] : e.message);
    }
  }
  process.exit(H.report());
})();
