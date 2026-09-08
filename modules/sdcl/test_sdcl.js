#!/usr/bin/env node
/**
 * test_sdcl.js — the command language must not print commands that do not exist.
 *
 * WHY THIS FILE IS THE WHOLE POINT
 *   A routing layer is the easiest thing in this repository to fake. Forty
 *   verbs, each printing a confident-looking line, and the desk appears twice
 *   as capable while answering exactly as many questions as before. Worse, the
 *   failure is silent in the only place it matters: you paste the line at 1am,
 *   the shell says "unknown command", and by then you have already told someone
 *   the desk can follow land.
 *
 *   So the central test here is not that the router is well formed. It is that
 *   EVERY command string it can emit resolves to a verb the dispatcher really
 *   answers, and, one level down, to a connector or subcommand that really
 *   exists. If someone renames `connect expand`, this suite goes red — not the
 *   operator, six weeks later, mid-investigation.
 *
 * READING SOURCE
 *   Comment lines are stripped before any source is scanned. This repository
 *   has shipped a green test six separate times that was matching a phrase
 *   inside its own explanatory comment, which reads exactly like a pass.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const S = require('./sdcl.js');

const ROOT = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(ROOT, 'bin', 'sentinel');
const CLI = path.join(__dirname, 'cli.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

/** File contents with comment-only lines removed. */
function uncommented(file, marker) {
  const re = marker === '#' ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !re.test(l)).join('\n');
}

console.log('\n== SDCL: the command language routes to real commands ==\n');

// ── 1. the vocabulary is complete and well formed ─────────────────────
const names = S.verbNames();
ok(names.length === 40, `forty verbs are defined (got ${names.length})`);

const STATUSES = new Set(['BACKED', 'PARTIAL', 'UNBACKED']);
for (const n of names) {
  const v = S.VERBS[n];
  ok(/^[A-Z]+$/.test(n), `${n} is a single uppercase word`);
  ok(STATUSES.has(v.status), `${n} declares a real status (${v.status})`);
  ok(S.TIERS.includes(v.ceiling), `${n} declares a real ceiling (${v.ceiling})`);
  ok(typeof v.asks === 'string' && v.asks.length > 10, `${n} says what it asks`);
  ok(typeof v.denominator === 'string' && v.denominator.length > 20,
    `${n} states a denominator`);
  ok(typeof v.notThis === 'string' && v.notThis.length > 5,
    `${n} states what it cannot tell you`);
  ok(typeof v.commands === 'function', `${n} builds commands`);
  if (v.status !== 'BACKED') {
    ok(typeof v.gap === 'string' && v.gap.length > 5,
      `${n} is ${v.status} and names the gap`);
  }
}

// ── 2. EVERY EMITTED COMMAND IS A REAL COMMAND ────────────────────────
// The dispatcher's own case arms are the authority on what exists. Nested
// arms are indented deeper than two spaces, so this reads the top level only.
const dispatcher = uncommented(DISPATCHER, '#');
const topVerbs = new Set();
for (const line of dispatcher.split('\n')) {
  const m = line.match(/^ {2}([a-z|?\\-]+)\)/);
  if (!m) continue;
  for (const v of m[1].split('|')) {
    const clean = v.replace(/\\/g, '');
    if (!clean || clean.startsWith('-') || clean === '?' || clean === '*') continue;
    topVerbs.add(clean);
  }
}
ok(topVerbs.size >= 12, `read the dispatcher's top-level verbs (got ${topVerbs.size})`);

// connect: the pass-through list, plus every connector NAME (the fallback arm
// turns an unlisted word into `cli.js search NAME`, so a connector name is a
// legitimate second token and a typo in one is not).
const connectArm = dispatcher.match(/^ {6}(test\|[a-z|]+)\)/m);
ok(!!connectArm, 'read the connect pass-through list');
const connectVerbs = new Set(connectArm ? connectArm[1].split('|') : []);
const registrySrc = uncommented(path.join(ROOT, 'modules', 'connectors', 'registry.js'), '//');
const connectorNames = new Set(
  [...registrySrc.matchAll(/^\s{2}([a-z0-9]+):\s*\{/gm)].map((m) => m[1]),
);
ok(connectorNames.size >= 10, `read the connector names (got ${connectorNames.size})`);

// doc: the actions its CLI handles.
const docSrc = uncommented(path.join(ROOT, 'modules', 'docs', 'cli.js'), '//');
const docActions = new Set(
  [...docSrc.matchAll(/action === '([a-z]+)'/g)].map((m) => m[1]),
);
ok(docActions.size >= 4, `read the doc actions (got ${docActions.size})`);

// sec: same idea, one CLI over. Added the moment `sentinel sec` existed --
// a new top-level verb whose SECOND token nothing validates is exactly the
// hole this file was written to close, and it opens silently every time a
// verb is added.
const secSrc = uncommented(path.join(ROOT, 'modules', 'docs', 'sec_cli.js'), '//');
const secActions = new Set(
  [...secSrc.matchAll(/action === '([a-z]+)'/g)].map((m) => m[1]),
);
ok(secActions.size >= 1, `read the sec actions (got ${secActions.size})`);

// case: the usage block in case.py is what an operator is shown.
const caseSrc = fs.readFileSync(path.join(ROOT, 'modules', 'research-desk', 'case.py'), 'utf8');
const caseSubs = new Set(
  [...caseSrc.matchAll(/sentinel case ([a-z]+)/g)].map((m) => m[1]),
);
ok(caseSubs.size >= 6, `read the case subcommands (got ${caseSubs.size})`);

// pra: the dispatcher prints its own authoritative list.
const praLine = dispatcher.match(/pra subcommands: (.+?)"/);
const praSubs = new Set(praLine ? praLine[1].trim().split(/\s+/) : []);
ok(praSubs.size >= 5, `read the pra subcommands (got ${praSubs.size})`);

// Now check every line every verb can emit, with a target supplied so the
// target-requiring verbs actually build something.
const PROBE = 'PROBE';
let checked = 0;
for (const n of names) {
  const r = S.route(`${n} ${PROBE}`);
  ok(r.ok, `${n} routes`);
  ok(r.commands.length > 0, `${n} emits at least one line`);
  for (const c of r.commands) {
    checked++;
    const words = c.run.split(/\s+/);
    ok(words[0] === 'sentinel', `${n}: "${c.run}" starts at the dispatcher`);
    const verb = words[1];
    ok(topVerbs.has(verb), `${n}: "sentinel ${verb}" is a real dispatcher verb`);
    const sub = (words[2] || '').replace(/^"|"$/g, '');
    if (verb === 'connect') {
      ok(connectVerbs.has(sub) || connectorNames.has(sub),
        `${n}: "connect ${sub}" is a pass-through verb or a connector`);
    } else if (verb === 'doc') {
      ok(docActions.has(sub), `${n}: "doc ${sub}" is an action doc/cli.js handles`);
    } else if (verb === 'sec') {
      ok(secActions.has(sub), `${n}: "sec ${sub}" is an action sec_cli.js handles`);
    } else if (verb === 'case') {
      ok(caseSubs.has(sub), `${n}: "case ${sub}" is a documented case subcommand`);
    } else if (verb === 'pra') {
      ok(praSubs.has(sub), `${n}: "pra ${sub}" is an advertised pra subcommand`);
    } else if (verb === 'moneyflow') {
      // moneyflow takes a TARGET, not a subcommand, so there is no action list
      // to check it against. The failure mode for a target-taking verb is the
      // opposite one: a line that routes perfectly and asks about nothing,
      // because the target got dropped while building the string. Run with no
      // target, `sentinel moneyflow` reports the whole library -- which looks
      // like a working command and answers a question nobody asked.
      ok(c.run.includes(PROBE), `${n}: "${c.run}" carries the target, not just the verb`);
    }
    ok(typeof c.why === 'string' && c.why.length > 10, `${n}: "${c.run}" says why`);
  }
}
ok(checked >= 60, `checked every emitted command line (got ${checked})`);

// ── 3. an UNBACKED verb must not look answerable ──────────────────────
// The whole value of the status is destroyed if UNBACKED still prints a line
// that appears to answer the question. Every UNBACKED verb has to route to the
// records desk, because that is genuinely the only route there is.
for (const n of names) {
  const v = S.VERBS[n];
  if (v.status !== 'UNBACKED') continue;
  const r = S.route(`${n} ${PROBE}`);
  ok(r.commands.some((c) => c.run === 'sentinel foia'),
    `${n} is UNBACKED and routes to the records desk`);
  ok(v.ceiling === 'LEAD',
    `${n} is UNBACKED so it cannot claim to reach past a LEAD (says ${v.ceiling})`);
}

// A verb that claims it can reach a FINDING must route through the case gate.
// A search cannot produce a finding, and a verb that says it can is the exact
// lie this file exists to prevent.
for (const n of names) {
  const v = S.VERBS[n];
  if (v.ceiling !== 'FINDING') continue;
  const r = S.route(`${n} ${PROBE}`);
  ok(r.commands.some((c) => /^sentinel case /.test(c.run)),
    `${n} claims a FINDING ceiling and routes through the case gate`);
}

// ── 4. no placeholder ever reaches the shell ──────────────────────────
// A verb with no target prints NOTHING rather than a line with a placeholder
// in it. A placeholder pasted into a command is an argument, and `doc get`
// has already refused a real fetch because a literal placeholder was handed
// to it as a URL.
{
  const r = S.route('FOLLOWMONEY');
  ok(r.ok, 'a bare target-requiring verb still routes');
  ok(r.needsTarget, 'FOLLOWMONEY with no target reports that it needs one');
  ok(r.commands.length === 0, 'and emits zero commands rather than a placeholder');
}
{
  const r = S.route('RATEPAYER');
  ok(r.ok && !r.needsTarget && r.commands.length > 0,
    'a verb that needs no target still works bare');
}

// Template lines are marked, and marked lines are the only ones that carry a
// template token. Both directions, because a marker that is set everywhere is
// the same as a marker that is set nowhere.
for (const n of names) {
  for (const c of S.route(`${n} ${PROBE}`).commands) {
    const hasToken = S.TEMPLATE_TOKENS.some((t) => c.run.includes(t));
    ok(c.runnable === !hasToken,
      `${n}: "${c.run}" is marked runnable exactly when it carries no template`);
  }
}

// ── 5. unknown verbs fail loudly and helpfully ────────────────────────
{
  const r = S.route('FOLLOWDOLLAR meta');
  ok(!r.ok, 'an unknown verb does not route');
  ok(r.commands.length === 0, 'and emits nothing');
  ok(r.suggestions.includes('FOLLOWMONEY'),
    `and suggests the near miss (got ${r.suggestions.join(',') || 'none'})`);
}
ok(S.parse('followmoney meta').verb === 'FOLLOWMONEY', 'verbs are case-insensitive');
ok(S.parse('  FOLLOWMONEY   Meta Platforms  ').target === 'Meta Platforms',
  'the target is everything after the verb, trimmed');
ok(S.parse('').known === false, 'an empty line is not a verb');

// ── 6. printed output is safe to paste ────────────────────────────────
// Angle brackets are input redirection in zsh. `sentinel claim dispose` with a
// bracketed placeholder produced "no such file or directory" and no usage, four
// separate times on this branch, before anyone guarded it. Checked against
// rendered OUTPUT, never source: a bracket inside a comment explaining the rule
// is harmless, and a guard that matches its own comment is a mistake this
// repository has now made several times.
function run(args) {
  try {
    return execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}
const outputs = {
  usage: run([]),
  verbs: run(['verbs']),
  coverage: run(['coverage']),
  route: run(['FOLLOWMONEY Early Warning Services']),
  unbacked: run(['FOLLOWLAND New Albany']),
  bare: run(['FOLLOWMONEY']),
  unknown: run(['FOLLOWDOLLAR meta']),
};
for (const [what, out] of Object.entries(outputs)) {
  const m = /<[a-z][a-z0-9 _-]*>/i.exec(out);
  ok(!m, `ask ${what} prints no angle-bracket placeholder (found ${m && m[0]})`);
  ok(out.length > 100, `ask ${what} prints something substantial`);
}

// Every verb is listed by `ask verbs`, or it is a verb nobody can discover.
for (const n of names) {
  ok(outputs.verbs.includes(n), `ask verbs lists ${n}`);
}

// The route output has to carry the discipline, not just the commands.
for (const needle of ['RUN THESE', 'THE DENOMINATOR', 'CANNOT TELL YOU', 'CEILING']) {
  ok(outputs.route.includes(needle), `a route prints its ${needle} block`);
}
ok(outputs.unbacked.includes('NOT CONNECTED'),
  'an UNBACKED verb says so before it prints anything else');
ok(/county auditor/i.test(outputs.unbacked),
  'FOLLOWLAND names the record it cannot read');
ok(outputs.bare.includes('NEEDS A TARGET'), 'a bare verb says it needs a target');
ok(outputs.unknown.includes('FOLLOWMONEY'), 'an unknown verb suggests a real one');

// ── 6b. the written page must not drift from the code ─────────────────
// docs/SDCL.md carries a status per verb and a running count. Those numbers
// are the ones an operator quotes when explaining what the desk can do, and a
// stale count is worse than no count: it is a specific, checkable claim that
// happens to be false.
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SDCL.md'), 'utf8');
  for (const n of names) {
    const row = new RegExp('`' + n + '` \\| `(BACKED|PARTIAL|UNBACKED)`').exec(doc);
    ok(!!row, `docs/SDCL.md lists ${n}`);
    if (row) {
      ok(row[1] === S.VERBS[n].status,
        `docs/SDCL.md has ${n} as ${S.VERBS[n].status} (says ${row[1]})`);
    }
  }
  const tally = { BACKED: 0, PARTIAL: 0, UNBACKED: 0 };
  for (const n of names) tally[S.VERBS[n].status]++;
  for (const st of Object.keys(tally)) {
    ok(new RegExp('`' + st + '` \\| ' + tally[st] + ' \\|').test(doc),
      `docs/SDCL.md counts ${tally[st]} ${st} verbs`);
  }
  const manual = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATOR_MANUAL.md'), 'utf8');
  ok(manual.includes(`${tally.BACKED} BACKED, ${tally.PARTIAL} PARTIAL, ${tally.UNBACKED} UNBACKED`),
    'the operator manual quotes the current split');
}

// ── 7. the argument splitter ──────────────────────────────────────────
// --run executes exactly what it printed. A splitter that dropped quoting
// would turn one two-word subject into two one-word arguments and search for
// the wrong thing, successfully, with no error anywhere.
const { splitArgs } = require('./cli.js');
{
  const a = splitArgs('connect usaspending "Early Warning Services"');
  ok(a.length === 3, `quoted subjects stay one argument (got ${a.length})`);
  ok(a[2] === 'Early Warning Services', 'and keep their spaces');
  const b = splitArgs('connect sweep ratepayers --go');
  ok(b.join('|') === 'connect|sweep|ratepayers|--go', 'flags survive splitting');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
