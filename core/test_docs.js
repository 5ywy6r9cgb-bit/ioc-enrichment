#!/usr/bin/env node
/**
 * test_docs.js — the operator manual must not drift from the dispatcher.
 *
 * WHY THIS EXISTS
 *   docs/OPERATOR_MANUAL.md is the page you read when there is nobody to ask.
 *   A command added to bin/sentinel and not written down there is a command
 *   that, for the operator, does not exist. Worse, a manual that is 90%
 *   right is the calmest kind of wrong: you trust it, it omits the one verb
 *   you needed, and you conclude the desk cannot do the thing.
 *
 *   So: every top-level verb the dispatcher answers to, and every `pra`
 *   subcommand it advertises, has to appear in the manual. This is a
 *   spelling check, not a quality check — it cannot tell you the manual is
 *   accurate, only that it is not silently incomplete.
 *
 * NOTE ON READING SOURCE
 *   Comment lines are stripped before the case statement is scanned. This
 *   file's own explanatory comments, and the dispatcher's, would otherwise
 *   match the patterns being searched for — which has happened four separate
 *   times in this repo and always reads as a passing test.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DISPATCHER = path.join(ROOT, 'bin', 'sentinel');
const MANUAL = path.join(ROOT, 'docs', 'OPERATOR_MANUAL.md');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

/** Shell source with comment-only lines removed. */
function uncommented(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

const dispatcher = uncommented(DISPATCHER);
const manual = fs.readFileSync(MANUAL, 'utf8');

// ---- top-level verbs -------------------------------------------------
// The outer case arms sit at exactly two spaces of indent. Nested arms
// (pra's, watch's, connect's) are deeper, so this reads only the top level.
const verbs = new Set();
for (const line of dispatcher.split('\n')) {
  const m = line.match(/^ {2}([a-z|?\\-]+)\)/);
  if (!m) continue;
  for (const v of m[1].split('|')) {
    const clean = v.replace(/\\/g, '');
    // Flag spellings and the catch-all are not commands to document.
    if (!clean || clean.startsWith('-') || clean === '?' || clean === '*') continue;
    verbs.add(clean);
  }
}

ok(verbs.size >= 12, `found the top-level verbs (got ${verbs.size})`);

for (const v of [...verbs].sort()) {
  ok(new RegExp(`sentinel ${v}\\b`).test(manual),
    `docs/OPERATOR_MANUAL.md documents "sentinel ${v}"`);
}

// ---- the help screen must not silently shrink ------------------------
// `sentinel help` used to print a hardcoded line range of its own header
// (`sed -n '3,40p'`). The header grew past line 40 and help quietly stopped
// after `watch run`, omitting six real commands. Nothing failed and nothing
// warned -- the help screen just became shorter than the truth, and the only
// way to notice was to already know what was missing.
//
// So: every top-level verb the dispatcher answers to must actually appear in
// what `sentinel help` prints. Not in the source -- in the OUTPUT.
const helpOut = require('child_process')
  .execFileSync(DISPATCHER, ['help'], { encoding: 'utf8' });

ok(helpOut.length > 500, 'sentinel help prints something substantial');
for (const v of [...verbs].sort()) {
  ok(new RegExp(`sentinel ${v}\\b`).test(helpOut),
    `sentinel help lists "sentinel ${v}"`);
}

// The header block has to be terminated, or the awk that prints it runs on
// past the comments and dumps the shell source at the operator. Checking for
// the closing ==== rule is NOT enough -- the opening rule matches the same
// pattern, so that check passes even with the terminator deleted. Test the
// property that actually matters: help prints help, not code.
for (const leak of ['set -euo pipefail', 'usage()', 'BASH_SOURCE', '${ROOT}']) {
  ok(!helpOut.includes(leak),
    `sentinel help does not leak shell source ("${leak}")`);
}

// ══ ANGLE BRACKETS ARE INPUT REDIRECTION IN zsh ═══════════════════════════
//
// `sentinel claim dispose <id>` pasted into zsh produces
//     zsh: no such file or directory: id
// and no usage message. It happened four times on this branch before anyone
// guarded it -- in the help screen, in the manual, and twice inside command
// output -- because the placeholder LOOKS like a documentation convention
// and is in fact a shell operator.
//
// Checked against rendered OUTPUT, never source. A `<...>` inside a comment
// explaining this rule is harmless, and a guard that matches its own comment
// is a mistake this repo has now made four separate times.
{
  const m = /<[a-z][a-z0-9 _-]*>/i.exec(helpOut);
  ok(!m, `sentinel help has no angle-bracket placeholder (found ${m && m[0]})`);
}

// The help screen was not the only place. A `<case-id>` was still being
// printed by `doc get` after the first purge, because the guard only looked
// at one command's output. Every CLI that prints a usage line is checked.
{
  const { execFileSync } = require('child_process');
  const clis = [
    ['modules/docs/cli.js', []],
    ['modules/bridge/draft.js', ['--help']],
    ['modules/connectors/cli.js', ['senatelda', '--registrant']],
  ];
  for (const [rel, argv] of clis) {
    const file = require('path').join(__dirname, '..', rel);
    let out = '';
    try {
      out = execFileSync('node', [file, ...argv], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    const m = /<[a-z][a-z0-9 _-]*>/i.exec(out);
    ok(!m, `${rel} usage has no angle-bracket placeholder (found ${m && m[0]})`);
  }
}


// ---- pra subcommands -------------------------------------------------
// The dispatcher prints its own list when you type a bad one. That line is
// the authoritative set, so read it rather than the case arms — if the two
// ever disagree, the printed list is what an operator is told.
const praLine = dispatcher.match(/pra subcommands: (.+?)"/);
ok(!!praLine, 'bin/sentinel advertises its pra subcommands');
if (praLine) {
  for (const sub of praLine[1].trim().split(/\s+/)) {
    ok(new RegExp(`sentinel pra ${sub}\\b`).test(manual),
      `docs/OPERATOR_MANUAL.md documents "sentinel pra ${sub}"`);
  }
}

// ---- connect subverbs: cli.js and the dispatcher must agree ----------
// `all` was added to cli.js and not to bin/sentinel's pass-through list, so
// `sentinel connect all "X"` became `cli.js search all "X"` and reported
// "unknown connector: all". Nothing was broken in the module — the module
// worked perfectly when called directly. The dispatcher is the surface an
// operator actually types, so a verb that works only via `node cli.js` is
// not yet a command. This checks the two lists against each other, and the
// manual against both.
const connectArm = dispatcher.match(/^ {6}(test\|[a-z|]+)\)/m);
ok(!!connectArm, 'bin/sentinel lists the connect verbs it passes through');
if (connectArm) {
  const passed = connectArm[1].split('|');
  const cliSrc = fs.readFileSync(path.join(ROOT, 'modules', 'connectors', 'cli.js'), 'utf8');
  const handled = [...cliSrc.matchAll(/action === '([a-z]+)'/g)].map((m) => m[1]);

  // `search` is the one verb deliberately NOT passed through. The dispatcher's
  // fallback arm supplies it — `sentinel connect fec "X"` becomes
  // `cli.js search fec "X"` — so an operator never types it and it must not
  // be in the pass-through list, or a connector named "search" would shadow it.
  const INTERNAL = new Set(['search']);
  for (const v of handled) {
    if (INTERNAL.has(v)) continue;
    ok(passed.includes(v),
      `bin/sentinel passes "connect ${v}" through (cli.js handles it)`);
  }
  for (const v of passed) {
    ok(handled.includes(v), `cli.js handles "connect ${v}" (the dispatcher passes it)`);
    ok(new RegExp(`sentinel connect ${v}\\b`).test(manual),
      `docs/OPERATOR_MANUAL.md documents "sentinel connect ${v}"`);
  }
}

// ---- connector names -------------------------------------------------
// A connector you cannot name is a connector you cannot search.
const registry = fs.readFileSync(path.join(ROOT, 'modules', 'connectors', 'registry.js'), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join('\n');
const keyVars = [...registry.matchAll(/keyVar: '([A-Z_0-9]+)'/g)].map((m) => m[1]);
ok(keyVars.length >= 7, `found connector key variables (got ${keyVars.length})`);
for (const kv of new Set(keyVars)) {
  ok(manual.includes(kv), `docs/OPERATOR_MANUAL.md names ${kv}`);
}

// ---- the things that cost real time ----------------------------------
// Each of these is a failure that actually happened and was diagnosed the
// slow way. The manual earns its keep by making the second occurrence cheap.
const MUST_MENTION = [
  ['zsh', 'the zsh # pitfall that silently broke the launchd schedule'],
  ['notified via none', 'the notification backend that delivers nothing'],
  ['operator_policy', 'that Ohio deadlines are policy, not statute'],
  ['mandamus', 'that damages require a filed mandamus action'],
  ['--dry-run', 'the flag that checks without sending'],
  ['county auditor', 'that parcel ownership is not a federal record'],
  ['gitignored', 'that the evidence store is never pushed'],
];
for (const [needle, why] of MUST_MENTION) {
  ok(manual.toLowerCase().includes(needle.toLowerCase()),
    `manual covers ${why} ("${needle}")`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
