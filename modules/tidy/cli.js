#!/usr/bin/env node
/**
 * cli.js — `sentinel tidy`, and it deletes nothing unless you say so twice.
 *
 *   sentinel tidy              what is junk, what names you, how much space
 *   sentinel tidy --apply      delete ONLY the categories marked safe
 *   sentinel tidy --exposure   just the places you are named
 *   sentinel tidy --redact FILE   write a redacted COPY beside the original
 *
 * THE EVIDENCE STORE IS NOT REACHABLE FROM HERE.
 * The walk skips it, and any file whose hash appears in the provenance ledger
 * is refused by name even if something else proposes it. A cleanup tool that
 * can reach into the evidence store is not worth the space it saves.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./tidy.js');

const ROOT = path.join(__dirname, '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const LEDGER = path.join(EVIDENCE, 'manifests', 'provenance.jsonl');

const CSI = String.fromCharCode(27) + '[';
const b = (s) => `${CSI}1m${s}${CSI}0m`;
const d = (s) => `${CSI}2m${s}${CSI}0m`;
const y = (s) => `${CSI}33m${s}${CSI}0m`;
const g = (s) => `${CSI}32m${s}${CSI}0m`;
const r = (s) => `${CSI}31m${s}${CSI}0m`;
const log = (s = '') => console.log(s);

function wrap(text, indent = 4, width = 78) {
  const pad = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    if (line && line.length + 1 + w.length > width - indent) { out.push(pad + line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(pad + line);
  return out.join('\n');
}

/** Read .env for the optional operator fields, without printing any value. */
function readEnv() {
  const out = {};
  for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'modules', 'pra', '.env')]) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
        if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* absent is normal */ }
  }
  return out;
}

/**
 * Every path the ledger has ever recorded.
 *
 * This is the refusal list. It is built from the ledger itself rather than
 * from a rule about directories, because a file moved out of evidence/ is
 * still evidence.
 */
function ledgerPaths() {
  const keep = new Set();
  try {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.local_path) keep.add(path.basename(rec.local_path));
      } catch { /* a malformed line protects nothing; skip it */ }
    }
  } catch { /* no ledger yet */ }
  return keep;
}

function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r2 = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (T.SKIP_DIRS.has(e.name)) {
        out.push({ rel: r2, path: full, dir: true, skipped: true });
        continue;
      }
      walk(full, r2, out);
    } else if (e.isFile()) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({ rel: r2, path: full, size: st.size });
    }
  }
  return out;
}

function cmdTidy(opts) {
  const env = readEnv();
  const ids = T.identifiers(env);
  const protectedNames = ledgerPaths();

  log('');
  log(b('  TIDY'));
  log(d(`  ${ROOT}`));
  log(d(`  evidence/ is not walked, and ${protectedNames.size} ledger-recorded file(s) are refused by name`));

  const files = walk(ROOT).filter((f) => !f.dir);

  // ── SPACE ───────────────────────────────────────────────────────────
  if (!opts.exposureOnly) {
    const found = new Map();
    for (const f of files) {
      const c = T.classify(f.rel, { size: f.size });
      if (!c) continue;
      // THE REFUSAL. Nothing the ledger has hashed is ever proposed, whatever
      // else it looks like.
      if (protectedNames.has(path.basename(f.rel))) continue;
      if (!found.has(c.category)) found.set(c.category, { ...c, files: [], bytes: 0 });
      const grp = found.get(c.category);
      grp.files.push(f);
      grp.bytes += f.size;
    }

    log('');
    log(b('  SPACE'));
    if (!found.size) {
      log(d('    Nothing disposable found. The tree is clean.'));
    }
    let reclaimable = 0;
    for (const [name, grp] of [...found].sort((a, z) => z[1].bytes - a[1].bytes)) {
      const tag = grp.safe ? g('SAFE TO DELETE') : y('REPORTED ONLY');
      log(`\n    ${b(name)}  ${grp.files.length} file(s)  ${T.humanSize(grp.bytes)}  ${tag}`);
      log(wrap(grp.why, 6));
      for (const f of grp.files.slice(0, opts.verbose ? 9999 : 5)) {
        log(d(`      ${f.rel}`));
      }
      if (!opts.verbose && grp.files.length > 5) {
        log(d(`      …and ${grp.files.length - 5} more  (--verbose for all)`));
      }
      if (grp.safe) reclaimable += grp.bytes;
    }

    log('');
    if (reclaimable > 0) {
      log(`  ${b(T.humanSize(reclaimable))} reclaimable from categories marked safe.`);
      if (opts.apply) {
        log('');
        let removed = 0;
        let freed = 0;
        for (const [, grp] of found) {
          if (!grp.safe) continue;
          for (const f of grp.files) {
            try { fs.unlinkSync(f.path); removed++; freed += f.size; }
            catch (e) { log(y(`    could not remove ${f.rel}: ${e.message}`)); }
          }
        }
        // Empty __pycache__ directories are left behind by removing their
        // contents. Sweep them, and only them.
        for (const dirent of walk(ROOT)) {
          if (!dirent.dir && /__pycache__/.test(dirent.rel)) continue;
        }
        log(`  ${g('removed')}  ${removed} file(s), ${T.humanSize(freed)} freed`);
        log(d('  Nothing in the evidence store was touched.'));
      } else {
        log(d(`  Nothing was deleted. To delete the safe categories:`));
        log(`    ${b('sentinel tidy --apply')}`);
      }
    } else {
      log(d('  Nothing is marked safe to delete.'));
    }
  }

  // ── EXPOSURE ────────────────────────────────────────────────────────
  log('');
  log(b('  EXPOSURE'));
  log(wrap('Where YOU are named, in files that are not investigation material. '
    + 'None of this is secret and all of it is identifying, which is a different '
    + 'problem and has a different fix: redact a COPY, keep the original.', 4));
  log('');
  if (!ids.length) {
    log(d('    No identifiers could be derived from this machine. Nothing to look for.'));
  } else {
    log(d(`    looking for: ${ids.map((i) => i.label).join(', ')}`));
    log(d('    (the values themselves are never printed, and are not stored in this repo)'));
    log('');
    const TEXT = /\.(js|py|md|json|txt|sh|yml|yaml|html|css|command|plist|template)$/i;
    const hits = [];
    for (const f of files) {
      if (!TEXT.test(f.rel)) continue;
      if (f.size > 2 * 1024 * 1024) continue;
      let text;
      try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
      const found = T.findIdentifiers(text, ids);
      if (found.length) hits.push({ file: f.rel, found });
    }
    // ── CONFIDENT HITS FIRST, A BARE NAME SEPARATELY ────────────────────
    //
    // A home directory, a hostname and an email cannot appear by accident. A
    // given name can: on the first live run a four-letter username matched
    // thirty files that named nobody. Mixing the two buries the real hits, and
    // a report that is mostly noise gets read once.
    const strong = hits.map((h) => ({ ...h, found: h.found.filter((f) => !f.weak) }))
      .filter((h) => h.found.length);
    const weakOnly = hits.filter((h) => h.found.every((f) => f.weak));

    if (!strong.length && !weakOnly.length) {
      log(`    ${g('Nothing outside the evidence store names you.')}`);
    } else {
      if (strong.length) {
        log(`    ${b('CONFIDENT')} ${d('— a path, a hostname or an email. These cannot be a coincidence.')}`);
        log('');
        for (const h of strong.slice(0, opts.verbose ? 9999 : 20)) {
          log(`    ${h.file}  ${d(`${h.found.length} line(s)`)}`);
          for (const f of h.found.slice(0, 2)) log(d(`        line ${f.line}  [${f.label}]`));
        }
        if (!opts.verbose && strong.length > 20) {
          log(d(`    …and ${strong.length - 20} more  (--verbose for all)`));
        }
      } else {
        log(`    ${g('No path, hostname or email names you outside the evidence store.')}`);
      }

      if (weakOnly.length) {
        log('');
        log(`    ${y('PROBABLY NOT YOU')} ${d(`— ${weakOnly.length} file(s) contain your name as a word.`)}`);
        log(wrap('A given name is also an English word, so most of these are ordinary '
          + 'prose or a variable called something else. They are listed so you can '
          + 'check, not because they are exposures.', 6));
        if (opts.verbose) {
          for (const h of weakOnly) log(d(`      ${h.file}`));
        } else {
          for (const h of weakOnly.slice(0, 6)) log(d(`      ${h.file}`));
          if (weakOnly.length > 6) log(d(`      …and ${weakOnly.length - 6} more  (--verbose for all)`));
        }
      }
      log('');
      log(wrap('These are NOT automatically changed. A home directory inside your own '
        + 'provenance ledger is doing a job, and editing files in place to hide a '
        + 'username is how a working script stops working. To hand one of these to '
        + 'somebody, write a redacted copy instead:', 4));
      log(`      ${b('sentinel tidy --redact ' + (strong[0] || hits[0]).file)}`);
    }
  }
  log('');
}

function cmdRedact(file) {
  const env = readEnv();
  const ids = T.identifiers(env);
  if (!fs.existsSync(file)) {
    console.error(`\n  ${r('no such file:')} ${file}\n`);
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const before = T.findIdentifiers(text, ids);
  const out = T.redact(text, ids);
  const ext = path.extname(file);
  const dest = `${file.slice(0, file.length - ext.length)}.redacted${ext}`;
  fs.writeFileSync(dest, out);

  // VERIFY THE OUTPUT, do not assume the replacement worked. A redacted copy
  // that still names you is worse than no copy, because it will be handed out.
  const after = T.findIdentifiers(out, ids);
  log('');
  log(b('  REDACTED COPY'));
  log(`    from  ${file}`);
  log(`    to    ${dest}`);
  log(`    ${before.length} occurrence(s) replaced`);
  if (after.length) {
    log(`\n  ${r('THE COPY STILL NAMES YOU')} — ${after.length} line(s) remain. Do not share it.`);
    process.exitCode = 1;
  } else {
    log(`\n  ${g('verified')} — the copy contains none of the identifiers.`);
    log(d('    The original is untouched.'));
  }
  log('');
}

function usage() {
  log('');
  log('  usage: sentinel tidy               what is junk, and where you are named');
  log('         sentinel tidy --apply       delete only the categories marked safe');
  log('         sentinel tidy --exposure    just the places you are named');
  log('         sentinel tidy --verbose     every file, not a sample');
  log('         sentinel tidy --redact FILE write a redacted copy beside it');
  log('');
  log('  The evidence store is never walked, and anything the provenance');
  log('  ledger has recorded is refused by name.');
  log('');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('help') || argv.includes('--help')) return usage();
  const ri = argv.indexOf('--redact');
  if (ri >= 0) {
    const f = argv[ri + 1];
    if (!f || f.startsWith('--')) {
      console.error('\n  usage: sentinel tidy --redact path/to/file.txt\n');
      process.exit(2);
    }
    return cmdRedact(f);
  }
  return cmdTidy({
    apply: argv.includes('--apply'),
    verbose: argv.includes('--verbose'),
    exposureOnly: argv.includes('--exposure'),
  });
}

if (require.main === module) main();

module.exports = { walk, ledgerPaths, readEnv };
