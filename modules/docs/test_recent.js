#!/usr/bin/env node
/**
 * test_recent.js — a placeholder pasted into a command is an argument.
 *
 * THE DEFECT, WHICH WAS MINE AND NOT THE OPERATOR'S
 *   Saved documents are named for the evidence store, not for typing:
 *   2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators-get-...txt
 *   So every hand-written next step used a stand-in -- THE_FILE.txt -- and it
 *   got pasted verbatim, four separate times in one working session.
 *
 *   "cannot read THE_FILE.txt" is true and useless: it reads as a broken
 *   command and sends someone hunting for a file. The dangerous version is a
 *   stand-in that names something real, where a quote is checked against the
 *   wrong document and the answer is believed.
 *
 *   This repository has already been bitten by two shapes of the same disease
 *   -- angle brackets in help text, which zsh reads as redirection, and a
 *   literal placeholder handed to `doc get` as a URL. Both are guarded in
 *   core/test_docs.js. This is the third, and the fix is not another warning:
 *   it is making the real path reachable without typing it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RC = require('./recent.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

console.log('\n== recent documents: never retype a path ==\n');

// ── placeholder detection ─────────────────────────────────────────────
//
// Both directions matter. Missing a stand-in lets it through as an argument;
// flagging a real file makes the tool refuse work it should have done.
for (const s of ['THE_FILE.txt', 'FILE.txt', 'YOUR_FILE.txt', 'PASTE_THE_PATH',
  'THE_TEXT_FILE_doc_get_PRINTED.txt', 'URL', 'PATH', 'CASE_ID']) {
  ok(RC.looksLikePlaceholder(s), `"${s}" is caught as a placeholder`);
}
for (const s of ['2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators.txt',
  'evidence/documents/a.txt', 'README.md', 'notes.txt', 'ACFR2025.pdf',
  '/Users/Mark/sentinel/evidence/documents/x.txt']) {
  ok(!RC.looksLikePlaceholder(s), `"${s}" is NOT flagged — it is a real name`);
}
ok(!RC.looksLikePlaceholder(''), 'an empty string is not a placeholder');
ok(!RC.looksLikePlaceholder(null), 'and neither is null');

// ── ordering ──────────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-recent-'));
  const names = [
    '2026-09-06T04-12-30-115Z__13f080d8674c__ohioans-are-getting-fed-up.txt',
    '2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators-get-update.txt',
    '2026-09-05T22-01-02-000Z__aaaaaaaaaaaa__an-older-one.txt',
    '2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators-get-update.html',
    'hand-saved-from-a-browser.txt',
  ];
  // Written in an order that does NOT match their timestamps, and with an
  // mtime that would sort differently -- because ordering must come from the
  // name. mtime is rewritten by a copy, a restore, or a move between machines;
  // none of those change when the document was actually captured.
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  fs.utimesSync(path.join(dir, names[1]), new Date('2000-01-01'), new Date('2000-01-01'));

  const txts = RC.list(dir, { ext: '.txt' });
  ok(txts.length === 4, `only .txt files are listed when asked (got ${txts.length})`);
  ok(txts[0].name === names[1],
    `newest by NAME comes first even with an old mtime (got ${txts[0].name})`);
  ok(RC.list(dir).length === 5, 'without a filter, every file is listed');

  const l = RC.latest(dir, { ext: '.txt' });
  ok(l && l.name === names[1], 'latest() agrees with the head of the list');
  ok(l.short === 'fa126858f579', `the short hash is parsed out (got ${l.short})`);
  ok(l.stamp === '2026-09-06T04-18-35-154Z', `and the stamp (got ${l.stamp})`);
  ok(l.slug === 'ohio-senators-get-update', `and a readable slug (got ${l.slug})`);

  const hand = txts.find((t) => t.name === 'hand-saved-from-a-browser.txt');
  ok(hand && hand.stamp === '' && hand.short === '',
    'a file added by hand parses to empty fields rather than garbage');
  ok(hand.slug === 'hand-saved-from-a-browser', 'and still gets a slug');

  ok(RC.list(path.join(dir, 'nope')).length === 0, 'a missing directory lists empty');
  ok(RC.latest(path.join(dir, 'nope')) === null, 'and has no latest');

  // ── resolve ─────────────────────────────────────────────────────────
  const real = path.join(dir, names[1]);
  ok(RC.resolve(real, dir).path === real, 'a real path resolves to itself');
  ok(RC.resolve(null, dir, { last: true, ext: '.txt' }).path === real,
    '--last resolves to the newest .txt');
  ok(/--last/.test(RC.resolve(null, dir, { last: true, ext: '.txt' }).why),
    'and says which file it chose');

  const ph = RC.resolve('THE_FILE.txt', dir);
  ok(ph.error && ph.placeholder === true, 'a placeholder is refused AS a placeholder');
  ok(/doc last/.test(ph.suggestion), 'and points at doc last');

  const missing = RC.resolve('no-such-file.txt', dir);
  ok(missing.error && !missing.placeholder,
    'a genuinely missing file is reported as missing, not as a placeholder');

  // A MISSING FILE IS NEVER SILENTLY SWAPPED FOR THE NEWEST ONE. That would
  // turn a typo into a verified quote against the wrong document, which is the
  // exact failure this whole file exists to prevent.
  ok(!missing.path, 'and is NOT quietly replaced by the newest document');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-empty-'));
  const none = RC.resolve(null, empty, { last: true });
  ok(none.error && /nothing has been fetched/.test(none.error),
    '--last on an empty store says so plainly');
  ok(/doc get/.test(none.suggestion), 'and tells you to fetch something');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
}

// ── the commands, end to end ──────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cli-'));
  const docs = path.join(root, 'documents');
  fs.mkdirSync(docs, { recursive: true });
  const article = '2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators-get-update.txt';
  fs.writeFileSync(path.join(docs, article),
    'PUCO Chair Jenifer French told the committee this is more gas-fired '
    + 'generation than in the past 20 years. The commission signed off on '
    + '2,000 megawatts of behind the meter power.');

  const env = Object.assign({}, process.env, { SENTINEL_EVIDENCE_DIR: root });
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const strip = (s) => s.replace(ANSI, '');
  const run = (args) => {
    try {
      return { out: strip(execFileSync('node', [path.join(__dirname, 'cli.js'), ...args],
        { encoding: 'utf8', env, stdio: 'pipe' })), code: 0 };
    } catch (e) {
      return { out: strip(String(e.stdout || '') + String(e.stderr || '')), code: e.status };
    }
  };

  const last = run(['last']);
  ok(/LAST FETCHED/.test(last.out), 'doc last prints the store');
  ok(last.out.includes(article), 'and names the real file');
  ok(/--last/.test(last.out), 'and shows how to use it without retyping');

  const byLast = run(['quote', '--last', 'this is more gas-fired generation than in the past 20 years']);
  ok(/VERBATIM/.test(byLast.out), 'doc quote --last checks the newest document');
  ok(byLast.code === 0, 'and exits 0 on a verified quote');

  const ph = run(['quote', 'THE_FILE.txt', 'anything at all']);
  ok(/placeholder/i.test(ph.out),
    'a pasted placeholder is named as one rather than reported as a missing file');
  ok(ph.code === 2, 'and exits 2');
  ok(/doc last/.test(ph.out), 'and points at the command that shows the real path');

  const gone = run(['quote', 'really-not-here.txt', 'anything at all']);
  ok(/no such file/.test(gone.out) && !/placeholder/i.test(gone.out),
    'a real typo is reported as a missing file, not as a placeholder');

  // No angle brackets anywhere: they are input redirection in zsh.
  for (const [what, r] of [['last', last], ['placeholder refusal', ph], ['usage', run([])]]) {
    const m = /<[a-z][a-z0-9 _-]*>/i.exec(r.out);
    ok(!m, `doc ${what} prints no angle-bracket placeholder (found ${m && m[0]})`);
  }

  // And the help itself must not hand out the very stand-in this file exists
  // to stop -- a usage line reading THE_FILE.txt would reintroduce it.
  ok(!/THE_FILE|YOUR_FILE|PASTE_/.test(run([]).out),
    'the usage screen contains no stand-in of its own');

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
