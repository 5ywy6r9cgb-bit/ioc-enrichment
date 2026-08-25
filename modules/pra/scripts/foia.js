#!/usr/bin/env node
'use strict';
/**
 * scripts/foia.js — the records desk, in the terminal.
 *
 *   sentinel pra foia                     what needs you, most urgent first
 *   sentinel pra foia --all               every request, including quiet ones
 *   sentinel pra foia draft REQ-ID        print the drafted follow-up
 *   sentinel pra foia show REQ-ID         one request in full, with its clock
 *   sentinel pra foia --json              machine-readable, for the watcher
 *   sentinel pra foia --file requests.json   run against a JSON file, no DB
 *
 * The --file mode exists so this is testable and usable before the database is
 * up, and so the foia_requests.json this replaces can be read directly rather
 * than migrated first.
 */

const fs = require('fs');
const path = require('path');
const T = require('../server/foia_tracker.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

const RUNG_COLOR = {
  denied_needs_review: C.r,
  partial_needs_completion: C.y,
  fee_quote_pending: C.y,
  no_response_escalate: C.r,
  no_response_followup: C.y,
  awaiting_agency: C.dim,
  no_action: C.dim,
};

function wrap(text, width, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > width) { out.push(pad + line.trim()); line = word; }
      else line += ' ' + word;
    }
    if (line.trim()) out.push(pad + line.trim());
  }
  return out.join('\n');
}

/** Normalise whatever shape the source gives us into what the tracker wants. */
function normalise(r) {
  return Object.assign({}, r, {
    request_id: r.request_id || r.id,
    agency_name: r.agency_name || r.agency,
    submitted_on: r.submitted_on || r.filed_date || r.filed_on,
    // The superseded JSON used status values this ladder reads differently.
    status: (r.status || 'submitted').toLowerCase(),
  });
}

async function loadFromFile(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.requests || []);
  return list.map(normalise);
}

async function loadFromDb() {
  const { Db } = require('../server/db.js');
  const { MetadataRepository } = require('../server/metadata_repository.js');
  const db = new Db();
  if (!(await db.isAvailable())) {
    throw new Error(`database unreachable: ${db.lastError()}`);
  }
  const repo = new MetadataRepository(db);
  const rows = await repo.listRequests({});
  await db.close();
  return rows.map(normalise);
}

function printItem(e, verbose) {
  const colour = RUNG_COLOR[e.rung] || C.dim;
  console.log(`  ${colour(e.label.padEnd(38))} ${C.b(e.request_id)}`);
  console.log(`    ${C.dim(e.agency || '(no agency)')}`
    + (e.business_days_elapsed != null ? C.dim(`  ·  ${e.business_days_elapsed} business days`) : ''));
  console.log(wrap(e.reason, 74, 4));

  if (e.operator_decision) {
    console.log(C.c(wrap(`YOUR CALL: ${e.operator_decision}`, 74, 4)));
  }

  // Damages are printed ONLY when live. Printing "$0 accrued" every run trains
  // the eye to skip the line, which is how a real accrual gets missed.
  if (e.damages && e.damages.accruing) {
    console.log(C.r(`    damages accruing: $${e.damages.accrued_usd} `
      + `(${e.damages.business_days_since_mandamus} business days since mandamus)`));
  }

  if (verbose) {
    console.log(C.dim(`    basis: ${e.deadline_basis}`));
    if (e.last_outreach_on) {
      console.log(C.dim(`    last outreach: ${e.last_outreach_on}`
        + ` (${e.business_days_since_outreach} business days ago)`));
    }
    if (e.damages && !e.damages.accruing) {
      console.log(wrap(C.dim(`damages: ${e.damages.basis}`), 74, 4));
    }
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const valOf = (n) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    if (hit) return hit.slice(n.length + 3);
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : null;
  };

  const positional = argv.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] || 'list';
  const file = valOf('file');

  let requests;
  try {
    requests = file ? await loadFromFile(file) : await loadFromDb();
  } catch (e) {
    console.error(`\n  ${C.r(e.message)}`);
    console.error(C.dim('  Start Postgres, or run against a file: --file foia_requests.json\n'));
    process.exit(2);
  }

  const opts = {};
  const asOf = valOf('as-of');
  if (asOf) opts.today = new Date(asOf);

  // ---- draft --------------------------------------------------------
  if (cmd === 'draft' || cmd === 'show') {
    const id = positional[1];
    if (!id) { console.error('\n  usage: foia ' + cmd + ' <REQUEST-ID>\n'); process.exit(2); }
    const r = requests.find((x) => x.request_id === id);
    if (!r) { console.error(`\n  ${C.r(`no request with id ${id}`)}\n`); process.exit(2); }
    const e = T.evaluate(r, opts);

    if (cmd === 'show') {
      console.log('');
      printItem(e, true);
      return;
    }

    const letter = T.draftFollowup(e, r, {
      name: process.env.PRA_OPERATOR_NAME || r.requester || 'Requester',
    });
    if (!letter) {
      console.log(`\n  ${C.y('No letter drafted for this rung.')}`);
      console.log(wrap(e.operator_decision || e.reason, 74, 2));
      console.log(C.dim('\n  Nothing here is sent automatically, and this rung needs you first.\n'));
      return;
    }
    console.log('\n' + C.dim('  ── drafted, NOT sent ' + '─'.repeat(52)) + '\n');
    console.log(letter);
    console.log(C.dim('  ' + '─'.repeat(72)));
    console.log(C.dim('  Read it before it goes anywhere. Nothing was sent.\n'));
    return;
  }

  // ---- list ---------------------------------------------------------
  const report = T.triage(requests, opts);

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const today = (opts.today || new Date()).toISOString().slice(0, 10);
  console.log('');
  console.log(`  ${C.b('SENTINEL — RECORDS DESK')}   ${C.dim(today)}`);
  console.log(C.dim('  ' + '─'.repeat(72)));

  const items = flag('all') ? report.all : report.items;
  if (!items.length) {
    console.log(`  ${C.g('Nothing needs you right now.')}`);
    console.log(C.dim(`  ${report.total} request(s) tracked. --all to see them.\n`));
    return;
  }

  console.log(`  ${C.b('NEEDS YOU')}  ${C.dim(`(${report.needs_attention} of ${report.total})`)}\n`);
  for (const e of items) printItem(e, flag('verbose') || flag('all'));

  console.log(C.dim('  ' + '─'.repeat(72)));
  console.log(wrap(C.dim(report.clock_note), 74, 2));
  console.log(C.dim('\n  Draft one:  sentinel pra foia draft <REQUEST-ID>'));
  console.log(C.dim('  Nothing in this report has been sent.\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
