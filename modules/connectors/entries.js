#!/usr/bin/env node
'use strict';
/**
 * entries.js — HOW a case ended, read off the docket itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * `connect dockets` answers WHEN. It sweeps every docket matching a case
 * name and buckets them by dateTerminated. That is a real denominator and
 * it is not a finding, because a termination date cannot tell settled from
 * abandoned, and those are opposite stories about the same plaintiff.
 *
 * The live example: 28 dockets named "Consumer Financial Protection
 * Bureau v. ..." terminated in 2025, and 25 of them between January and
 * July. Twenty-eight is not, by itself, unusual -- 2017 saw 29 and 2015
 * saw 25. What would be unusual is 28 terminations that are mostly the
 * PLAINTIFF WALKING AWAY, because an agency that settles 28 cases and an
 * agency that drops 28 cases have done opposite things.
 *
 * Only the docket text can tell them apart. This reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT RETURN ONE LABEL PER CASE
 * ─────────────────────────────────────────────────────────────────────────
 * A classifier that always emits a category is a classifier that is
 * confidently wrong on the hard cases, and the hard cases are the ones
 * that matter. "Stipulated Final Judgment and Order" and "Notice of
 * Voluntary Dismissal" both contain dismissal language; one is a
 * settlement the defendant paid for and the other is the government
 * giving up. A regex that forces a single answer will merge them, and the
 * merge is invisible in the output.
 *
 * So: every matching signal is reported, WITH THE PHRASE THAT MATCHED,
 * and a docket is called AMBIGUOUS when signals from more than one family
 * fire. Ambiguous is a real answer that sends a human to the document.
 * A guess dressed as a category is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FOUR THINGS THIS CANNOT TELL YOU
 * ─────────────────────────────────────────────────────────────────────────
 * 1. AN ENTRY TITLE IS NOT AN ORDER. These are docket-entry descriptions
 *    written by clerks, not the text of the ruling. They abbreviate, they
 *    vary by district, and they are sometimes wrong. Every finding here is
 *    a POINTER to a document, never a substitute for reading it.
 * 2. WITH OR WITHOUT PREJUDICE IS THE WHOLE BALLGAME AND IS OFTEN ABSENT.
 *    A dismissal without prejudice can be refiled; with prejudice cannot.
 *    Clerks frequently omit it from the entry text. Absent is UNSTATED.
 * 3. THE LAST ENTRY IS OFTEN ADMINISTRATIVE. "Civil case terminated",
 *    "case closed", a satisfaction of judgment, a bill of costs -- these
 *    follow the dispositive event. Reading only the last entry finds the
 *    paperwork and misses the ruling, so a window is scanned.
 * 4. RECAP IS WHAT PEOPLE UPLOADED. A docket nobody refreshed after
 *    judgment has no dispositive entry to find. That is UNREAD, and it is
 *    not the same as "no disposition".
 */

const R = require('./registry.js');

const ENTRIES = 'https://www.courtlistener.com/api/rest/v4/docket-entries/';

/**
 * Disposition families, most specific first.
 *
 * ORDER IS LOAD-BEARING WITHIN A FAMILY but families never suppress each
 * other: if a docket matches both SETTLEMENT and VOLUNTARY, both are
 * reported and the docket is AMBIGUOUS. That is the point.
 *
 * The `family` is what a finding may be built on. The `label` is what gets
 * shown, so a reader can see WHICH phrasing fired without going to source.
 */
const SIGNALS = [
  // ---- the plaintiff walked away -------------------------------------
  { family: 'VOLUNTARY', label: 'notice of voluntary dismissal',
    re: /\bnotice\s+of\s+(?:the\s+)?voluntary\s+dismissal\b/i },
  { family: 'VOLUNTARY', label: 'Rule 41(a) dismissal',
    re: /\brule\s*41\s*\(\s*a\s*\)/i },
  { family: 'VOLUNTARY', label: 'plaintiff voluntarily dismisses',
    re: /\bvoluntarily\s+dismiss(?:es|ed|ing)?\b/i },
  { family: 'VOLUNTARY', label: 'notice of dismissal',
    re: /\bnotice\s+of\s+dismissal\b/i },

  // ---- both sides signed ---------------------------------------------
  { family: 'STIPULATED', label: 'stipulation of dismissal',
    re: /\bstipulation\s+(?:and\s+order\s+)?of\s+dismissal\b/i },
  { family: 'STIPULATED', label: 'joint stipulation to dismiss',
    re: /\bjoint\s+stipulation\b[^.]{0,60}\bdismiss/i },

  // ---- the defendant paid or agreed to terms -------------------------
  { family: 'CONSENT', label: 'stipulated final judgment and order',
    re: /\bstipulated\s+final\s+judgment\b/i },
  { family: 'CONSENT', label: 'consent order / consent judgment',
    re: /\bconsent\s+(?:order|judgment|decree)\b/i },
  { family: 'CONSENT', label: 'settlement agreement',
    re: /\bsettlement\s+agreement\b/i },

  // ---- the court decided ---------------------------------------------
  { family: 'COURT', label: 'order granting motion to dismiss',
    re: /\b(?:order|opinion)[^.]{0,60}\bgrant(?:ing|ed)\b[^.]{0,60}\bmotion\s+to\s+dismiss\b/i },
  { family: 'COURT', label: 'summary judgment',
    re: /\bsummary\s+judgment\b/i },
  // NOT preceded by a word that makes it a SETTLEMENT. Without this
  // lookbehind, "Stipulated Final Judgment and Order" fires CONSENT and
  // COURT both, and every settlement in the register reads as ambiguous
  // -- the exact merge this module exists to prevent, committed by the
  // module itself. The test suite caught it; the comment keeps it caught.
  { family: 'COURT', label: 'final judgment',
    re: /(?<!\b(?:stipulated|consent|agreed|joint|proposed)\s{1,4})\bfinal\s+judgment\b/i },
  { family: 'COURT', label: 'default judgment',
    re: /\bdefault\s+judgment\b/i },

  // ---- it went somewhere else ----------------------------------------
  { family: 'MOVED', label: 'transferred',
    re: /\btransferr?ed\s+to\b/i },
  { family: 'MOVED', label: 'remanded',
    re: /\bremand(?:ed|ing)?\b/i },
  { family: 'MOVED', label: 'notice of appeal',
    re: /\bnotice\s+of\s+appeal\b/i },
];

/**
 * Prejudice, which decides whether a dismissal can come back.
 *
 * Returned separately from the family because it is orthogonal: a
 * voluntary dismissal, a stipulated one and a court dismissal can each be
 * with or without prejudice, and the clerk frequently says neither.
 */
function prejudice(text) {
  const t = String(text || '');
  const without = /\bwithout\s+prejudice\b/i.test(t);
  const wi = /\bwith\s+prejudice\b/i.test(t);
  if (without && wi) return 'BOTH STATED';   // separate counts, usually
  if (without) return 'WITHOUT';
  if (wi) return 'WITH';
  return 'UNSTATED';
}

/** Entry description plus the descriptions of its attached documents. */
function entryText(e) {
  if (!e || typeof e !== 'object') return '';
  const parts = [e.description || ''];
  const docs = Array.isArray(e.recap_documents) ? e.recap_documents : [];
  for (const d of docs) parts.push((d && d.description) || '');
  return parts.filter(Boolean).join(' | ');
}

/** The first page of a docket's entries, newest first. */
function firstPageUrl(docketId, opts = {}) {
  const p = new URLSearchParams();
  p.set('docket', String(docketId));
  p.set('order_by', opts.order || '-date_filed');
  return `${ENTRIES}?${p.toString()}`;
}

/**
 * Every signal a block of text fires, with the text that fired it.
 *
 * The MATCHED SUBSTRING is carried out, not just the label. A reader who
 * disagrees with a classification can see exactly what the code saw
 * without opening the docket, and a label that fired on the wrong phrase
 * is then visible rather than hidden behind a category name.
 */
function signalsIn(text) {
  const t = String(text || '');
  const out = [];
  for (const s of SIGNALS) {
    const m = s.re.exec(t);
    if (!m) continue;
    out.push({ family: s.family, label: s.label, phrase: m[0] });
  }
  return out;
}

/**
 * Read a window of entries into a disposition.
 *
 * `window` is how many of the newest entries are scanned. The default is
 * 8 because the last entry is so often administrative -- "civil case
 * terminated" follows the order that terminated it -- and reading only
 * the last one finds the paperwork instead of the ruling.
 */
function disposition(entries, opts = {}) {
  const window = opts.window || 8;
  const scanned = (Array.isArray(entries) ? entries : []).slice(0, window);

  const hits = [];
  for (const e of scanned) {
    const text = entryText(e);
    if (!text) continue;
    for (const s of signalsIn(text)) {
      hits.push({
        ...s,
        date: e.date_filed ? String(e.date_filed).slice(0, 10) : '',
        number: e.entry_number === undefined ? null : e.entry_number,
        prejudice: prejudice(text),
        text: text.slice(0, 240),
      });
    }
  }

  const families = [...new Set(hits.map((h) => h.family))];
  let verdict;
  if (!scanned.length) verdict = 'UNREAD';
  else if (!hits.length) verdict = 'UNCLASSIFIED';
  else if (families.length === 1) verdict = families[0];
  else verdict = 'AMBIGUOUS';

  return {
    verdict,
    families,
    hits,
    scanned: scanned.length,
    // Carried so a reader can tell "I looked at 8 of 8" from "I looked at
    // 8 of 400" -- the second is a window that may have missed the ruling.
    available: Array.isArray(entries) ? entries.length : 0,
    windowed: Array.isArray(entries) && entries.length > window,
  };
}

/**
 * Read one docket.
 *
 * One request. Deep paging is deliberately not done here: the newest
 * entries are what a disposition lives in, and walking a 400-entry docket
 * to the beginning spends the rate limit that the OTHER 27 dockets need.
 */
async function readDocket(docketId, opts = {}) {
  const req = opts.request || R.request;
  const headers = opts.key ? { Authorization: `Token ${opts.key}` } : {};
  const url = firstPageUrl(docketId, opts);

  const res = await req('GET', url, headers);
  if (!res || res.status !== 200) {
    return {
      docket_id: docketId,
      ok: false,
      // An HTTP failure is UNREAD, never "no disposition found". Those
      // read the same in a table and mean opposite things.
      verdict: 'UNREAD',
      error: res && res.status ? `HTTP ${res.status}` : 'no answer',
      hits: [], scanned: 0, available: 0, families: [],
    };
  }
  let body;
  try { body = JSON.parse(R.decodeBody(res.body)); }
  catch (e) {
    return { docket_id: docketId, ok: false, verdict: 'UNREAD',
      error: `unparseable: ${e.message}`, hits: [], scanned: 0, available: 0, families: [] };
  }

  const got = Array.isArray(body.results) ? body.results : [];
  const d = disposition(got, opts);
  return {
    docket_id: docketId,
    ok: true,
    url,
    reported: typeof body.count === 'number' ? body.count : null,
    ...d,
  };
}

/** Read many dockets, pacing between them. */
async function readMany(ids, opts = {}) {
  const pause = opts.intervalMs === undefined ? 1200 : opts.intervalMs;
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    const r = await readDocket(ids[i], opts);
    out.push(r);
    if (opts.onEach) opts.onEach(r, i + 1, ids.length);
    if (pause && i < ids.length - 1) await new Promise((f) => setTimeout(f, pause));
  }
  return out;
}

/**
 * Tally verdicts.
 *
 * UNREAD and UNCLASSIFIED are kept as their own rows and never folded
 * into a denominator of "classified" cases. A rate limit that turns ten
 * dockets into UNREAD would otherwise quietly shrink the denominator and
 * inflate every percentage computed from it.
 */
function tally(results) {
  const counts = new Map();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) || 0) + 1);
  const rows = [...counts.entries()]
    .map(([verdict, n]) => ({ verdict, dockets: n }))
    .sort((a, b) => b.dockets - a.dockets || a.verdict.localeCompare(b.verdict));
  const readable = results.filter((r) => r.verdict !== 'UNREAD').length;
  const classified = results.filter(
    (r) => r.verdict !== 'UNREAD' && r.verdict !== 'UNCLASSIFIED' && r.verdict !== 'AMBIGUOUS').length;
  return { rows, total: results.length, readable, classified };
}

module.exports = {
  ENTRIES, SIGNALS,
  prejudice, entryText, firstPageUrl, signalsIn, disposition,
  readDocket, readMany, tally,
};
