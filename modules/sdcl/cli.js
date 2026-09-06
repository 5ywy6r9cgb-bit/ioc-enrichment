#!/usr/bin/env node
/**
 * cli.js — `sentinel ask`, the front door to the Sentinel Desk Command Language.
 *
 *   sentinel ask "FOLLOWMONEY Early Warning Services"
 *   sentinel ask "FOLLOWLAND New Albany"        -- and be told nothing reads deeds
 *   sentinel ask verbs                          -- the whole vocabulary
 *   sentinel ask coverage                       -- what this desk can and cannot see
 *   sentinel ask "RATEPAYER" --run              -- route AND execute
 *
 * It prints a ROUTE, not an answer. The distinction is the entire design: a
 * language that answered would be a language that guessed, and forty verbs
 * that each guess confidently is a machine for producing corrections.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./sdcl.js');

const ROOT = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(ROOT, 'bin', 'sentinel');

const FAMILY_NAME = {
  CORE: 'THE CORE LOOP',
  MONEY: 'FOLLOW THE MONEY',
  LAND: 'FOLLOW THE LAND',
  POWER: 'FOLLOW THE POWER',
  RECORDS: 'FOLLOW THE RECORDS',
  LAW: 'FOLLOW THE LAW',
};
const FAMILY_ORDER = ['CORE', 'MONEY', 'LAND', 'POWER', 'RECORDS', 'LAW'];

const CSI = String.fromCharCode(27) + '[';
const bold = (s) => `${CSI}1m${s}${CSI}0m`;
const dim = (s) => `${CSI}2m${s}${CSI}0m`;
const log = (s = '') => console.log(s);

/** Wrap prose to a column, indented. Long single tokens are left alone. */
function wrap(text, indent = 6, width = 78) {
  const pad = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > (width - indent)) {
      lines.push(pad + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(pad + line);
  return lines.join('\n');
}

// -- the vocabulary ---------------------------------------------------
function cmdVerbs() {
  const fams = S.byFamily();
  log('');
  log(bold('  SENTINEL DESK COMMAND LANGUAGE'));
  log(dim('  Forty verbs. Each one routes to what this desk can actually run.'));
  log('');
  for (const fam of FAMILY_ORDER) {
    const names = fams[fam] || [];
    if (!names.length) continue;
    log(`  ${bold(FAMILY_NAME[fam] || fam)}`);
    for (const n of names) {
      const v = S.VERBS[n];
      log(`    ${n.padEnd(16)}${v.status.padEnd(10)}${v.asks}`);
    }
    log('');
  }
  log(dim('  BACKED   a connector or reader answers this'));
  log(dim('  PARTIAL  something runs, but it answers less than the verb promises'));
  log(dim('  UNBACKED nothing here reads that source. The route is a records request.'));
  log('');
  log('  Ask one:  sentinel ask "FOLLOWMONEY Early Warning Services"');
  log('');
}

// -- the honest map ---------------------------------------------------
function cmdCoverage() {
  const counts = { BACKED: 0, PARTIAL: 0, UNBACKED: 0 };
  const unbacked = [];
  for (const [n, v] of Object.entries(S.VERBS)) {
    counts[v.status]++;
    if (v.status !== 'BACKED') unbacked.push([n, v]);
  }
  const total = S.verbNames().length;
  log('');
  log(bold('  WHAT THIS DESK CAN SEE'));
  log('');
  log(`  ${String(counts.BACKED).padStart(3)} of ${total} verbs are BACKED    a real source answers them`);
  log(`  ${String(counts.PARTIAL).padStart(3)} of ${total} verbs are PARTIAL   something runs, and it answers less`);
  log(`  ${String(counts.UNBACKED).padStart(3)} of ${total} verbs are UNBACKED nothing reads that source at all`);
  log('');
  log(bold('  THE GAPS, NAMED'));
  log('');
  for (const [n, v] of unbacked) {
    log(`    ${n.padEnd(16)}${dim(v.status)}`);
    log(wrap(v.gap || '(gap not stated)', 6));
  }
  log('');
  log(wrap('This list is the more useful half. A desk that reported only its '
    + 'strengths would let you conclude that an absence of records is an absence '
    + 'of facts, and that is the error that ends investigations wrongly.', 2));
  log('');
}

// -- one route --------------------------------------------------------
function cmdRoute(line, opts) {
  const r = S.route(line);

  if (!r.ok) {
    log('');
    log(`  Not a verb: ${r.verb || '(nothing)'}`);
    if (r.suggestions.length) {
      log('');
      log(`  Did you mean:  ${r.suggestions.join('   ')}`);
    }
    log('');
    log('  The whole vocabulary:  sentinel ask verbs');
    log('');
    process.exitCode = 2;
    return undefined;
  }

  const v = r.spec;
  log('');
  log(`  ${bold(r.verb)}  ${dim('--')}  ${v.asks}`);
  log(`  ${dim(`family ${FAMILY_NAME[v.family] || v.family}`)}   `
    + `${dim(`status ${v.status}`)}   ${dim(`ceiling ${v.ceiling}`)}`);
  if (r.target) log(`  ${dim(`target ${r.target}`)}`);
  log('');

  if (r.needsTarget) {
    log(bold('  THIS VERB NEEDS A TARGET'));
    log('');
    log(wrap('Every command it would print names one. Rather than print a '
      + 'placeholder for you to paste, it prints nothing -- a placeholder in a '
      + 'pasted command is an argument, and the tool receiving it does exactly '
      + 'what it was told with a word that describes a word.', 4));
    log('');
    log(`  Try:  sentinel ask "${r.verb} the name or file you mean"`);
    log('');
    process.exitCode = 2;
    return undefined;
  }

  if (v.status === 'UNBACKED') {
    log(bold('  NOT CONNECTED'));
    log(wrap(v.gap || 'no source', 4));
    log('');
  } else if (v.status === 'PARTIAL') {
    log(bold('  PARTIAL -- READ THIS BEFORE THE OUTPUT'));
    log(wrap(v.gap || 'incomplete', 4));
    log('');
  }

  log(bold('  RUN THESE'));
  log('');
  let i = 0;
  for (const c of r.commands) {
    i++;
    const mark = c.runnable ? ' ' : '!';
    log(`  ${mark} ${String(i).padStart(2)}  ${c.run}`);
    log(wrap(c.why, 8));
    if (!c.runnable) {
      log(dim('        ! edit this line before running it -- it contains a placeholder'));
    }
    log('');
  }

  log(bold('  THE DENOMINATOR'));
  log(wrap(v.denominator, 4));
  log('');
  log(bold('  WHAT THIS VERB CANNOT TELL YOU'));
  log(wrap(v.notThis, 4));
  log('');
  log(bold(`  CEILING: ${v.ceiling}`));
  log(wrap(ceilingNote(v.ceiling), 4));
  log('');

  if (opts.run) return execute(r);
  if (r.commands.some((c) => c.runnable)) {
    log(dim('  Add --run to execute the lines above, in order, stopping at the first failure.'));
    log('');
  }
  return undefined;
}

function ceilingNote(tier) {
  switch (tier) {
    case 'LEAD':
      return 'These commands produce a LEAD and nothing more. Nobody has verified it, '
        + 'and a lead repeated confidently is how a rumour acquires a source.';
    case 'EVIDENCE':
      return 'These commands reach EVIDENCE -- a primary document, fetched and hashed. '
        + 'What you assert it SHOWS is a CLAIM, and it is yours, not the source\'s. '
        + 'A claim becomes a FINDING only after DISPROVE has failed to kill it.';
    case 'CLAIM':
      return 'This verb reaches a CLAIM: an assertion you are making. It is not yet a '
        + 'finding. Run DISPROVE against it before it is either published or believed.';
    case 'FINDING':
      return 'This verb can reach a FINDING -- but only through the gate, which has four '
        + 'rules and no override. Every financial exhibit read to the last page, no '
        + 'broken exhibit, no open question, no unresolved contradiction.';
    default:
      return '';
  }
}

// -- --run ------------------------------------------------------------
function execute(r) {
  const runnables = r.commands.filter((c) => c.runnable);
  const held = r.commands.length - runnables.length;
  if (!runnables.length) {
    log(bold('  NOTHING TO RUN'));
    log(wrap('Every line for this verb is a template you must edit first.', 4));
    log('');
    process.exitCode = 2;
    return;
  }
  log(bold(`  RUNNING ${runnables.length} of ${r.commands.length}`)
    + (held ? dim(`   (${held} held back as templates)`) : ''));
  log('');
  let n = 0;
  for (const c of runnables) {
    n++;
    log(dim('  ' + '-'.repeat(70)));
    log(`  ${bold(`[${n}/${runnables.length}]`)} ${c.run}`);
    log('');
    // The printed line is a `sentinel ...` command; run it through the same
    // dispatcher an operator would type it into, so what executes is exactly
    // what was printed. Argument splitting honours double quotes only, which
    // is all this router ever emits.
    const args = splitArgs(c.run.replace(/^sentinel\s+/, ''));
    const res = spawnSync(DISPATCHER, args, { stdio: 'inherit' });
    if (res.error) {
      log('');
      log(`  STOPPED: could not run it -- ${res.error.message}`);
      process.exitCode = 1;
      return;
    }
    if (res.status !== 0) {
      log('');
      log(`  STOPPED at step ${n}: exit ${res.status}.`);
      log(wrap('The remaining steps were NOT run. A step that failed and a step that '
        + 'was skipped look identical in an evidence store a week later, so nothing '
        + 'after a failure runs on its own.', 4));
      process.exitCode = res.status || 1;
      return;
    }
    log('');
  }
  log(dim('  ' + '-'.repeat(70)));
  log(`  ${bold('done')} -- ${runnables.length} step(s), all exited clean.`);
  log('');
  log(wrap('Captured is not read. Nothing above has been read by anyone, and a '
    + 'capture count is not a finding.', 2));
  log('');
}

/** Split a command line on spaces, honouring double quotes. */
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// -- usage ------------------------------------------------------------
function usage() {
  log('');
  log('  usage: sentinel ask "VERB target"         route one question to real commands');
  log('         sentinel ask "VERB target" --run   ...and execute them, in order');
  log('         sentinel ask verbs                 the whole vocabulary');
  log('         sentinel ask coverage              what this desk can and cannot see');
  log('');
  log('  examples:');
  log('         sentinel ask "FOLLOWMONEY Early Warning Services"');
  log('         sentinel ask "SUBSIDY https://example.gov/acfr-2025.pdf"');
  log('         sentinel ask "RATEPAYER" --run');
  log('         sentinel ask "DISPROVE cfpb-2025"');
  log('');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { run: argv.includes('--run') };
  const positional = argv.filter((a) => !a.startsWith('--'));
  const first = (positional[0] || '').toLowerCase();

  if (!positional.length || first === 'help') return usage();
  if (first === 'verbs' || first === 'list') return cmdVerbs();
  if (first === 'coverage' || first === 'gaps') return cmdCoverage();
  return cmdRoute(positional.join(' '), opts);
}

if (require.main === module) main();

module.exports = { wrap, splitArgs, ceilingNote };
