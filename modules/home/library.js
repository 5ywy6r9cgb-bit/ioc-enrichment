'use strict';
/**
 * library.js — one folder of links to everything the desk has produced.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY LINKS AND NOT COPIES
 *
 * A copy is stale the moment the next sweep runs, and it puts evidence on the
 * Desktop, which is the least protected place on the machine. A symlink shows
 * the live file, duplicates nothing, and can be deleted without losing
 * anything. The folder is a VIEW of the evidence store, never a second copy
 * of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AN INDEX THAT OMITS WHAT IS MISSING IS LYING BY OMISSION
 *
 * The obvious way to write this is to list the files that exist. That produces
 * a page which looks complete on a desk where half the outputs were never
 * built — the graph dashboard, the lobbying chart, the case dossier — and the
 * operator has no way to tell the difference between "there is no chart" and
 * "there is nothing to chart".
 *
 * So every artifact this desk CAN produce is listed whether or not it exists,
 * and a missing one carries the command that builds it. What the folder is
 * missing is as much of its job as what it holds.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT LINKED
 *
 * Raw captures. There are thousands, they are inputs rather than outputs, and
 * a folder of them is not a library — it is the same haystack with a nicer
 * name. The library holds what was DERIVED from them: reports, charts,
 * fetched primary documents, case files, the ledger.
 */

const fs = require('fs');
const path = require('path');

/**
 * Everything the desk can produce, by section.
 *
 * `glob` is a directory plus a filter, not a pattern language — one less thing
 * to get subtly wrong. `build` is the command that creates the artifact when
 * it is absent, and it is printed on the page.
 */
function sections(evidence, root) {
  const d = (...p) => path.join(evidence, ...p);
  return [
    {
      name: 'Reports & dossiers',
      why: 'What you would hand to somebody. Written by you, or by the desk from '
        + 'what you read.',
      items: [
        {
          title: 'Case files',
          dir: d('sentinel_cases'),
          filter: (f) => f.endsWith('.json'),
          build: 'bin/sentinel case new CASE-ID "what this case asserts"',
          note: 'Each holds exhibits, pages read, open questions and contradictions. '
            + 'A case with any of the last two is BLOCKED from publication.',
        },
        {
          title: 'Case dashboard',
          file: d('cases.html'),
          build: 'bin/sentinel dash',
          note: 'Every case on one screen, with what is blocking each one.',
        },
      ],
    },
    {
      name: 'Graphs & charts',
      why: 'Pictures. The most persuasive thing this desk makes and the least '
        + 'evidentiary — cite the filing underneath, never the picture.',
      items: [
        {
          title: 'Graph dashboard',
          file: d('graph-dashboard.html'),
          build: 'bin/sentinel connect graph --dashboard',
          note: 'Self-contained: no script, no CDN, no font host, no request of '
            + 'any kind. Safe to open offline and safe to send.',
        },
        {
          title: 'Lobbying charts',
          file: d('lobbying.html'),
          build: 'bin/sentinel connect lobby --chart',
          note: 'Read from the captured filings, not from a summary.',
        },
        {
          title: 'Records desk',
          file: d('foia.html'),
          build: 'bin/sentinel foia dash',
          note: 'Every records request, what is denied, what has gone silent.',
        },
      ],
    },
    {
      name: 'Primary documents',
      why: 'Things you fetched and hashed. THIS is what a claim cites.',
      items: [
        {
          title: 'Fetched documents',
          dir: d('documents'),
          filter: (f) => /\.(pdf|html|txt)$/i.test(f),
          build: 'bin/sentinel doc get "https://…"',
          note: 'Each arrived over a verified connection and its hash is in the '
            + 'ledger. The .txt beside a .html is the extracted text.',
        },
      ],
    },
    {
      name: 'Images',
      why: 'A photograph you took is a primary artifact. A screenshot is a '
        + 'picture OF a source and is not the source.',
      items: [
        {
          title: 'Asset store',
          dir: d('assets'),
          filter: (f) => /\.(jpe?g|png|heic|webp|gif)$/i.test(f),
          build: 'bin/sentinel assets ingest',
          note: 'Classified and tiered. Screenshots stay SOURCE_NEEDED until the '
            + 'page behind them is fetched.',
        },
        {
          title: 'Publication-safe copies',
          dir: d('assets', 'publish'),
          filter: (f) => /\.(jpe?g|png)$/i.test(f),
          build: 'bin/sentinel assets clean',
          note: 'GPS and camera metadata removed, and verified gone. PUBLISH FROM '
            + 'HERE, not from the store above.',
        },
      ],
    },
    {
      name: 'The record',
      why: 'How you can prove any of it. Read-only in practice — never edit these.',
      items: [
        {
          title: 'Provenance ledger',
          file: path.join(evidence, 'manifests', 'provenance.jsonl'),
          build: 'it is written by every fetch — run any `doc get`',
          note: 'Append-only. One line per artifact: what it is, its hash, where '
            + 'it came from, and its sourcing tier.',
        },
        {
          title: 'Registrant book sizes',
          file: d('registrant_books.json'),
          build: 'bin/sentinel connect expand --limit 40',
          note: 'How many federal filings each firm has in total. Without it, '
            + '"bridges 3 of 3 clients" is true of any firm at all.',
        },
      ],
    },
  ];
}

/** Count and newest mtime for a directory of matching files. */
function survey(item) {
  if (item.file) {
    try {
      const st = fs.statSync(item.file);
      return { present: true, count: 1, bytes: st.size, at: st.mtime, target: item.file };
    } catch { return { present: false, count: 0, bytes: 0, at: null, target: item.file }; }
  }
  let names;
  try { names = fs.readdirSync(item.dir); } catch {
    return { present: false, count: 0, bytes: 0, at: null, target: item.dir };
  }
  const files = names.filter((f) => !f.startsWith('.') && (!item.filter || item.filter(f)));
  let bytes = 0;
  let at = null;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(item.dir, f));
      bytes += st.size;
      if (!at || st.mtime > at) at = st.mtime;
    } catch { /* vanished mid-scan */ }
  }
  return { present: files.length > 0, count: files.length, bytes, at, target: item.dir };
}

/** The whole picture, before anything is written. */
function plan(evidence, root) {
  return sections(evidence, root).map((s) => ({
    ...s,
    items: s.items.map((i) => ({ ...i, ...survey(i) })),
  }));
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The index page.
 *
 * Self-contained by rule: no script, no CDN, no font host, no request of any
 * kind. A front door that phones out is a front door that tells somebody when
 * the operator opened it, and it stops working on a machine with no network.
 */
function renderIndex(built, opts = {}) {
  const when = opts.now || new Date();
  const total = built.reduce((n, s) => n + s.items.filter((i) => i.present).length, 0);
  const missing = built.reduce((n, s) => n + s.items.filter((i) => !i.present).length, 0);

  const rows = built.map((s) => {
    const items = s.items.map((i) => {
      const href = `file://${encodeURI(i.target)}`;
      if (!i.present) {
        return `<div class="item missing">
  <div class="t">${esc(i.title)}</div>
  <div class="n">${esc(i.note)}</div>
  <div class="gap">NOT BUILT YET — run this to make it:</div>
  <code>${esc(i.build)}</code>
</div>`;
      }
      const count = i.dir ? `${i.count} file${i.count === 1 ? '' : 's'} · ` : '';
      const stamp = i.at ? i.at.toISOString().slice(0, 16).replace('T', ' ') : '';
      return `<div class="item">
  <div class="t"><a href="${esc(href)}">${esc(i.title)}</a></div>
  <div class="m">${esc(count)}${esc(human(i.bytes))}${stamp ? ' · updated ' + esc(stamp) : ''}</div>
  <div class="n">${esc(i.note)}</div>
</div>`;
    }).join('\n');
    return `<section>
  <h2>${esc(s.name)}</h2>
  <p class="why">${esc(s.why)}</p>
  ${items}
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Sentinel Library</title>
<style>
  :root{--ink:#12151a;--dim:#5b6472;--line:#dfe3e8;--bg:#fbfbfc;--acc:#8a6d1f;--gap:#b03a2e}
  @media (prefers-color-scheme:dark){
    :root{--ink:#e8eaee;--dim:#98a1ad;--line:#2a2f37;--bg:#14171c;--acc:#d9b449;--gap:#e5836f}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:40px 24px 80px;background:var(--bg);color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
  .sub{color:var(--dim);font-size:13px;margin:0 0 6px}
  .tally{color:var(--dim);font-size:13px;margin:0 0 32px}
  .tally b{color:var(--ink)}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;margin:34px 0 4px;
    padding-bottom:7px;border-bottom:1px solid var(--line)}
  .why{color:var(--dim);font-size:13px;margin:0 0 14px}
  .item{padding:11px 0;border-bottom:1px solid var(--line)}
  .item:last-child{border-bottom:0}
  .t{font-weight:600}
  .t a{color:var(--acc);text-decoration:none}
  .t a:hover{text-decoration:underline}
  .m{color:var(--dim);font-size:12px;margin-top:2px}
  .n{color:var(--dim);font-size:13px;margin-top:4px}
  .missing .t{color:var(--dim)}
  .gap{color:var(--gap);font-size:12px;font-weight:600;margin-top:6px}
  code{display:inline-block;margin-top:5px;padding:5px 9px;border:1px solid var(--line);
    border-radius:5px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--ink);background:transparent;user-select:all}
  footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);
    color:var(--dim);font-size:12px}
</style></head><body><div class="wrap">
<h1>Sentinel Library</h1>
<p class="sub">Links to the live files. Nothing here is a copy, so nothing here goes stale.</p>
<p class="tally"><b>${total}</b> built · <b>${missing}</b> not built yet · rebuilt ${esc(when.toISOString().slice(0, 16).replace('T', ' '))}</p>
${rows}
<footer>
Every entry links to the real file in the evidence store. Deleting anything in
this folder deletes a link, never the evidence.<br>
Raw captures are deliberately not listed: they are inputs, and a folder of
thousands of them is the same haystack with a nicer name.<br>
Rebuild this page with <code>bin/sentinel library</code>.
</footer>
</div></body></html>`;
}


/**
 * Build the folder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SAFETY RULE: NEVER REMOVE ANYTHING THAT IS NOT A SYMLINK
 *
 * A rebuild has to clear the previous run's links or they accumulate and go
 * stale. The obvious implementation removes whatever is in the way — and then
 * the first time the operator drags a real file into the folder, or saves a
 * draft there because it is a convenient place, the next rebuild deletes it.
 *
 * So: lstat first, and if the thing in the way is not a symlink, leave it
 * alone and report it. A folder that quietly eats files put into it is worse
 * than one that is occasionally untidy.
 */
function build(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..');
  const evidence = opts.evidence
    || process.env.SENTINEL_EVIDENCE_DIR || path.join(root, 'evidence');
  const home = opts.home || process.env.HOME || '';
  const dest = opts.dest || path.join(home, 'Desktop', 'Sentinel Library');

  const built = plan(evidence, root);
  fs.mkdirSync(dest, { recursive: true });

  const links = [];
  const kept = [];
  for (const s of built) {
    // A section with nothing built yet gets no folder. An empty directory on
    // the Desktop reads as "there is nothing here", which is a claim about the
    // investigation rather than about what has been generated.
    if (!s.items.some((i) => i.present)) continue;
    const sdir = path.join(dest, s.name);
    fs.mkdirSync(sdir, { recursive: true });
    for (const i of s.items) {
      if (!i.present) continue;
      const link = path.join(sdir, i.title);
      let existing = null;
      try { existing = fs.lstatSync(link); } catch { /* nothing there */ }
      if (existing && !existing.isSymbolicLink()) {
        // Something real is in the way. It is not ours to remove.
        kept.push(link);
        continue;
      }
      if (existing) fs.unlinkSync(link);
      try {
        fs.symlinkSync(i.target, link);
        links.push({ link, target: i.target });
      } catch (e) {
        kept.push(`${link}  (${e.code || e.message})`);
      }
    }
  }

  const index = path.join(dest, 'START HERE.html');
  fs.writeFileSync(index, renderIndex(built, { now: opts.now }));

  return { dest, index, links, kept, built, evidence, root };
}

module.exports = { sections, survey, plan, renderIndex, human, build };

if (require.main === module) {
  const C = {
    b: (s2) => `${String.fromCharCode(27)}[1m${s2}${String.fromCharCode(27)}[0m`,
    d: (s2) => `${String.fromCharCode(27)}[2m${s2}${String.fromCharCode(27)}[0m`,
    g: (s2) => `${String.fromCharCode(27)}[32m${s2}${String.fromCharCode(27)}[0m`,
    y: (s2) => `${String.fromCharCode(27)}[33m${s2}${String.fromCharCode(27)}[0m`,
  };
  const r = build({});
  const total = r.built.reduce((n, s2) => n + s2.items.filter((i) => i.present).length, 0);
  const gaps = [];
  for (const s2 of r.built) for (const i of s2.items) if (!i.present) gaps.push(i);

  console.log('');
  console.log(`  ${C.b('SENTINEL LIBRARY')}`);
  console.log(`  ${r.dest}`);
  console.log('');
  console.log(`  ${C.g(String(r.links.length))} link(s) to live files, in ${
    new Set(r.links.map((l) => path.dirname(l.link))).size} folder(s)`);
  console.log(`  ${C.b('index')}  ${r.index}`);
  console.log(C.d('  Links, not copies — nothing here goes stale, and deleting anything'));
  console.log(C.d('  in that folder deletes a link, never the evidence.'));

  if (r.kept.length) {
    console.log('');
    console.log(`  ${C.y(String(r.kept.length) + ' item(s) left alone')} — something real is in the way:`);
    for (const k of r.kept) console.log(C.d(`    ${k}`));
    console.log(C.d('  A rebuild never removes anything that is not a link it made.'));
  }

  if (gaps.length) {
    console.log('');
    console.log(`  ${C.y(String(gaps.length) + ' artifact(s) not built yet')} ${
      C.d('— listed on the page too, with these commands:')}`);
    for (const i of gaps) console.log(`    ${C.d(i.title.padEnd(26))} ${i.build}`);
  }

  console.log('');
  console.log(`  ${C.b('open')} "${r.index}"`);
  console.log('');
}
