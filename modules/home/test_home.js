'use strict';
/**
 * modules/home/test_home.js
 *
 * The risk in a front door is not that a button is ugly. It is that a button
 * lies — runs a command that no longer exists, opens a window that vanishes
 * before you can read the error, or quietly copies case material onto the
 * least protected folder on the machine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = require('./build_home.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = function run() {
  console.log('\n  home (the front door)\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const dest = path.join(dir, 'Sentinel');
  const r = H.build({ root: ROOT, dest });

  // ══ it builds, and everything is double-clickable ═════════════════════
  {
    check('the folder is created', fs.existsSync(dest));
    check('a README is written', fs.existsSync(path.join(dest, 'READ ME FIRST.md')));
    const cmds = fs.readdirSync(dest).filter((f) => f.endsWith('.command'));
    check('every entry produced a .command', cmds.length === H.entries(ROOT).length,
      `${cmds.length} files`);

    // Not executable means double-clicking opens it in a text editor, which
    // looks exactly like the launcher being broken.
    const notExec = cmds.filter((f) => !(fs.statSync(path.join(dest, f)).mode & 0o111));
    check('all of them are executable', notExec.length === 0, notExec.join(', '));

    check('they are numbered, so the folder has an order',
      cmds.every((f) => /^\d+ /.test(f)), cmds.join(' | '));
  }

  // ══ every button runs a command that actually exists ══════════════════
  //
  // The failure this prevents: a launcher pointing at `sentinel foia dash`
  // after someone renames the subcommand. The window flashes, the error
  // scrolls past, and the button is "just broken" forever.
  {
    const help = execFileSync(path.join(ROOT, 'bin', 'sentinel'), ['help'], { encoding: 'utf8' });
    const verbs = new Set();
    for (const m of help.matchAll(/^\s*sentinel\s+([a-z]+)/gm)) verbs.add(m[1]);

    const missing = [];
    for (const e of H.entries(ROOT)) {
      const m = /bin\/sentinel"\s+([a-z]+)/.exec(e.cmd);
      if (!m) continue;                       // `open <path>` entries
      if (!verbs.has(m[1])) missing.push(`${e.file} -> sentinel ${m[1]}`);
    }
    check('every launcher calls a verb that sentinel help lists',
      missing.length === 0, missing.join('; '));
  }

  // ══ a window that closes on an error teaches nothing ══════════════════
  {
    const bodies = fs.readdirSync(dest).filter((f) => f.endsWith('.command'))
      .map((f) => fs.readFileSync(path.join(dest, f), 'utf8'));
    check('every launcher pauses on failure instead of vanishing',
      bodies.every((b) => /STATUS -ne 0/.test(b) && /read -r _/.test(b)));
    check('and says what to do when the repo has moved',
      bodies.every((b) => /Re-run: sentinel home/.test(b)));
  }

  // ══ nothing sensitive lands on the Desktop ════════════════════════════
  //
  // The whole point of doors rather than copies. The Desktop is what gets
  // screen-shared and cloud-synced.
  {
    const files = fs.readdirSync(dest);
    const all = files.map((f) => fs.readFileSync(path.join(dest, f), 'utf8')).join('\n');
    check('no capture, case file, or FOIA store was copied in',
      !files.some((f) => /\.json$|\.jsonl$|live_capture|foia_requests/.test(f)),
      files.join(', '));
    check('the README says this folder holds no case material',
      /Nothing in this folder holds your case material/.test(
        fs.readFileSync(path.join(dest, 'READ ME FIRST.md'), 'utf8')));

    // A launcher may REFERENCE the ledger path (verify reads it); it must not
    // contain evidence content.
    check('no launcher embeds capture contents',
      !/"results"|"opinion_id"|filing_uuid/.test(all));
  }

  // ══ the README explains, in plain words, and states the limits ════════
  {
    const md = fs.readFileSync(path.join(dest, 'READ ME FIRST.md'), 'utf8');
    check('it names every button', H.entries(ROOT).every(
      (e) => md.includes(e.file.replace(/\.command$/, ''))));
    check('it states the lead-vs-claim rule',
      /search result is a \*\*lead\*\*/.test(md) && /cites the document/.test(md));
    check('it warns that the Ohio clock is not statutory',
      /R\.C\. 149\.43 sets no deadline/.test(md));
    check('it says the publish gate has no override',
      /there is no override/i.test(md));
    check('it tells you how to rebuild after moving the repo',
      /bin\/sentinel home/.test(md));
  }

  // ══ re-running is safe ════════════════════════════════════════════════
  //
  // Documented as safe, so it has to actually be. A build that appended, or
  // that failed on an existing directory, would make the advice wrong.
  {
    const before = fs.readdirSync(dest).sort().join('|');
    H.build({ root: ROOT, dest });
    const after = fs.readdirSync(dest).sort().join('|');
    check('a second build produces the same folder, not duplicates',
      before === after, `${before}\n          ${after}`);

    // And it must survive a stale file left by an older version.
    fs.writeFileSync(path.join(dest, 'stale.command'), 'old');
    H.build({ root: ROOT, dest });
    check('rebuilding does not throw when the folder already has content',
      fs.existsSync(path.join(dest, 'READ ME FIRST.md')));
  }

  // ══ paths with spaces survive ═════════════════════════════════════════
  //
  // "~/Desktop/Sentinel" is fine; the REPO path is the risk — plenty of Macs
  // have it under a folder with a space, and an unquoted cd silently runs the
  // command in the wrong directory.
  {
    const spaced = path.join(dir, 'My Folder', 'Sentinel OS');
    fs.mkdirSync(spaced, { recursive: true });
    const r2 = H.build({ root: spaced, dest: path.join(dir, 'S2') });
    const body = fs.readFileSync(r2.written[0], 'utf8');
    check('the repo path is quoted in the cd',
      body.includes(`cd "${spaced}"`), (body.match(/cd .*/) || [])[0]);
    check('and quoted where the binary is invoked',
      body.includes(`"${spaced}/bin/sentinel"`));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
