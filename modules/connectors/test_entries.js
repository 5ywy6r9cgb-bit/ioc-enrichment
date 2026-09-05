#!/usr/bin/env node
'use strict';
/**
 * test_entries.js — the disposition reader must never merge a settlement
 * with a surrender.
 */
const fs = require('fs');
const E = require('./entries.js');

let PASS = 0; let FAIL = 0;
function check(name, cond, got) {
  if (cond) { PASS += 1; console.log(`    PASS  ${name}`); }
  else { FAIL += 1; console.log(`    FAIL  ${name}${got === undefined ? '' : `  (${got})`}`); }
}

console.log('\n  entries — how a case ended\n');

// ══ 1. THE TWO PHRASES THAT MUST NEVER MERGE ═════════════════════════
//
// "Stipulated Final Judgment and Order" is a settlement the defendant
// paid for. "Notice of Voluntary Dismissal" is the government giving up.
// Both contain dismissal-adjacent language. Merging them would turn an
// enforcement record into its opposite.
{
  const settle = E.signalsIn('STIPULATED FINAL JUDGMENT AND ORDER as to Defendant');
  check('a stipulated final judgment is CONSENT',
    settle.length === 1 && settle[0].family === 'CONSENT', JSON.stringify(settle));

  const walk = E.signalsIn('NOTICE of Voluntary Dismissal by Consumer Financial Protection Bureau');
  check('a notice of voluntary dismissal is VOLUNTARY',
    walk.some((s) => s.family === 'VOLUNTARY'), JSON.stringify(walk));
  check('and it never also reads as CONSENT',
    !walk.some((s) => s.family === 'CONSENT'), JSON.stringify(walk));

  // The word "consent" inside a voluntary dismissal must not flip it.
  const both = E.signalsIn('Notice of Voluntary Dismissal; Consent Order vacated');
  check('a docket naming BOTH is reported as both, not silently picked',
    new Set(both.map((s) => s.family)).size === 2, JSON.stringify(both.map((s) => s.family)));
}

// ══ 2. THE MATCHED PHRASE TRAVELS WITH THE LABEL ═════════════════════
//
// A category name alone cannot be checked. The substring that fired it
// can, without opening the docket.
{
  const s = E.signalsIn('ORDER granting Defendant\'s Motion to Dismiss the amended complaint');
  check('a court dismissal is COURT', s.some((x) => x.family === 'COURT'), JSON.stringify(s));
  check('and carries the phrase it matched on',
    s.some((x) => /motion to dismiss/i.test(x.phrase)), JSON.stringify(s.map((x) => x.phrase)));
}

// ══ 3. PREJUDICE IS ORTHOGONAL, AND USUALLY ABSENT ═══════════════════
{
  check('without prejudice is read', E.prejudice('dismissed without prejudice') === 'WITHOUT');
  check('with prejudice is read', E.prejudice('dismissed with prejudice') === 'WITH');
  // The single most important default on this desk: silence is UNSTATED,
  // never assumed either way. A dismissal without prejudice can be
  // refiled; guessing that from silence invents the difference.
  check('and silence is UNSTATED, not assumed',
    E.prejudice('Notice of Voluntary Dismissal') === 'UNSTATED');
  check('both stated is its own answer',
    E.prejudice('Count I with prejudice, Count II without prejudice') === 'BOTH STATED');
}

// ══ 4. THE LAST ENTRY IS OFTEN THE PAPERWORK, NOT THE RULING ═════════
{
  const entries = [
    { date_filed: '2025-04-14', entry_number: 31, description: 'Civil Case Terminated' },
    { date_filed: '2025-04-11', entry_number: 30,
      description: 'NOTICE of Voluntary Dismissal by Consumer Financial Protection Bureau' },
  ];
  const d = E.disposition(entries);
  check('a window finds the ruling behind the administrative entry',
    d.verdict === 'VOLUNTARY', JSON.stringify({ v: d.verdict, f: d.families }));
  check('and reports how many entries it actually looked at',
    d.scanned === 2 && d.available === 2, JSON.stringify({ s: d.scanned, a: d.available }));

  // Reading ONLY the last entry is the bug this window exists to prevent.
  const lastOnly = E.disposition(entries, { window: 1 });
  check('reading only the last entry finds nothing, and says so',
    lastOnly.verdict === 'UNCLASSIFIED', lastOnly.verdict);
  check('and a truncated window is flagged as truncated',
    lastOnly.windowed === true);
}

// ══ 5. THREE KINDS OF "NO ANSWER", NEVER MERGED ══════════════════════
//
// UNREAD (could not fetch), UNCLASSIFIED (fetched, nothing matched) and
// AMBIGUOUS (fetched, several families matched) look identical in a
// summary table and mean completely different things.
{
  check('no entries at all is UNREAD', E.disposition([]).verdict === 'UNREAD');
  check('entries with nothing dispositive is UNCLASSIFIED',
    E.disposition([{ description: 'Minute entry for proceedings held before Judge' }])
      .verdict === 'UNCLASSIFIED');
  const amb = E.disposition([
    { description: 'Stipulated Final Judgment and Order' },
    { description: 'Notice of Voluntary Dismissal' },
  ]);
  check('two families is AMBIGUOUS, not a coin flip',
    amb.verdict === 'AMBIGUOUS' && amb.families.length === 2, JSON.stringify(amb.families));

  const t = E.tally([
    { verdict: 'VOLUNTARY' }, { verdict: 'VOLUNTARY' }, { verdict: 'CONSENT' },
    { verdict: 'UNREAD' }, { verdict: 'UNCLASSIFIED' }, { verdict: 'AMBIGUOUS' },
  ]);
  check('the tally keeps UNREAD out of the classified count',
    t.classified === 3 && t.total === 6, JSON.stringify(t));
  check('and keeps it out of the readable count too',
    t.readable === 5, String(t.readable));
}

// ══ 6. DOCUMENT DESCRIPTIONS COUNT, NOT JUST THE ENTRY LINE ══════════
//
// District clerks often leave the entry line bare and put the real title
// on the attached document.
{
  const e = { description: '', recap_documents: [
    { description: 'Notice of Voluntary Dismissal Pursuant to Rule 41(a)(1)(A)(i)' }] };
  check('an attached document\'s title is read',
    E.disposition([e]).verdict === 'VOLUNTARY');
  check('and Rule 41(a) is recognised on its own',
    E.signalsIn('Pursuant to Rule 41(a)(1)(A)(i)').some((s) => s.family === 'VOLUNTARY'));
}

// ══ 7. A FAILED FETCH IS NEVER A DISPOSITION ═════════════════════════
{
  const url = E.firstPageUrl(69442801);
  check('the entries URL asks for one docket, newest first',
    /docket=69442801/.test(url) && /order_by=-date_filed/.test(url), url);

  Promise.resolve()
    .then(() => E.readDocket(1, { request: async () => ({ status: 429, body: Buffer.from('') }) }))
    .then((r) => {
      check('a rate-limited docket is UNREAD, not UNCLASSIFIED',
        r.verdict === 'UNREAD' && r.ok === false, JSON.stringify({ v: r.verdict, e: r.error }));
      check('and says the HTTP status that stopped it', /429/.test(r.error || ''), r.error);
      return E.readDocket(2, { request: async () => ({ status: 200, body: Buffer.from('not json') }) });
    })
    .then((r) => {
      check('an unparseable body is UNREAD too', r.verdict === 'UNREAD', r.verdict);

      return E.readDocket(3, { request: async () => ({ status: 200, body: Buffer.from(JSON.stringify({
        count: 40,
        results: [{ date_filed: '2025-04-11', entry_number: 30,
          description: 'NOTICE of Voluntary Dismissal' }],
      })) }) });
    })
    .then((r) => {
      check('a real read carries the docket id and the URL it used',
        r.docket_id === 3 && /docket=3/.test(r.url), JSON.stringify({ d: r.docket_id, u: r.url }));
      check('and the source\'s own entry count, so a window is visible',
        r.reported === 40, String(r.reported));

      // The reason this module refuses to emit one label per case, kept
      // in the source so a future rewrite cannot quietly drop it. Matched
      // against a SINGLE line -- a phrase wrapped across two comment
      // lines can never match the file as one string.
      const src = fs.readFileSync(require.resolve('./entries.js'), 'utf8');
      check('the refusal to force one label is recorded in the source',
        /confidently wrong on the hard cases/.test(src));
      check('and the settlement-versus-surrender trap is named',
        /giving up/.test(src));

      let n = 0;
      return E.readMany([1, 2], { intervalMs: 0,
        request: async () => { n += 1; return { status: 200, body: Buffer.from(JSON.stringify({
          count: 1, results: [{ description: 'Consent Order' }] })) }; } })
        .then((rs) => {
          check('readMany reads each docket once', n === 2 && rs.length === 2, String(n));
          check('and every row carries its own docket id',
            rs[0].docket_id === 1 && rs[1].docket_id === 2);
          console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
          process.exitCode = FAIL === 0 ? 0 : 1;
        });
    });
}
