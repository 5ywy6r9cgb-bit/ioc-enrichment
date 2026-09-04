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

/**
 * A macOS sidecar, not a message.
 *
 * Copy files to a FAT32 or exFAT stick and macOS writes an AppleDouble
 * companion for every one of them: `._Whatever.msg`, holding the resource
 * fork and extended attributes. It carries the .msg extension and no message.
 *
 * Counting those as unreadable messages is not a cosmetic bug. It reports a
 * folder of 194 messages as 388 files with a 50% failure rate — so the
 * operator believes half the production would not open, when in truth every
 * message read fine. On evidence, a false gap is worse than a real one:
 * you go hunting for records that were never missing, or you decide the
 * production was incomplete when it was not.
 */
function isSidecar(name) {
  return name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db';
}

/** Every .msg under a root, however deep the export nested them. */
function walk(root, out = [], depth = 0, sidecars = []) {
  if (depth > 12) return out;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const d of names) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) walk(p, out, depth + 1, sidecars);
    else if (isSidecar(d.name)) sidecars.push(p);
    else if (/\.msg$/i.test(d.name)) out.push(p);
  }
  out.sidecars = sidecars;
  return out;
}

/** Addresses out of a header field, lowercased so one person is one person. */
function addresses(field) {
  if (!field) return [];
  const out = [];
  for (const m of String(field).matchAll(/<([^>@\s]+@[^>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g)) {
    // Strip the punctuation an address collects from the header around it.
    // `'Nathan Dickman' <n@dlz.com>` and `(n@dlz.com)` both leave a trailing
    // mark attached, and epa.ohio.gov, epa.ohio.gov' and epa.ohio.gov) then
    // report as three organisations instead of one — which quietly splits
    // every count that matters.
    const a = (m[1] || m[2] || '').toLowerCase()
      .replace(/^[\s'"(<[]+/, '')
      .replace(/[\s'"),.;:>\]]+$/, '');
    if (a.includes('@') && /^[^@]+@[^@]+\.[a-z]{2,}$/i.test(a)) out.push(a);
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
  const sidecars = files.sidecars || [];
  console.log('\n' + C.b('Scan a folder of Outlook messages'));
  console.log(C.dim(`  ${path.resolve(dir)}`));
  console.log(C.dim(`  ${files.length} .msg file(s) — read in place, nothing copied, no network call`));
  if (sidecars.length) {
    console.log(C.dim(`  ${sidecars.length} macOS sidecar file(s) skipped `
      + `(._ AppleDouble / .DS_Store) — not messages`));
  }
  console.log('');

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
      file: f,                              // absolute: the source is often an external drive
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
    sidecars_skipped: sidecars.length,
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

/** The index written by the last scan. */
function loadIndex(file) {
  const p = file || path.join('evidence', 'mail_index.json');
  if (!fs.existsSync(p)) {
    console.error(`\n  ${C.r('no index at')} ${p}`);
    console.error(C.dim('  Run a scan first:  bin/sentinel mail scan DIR\n'));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Sort by the date the mail systems recorded, oldest first.
 *
 * A message with no parseable date sorts LAST rather than to the epoch. Those
 * are the sent-items copies with no transport headers, and dropping them at
 * the top of a timeline would put the reply above the thing it replied to.
 */
function byDate(a, b) {
  const ta = Date.parse(a.date || '');
  const tb = Date.parse(b.date || '');
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

function shortAddr(list) {
  if (!list || !list.length) return '';
  return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3}`;
}

/** `mail find TERM` — which messages mention this, by subject or by person. */
function cmdFind(term, opts = {}) {
  if (!term) { console.error('\n  usage: sentinel mail find TERM\n'); process.exit(2); }
  const idx = loadIndex(opts.index);
  const q = term.toLowerCase();
  const hits = idx.messages.filter((m) => (m.subject || '').toLowerCase().includes(q)
    || [...(m.from || []), ...(m.to || []), ...(m.cc || [])].some((a) => a.includes(q)));

  console.log('\n' + C.b(`Messages matching "${term}"`));
  console.log(C.dim(`  ${hits.length} of ${idx.messages.length}\n`));
  for (const m of hits.sort(byDate)) {
    console.log(`  ${C.dim((m.date || '(no date)').slice(0, 25).padEnd(25))} ${m.subject.slice(0, 72)}`);
    console.log(C.dim(`    ${shortAddr(m.from)} → ${shortAddr(m.to)}`));
  }
  console.log('');
  if (hits.length) {
    console.log(C.dim('  Read the whole exchange:  bin/sentinel mail thread "<part of the subject>"\n'));
  }
}

/**
 * `mail thread SUBJECT` — one exchange, in the order it happened.
 *
 * Reply prefixes are folded away, so `Re:`, `RE:` and `FW:` of the same
 * subject are one thread rather than three. This is the view a folder cannot
 * give you: who said what, in sequence, and who was added or dropped from the
 * copy list along the way.
 */
function cmdThread(fragment, opts = {}) {
  if (!fragment) { console.error('\n  usage: sentinel mail thread SUBJECT [--body]\n'); process.exit(2); }
  const idx = loadIndex(opts.index);
  const q = threadKey(fragment);
  let hits = idx.messages.filter((m) => (m.thread || '').includes(q));
  if (!hits.length) {
    hits = idx.messages.filter((m) => (m.subject || '').toLowerCase().includes(fragment.toLowerCase()));
  }
  if (!hits.length) {
    console.error(`\n  ${C.y('Nothing matches')} "${fragment}"`);
    console.error(C.dim('  List what is there:  bin/sentinel mail find LOT\n'));
    process.exit(1);
  }

  hits.sort(byDate);
  console.log('\n' + C.b(hits[0].subject));
  console.log(C.dim(`  ${hits.length} message(s)\n`));

  // Who joins or leaves the copy list is often the finding. A name added the
  // day a problem escalates, or dropped the day it is settled, is a fact the
  // bodies rarely state outright.
  let previous = null;
  for (const m of hits) {
    const people = [...new Set([...(m.to || []), ...(m.cc || [])])].sort();
    console.log(`  ${C.b((m.date || '(no date — sent-items copy)'))}`);
    console.log(`    ${C.dim('from')}  ${shortAddr(m.from)}`);
    console.log(`    ${C.dim('to')}    ${shortAddr(m.to)}`);
    if (m.cc && m.cc.length) console.log(`    ${C.dim('cc')}    ${shortAddr(m.cc)}`);
    if (previous) {
      const added = people.filter((a) => !previous.includes(a));
      const gone = previous.filter((a) => !people.includes(a));
      if (added.length) console.log(`    ${C.g('+ added')} ${added.join(', ')}`);
      if (gone.length) console.log(`    ${C.y('- dropped')} ${gone.join(', ')}`);
    }
    previous = people;
    if (m.attachments && m.attachments.length) {
      console.log(`    ${C.dim('files')} ${m.attachments.join(', ')}`);
    }
    if (opts.body) {
      let body = '';
      try { body = M.read(m.file).body || ''; } catch { body = '(could not re-read this file)'; }
      // Only the new text: everything from the first quoted header down is
      // the previous message repeated, and printing it turns a ten-message
      // thread into the same paragraph ten times.
      const cut = body.search(/\n\s*(From|On .{0,60}wrote):/);
      const fresh = (cut > 0 ? body.slice(0, cut) : body).trim();
      console.log('');
      for (const line of fresh.split(/\n/).slice(0, 40)) console.log(`      ${line}`);
    }
    console.log(`    ${C.dim(m.file)}`);
    console.log('');
  }
  console.log(C.dim('  Full text of any one:  bin/sentinel mail read "<path above>"\n'));
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

/**
 * An inline signature graphic, not a record.
 *
 * A corporate signature block carries image001.gif on every message. Across
 * 194 messages that is hundreds of files, and they bury the four or five
 * attachments that are actually documents. Skipped by default, never by
 * force — `--all` takes everything, because "probably a logo" is a guess and
 * the operator is entitled to overrule it.
 */
function looksInline(a) {
  return /^image\d{3}\.(png|gif|jpe?g)$/i.test(a.name) && a.bytes < 200 * 1024;
}

/**
 * `mail attachments` — get the documents out of the messages.
 *
 * The body is the covering note; the attachment is the record. A message
 * whose entire text is "FYI" can carry the one document that explains a
 * project. Reading the filename and reasoning from it is the error this desk
 * exists to prevent — a filename is a claim about a document, not the
 * document.
 */
function cmdAttachments(opts = {}) {
  const idx = loadIndex(opts.index);
  const outDir = path.resolve(opts.out || path.join('evidence', 'mail_attachments'));

  const carrying = idx.messages.filter((m) => (m.attachments || []).length);
  console.log('\n' + C.b('Extract attachments'));
  console.log(C.dim(`  ${carrying.length} message(s) carry files → ${outDir}\n`));

  let wrote = 0, skipped = 0, failed = 0;
  const seen = new Map();               // sha256 -> first name, for dedupe

  for (const m of carrying.sort(byDate)) {
    let got;
    try { got = M.extractAttachments(m.file, null, { listOnly: true }); }
    catch { failed++; continue; }

    const keep = opts.all ? got : got.filter((a) => !looksInline(a));
    skipped += got.length - keep.length;
    if (!keep.length) continue;

    let printedHeader = false;
    for (const a of keep) {
      // The same PDF forwarded to three custodians is one document. Writing
      // it three times inflates the corpus and makes a single record look
      // like a pattern of records.
      if (seen.has(a.sha256)) continue;
      seen.set(a.sha256, a.name);
      try {
        // Write ONLY this one. Extracting the whole message and filtering
        // afterwards filters the REPORT, not the disk -- every duplicate is
        // already written by the time the filter runs, which is how a
        // deduplicated run still produced 120 files while reporting 92.
        const [rec] = M.extractAttachments(m.file, outDir, { only: new Set([a.sha256]) })
          .filter((x) => x.file);
        if (!rec) continue;
        if (!printedHeader) {
          console.log(`  ${C.dim((m.date || '(no date)').slice(0, 25))}  ${m.subject.slice(0, 60)}`);
          printedHeader = true;
        }
        console.log(`    ${C.g(a.name)}  ${C.dim(`${Math.round(a.bytes / 1024)}KB  ${a.sha256.slice(0, 16)}`)}`);
        wrote++;
      } catch { failed++; }
    }
    if (printedHeader) console.log('');
  }

  console.log(`  ${C.g('wrote')}     ${wrote} file(s), named by the hash of their own bytes`);
  if (skipped) console.log(`  ${C.dim('skipped')}   ${skipped} inline signature image(s) — use --all to keep them`);
  if (failed) console.log(`  ${C.y('failed')}    ${failed}`);
  console.log('');
  console.log(C.dim('  Next: inventory them like any other records folder —'));
  console.log(C.dim(`    bin/sentinel corpus inventory "${outDir}" --out evidence/mail_docs \\`));
  console.log(C.dim('      --save-text evidence/mail_docs/text\n'));
}

function main() {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

  if (action === 'scan') return cmdScan(positional[1], { out: val('--out') });
  if (action === 'read') return cmdRead(positional[1]);
  if (action === 'find') return cmdFind(positional.slice(1).join(' '), { index: val('--index') });
  if (action === 'attachments') {
    return cmdAttachments({ index: val('--index'), out: val('--out'), all: argv.includes('--all') });
  }
  if (action === 'thread') {
    return cmdThread(positional.slice(1).join(' '),
      { index: val('--index'), body: argv.includes('--body') });
  }
  console.error('\n  usage: sentinel mail scan DIR [--out FILE]'
    + '\n         sentinel mail find TERM'
    + '\n         sentinel mail thread SUBJECT [--body]'
    + '\n         sentinel mail attachments [--out DIR] [--all]'
    + '\n         sentinel mail read FILE.msg\n');
  process.exit(2);
}

module.exports = { cmdScan, cmdRead, cmdFind, cmdThread, cmdAttachments, walk,
  addresses, threadKey, domainOf, isSidecar, byDate, loadIndex, looksInline };
if (require.main === module) main();
