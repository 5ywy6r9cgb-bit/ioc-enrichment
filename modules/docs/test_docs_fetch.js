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

  // ══ 7b. AN HTML RECORD IS A RECORD ════════════════════════════════════
  // The Senate LDA serves filings as HTML, not PDF -- sworn statements under
  // 2 U.S.C. 1603, the strongest evidence this desk handles. They used to
  // land on disk under "Not a PDF, no extraction attempted", unsearchable.
  // Six months later that reads exactly like a record that says nothing.
  {
    const html = '<html><head><style>a{color:red}</style>'
      + '<script>document.write("NOT THE DOCUMENT")</script></head><body>'
      + '<h1>LOBBYING REPORT</h1>'
      + '<table><tr><td>Registrant</td><td>ALPINE GROUP PARTNERS</td></tr>'
      + '<tr><td>Client</td><td>AWS PUBLIC POLICY, AMERICAS</td></tr></table>'
      + '<p>Issues: H.R.&nbsp;9126 &mdash; data&nbsp;center energy</p></body></html>';
    const r = D.extractHtmlText(html);

    check('html text is extracted', r.ok === true && r.chars > 0);
    check('script contents are not part of the document',
      !/NOT THE DOCUMENT/.test(r.text), r.text);
    check('style contents are not part of the document', !/color:red/.test(r.text));
    check('entities are decoded, so a quote is quotable',
      r.text.includes('H.R. 9126') && r.text.includes('\u2014'), JSON.stringify(r.text));
    check('table cells do not run together into one line',
      /ALPINE GROUP PARTNERS/.test(r.text) && /\n/.test(r.text), JSON.stringify(r.text));
    check('both parties survive extraction',
      /ALPINE GROUP PARTNERS/.test(r.text) && /AWS PUBLIC POLICY/.test(r.text));
  }

  // ══ 7c. A NAV SHELL IS NOT A FILING ═══════════════════════════════════
  // An error page, a cookie banner, or a document that renders entirely from
  // JavaScript all produce a page with almost no text. Filing one as a
  // readable record is how "the filing does not mention that" gets written
  // about a filing nobody could read.
  {
    const shell = '<html><body><nav>Home About</nav>'
      + '<div id="app"></div><script>render()</script></body></html>';
    const r = D.extractHtmlText(shell);
    check('a page carrying almost no text is flagged, not filed as readable',
      r.likelyEmpty === true, `${r.chars} chars`);

    const real = '<html><body><p>' + 'Registrant: ALPINE GROUP PARTNERS. '.repeat(40)
      + '</p></body></html>';
    check('a real filing is not flagged',
      D.extractHtmlText(real).likelyEmpty === false);
    check('the threshold is a named constant, not a literal',
      typeof D.HTML_MIN_CHARS === 'number' && D.HTML_MIN_CHARS > 0);
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

  // ══ FINDING A TOOL ON PATH DOES NOT INVOLVE A SHELL ═══════════════════
  //
  // haveTool() used to run `command -v <bin>` with { shell: true }. Node
  // deprecation-warned on it (DEP0190) on every fetch and every test run, and
  // the tool name is a caller-supplied option — so the moment it comes from a
  // config file or env var, the lookup is arbitrary command execution.
  {
    // Strip comments first. The guard is about CODE — and the explanation of
    // why this was removed necessarily quotes the thing it removed. A guard
    // that fires on its own rationale is a guard that gets deleted.
    const src = fs.readFileSync(path.join(__dirname, 'document.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check('no command runs through a shell in this module',
      !/shell:\s*true/.test(src));

    // Behaviour, not just absence: it must still answer correctly.
    check('a binary that is really on PATH is found',
      D.haveTool(process.platform === 'win32' ? 'cmd' : 'sh'));
    check('a name that is on no PATH is not found',
      !D.haveTool('sentinel-definitely-not-a-real-binary-xyz'));
    check('an explicit path is checked where it points, not looked up',
      D.haveTool(process.execPath));
    check('an explicit path that does not exist is not found',
      !D.haveTool('/definitely/not/here/pdftotext'));

    // A shell would happily accept these. execFileSync would not, so
    // answering "yes" to them is answering the wrong question.
    check('a name with shell metacharacters is not reported as runnable',
      !D.haveTool('sh; echo pwned') && !D.haveTool('$(echo sh)'));
    check('an empty or non-string tool name is refused rather than guessed at',
      !D.haveTool('') && !D.haveTool(null) && !D.haveTool(undefined));
  }

  // ══ THE CHAIN FIXER MUST NOT BECOME THE CHAIN BYPASS ══════════════════
  //
  // `doc chain` exists so nobody reaches for NODE_TLS_REJECT_UNAUTHORIZED=0.
  // It earns that only if the one unverified connection it makes stays a
  // DIAGNOSTIC — certificates in, no document out, nothing in the ledger.
  // If verification ever slips into the fetch path, this desk would be
  // recording provenance for bytes whose origin was never established, and
  // the ledger would say GREEN about them.
  {
    const CH = require('./chain.js');
    const chainSrc = fs.readFileSync(path.join(__dirname, 'chain.js'), 'utf8');
    const docSrc = fs.readFileSync(path.join(__dirname, 'document.js'), 'utf8');
    const regSrc = fs.readFileSync(
      path.join(__dirname, '..', 'connectors', 'registry.js'), 'utf8');

    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    check('the document fetcher never disables certificate verification',
      !/rejectUnauthorized\s*:\s*false/.test(strip(docSrc)));
    check('and neither does the connector request layer',
      !/rejectUnauthorized\s*:\s*false/.test(strip(regSrc)));

    // Exactly one, in the diagnostic connect. Two would mean it spread.
    const relaxed = (strip(chainSrc).match(/rejectUnauthorized\s*:\s*false/g) || []).length;
    check('the chain module relaxes verification in exactly one place',
      relaxed === 1, `${relaxed} occurrences`);
    check('and that place is a tls.connect, not an https request for content',
      /tls\.connect\(\{[\s\S]{0,300}rejectUnauthorized:\s*false/.test(strip(chainSrc)));
    check('the chain module never writes into the documents tree',
      !/documents/.test(strip(chainSrc)));
    check('nor touches the provenance ledger',
      !/Ledger|provenance/i.test(strip(chainSrc)));

    // DER -> PEM, because a wrong conversion produces a file Node silently
    // ignores: the fetch still fails and the operator blames the host.
    const pem = CH.derToPem(Buffer.from('hello world, not really a cert'));
    check('a PEM is produced with both armour lines',
      /^-----BEGIN CERTIFICATE-----\n/.test(pem) && /-----END CERTIFICATE-----\n$/.test(pem));
    check('and its base64 is wrapped at 64 columns',
      pem.split('\n').slice(1, -2).every((l) => l.length <= 64));

    // AIA parsing. A missed issuer URL means no completion is even attempted.
    const urls = CH.issuerUrls({ infoAccess: {
      'CA Issuers - URI': ['http://cert.example.gov/ca.crt'],
      'OCSP - URI': ['http://ocsp.example.gov'],
    } });
    check('the CA Issuers URL is read out of the certificate',
      urls.length === 1 && urls[0] === 'http://cert.example.gov/ca.crt', urls.join(','));
    check('and the OCSP responder is not mistaken for one',
      !urls.some((u) => /ocsp/.test(u)));
    check('a certificate publishing no issuer URL yields none, not a crash',
      CH.issuerUrls({}).length === 0 && CH.issuerUrls(null).length === 0);
    check('a non-http scheme in AIA is refused',
      CH.issuerUrls({ infoAccess: { 'CA Issuers - URI': ['ldap://x/cn=CA'] } }).length === 0);

    // The explanation the operator reads instead of a search engine.
    const tls = require('./document.js').explainTlsError(
      'Error: unable to verify the first certificate UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    check('the leaf-signature error is explained as a server misconfiguration',
      tls && /intermediate/.test(tls.cause));
    check('an expired certificate is not confused with a missing intermediate',
      require('./document.js').explainTlsError('CERT_HAS_EXPIRED').code === 'CERT_HAS_EXPIRED');
    check('a non-TLS failure gets no certificate advice',
      require('./document.js').explainTlsError('HTTP 404') === null);

    // The advice itself. If this string ever drifts out, the operator is one
    // search away from the thing that quietly voids the evidence chain.
    const cliSrc = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
    check('doc get warns against NODE_TLS_REJECT_UNAUTHORIZED by name',
      /NODE_TLS_REJECT_UNAUTHORIZED=0/.test(cliSrc) && /Do NOT set/.test(cliSrc));
    check('and offers NODE_EXTRA_CA_CERTS as the safe route instead',
      /NODE_EXTRA_CA_CERTS/.test(cliSrc));
  }

  // ══ A JS SHELL IS NOT A MISSING DOCUMENT ══════════════════════════════
  //
  // courtlistener.com/opinion/<id>/<slug>/ renders from JavaScript, so a fetch
  // gets an empty body and `doc get` reports "empty response body" — which
  // reads as "the document is gone" when it is simply not in the HTML.
  //
  // That failure is worst precisely here: the connector hands the operator
  // these URLs by the dozen. The search says "20 civil rights cases", every
  // fetch says nothing is there, and the conclusion from the terminal alone
  // is that the leads were junk.
  {
    const r = D.rewriteForMachines(
      'https://www.courtlistener.com/opinion/8725437/laborde-v-city-of-gahanna/',
      { COURTLISTENER_API_TOKEN: 'secret-token' });
    check('an opinion URL is rewritten to the API record',
      r && r.url === 'https://www.courtlistener.com/api/rest/v4/clusters/8725437/',
      r && r.url);
    check('the key travels in the Authorization header',
      r.headers.Authorization === 'Token secret-token');
    check('and never in the URL, where it would reach the ledger and a filename',
      !r.url.includes('secret-token'));

    const nokey = D.rewriteForMachines('https://www.courtlistener.com/opinion/1/x/', {});
    check('a missing key is flagged rather than silently sending none',
      nokey.needsKey === true && !nokey.headers.Authorization);

    check('a host that merely CONTAINS courtlistener.com is not rewritten',
      D.rewriteForMachines('https://evilcourtlistener.com/opinion/1/x/', {}) === null);
    check('a subdomain of the real host still is',
      !!D.rewriteForMachines('https://www.courtlistener.com/opinion/1/x/', {}));
    // This test used to assert that a docket URL was LEFT ALONE, which was
    // right while nothing produced them. `connect courtlistener --dockets`
    // now hands the operator docket URLs by the dozen — that is where
    // indictments, affidavits and seizure warrants live — and every one of
    // them fetched a JavaScript shell. The old assertion had become a guard
    // protecting the bug.
    const d = D.rewriteForMachines(
      'https://www.courtlistener.com/docket/69127499/united-states-v-certain-domains/',
      { COURTLISTENER_API_TOKEN: 'secret-token' });
    check('a docket URL is rewritten to the docket API record',
      d && d.url === 'https://www.courtlistener.com/api/rest/v4/dockets/69127499/',
      d && d.url);
    check('the docket rewrite carries the key in the header too',
      d.headers.Authorization === 'Token secret-token' && !d.url.includes('secret-token'));
    check('and it SAYS that a docket record is not the charging document',
      /NOT the filings/.test(d.note || ''), d.note);
    check('it also points at where the filings are listed',
      /docket-entries/.test(d.why), d.why);
    check('a CourtListener page that is neither opinion nor docket is left alone',
      D.rewriteForMachines('https://www.courtlistener.com/person/123/x/', {}) === null);

    // The docket rewrite tells the operator to go to /api/rest/v4/docket-entries/
    // for the filings. Pasting that URL back in has to work: with no token it
    // is refused, and the refusal reads as "the filings are not available"
    // rather than "you did not send your key".
    const api = D.rewriteForMachines(
      'https://www.courtlistener.com/api/rest/v4/docket-entries/?docket=69127499',
      { COURTLISTENER_API_TOKEN: 'secret-token' });
    check('an API URL pasted directly still gets the key attached',
      api && api.headers.Authorization === 'Token secret-token', JSON.stringify(api));
    check('and its URL is passed through unchanged, not rewritten again',
      api.url === 'https://www.courtlistener.com/api/rest/v4/docket-entries/?docket=69127499');
    check('with no key it is flagged rather than sent bare into a refusal',
      D.rewriteForMachines('https://www.courtlistener.com/api/rest/v4/dockets/1/', {}).needsKey === true);
  }

  // ══ AN API RECORD IS A FILE TYPE ═════════════════════════════════════
  //
  // The docket rewrite returns JSON. Sniffed as 'unknown' it was saved with
  // no extension at all — a file called "69127499" that nothing downstream
  // can open by type, and that reads in a folder listing as a mistake.
  {
    check('a JSON object body is recognised',
      D.sniff(Buffer.from('{"id": 69127499, "case_name": "US v. CERTAIN DOMAINS"}')) === 'json');
    check('a JSON array body is recognised too',
      D.sniff(Buffer.from('[{"a":1}]')) === 'json');
    check('a brace that does not parse is NOT called json',
      D.sniff(Buffer.from('{ this is not json at all, really')) === 'unknown');
    check('and a PDF is still a PDF', D.sniff(Buffer.from('%PDF-1.7 ...')) === 'pdf');
    check('a JSON response is saved with a .json extension, not as a bare id',
      D.nameFor('https://www.courtlistener.com/api/rest/v4/dockets/69127499/',
        'application/json') === '69127499.json',
      D.nameFor('https://www.courtlistener.com/api/rest/v4/dockets/69127499/', 'application/json'));
    check('an unrelated host is left alone',
      D.rewriteForMachines('https://lda.gov/filings/public/filing/abc/print/', {}) === null);
    check('a malformed url does not throw',
      D.rewriteForMachines('not a url', {}) === null);

    // The rewrite must change WHICH document is asked for, never what is
    // recorded about it.
    const cliSrc = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
    check('the rewritten target is announced, not swapped in silently',
      /→ \$\{alt\.url\}/.test(cliSrc) && /alt\.why/.test(cliSrc));
    check('and the operator is warned when the key is missing',
      /COURTLISTENER_API_TOKEN is not set/.test(cliSrc));
  }

  // ══ A PLACEHOLDER IS NOT AN ADDRESS ═══════════════════════════════════
  //
  // A command block said `doc get ".../documents/2024/04/22/..."` with `...`
  // meaning "the rest, which you look up". It was pasted verbatim, the server
  // answered with an error page, and this desk saved 10KB of it, hashed it,
  // wrote a provenance row and offered to file it as an exhibit.
  //
  // Six months on that is a hashed document in the evidence tree, with a
  // ledger entry, that says nothing — and nothing on its face separates it
  // from a real record that is merely short. A failed fetch is visible. A
  // hashed error page is camouflage.
  {
    check('an ellipsis placeholder is refused',
      !!D.looksLikePlaceholder('https://www.federalregister.gov/documents/2024/04/22/...'));
    check('angle brackets are refused',
      !!D.looksLikePlaceholder('https://x.gov/<the-file>.pdf'));
    check('and their url-encoded form too, since a shell may encode them',
      !!D.looksLikePlaceholder('https://x.gov/%3Cfile%3E.pdf'));
    check('YOUR_KEY style placeholders are refused',
      !!D.looksLikePlaceholder('https://api.x.gov/v1?key=YOUR_KEY'));
    check('a real URL is not refused',
      D.looksLikePlaceholder('https://lda.gov/filings/public/filing/abc/print/') === null);
    check('a URL with legitimate dots is not mistaken for one',
      D.looksLikePlaceholder('https://www.courtlistener.com/opinion/1/x/') === null);

    const src = fs.readFileSync(path.join(__dirname, 'document.js'), 'utf8');
    check('the refusal happens BEFORE any request is made',
      src.indexOf('looksLikePlaceholder(url)') < src.indexOf("await request('GET'"));
  }

  // ══ HTTP 200 IS NOT A DOCUMENT ════════════════════════════════════════
  {
    const page = Buffer.from('<html><head><title>Page not found</title></head>'
      + '<body>Error 404. The page you requested is not here.</body></html>');
    const flags = D.looksLikeErrorPage(page, 'text/html; charset=utf-8');
    check('a friendly 404 served as HTTP 200 is flagged', !!flags && flags.length >= 1, String(flags));
    check('and the signals are named, so the operator can judge',
      flags.includes('404') || flags.includes('page not found'), String(flags));
    check('a long real page is not flagged for containing the word error',
      D.looksLikeErrorPage(Buffer.from('<html>' + 'x'.repeat(60000) + ' error </html>'),
        'text/html') === null);
    check('a PDF is never checked as an HTML error page',
      D.looksLikeErrorPage(Buffer.from('%PDF-1.4 404 not found'), 'application/pdf') === null);
    check('it FLAGS rather than refusing — the operator decides',
      /THIS LOOKS LIKE THE SITE/.test(fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8')));
  }

  // ══ THE SAME DOCUMENT FETCHED TWICE IS ONE DOCUMENT ═══════════════════
  //
  // Real cost: a 277-page, 26MB seizure-warrant affidavit was fetched twice
  // thirty seconds apart. Two byte-identical files landed in the evidence
  // tree with no warning, and `cat evidence/documents/*docket-entries*` then
  // produced "Extra data: line 1 column 240334" — which reads exactly like a
  // corrupt download and is not one.
  {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
    const body = Buffer.from('%PDF-1.4 AFFIDAVIT IN SUPPORT OF SEIZURE WARRANT');
    const hash = D.sha256(body);
    const first = path.join(dir, `2026-09-04T20-15-35-219Z__${hash.slice(0, 12)}__a.pdf`);
    const second = path.join(dir, `2026-09-04T20-15-54-916Z__${hash.slice(0, 12)}__a.pdf`);
    fs.writeFileSync(first, body);
    fs.writeFileSync(second, body);

    check('the earlier identical copy is found',
      D.findIdenticalSibling(dir, second, hash) === first,
      String(D.findIdenticalSibling(dir, second, hash)));

    check('a file never reports itself as its own duplicate',
      D.findIdenticalSibling(dir, first, hash) === second);

    // A hash PREFIX in a filename is a claim. Two different documents whose
    // hashes share twelve characters must not delete each other, so the full
    // hash is recomputed from disk before anything is called identical.
    const impostor = path.join(dir, `2026-09-04T21-00-00-000Z__${hash.slice(0, 12)}__b.pdf`);
    fs.writeFileSync(impostor, Buffer.from('%PDF-1.4 A COMPLETELY DIFFERENT DOCUMENT'));
    const found = [];
    for (const f of [first, second]) found.push(D.findIdenticalSibling(dir, f, hash));
    check('a filename prefix collision is NOT treated as identical',
      !found.includes(impostor), found.join(', '));

    check('a lone document has no duplicate',
      D.findIdenticalSibling(fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe2-')),
        'nothing.pdf', hash) === null);

    check('the extracted .txt beside a document is never mistaken for it',
      (() => {
        const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe3-'));
        const pdf = path.join(solo, `x__${hash.slice(0, 12)}__a.pdf`);
        fs.writeFileSync(pdf, body);
        fs.writeFileSync(path.join(solo, `x__${hash.slice(0, 12)}__a.txt`), body);
        return D.findIdenticalSibling(solo, pdf, hash) === null;
      })());

    check('doc get removes the duplicate rather than leaving both',
      /findIdenticalSibling/.test(fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8')));
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
