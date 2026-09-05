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

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
