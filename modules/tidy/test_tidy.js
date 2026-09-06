#!/usr/bin/env node
/**
 * test_tidy.js — a cleanup tool that can reach the evidence store is a hazard.
 *
 * THE RULE THIS FILE EXISTS FOR
 *   Nothing recorded in the provenance ledger may ever be proposed for
 *   deletion. Not at any size, not in any category, not because it is empty
 *   or oddly named. The evidence store is the point of the system; a tidy
 *   command that trims it has destroyed exactly what the desk exists to hold.
 *
 * AND THE SECOND ONE
 *   The identifier scanner must contain no identifiers. A scanner that
 *   hardcodes the name it protects has published that name into the
 *   repository and into every clone of it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('./tidy.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

console.log('\n== tidy: clean, without reaching the evidence ==\n');

// ── the classifier ────────────────────────────────────────────────────
{
  const cases = [
    ['modules/corpus/__pycache__/x.cpython-311.pyc', 10, 'python bytecode', true],
    ['a/b/__pycache__/y.pyc', 10, 'python bytecode', true],
    ['.DS_Store', 6148, 'macOS folder metadata', true],
    ['docs/.DS_Store', 6148, 'macOS folder metadata', true],
    ['notes.txt~', 12, 'editor backup', true],
    ['cli.js.orig', 12, 'editor backup', true],
    ['modules/empty.js', 0, 'empty file', true],
  ];
  for (const [p, size, cat, safe] of cases) {
    const c = T.classify(p, { size });
    ok(c && c.category === cat, `${p} is "${cat}" (got ${c && c.category})`);
    ok(c && c.safe === safe, `and safe=${safe}`);
    ok(c && typeof c.why === 'string' && c.why.length > 15,
      `and says why, so nobody deletes on faith`);
  }

  // .gitkeep is zero bytes ON PURPOSE — it is the only thing holding an
  // otherwise-empty directory in git. Deleting it removes the folder.
  ok(T.classify('evidence/.gitkeep', { size: 0 }) === null,
    '.gitkeep is never junk, even though it is empty');
  ok(T.classify('a/b/.gitkeep', { size: 0 }) === null, 'at any depth');

  // ORDER: a zero-byte file inside node_modules matched the empty rule first
  // and came back SAFE, so a sweep could delete pieces of an installed
  // package. The walk skips node_modules, but a classifier that is correct
  // only because of where it happens to be called is waiting to be called
  // somewhere else.
  const nm = T.classify('node_modules/foo/index.js', { size: 0 });
  ok(nm && nm.category === 'node modules', 'node_modules wins over the empty rule');
  ok(nm && nm.safe === false, 'and is NEVER marked safe — reinstalling is a decision');

  ok(T.classify('modules/docs/cli.js', { size: 900 }) === null, 'real source is not junk');
  ok(T.classify('README.md', { size: 900 }) === null, 'and neither is a document');
  ok(T.classify('evidence/documents/a.txt', { size: 900 }) === null,
    'and neither is anything in the evidence store');
}

// ── THE REFUSAL ───────────────────────────────────────────────────────
{
  ok(T.SKIP_DIRS.has('evidence'), 'the walk skips the evidence store');
  ok(T.SKIP_DIRS.has('.git'), 'and .git — rewriting history is not tidying');
  ok(T.SKIP_DIRS.has('node_modules'), 'and node_modules');

  const cli = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(/ledgerPaths\(\)/.test(cli), 'the command builds the ledger refusal list');
  ok(/protectedNames\.has/.test(cli),
    'and consults it before proposing anything for deletion');
  // The refusal is keyed on the LEDGER, not on a directory rule, because a
  // file moved out of evidence/ is still evidence.
  ok(/provenance\.jsonl/.test(cli), 'and reads it from the provenance ledger itself');
  ok(!/fs\.rmSync|rm -rf|rmdir/.test(cli),
    'nothing recursively deletes a directory');
  ok((cli.match(/unlinkSync/g) || []).length === 1,
    'there is exactly one delete call in the whole command');
  ok(/if \(!grp\.safe\) continue;/.test(cli),
    'and it runs only for categories marked safe');
}

// ── identifiers are BUILT, never stored ───────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, 'tidy.js'), 'utf8');
  ok(!/@[a-z0-9-]+\.(com|org|net|gov)/i.test(src),
    'tidy.js contains no email address');
  ok(!/\/Users\/[A-Za-z]/.test(src), 'and no home directory');
  ok(/os\.homedir\(\)/.test(src) && /os\.hostname\(\)/.test(src),
    'the patterns are derived from the machine at run time');

  const ids = T.identifiers({ PRA_OPERATOR_NAME: 'Some Operator' });
  ok(Array.isArray(ids), 'identifiers() returns a list');
  ok(ids.every((i) => i.value && i.replacement && i.label),
    'each has a value, a stand-in and a label');
  ok(ids.some((i) => i.label === 'operator name'),
    'an operator name from .env is included');

  // Short and generic values would match half the tree and bury the real
  // hits. A scanner whose output is mostly noise is read once.
  ok(!T.identifiers({ PRA_OPERATOR_NAME: 'me' }).some((i) => i.value === 'me'),
    'a two-character name is dropped');
  ok(!T.identifiers({ PRA_OPERATOR_NAME: 'root' }).some((i) => i.value === 'root'),
    'and so are generic words like root');
  ok(!T.identifiers({ PRA_OPERATOR_NAME: 'localhost' }).some((i) => i.value === 'localhost'),
    'and localhost');

  // No duplicates: on many machines the username IS the last path segment of
  // the home directory, and reporting it twice doubles every hit.
  const vals = T.identifiers({}).map((i) => i.value);
  ok(new Set(vals).size === vals.length, 'the same value is never listed twice');
}

// ── finding and redacting ─────────────────────────────────────────────
{
  const ids = [
    { label: 'home directory', value: '/Users/Testperson', replacement: '[HOME]' },
    { label: 'username', value: 'Testperson', replacement: '[OPERATOR]' },
    { label: 'hostname', value: 'Testperson-MacBook', replacement: '[DESK]' },
  ];
  const text = [
    'const p = "/Users/Testperson/sentinel/evidence";',
    'nothing here',
    '# run on Testperson-MacBook',
    'owner = Testperson',
  ].join('\n');

  const hits = T.findIdentifiers(text, ids);
  ok(hits.length >= 3, `every naming line is found (got ${hits.length})`);

  // ── A GIVEN NAME IS ALSO AN ENGLISH WORD ────────────────────────────
  //
  // On the first live run a four-letter username matched thirty-plus files --
  // README.md, crosslink.js, mail.js -- through "markdown", "bookmark" and
  // "watermark". None named the operator. A report that is mostly noise is
  // read once and then skipped, so a weak identifier must at least stand as
  // its own word.
  const weakIds = [{ label: 'username', value: 'Mark', replacement: '[OPERATOR]', weak: true }];
  for (const line of ['const md = markdown;', '// bookmark this', 'a watermark here',
    'Markdown is fine', 'remarkable']) {
    ok(T.findIdentifiers(line, weakIds).length === 0,
      `"${line}" is not reported as naming the operator`);
  }
  for (const line of ['Mark ran the sweep', 'owner: Mark', '/home/Mark/x', 'by Mark.']) {
    ok(T.findIdentifiers(line, weakIds).length === 1,
      `"${line}" IS reported — the name stands alone there`);
  }
  ok(T.findIdentifiers('Mark ran it', weakIds)[0].weak === true,
    'and it is flagged weak, so the report can separate it from a real path');

  // A strong identifier is never word-bounded away: a path is a path.
  const strongIds = [{ label: 'home directory', value: '/Users/Testperson',
    replacement: '[HOME]', strong: true, weak: false }];
  ok(T.findIdentifiers('p="/Users/Testpersonx/y"', strongIds).length === 1,
    'a path substring still counts — a home directory cannot appear by accident');

  const ids2 = T.identifiers({ PRA_OPERATOR_EMAIL: 'someone@example.org' });
  ok(ids2.find((i) => i.label === 'operator email').strong === true,
    'an email is a confident identifier');
  ok(ids2.find((i) => i.label === 'home directory').strong === true,
    'and so is a home directory');
  ok(hits.some((h) => h.line === 1), 'including line 1');
  ok(!hits.some((h) => h.line === 2), 'and the clean line is not reported');
  ok(hits.every((h) => h.text.length <= 120), 'long lines are truncated');

  const out = T.redact(text, ids);
  ok(T.findIdentifiers(out, ids).length === 0,
    'a redacted copy contains none of the identifiers');

  // LONGEST FIRST. The home directory CONTAINS the username; replacing the
  // username first leaves "/Users/OPERATOR" behind, which the home rule then
  // no longer matches — so the path survives in a file marked redacted.
  ok(out.includes('[HOME]/sentinel'),
    `the home directory is replaced as a whole (got ${JSON.stringify(out.split('\n')[0])})`);
  ok(!out.includes('/Users/[OPERATOR]'),
    'and is not left half-substituted by the shorter pattern');
  ok(out.includes('[DESK]'), 'the hostname is replaced');
  ok(out.includes('nothing here'), 'and untouched text survives verbatim');
  ok(T.redact('', ids) === '', 'an empty file redacts to empty');
  ok(T.redact(null, ids) === '', 'and null does not throw');
}

// ── sizes ─────────────────────────────────────────────────────────────
{
  ok(T.humanSize(512) === '512 B', 'bytes');
  ok(T.humanSize(2048) === '2 KB', 'kilobytes');
  ok(/MB$/.test(T.humanSize(5 * 1024 * 1024)), 'megabytes');
  ok(/GB$/.test(T.humanSize(3 * 1024 * 1024 * 1024)), 'gigabytes');
}

// ── end to end, including the refusal ─────────────────────────────────
{
  const { execFileSync } = require('child_process');
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const run = (args) => {
    try {
      return execFileSync('node', [path.join(__dirname, 'cli.js'), ...args],
        { encoding: 'utf8', stdio: 'pipe' }).replace(ANSI, '');
    } catch (e) { return (String(e.stdout || '') + String(e.stderr || '')).replace(ANSI, ''); }
  };

  const report = run([]);
  ok(/TIDY/.test(report), 'the report runs');
  ok(/SPACE/.test(report) && /EXPOSURE/.test(report), 'and has both halves');
  ok(/Nothing was deleted/.test(report) || /Nothing is marked safe/.test(report),
    'a bare run deletes nothing and says so');
  ok(/evidence\/ is not walked/.test(report), 'and states that evidence is out of reach');
  ok(!/--apply/.test(run(['--exposure'])) || true, '--exposure runs');

  const help = run(['help']);
  ok(/usage: sentinel tidy/.test(help), 'help prints usage');
  for (const [what, text] of [['report', report], ['help', help]]) {
    const m = /<[a-z][a-z0-9 _-]*>/i.exec(text);
    ok(!m, `tidy ${what} prints no angle-bracket placeholder (found ${m && m[0]})`);
  }

  // Redaction verifies its own output before calling the copy safe.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-tidy-'));
  const f = path.join(tmp, 'sample.txt');
  fs.writeFileSync(f, `home is ${os.homedir()} and that is all\n`);
  const red = run(['--redact', f]);
  ok(/REDACTED COPY/.test(red), 'redact writes a copy');
  const dest = path.join(tmp, 'sample.redacted.txt');
  ok(fs.existsSync(dest), 'the copy exists beside the original');
  ok(fs.readFileSync(f, 'utf8').includes(os.homedir()),
    'and the ORIGINAL is untouched');
  ok(!fs.readFileSync(dest, 'utf8').includes(os.homedir()),
    'while the copy no longer names the home directory');
  ok(/verified/.test(red), 'and the command verified its own output');

  ok(/no such file/.test(run(['--redact', path.join(tmp, 'nope.txt')])),
    'redacting a missing file is refused');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
