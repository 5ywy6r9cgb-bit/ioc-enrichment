#!/usr/bin/env node
/**
 * test_library.js — a view of the evidence, never a second copy of it.
 *
 * THREE THINGS THAT MUST HOLD
 *
 *   1. It links. A copy is stale the moment the next sweep runs, and it puts
 *      evidence on the Desktop, which is the least protected place on the
 *      machine.
 *
 *   2. A rebuild never removes anything it did not create. Clearing "whatever
 *      is in the way" works until the operator saves a draft in the folder,
 *      and then the next rebuild eats it.
 *
 *   3. The index lists what is MISSING. Listing only what exists produces a
 *      page that looks complete on a desk where half the outputs were never
 *      built, and no way to tell "there is no chart" from "there is nothing
 *      to chart".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('./library.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

console.log('\n== library: links, and an honest index ==\n');

function fixture() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lib-'));
  const ev = path.join(t, 'evidence');
  fs.mkdirSync(path.join(ev, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(ev, 'manifests'), { recursive: true });
  fs.writeFileSync(path.join(ev, 'documents', 'a.txt'), 'one');
  fs.writeFileSync(path.join(ev, 'documents', 'b.html'), 'two');
  fs.writeFileSync(path.join(ev, 'documents', 'ignored.json'), 'not a document');
  fs.writeFileSync(path.join(ev, 'manifests', 'provenance.jsonl'), '{}');
  fs.writeFileSync(path.join(ev, 'graph-dashboard.html'), '<html>');
  return { t, ev, dest: path.join(t, 'Library') };
}

// ── the plan ──────────────────────────────────────────────────────────
{
  const { t, ev } = fixture();
  const p = L.plan(ev, t);
  ok(p.length >= 4, `every section is planned (got ${p.length})`);
  ok(p.every((s) => s.name && s.why && s.items.length), 'each has a name, a reason and items');

  const all = p.flatMap((s) => s.items);
  ok(all.every((i) => i.title && i.note && i.build),
    'every item says what it is, and how to build it if absent');

  const docs = all.find((i) => i.title === 'Fetched documents');
  ok(docs.present && docs.count === 2,
    `a directory is counted by its matching files only (got ${docs.count})`);
  ok(docs.bytes === 6, `and their bytes summed (got ${docs.bytes})`);
  ok(docs.at instanceof Date, 'and the newest mtime carried');

  const ledger = all.find((i) => i.title === 'Provenance ledger');
  ok(ledger.present && ledger.count === 1, 'a single file is present with count 1');

  // MISSING IS THE POINT. An index of only what exists cannot distinguish
  // "no chart" from "nothing to chart".
  const gone = all.filter((i) => !i.present);
  ok(gone.length >= 4, `absent artifacts are still planned (got ${gone.length})`);
  ok(gone.every((i) => i.build && i.build.length > 5),
    'and each carries the command that would build it');

  fs.rmSync(t, { recursive: true, force: true });
}

// ── the build ─────────────────────────────────────────────────────────
{
  const { t, ev, dest } = fixture();
  const r = L.build({ evidence: ev, dest, home: t });

  ok(fs.existsSync(r.index), 'the index page is written');
  ok(path.basename(r.index) === 'START HERE.html',
    'and is named so it is obvious where to begin');
  ok(r.links.length === 3, `one link per built artifact (got ${r.links.length})`);

  // LINKS, NOT COPIES.
  for (const l of r.links) {
    ok(fs.lstatSync(l.link).isSymbolicLink(), `${path.basename(l.link)} is a symlink`);
    ok(fs.readlinkSync(l.link) === l.target, 'pointing at the live file');
  }
  // Following one reaches the real content, so the folder is usable.
  const doclink = r.links.find((l) => /Fetched documents$/.test(l.link));
  ok(fs.readFileSync(path.join(doclink.link, 'a.txt'), 'utf8') === 'one',
    'and reading through the link reaches the real file');

  // A section with nothing built gets no folder: an empty directory reads as a
  // statement about the investigation rather than about what was generated.
  ok(!fs.existsSync(path.join(dest, 'Images')),
    'a section with nothing built yet gets no empty folder');
  ok(fs.existsSync(path.join(dest, 'Primary documents')), 'a section with content does');

  // Rebuilding is idempotent.
  const r2 = L.build({ evidence: ev, dest, home: t });
  ok(r2.links.length === 3, 'a rebuild produces the same links, not duplicates');
  ok(r2.kept.length === 0, 'and leaves nothing behind');

  // ── THE SAFETY RULE ─────────────────────────────────────────────────
  const inTheWay = path.join(dest, 'Primary documents', 'Fetched documents');
  fs.unlinkSync(inTheWay);
  fs.writeFileSync(inTheWay, 'a draft the operator saved here');
  const r3 = L.build({ evidence: ev, dest, home: t });
  ok(r3.kept.length === 1, 'a real file in the way is reported, not removed');
  ok(fs.readFileSync(inTheWay, 'utf8') === 'a draft the operator saved here',
    'AND IT SURVIVES THE REBUILD — the folder never eats what you put in it');
  ok(r3.links.length === 2, 'the other links are still made');

  fs.rmSync(t, { recursive: true, force: true });
}

// ── the index page ────────────────────────────────────────────────────
{
  const { t, ev, dest } = fixture();
  const r = L.build({ evidence: ev, dest, home: t });
  const html = fs.readFileSync(r.index, 'utf8');

  // SELF-CONTAINED BY RULE. A front door that phones out tells somebody when
  // the operator opened it, and stops working on a machine with no network.
  ok(!/<script/i.test(html), 'no script tag');
  ok(!/\ssrc=/i.test(html), 'nothing is fetched by src');
  ok(!/@import|href=["']https?:/i.test(html), 'no external stylesheet or font host');
  ok(!/<link/i.test(html), 'no link element at all');

  ok(/Sentinel Library/.test(html), 'it is titled');
  ok(/Fetched documents/.test(html), 'built artifacts are listed');
  ok(/NOT BUILT YET/.test(html), 'and so are the ones that are not');
  // The fixture BUILDS graph-dashboard.html, so its command must not appear.
  // Check one that is genuinely absent, or this asserts nothing.
  ok(/connect lobby --chart/.test(html),
    'a missing artifact prints the command that builds it');
  ok(/assets ingest/.test(html), 'and so does another');
  ok(!/connect graph --dashboard/.test(html),
    'while a BUILT artifact does not print a build command at all');
  ok(/built/.test(html) && /not built yet/.test(html), 'the tally names both');

  ok(/prefers-color-scheme/.test(html), 'it is readable in either theme');
  ok(/file:\/\//.test(html), 'entries link to the real files');

  // Raw captures are deliberately absent: they are inputs, and thousands of
  // them in a folder is the same haystack with a nicer name.
  ok(!/live_capture_/.test(html), 'raw captures are not listed');
  ok(/inputs/.test(html), 'and the page says why');

  fs.rmSync(t, { recursive: true, force: true });
}

// ── nothing to show ───────────────────────────────────────────────────
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lib-empty-'));
  const r = L.build({ evidence: path.join(t, 'evidence'), dest: path.join(t, 'Library'), home: t });
  ok(fs.existsSync(r.index), 'a brand-new desk still gets an index');
  ok(r.links.length === 0, 'with no links');
  const html = fs.readFileSync(r.index, 'utf8');
  ok(/NOT BUILT YET/.test(html), 'and the page is entirely a to-do list');
  ok(/0<\/b> built/.test(html), 'which it states plainly');
  fs.rmSync(t, { recursive: true, force: true });
}

// ── escaping ──────────────────────────────────────────────────────────
{
  const h = L.renderIndex([{
    name: 'S', why: 'w',
    items: [{ title: '<script>evil</script>', note: 'n', build: 'b', present: false, target: '/t' }],
  }]);
  ok(!/<script>evil/.test(h), 'a filename cannot inject markup into the page');
  ok(/&lt;script&gt;evil/.test(h), 'it is escaped instead');
}

// ── sizes ─────────────────────────────────────────────────────────────
ok(L.human(900) === '900 B', 'bytes');
ok(L.human(2048) === '2 KB', 'kilobytes');
ok(/MB$/.test(L.human(3 * 1024 * 1024)), 'megabytes');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
