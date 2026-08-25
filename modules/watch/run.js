#!/usr/bin/env node
'use strict';
/**
 * modules/watch/run.js — the standing watch.
 *
 *   sentinel watch run                 run every watch that is due
 *   sentinel watch run --all           ignore cadence, run everything
 *   sentinel watch run --dry-run       announce, make no call, write nothing
 *   sentinel watch run --id WATCH-01   run one watch
 *   sentinel watch status              what is configured and when it last ran
 *
 * WHAT MAKES THIS USEFUL RATHER THAN NOISE
 *
 * A watchlist that re-reports the same twelve hits every morning gets muted in
 * a week, and a muted watchlist is worse than none — it produces the feeling of
 * coverage without the fact of it. So this runner keeps a seen-set per watch
 * and reports only what it has never seen before. A quiet run is the normal
 * outcome and prints one line.
 *
 * WHAT IT FILES
 *
 * Every run files into the investigation's folder, so the filing cabinet builds
 * itself as you work:
 *
 *   evidence/investigations/<investigation>/<YYYY>/<MM>/
 *     <watch-id>_<stamp>.json      the verbatim capture
 *     NEW_HITS.md                  appended, human-readable, newest first
 *
 * The path is relative and the capture is hashed into the provenance ledger, so
 * `sentinel prov verify` covers it and `sentinel prov ingest` can flow it into
 * the citation ledger like anything else.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not decide anything. A new hit is a lead: it means a source that had
 * nothing yesterday has something today, and you should go look. It is not a
 * finding, and nothing here can promote it to one.
 */

const fs = require('fs');
const path = require('path');
const R = require('../connectors/registry.js');
const notify = require('./notify.js');
const recordsDesk = require('./records_desk.js');

const ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const WATCH_DIR = path.join(EVIDENCE, 'watch');
const STATE_PATH = path.join(WATCH_DIR, 'state.json');
const CONFIG_PATH = process.env.SENTINEL_WATCHLIST || path.join(ROOT, 'watchlist.json');
const EXAMPLE_PATH = path.join(__dirname, 'watchlist.example.json');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const CADENCE_HOURS = { hourly: 1, daily: 24, weekly: 168, monthly: 720, manual: Infinity };

// ---------------------------------------------------------------- config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(C.y(`\n  No watchlist at ${path.relative(ROOT, CONFIG_PATH)}`));
    console.error(`  Start from the example:\n`);
    console.error(`    cp ${path.relative(ROOT, EXAMPLE_PATH)} ${path.relative(ROOT, CONFIG_PATH)}\n`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(C.r(`\n  watchlist.json is not valid JSON: ${e.message}\n`));
    process.exit(2);
  }
  if (!Array.isArray(cfg.watches)) {
    console.error(C.r('\n  watchlist.json needs a "watches" array.\n'));
    process.exit(2);
  }
  // Validate up front so a typo fails loudly instead of silently skipping.
  const seen = new Set();
  for (const w of cfg.watches) {
    if (!w.id) { console.error(C.r('\n  every watch needs an "id".\n')); process.exit(2); }
    if (seen.has(w.id)) { console.error(C.r(`\n  duplicate watch id: ${w.id}\n`)); process.exit(2); }
    seen.add(w.id);
    if (!R.CONNECTORS[w.connector]) {
      console.error(C.r(`\n  watch ${w.id}: unknown connector "${w.connector}"`));
      console.error(`  known: ${Object.keys(R.CONNECTORS).join(', ')}\n`);
      process.exit(2);
    }
    if (!w.query) { console.error(C.r(`\n  watch ${w.id}: needs a "query".\n`)); process.exit(2); }
    if (w.cadence && !(w.cadence in CADENCE_HOURS)) {
      console.error(C.r(`\n  watch ${w.id}: unknown cadence "${w.cadence}"`));
      console.error(`  known: ${Object.keys(CADENCE_HOURS).join(', ')}\n`);
      process.exit(2);
    }
  }
  return cfg;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { watches: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { watches: {} }; }
}

function saveState(state) {
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function isDue(watch, st, force) {
  if (force) return true;
  const hours = CADENCE_HOURS[watch.cadence || 'weekly'];
  if (hours === Infinity) return false;              // manual: only with --id or --all
  if (!st || !st.last_run_at) return true;           // never run
  const elapsed = (Date.now() - Date.parse(st.last_run_at)) / 36e5;
  return elapsed >= hours;
}

// ---------------------------------------------------------------- filing
function investigationDir(watch, when) {
  const inv = (watch.investigation || 'unfiled').replace(/[^A-Za-z0-9_-]+/g, '-');
  const yyyy = String(when.getUTCFullYear());
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  return path.join(EVIDENCE, 'investigations', inv, yyyy, mm);
}

function appendNewHits(dir, watch, newHits, captureRel, captureHash, when) {
  const md = path.join(dir, 'NEW_HITS.md');
  const header = fs.existsSync(md) ? '' :
    `# New hits — ${watch.investigation || 'unfiled'}\n\n` +
    `Appended by \`sentinel watch\`. Newest entries are at the bottom.\n\n` +
    `Everything here is a **lead**: a source that had nothing before has\n` +
    `something now. Confirm same-entity and pull the underlying document\n` +
    `before any of it is used.\n\n---\n`;

  const lines = [`\n## ${when.toISOString()} — ${watch.label || watch.id}\n`];
  lines.push(`- watch: \`${watch.id}\`  ·  connector: \`${watch.connector}\`  ·  query: \`${watch.query}\``);
  lines.push(`- capture: \`${captureRel}\``);
  lines.push(`- sha256: \`${captureHash}\``);
  lines.push(`- new: **${newHits.length}**\n`);
  for (const h of newHits) {
    lines.push(`### ${h.name || '(unnamed)'}`);
    for (const [k, v] of Object.entries(h)) {
      if (k === 'name' || v === '' || v == null) continue;
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      if (val) lines.push(`- ${k}: ${val}`);
    }
    lines.push('');
  }
  fs.appendFileSync(md, header + lines.join('\n'), 'utf8');
  return md;
}

// ---------------------------------------------------------------- run one
async function runWatch(watch, state, opts) {
  const c = R.CONNECTORS[watch.connector];
  const st = state.watches[watch.id] || { seen: [], last_run_at: null, runs: 0 };
  const when = new Date();

  console.log(`\n  ${C.b(watch.label || watch.id)}  ${C.dim(`[${watch.id}]`)}`);
  console.log(`    ${c.label} · "${watch.query}" · ${watch.cadence || 'weekly'}`);

  if (opts.dryRun) {
    console.log(`    ${C.y('DRY RUN')} — would call: ${c.describe(watch.query)}`);
    return { ran: false, newHits: [] };
  }

  const dir = investigationDir(watch, when);
  fs.mkdirSync(dir, { recursive: true });

  const out = await R.runConnector(watch.connector, watch.query, {
    env: opts.env,
    captureDir: dir,
    tool: 'sentinel watch',
    extra: { watch_id: watch.id, investigation: watch.investigation || null },
  });

  if (!out.ok) {
    console.log(`    ${C.r('failed')}: ${out.error} ${C.dim('— nothing written')}`);
    // A failed run does NOT advance last_run_at: it should be retried, not
    // silently treated as a completed check.
    return { ran: false, failed: true, error: out.error, newHits: [] };
  }

  const seen = new Set(st.seen || []);
  const newHits = out.results.filter((r) => {
    const id = c.identify(r);
    return id && !seen.has(id);
  });
  for (const r of out.results) {
    const id = c.identify(r);
    if (id) seen.add(id);
  }

  const captureRel = path.relative(EVIDENCE, out.capturePath);
  let mdPath = null;
  if (newHits.length) {
    mdPath = appendNewHits(dir, watch, newHits, captureRel, out.captureHash, when);
  }

  state.watches[watch.id] = {
    seen: Array.from(seen),
    last_run_at: when.toISOString(),
    last_result_count: out.results.length,
    last_new_count: newHits.length,
    runs: (st.runs || 0) + 1,
  };

  if (newHits.length) {
    console.log(`    ${C.g(`${newHits.length} NEW`)} of ${out.results.length} result(s)`);
    console.log(`    filed → evidence/${path.relative(EVIDENCE, mdPath)}`);
  } else {
    console.log(`    ${C.dim(`no change (${out.results.length} result(s), all seen before)`)}`);
  }

  return { ran: true, newHits, watch, capturePath: out.capturePath, mdPath };
}

// ---------------------------------------------------------------- commands
async function cmdRun(opts) {
  const cfg = loadConfig();
  const state = loadState();
  const env = R.loadEnv();

  let watches = cfg.watches;
  if (opts.id) watches = watches.filter((w) => w.id === opts.id);
  if (opts.id && !watches.length) {
    console.error(C.r(`\n  no watch with id ${opts.id}\n`));
    process.exit(2);
  }
  const due = watches.filter((w) => opts.id || isDue(w, state.watches[w.id], opts.all));

  console.log('\n' + C.b('Sentinel watch'));
  console.log(C.dim(`  watchlist: ${path.relative(ROOT, CONFIG_PATH)}`));
  console.log(C.dim(`  ${watches.length} configured · ${due.length} due${opts.dryRun ? ' · DRY RUN' : ''}`));

  // The records desk runs FIRST and runs unconditionally. It is the one stage
  // that cannot fail for a network reason, and an overdue clock is the thing
  // most likely to actually cost you something today.
  const desk = opts.dryRun ? null : runRecordsDesk(opts);

  if (!due.length) {
    console.log(C.dim('\n  No watches due. Use --all to force every watch.\n'));
    if (desk) await notifyDesk(desk, cfg);
    return;
  }

  const results = [];
  for (const w of due) {
    results.push(await runWatch(w, state, { ...opts, env }));
  }

  if (!opts.dryRun) saveState(state);

  // ---- summary --------------------------------------------------------
  const withNew = results.filter((r) => r.newHits && r.newHits.length);
  const failed = results.filter((r) => r.failed);
  const totalNew = withNew.reduce((n, r) => n + r.newHits.length, 0);

  console.log('\n  ' + C.b('Summary'));
  console.log(`    ran        ${results.filter((r) => r.ran).length}`);
  console.log(`    new hits   ${totalNew}${totalNew ? ` across ${withNew.length} watch(es)` : ''}`);
  if (failed.length) console.log(`    ${C.r(`failed     ${failed.length}`)} ${C.dim('(will retry next run)')}`);

  if (opts.dryRun) { console.log(C.dim('\n  Dry run — nothing written, nothing sent.\n')); return; }

  // ---- notify ---------------------------------------------------------
  // Counts, watch labels, and request IDs only. See notify.js for why.
  const deskLine = desk ? recordsDesk.notifyLine(desk) : null;
  if (totalNew || failed.length || deskLine) {
    const bits = [];
    if (totalNew) bits.push(`${totalNew} new on ${withNew.map((r) => r.watch.id).join(', ')}`);
    if (failed.length) bits.push(`${failed.length} failed`);
    if (deskLine) bits.push(deskLine);
    const res = await notify.send({
      title: 'Sentinel watch',
      body: bits.join(' · '),
      config: cfg.notify || { backend: 'none' },
    });
    if (res.ok && res.via !== 'none') console.log(`    notified   via ${res.via}`);
    else if (!res.ok) console.log(`    ${C.y(`notify skipped: ${res.reason}`)}`);
  }

  if (totalNew) {
    console.log('\n  ' + C.y('New leads are filed, not confirmed.'));
    console.log(C.dim('  Open the NEW_HITS.md above, confirm same-entity, and pull the'));
    console.log(C.dim('  underlying document before any of it is used.'));
  }
  console.log('');
}

/**
 * Run the records desk stage and print it. Returns the result so the caller can
 * fold it into one notification rather than sending two.
 */
function runRecordsDesk(opts) {
  const result = recordsDesk.run(opts);
  const brief = recordsDesk.writeBrief(result, opts);

  console.log('\n  ' + C.b('Records desk'));
  if (!result.ok) {
    // Loud, because the alternative is reading silence as "nothing is overdue."
    console.log(`    ${C.r('FAILED')} ${result.reason}`);
    console.log(C.dim('    No clocks were checked. Do not read this run as quiet.'));
  } else if (!result.total) {
    console.log(C.dim('    no requests tracked yet'));
  } else if (!result.needs_attention) {
    console.log(`    ${C.g('nothing needs you')} ${C.dim(`(${result.total} tracked)`)}`);
  } else {
    console.log(`    ${C.y(`${result.needs_attention} of ${result.total} need you`)}`);
    for (const e of result.items.slice(0, 5)) {
      console.log(`      ${C.dim(e.request_id.padEnd(34))} ${e.label}`);
    }
    if (result.judgment) {
      console.log(C.dim(`    ${result.judgment} need a decision, not just a letter.`));
    }
  }
  console.log(C.dim(`    brief: ${path.relative(ROOT, brief)}`));
  return result;
}

/** Notify for a desk-only run — when no watches were due but a clock moved. */
async function notifyDesk(desk, cfg) {
  const line = recordsDesk.notifyLine(desk);
  if (!line) return;
  const res = await notify.send({
    title: 'Sentinel watch',
    body: line,
    config: cfg.notify || { backend: 'none' },
  });
  if (res.ok && res.via !== 'none') console.log(C.dim(`    notified via ${res.via}`));
}

function cmdStatus() {
  const cfg = loadConfig();
  const state = loadState();
  console.log('\n' + C.b('Watchlist status'));
  console.log(C.dim(`  ${path.relative(ROOT, CONFIG_PATH)} · notify backend: ${(cfg.notify && cfg.notify.backend) || 'none'}\n`));
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + C.dim(pad('ID', 22) + pad('CONNECTOR', 17) + pad('CADENCE', 10) + pad('LAST RUN', 22) + 'LAST NEW'));
  for (const w of cfg.watches) {
    const st = state.watches[w.id] || {};
    const due = isDue(w, st, false);
    console.log('  ' + pad(w.id, 22) + pad(w.connector, 17) + pad(w.cadence || 'weekly', 10)
      + pad(st.last_run_at ? st.last_run_at.slice(0, 19).replace('T', ' ') : 'never', 22)
      + (st.last_new_count == null ? '—' : String(st.last_new_count))
      + (due ? '  ' + C.g('DUE') : ''));
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const action = (argv.find((a) => !a.startsWith('--')) || 'run');
  const idFlag = argv.find((a) => a.startsWith('--id='));
  const opts = {
    dryRun: argv.includes('--dry-run'),
    all: argv.includes('--all'),
    id: idFlag ? idFlag.slice(5) : null,
  };
  if (action === 'status') return cmdStatus();
  if (action === 'run') return cmdRun(opts);
  console.error('usage: run.js [run|status] [--all] [--dry-run] [--id=WATCH-ID]');
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
