#!/usr/bin/env node
/**
 * test_sec.js -- the filing history, tested against the ways it lies.
 *
 * Two of these tests exist because the one-liner that preceded this module
 * had the bugs they check for, and on the entity it was written for NEITHER
 * bug was visible. That is the whole point: a reader who tests on one small
 * issuer concludes the code is correct.
 */
'use strict';

const S = require('./sec.js');

let PASS = 0; let FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS += 1; console.log(`    PASS  ${label}`); return; }
  FAIL += 1;
  console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}

console.log('\n  sec filing history\n');

// ══ A CIK, OR A REFUSAL ══════════════════════════════════════════════════
check('a bare number is padded to ten digits',
  S.normalizeCik('1577459').cik === '0001577459', JSON.stringify(S.normalizeCik('1577459')));
check('an already-padded one is unchanged',
  S.normalizeCik('0001577459').cik === '0001577459');
check('the CIK prefix is accepted, since that is how EDGAR writes it',
  S.normalizeCik('CIK0001577459').cik === '0001577459');
check('and lower case, and a .json suffix copied off a saved capture',
  S.normalizeCik('cik0001577459.json').cik === '0001577459');
check('surrounding whitespace does not defeat it',
  S.normalizeCik('  1577459 ').cik === '0001577459');

// A COMPANY NAME IS THE DANGEROUS INPUT. Stripping its letters leaves
// nothing, and nothing padded to ten digits is CIK0000000000 -- a real URL
// that answers 404, which reads as "this company does not file".
{
  const r = S.normalizeCik('Ohio Power Company');
  check('a company name is refused, not silently turned into CIK0000000000',
    !r.cik && !!r.error, JSON.stringify(r));
  check('and the refusal says how to find the number instead',
    /connect sec/.test(r.suggestion || ''), r.suggestion);
}
check('an empty input is refused', !S.normalizeCik('').cik);
check('eleven digits is refused rather than truncated',
  !S.normalizeCik('12345678901').cik);

check('the submissions URL is the data.sec.gov one',
  S.submissionsUrl('0001577459')
    === 'https://data.sec.gov/submissions/CIK0001577459.json');

// ══ THE URL OF ONE FILING ════════════════════════════════════════════════
//
// Dashes come OUT of the directory name and stay IN the index filename, and
// /Archives/ uses the CIK with leading zeros stripped. Get any of it wrong
// and every URL 404s, which reads as a removed document.
check('a filing URL matches the real EDGAR path',
  S.filingUrl('0001577459', '0001577459-19-000009', 'opirform10d-06x2019.htm')
    === 'https://www.sec.gov/Archives/edgar/data/1577459/000157745919000009/opirform10d-06x2019.htm',
  S.filingUrl('0001577459', '0001577459-19-000009', 'opirform10d-06x2019.htm'));
check('leading zeros are stripped from the archives path',
  !/data\/0+1577459/.test(S.filingUrl('0001577459', '0001577459-19-000009', 'x.htm')));
check('with no primary document it returns the accession INDEX, a real page',
  S.filingUrl('0001577459', '0001577459-13-000012', '')
    === 'https://www.sec.gov/Archives/edgar/data/1577459/000157745913000012/0001577459-13-000012-index.htm',
  S.filingUrl('0001577459', '0001577459-13-000012', ''));

// ══ THE FIXTURE ══════════════════════════════════════════════════════════
// Shaped like the real submissions record, trimmed to what is tested.
const FIX = {
  cik: '1577459',
  name: 'Ohio Phase-In-Recovery Funding LLC',
  sic: '4911',
  sicDescription: 'Electric Services',
  entityType: 'other',
  stateOfIncorporation: 'DE',
  tickers: [],
  formerNames: [{ name: 'OPCo Phase-In-Recovery Funding LLC', from: '2013-05-22', to: '2013-07-09' }],
  filings: {
    recent: {
      form:             ['15-15D', '10-D', '10-K', '10-D', '10-D', 'EFFECT'],
      filingDate:       ['2019-09-10', '2019-07-01', '2019-04-01', '2019-01-03', '2018-07-02', '2013-07-12'],
      accessionNumber:  ['0001577459-19-000012', '0001577459-19-000009', '0001577459-19-000007',
                         '0001577459-19-000003', '0001577459-18-000006', '9999999995-13-002071'],
      primaryDocument:  ['a2019-09form15xohiophasexi.htm', 'opirform10d-06x2019.htm',
                         'ohiopirf201810k.htm', 'opirform10d-12x2018.htm',
                         'opirform10d-06x2018.htm', ''],
      reportDate:       ['', '2019-06-30', '2018-12-31', '2018-12-31', '2018-06-30', ''],
      primaryDocDescription: ['FORM 15', 'FORM 10-D', 'FORM 10-K', 'FORM 10-D', 'FORM 10-D', ''],
    },
    files: [],
  },
};

// ══ NOTHING IS DROPPED ═══════════════════════════════════════════════════
//
// The one-liner did `if not doc: continue`, which removed the EFFECT filing
// -- silently, with no line saying a row had been removed. On the entity it
// was written for nothing was dropped and the bug was invisible.
{
  const p = S.parseSubmissions(FIX);
  check('the record parses', p.ok === true, p.error);
  check('every filing is present, including the one with no primary document',
    p.filings.length === 6, `got ${p.filings.length}`);
  const eff = p.filings.find((f) => f.form === 'EFFECT');
  check('the document-less filing is kept, not skipped', !!eff);
  check('and it gets the accession index, which is a real fetchable page',
    eff && /-index\.htm$/.test(eff.url), eff && eff.url);
  check('it is marked as having no primary document, so a caller can say so',
    eff && eff.hasPrimaryDocument === false);
  check('filings come back oldest first, which is how a history reads',
    p.filings[0].date === '2013-07-12'
    && p.filings[p.filings.length - 1].date === '2019-09-10',
    `${p.filings[0].date} .. ${p.filings[p.filings.length - 1].date}`);
  check('the entity name travels with it', p.name === 'Ohio Phase-In-Recovery Funding LLC');
  check('so does the state of incorporation', p.stateOfIncorporation === 'DE');
  check('a FORMER NAME is surfaced — an entity that renamed is a lead',
    p.formerNames.length === 1
    && /OPCo Phase-In-Recovery/.test(p.formerNames[0].name),
    JSON.stringify(p.formerNames));
  check('nothing is truncated for this small issuer',
    p.truncated === false && p.countIsFloor === false);
}

// ══ THE CAP THAT LOOKS LIKE A COUNT ══════════════════════════════════════
//
// A large filer's older filings live in separate JSON files. Same shape, no
// error -- so "34 filings, 2013 to 2019" silently becomes the most recent
// page for a company that has filed since the 1940s.
{
  const big = JSON.parse(JSON.stringify(FIX));
  big.filings.files = [
    { name: 'CIK0001577459-submissions-001.json',
      filingCount: 1043, filingFrom: '1994-02-01', filingTo: '2013-05-21' },
  ];
  const p = S.parseSubmissions(big);
  check('additional filing files are DETECTED', p.truncated === true);
  check('and the shown count is flagged as a floor, not a total',
    p.countIsFloor === true);
  check('the older file is named with its date range',
    p.moreFiles[0].from === '1994-02-01' && p.moreFiles[0].count === 1043,
    JSON.stringify(p.moreFiles));
  check('and given a fetchable URL, so the rest is reachable',
    p.moreFiles[0].url
      === 'https://data.sec.gov/submissions/CIK0001577459-submissions-001.json',
    p.moreFiles[0].url);
}

// ══ UNKNOWN IS NOT ZERO ══════════════════════════════════════════════════
{
  check('a non-object is refused', S.parseSubmissions(null).ok === false);
  const noFilings = S.parseSubmissions({ cik: '1577459', name: 'X' });
  check('a record with no filings block is refused, not read as no filings',
    noFilings.ok === false && /not an EDGAR submissions record/.test(noFilings.error),
    noFilings.error);
  const empty = S.parseSubmissions({ cik: '1', name: 'X', filings: { recent: {} } });
  check('a malformed recent block says UNKNOWN rather than printing nothing',
    empty.ok === false && /UNKNOWN/.test(empty.error), empty.error);
}

// ══ DEREGISTRATION IS A FILING, NOT A CONCLUSION ═════════════════════════
{
  const p = S.parseSubmissions(FIX);
  const d = S.deregistrations(p.filings);
  check('the Form 15 is found by form type', d.length === 1 && d[0].form === '15-15D');
  check('with its date, which is the fact that matters',
    d[0].date === '2019-09-10');
  check('and its own URL, so the operator reads the form and not a summary',
    /a2019-09form15xohiophasexi\.htm$/.test(d[0].url), d[0].url);
  check('every Form 15 variant is recognised',
    ['15', '15-12B', '15-12G', '15-15D', '15F-12B'].every(
      (f) => S.DEREGISTRATION_FORMS.has(f)));
  check('a 10-K is not mistaken for one',
    S.deregistrations([{ form: '10-K', date: 'x' }]).length === 0);
}

// ══ HOW OFTEN, AND HOW LONG AGO ══════════════════════════════════════════
{
  const p = S.parseSubmissions(FIX);
  const rows = S.summarize(p.filings, '2026-09-08');
  const tenD = rows.find((r) => r.form === '10-D');
  check('the 10-D series is counted', tenD.count === 3, String(tenD.count));
  check('its first and last dates are reported',
    tenD.first === '2018-07-02' && tenD.last === '2019-07-01',
    `${tenD.first}..${tenD.last}`);
  check('a semiannual filer shows a ~183-day typical gap',
    tenD.typicalGap >= 180 && tenD.typicalGap <= 186, String(tenD.typicalGap));
  check('and how long it has been since the last one',
    tenD.sinceLast > 2600, String(tenD.sinceLast));

  const k = rows.find((r) => r.form === '10-K');
  check('a form with ONE filing gets no typical gap — one interval is not a pattern',
    k.typicalGap === null, String(k.typicalGap));

  // There is deliberately no `stopped` flag. See summarize().
  check('nothing in the summary concludes that a series stopped',
    rows.every((r) => !('stopped' in r)), JSON.stringify(rows[0]));
  check('rows come back busiest first, so the periodic series leads',
    rows[0].count >= rows[rows.length - 1].count);
}

// ══ THE RENDERER, ACTUALLY RUN ═══════════════════════════════════════════
//
// Every check above tests the data. None of them would have caught a crash
// or a swallowed section in the printing, and a renderer that has never been
// run against real data is a renderer nobody has checked. So the CLI is
// executed, on a fixture shaped like the entity this was built for.
{
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const rows = [
    ['2013-05-22', 'S-3', '0000905148-13-000580', 'efc13-364_fms3.htm'],
    ['2013-07-12', 'EFFECT', '9999999995-13-002071', ''],
    ['2013-07-25', '424B5', '0000905148-13-000756', 'efc13-468_fm424b5.htm'],
    ['2014-07-01', '10-D', '0000004904-14-000083', 'form10d062014.htm'],
    ['2015-01-05', '10-D', '0001577459-15-000002', 'form10d122014.htm'],
    ['2015-07-01', '10-D', '0001577459-15-000008', 'form10d072015.htm'],
    ['2019-07-01', '10-D', '0001577459-19-000009', 'opirform10d-06x2019.htm'],
    ['2019-09-10', '15-15D', '0001577459-19-000012', 'a2019-09form15xohiophasexi.htm'],
  ];
  const fixture = {
    cik: '1577459',
    name: 'Ohio Phase-In-Recovery Funding LLC',
    sic: '4911',
    sicDescription: 'Electric Services',
    entityType: 'other',
    stateOfIncorporation: 'DE',
    formerNames: [{ name: 'OPCo Phase-In-Recovery Funding LLC', from: '2013-05-22', to: '2013-07-09' }],
    filings: {
      recent: {
        form: rows.map((r) => r[1]),
        filingDate: rows.map((r) => r[0]),
        accessionNumber: rows.map((r) => r[2]),
        primaryDocument: rows.map((r) => r[3]),
        reportDate: rows.map(() => ''),
        primaryDocDescription: rows.map(() => ''),
      },
      files: [{ name: 'CIK0001577459-submissions-001.json',
                filingCount: 400, filingFrom: '1994-01-01', filingTo: '2013-05-21' }],
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sec-'));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(fixture));

  const strip = (t) => t.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const run = (args) => strip(execFileSync(process.execPath,
    [path.join(__dirname, 'sec_cli.js')].concat(args), { encoding: 'utf8' }));

  const out = run(['history', '1577459', '--from', file]);
  check('the CLI runs on a real-shaped record without throwing', out.length > 200);
  check('it names the entity', /Ohio Phase-In-Recovery Funding LLC/.test(out));
  check('it prints the Form 15 under its own heading',
    /REPORTING ENDED[\s\S]*15-15D\s+2019-09-10/.test(out));
  check('and refuses to let a Form 15 read as "the bonds were paid"',
    /does not say securities were/.test(out));
  check('the truncation warning is SHOWN, not just computed',
    /THIS IS NOT THE WHOLE HISTORY/.test(out));
  check('with a command to reach the older filings',
    /doc get "https:\/\/data\.sec\.gov\/submissions\/CIK0001577459-submissions-001\.json"/.test(out));
  check('the document-less filing is visible in the timeline, flagged',
    /EFFECT/.test(out) && /this is the filing index/.test(out));
  check('a former name is printed — the lead is not buried in the data',
    /FORMERLY[\s\S]*OPCo Phase-In-Recovery/.test(out));
  check('reading a file does NOT claim a ledger write',
    !/ledger  evidence/.test(out), out.split('\n').filter((l) => /ledger/.test(l)).join(' | '));
  check('and says so plainly', /nothing written to the ledger/.test(out));

  const only = run(['history', '1577459', '--form', '10-D', '--from', file]);
  check('--form narrows the timeline', (only.match(/10-D/g) || []).length >= 4
    && !/TIMELINE[\s\S]*15-15D\s+https/.test(only));

  const lim = run(['history', '1577459', '--limit', '2', '--from', file]);
  check('--limit clips the timeline',
    /earlier filing\(s\) not shown/.test(lim), lim.slice(-400));
  check('and says a limit is not a count', /A limit is not a count/.test(lim));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
process.exit(FAIL ? 1 : 0);
