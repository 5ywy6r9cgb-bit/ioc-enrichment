#!/usr/bin/env node
/**
 * cli.js — `sentinel assets`, the door images come in through.
 *
 *   sentinel assets                  where the inbox is, and what is in it
 *   sentinel assets ingest           take everything in the inbox into the store
 *   sentinel assets ingest DIR       ...from somewhere else
 *   sentinel assets ingest --dry-run what WOULD happen, touching nothing
 *   sentinel assets ingest --as PHOTOGRAPH   override the guess for the batch
 *   sentinel assets list             what the store holds
 *   sentinel assets clean            write publication-safe copies
 *
 * Ingest is COPY, never move. An image that arrived by text message and was
 * saved to a camera roll exists in exactly one place; a tool that relocates it
 * on a first run is a tool that loses somebody's only copy of a photograph
 * they drove out to take.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../../core/provenance/provenance.js');
const IMG = require('./image.js');
const A = require('./assets.js');

const ROOT = path.join(__dirname, '..', '..');
// SENTINEL_EVIDENCE_DIR is what the rest of the repo reads (registry.js).
// A second spelling would mean a test, or an operator, could relocate the
// evidence store for one module and not the others -- and then write into
// the real tree while believing it was isolated.
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR
  || process.env.SENTINEL_EVIDENCE
  || path.join(ROOT, 'evidence');
const STORE = path.join(EVIDENCE, 'assets');
const INBOX = process.env.SENTINEL_ASSET_INBOX || path.join(STORE, 'inbox');
const PUBLISH = path.join(STORE, 'publish');
const INDEX = path.join(STORE, 'index.json');
const LEDGER = path.join(EVIDENCE, 'manifests', 'provenance.jsonl');

const CSI = String.fromCharCode(27) + '[';
const b = (s) => `${CSI}1m${s}${CSI}0m`;
const d = (s) => `${CSI}2m${s}${CSI}0m`;
const y = (s) => `${CSI}33m${s}${CSI}0m`;
const g = (s) => `${CSI}32m${s}${CSI}0m`;
const log = (s = '') => console.log(s);

function wrap(text, indent = 6, width = 78) {
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

function readIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    return j && Array.isArray(j.assets) ? j.assets : [];
  } catch { return []; }
}

function writeIndex(assets) {
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify({
    what: 'Every image the desk holds, what it is, and how it may be used.',
    caution: 'A SCREENSHOT is a picture of a source and is not the source. '
      + 'A GRAPHIC was made by this desk and is never evidence. Only a '
      + 'PHOTOGRAPH is a primary artifact, and only because you took it.',
    assets,
  }, null, 2));
}

// ── what is sitting there ─────────────────────────────────────────────
function cmdStatus() {
  fs.mkdirSync(INBOX, { recursive: true });
  const waiting = fs.readdirSync(INBOX).filter(A.isImageFile);
  const held = readIndex();
  log('');
  log(b('  ASSETS'));
  log('');
  log(`  inbox    ${INBOX}`);
  log(d('           drop images here — from Photos, use File ▸ Export ▸ Export Unmodified Original'));
  log(`  store    ${path.relative(ROOT, STORE)}${path.sep}   ${d('(gitignored, like the rest of evidence/)')}`);
  log('');
  log(`  waiting in the inbox   ${waiting.length}`);
  log(`  already in the store   ${held.length}`);
  if (held.length) {
    const byKind = {};
    for (const a of held) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    for (const [k, n] of Object.entries(byKind).sort()) {
      log(d(`      ${String(n).padStart(4)}  ${k}`));
    }
    const unresolved = held.filter((a) => a.kind === 'SCREENSHOT' && !a.source_url).length;
    if (unresolved) {
      log('');
      log(y(`  ${unresolved} screenshot(s) still have no source URL.`));
      log(wrap('A screenshot is a picture of a page, not the page. Until `doc get` has '
        + 'fetched and hashed the real URL, it supports nothing. Record one with: '
        + 'sentinel assets source ASSET-ID "https://…"', 2));
    }
  }
  log('');
  if (waiting.length) {
    log(`  Take them in:  ${b('sentinel assets ingest')}`);
  } else {
    log(d('  Nothing waiting. Drop files in the inbox path above, then run: sentinel assets ingest'));
  }
  log('');
}

// ── ingest ────────────────────────────────────────────────────────────
function cmdIngest(dir, opts) {
  const from = dir ? path.resolve(dir) : INBOX;
  if (!fs.existsSync(from)) {
    console.error(`\n  ${y('no such folder:')} ${from}\n`);
    process.exit(2);
  }
  const files = fs.readdirSync(from).filter(A.isImageFile).sort();
  log('');
  log(b(`  INGEST — ${files.length} image(s)`));
  log(`  from     ${from}`);
  log(`  into     ${path.relative(ROOT, STORE)}${path.sep}`);
  if (opts.as) log(`  forced   every file filed as ${opts.as}`);
  if (opts.caseId) log(`  case     ${opts.caseId}`);
  if (opts.dryRun) log(y('  DRY RUN — nothing is copied, nothing is recorded'));
  log('');

  if (!files.length) {
    log(d('  Nothing to do.'));
    log(d(`  Drop images into ${from} and run this again.\n`));
    return;
  }

  const index = readIndex();
  const known = new Set(index.map((a) => a.sha256));
  const ledger = opts.dryRun ? null : new P.Ledger(LEDGER);
  if (!opts.dryRun) {
    fs.mkdirSync(STORE, { recursive: true });
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  }

  let added = 0;
  let dupes = 0;
  let unreadable = 0;
  const needStrip = [];

  for (const f of files) {
    const src = path.join(from, f);
    let meta;
    let sha;
    try {
      meta = IMG.read(src);
      sha = P.sha256File(src);
    } catch (e) {
      unreadable++;
      log(`  ${y('unreadable')}  ${f} — ${e.message}`);
      continue;
    }

    if (known.has(sha)) {
      dupes++;
      log(d(`  already held  ${f}`));
      continue;
    }

    const guess = A.classify(meta, f);
    const kind = opts.as || guess.kind;
    const tier = A.tierFor(kind);
    const ext = A.extFor(meta.format, f);
    const when = meta.exif.dateTimeOriginal || meta.exif.dateTime || '';
    const name = A.assetName(kind, opts.label || f, sha, ext);
    const dest = path.join(STORE, name);

    const dims = meta.size ? `${meta.size.width}x${meta.size.height}` : 'size unread';
    const forced = opts.as ? ' (forced)' : ` (${guess.confidence} confidence)`;
    log(`  ${g('+')} ${name}`);
    log(d(`      ${kind}${forced} · ${tier} · ${meta.format} ${dims} · ${(meta.bytes / 1024).toFixed(0)} KB`));
    if (!opts.as) log(d(`      why: ${guess.why}`));
    if (meta.format === 'heic') {
      log(y('      HEIC — dimensions and EXIF were not read.'));
      log(d('      Convert first:  sips -s format jpeg "' + f + '" --out "' + f.replace(/\.heic$/i, '.jpg') + '"'));
    }
    if (meta.exif.hasGps) {
      log(y('      CARRIES GPS — the exact spot you stood, in the file.'));
      needStrip.push(name);
    } else if (A.needsStripping(meta)) {
      needStrip.push(name);
    }

    if (opts.dryRun) { added++; continue; }

    fs.copyFileSync(src, dest);
    const rec = {
      kind: 'image',
      artifactId: name,
      label: f,
      tier,
      sha256: sha,
      localPath: dest,
      evidenceRoot: EVIDENCE,
      tool: 'sentinel assets ingest',
      extra: {
        asset_kind: kind,
        classified: opts.as ? 'forced by operator' : `${guess.confidence}: ${guess.why}`,
        format: meta.format,
        width: (meta.size && meta.size.width) || null,
        height: (meta.size && meta.size.height) || null,
        camera: [meta.exif.make, meta.exif.model].filter(Boolean).join(' ') || null,
        taken_at: when || null,
        has_gps: meta.exif.hasGps,
        original_filename: f,
        case: opts.caseId || null,
      },
    };
    ledger.append(P.makeRecord(rec));
    index.push({
      id: name, sha256: sha, kind, tier,
      original_filename: f, format: meta.format,
      width: (meta.size && meta.size.width) || null,
      height: (meta.size && meta.size.height) || null,
      camera: [meta.exif.make, meta.exif.model].filter(Boolean).join(' ') || '',
      taken_at: when || '',
      has_gps: meta.exif.hasGps,
      source_url: '',
      case: opts.caseId || '',
      ingested_at: new Date().toISOString(),
    });
    known.add(sha);
    added++;
  }

  if (!opts.dryRun) writeIndex(index);

  log('');
  log(`  ${b(String(added))} added · ${dupes} already held · ${unreadable} unreadable`);
  if (!opts.dryRun) {
    log(d(`  index   ${path.relative(ROOT, INDEX)}`));
    log(d(`  ledger  ${path.relative(ROOT, LEDGER)}`));
  }
  log(d('  Copied, never moved — your originals are untouched where they were.'));

  if (needStrip.length) {
    log('');
    log(y(`  ${needStrip.length} file(s) carry camera metadata, GPS, or both.`));
    log(wrap('Keep it: it is the best provenance you will ever have on your own '
      + 'photographs. Do not publish it: it tells every reader exactly where you '
      + 'were standing and when. Write the safe copies with:', 2));
    log(`      ${b('sentinel assets clean')}`);
  }

  const shots = index.filter((a) => a.kind === 'SCREENSHOT' && !a.source_url);
  if (shots.length) {
    log('');
    log(y(`  ${shots.length} screenshot(s) have no source URL.`));
    log(wrap('A screenshot is a picture OF a page. The page is the source, and a '
      + 'screenshot can be scrolled, cropped or assembled. Fetch the real thing '
      + 'with `sentinel doc get "URL"`, then record it here so the two are tied '
      + 'together:  sentinel assets source ASSET-ID "https://…"', 2));
  }
  log('');
}

// ── clean ─────────────────────────────────────────────────────────────
function cmdClean(opts) {
  const index = readIndex();
  const targets = index.filter((a) => a.has_gps || a.camera || a.taken_at);
  log('');
  log(b('  PUBLICATION-SAFE COPIES'));
  log('');
  if (!targets.length) {
    log(d('  Nothing in the store carries camera metadata. Nothing to strip.\n'));
    return;
  }
  fs.mkdirSync(PUBLISH, { recursive: true });
  let done = 0;
  let skipped = 0;
  for (const a of targets) {
    const src = path.join(STORE, a.id);
    const out = path.join(PUBLISH, a.id);
    if (!fs.existsSync(src)) { log(y(`  missing  ${a.id}`)); continue; }
    const buf = fs.readFileSync(src);
    const stripped = IMG.strip(buf, a.format);
    if (!stripped) {
      skipped++;
      log(y(`  cannot strip  ${a.id}  (${a.format})`));
      log(d('      Only JPEG and PNG are rewritten here. Convert first: sips -s format jpeg'));
      continue;
    }
    if (opts.dryRun) { done++; continue; }
    fs.writeFileSync(out, stripped);
    const after = IMG.exif(stripped, a.format);
    // VERIFY, do not assume. A strip that silently failed and left GPS in the
    // file is worse than no strip at all, because the whole point of this
    // folder is that its contents are safe to hand out.
    if (after.hasGps || after.make) {
      log(y(`  STILL CARRIES METADATA after stripping: ${a.id} — not safe, delete it`));
      continue;
    }
    done++;
    log(`  ${g('✓')} ${a.id}  ${d(`${(buf.length / 1024).toFixed(0)} KB → ${(stripped.length / 1024).toFixed(0)} KB`)}`);
  }
  log('');
  log(`  ${b(String(done))} written to ${path.relative(ROOT, PUBLISH)}${path.sep}` + (skipped ? `  ${skipped} skipped` : ''));
  log(wrap('Publish from that folder. The originals keep their metadata, and the '
    + 'ledger keeps the hash of both, so you can always prove the stripped copy '
    + 'came from the photograph you took.', 2));
  log('');
}

// ── list ──────────────────────────────────────────────────────────────
function cmdList() {
  const index = readIndex();
  log('');
  log(b(`  ASSET STORE — ${index.length} image(s)`));
  log('');
  if (!index.length) { log(d('  Empty. Run: sentinel assets ingest\n')); return; }
  for (const a of index) {
    const flags = [
      a.has_gps ? y('GPS') : '',
      a.kind === 'SCREENSHOT' && !a.source_url ? y('NO SOURCE URL') : '',
      a.case ? d(`case ${a.case}`) : '',
    ].filter(Boolean).join('  ');
    log(`  ${a.kind.padEnd(11)} ${a.id}`);
    log(d(`      ${a.tier} · ${a.width || '?'}x${a.height || '?'} · from ${a.original_filename}`)
      + (flags ? `  ${flags}` : ''));
    if (a.source_url) log(d(`      source  ${a.source_url}`));
  }
  log('');
}

// ── source ────────────────────────────────────────────────────────────
function cmdSource(id, url) {
  if (!id || !url) {
    console.error('\n  usage: sentinel assets source ASSET-ID "https://the-page-it-shows"\n');
    process.exit(2);
  }
  if (!/^https?:\/\//i.test(url)) {
    console.error(`\n  ${y('not a URL:')} ${url}\n`);
    process.exit(2);
  }
  const index = readIndex();
  const a = index.find((x) => x.id === id || x.id.startsWith(id));
  if (!a) {
    console.error(`\n  ${y('no such asset:')} ${id}`);
    console.error('  List them with: sentinel assets list\n');
    process.exit(2);
  }
  a.source_url = url;
  writeIndex(index);
  log('');
  log(`  ${g('recorded')}  ${a.id}`);
  log(d(`  source  ${url}`));
  log('');
  log(wrap('That ties the picture to the page. It does NOT fetch the page. Until you '
    + 'run the line below, the desk holds a screenshot and a claim about where it '
    + 'came from, and nothing that could survive being challenged:', 2));
  log(`      ${b(`sentinel doc get "${url}"`)}`);
  log('');
}

function usage() {
  log('');
  log('  usage: sentinel assets                    where the inbox is, and what is in it');
  log('         sentinel assets ingest             take the inbox into the store');
  log('         sentinel assets ingest FOLDER      ...from somewhere else');
  log('         sentinel assets ingest --dry-run   what would happen, touching nothing');
  log('         sentinel assets ingest --as KIND   force PHOTOGRAPH, SCREENSHOT or GRAPHIC');
  log('         sentinel assets ingest --case ID   tag the batch to a case');
  log('         sentinel assets list               what the store holds');
  log('         sentinel assets source ID "URL"    tie a screenshot to the page it shows');
  log('         sentinel assets clean              write publication-safe copies');
  log('');
}

function main() {
  const argv = process.argv.slice(2);
  const action = (argv[0] || '').toLowerCase();
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positional = argv.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && argv[i - 1].startsWith('--')));

  const as = val('--as');
  if (as && !Object.prototype.hasOwnProperty.call(A.KINDS, as.toUpperCase())) {
    console.error(`\n  ${y(`not a kind: ${as}`)}`);
    console.error(`  known: ${Object.keys(A.KINDS).join(' ')}\n`);
    process.exit(2);
  }
  const opts = {
    dryRun: argv.includes('--dry-run'),
    as: as ? as.toUpperCase() : null,
    caseId: val('--case'),
    label: val('--label'),
  };

  if (!action) return cmdStatus();
  if (action === 'help') return usage();
  if (action === 'ingest') return cmdIngest(positional[1], opts);
  if (action === 'list') return cmdList();
  if (action === 'clean') return cmdClean(opts);
  if (action === 'source') return cmdSource(positional[1], positional[2]);
  return usage();
}

if (require.main === module) main();

module.exports = { wrap, readIndex };
