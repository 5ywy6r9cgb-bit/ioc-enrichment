#!/usr/bin/env node
/**
 * test_quote.js — a quotation is a claim about what a person said.
 *
 * TWO OPPOSITE FAILURES, BOTH GUARDED HERE
 *
 *   Publishing a misquote. Almost never invention -- it is drift. The words
 *   get typed from memory or lifted from a summary and land 90% right, which
 *   reads as authentic to whoever wrote it. That is why nobody catches it.
 *
 *   Crying wolf on a true quote. A naive includes() reports NOT FOUND when a
 *   web page uses a curly apostrophe and the operator typed a straight one.
 *   A tool that is wrong in THAT direction gets overruled, and then it is
 *   worse than having no tool at all.
 *
 * The percentage is word overlap and nothing else. One changed word out of
 * twelve scores 92% and can reverse the allegation, so that case is asserted
 * on explicitly rather than trusted to the number.
 */

'use strict';

const Q = require('./quote.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

console.log('\n== quotes: did they actually say it ==\n');

const ARTICLE = 'HILLIARD — Les Carrier, a member of city council, said the developers '
  + 'are “trying to bootstrap a power plant into a data center approval process.” '
  + 'The application covers 158 diesel generators — a combined 216 megawatts — on a '
  + 'site the council rezoned in 2024. Carrier said the council was never told.';

// ── the honest pass ───────────────────────────────────────────────────
{
  const r = Q.verify(ARTICLE, 'trying to bootstrap a power plant into a data center approval process');
  ok(r.verdict === 'VERBATIM', `an exact substring is VERBATIM (got ${r.verdict})`);
  ok(r.overlap === 1, 'and scores 1');
}

// ── PUNCTUATION MUST NOT PRODUCE A FALSE ALARM ────────────────────────
//
// This is the direction that destroys trust in the tool. Every one of these
// is the SAME sentence as the article; only invisible characters differ.
{
  const same = [
    ['straight apostrophe against the page\'s curly one',
      "the developers are 'trying to bootstrap a power plant into a data center approval process.'"],
    ['a hyphen where the page has an em dash',
      'The application covers 158 diesel generators - a combined 216 megawatts - on a site'],
    ['a line break in the middle of the sentence',
      'trying to bootstrap a power plant\ninto a data center approval process'],
    ['doubled and ragged whitespace',
      'trying   to bootstrap  a power plant into a   data center approval process'],
    ['a non-breaking space',
      'trying to bootstrap a power plant into a data center approval process'],
    ['different letter case',
      'TRYING TO BOOTSTRAP A POWER PLANT INTO A DATA CENTER APPROVAL PROCESS'],
  ];
  for (const [why, q] of same) {
    const r = Q.verify(ARTICLE, q);
    ok(r.verdict === 'VERBATIM' || r.verdict === 'NORMALIZED',
      `${why} still matches (got ${r.verdict})`);
  }

  // And the distinction is KEPT, not collapsed: NORMALIZED tells the operator
  // to copy the text from the source so the printed punctuation is the
  // source's own.
  const n = Q.verify(ARTICLE, 'trying to bootstrap a power plant into a data center approval process.');
  ok(n.verdict === 'VERBATIM' || n.verdict === 'NORMALIZED', 'trailing punctuation is tolerated');
  const curly = Q.verify('He said “it is over” and left.', 'He said "it is over" and left.');
  ok(curly.verdict === 'NORMALIZED',
    `a curly-vs-straight difference reports NORMALIZED, not VERBATIM (got ${curly.verdict})`);
}

// ── THE DANGEROUS MIDDLE ──────────────────────────────────────────────
//
// A paraphrase inside quotation marks. High overlap, different allegation.
{
  const r = Q.verify(ARTICLE, 'trying to sneak a power plant into a data center approval process');
  ok(r.verdict === 'NEAR', `one changed word is NEAR, not VERBATIM (got ${r.verdict})`);
  ok(r.overlap > 0.85, `and still scores high (${r.overlap}) — the score is not a safety margin`);
  ok(r.diff.notInSource.includes('sneak'), 'the changed word is named');
  ok(/bootstrap/.test(r.passage), 'and the real passage is shown so the two can be compared');
  ok(!r.diff.notInSource.includes('power'), 'words that ARE present are not reported missing');
}
{
  // Words added to the front of a real quote. The added attribution changes
  // who is speaking and is exactly as publishable-false as changing a verb.
  const r = Q.verify(ARTICLE, 'The mayor said they are trying to bootstrap a power plant into a data center approval process');
  ok(r.verdict === 'NEAR', `added words make it NEAR (got ${r.verdict})`);
  ok(r.diff.notInSource.includes('mayor'), 'and the invented word is named');
}

// ── NOT IN THIS DOCUMENT ──────────────────────────────────────────────
{
  const r = Q.verify(ARTICLE, 'the governor personally approved the substation in March of last year');
  ok(r.verdict === 'NOT FOUND', `an unrelated sentence is NOT FOUND (got ${r.verdict})`);
  ok(r.overlap < 0.5, `and scores low (${r.overlap})`);

  // The verdict is about THIS document only. A real quote from another article
  // must not be reported as fabricated -- the finding is "this is not its
  // source", which is a different and recoverable problem.
  ok(/THIS IS NOT ITS SOURCE/.test(Q.MEANING['NOT FOUND']),
    'and the wording says the quote may be real but this is not its source');
}

// ── things that must not crash ────────────────────────────────────────
{
  ok(Q.verify(ARTICLE, '').verdict === 'NO QUOTE', 'an empty quote is refused, not matched');
  ok(Q.verify('', 'anything at all here').verdict === 'NO DOCUMENT',
    'an empty document is refused');
  ok(/fact about the extraction/.test(Q.MEANING['NO DOCUMENT']),
    'and says an empty extraction is a fact about the extraction, not the quote');
  ok(Q.verify(null, null).verdict === 'NO QUOTE', 'nulls do not throw');
  ok(Q.verify(ARTICLE, '   ').verdict === 'NO QUOTE', 'and neither does whitespace');
  ok(Q.verify(ARTICLE, '"bootstrap a power plant"').verdict !== 'NO QUOTE',
    'a quote pasted WITH its quotation marks is handled');

  // A quote longer than the document must not read past the end of the array.
  const r = Q.verify('short text', 'a much much longer quotation than the document itself contains');
  ok(r.verdict === 'NOT FOUND', 'a quote longer than the document is NOT FOUND, not a crash');
}

// ── the sliding window is right, not just fast ────────────────────────
{
  // The window slides by adjusting for the word leaving and the word entering.
  // An off-by-one there silently returns a passage shifted by a word, which
  // reads as a near-miss and would send an operator to argue with a document
  // that actually contains their quote.
  const doc = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  const w = Q.bestWindow(doc, 'epsilon zeta eta');
  ok(w.words.join(' ') === 'epsilon zeta eta',
    `the window lands exactly on the match (got "${w.words.join(' ')}")`);
  ok(w.overlap === 1, 'and reports full overlap');

  const end = Q.bestWindow(doc, 'iota kappa');
  ok(end.words.join(' ') === 'iota kappa',
    `a match at the very end is found (got "${end.words.join(' ')}")`);
  const start = Q.bestWindow(doc, 'alpha beta');
  ok(start.words.join(' ') === 'alpha beta',
    `and so is one at the very start (got "${start.words.join(' ')}")`);
}

// ── normalize ─────────────────────────────────────────────────────────
{
  ok(Q.normalize('“Hello,”  he said—quietly…') === "'hello,' he said-quietly...",
    `curly quotes, em dash and ellipsis all fold (got ${JSON.stringify(Q.normalize('“Hello,”  he said—quietly…'))})`);
  ok(Q.normalize('"a"') === Q.normalize('“a”') && Q.normalize('"a"') === Q.normalize("'a'"),
    'single and double quotation marks fold to the SAME character, so swapping them is not a mismatch');
  ok(Q.normalize("they're") === "they're", "and an apostrophe inside a word survives");
  ok(Q.words("'trying to go'").join(' ') === 'trying to go',
    'a folded quote mark is shed from the ends of a word');
  ok(Q.words("they're don't O'Brien").join(' ') === "they're don't o'brien",
    'while an apostrophe inside a word is kept');
  ok(Q.normalize('a b') === 'a b', 'a non-breaking space becomes a space');
  ok(Q.normalize('a​b') === 'ab', 'a zero-width space is removed');
  ok(Q.normalize(null) === '', 'null normalizes to empty');
}

// ── every verdict has plain words attached ────────────────────────────
{
  for (const v of ['VERBATIM', 'NORMALIZED', 'NEAR', 'NOT FOUND', 'NO QUOTE', 'NO DOCUMENT']) {
    ok(typeof Q.MEANING[v] === 'string' && Q.MEANING[v].length > 20,
      `${v} is explained in plain words, so it is never inferred`);
  }
  ok(/PARAPHRASE INSIDE\s+QUOTATION MARKS/.test(Q.MEANING.NEAR),
    'and NEAR names the failure it represents');
}

// ── the command exits non-zero on anything unpublishable ──────────────
{
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-q-')), 'a.txt');
  fs.writeFileSync(f, ARTICLE);
  const run = (q) => {
    try {
      execFileSync('node', [path.join(__dirname, 'cli.js'), 'quote', f, q],
        { encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) { return e.status; }
  };
  ok(run('trying to bootstrap a power plant into a data center approval process') === 0,
    'a verified quote exits 0, so a script can gate on it');
  ok(run('trying to sneak a power plant into a data center approval process') === 1,
    'a paraphrase exits non-zero');
  ok(run('the governor approved it personally last March in Columbus') === 1,
    'and so does one that is not in the document');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
