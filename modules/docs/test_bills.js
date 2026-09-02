'use strict';
/**
 * test_bills.js
 *
 * Two failures to guard against, and they pull in opposite directions.
 *
 * A MISSED bill loses a real correlation. A FALSE bill invents one — it links
 * two unrelated filings and reads exactly like a finding. The second is
 * worse, so the matcher is strict and these tests hold it there.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./bills.js');

let PASS = 0, FAIL = 0;
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

module.exports = async function run() {
  console.log('\n  bill correlation\n');

  // ══ 1. THE SPELLINGS A FILING ACTUALLY USES ═══════════════════════════
  {
    const t = 'H.R. 9126, HR9126, H. R. 9126 and h.r. 9126 are one bill.';
    const b = B.billsIn(t);
    ok('four spellings of one bill collapse to one key',
      b.size === 1 && b.has('H.R. 9126'), [...b.keys()].join(', '));

    const kinds = B.billsIn('S. 4207, H.Res. 45, S.Res. 9, H.J.Res. 12, '
      + 'S.J.Res. 7, H.Con.Res. 30, S.Con.Res. 11');
    ok('every chamber and resolution type is recognised',
      kinds.size === 7, [...kinds.keys()].join(' | '));
  }

  // ══ 2. A FALSE BILL IS WORSE THAN A MISSED ONE ════════════════════════
  // A bare single digit after "S." matches a sentence ending in an initial,
  // a page reference, a section number. Linking two filings on that would
  // manufacture a correlation that looks like evidence.
  {
    const noise = 'Signed J. S. 1 above. See page 3. Section 5. Exhibit A. '
      + 'Contact R. 22 Smith. Rule S. 7.';
    const b = B.billsIn(noise);
    ok('single-digit and two-digit noise is not read as a bill',
      ![...b.keys()].some((k) => /^S\. [1-9]$/.test(k)), [...b.keys()].join(', '));

    ok('a real four-digit bill in the same text IS found',
      B.billsIn('nonsense S. 1 but also S. 4207').has('S. 4207'));
  }

  // ══ 3. CONTEXT IS KEPT, BECAUSE A BARE NUMBER IS UNCHECKABLE ══════════
  {
    const b = B.billsIn('Specific lobbying issues: H.R. 9126 regarding data '
      + 'center energy siting in central Ohio.');
    ok('surrounding text is captured so the citation can be checked',
      /data center energy siting/.test(b.get('H.R. 9126')), b.get('H.R. 9126'));
  }

  // ══ 4. PARTIES ════════════════════════════════════════════════════════
  {
    const p = B.partiesIn('LOBBYING REPORT\nRegistrant\tALPINE GROUP PARTNERS, LLC.\n'
      + 'Client\tAWS PUBLIC POLICY, AMERICAS\n');
    ok('the registrant is read out of the filing', /ALPINE GROUP PARTNERS/.test(p.registrant), p.registrant);
    ok('the client is read out of the filing', /AWS PUBLIC POLICY/.test(p.client), p.client);
    const none = B.partiesIn('a page with no such labels');
    ok('a document with no parties yields empty strings, not a crash',
      none.registrant === '' && none.client === '');
  }

  // ══ 5. CORRELATION IS BY CLIENT, NOT BY FILE ══════════════════════════
  // The same filing fetched twice, or a filing and its amendment, is ONE
  // party. Counting files would manufacture a correlation out of one sworn
  // statement.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bills-'));
    const w = (n, client, body) => fs.writeFileSync(path.join(dir, n),
      `Registrant\tALPINE GROUP PARTNERS\nClient\t${client}\n${body}\n`);

    w('one.txt', 'AWS PUBLIC POLICY', 'Issues: H.R. 9126 and S. 4207.');
    w('one-again.txt', 'AWS PUBLIC POLICY', 'Issues: H.R. 9126 amended filing.');
    let docs = B.readDocs(dir);
    let r = B.correlate(docs);
    ok('one client in two files is NOT a correlation',
      r.shared.length === 0, JSON.stringify(r.shared.map((s) => s.bill)));

    w('two.txt', 'ATMOS ENERGY CORPORATION', 'Issues: HR 9126 pipeline siting.');
    docs = B.readDocs(dir);
    r = B.correlate(docs);
    const hr = r.shared.find((s) => s.bill === 'H.R. 9126');
    ok('two different clients on one bill IS a correlation', !!hr);
    ok('and it names both clients',
      hr && hr.clients.length === 2
        && hr.clients.some((c) => /AWS/.test(c))
        && hr.clients.some((c) => /ATMOS/.test(c)), JSON.stringify(hr && hr.clients));
    ok('a bill in only one client\'s filings is not reported as shared',
      !r.shared.some((s) => s.bill === 'S. 4207'),
      r.shared.map((s) => s.bill).join(', '));
  }

  // ══ 6. A DOCUMENT THAT NAMES NO BILL IS STILL COUNTED ═════════════════
  // Dropping it silently reads as "it shares nothing", when the fact may be
  // that extraction failed or it is not a filing at all.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bills2-'));
    fs.writeFileSync(path.join(dir, 'quiet.txt'), 'No bills here.\n');
    fs.writeFileSync(path.join(dir, 'loud.txt'),
      'Client\tX CORP\nIssues: H.R. 9126.\n');
    const r = B.correlate(B.readDocs(dir));
    ok('a document naming no bill is still in the document list',
      r.docs.length === 2, String(r.docs.length));
    ok('and it carries an empty bill set rather than being dropped',
      r.docs.some((d) => d.file === 'quiet.txt' && d.bills.size === 0));
  }

  // ══ 7. AN EMPTY OR MISSING FOLDER IS NOT A CRASH ══════════════════════
  {
    ok('a folder that does not exist yields no documents',
      B.readDocs('/definitely/not/here').length === 0);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bills3-'));
    const r = B.correlate(B.readDocs(empty));
    ok('an empty folder yields no correlations rather than throwing',
      r.shared.length === 0 && r.docs.length === 0);
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
