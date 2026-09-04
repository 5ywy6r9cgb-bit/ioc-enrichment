#!/usr/bin/env node
'use strict';
/**
 * mail/cli.js — `sentinel mail scan DIR` and `sentinel mail read FILE`
 *
 * A records request for project email comes back as thousands of .msg files
 * in a folder. Opening them one at a time in Outlook is not an investigation,
 * it is data entry, and the thing you most need — who was told what, when —
 * is the one thing a folder listing cannot show you.
 *
 * `scan` reads the folder in place. It does not copy the mail anywhere, does
 * not upload it, and makes no network call of any kind. It hashes every file
 * as it arrives, exactly as `doc get` does, so a message can be cited later
 * and shown to be the same bytes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./msg.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

/** Every .msg under a root, however deep the export nested them. */
function walk(root, out = [], depth = 0) {
  if (depth > 12) return out;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const d of names) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) walk(p, out, depth + 1);
    else if (/\.msg$/i.test(d.name)) out.push(p);
  }
  return out;
}

/** Addresses out of a header field, lowercased so one person is one person. */
function addresses(field) {
  if (!field) return [];
  const out = [];
  for (const m of String(field).matchAll(/<([^>@\s]+@[^>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g)) {
    const a = (m[1] || m[2] || '').toLowerCase().replace(/[.,;]+$/, '');
    if (a.includes('@')) out.push(a);
  }
  return [...new Set(out)];
}

function domainOf(addr) {
  const i = addr.lastIndexOf('@');
  return i < 0 ? '' : addr.slice(i + 1);
}

/** Thread key: the subject with every Re:/Fwd: and whitespace run removed. */
function threadKey(subject) {
  return String(subject || '')
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cmdScan(dir, opts = {}) {
  if (!dir) { console.error('\n  usage: sentinel mail scan DIR [--out FILE]\n'); process.exit(2); }
  if (!fs.existsSync(dir)) { console.error(`\n  ${C.r('no such folder:')} ${dir}\n`); process.exit(1); }

  const files = walk(path.resolve(dir));
  console.log('\n' + C.b('Scan a folder of Outlook messages'));
  console.log(C.dim(`  ${path.resolve(dir)}`));
  console.log(C.dim(`  ${files.length} .msg file(s) — read in place, nothing copied, no network call\n`));

  const rows = [];
  const failed = [];
  const people = new Map();     // address -> { seen, name, sent, received }
  const domains = new Map();
  const threads = new Map();

  for (const f of files) {
    let r;
    try { r = M.read(f); }
    catch (e) { failed.push({ file: f, error: e.message }); continue; }

    const bytes = fs.readFileSync(f);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const from = addresses(r.from);
    const to = addresses(r.to);
    const cc = addresses(r.cc);

    for (const a of from) {
      const p = people.get(a) || { address: a, sent: 0, received: 0 };
      p.sent++; people.set(a, p);
    }
    for (const a of [...to, ...cc]) {
      const p = people.get(a) || { address: a, sent: 0, received: 0 };
      p.received++; people.set(a, p);
    }
    for (const a of [...from, ...to, ...cc]) {
      const d = domainOf(a);
      if (d) domains.set(d, (domains.get(d) || 0) + 1);
    }

    const key = threadKey(r.subject);
    const t = threads.get(key) || { subject: r.subject, count: 0, dates: [] };
    t.count++; if (r.date) t.dates.push(r.date);
    threads.set(key, t);

    rows.push({
      file: path.relative(process.cwd(), f),
      sha256,
      bytes: bytes.length,
      subject: r.subject,
      thread: key,
      date: r.date,
      from, to, cc,
      // hops 0 means no transport headers survived — a SENT-items copy from
      // someone's own mailbox rather than a received one. Which mailbox was
      // produced is a fact about the records request, and it is invisible
      // unless something looks.
      hops: r.hops,
      sent_copy: r.hops === 0,
      attachments: r.attachments,
      body_chars: (r.body || '').length,
    });
  }

  const out = opts.out || path.join('evidence', 'mail_index.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    scanned: path.resolve(dir),
    generated: new Date().toISOString(),
    files: files.length,
    read: rows.length,
    failed,
    messages: rows,
  }, null, 2), { mode: 0o600 });

  const sentCopies = rows.filter((r) => r.sent_copy).length;
  const withAttach = rows.filter((r) => r.attachments.length).length;

  console.log(`  ${C.g('read')}       ${rows.length}`);
  if (failed.length) console.log(`  ${C.y('unreadable')} ${failed.length}  ${C.dim('(listed in the index)')}`);
  console.log(`  ${C.dim('threads')}    ${threads.size}`);
  console.log(`  ${C.dim('people')}     ${people.size} address(es) across ${domains.size} domain(s)`);
  console.log(`  ${C.dim('attached')}   ${withAttach} message(s) carry attachments`);
  if (sentCopies) {
    console.log(`  ${C.y('sent copies')} ${sentCopies} ${C.dim('— no transport headers; these came from a')}`);
    console.log(C.dim("               sender's own mailbox, not a recipient's."));
  }
  console.log('');

  const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(C.b('  Who is in this correspondence, by organisation'));
  for (const [d, n] of top) console.log(`    ${String(n).padStart(5)}  ${d}`);
  console.log('');

  const busiest = [...threads.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  console.log(C.b('  Longest threads'));
  for (const t of busiest) {
    console.log(`    ${String(t.count).padStart(4)}  ${t.subject.slice(0, 78)}`);
  }
  console.log('');
  console.log(`  ${C.dim('index')}      ${out}  ${C.dim('(owner-only, inside the gitignored evidence tree)')}`);
  console.log('');
  console.log(C.b('  An email is a statement by its sender.'));
  console.log(C.dim('  The strongest kind of contemporaneous record, and still a statement.'));
  console.log(C.dim('  That someone wrote "the power was cut on Tuesday" establishes that'));
  console.log(C.dim('  they said so on the date in the headers — not that it happened.\n'));
}

function cmdRead(file) {
  if (!file) { console.error('\n  usage: sentinel mail read FILE.msg\n'); process.exit(2); }
  let r;
  try { r = M.read(file); }
  catch (e) { console.error(`\n  ${C.r('could not read:')} ${e.message}\n`); process.exit(1); }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  console.log('\n' + C.b(r.subject || '(no subject)'));
  console.log(C.dim(`  ${path.basename(file)}`));
  console.log(C.dim(`  sha256  ${sha256}`));
  console.log('');
  console.log(`  ${C.dim('date')}  ${r.date || C.y('(none — sent-items copy, no transport headers)')}`);
  console.log(`  ${C.dim('from')}  ${r.from}`);
  console.log(`  ${C.dim('to')}    ${r.to}`);
  if (r.cc) console.log(`  ${C.dim('cc')}    ${r.cc}`);
  if (r.attachments.length) console.log(`  ${C.dim('files')} ${r.attachments.join(', ')}`);
  console.log('');
  console.log(r.body || C.dim('  (no plain-text body)'));
  console.log('');
}

function main() {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

  if (action === 'scan') return cmdScan(positional[1], { out: val('--out') });
  if (action === 'read') return cmdRead(positional[1]);
  console.error('\n  usage: sentinel mail scan DIR [--out FILE]\n         sentinel mail read FILE.msg\n');
  process.exit(2);
}

module.exports = { cmdScan, cmdRead, walk, addresses, threadKey, domainOf };
if (require.main === module) main();
