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

const fs = require('fs');
const path = require('path');
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

/**
 * The documents attached to an entry, with whether they can actually be read.
 *
 * `is_available` is the field that matters and the one an eager reader skips.
 * RECAP holds what people uploaded; an entry can name a document that is NOT
 * in the archive, and following that pointer costs PACER money. Reporting a
 * document that cannot be opened as though it can is how a citation dies
 * between the desk and the page.
 */
function documentsOn(e) {
  const docs = Array.isArray(e && e.recap_documents) ? e.recap_documents : [];
  return docs.map((d) => ({
    description: (d && d.description) || '',
    // THE PDF ITSELF, not the page that describes it. Without this the
    // operator fetched the entry record, was told to read filepath_local out
    // of 36KB of JSON by hand, and fetch a second URL. Two steps where the
    // service already handed us the path.
    pdf: d && d.filepath_local
      ? `https://storage.courtlistener.com/${String(d.filepath_local).replace(/^\/+/, '')}`
      : '',
    number: d && d.document_number !== undefined ? d.document_number : null,
    attachment: d && d.attachment_number !== undefined ? d.attachment_number : null,
    pages: d && d.page_count !== undefined ? d.page_count : null,
    available: d ? d.is_available === true : false,
    url: d && d.absolute_url ? `https://www.courtlistener.com${d.absolute_url}` : '',
  }));
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
 * The same fact stated twice is not ambiguity.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * The first complete 28-docket run returned FIVE AMBIGUOUS rows, and four of
 * them were not ambiguous at all:
 *
 *   MoneyGram        CONSENT "STIPULATED FINAL JUDGMENT" + COURT "Final Judgment"
 *   MoneyLion        CONSENT "consent judgment"          + COURT "final judgment"
 *   FirstCash        CONSENT "STIPULATED FINAL JUDGMENT" + STIPULATED
 *   Nat'l Collegiate CONSENT "Consent Judgment"          + STIPULATED
 *
 * A consent judgment IS entered as a final judgment. The document says both
 * because both are true of one act, and reporting it as "more than one
 * family, go read it" sends a human to re-derive what the code already knew.
 *
 * TWO RULES, both legally grounded, and nothing wider:
 *
 *   CONSENT subsumes COURT's "final judgment" only. A settlement entered as
 *   a final judgment is one event. It does NOT subsume summary judgment, a
 *   granted motion to dismiss, or a default judgment -- those are the court
 *   deciding, which is a different story from the parties agreeing.
 *
 *   STIPULATED subsumes VOLUNTARY's bare "Rule 41(a)". Rule 41(a)(1)(A)(i)
 *   is a unilateral notice; (ii) is a stipulation signed by every party. The
 *   bare cite cannot tell them apart, so beside an explicit joint
 *   stipulation the stipulation is the more specific fact. It does NOT
 *   subsume "notice of voluntary dismissal", which is unilateral on its face
 *   -- and that distinction is the whole difference between a plaintiff
 *   walking away and both sides agreeing to end it.
 *
 * What is removed is returned in `subsumed`, so the reduction is checkable
 * and a wrong rule shows up rather than quietly deciding cases.
 */
function subsume(hits) {
  const fams = new Set(hits.map((h) => h.family));
  return hits.filter((h) => {
    if (fams.has('CONSENT') && h.family === 'COURT'
        && h.label === 'final judgment') return false;
    if (fams.has('STIPULATED') && h.family === 'VOLUNTARY'
        && h.label === 'Rule 41(a) dismissal') return false;
    return true;
  });
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
        documents: documentsOn(e),
        date: e.date_filed ? String(e.date_filed).slice(0, 10) : '',
        number: e.entry_number === undefined ? null : e.entry_number,
        prejudice: prejudice(text),
        text: text.slice(0, 240),
      });
    }
  }

  const kept = subsume(hits);
  const families = [...new Set(kept.map((h) => h.family))];
  let verdict;
  if (!scanned.length) verdict = 'UNREAD';
  else if (!hits.length) verdict = 'UNCLASSIFIED';
  else if (families.length === 1) verdict = families[0];
  else verdict = 'AMBIGUOUS';

  return {
    verdict,
    families,
    hits: kept,
    // What subsumption removed, kept so the reduction is checkable and a
    // wrong rule is visible rather than silent.
    subsumed: hits.filter((h) => !kept.includes(h)),
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
/**
 * How long to wait after a 429, read from the response rather than guessed.
 *
 * CourtListener answers a throttled request with Retry-After. Ignoring it and
 * hammering on is what turned a 28-docket run into 25 UNREAD rows: the
 * default 1.2s pace is far under this endpoint's limit, every request after
 * the first few was refused, and the output was a wall of HTTP 429 that looks
 * exactly like an agency with no records.
 */
function retryAfterMs(res) {
  const h = (res && res.headers) || {};
  const raw = h['retry-after'] || h['Retry-After'];
  if (raw === undefined || raw === null) return null;
  const secs = Number(String(raw).trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120000);
  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 120000));
  return null;
}

const MAX_429_RETRIES = 3;

async function readDocket(docketId, opts = {}) {
  const req = opts.request || R.request;
  const headers = opts.key ? { Authorization: `Token ${opts.key}` } : {};
  const url = firstPageUrl(docketId, opts);

  // A THROTTLE IS NOT AN ANSWER. Wait the time the service asked for and ask
  // again, rather than recording UNREAD for a docket the archive holds.
  let res = await req('GET', url, headers);
  for (let n = 0; n < MAX_429_RETRIES && res && res.status === 429; n += 1) {
    const wait = retryAfterMs(res) === null ? (n + 1) * 20000 : retryAfterMs(res);
    if (opts.onThrottle) opts.onThrottle({ docketId, attempt: n + 1, waitMs: wait });
    await new Promise((f) => setTimeout(f, wait));
    res = await req('GET', url, headers);
  }

  if (!res || res.status !== 200) {
    return {
      docket_id: docketId,
      ok: false,
      // An HTTP failure is UNREAD, never "no disposition found". Those
      // read the same in a table and mean opposite things.
      verdict: 'UNREAD',
      error: res && res.status === 429
        ? `HTTP 429 after ${MAX_429_RETRIES} retries — still throttled, `
          + 'not a docket without a disposition'
        : (res && res.status ? `HTTP ${res.status}` : 'no answer'),
      throttled: !!(res && res.status === 429),
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

/**
 * Where a read docket is remembered.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A CACHE, AND WHY IT IS NOT AN OPTIMISATION
 * ─────────────────────────────────────────────────────────────────────────
 * Three consecutive live runs over the same 28 dockets each answered two or
 * three and threw the answers away, because a throttled run starts from
 * scratch. Different dockets came back each time. The operator held, across
 * three runs, six real dispositions -- and the tool showed him two, then
 * three, then three, never the six.
 *
 * A rate limit you cannot get past in one run is not a reason to abandon
 * the question. It is a reason to answer it in pieces and keep the pieces.
 */
function cacheDir(root) {
  return path.join(root || R.EVIDENCE, 'captures', 'entries');
}

function cachePath(docketId, root) {
  return path.join(cacheDir(root), `docket_${String(docketId)}.json`);
}

/** A cached read, or null. Never an error: a bad cache file is a cache miss. */
function cached(docketId, opts = {}) {
  try {
    const f = cachePath(docketId, opts.evidenceRoot);
    if (!fs.existsSync(f)) return null;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    // A CACHE HIT AT A DIFFERENT WINDOW IS A MISS.
    //
    // `--window 25` on five UNCLASSIFIED dockets came straight back as
    // UNCLASSIFIED, still reporting "newest 8 of 76", because the cached
    // row was read at 8 and nothing compared the two. Widening the window
    // is the operator asking a DIFFERENT question; serving the old answer
    // makes the wider read look like it was tried and failed.
    if ((v.window || 8) !== (opts.window || 8)) return null;
    // A CACHED FAILURE IS NOT A CACHED ANSWER. Storing UNREAD would make a
    // rate limit permanent -- the one outcome that must always be retried.
    if (!v || v.ok !== true) return null;
    return v;
  } catch { return null; }
}

function remember(row, opts = {}) {
  if (!row || row.ok !== true) return;
  // The window the row was READ at, so a later run at a different window
  // knows this answer does not apply to its question.
  const stamped = Object.assign({}, row, { window: opts.window || 8 });
  try {
    const dir = cacheDir(opts.evidenceRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(row.docket_id, opts.evidenceRoot),
      JSON.stringify(Object.assign(stamped, { cached_at: new Date().toISOString() }), null, 2));
  } catch { /* a cache that cannot be written is not a failed read */ }
}

/** Read many dockets, pacing between them. */
async function readMany(ids, opts = {}) {
  // 6s, not 1.2s. The first live 28-docket run at 1.2s returned 25 UNREAD
  // rows -- every one an HTTP 429. A pace that outruns the limit does not
  // read faster, it reads nothing and prints the nothing as a result.
  const pause = opts.intervalMs === undefined ? 6000 : opts.intervalMs;
  const out = [];
  let served = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const hit = opts.refresh ? null : cached(ids[i], opts);
    if (hit) {
      served += 1;
      out.push(Object.assign({}, hit, { fromCache: true }));
      if (opts.onEach) opts.onEach(out[out.length - 1], i + 1, ids.length);
      continue;                    // no request, so no pause either
    }
    const r = await readDocket(ids[i], opts);
    remember(r, opts);
    out.push(r);
    if (opts.onEach) opts.onEach(r, i + 1, ids.length);
    if (pause && i < ids.length - 1) await new Promise((f) => setTimeout(f, pause));
  }
  out.servedFromCache = served;
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
  ENTRIES, SIGNALS, MAX_429_RETRIES, retryAfterMs,
  cacheDir, cachePath, cached, remember,
  prejudice, entryText, documentsOn, subsume, firstPageUrl, signalsIn, disposition,
  readDocket, readMany, tally,
};
