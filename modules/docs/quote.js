'use strict';
/**
 * quote.js — did the person actually say the words inside the quotation marks?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE MOST DANGEROUS THING ON THE DESK
 *
 * Everything else this system handles is a filing somebody signed. A quotation
 * is different in kind: it is a claim about what a named, living person said,
 * and it is the one assertion that can be wrong in a way no amount of care
 * elsewhere repairs. A published graphic carrying words in quotation marks
 * beside a real official's name and title is the single highest-exposure
 * artifact this desk can produce.
 *
 * The failure is almost never invention. It is drift: the quote gets typed
 * from memory, or lifted from a summary of the article rather than the
 * article, and lands 90% right. Ninety percent is a misquote. It reads as
 * authentic to the person who wrote it, which is exactly why nobody catches
 * it before publication.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OPPOSITE ERROR, WHICH IS ALSO REAL
 *
 * A naive `text.includes(quote)` reports NOT FOUND on quotes that are
 * genuinely present, because the two strings differ in ways no reader can
 * see: a curly apostrophe against a straight one, an em dash against a
 * hyphen, a non-breaking space, a soft hyphen left by a PDF extractor, a line
 * break in the middle of a sentence.
 *
 * That direction matters just as much. A tool that cries wolf on true quotes
 * teaches its operator to overrule it, and then it is worse than nothing. So
 * the comparison is done on normalised text, and the verdict distinguishes
 * "identical" from "identical once punctuation is set aside" rather than
 * collapsing them.
 */

/** Characters that differ between a web page, a PDF extract, and a keyboard. */
function normalize(s) {
  return String(s == null ? '' : s)
    // EVERY quotation character folds to one, single and double alike.
    //
    // Not just curly-to-straight. Someone re-typing a quotation routinely
    // swaps the outer marks -- the page prints “trying to…” and the operator
    // types 'trying to…' -- and a fold that kept single and double apart
    // reported that as NEAR: a false alarm on a sentence that is word-for-word
    // identical. That is the direction that gets a tool overruled and then
    // ignored. Quotation marks almost never distinguish two otherwise
    // identical sentences, so collapsing them costs nothing real.
    .replace(/[‘’‚‛′´`“”„‟″«»"]/g, "'")
    // Dashes: em, en, minus, figure, non-breaking hyphen -> hyphen.
    .replace(/[‐‑‒–—―−]/g, '-')
    // Ellipsis, and the spaced three-dot form, to a single marker.
    .replace(/…/g, '...')
    // Spaces that are not spaces: non-breaking, thin, hair, zero-width.
    .replace(/[  -   　]/g, ' ')
    .replace(/[​-‍﻿­]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words, for overlap scoring. Punctuation is not a word.
 *
 * An apostrophe INSIDE a word is part of it -- they're, don't, O'Brien. An
 * apostrophe at either end is a quotation mark that normalize() folded, and it
 * must be shed: otherwise the page's 'trying and the operator's trying are two
 * different tokens, and a word-for-word identical sentence scores as a near
 * miss. That regression was introduced by the fold above and caught here.
 */
function words(s) {
  return normalize(s)
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/**
 * The passage in `text` that best matches `quote`, by word overlap.
 *
 * A sliding window the length of the quote, scored on how many of the quote's
 * words it contains. Deliberately simple: the job is to put the nearest real
 * sentence in front of the operator, not to score it. A human decides whether
 * what comes back is the same statement.
 */
function bestWindow(text, quote) {
  const q = words(quote);
  const t = words(text);
  if (!q.length || !t.length) return null;

  const want = new Set(q);
  const size = Math.min(q.length, t.length);
  let bestAt = 0;
  let bestHits = -1;

  // Count matches in the first window, then slide, adjusting by the word that
  // leaves and the word that enters. Rescanning each window turns a long
  // document into minutes of work for no additional accuracy.
  let hits = 0;
  for (let i = 0; i < size; i++) if (want.has(t[i])) hits++;
  bestHits = hits;
  for (let i = size; i < t.length; i++) {
    if (want.has(t[i - size])) hits--;
    if (want.has(t[i])) hits++;
    if (hits > bestHits) { bestHits = hits; bestAt = i - size + 1; }
  }

  return {
    words: t.slice(bestAt, bestAt + size),
    overlap: q.length ? bestHits / q.length : 0,
    at: bestAt,
  };
}

/** Which words of the quote are missing from the passage, and vice versa. */
function wordDiff(quote, passage) {
  const q = words(quote);
  const p = words(passage);
  const pSet = new Set(p);
  const qSet = new Set(q);
  return {
    notInSource: q.filter((w) => !pSet.has(w)),
    notInQuote: p.filter((w) => !qSet.has(w)),
  };
}

/**
 * Verify one quotation against one document.
 *
 * Verdicts, and what each one means for publication:
 *
 *   VERBATIM        the words appear exactly. Publish with quotation marks.
 *   NORMALIZED      identical once curly quotes, dashes and line breaks are
 *                   set aside. Publish with quotation marks -- but copy the
 *                   text FROM THE SOURCE so the published punctuation is the
 *                   source's, not yours.
 *   NEAR            most of the words are there and some are not. This is a
 *                   PARAPHRASE WEARING QUOTATION MARKS, and it is the most
 *                   common way a careful desk publishes something false.
 *                   Either quote what the passage actually says, or drop the
 *                   quotation marks and attribute the substance.
 *   NOT FOUND       nothing close is in this document. The quote may be real
 *                   and from somewhere else -- which means this is not the
 *                   source, and you do not yet have one.
 */
function verify(text, quote, opts = {}) {
  const near = opts.nearThreshold === undefined ? 0.6 : opts.nearThreshold;
  const raw = String(text == null ? '' : text);
  const q = String(quote == null ? '' : quote).trim().replace(/^["'“‘]|["'”’]$/g, '');

  if (!q) return { verdict: 'NO QUOTE', quote: '', overlap: 0, passage: '', diff: null };
  if (!raw.trim()) {
    return { verdict: 'NO DOCUMENT', quote: q, overlap: 0, passage: '', diff: null };
  }

  if (raw.includes(q)) {
    return { verdict: 'VERBATIM', quote: q, overlap: 1, passage: q, diff: null, exact: true };
  }

  const nText = normalize(raw);
  const nQuote = normalize(q);
  if (nQuote && nText.includes(nQuote)) {
    return { verdict: 'NORMALIZED', quote: q, overlap: 1, passage: nQuote, diff: null, exact: false };
  }

  const win = bestWindow(raw, q);
  if (!win) return { verdict: 'NOT FOUND', quote: q, overlap: 0, passage: '', diff: null };

  const passage = win.words.join(' ');
  const verdict = win.overlap >= near ? 'NEAR' : 'NOT FOUND';
  return {
    verdict,
    quote: q,
    overlap: Math.round(win.overlap * 100) / 100,
    passage,
    diff: wordDiff(q, passage),
    exact: false,
  };
}

/** Plain words for what a verdict means. Printed, so it is never inferred. */
const MEANING = {
  VERBATIM: 'The words appear exactly as written. Safe to publish in quotation marks.',
  NORMALIZED: 'Identical once curly quotes, dashes and line breaks are set aside. '
    + 'Safe to publish -- but copy the text FROM THE SOURCE, so the punctuation '
    + 'you print is the punctuation the source used.',
  NEAR: 'Most of the words are here and some are not. This is a PARAPHRASE INSIDE '
    + 'QUOTATION MARKS, which is the usual way a careful desk publishes something '
    + 'false. Quote what the passage actually says, or drop the quotation marks '
    + 'and attribute the substance instead.',
  'NOT FOUND': 'Nothing close is in this document. The quote may still be real and '
    + 'from somewhere else -- in which case THIS IS NOT ITS SOURCE, and you do not '
    + 'have one yet.',
  'NO QUOTE': 'No quotation was given to check.',
  'NO DOCUMENT': 'The document is empty. Nothing can be concluded from it -- that is '
    + 'a fact about the extraction, not about the quote.',
};

module.exports = { normalize, words, bestWindow, wordDiff, verify, MEANING };
