#!/usr/bin/env node
'use strict';
/**
 * test_gaps.js
 *
 * Real failure this module exists to stop: a 233-page state attorneys general
 * complaint was checked for redactions with `grep -c -i redact`, returned 0,
 * and was reported to the operator as unredacted and complete. Paragraphs
 * 159, 160, 162, 163, 164 and 380 are sealed, and they carry no marker at all
 * — no black bar, no bracketed label, no word. The text is simply absent.
 */

const fs = require('fs');
const G = require('./gaps.js');

let PASS = 0;
let FAIL = 0;
function check(what, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${what}`); }
  else { FAIL++; console.log(`    FAIL  ${what}${detail ? `\n          ${detail}` : ''}`); }
}

/** A filing shaped like the real one: line numbers, footnotes, statute cites. */
function filing(missing, from = 150, to = 185) {
  let t = '     IX.   META COPPA NONCOMPLIANCE ..........  105\n';
  for (let n = from; n <= to; n++) {
    if (missing.includes(n)) continue;
    t += ` ${(n % 28) + 1}          ${n}.    Meta employs design features and the states allege\n`;
    if (n % 7 === 0) {
      t += '     9  Mark D. Griffiths, Adolescent Social Networking, 36 Educ. & Health J. 66 (2018)\n';
    }
  }
  t += 'jurisdiction under 15 U.S.C. 6501 and 16 C.F.R. 312.4, 312.5, 312.9.\n';
  return t;
}

module.exports = function run() {
  console.log('\n  gaps.js — the paragraphs a filing does not contain\n');

  // ══ 1. THE HOLE IS THE EVIDENCE ════════════════════════════════════════
  {
    const r = G.analyse(filing([159, 160, 162, 163, 164, 180]));
    check('the sealed paragraphs are found',
      r.missing.join(',') === '159,160,162,163,164,180', r.missing.join(','));
    check('consecutive holes are collapsed into runs',
      r.runs.map((x) => (x.from === x.to ? `${x.from}` : `${x.from}-${x.to}`)).join(' ')
        === '159-160 162-164 180',
      JSON.stringify(r.runs));
    check('and the run carries how many paragraphs it hides',
      r.runs[1].count === 3, String(r.runs[1].count));

    const clean = G.analyse(filing([]));
    check('an unbroken filing reports no gaps',
      clean.missing.length === 0, clean.missing.join(','));
    check('and still reports the range it checked',
      clean.first === 150 && clean.last === 185, `${clean.first}-${clean.last}`);
  }

  // ══ 2. ONE STRAY NUMBER MUST NOT DECIDE THE ANSWER ═════════════════════
  //
  // The first implementation walked forward keeping any number that advanced
  // a running maximum, which anchors everything on whatever matched FIRST. A
  // single high number ahead of the real numbering — a caption, a page
  // reference, a table-of-contents row — discarded every genuine paragraph
  // after it as "out of order", and the report said the document held one
  // paragraph and no gaps. Clean, confident, wrong.
  {
    const poisoned = ' 4          531.    Meta has conducted detailed internal research\n'
      + filing([159, 160]);
    const r = G.analyse(poisoned);
    check('a stray high number ahead of the sequence does not swallow it',
      r.found > 30, `found ${r.found}`);
    check('and the real gaps are still found',
      r.missing.includes(159) && r.missing.includes(160), r.missing.join(','));
    check('the longest rising run wins, not the first one',
      r.first === 150 && r.last === 185, `${r.first}-${r.last}`);
  }

  // ══ 3. WHAT MUST NOT BE COUNTED AS A PARAGRAPH ═════════════════════════
  {
    const nums = G.paragraphNumbers(
      'This Court has jurisdiction under 15 U.S.C. § 6501 and 16 C.F.R. §§ 312.4, 312.5.\n'
      + '     9  Mark D. Griffiths, Adolescent Social Networking, 36 Educ. & Health J. 66.\n'
      + ' 5          158.       Because they do not work in a predictable pattern\n');
    check('a statute cite is not a paragraph',
      !nums.includes(15) && !nums.includes(6501), nums.join(','));
    check('a CFR subsection is not a paragraph',
      !nums.includes(312), nums.join(','));
    check('a footnote marker is not a paragraph',
      !nums.includes(9), nums.join(','));
    check('a real paragraph is', nums.includes(158), nums.join(','));
  }

  // ══ 4. AN EMPTY ANSWER SAYS WHAT IT MEANS ══════════════════════════════
  {
    const r = G.analyse('Prose with no numbered paragraphs at all.');
    check('no numbering yields found:0 rather than a fabricated range',
      r.found === 0 && r.first === null && r.missing.length === 0);
    check('and null input does not throw',
      G.analyse(null).found === 0 && G.analyse(undefined).found === 0);

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the command says a null result is about the text, not the document',
      /fact about this text, not about the document/.test(cli));
  }

  // ══ 5. A GAP IS NOT A REDACTION ════════════════════════════════════════
  //
  // Three causes, and this tool chooses between none of them. Saying "sealed"
  // would be the same overreach the null result exists to prevent.
  {
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the output states that a gap is not a redaction',
      /A GAP IS NOT A REDACTION/.test(cli));
    check('and names all three causes',
      /SEALED/.test(cli) && /extractor dropped it/.test(cli) && /skipped the number/.test(cli));
    check('and tells the operator to open the page',
      /Open the page and look/.test(cli));
    // An unbroken sequence must not be reported as "nothing was removed".
    check('an unbroken sequence is not reported as proof nothing was removed',
      /does not rule out words removed/.test(cli));
  }

  // ══ 6. WORDS REMOVED FROM INSIDE A PARAGRAPH ═══════════════════════════
  //
  // Real line: "Elaborating further,        teens responded that Instagram
  // use led to them feeling 'not good enough,'". The sentence survives; the
  // figure that gave it meaning does not, and the paragraph number is present
  // so the gap check cannot see it.
  {
    const hits = G.whitedOut(
      'Elaborating further,        teens responded that Instagram use led to '
      + 'them feeling not good enough, with        24% reporting the feelings started');
    check('a whited-out figure mid-sentence is surfaced',
      hits.length >= 1, String(hits.length));
    check('ordinary prose is not flagged',
      G.whitedOut('A normal sentence with single spaces throughout.').length === 0);

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('and the output calls that signal WEAK rather than a finding',
      /This signal is WEAK/.test(cli) && /places to look, not findings/.test(cli));
  }

  // ══ 7. A GAP LIST THE MATCHER CANNOT SUPPORT IS NOT PRINTED ═══════════
  //
  // First live run on the real 233-page complaint: 570 paragraphs found
  // across a range of 1 to 1,040, and 470 reported MISSING, under a heading
  // any operator would read as "hundreds of passages are sealed". Nearly half
  // the paragraphs were plainly in the document; the matcher could not see
  // them. The tool printed its own blind spots as holes in a federal filing.
  {
    let dense = '';
    for (let n = 1; n <= 100; n++) {
      if ([59, 60, 80].includes(n)) continue;
      dense += ` ${(n % 28) + 1}          ${n}.    The states allege Meta employs design features\n`;
    }
    const good = G.analyse(dense);
    check('a document the matcher reads well is reliable',
      good.reliable === true && good.confidence > 0.9, String(good.confidence));
    check('and its real gaps are reported',
      good.missing.join(',') === '59,60,80', good.missing.join(','));

    let sparse = '';
    for (let n = 1; n <= 100; n += 2) sparse += ` 3          ${n}.    Sparse text\n`;
    const bad = G.analyse(sparse);
    check('a document the matcher half-reads is NOT reliable',
      bad.reliable === false, `${bad.found}/${bad.span}`);
    check('confidence is carried as a number, not a verdict',
      Math.abs(bad.confidence - 0.505) < 0.02, String(bad.confidence));

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('an unreliable read refuses to print a gap list',
      /CANNOT READ THIS DOCUMENT/.test(cli) && /NUMBERING\./.test(cli));
    check('and says no conclusion about redaction can be drawn',
      /No conclusion about redaction/.test(cli));
    check('and the confidence is always shown, reliable or not',
      /matcher read \$\{pct\} of that range/.test(cli));
  }

  // ══ 8. A TABLE OF CONTENTS IS NOT A REDACTION ═════════════════════════
  //
  // The first live run reported forty "places where words may be missing"
  // and every one was a contents row with dot leaders.
  {
    check('a contents row with dot leaders is not flagged',
      G.whitedOut('  monetizes young users attention through data harvesting. ......... 41')
        .length === 0);
    check('a bare page number is not flagged',
      G.whitedOut('\n    89    \n').length === 0);
    check('a real mid-sentence hole is still flagged',
      G.whitedOut('Elaborating further,        teens responded that Instagram use led')
        .length === 1);
  }

  // ══ 9. A LOOKUP THAT CANNOT FIND WHAT THE MATCHER FOUND IS BROKEN ═════
  //
  // The first diagnostic for "is this paragraph missing, or did the matcher
  // miss it?" was a shell one-liner:
  //
  //     new RegExp("(^|[^0-9.])" + n + "\\\\.[ \\t]")     inside  node -e '...'
  //
  // Single quotes pass backslashes through, so JavaScript got `\\.` — an
  // escaped BACKSLASH plus any character. It searched for "42\" and matched
  // nothing anywhere. Fourteen paragraphs came back "not present in the text
  // at all", and so did six numbers the matcher had just found. The
  // self-contradiction was the only reason it was caught.
  {
    const t = ' 3          41.    Present paragraph text here\n'
      + ' 4          43.    Another present paragraph\n'
      + 'Case 4:23-cv-05448 Document 1 Filed 10/24/23 Page 95 of 233\n';

    const [a, b, c] = G.locate(t, [41, 42, 43]);
    check('a paragraph that IS in the text is located',
      a.line === 1 && /Present paragraph/.test(a.text), JSON.stringify(a));
    check('a paragraph that is NOT in the text returns null, not a false line',
      b.line === null && b.text === null, JSON.stringify(b));
    check('and the one after it is still located',
      c.line === 2, JSON.stringify(c));

    // The control that catches a broken lookup: every number the matcher
    // found must be locatable in the same text.
    const dense = Array.from({ length: 60 }, (_, i) =>
      ` ${(i % 28) + 1}          ${i + 1}.    The states allege Meta employs features`).join('\n');
    const r = G.analyse(dense);
    const unfindable = G.locate(dense, [...r.seen]).filter((x) => x.line === null);
    check('every number the matcher found can be located again',
      unfindable.length === 0, unfindable.map((x) => x.number).join(','));

    const st = G.pageStamps(t);
    check('page stamps are read for coverage',
      st.total === 233 && st.highest === 95 && st.found === 1, JSON.stringify(st));
    check('a document with no stamps reports null rather than zero pages',
      G.pageStamps('no stamps here').total === null);

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('--why runs the control before anything else',
      /THE LOOKUP IS BROKEN, NOT THE DOCUMENT/.test(cli));
    check('and prints nothing further when the control fails',
      /Nothing\\n?[^\n]*below this line would mean anything/.test(cli)
        || /below this line would mean anything/.test(cli));
    check('--why says what full page coverage does and does not rule out',
      /Extraction reached every page/.test(cli)
        && /EXTRACTION DID NOT REACH EVERY PAGE/.test(cli));
    check('and interprets the sample in both directions',
      /Mostly absent/.test(cli) && /Mostly present/.test(cli));
  }

  // ══ 10. A RANGE THAT DOES NOT EXIST INVENTS THE GAPS IN IT ════════════
  //
  // Live run: 737 paragraphs found, range reported as 1 to 1,171, and 434
  // called missing. If the filing's real paragraphs run 1..737 unbroken and
  // the numbers above that are a citation or a case number chained on by the
  // rising walk, then the document has 737 paragraphs and NO gaps — and every
  // one of those 434 is an artifact of a range that was never there.
  //
  // The signature is a contiguous prefix that ends far below the top.
  {
    let t = '';
    for (let n = 1; n <= 40; n++) {
      if (n === 23) continue;
      t += ` 3          ${n}.    Real paragraph prose here\n`;
    }
    t += ' 4          900.    A stray high number, a citation say\n';

    const r = G.analyse(t, { maxJump: 900 });
    check('the unbroken run is reported, not just the outer range',
      r.contiguousTo === 22, String(r.contiguousTo));
    check('and it is visibly far below the top of the range',
      r.last - r.contiguousTo > 800, `${r.contiguousTo}..${r.last}`);

    const clean = G.analyse('  1.    One\n  2.    Two\n  3.    Three\n');
    check('a filing with no holes runs contiguous to its last paragraph',
      clean.contiguousTo === clean.last, `${clean.contiguousTo} vs ${clean.last}`);

    // The bracket: what actually sits where the missing paragraph should be.
    const br = G.bracket(t, 23, r.seen);
    check('the bracket finds the neighbours that straddle the hole',
      br.before === 22 && br.after === 24, JSON.stringify([br.before, br.after]));
    check('and shows the text between them',
      br.lines.length === 2 && /22\./.test(br.lines[0]) && /24\./.test(br.lines[1]),
      JSON.stringify(br.lines));
    check('a number with no neighbour on one side yields null, not a guess',
      G.bracket(t, 0, r.seen) === null);

    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('--why says a scattered tail may mean the range is not real',
      /artifact of a range that does not exist/.test(cli));
    check('and reads the bracket in both directions',
      /extraction lost the number, not the document/.test(cli)
        && /the numbering skips/.test(cli));
    check('and refuses to call a skip a seal without the PDF',
      /only the PDF page can say whether that is a seal/.test(cli));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
