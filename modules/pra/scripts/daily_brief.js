#!/usr/bin/env node
'use strict';
/**
 * scripts/daily_brief.js — the morning read.
 *
 *   sentinel pra brief
 *
 * One screen: what went quiet, what is due, and which letter is already
 * drafted for it. This is the thing you actually run every day, so it is
 * written to be scanned in ten seconds and to be honest about the difference
 * between your cadence and the law.
 */

const { Db } = require('../server/db.js');
const { MetadataRepository } = require('../server/metadata_repository.js');
const schemaVersion = require('../server/schema_version.js');
const clock = require('../server/deadline_engine.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  u: (s) => `\x1b[4m${s}\x1b[0m`,
};

const ACTION_COLOR = { appeal: C.r, escalate: C.r, followup: C.y, review: C.g };

function rule(width = 66) { return C.dim('─'.repeat(width)); }

async function main() {
  const db = new Db();
  if (!(await db.isAvailable())) {
    console.error(`\n  ${C.r('database unreachable')}: ${db.lastError()}`);
    console.error('  Start Postgres, then run this again.\n');
    process.exit(2);
  }

  const sv = await schemaVersion.check(db);
  if (!sv.ok) {
    console.error(`\n  ${C.r('schema problem')}: ${sv.message}\n`);
    process.exit(2);
  }

  const repo = new MetadataRepository(db);
  const [counts, requests, rules] = await Promise.all([
    repo.dashboardCounts(), repo.listRequests({}), repo.listDeadlineRules(),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  console.log('');
  console.log(`  ${C.b('SENTINEL — DAILY BRIEF')}   ${C.dim(today)}`);
  console.log(`  ${rule()}`);

  // ---- the clock -------------------------------------------------------
  const triaged = clock.triage(requests, rules);
  if (!triaged.length) {
    console.log(`  ${C.g('Nothing is past your follow-up cadence.')}`);
  } else {
    console.log(`  ${C.b('NEEDS YOU')}  ${C.dim(`(${triaged.length} request(s))`)}\n`);
    for (const t of triaged) {
      const colour = ACTION_COLOR[t.top.action] || C.y;
      console.log(`    ${colour(t.top.action.toUpperCase().padEnd(9))} ${C.b(t.request_id)}  ${t.subject || ''}`);
      console.log(`      ${t.top.days_elapsed} days since ${t.top.anchored_on}  ${C.dim(`(threshold ${t.top.days_threshold})`)}`);
      console.log(`      ${C.dim(t.top.label)}`);
      // The line that keeps the letters honest.
      console.log(`      ${C.dim('basis:')} ${t.top.basis === 'statutory' ? C.r(t.top.basis_label) : C.dim(t.top.basis_label)}`);
      if (t.top.template_id) {
        console.log(`      ${C.dim('draft ready:')} sentinel pra draft ${t.request_id} ${t.top.template_id}`);
      }
      if (t.breach_count > 1) console.log(`      ${C.dim(`+${t.breach_count - 1} more rule(s) tripped`)}`);
      console.log('');
    }
  }

  // ---- standing state --------------------------------------------------
  console.log(`  ${rule()}`);
  console.log(`  ${C.b('STANDING')}`);
  console.log(`    open requests      ${counts.open_requests}`);
  console.log(`    received records   ${counts.received_records}`);
  console.log(`    sources            ${counts.sources}  ${counts.unverified_sources ? C.y(`(${counts.unverified_sources} unverified)`) : ''}`);
  console.log(`    directory          ${counts.agencies} agencies · ${counts.portals} portals · ${counts.jurisdictions} jurisdictions`);
  if (counts.unverified_portals) {
    console.log(`    ${C.y(`${counts.unverified_portals} portal(s) still unverified`)} ${C.dim('— sentinel pra portals')}`);
  }

  // ---- the honest footer ----------------------------------------------
  console.log(`  ${rule()}`);
  console.log(`  ${C.dim('Ohio R.C. 149.43 sets no fixed day count. Every Ohio number above is')}`);
  console.log(`  ${C.dim('YOUR cadence, not a legal deadline. Do not claim otherwise in a letter.')}`);
  console.log('');

  await db.close();
}

main().catch((e) => { console.error(`\n  brief failed: ${e.message}\n`); process.exit(1); });
