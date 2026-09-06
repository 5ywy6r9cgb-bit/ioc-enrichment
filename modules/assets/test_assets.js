#!/usr/bin/env node
/**
 * test_assets.js — an image is not a source, and a stripped file must be stripped.
 *
 * WHAT THESE GUARD
 *   Two failures, both silent, both expensive:
 *
 *   1. A screenshot filed as evidence. The desk then cites a picture of a page
 *      instead of the page, and the citation cannot survive anyone asking to
 *      see the original.
 *
 *   2. A "publication-safe" copy that still carries GPS. That folder exists so
 *      its contents can be handed out; a strip that quietly failed is worse
 *      than never having stripped at all, because the operator now trusts it.
 *      So `clean` re-reads its own output and this suite asserts on the bytes
 *      that come back, never on the fact that the function was called.
 *
 * The fixtures are built here, byte by byte, rather than shipped. A test that
 * needs a binary checked in is a test nobody edits.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const IMG = require('./image.js');
const A = require('./assets.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

// ── fixtures ──────────────────────────────────────────────────────────

/** A minimal but structurally real PNG of the given size. */
function png(width, height, extraChunks = []) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extraChunks.map(([t, dta]) => chunk(t, dta)),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(width * 3 + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A JPEG carrying a real little-endian EXIF block: Make, Model,
 * DateTimeOriginal and a GPS IFD. Built by hand so the parser is tested
 * against the structure it will actually meet, not against a mock.
 */
function jpegWithExif(width, height, { make = 'Apple', model = 'iPhone 15 Pro',
  taken = '2026:09:01 14:22:03', gps = true } = {}) {
  const strings = [];
  let pool = Buffer.alloc(0);
  const addString = (s) => {
    const at = pool.length;
    pool = Buffer.concat([pool, Buffer.from(`${s}\0`, 'latin1')]);
    if (pool.length % 2) pool = Buffer.concat([pool, Buffer.alloc(1)]);
    return at;
  };
  const makeAt = addString(make);
  const modelAt = addString(model);
  const takenAt = addString(taken);

  const entries = [];
  const entry = (tag, type, count, valueOrOffset) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    e.writeUInt32LE(valueOrOffset, 8);
    entries.push(e);
  };

  // Layout: TIFF header (8) + IFD0 + pool. Offsets are from the TIFF header.
  const nEntries = 3 + (gps ? 1 : 0) + 1;              // + ExifIFD pointer
  const ifd0At = 8;
  const poolAt = ifd0At + 2 + nEntries * 12 + 4;
  const exifIfdAt = poolAt + pool.length;
  const gpsIfdAt = exifIfdAt + 2 + 1 * 12 + 4;

  entry(0x010f, 2, make.length + 1, poolAt + makeAt);
  entry(0x0110, 2, model.length + 1, poolAt + modelAt);
  entry(0x0132, 2, taken.length + 1, poolAt + takenAt);
  if (gps) entry(0x8825, 4, 1, gpsIfdAt);
  entry(0x8769, 4, 1, exifIfdAt);

  const count0 = Buffer.alloc(2); count0.writeUInt16LE(entries.length);
  const next0 = Buffer.alloc(4);

  // ExifIFD: one entry, DateTimeOriginal, pointing back into the pool.
  const exifCount = Buffer.alloc(2); exifCount.writeUInt16LE(1);
  const exifEntry = Buffer.alloc(12);
  exifEntry.writeUInt16LE(0x9003, 0);
  exifEntry.writeUInt16LE(2, 2);
  exifEntry.writeUInt32LE(taken.length + 1, 4);
  exifEntry.writeUInt32LE(poolAt + takenAt, 8);
  const exifNext = Buffer.alloc(4);

  const gpsCount = Buffer.alloc(2); gpsCount.writeUInt16LE(1);
  const gpsEntry = Buffer.alloc(12);
  gpsEntry.writeUInt16LE(0x0001, 0);                   // GPSLatitudeRef
  gpsEntry.writeUInt16LE(2, 2);
  gpsEntry.writeUInt32LE(2, 4);
  gpsEntry.write('N\0', 8, 'latin1');
  const gpsNext = Buffer.alloc(4);

  const tiff = Buffer.concat([
    Buffer.from('II', 'latin1'),
    (() => { const x = Buffer.alloc(2); x.writeUInt16LE(42); return x; })(),
    (() => { const x = Buffer.alloc(4); x.writeUInt32LE(ifd0At); return x; })(),
    count0, ...entries, next0,
    pool,
    exifCount, exifEntry, exifNext,
    ...(gps ? [gpsCount, gpsEntry, gpsNext] : []),
  ]);

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2); app1Len.writeUInt16BE(app1Body.length + 2);

  const sof = Buffer.alloc(8);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  const sofLen = Buffer.alloc(2); sofLen.writeUInt16BE(sof.length + 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]), app1Len, app1Body,
    Buffer.from([0xff, 0xc0]), sofLen, sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0x00, 0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

console.log('\n== assets: a picture of a source is not the source ==\n');

// ── containers and dimensions ─────────────────────────────────────────
{
  const p = png(553, 1200);
  ok(IMG.detectFormat(p) === 'png', 'a PNG is recognised');
  const s = IMG.pngSize(p);
  ok(s && s.width === 553 && s.height === 1200,
    `PNG dimensions are read (got ${s && `${s.width}x${s.height}`})`);

  const j = jpegWithExif(4032, 3024);
  ok(IMG.detectFormat(j) === 'jpeg', 'a JPEG is recognised');
  const js = IMG.jpegSize(j);
  ok(js && js.width === 4032 && js.height === 3024,
    `JPEG dimensions are read past the EXIF block (got ${js && `${js.width}x${js.height}`})`);

  ok(IMG.detectFormat(Buffer.from('not an image at all')) === 'unknown',
    'a non-image is unknown, not a crash');
  ok(IMG.detectFormat(Buffer.alloc(0)) === 'unknown', 'and neither is an empty file');
  ok(IMG.pngSize(Buffer.alloc(4)) === null, 'a truncated PNG yields no size');
  ok(IMG.jpegSize(Buffer.from([0xff, 0xd8])) === null, 'and neither does a truncated JPEG');

  // HEIC is what an iPhone actually writes. It must be RECOGNISED even though
  // it cannot be read, so the operator is told to convert rather than left
  // wondering why the file was ignored.
  const heic = Buffer.concat([
    Buffer.alloc(4), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16),
  ]);
  ok(IMG.detectFormat(heic) === 'heic', 'HEIC is recognised even though it cannot be parsed');
}

// ── EXIF ──────────────────────────────────────────────────────────────
{
  const j = jpegWithExif(4032, 3024);
  const e = IMG.exif(j, 'jpeg');
  ok(e.present, 'EXIF is found in a JPEG');
  ok(e.make === 'Apple', `the camera make is read (got ${JSON.stringify(e.make)})`);
  ok(e.model === 'iPhone 15 Pro', `the model is read (got ${JSON.stringify(e.model)})`);
  ok(e.dateTimeOriginal === '2026:09:01 14:22:03',
    `the shutter time is read (got ${JSON.stringify(e.dateTimeOriginal)})`);
  ok(e.hasGps === true, 'and the GPS block is detected');

  const noGps = IMG.exif(jpegWithExif(100, 100, { gps: false }), 'jpeg');
  ok(noGps.present && noGps.hasGps === false,
    'a photo without GPS reports no GPS rather than defaulting to true');

  const plain = IMG.exif(png(553, 1200), 'png');
  ok(plain.present === false && plain.hasGps === false,
    'a PNG with no EXIF reports none');

  // A malformed blob must not hang or throw. A corrupt EXIF header that claims
  // 60,000 entries would otherwise walk the whole file as if it were tags.
  const junk = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20]),
    Buffer.from('Exif\0\0II', 'latin1'),
    Buffer.from([42, 0, 8, 0, 0, 0, 0xff, 0xff]),
    Buffer.alloc(16, 0xaa),
  ]);
  let threw = false;
  try { IMG.exif(junk, 'jpeg'); } catch { threw = true; }
  ok(!threw, 'a corrupt EXIF block is survived, not thrown on');
}

// ── STRIPPING, VERIFIED ON THE OUTPUT BYTES ───────────────────────────
{
  const j = jpegWithExif(4032, 3024);
  ok(IMG.exif(j, 'jpeg').hasGps, 'the fixture starts out carrying GPS');
  const s = IMG.stripJpeg(j);
  const after = IMG.exif(s, 'jpeg');
  ok(after.present === false, 'after stripping, the JPEG has no EXIF block at all');
  ok(after.hasGps === false, 'and no GPS');
  ok(after.make === '', 'and no camera name');
  const sz = IMG.jpegSize(s);
  ok(sz && sz.width === 4032 && sz.height === 3024,
    'and the picture itself is intact — same dimensions');
  ok(s.length < j.length, 'and the file got smaller');

  const p = png(553, 1200, [['tEXt', Buffer.from('Author\0Mark', 'latin1')]]);
  ok(p.includes(Buffer.from('tEXt')), 'the PNG fixture starts with a text chunk');
  const ps = IMG.stripPng(p);
  ok(!ps.includes(Buffer.from('tEXt')), 'stripping removes PNG text chunks');
  const pz = IMG.pngSize(ps);
  ok(pz && pz.width === 553, 'and the PNG is still readable afterwards');

  ok(IMG.strip(Buffer.alloc(10), 'heic') === null,
    'a container it cannot rewrite is REFUSED, not passed through unchanged');
}

// ── classification ────────────────────────────────────────────────────
{
  const phone = A.classify({ size: { width: 553, height: 1200 }, exif: {} }, 'IMG_4821.png');
  ok(phone.kind === 'SCREENSHOT', `a 19.5:9 image with no camera is a screenshot (got ${phone.kind})`);

  const wide = A.classify({ size: { width: 1200, height: 800 }, exif: {} }, 'IMG_4822.png');
  ok(wide.kind === 'GRAPHIC', `a 3:2 image with no camera is a graphic (got ${wide.kind})`);

  const shot = A.classify({
    size: { width: 4032, height: 3024 },
    exif: { make: 'Apple', model: 'iPhone 15 Pro', dateTimeOriginal: '2026:09:01 14:22:03' },
  }, 'IMG_0099.jpg');
  ok(shot.kind === 'PHOTOGRAPH', `camera EXIF makes it a photograph (got ${shot.kind})`);
  ok(shot.confidence === 'high', 'and that is the only high-confidence call');

  ok(A.classify({ size: { width: 100, height: 100 }, exif: {} }, 'Screenshot 2026.png').kind === 'SCREENSHOT',
    'a filename that says screenshot is believed');

  // AN IMAGE THE PIPELINE DOWNSCALED IS STILL A SCREENSHOT. This is the whole
  // reason the test is on the aspect ratio: an image sent by text message and
  // saved to a camera roll no longer has its original pixel dimensions, and a
  // classifier keyed on exact device sizes would call every one of them a
  // graphic -- which files a picture of a web page as something the desk drew.
  const full = A.classify({ size: { width: 1179, height: 2556 }, exif: {} }, 'IMG_1.png');
  const small = A.classify({ size: { width: 553, height: 1199 }, exif: {} }, 'IMG_2.png');
  ok(full.kind === 'SCREENSHOT' && small.kind === 'SCREENSHOT',
    'a full-size and a downscaled screenshot classify the same');

  ok(A.classify({ size: null, exif: {} }, 'x.heic').kind === 'UNKNOWN',
    'a file whose size could not be read is UNKNOWN, not guessed at');
}

// ── the tiers, which are the point ────────────────────────────────────
{
  ok(A.tierFor('PHOTOGRAPH') === 'GREEN', 'a photograph you took is a primary artifact');
  ok(A.tierFor('SCREENSHOT') === 'SOURCE_NEEDED',
    'a screenshot is NOT evidence until the page behind it is fetched');
  ok(A.tierFor('GRAPHIC') === 'GENERATED', 'a graphic the desk made is generated, never sourced');
  ok(A.tierFor('UNKNOWN') === 'SOURCE_NEEDED', 'and an unknown defaults to needing a source');
  ok(A.tierFor('nonsense') === 'SOURCE_NEEDED', 'as does anything unrecognised');

  const P = require('../../core/provenance/provenance.js');
  for (const k of Object.keys(A.KINDS)) {
    ok(P.validTier(A.tierFor(k)), `${k} files under a tier the ledger accepts`);
  }
}

// ── stripping is only offered where there is something to strip ───────
{
  ok(A.needsStripping({ exif: { hasGps: true } }), 'GPS needs stripping');
  ok(A.needsStripping({ exif: { make: 'Apple' } }), 'a camera name needs stripping');
  ok(!A.needsStripping({ exif: {} }), 'a bare file does not');
  ok(!A.needsStripping({}), 'and neither does one with no EXIF read at all');
}

// ── naming ────────────────────────────────────────────────────────────
{
  const n = A.assetName('PHOTOGRAPH', 'AEP substation New Albany.HEIC', 'abcdef1234567890', '.jpg', '2026-09-06');
  ok(/^2026-09-06_photograph_aep-substation-new-albany_abcdef12\.jpg$/.test(n),
    `the name says what it is (got ${n})`);
  ok(!/\s/.test(n), 'and has no spaces to break a shell command');
  ok(A.assetName('GRAPHIC', '', 'ff00', '.png').includes('untitled'),
    'a nameless file still gets a name');
  ok(A.assetName('GRAPHIC', '../../etc/passwd', 'ff00', '.png').indexOf('/') === -1,
    'a path in the label cannot escape the store');
}

// ── end to end, on disk ───────────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-assets-'));
  const inbox = path.join(tmp, 'inbox');
  const evid = path.join(tmp, 'evidence');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'IMG_0099.jpg'), jpegWithExif(4032, 3024));
  fs.writeFileSync(path.join(inbox, 'IMG_4821.png'), png(553, 1200));
  fs.writeFileSync(path.join(inbox, 'notes.txt'), 'not an image');

  const env = Object.assign({}, process.env, {
    SENTINEL_EVIDENCE_DIR: evid, SENTINEL_ASSET_INBOX: inbox,
  });
  // ANSI escapes are stripped before matching. Without this, the bold on a
  // count puts an escape sequence BETWEEN the number and the word -- so
  // /2 added/ fails against output that reads "2 added" on screen. The first
  // draft of this suite failed three assertions for exactly that reason and
  // the failure looked like a bug in the ingest.
  const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const run = (args) => strip(require('child_process').execFileSync(
    'node', [path.join(__dirname, 'cli.js'), ...args], { encoding: 'utf8', env },
  ));

  const dry = run(['ingest', '--dry-run']);
  ok(/DRY RUN/.test(dry), 'a dry run says so');
  ok(!fs.existsSync(path.join(evid, 'assets', 'index.json')),
    'and writes no index');

  const out = run(['ingest']);
  ok(/2 added/.test(out), `both images are taken in, the .txt is not (got: ${/(\d+) added/.exec(out)})`);
  ok(/CARRIES GPS/.test(out), 'the photograph is flagged as carrying GPS');
  ok(/PHOTOGRAPH/.test(out) && /SCREENSHOT/.test(out), 'and each is classified');
  ok(/no source URL/.test(out), 'and the screenshot is told it has no source');

  const idx = JSON.parse(fs.readFileSync(path.join(evid, 'assets', 'index.json'), 'utf8'));
  ok(idx.assets.length === 2, 'the index holds both');
  const photo = idx.assets.find((a) => a.kind === 'PHOTOGRAPH');
  ok(photo && photo.tier === 'GREEN', 'the photograph filed as GREEN');
  ok(photo && photo.has_gps === true, 'and recorded its GPS');
  const shotRow = idx.assets.find((a) => a.kind === 'SCREENSHOT');
  ok(shotRow && shotRow.tier === 'SOURCE_NEEDED', 'the screenshot filed as SOURCE_NEEDED');

  // ORIGINALS ARE NEVER MOVED. An image that arrived by text message exists in
  // one place; a tool that relocates it loses the only copy of a photograph
  // somebody drove out to take.
  ok(fs.existsSync(path.join(inbox, 'IMG_0099.jpg')), 'the original is still in the inbox');

  const again = run(['ingest']);
  ok(/0 added/.test(again) && /2 already held/.test(again),
    'a second run adds nothing — dedupe is by hash, not by filename');

  const ledger = fs.readFileSync(path.join(evid, 'manifests', 'provenance.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  ok(ledger.length === 2, `the ledger holds one record per image (got ${ledger.length})`);
  ok(ledger.every((r) => r.sha256 && r.local_path), 'each with a hash and a path');
  ok(ledger.every((r) => !r.local_path.startsWith('/')),
    'and no absolute paths, which would leak the operator home directory');

  const cleaned = run(['clean']);
  ok(/1 written/.test(cleaned), 'clean writes a safe copy of the photograph only');
  const safe = path.join(evid, 'assets', 'publish', photo.id);
  ok(fs.existsSync(safe), 'the safe copy exists');

  // THE ASSERTION THAT MATTERS. Not that clean ran -- that its output is clean.
  const safeExif = IMG.exif(fs.readFileSync(safe), 'jpeg');
  ok(safeExif.hasGps === false, 'the published copy carries NO GPS');
  ok(safeExif.make === '', 'and no camera name');
  ok(IMG.jpegSize(fs.readFileSync(safe)).width === 4032,
    'and it is still the same photograph');
  ok(IMG.exif(fs.readFileSync(path.join(evid, 'assets', photo.id)), 'jpeg').hasGps === true,
    'while the ORIGINAL in the store keeps its GPS, because that is the provenance');

  const listed = run(['list']);
  ok(/NO SOURCE URL/.test(listed), 'list flags the screenshot with no source');
  const sourced = run(['source', shotRow.id, 'https://www.epa.gov/stationary-sources-air-pollution']);
  ok(/recorded/.test(sourced), 'a source URL can be recorded');
  ok(/doc get/.test(sourced), 'and recording it tells you it is not the same as fetching it');
  const listed2 = run(['list']);
  ok(!/NO SOURCE URL/.test(listed2), 'after which the flag clears');

  let refused = '';
  try {
    require('child_process').execFileSync(
      'node', [path.join(__dirname, 'cli.js'), 'source', shotRow.id, 'epa.gov'],
      { encoding: 'utf8', env, stdio: 'pipe' },
    );
  } catch (e) { refused = String(e.stderr || ''); }
  ok(/not a URL/.test(refused), 'a bare hostname is refused as a source');

  // No angle-bracket placeholders: they are input redirection in zsh, and this
  // repository has shipped four of them into commands people then pasted.
  for (const [what, text] of [['status', run([])], ['help', run(['help'])], ['list', listed2]]) {
    const m = /<[a-z][a-z0-9 _-]*>/i.exec(text);
    ok(!m, `assets ${what} prints no angle-bracket placeholder (found ${m && m[0]})`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
