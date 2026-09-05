#!/usr/bin/env node
'use strict';
/**
 * gaps.js — find the paragraphs a filing does not contain.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * A 233-page state attorneys general complaint was checked for redactions
 * with `grep -c -i redact`. It returned 0, and the document was reported to
 * the operator as unredacted and complete.
 *
 * It was not. Paragraphs 159, 160, 162, 163, 164 and 380 are absent, and
 * paragraph 535 reads "Elaborating further,        teens responded..." with
 * the figure whited out. The sealed passages carry NO marker — no black bar,
 * no bracketed label, no word. The text is simply not there.
 *
 * So the word "redacted" is the wrong thing to look for. What a numbered
 * legal filing cannot hide is its own arithmetic: paragraphs run 1, 2, 3, and
 * a missing one leaves a hole nothing can paper over.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A GAP IS AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 * A gap means the number is not in the extracted text. That has three causes
 * and this module will not choose between them:
 *
 *   1. The passage is SEALED — the point of the exercise.
 *   2. The extractor dropped it — a scanned page, a table, a figure.
 *   3. The filing skipped the number — drafting error, happens.
 *
 * Reporting a gap as a redaction would be exactly the overreach the null
 * result was supposed to prevent. The operator opens the page and looks.
 */

/**
 * Paragraph numbers, in the order they appear.
 *
 * Matched as "<n>." followed by real whitespace and a capital or an opening
 * quote — the shape of a numbered paragraph. Deliberately NOT matched: the
 * "15" in "15 U.S.C. § 6501" (no period before the space), "312.4" in a CFR
 * cite (no space after the period), and a footnote marker (a bare number on
 * its own line, no period).
 */
function paragraphNumbers(text) {
  const out = [];
  const re = /(?:^|[\s(])(\d{1,4})\.[ \t]+(?=[A-Z"“‘[])/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * Keep only the numbers that belong to the document's own rising sequence.
 *
 * A filing quotes statutes, exhibits and other paragraph numbers, and those
 * appear out of order.
 *
 * The first attempt walked forward keeping any number that advanced a running
 * maximum. That anchors the whole sequence on whatever matched FIRST — one
 * stray high number ahead of the real numbering (a caption, a page reference,
 * a table of contents row) and every genuine paragraph after it is discarded
 * as "out of order". The report then says the document contains one paragraph
 * and no gaps, which is a confident, clean, completely wrong answer.
 *
 * The document's true numbering is the LONGEST rising run, not the first one.
 * That is a longest-increasing-subsequence problem, and solving it properly
 * means no single early match can decide the outcome.
 *
 * `maxJump` still applies to each step: a real filing does not leap from 161
 * to 1,400, and allowing it would let a page number join the chain. It is set
 * well above any plausible run of sealed paragraphs.
 */
function risingSequence(nums, opts = {}) {
  const maxJump = opts.maxJump || 60;
  const n = nums.length;
  if (!n) return [];

  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (nums[j] >= nums[i]) continue;
      if (nums[i] - nums[j] > maxJump) continue;
      if (len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (len[i] > len[best]) best = i;
  }

  const out = [];
  for (let i = best; i !== -1; i = prev[i]) out.push(nums[i]);
  return out.reverse();
}

/** Consecutive missing numbers, collapsed into runs. */
function runs(missing) {
  const out = [];
  for (const n of missing) {
    const last = out[out.length - 1];
    if (last && n === last.to + 1) { last.to = n; last.count++; continue; }
    out.push({ from: n, to: n, count: 1 });
  }
  return out;
}

/**
 * The report. `first` is where the sequence starts, which is not always 1 —
 * a brief's numbering may begin partway in, and assuming 1 would invent a
 * gap covering the whole front matter.
 */
function analyse(text, opts = {}) {
  const all = paragraphNumbers(text);
  const seq = risingSequence(all, opts);
  if (!seq.length) {
    return {
      found: 0, first: null, last: null, missing: [], runs: [],
      seen: new Set(), span: 0, confidence: null, reliable: false,
    };
  }
  const seen = new Set(seq);
  const first = seq[0];
  const last = seq[seq.length - 1];
  const missing = [];
  for (let n = first; n <= last; n++) if (!seen.has(n)) missing.push(n);

  // ── CAN THIS MATCHER EVEN READ THIS DOCUMENT? ─────────────────────────
  //
  // First live run, on a 233-page complaint: 570 paragraphs found across a
  // range of 1 to 1,040, and 470 reported MISSING. That is not a redaction
  // map. It is the matcher failing to recognise nearly half the paragraphs
  // that are plainly there, and printing its own blind spots as holes in the
  // document — under a heading the operator would reasonably read as
  // "hundreds of passages are sealed".
  //
  // A gap list is only meaningful if the matcher found most of the sequence.
  // Below the threshold the honest output is "I cannot read this document's
  // numbering", not a list. This is the same coverage rule the rest of the
  // desk applies to sources, turned on the tool itself.
  const span = last - first + 1;
  const confidence = span > 0 ? seq.length / span : null;
  const reliable = confidence !== null && confidence >= (opts.minConfidence || 0.85);

  return {
    found: seq.length, first, last, missing, runs: runs(missing), seen,
    span, confidence, reliable,
  };
}

/**
 * A whited-out figure inside a paragraph that IS present.
 *
 * Real line: "Elaborating further,        teens responded that Instagram use
 * led to them feeling 'not good enough,'". The sentence survives; the number
 * that made it meaningful does not. A run of spaces mid-sentence, between two
 * lowercase words, is the signature — and it is a WEAK one, because
 * proportional-font extraction pads text for its own reasons. Reported as
 * "look at this", never as a finding.
 */
function whitedOut(text) {
  const out = [];
  // Line by line, so a TABLE OF CONTENTS row can be excluded. The first live
  // run reported forty "places where words may be missing" and every one was
  // a contents entry — "...monetizes young users' attention through data
  // harvesting and targeted advertising. ............ 41". Dot leaders and
  // their padding are typesetting, not redaction, and reporting them as
  // possible removals buries whatever is real.
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.{4,}/.test(line)) continue;                 // contents / index row
    if (/^\s*\d+\s*$/.test(line)) continue;            // a bare page number
    const m = /([a-z,;]\s)( {6,})([a-z])/.exec(line);
    if (!m) continue;
    out.push(line.replace(/\s+/g, ' ').trim().slice(0, 220));
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Where a paragraph number actually sits in the text, if anywhere.
 *
 * This exists because the throwaway shell diagnostic that was supposed to
 * answer "is ¶42 missing, or did the matcher miss it?" was written as
 *
 *     new RegExp("(^|[^0-9.])" + n + "\\\\.[ \\t]")
 *
 * inside `node -e '...'`. Single quotes pass backslashes through untouched, so
 * JavaScript received the string `\\.` — which RegExp reads as an escaped
 * BACKSLASH followed by any character. It searched for "42\" and matched
 * nothing, anywhere, ever. Fourteen paragraphs were reported "not present in
 * the text at all", and so were six numbers the matcher had just found.
 *
 * A lookup that cannot find what the matcher already matched is broken, and
 * that is the check below. Escaping belongs in a file with a test, not in a
 * shell string.
 */
function locate(text, numbers) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (const n of numbers) {
    const re = new RegExp(`(?:^|[^0-9.])${n}\\.[ \\t]`);
    const idx = lines.findIndex((L) => re.test(L));
    out.push({
      number: n,
      line: idx < 0 ? null : idx + 1,
      text: idx < 0 ? null : lines[idx].slice(0, 100),
    });
  }
  return out;
}

/** How many of the document's own "Page N of T" stamps survived extraction. */
function pageStamps(text) {
  const m = String(text || '').match(/Page\s+(\d+)\s+of\s+(\d+)/g) || [];
  if (!m.length) return { found: 0, total: null, highest: null };
  const nums = m.map((x) => x.match(/\d+/g).map(Number));
  return {
    found: m.length,
    total: nums[0][1],
    highest: Math.max(...nums.map((x) => x[0])),
  };
}

module.exports = {
  paragraphNumbers, risingSequence, runs, analyse, whitedOut, locate, pageStamps,
};
