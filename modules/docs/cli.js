#!/usr/bin/env node
'use strict';
/**
 * docs/cli.js — `sentinel doc get <url>`
 *
 * Fetches one document, hashes it, extracts its text if it can, and tells you
 * plainly whether the result is readable. Then prints the exact `case add`
 * line to file it as an exhibit, because the whole point is to close the gap
 * between a lead and something the publication gate can weigh.
 */

const fs = require('fs');
const path = require('path');
const D = require('./document.js');
const B = require('./bills.js');
const R = require('../connectors/registry.js');
const P = require('../../core/provenance/provenance.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

function human(n) {
  const u = ['B', 'KB', 'MB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}

/**
 * `sentinel doc gaps FILE.txt` — the paragraphs a filing does not contain.
 *
 * Written after `grep -c -i redact` returned 0 on a 233-page complaint whose
 * paragraphs 159, 160, 162, 163, 164 and 380 are sealed. Those redactions
 * carry no marker at all. The word was the wrong thing to look for; the
 * arithmetic of the numbering is not.
 */
function cmdGaps(file, opts = {}) {
  const G = require('./gaps.js');
  if (!file) {
    console.error('\n  usage: sentinel doc gaps FILE.txt\n');
    process.exit(2);
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    console.error(`\n  cannot read ${file}: ${e.message}\n`);
    process.exit(1);
  }

  const r = G.analyse(text, opts);
  console.log(`\n  ${C.b('NUMBERED PARAGRAPHS')}  ${C.dim(path.basename(file))}`);

  if (!r.found) {
    console.log(C.y('\n  No numbered paragraphs found.'));
    console.log(C.dim('  That is a fact about this text, not about the document: a brief of'));
    console.log(C.dim('  unnumbered prose, a scan with no text layer, and a filing whose'));
    console.log(C.dim('  numbering this pattern does not match all look identical here.\n'));
    return;
  }

  const pct = r.confidence === null ? '?' : `${Math.round(r.confidence * 100)}%`;
  console.log(C.dim(`  ${r.found} paragraph(s) present · numbered ${r.first} to ${r.last}`
    + ` · matcher read ${pct} of that range`));

  // ── CAN THIS MATCHER READ THIS DOCUMENT AT ALL? ───────────────────────
  //
  // First live run: 570 found across 1 to 1,040 and 470 reported missing.
  // That was not a redaction map, it was the matcher's own blind spots
  // printed under a heading the operator would read as "hundreds sealed".
  // A gap list means nothing unless most of the sequence was found.
  if (!r.reliable) {
    console.log(`\n  ${C.r('THIS MATCHER CANNOT READ THIS DOCUMENT\'S NUMBERING.')}`);
    console.log(C.dim(`  It found ${r.found} of the ${r.span} numbers in the range`
      + ` ${r.first}–${r.last}.`));
    console.log(C.dim('  A gap list drawn from that would be mostly this tool\'s blind spots,'));
    console.log(C.dim('  not the document\'s holes — so it is NOT printed.'));
    console.log(C.dim('  No conclusion about redaction can be drawn from this file here.'));
    console.log(C.dim('  Check a page against the PDF and send the paragraph\'s exact'));
    console.log(C.dim('  spacing; the pattern can be fixed for this filing\'s layout.\n'));
    return;
  }

  if (!r.missing.length) {
    console.log(`\n  ${C.g('The sequence is unbroken.')}`);
    console.log(C.dim(`  Every number from ${r.first} to ${r.last} appears, which rules out a`));
    console.log(C.dim('  WHOLE paragraph being sealed. It does not rule out words removed'));
    console.log(C.dim('  from inside one — see below.'));
  } else {
    console.log(`\n  ${C.y(`${r.missing.length} PARAGRAPH(S) ARE NOT IN THIS TEXT`)}`);
    const show = opts.verbose ? r.runs : r.runs.slice(0, 20);
    for (const run of show) {
      const label = run.from === run.to ? `${run.from}` : `${run.from}–${run.to}`;
      console.log(`    ${C.y(label.padEnd(14))}`
        + C.dim(run.count === 1 ? '1 paragraph' : `${run.count} paragraphs`));
    }
    if (!opts.verbose && r.runs.length > 20) {
      console.log(C.dim(`    …and ${r.runs.length - 20} more run(s) (--verbose for all)`));
    }
    console.log('');
    console.log(C.dim('  A GAP IS NOT A REDACTION. It has three causes and this tool chooses'));
    console.log(C.dim('  between none of them:'));
    console.log(C.dim('    1. the passage is SEALED — the case worth opening the page for'));
    console.log(C.dim('    2. the extractor dropped it — a scan, a table, a figure'));
    console.log(C.dim('    3. the filing skipped the number — drafting error, it happens'));
    console.log(C.dim('  Open the page and look before calling it anything.'));
  }

  const white = G.whitedOut(text);
  if (white.length) {
    console.log(`\n  ${C.y(`${white.length} place(s) where words may be missing from INSIDE a paragraph`)}`);
    console.log(C.dim('  A run of spaces mid-sentence. This signal is WEAK — PDF extraction pads'));
    console.log(C.dim('  text for its own reasons — so these are places to look, not findings:'));
    for (const w of white.slice(0, opts.verbose ? 40 : 5)) {
      console.log(C.dim(`    …${w.slice(0, 150)}…`));
    }
    if (!opts.verbose && white.length > 5) {
      console.log(C.dim(`    …and ${white.length - 5} more (--verbose for all)`));
    }
  }
  console.log('');
}

async function cmdGet(url, opts) {
  if (!url) {
    console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]\n         sentinel doc bills\n         sentinel doc gaps FILE.txt\n');
    process.exit(2);
  }

  const dir = path.join(R.EVIDENCE, 'documents');
  console.log('\n' + C.b('Fetch document'));
  console.log(`  ${url}`);
  console.log(C.dim(`  → ${dir}/\n`));

  // Some sources publish a JS shell for humans and the record for machines.
  // Rewriting the URL changes which document is requested; it never changes
  // what is recorded — the capture is the bytes that came back, hashed before
  // anything is derived, and the ledger stores the URL actually called.
  const env = R.loadEnv();
  const alt = D.rewriteForMachines(url, env);
  let target = url;
  let extraHeaders;
  if (alt) {
    console.log(C.dim(`  → ${alt.url}`));
    console.log(C.dim(`    ${alt.why}`));
    if (alt.needsKey) {
      console.log(`    ${C.y('COURTLISTENER_API_TOKEN is not set — this will likely be refused.')}`);
    }
    // Some rewrites reach a RECORD ABOUT a document rather than the document.
    // Saying so at fetch time is the only place it can be said before the
    // file is hashed and starts looking like evidence of something it isn't.
    if (alt.note) console.log(`    ${C.y(alt.note)}`);
    target = alt.url;
    extraHeaders = alt.headers;
  }

  const got = await D.fetchDocument(target, R.request, { dir, headers: extraHeaders });
  if (!got.ok) {
    console.error(`  ${C.r('failed:')} ${got.error}`);

    // A TLS code with no explanation sends the operator to a search engine,
    // and the top answer there is the one that destroys the evidence chain.
    if (got.placeholder) {
      console.error('');
      console.error(`  ${C.y('That URL still has a placeholder in it.')}`);
      console.error(C.dim('  Something like `...`, `<file.pdf>` or `YOUR_KEY` was left in the'));
      console.error(C.dim('  command — it stands for "look this up", not for an address.'));
      console.error(C.dim('  Find the real link and fetch that.'));
      console.error('');
      process.exit(1);
    }

    const tls = D.explainTlsError(got.error);
    if (tls) {
      const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
      console.error('');
      console.error(`  ${C.y('This is a certificate problem, not a missing document.')}`);
      console.error(`  ${C.dim(tls.cause)}`);
      console.error(C.dim(`  ${tls.detail.replace(/\s+/g, ' ')}`));
      console.error('');
      console.error(`  ${C.b('Do NOT set NODE_TLS_REJECT_UNAUTHORIZED=0.')}`);
      console.error(C.dim('  It is the first answer you will find and it works instantly.'));
      console.error(C.dim('  It also turns every later fetch into a file you cannot cite —'));
      console.error(C.dim('  silently, with nothing in the ledger to say so.'));
      console.error('');
      console.error(`  ${C.b('Try these, in order:')}`);
      console.error(C.dim('  1. The same document on another host. Ohio publishes bills on'));
      console.error(C.dim('     ohiohouse.gov and ohiosenate.gov as well as legislature.ohio.gov.'));
      console.error(C.dim('  2. Diagnose the chain, and complete it if that is all it needs:'));
      console.error(`       ${C.g(`bin/sentinel doc chain ${host}`)}`);
      console.error(C.dim('     That writes a PEM of the real chain. Then re-run with it'));
      console.error(C.dim('     trusted — verification stays ON, you have only supplied the'));
      console.error(C.dim('     certificate the server should have sent:'));
      console.error(`       ${C.g('NODE_EXTRA_CA_CERTS=evidence/chains/' + (host || 'HOST') + '.pem \\')}`);
      console.error(`         ${C.g('bin/sentinel doc get "' + url + '"')}`);
      console.error('');
      console.error(C.dim('  If the chain cannot be completed, the honest outcome is that this'));
      console.error(C.dim('  document is not fetchable by this desk. Save it from a browser and'));
      console.error(C.dim('  file it with `doc add` — a hand-saved file with a recorded hash is'));
      console.error(C.dim('  worth more than an automated one with no verified connection.'));
    }
    console.error('');
    process.exit(1);
  }

  // ---- have we already got these exact bytes? ------------------------
  //
  // Real cost: a 26MB, 277-page affidavit fetched twice, thirty seconds
  // apart, wrote two byte-identical copies into the evidence tree. Nothing
  // warned. Later that reads as two documents, and a `cat` across the glob
  // hands the JSON parser two concatenated documents and an "Extra data"
  // error that looks like corruption.
  //
  // The duplicate is only removed when its full sha256 is recomputed from
  // the file already on disk and matches -- a filename hash prefix is a
  // claim, not proof, and nothing gets deleted on a claim.
  try {
    const prior = D.findIdenticalSibling(path.dirname(got.file), got.file, got.sha256);
    if (prior) {
      fs.unlinkSync(got.file);
      got.file = prior;
      console.log('');
      console.log(`  ${C.y('You already had this document — byte-identical.')}`);
      console.log(C.dim(`  Kept  ${path.relative(process.cwd(), prior)}`));
      console.log(C.dim('  The second copy was removed. Two files with one hash is not two'));
      console.log(C.dim('  records, and a `cat` across both breaks any parser you point at it.'));
      console.log(C.dim('  The re-fetch is still logged: the source served the same bytes twice,'));
      console.log(C.dim('  which is a fact worth having about the source.'));
    }
  } catch { /* a dedupe that fails must never cost you the document */ }

  // A server that answers a bad path with HTTP 200 and a friendly error page
  // puts a hashed nothing into the evidence tree — indistinguishable, later,
  // from a real record that happens to be short.
  const errish = D.looksLikeErrorPage(fs.readFileSync(got.file), got.contentType);
  if (errish) {
    console.log('');
    console.log(`  ${C.y('THIS LOOKS LIKE THE SITE\'S ERROR PAGE, NOT A DOCUMENT.')}`);
    console.log(C.dim(`  Signals: ${errish.join(', ')}. The server returned HTTP 200 anyway,`));
    console.log(C.dim('  which is normal and is why the status code cannot be trusted.'));
    console.log(C.dim('  It is saved and hashed — read it before filing it as anything.'));
    console.log(C.dim(`    rm "${got.file}"    if it is what it looks like`));
    console.log('');
  }

  console.log(`  ${C.g('saved')}   ${path.relative(process.cwd(), got.file)}`);
  console.log(`  ${C.dim('sha256')}  ${got.sha256}`);
  console.log(`  ${C.dim('size')}    ${human(got.bytes)}  ${C.dim(got.contentType || 'type unknown')}`);

  let pages = null;
  let readable = null;
  let textPath = null;

  if (got.isPdf) {
    const ex = D.extractText(got.file);
    if (!ex.available) {
      console.log(`\n  ${C.y('Text not extracted.')} ${ex.reason}`);
      console.log(C.dim(`    ${ex.install}`));
      console.log(C.dim('  The document is saved and hashed either way — only the text is missing.'));
    } else if (!ex.ok) {
      console.log(`\n  ${C.y('Extraction failed.')} ${ex.reason}`);
    } else {
      pages = ex.pages;
      const txt = got.file.replace(/\.[^.]*$/, '') + '.txt';
      fs.writeFileSync(txt, ex.text);
      textPath = txt;
      console.log(`  ${C.dim('pages')}   ${ex.pages === null ? 'unknown' : ex.pages}`);
      console.log(`  ${C.g('text')}    ${path.relative(process.cwd(), txt)}  `
        + C.dim(`${ex.chars.toLocaleString()} chars`
          + (ex.charsPerPage !== null ? ` · ${ex.charsPerPage}/page` : '')));

      if (ex.empty || ex.likelyScanned) {
        readable = false;
        console.log(`\n  ${C.y('THIS DOCUMENT IS ALMOST CERTAINLY A SCAN.')}`);
        console.log(C.dim(`  ${ex.charsPerPage === null ? 'No text came out' : `${ex.charsPerPage} characters per page`}`
          + ` — a real page of a filing runs into the thousands.`));
        console.log(C.dim('  It will match no search and read as "not mentioned" forever.'));
        console.log(C.dim('  To make it searchable:'));
        console.log(C.dim(`    ocrmypdf "${got.file}" "${got.file.replace(/\.pdf$/i, '')}_ocr.pdf"`));
        console.log(C.dim('    (brew install ocrmypdf)'));
      } else {
        readable = true;
      }
    }
  } else if (got.zipMislabelled) {
    readable = false;
    console.log(`\n  ${C.r('THIS IS A ZIP ARCHIVE WEARING A .pdf NAME.')}`);
    console.log(C.dim('  Records portals serve bundles of page images this way. pdftotext,'));
    console.log(C.dim('  grep and every keyword search return nothing regardless of content —'));
    console.log(C.dim('  and a null result on a file like this is NOT evidence of absence.'));
    console.log(C.dim('  Unpack and OCR it:'));
    console.log(C.dim(`    bin/sentinel corpus ocr "${path.dirname(got.file)}" --out "${path.dirname(got.file)}_derived"`));
  } else if (got.magic === 'html') {
    // The Senate LDA serves filings as HTML. Those are the strongest records
    // this desk handles, and "no extraction attempted" left them on disk
    // unsearchable -- which six months later reads exactly like a record that
    // says nothing.
    const ex = D.extractHtmlText(fs.readFileSync(got.file));
    const txt = got.file.replace(/\.[^.]*$/, '') + '.txt';
    fs.writeFileSync(txt, ex.text);
    textPath = txt;
    console.log(`  ${C.g('text')}    ${path.relative(process.cwd(), txt)}  `
      + C.dim(`${ex.chars.toLocaleString()} chars`));
    if (ex.likelyEmpty) {
      readable = false;
      console.log(`\n  ${C.y('THIS PAGE CARRIED ALMOST NO TEXT.')}`);
      console.log(C.dim(`  ${ex.chars} characters — a real filing runs into the thousands.`));
      console.log(C.dim('  Likely a nav shell, an error page, or a document that renders'));
      console.log(C.dim('  from JavaScript. It is saved and hashed, but it is not the record.'));
    } else {
      readable = true;
    }
  } else {
    console.log(C.dim(`\n  Not a PDF (looks like: ${got.magic}) — saved as fetched, no extraction attempted.`));
  }

  // ---- what legislation this document names ---------------------------
  //
  // This used to be a second, looser regex written inline here -- bare "S."
  // plus a single digit, no canonical spelling. So `doc get` and `doc bills`
  // could disagree about the same file on disk, and the one the operator read
  // first was the careless one. Worse, it only ran on the HTML branch: fetch a
  // filing as a PDF and the single most useful line never printed at all.
  //
  // Both now ask bills.js, which is the module that has actually thought about
  // what a bill designation looks like.
  if (readable === true && textPath) {
    let text = '';
    try { text = fs.readFileSync(textPath, 'utf8'); } catch { /* printed below */ }
    const found = [...B.billsIn(text).keys()];

    if (found.length) {
      console.log(`\n  ${C.b('Bills named in this document:')} ${found.slice(0, 12).join(', ')}`
        + (found.length > 12 ? ` … +${found.length - 12}` : ''));
      console.log(C.dim('  A named bill is what the registrant swore it lobbied on. It does not'));
      console.log(C.dim('  say which side. To see who else named the same bill:'));
      console.log(C.dim('    bin/sentinel doc bills'));
    } else if (text) {
      // "No bills" is an assertion the operator cannot check, and it has two
      // very different causes: a filing that genuinely describes its work in
      // prose, or a matcher that missed the format. Showing the filing's own
      // issue text separates them -- and a filing whose entire description is
      // "Energy and tax issues generally" is itself the finding.
      const issue = B.issueTextIn(text);
      console.log(`\n  ${C.y('No bill designation appears in this document.')}`);
      if (issue) {
        console.log(C.dim('  What it says it lobbied on, in its own words:'));
        console.log(C.dim(`    ${issue.slice(0, 240)}`));
      } else {
        console.log(C.dim('  And no lobbying-issue field was found either — check the text file'));
        console.log(C.dim('  yourself before treating this as a document that names nothing.'));
      }
    }
  }

  // ---- provenance ----------------------------------------------------
  try {
    const ledger = new P.Ledger(R.LEDGER);
    ledger.append(P.makeRecord({
      kind: 'document_fetch',
      artifactId: got.sha256.slice(0, 16),
      label: `document: ${url}`,
      tool: 'sentinel doc get',
      toolVersion: R.VERSION,
      tier: 'GREEN',
      sha256: got.sha256,
      localPath: got.file,
      evidenceRoot: R.EVIDENCE,
      sourceUrl: url,
      extra: {
        content_type: got.contentType,
        bytes: got.bytes,
        pages,
        magic: got.magic,
        zip_mislabelled: got.zipMislabelled === true,
        text_extracted: readable === true,
        likely_scanned: readable === false && !got.zipMislabelled,
        result_disposition: 'primary_source_document',
      },
    }));
    console.log(C.dim(`\n  ledger  evidence/manifests/provenance.jsonl`));
  } catch (e) {
    console.log(C.y(`\n  ledger not written: ${e.message}`));
  }

  // ---- what to do with it --------------------------------------------
  const caseId = opts.caseId || 'CASE-ID';
  const exId = opts.as || 'EX-01';
  console.log(`\n  ${C.b('File it as an exhibit:')}`);
  console.log(`    bin/sentinel case add ${caseId} ${exId} "${got.file}"`
    + (pages ? ` --pages ${pages}` : ''));
  if (pages) {
    console.log(C.dim(`    bin/sentinel case read ${caseId} ${exId} ${pages}   `)
      + C.dim('# only after you have actually read it'));
  }
  console.log(C.dim('\n  Fetching is not reading. The gate counts pages you have marked read,'));
  console.log(C.dim('  and it is the only thing standing between a lead and a published claim.\n'));
}

function cmdBills(opts) {
  const B = require('./bills.js');
  const dir = path.join(R.EVIDENCE, 'documents');
  const docs = B.readDocs(dir);

  console.log('\n' + C.b('Bills named across the documents you have fetched'));
  console.log(C.dim(`  ${dir}\n`));

  if (!docs.length) {
    console.log('  No extracted text in that folder yet.');
    console.log(C.dim('  Fetch a filing first:  bin/sentinel doc get URL\n'));
    return;
  }

  const { shared, docs: seen } = B.correlate(docs);
  const withBills = seen.filter((d) => d.bills.size);
  console.log(C.dim(`  ${seen.length} document(s) · ${withBills.length} naming at least one bill\n`));

  // A document that names no bill is reported, not skipped. Silence about it
  // reads as "it shares nothing", when the fact may be that it never
  // extracted or is not a filing at all.
  const silent = seen.filter((d) => !d.bills.size);
  if (silent.length) {
    console.log(C.dim(`  ${silent.length} document(s) name no bill at all. What they say instead:`));
    for (const d of silent.slice(0, 4)) {
      console.log(C.dim(`    ${d.file}`));
      const issue = B.issueTextIn(d.text);
      // "0 bills in 13,000 characters" is unfalsifiable on its own. Either
      // the filing cites no legislation -- common, many describe issues in
      // prose -- or the matcher missed a format, and only one of those is a
      // bug. The text decides.
      console.log(C.dim(`      ${issue ? issue.slice(0, 200) : '(no lobbying-issues section found)'}`));
    }
    if (silent.length > 4) console.log(C.dim(`    … and ${silent.length - 4} more`));
    console.log('');
  }

  if (!shared.length) {
    console.log('  ' + C.y('No bill appears in more than one client\'s filing yet.'));
    console.log(C.dim('  That is a fact about what you have fetched, not about the record.'));
    console.log(C.dim('  Fetch more filings and run this again.\n'));
    return;
  }

  for (const s of shared) {
    console.log(`  ${C.b(s.bill)}  ${C.dim(`— ${s.clients.length} clients`)}`);
    for (const h of s.hits) {
      const who = h.doc.client || h.doc.file;
      const by = h.doc.registrant ? C.dim(`  (filed by ${h.doc.registrant})`) : '';
      console.log(`    ${who}${by}`);
      console.log(C.dim(`      …${h.context.slice(0, 150)}…`));
    }
    console.log('');
  }

  console.log(C.b('  What this establishes, and what it does not.'));
  console.log(C.dim('  Both parties told Congress under 2 U.S.C. 1603–1604 that they'));
  console.log(C.dim('  lobbied on that bill. That is two sworn statements about one object,'));
  console.log(C.dim('  not a co-occurrence.'));
  console.log(C.dim('\n  It does NOT establish that they took the same side. A filing names'));
  console.log(C.dim('  the bill; it does not say for or against. Opposing parties appear on'));
  console.log(C.dim('  the same bill in the same quarter as a matter of routine — reporting'));
  console.log(C.dim('  a shared bill as an alignment is the easiest way to publish something'));
  console.log(C.dim('  false out of accurate records.\n'));
}

/**
 * `sentinel doc chain HOST` — why the handshake failed, and a PEM that fixes
 * it without switching verification off.
 */
async function cmdChain(host) {
  if (!host) {
    console.error('\n  usage: sentinel doc chain HOST     (e.g. www.legislature.ohio.gov)\n');
    process.exit(2);
  }
  const CH = require('./chain.js');
  const dir = path.join(R.EVIDENCE, 'chains');

  console.log('\n' + C.b('Certificate chain'));
  console.log(`  ${host}\n`);

  const r = await CH.complete(host, { dir });
  if (!r.ok) {
    console.error(`  ${C.r('could not connect:')} ${r.error}\n`);
    process.exit(1);
  }

  console.log(`  ${C.dim('subject')}   ${r.subject}`);
  console.log(`  ${C.dim('issuer')}    ${r.issuer}`);
  console.log(`  ${C.dim('expires')}   ${r.validTo}`);
  console.log(`  ${C.dim('served')}    ${r.served} certificate(s)`);
  console.log('');

  if (r.authorized) {
    console.log(`  ${C.g('This chain already verifies.')}`);
    console.log(C.dim('  Whatever failed was not this host\'s certificate. Re-read the error.'));
    console.log('');
    return;
  }

  console.log(`  ${C.y('NOT verified:')} ${r.reason || 'unknown'}`);
  if (r.intermediateMissing) {
    console.log(C.dim('  The server sent its own certificate and nothing else, and that'));
    console.log(C.dim('  certificate did not sign itself. The intermediate is missing —'));
    console.log(C.dim('  a server misconfiguration, and a common one on records portals.'));
  }
  console.log('');

  if (r.fetched.length) {
    console.log(`  ${C.g('Fetched the missing certificate(s) the server should have sent:')}`);
    for (const f of r.fetched) console.log(C.dim(`    ${f.url}`));
    console.log('');
  }

  if (r.written) {
    console.log(`  ${C.dim('wrote')}     ${path.relative(process.cwd(), r.written)}  ${C.dim(`${r.certificates} certificate(s)`)}`);
    console.log('');
    console.log(`  ${C.b('Re-run the fetch with that chain trusted:')}`);
    console.log(`    ${C.g(`NODE_EXTRA_CA_CERTS="${r.written}" \\`)}`);
    console.log(`      ${C.g('bin/sentinel doc get "https://' + host + '/..."')}`);
    console.log('');
    console.log(C.dim('  Verification stays ON. You have supplied the certificate the server'));
    console.log(C.dim('  should have sent — exactly what a browser does — and nothing is'));
    console.log(C.dim('  bypassed. If the fetch still fails, the chain genuinely does not'));
    console.log(C.dim('  reach a trusted root, and that is a real answer rather than a'));
    console.log(C.dim('  problem to route around.'));
  } else {
    console.log(`  ${C.y('No completion could be built.')}`);
    console.log(C.dim('  The certificate publishes no issuer URL, or it could not be fetched.'));
    console.log(C.dim('  Save the document from a browser and file it with its hash instead.'));
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && argv[i - 1].startsWith('--') && !a.startsWith('--')) return false;
    return true;
  });

  if (action === 'get') {
    return cmdGet(positional[1], { caseId: val('--case'), as: val('--as') });
  }
  if (action === 'gaps') {
    return cmdGaps(positional[1], { verbose: argv.includes("--verbose") });
  }
  if (action === 'bills') {
    return cmdBills({});
  }
  if (action === 'chain') {
    return cmdChain(positional[1]);
  }

  console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]'
    + '\n         sentinel doc bills'
    + '\n         sentinel doc gaps FILE.txt'
    + '\n         sentinel doc chain HOST\n');
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { cmdGet, cmdChain };
