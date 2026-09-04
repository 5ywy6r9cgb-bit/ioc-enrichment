#!/usr/bin/env node
'use strict';
/**
 * document.js — get a document onto disk, hashed, and find out if it is readable.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────
 * Every connector in this desk collects METADATA about documents: a case
 * name, a filing period, an amount, a URL. Not one of them fetches the
 * document. So a library of hundreds of captures can sit beside a case file
 * with zero exhibits, and the step in between — open the link, save the PDF,
 * read it — stays entirely manual and therefore never happens.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS IS BUILT AROUND
 * ─────────────────────────────────────────────────────────────────────
 * A scanned PDF and a text PDF have the same extension, open in the same
 * viewer, and look identical to a person. Run a text extractor over the
 * scanned one and it returns almost nothing — no error, no warning, just a
 * near-empty file. The document then appears in your library as "extracted"
 * and never matches a single search, and you conclude the record does not
 * mention what you were looking for.
 *
 * So extraction reports characters PER PAGE and says plainly when a document
 * is almost certainly a scan needing OCR. An empty extraction is never
 * reported as a successful one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * Below this many characters per page, a PDF is almost certainly images.
 *
 * A genuinely text-bearing page of a court opinion or a filing runs into the
 * thousands. A scanned page yields a handful of stray characters from
 * whatever the scanner embedded. 120 sits far below any real page and far
 * above any scan, so it does not need to be precise to be useful.
 */
const SCAN_THRESHOLD_CHARS_PER_PAGE = 120;

/**
 * What a file ACTUALLY is, from its first bytes.
 *
 * An extension is a claim and a Content-Type is a claim; the magic number is
 * the file. Records portals serve ZIP archives of page images under a .pdf
 * name, and on a real corpus every single .pdf was one of those, a non-PDF,
 * or empty. Trusting the extension there means every search returns nothing
 * and reads as "the record does not mention that".
 */
function sniff(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const head = buf.slice(0, 8);
  if (head.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // PK\x03\x04 archive; PK\x05\x06 empty archive; PK\x07\x08 spanned.
  if (head[0] === 0x50 && head[1] === 0x4B
      && [0x03, 0x05, 0x07].includes(head[2])) return 'zip';
  if (head.slice(0, 4).toString('latin1') === '%!PS') return 'postscript';
  if (head[0] === 0xFF && head[1] === 0xD8) return 'jpeg';
  if (head.slice(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'png';
  if (head.slice(0, 5).toString('latin1').toLowerCase() === '<html'
      || buf.slice(0, 200).toString('latin1').toLowerCase().includes('<!doctype html')) return 'html';
  return 'unknown';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A filename that is safe, readable, and traceable back to its source. */
function nameFor(url, contentType) {
  let base = 'document';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) base = decodeURIComponent(last);
  } catch { /* keep the default */ }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  if (!base) base = 'document';
  const ct = String(contentType || '');
  let ext = '';
  if (/pdf/i.test(ct)) ext = '.pdf';
  else if (/html/i.test(ct)) ext = '.html';
  else if (/plain/i.test(ct)) ext = '.txt';
  if (ext && !base.toLowerCase().endsWith(ext)) base += ext;
  return base;
}

/**
 * Is a command actually on PATH?
 *
 * Checked rather than assumed, because the failure mode of assuming is a
 * thrown ENOENT in the middle of an otherwise successful fetch — the
 * document is already on disk and the run looks like it failed.
 *
 * This used to run `command -v <bin>` through a SHELL. Three things wrong
 * with that, in increasing order of seriousness:
 *
 *   1. Node prints a DeprecationWarning (DEP0190) on every single fetch and
 *      every test run. A warning that always fires is a warning nobody reads,
 *      and it was sitting on top of the one command this desk runs most.
 *   2. It spawned a shell to answer a question about a directory listing.
 *   3. Under `shell: true` the arguments are concatenated into a command
 *      line, not passed as arguments. The tool name is a caller-supplied
 *      option (`opts.pdftotext`), so the moment that ever comes from a
 *      config file, an env var, or anything a fetched document influences,
 *      `command -v` becomes arbitrary command execution. Nothing supplies it
 *      today. That is exactly the kind of "safe for now" that stops being
 *      true without anyone editing this function.
 *
 * So: no subprocess and no shell. Walk PATH and ask the filesystem, which is
 * what `command -v` was going to do anyway — and is stricter, because it
 * answers the question we actually have ("can execFileSync run this?")
 * rather than the shell's question, which also says yes to builtins and
 * aliases that execFileSync cannot run.
 */
function haveTool(bin) {
  if (!bin || typeof bin !== 'string') return false;

  // An explicit path is not a PATH lookup — check it where it points.
  if (bin.includes(path.sep) || bin.startsWith('.')) {
    try { fs.accessSync(bin, fs.constants.X_OK); return true; }
    catch { return false; }
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch { /* next directory */ }
  }
  return false;
}

/** Page count, or null when nothing can tell us. */
function pageCount(file, opts = {}) {
  const bin = opts.pdfinfo || 'pdfinfo';
  if (!opts.force && !haveTool(bin)) return null;
  try {
    const out = execFileSync(bin, [file], { encoding: 'utf8', timeout: 30000 });
    const m = /^Pages:\s+(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/**
 * Pull the text out, and say honestly what came out.
 *
 * Returns `available: false` when the tool is absent — which is NOT the same
 * as a document with no text, and must not be reported as one.
 */
function extractText(file, opts = {}) {
  const bin = opts.pdftotext || 'pdftotext';
  if (!opts.force && !haveTool(bin)) {
    return {
      available: false,
      reason: `${bin} is not installed`,
      install: 'brew install poppler',
    };
  }
  let text = '';
  try {
    text = execFileSync(bin, ['-layout', file, '-'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { available: true, ok: false, reason: e.message.slice(0, 200) };
  }

  const pages = opts.pages !== undefined ? opts.pages : pageCount(file, opts);
  const chars = text.trim().length;
  // Guard the division: a page count of zero or null must not produce
  // Infinity and quietly pass the scan check.
  const perPage = pages && pages > 0 ? Math.round(chars / pages) : null;
  const likelyScanned = perPage !== null && perPage < SCAN_THRESHOLD_CHARS_PER_PAGE;

  return {
    available: true,
    ok: true,
    text,
    chars,
    pages,
    charsPerPage: perPage,
    likelyScanned,
    empty: chars === 0,
  };
}

/**
 * Named HTML entities worth decoding. Deliberately short: these are the ones
 * that appear in filing text and would otherwise land in a quote.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', middot: '\u00b7',
};

/**
 * Pull readable text out of an HTML record.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT OPTIONAL
 * ─────────────────────────────────────────────────────────────────────
 * The Senate LDA serves its filings as HTML, not PDF. Those filings are the
 * strongest evidence this desk handles -- sworn statements under 2 U.S.C.
 * 1603 -- and without this they landed on disk as an unsearchable blob under
 * "Not a PDF, no extraction attempted."
 *
 * A record that is saved and hashed but cannot be searched reads, six months
 * later, exactly like a record that says nothing. That is the same silent
 * failure as a scanned PDF, arriving through a different door.
 */
function extractHtmlText(input) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let t = raw;

  // Script and style contents are not the document.
  t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');

  // Block boundaries become line breaks, or every field in a filing table
  // runs together into one unreadable line and a quote spans two cells.
  t = t.replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n');
  t = t.replace(/<\/\s*(p|div|tr|li|h[1-6]|section|article|table|thead|tbody)\s*>/gi, '\n');
  t = t.replace(/<\/\s*(td|th)\s*>/gi, '\t');

  t = t.replace(/<[^>]+>/g, '');

  t = t.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  t = t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/&([a-z]+);/gi, (m, name) => {
    const v = ENTITIES[name.toLowerCase()];
    return v === undefined ? m : v;
  });

  // Collapse runs of blank lines and trailing space, keeping the shape.
  t = t.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
       .filter((l, i, a) => l !== '' || (a[i - 1] || '') !== '')
       .join('\n').trim();

  const chars = t.length;
  return {
    available: true,
    ok: true,
    text: t,
    chars,
    // A page whose visible text is almost all chrome -- nav, cookie banner,
    // a JS shell -- is not a readable record, and must not be filed as one.
    likelyEmpty: chars < HTML_MIN_CHARS,
  };
}

/**
 * Below this, an HTML page carried no real record: a nav shell, an error
 * page, or a document that renders entirely from JavaScript.
 */
const HTML_MIN_CHARS = 400;

/**
 * Fetch a document and put it on disk with its hash.
 *
 * `request` is injected so this is testable without a network, and so it
 * reuses the connector layer's redirect handling and https-only rule rather
 * than growing a second, subtly different one.
 */
async function fetchDocument(url, request, opts = {}) {
  let u;
  try { u = new URL(url); }
  catch { return { ok: false, error: `not a url: ${url}` }; }
  if (u.protocol !== 'https:') {
    return { ok: false, error: `refusing non-https url (${u.protocol})` };
  }

  const res = await request('GET', url, { Accept: '*/*' });
  if (res.status === 0) return { ok: false, error: res.error || 'no response' };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  if (!res.body || !res.body.length) {
    return { ok: false, status: res.status, error: 'empty response body' };
  }

  const dir = opts.dir || 'documents';
  fs.mkdirSync(dir, { recursive: true });

  const contentType = (res.headers && (res.headers['content-type'] || '')) || '';
  // Hash the bytes as received, BEFORE anything is derived from them. The
  // hash has to describe what the server sent, not what survived processing.
  const hash = sha256(res.body);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}__${hash.slice(0, 12)}__${nameFor(url, contentType)}`);
  fs.writeFileSync(file, res.body);

  const magic = sniff(res.body);

  return {
    ok: true,
    file,
    sha256: hash,
    bytes: res.body.length,
    contentType,
    magic,
    // The MAGIC decides, not the extension and not the Content-Type. Both of
    // those are claims made by whoever served the file.
    isPdf: magic === 'pdf',
    // A ZIP served as a PDF is not a curiosity. On a real records corpus,
    // 95 of 95 files with a .pdf extension were ZIP bundles of page images,
    // documents that were not PDFs at all, or empty -- and every keyword
    // search ever run against them returned nothing regardless of content.
    zipMislabelled: magic === 'zip' && (/pdf/i.test(contentType) || /\.pdf$/i.test(file)),
    url,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchDocument, extractText, extractHtmlText, pageCount, nameFor, sha256,
  haveTool, sniff,
  SCAN_THRESHOLD_CHARS_PER_PAGE, HTML_MIN_CHARS,
};
