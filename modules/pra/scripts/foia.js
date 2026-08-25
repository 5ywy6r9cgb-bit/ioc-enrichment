#!/usr/bin/env node
'use strict';
/**
 * scripts/foia.js — the records desk, in the terminal.
 *
 * READ
 *   sentinel pra foia                     what needs you, most urgent first
 *   sentinel pra foia --all               every request, including quiet ones
 *   sentinel pra foia show REQ-ID         one request in full, with its clock
 *   sentinel pra foia draft REQ-ID        print the drafted follow-up
 *   sentinel pra foia history REQ-ID      every logged letter and field change
 *   sentinel pra foia --json              machine-readable, for the watcher
 *
 * WRITE
 *   sentinel pra foia add REQ-ID "Agency Name" [--on DATE] [--via METHOD]
 *   sentinel pra foia set REQ-ID FIELD VALUE
 *   sentinel pra foia sent REQ-ID [--on DATE] [--via CHANNEL] [--note TEXT]
 *   sentinel pra foia heard REQ-ID [--on DATE] [--via CHANNEL] [--note TEXT]
 *   sentinel pra foia mandamus REQ-ID DATE
 *
 * SOURCE
 *   default                               the local store (see foia_store.js)
 *   --db                                  read from Postgres instead
 *   --file requests.json                  read one JSON file, change nothing
 *
 * The write commands exist because a tracker you have to hand-edit JSON to
 * feed is a tracker that goes stale, and a stale clock is worse than no clock:
 * it reports "nothing needs you" and is believed. `sent` in particular is not
 * bookkeeping — logging an outbound letter is how you stop this proposing the
 * same letter again tomorrow.
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

function store() {
  const { FoiaStore } = require('../server/foia_store.js');
  return new FoiaStore(process.env.PRA_FOIA_STORE || null);
}

async function loadFromStore() {
  return store().list().map(normalise);
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

const WRITE_COMMANDS = new Set(['add', 'set', 'sent', 'heard', 'mandamus']);

/** Terminal writes. Each one prints what it changed — a silent write is how
 *  you end up unsure whether the thing you typed actually landed. */
async function write(cmd, args, valOf, flag) {
  const S = store();
  const id = args[0];
  if (!id) throw new Error(`usage: foia ${cmd} <REQUEST-ID> ...`);

  if (cmd === 'add') {
    const agency = args[1];
    if (!agency) {
      throw new Error('usage: foia add <REQUEST-ID> "<Agency Name>" '
        + '[--on YYYY-MM-DD] [--via certified_mail|electronic|hand_delivery|...] '
        + '[--about "what you asked for"] [--scope OH|US]');
    }
    const rec = S.add({
      request_id: id,
      agency_name: agency,
      submitted_on: valOf('on') || new Date().toISOString().slice(0, 10),
      delivery_method: valOf('via') || null,
      description: valOf('about') || null,
      jurisdiction_scope: valOf('scope') || 'OH',
      requester: valOf('as') || process.env.PRA_OPERATOR_NAME || null,
      account_track: valOf('track') || null,
    });
    console.log(`\n  ${C.g('recorded')}  ${C.b(rec.request_id)}  ${C.dim(rec.agency_name)}`);
    console.log(C.dim(`  submitted ${rec.submitted_on}  ·  ${rec.jurisdiction_scope}`
      + `  ·  ${rec.delivery_method || 'delivery method not recorded'}`));
    if (!rec.delivery_method) {
      console.log(wrap(C.y('No delivery method on file. Under R.C. 149.43(C)(2) only '
        + 'hand delivery, electronic submission, or certified mail can ever support '
        + 'statutory damages — and you cannot reconstruct that fact later. '
        + `Set it now: sentinel pra foia set ${rec.request_id} delivery_method certified_mail`), 74, 2));
    }
    console.log(C.dim(`\n  ${S.file}\n`));
    return;
  }

  if (cmd === 'set') {
    const field = args[1];
    let value = args.slice(2).join(' ');
    if (!field || value === '') throw new Error('usage: foia set <REQUEST-ID> <field> <value>');
    if (value === 'null') value = null;
    const { change } = S.set(id, field, value);
    if (!change) {
      console.log(`\n  ${C.dim(`${id}.${field} was already ${JSON.stringify(value)} — nothing changed.`)}\n`);
      return;
    }
    console.log(`\n  ${C.g('updated')}  ${C.b(id)}`);
    console.log(`  ${field}: ${C.dim(JSON.stringify(change.from))} → ${C.b(JSON.stringify(change.to))}`);
    if (field === 'status' && value === 'denied') {
      console.log(wrap(C.y('A denial is now the top rung for this request. Record the '
        + 'exemption they cited — a denial with no stated legal authority is itself a '
        + `149.43(B)(3) problem: sentinel pra foia set ${id} denial_basis "R.C. 149.43(A)(1)(x)"`), 74, 2));
    }
    console.log('');
    return;
  }

  if (cmd === 'sent' || cmd === 'heard') {
    const row = S.logCorrespondence(id, {
      direction: cmd === 'sent' ? 'outbound' : 'inbound',
      occurred_at: valOf('on') || null,
      channel: valOf('via') || null,
      note: valOf('note') || args.slice(1).join(' ') || null,
    });
    console.log(`\n  ${C.g('logged')}  ${C.b(id)}  ${row.direction}  ${C.dim(row.occurred_at)}`);
    if (row.note) console.log(wrap(C.dim(row.note), 74, 2));
    if (row.direction === 'outbound') {
      console.log(C.dim('  This suppresses another follow-up on this request for the '
        + 'next few business days.'));
    }
    console.log('');
    return;
  }

  if (cmd === 'mandamus') {
    const when = args[1];
    if (!when) throw new Error('usage: foia mandamus <REQUEST-ID> <YYYY-MM-DD>');
    const { change } = S.set(id, 'mandamus_filed_on', when);
    const rec = S.find(id);
    console.log(`\n  ${C.g('recorded')}  mandamus filed ${C.b(when)} for ${C.b(id)}`);
    if (!change) console.log(C.dim('  (already on file)'));
    const d = T.damagesPosture(normalise(rec), new Date());
    if (d.accruing) {
      console.log(C.r(`  damages now accruing: $${d.accrued_usd} `
        + `(${d.business_days_since_mandamus} business days)`));
    } else {
      console.log(wrap(C.y(d.basis), 74, 2));
    }
    console.log(C.dim('\n  This records a fact. It is not legal advice and not a '
      + 'prediction of an award — R.C. 149.43(C)(2)(c) lets a court reduce or '
      + 'deny statutory damages entirely.\n'));
    return;
  }
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

  // ---- write commands ------------------------------------------------
  // These run against the local store only. --file is a read-only view of
  // someone else's JSON and --db has its own write path; neither should be
  // mutated by a convenience command typed at 11pm.
  if (WRITE_COMMANDS.has(cmd)) {
    if (file || flag('db')) {
      console.error(`\n  ${C.r(`'${cmd}' writes to the local store and cannot be used with `
        + `${file ? '--file' : '--db'}.`)}\n`);
      process.exit(2);
    }
    try {
      await write(cmd, positional.slice(1), valOf, flag);
    } catch (e) {
      console.error(`\n  ${C.r(e.message)}\n`);
      process.exit(2);
    }
    return;
  }

  let requests;
  try {
    if (file) requests = await loadFromFile(file);
    else if (flag('db')) requests = await loadFromDb();
    else requests = await loadFromStore();
  } catch (e) {
    console.error(`\n  ${C.r(e.message)}`);
    console.error(C.dim('  Read a file instead: --file foia_requests.json\n'));
    process.exit(2);
  }

  const opts = {};
  const asOf = valOf('as-of');
  if (asOf) opts.today = new Date(asOf);

  // ---- history ------------------------------------------------------
  if (cmd === 'history') {
    const id = positional[1];
    if (!id) { console.error('\n  usage: foia history <REQUEST-ID>\n'); process.exit(2); }
    const r = requests.find((x) => x.request_id === id);
    if (!r) { console.error(`\n  ${C.r(`no request with id ${id}`)}\n`); process.exit(2); }

    console.log(`\n  ${C.b(id)}  ${C.dim(r.agency_name || '')}\n`);

    const rows = [];
    if (r.submitted_on) rows.push([r.submitted_on, C.g('submitted'), r.delivery_method || 'method not recorded']);
    for (const c of (r.correspondence || [])) {
      rows.push([c.occurred_at,
        c.direction === 'outbound' ? C.c('sent') : C.y('heard back'),
        [c.channel, c.note].filter(Boolean).join(' — ') || '']);
    }
    for (const h of (r.history || [])) {
      rows.push([String(h.at).slice(0, 10), C.dim('changed'),
        `${h.field}: ${JSON.stringify(h.from)} → ${JSON.stringify(h.to)}`]);
    }
    if (!rows.length) {
      console.log(C.dim('  Nothing logged yet.\n'));
      return;
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [when, what, detail] of rows) {
      console.log(`  ${C.dim(when)}  ${what.padEnd(20)} ${detail}`);
    }
    console.log(C.dim('\n  Correspondence is append-only. A wrong entry is corrected '
      + 'by logging a correction, not by editing this away.\n'));
    return;
  }

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
  console.log(C.dim('  Once you send it:  sentinel pra foia sent <REQUEST-ID> --via email'));
  console.log(C.dim('  Nothing in this report has been sent.\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
