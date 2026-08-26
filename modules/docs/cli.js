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
    console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]\n');
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
      const bills = [...new Set((ex.text.match(/\b(?:H\.?R\.?|S\.?)\s?\d{1,5}\b/g) || []))];
      if (bills.length) {
        // The bill numbers are the reason to open a lobbying filing at all.
        console.log(`\n  ${C.b('Bills named in this document:')} ${bills.slice(0, 12).join(', ')}`
          + (bills.length > 12 ? ` … +${bills.length - 12}` : ''));
      }
    }
  } else {
    console.log(C.dim(`\n  Not a PDF (looks like: ${got.magic}) — saved as fetched, no extraction attempted.`));
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

  console.error('\n  usage: sentinel doc get URL [--case CASE-ID] [--as EX-01]\n');
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { cmdGet };
