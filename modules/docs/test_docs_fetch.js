'use strict';
/**
 * test_docs_fetch.js
 *
 * The dangerous outcome here is not a failed fetch. It is a SUCCESSFUL one
 * over a scanned document: the file lands, the extractor returns almost
 * nothing without erroring, and the document joins the library as "readable".
 * It then matches no search for the rest of its life, and every search that
 * misses it reads as "the record does not mention that".
 *
 * So most of these tests are about telling three things apart that all look
 * like "no text": the tool is missing, the extraction failed, and the
 * document is a scan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./document.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')); }

/** A stand-in for pdftotext that emits exactly what we tell it to. */
function fakeTool(dir, name, output, exitCode = 0) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${exitCode ? `exit ${exitCode}` : `cat <<'XEOF'\n${output}\nXEOF`}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

module.exports = async function run() {
  console.log('\n  document fetch\n');

  // ══ 1. THE BYTES ARE HASHED AS RECEIVED ═══════════════════════════════
  {
    const dir = tmpdir();
    const body = Buffer.from('%PDF-1.4 pretend pdf');
    const fakeRequest = async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body });
    const got = await D.fetchDocument('https://example.gov/opinion.pdf', fakeRequest, { dir });

    check('the document lands on disk', got.ok && fs.existsSync(got.file));
    check('the hash is of the bytes as received',
      got.sha256 === D.sha256(body), got.sha256);
    check('the saved file is byte-identical to the response',
      fs.readFileSync(got.file).equals(body));
    check('the filename carries the hash so it traces back',
      path.basename(got.file).includes(got.sha256.slice(0, 12)));
    check('a PDF is recognised from its magic bytes, not just the header',
      got.isPdf === true);
  }

  // ══ 2. REFUSALS ═══════════════════════════════════════════════════════
  {
    const dir = tmpdir();
    const never = async () => { throw new Error('should not have been called'); };
    const http = await D.fetchDocument('http://example.gov/x.pdf', never, { dir });
    check('plain http is refused before any request is made',
      !http.ok && /non-https/.test(http.error), JSON.stringify(http));

    const bad = await D.fetchDocument('not a url', never, { dir });
    check('a malformed url is refused', !bad.ok && /not a url/.test(bad.error));

    const empty = await D.fetchDocument('https://example.gov/x.pdf',
      async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }), { dir });
    check('an empty body is a failure, not a zero-byte document',
      !empty.ok && /empty/.test(empty.error), JSON.stringify(empty));

    const notFound = await D.fetchDocument('https://example.gov/x.pdf',
      async () => ({ status: 404, headers: {}, body: Buffer.from('nope') }), { dir });
    check('a 404 body is not saved as the document', !notFound.ok && notFound.status === 404);
  }

  // ══ 2b. THE EXTENSION IS A CLAIM; THE MAGIC IS THE FILE ═══════════════
  // On a real records corpus, 95 of 95 files with a .pdf extension were ZIP
  // bundles of page images, non-PDFs, or empty. Not one was a readable PDF.
  // Trusting the extension there means every search comes back empty and
  // reads as "the record does not mention that".
  {
    check('a PDF is identified by its magic bytes',
      D.sniff(Buffer.from('%PDF-1.7 etc')) === 'pdf');
    check('a ZIP is identified even when everything else says PDF',
      D.sniff(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0])) === 'zip');
    check('an EMPTY zip is still a zip',
      D.sniff(Buffer.from([0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0])) === 'zip');
    check('a jpeg is not mistaken for a document',
      D.sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])) === 'jpeg');
    check('a truncated buffer is unknown rather than guessed',
      D.sniff(Buffer.from([0x50])) === 'unknown');

    const dir = tmpdir();
    const zipBody = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(64)]);
    const got = await D.fetchDocument('https://portal.gov/CouncilMinutes.pdf',
      async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: zipBody }),
      { dir });

    check('a ZIP served as application/pdf is NOT treated as a PDF',
      got.ok && got.isPdf === false, JSON.stringify({ isPdf: got.isPdf, magic: got.magic }));
    check('and it is named as a mislabelled zip, not merely "not a pdf"',
      got.zipMislabelled === true);
    check('the real type is reported', got.magic === 'zip');

    // A genuine PDF must not trip the mislabelled flag.
    const real = await D.fetchDocument('https://x.gov/opinion.pdf',
      async () => ({ status: 200, headers: { 'content-type': 'application/pdf' },
                     body: Buffer.from('%PDF-1.7 real document here') }), { dir });
    check('a real PDF is not flagged as mislabelled',
      real.isPdf === true && real.zipMislabelled === false);
  }

  // ══ 3. MISSING TOOL IS NOT AN EMPTY DOCUMENT ══════════════════════════
  // These are three different facts and only one of them is about the
  // document. Reporting the first as the third is how a readable filing gets
  // filed as unreadable, and the reverse is worse.
  {
    const r = D.extractText('/nonexistent.pdf', { pdftotext: 'definitely-not-a-real-binary-xyz' });
    check('a missing extractor reports unavailable, not "no text"',
      r.available === false && !('chars' in r), JSON.stringify(r));
    check('it says how to install it', /brew install poppler/.test(r.install));
  }

  // ══ 4. A SCAN IS CALLED A SCAN ════════════════════════════════════════
  {
    const dir = tmpdir();
    // 40 pages, a handful of stray characters — what a scanner leaves behind.
    const tool = fakeTool(dir, 'pdftotext-scan', 'Exhibit A\n\n\f \n\f');
    const r = D.extractText('/whatever.pdf', { pdftotext: tool, force: true, pages: 40 });
    check('a scan extracts successfully but is flagged',
      r.ok === true && r.likelyScanned === true, JSON.stringify(r));
    check('characters per page is reported, not just a total',
      r.charsPerPage !== null && r.charsPerPage < D.SCAN_THRESHOLD_CHARS_PER_PAGE,
      String(r.charsPerPage));
  }

  // ══ 5. A REAL DOCUMENT IS NOT FLAGGED ═════════════════════════════════
  {
    const dir = tmpdir();
    const page = 'IN THE COURT OF APPEALS OF OHIO. '.repeat(60);
    const tool = fakeTool(dir, 'pdftotext-real', `${page}\n\f${page}`);
    const r = D.extractText('/whatever.pdf', { pdftotext: tool, force: true, pages: 2 });
    check('a text-bearing document is not called a scan',
      r.ok === true && r.likelyScanned === false, String(r.charsPerPage));
    check('the extracted text is returned', /COURT OF APPEALS/.test(r.text));
  }

  // ══ 6. ZERO PAGES MUST NOT DIVIDE ═════════════════════════════════════
  // pages of 0 or null would make chars/pages Infinity or NaN, and Infinity
  // sails past a "< threshold" check as though the document were fine.
  {
    const dir = tmpdir();
    const tool = fakeTool(dir, 'pdftotext-nopages', 'a little text');
    for (const pages of [0, null]) {
      const r = D.extractText('/whatever.pdf', { pdftotext: tool, force: true, pages });
      check(`page count of ${JSON.stringify(pages)} yields no per-page figure rather than a wrong one`,
        r.charsPerPage === null && r.likelyScanned === false, JSON.stringify(r));
    }
  }

  // ══ 7. AN EXTRACTOR THAT ERRORS IS REPORTED AS ERRORING ═══════════════
  {
    const dir = tmpdir();
    const tool = fakeTool(dir, 'pdftotext-broken', '', 3);
    const r = D.extractText('/whatever.pdf', { pdftotext: tool, force: true, pages: 5 });
    check('a failing extractor is not reported as an empty document',
      r.available === true && r.ok === false, JSON.stringify(r));
  }

  // ══ 8. FILENAMES ══════════════════════════════════════════════════════
  {
    check('a filename is taken from the url path',
      D.nameFor('https://lda.gov/filings/abc/print/x.pdf', 'application/pdf') === 'x.pdf');
    check('a url with no filename still produces one',
      D.nameFor('https://lda.gov/', 'application/pdf') === 'document.pdf');
    check('path separators cannot escape the directory',
      !D.nameFor('https://x.gov/../../etc/passwd', 'text/plain').includes('/'));
    check('an extension is not doubled',
      D.nameFor('https://x.gov/a.pdf', 'application/pdf') === 'a.pdf');
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
