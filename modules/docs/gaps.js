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
  const re = /(?:^|[\s(])(\d{1,4})\.[ \t]{2,}(?=[A-Z"“‘[])/gm;
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
    return { found: 0, first: null, last: null, missing: [], runs: [], seen: new Set() };
  }
  const seen = new Set(seq);
  const first = seq[0];
  const last = seq[seq.length - 1];
  const missing = [];
  for (let n = first; n <= last; n++) if (!seen.has(n)) missing.push(n);
  return { found: seq.length, first, last, missing, runs: runs(missing), seen };
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
  const re = /([a-z,;]\s)( {6,})([a-z])/g;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s)) !== null) {
    const from = Math.max(0, m.index - 60);
    out.push(s.slice(from, m.index + m[0].length + 60).replace(/\s+/g, ' ').trim());
    if (out.length >= 40) break;
  }
  return out;
}

module.exports = { paragraphNumbers, risingSequence, runs, analyse, whitedOut };
