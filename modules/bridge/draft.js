#!/usr/bin/env node
'use strict';
/**
 * draft.js — turn captures into properly-formed open questions on the desk.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP
 * ─────────────────────────────────────────────────────────────────────────
 * Hundreds of captures sit in evidence/captures/ and every claim on the desk
 * is typed by hand. So the collecting and the reasoning never meet: the
 * library grows, the case file stays empty, and the step between them —
 * "read this, decide what it means" — is the one that never happens.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THING THIS MUST NOT DO
 * ─────────────────────────────────────────────────────────────────────────
 * A capture is a SEARCH RESULT. It is a row of metadata an API returned:
 * a case name, a filing period, a URL. It is not the document, nobody has
 * read it, and its presence in the library means only that a keyword matched.
 *
 * The tempting version of this tool writes GREEN claims with the capture's
 * URL as the citation. That would launder a search hit into a cited fact at
 * a rate of several hundred per run, and every one would look exactly like a
 * claim someone had actually checked.
 *
 * So this writes RED and only RED — open questions — and the gate on each one
 * names the document that would close it and the command that fetches it.
 * Promotion out of RED requires fetching the document, ingesting it, and
 * citing it, which is three deliberate acts by a person.
 *
 * The desk's own schema agrees: `citations` takes a doc_id into `documents`.
 * There is no way to cite a URL, by design.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT SHELLS OUT INSTEAD OF WRITING SQL
 * ─────────────────────────────────────────────────────────────────────────
 * Every write goes through `sentinel claim add`, which records into the audit
 * hash chain. Writing to sentinel.db directly would be faster and would leave
 * several hundred claims in the desk with no audit entry -- a chain that
 * still verifies as intact while no longer describing what happened.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('../connectors/registry.js');
const X = require('../connectors/crosslink.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DESK = path.join(ROOT, 'modules', 'sentinel-desk');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

/**
 * The noun phrase for one capture row, per connector.
 *
 * Kept mechanical on purpose. Anything cleverer would be this tool inventing
 * a characterisation of a document nobody has opened.
 */
function describe(connector, row) {
  const name = String(row.name || '').trim();
  switch (connector) {
    case 'courtlistener': {
      const bits = [row.court, row.date].filter(Boolean).join(', ');
      return bits ? `${name} (${bits})` : name;
    }
    case 'federalregister': {
      const bits = [row.agencies, row.date].filter(Boolean).join(', ');
      return bits ? `the notice "${name}" (${bits})` : `the notice "${name}"`;
    }
    case 'fec': {
      const bits = [row.party, row.office, row.state].filter(Boolean).join(' · ');
      return bits ? `${name} (${bits})` : name;
    }
    case 'senatelda': {
      const client = row.client || row.client_name;
      return client && client !== name
        ? `${name}'s lobbying filing for ${client}`
        : `${name}'s lobbying filing`;
    }
    default:
      return name;
  }
}

/**
 * A capture row becomes exactly one open question.
 *
 * Deterministic: the same row produces the same text every run. That is what
 * makes re-running safe -- duplicates are detected by exact text match, with
 * no extra state to keep in sync and no schema change to the desk.
 */
function toClaim(connector, subject, row) {
  const label = (R.CONNECTORS[connector] && R.CONNECTORS[connector].label) || connector;
  const what = describe(connector, row);
  if (!what) return null;

  const text = `Does ${what} establish anything about ${subject}?`;
  const url = row.url || '';
  const gate = url
    ? `The ${label} record itself, fetched and read — bin/sentinel doc get ${url}`
    : `The ${label} record itself (${row.external_id || 'no id'}), fetched and read`;

  return { text, gate, connector, subject, url, id: row.external_id || '' };
}

// ── reading the desk ──────────────────────────────────────────────────────
function deskEnv() {
  return Object.assign({}, process.env);
}

function existingClaimTexts(slug) {
  // Read-only, and through sqlite rather than the CLI because the CLI has no
  // machine-readable list. A desk that cannot be read is an error, never an
  // empty list -- "no claims yet" and "I could not look" must not be the same
  // answer, or every run would re-draft everything.
  const py = `
import json, os, sqlite3, sys
from pathlib import Path
root = Path(os.environ.get("SENTINEL_ROOT", Path.home() / "SentinelDesk"))
db = root / "sentinel.db"
if not db.is_file():
    print(json.dumps({"error": f"no desk at {root} — run: bin/sentinel sdesk init"}))
    sys.exit(0)
try:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = c.execute("select id from cases where slug = ?", (sys.argv[1],)).fetchone()
    if not row:
        print(json.dumps({"error": "nocase"}))
        sys.exit(0)
    texts = [r[0] for r in c.execute(
        "select text from claims where case_id = ?", (row[0],))]
    print(json.dumps({"texts": texts}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
  const out = execFileSync('python3', ['-c', py, slug],
    { encoding: 'utf8', env: deskEnv(), cwd: DESK });
  return JSON.parse(out);
}

function addClaim(slug, claim) {
  // --origin machine is not decoration. A drafted claim and a typed one are
  // indistinguishable in the ledger about a week later, and the ledger
  // outlives anyone's memory of which was which. The desk refuses to publish
  // a machine-origin claim until a person has disposed of it, and that
  // refusal only works if this flag is here.
  execFileSync('python3',
    ['-m', 'sentinel', 'claim', 'add', slug, claim.text, '--tier', 'RED',
      '--gate', claim.gate,
      '--origin', 'machine',
      '--origin-note', `sentinel draft: ${claim.connector} capture`
        + (claim.id ? ` ${claim.id}` : '')],
    { encoding: 'utf8', env: deskEnv(), cwd: DESK, stdio: 'pipe' });
}

// ── commands ──────────────────────────────────────────────────────────────
function gather(opts) {
  const caps = X.readCaptures(path.join(R.EVIDENCE, 'captures'));
  const out = [];
  let unparsed = 0;
  for (const cap of caps) {
    if (cap.unparsed) { unparsed++; continue; }
    if (opts.connector && cap.connector !== opts.connector) continue;
    const subjects = opts.subjects && opts.subjects.length ? opts.subjects
      : (opts.subject ? [opts.subject] : []);
    if (subjects.length) {
      const hay = cap.subject.toLowerCase();
      if (!subjects.some((s) => hay.includes(String(s).toLowerCase()))) continue;
    }
    for (const row of cap.results) {
      const c = toClaim(cap.connector, cap.subject, row);
      if (c) out.push(c);
    }
  }
  // One record can be returned by several searches. The same question twice is
  // still one question.
  const seen = new Set();
  const unique = out.filter((c) => {
    if (seen.has(c.text)) return false;
    seen.add(c.text);
    return true;
  });
  return { claims: unique, unparsed, captures: caps.length, raw: out.length };
}

function cmdList() {
  const caps = X.readCaptures(path.join(R.EVIDENCE, 'captures'));
  if (!caps.length) {
    console.log(`\n  No captures in ${path.join(R.EVIDENCE, 'captures')}`);
    console.log(C.d('  Run a search first:  bin/sentinel connect all "Aligned Data Centers"\n'));
    return;
  }
  const bySubject = new Map();
  let unparsed = 0;
  for (const c of caps) {
    if (c.unparsed) { unparsed++; continue; }
    const k = c.subject;
    if (!bySubject.has(k)) bySubject.set(k, { rows: 0, connectors: new Set(), truncated: false });
    const e = bySubject.get(k);
    e.rows += c.results.length;
    e.connectors.add(c.connector);
    if (c.truncated) e.truncated = true;
  }
  console.log(`\n  ${C.b('Captures available to draft from')}`);
  console.log(C.d(`  ${caps.length} capture file(s)\n`));
  const rows = [...bySubject.entries()].sort((a, b) => b[1].rows - a[1].rows);
  for (const [subject, e] of rows) {
    console.log(`  ${String(e.rows).padStart(5)}  ${subject}`
      + C.d(`  · ${[...e.connectors].sort().join(', ')}`)
      + (e.truncated ? C.y('  · TRUNCATED') : ''));
  }
  if (unparsed) {
    console.log(C.y(`\n  ${unparsed} capture(s) would not parse — they are on disk and hashed,`));
    console.log(C.y('  but nothing can be drafted from them.'));
  }
  console.log(C.d('\n  Draft from one, e.g.:'));
  console.log(C.d('    bin/sentinel draft datacenters --subject "Aligned Data Centers"'));
  console.log(C.d('  --subject may be repeated; one entity is often several spellings.\n'));
}

function cmdDraft(slug, opts) {
  const desk = existingClaimTexts(slug);
  if (desk.error === 'nocase') {
    console.error(`\n  No case "${slug}" on the desk.`);
    console.error(C.d(`  Create it:  bin/sentinel sdesk case new ${slug} "A title"\n`));
    process.exit(2);
  }
  if (desk.error) {
    console.error(`\n  ${C.r('Cannot read the desk:')} ${desk.error}\n`);
    process.exit(2);
  }

  const { claims, unparsed, captures, raw } = gather(opts);
  const already = new Set(desk.texts);
  const fresh = claims.filter((c) => !already.has(c.text));
  const dupes = claims.length - fresh.length;
  const limited = opts.limit ? fresh.slice(0, opts.limit) : fresh;

  console.log(`\n  ${C.b(`Draft into case "${slug}"`)}`);
  console.log(C.d(`  ${captures} capture file(s) → ${raw} row(s) → ${claims.length} distinct question(s)`));
  if (dupes) console.log(C.d(`  ${dupes} already on the desk, skipped`));
  if (unparsed) console.log(C.y(`  ${unparsed} capture(s) unparseable — nothing drafted from those`));
  if (opts.limit && fresh.length > opts.limit) {
    console.log(C.d(`  showing ${opts.limit} of ${fresh.length} (--limit)`));
  }

  if (!limited.length) {
    console.log(C.g('\n  Nothing new to draft.\n'));
    return;
  }

  console.log('');
  for (const c of limited.slice(0, opts.apply ? 5 : 25)) {
    console.log(`  ${C.y('RED')}  ${c.text}`);
    console.log(C.d(`       gate: ${c.gate}`));
  }
  if (!opts.apply && limited.length > 25) {
    console.log(C.d(`  … and ${limited.length - 25} more`));
  }

  console.log(`\n  ${C.b('Every one of these is RED — an open question.')}`);
  console.log(C.d('  A capture is a search result, not a document. Nobody has read these.'));
  console.log(C.d('  To promote one: fetch it (doc get), ingest it, then cite it.'));
  console.log(C.d('  Each is recorded as machine-drafted and CANNOT be published until'));
  console.log(C.d('  you have disposed of it:  bin/sentinel sdesk claim dispose 12 --by "your name"'));

  if (!opts.apply) {
    console.log(`\n  ${C.d('Nothing was written.')} Add ${C.b('--apply')} to record `
      + `${limited.length} claim(s).\n`);
    return;
  }

  console.log('');
  let ok = 0;
  const failed = [];
  for (const c of limited) {
    try { addClaim(slug, c); ok++; }
    catch (e) {
      failed.push({ c, why: (e.stderr || e.message || '').toString().trim().slice(0, 160) });
    }
    if (ok % 25 === 0 && ok) process.stderr.write(`\r  recorded ${ok}/${limited.length} ...`);
  }
  process.stderr.write('\r');
  console.log(`  ${C.g('recorded')} ${ok} claim(s) into ${slug}`);
  if (failed.length) {
    // A claim the desk refused is reported, never counted as written.
    console.log(`  ${C.r('refused')}  ${failed.length}:`);
    for (const f of failed.slice(0, 5)) console.log(C.d(`    ${f.why}`));
  }
  console.log(C.d(`\n  Review:  bin/sentinel sdesk gate run --case ${slug}\n`));
}

function main() {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const vals = (f) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === f && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[++i]);
    }
    return out;
  };
  const action = argv[0];
  if (!action || action === 'list') return cmdList();
  if (action.startsWith('--')) {
    console.error('\n  usage: sentinel draft CASE-SLUG [--subject S ...] [--connector C]'
      + ' [--limit N] [--apply]\n         sentinel draft list\n');
    process.exit(2);
  }
  const n = Number(val('--limit'));
  return cmdDraft(action, {
    subjects: vals('--subject'),
    connector: val('--connector'),
    limit: Number.isFinite(n) && n > 0 ? n : 0,
    apply: argv.includes('--apply'),
  });
}

if (require.main === module) main();
module.exports = { toClaim, describe, gather };
