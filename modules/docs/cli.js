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

async function cmdGet(url, opts) {
  if (!url) {
    console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]\n         sentinel doc bills\n');
    process.exit(2);
  }

  const dir = path.join(R.EVIDENCE, 'documents');
  console.log('\n' + C.b('Fetch document'));
  console.log(`  ${url}`);
  console.log(C.dim(`  → ${dir}/\n`));

  const got = await D.fetchDocument(url, R.request, { dir });
  if (!got.ok) {
    console.error(`  ${C.r('failed:')} ${got.error}\n`);
    process.exit(1);
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
  if (action === 'bills') {
    return cmdBills({});
  }

  console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]\n         sentinel doc bills\n');
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { cmdGet };
