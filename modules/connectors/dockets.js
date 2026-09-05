#!/usr/bin/env node
'use strict';
/**
 * dockets.js — when did a whole class of cases end?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * A single docket answers "what happened to this case". It cannot answer
 * "was this one case or a pattern", and that second question is the one
 * that separates an anecdote from a finding.
 *
 * The live example: CFPB v. Comerica Bank was voluntarily dismissed on
 * 2025-04-11, one day after an order to show cause. Read alone that is a
 * story about one bank. Read against every docket named "Consumer
 * Financial Protection Bureau v. ..." and their termination dates, it is
 * either still a story about one bank -- which is worth knowing -- or it
 * is a story about an agency.
 *
 * Only the denominator can tell you which, and a search page of 20 cannot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE THINGS THIS CANNOT TELL YOU
 * ─────────────────────────────────────────────────────────────────────────
 * 1. A DOCKET IS NOT A CASE. One enforcement action appears as a district
 *    docket AND an appellate docket, and a case that is re-filed or removed
 *    appears twice more. Counting dockets over-counts actions, always. Any
 *    total here is a CEILING on the number of cases.
 * 2. dateTerminated SAYS WHEN, NEVER HOW. A case terminated in 2025 may
 *    have settled, been dismissed by the court, been won, or been
 *    abandoned by the plaintiff. Those are four different stories and this
 *    field cannot distinguish them. The last docket entry can; go read it.
 * 3. A NULL dateTerminated IS NOT "STILL OPEN". RECAP is assembled from
 *    what people have uploaded. A docket nobody refreshed after judgment
 *    carries a null here forever. Null means UNKNOWN.
 */

const R = require('./registry.js');

const SEARCH = 'https://www.courtlistener.com/api/rest/v4/search/';

/** One page of the RECAP docket search. */
function pageUrl(query, page, opts = {}) {
  const p = new URLSearchParams();
  p.set('type', 'r');
  p.set('q', query);
  p.set('order_by', opts.order || 'dateFiled desc');
  if (page > 1) p.set('page', String(page));
  return `${SEARCH}?${p.toString()}`;
}

/** Keep only the fields a disposition question needs. */
function row(r) {
  return {
    docket_id: r.docket_id,
    case_name: r.caseName || '',
    court: r.court || '',
    court_id: r.court_id || '',
    docket_number: r.docketNumber || '',
    filed: r.dateFiled ? String(r.dateFiled).slice(0, 10) : '',
    terminated: r.dateTerminated ? String(r.dateTerminated).slice(0, 10) : '',
    url: r.docket_absolute_url
      ? `https://www.courtlistener.com${r.docket_absolute_url}` : '',
  };
}

/**
 * Roll dockets up by the YEAR they ended.
 *
 * `unknown` is its own bucket and is never folded into "open". See the
 * header: a null termination date in RECAP means nobody uploaded the
 * closing entry, not that the case is running.
 */
function byYear(rows) {
  const years = new Map();
  let unknown = 0;
  for (const r of rows) {
    if (!r.terminated) { unknown += 1; continue; }
    const y = r.terminated.slice(0, 4);
    years.set(y, (years.get(y) || 0) + 1);
  }
  return {
    years: [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, n]) => ({ year, dockets: n })),
    terminated: rows.length - unknown,
    unknown,
    total: rows.length,
  };
}

/**
 * Distinct DEFENDANTS, as a floor on the number of real actions.
 *
 * Strips the plaintiff and any "(f/k/a ...)" so the district and appellate
 * dockets of one action collapse. This is a heuristic and is labelled one:
 * it will merge two genuinely separate suits against the same defendant.
 */
function defendants(rows) {
  const seen = new Map();
  for (const r of rows) {
    const m = /\sv\.?\s+(.+)$/i.exec(r.case_name);
    if (!m) continue;
    const name = m[1].replace(/\s*\(f\/k\/a[^)]*\)/i, '').replace(/[.,]\s*$/, '').trim();
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, { defendant: name, dockets: [] });
    seen.get(key).dockets.push(r);
  }
  return [...seen.values()].sort((a, b) => b.dockets.length - a.dockets.length
    || a.defendant.localeCompare(b.defendant));
}

/** Dockets that ended within a calendar year. */
function endedIn(rows, year) {
  const y = String(year);
  return rows.filter((r) => r.terminated && r.terminated.slice(0, 4) === y)
    .sort((a, b) => a.terminated.localeCompare(b.terminated));
}

/**
 * Walk every page of a docket search.
 *
 * Paced, because CourtListener enforces its rate limit and a sweep that
 * gets throttled halfway returns a PARTIAL list that looks complete. The
 * result carries `complete` so the caller can never mistake one for the
 * other.
 */
async function sweep(query, opts = {}) {
  const req = opts.request || R.request;
  const headers = opts.key ? { Authorization: `Token ${opts.key}` } : {};
  const pause = opts.intervalMs === undefined ? 13000 : opts.intervalMs;
  const maxPages = opts.maxPages || 40;

  const rows = [];
  // DEDUPE BY DOCKET ID.
  //
  // A live sweep reported "260 docket(s) of 203" at page 13: more rows
  // than the source said existed. CourtListener's deep paging returns
  // OVERLAPPING pages, so appending blindly inflates the count and would
  // have produced a denominator larger than the universe it came from --
  // the exact error this command exists to prevent, committed by the
  // command itself.
  const seen = new Set();
  let duplicates = 0;
  let reported = null;
  let pages = 0;
  let stoppedBy = null;

  for (let page = 1; page <= maxPages; page++) {
    const res = await req('GET', pageUrl(query, page, opts), headers);
    if (!res || res.status !== 200) {
      stoppedBy = res && res.status
        ? `HTTP ${res.status} on page ${page}` : `no answer on page ${page}`;
      break;
    }
    let body;
    try { body = JSON.parse(R.decodeBody(res.body)); }
    catch (e) { stoppedBy = `unparseable page ${page}: ${e.message}`; break; }

    // The count is authoritative only if it is a NUMBER. v4 sometimes
    // returns a URL here, and Number(url) is NaN -- which compares false
    // against everything and would silently make any page look complete.
    if (reported === null && typeof body.count === 'number') reported = body.count;

    const got = Array.isArray(body.results) ? body.results : [];
    let fresh = 0;
    for (const r of got) {
      const id = r.docket_id;
      const k = id === undefined || id === null ? JSON.stringify(r).slice(0, 120) : String(id);
      if (seen.has(k)) { duplicates += 1; continue; }
      seen.add(k);
      rows.push(row(r));
      fresh += 1;
    }
    pages += 1;
    if (opts.onPage) {
      opts.onPage({ page, got: got.length, fresh, total: rows.length, duplicates, reported });
    }
    if (!got.length || !body.next) break;
    // A page that adds nothing NEW means the paging is looping. Walking on
    // burns the rate limit and can never finish; stopping and saying so is
    // the only honest option.
    if (!fresh) { stoppedBy = `page ${page} returned only rows already seen`; break; }
    if (pause) await new Promise((r2) => setTimeout(r2, pause));
  }

  // The source's own count and its own pages can disagree. When they do,
  // neither number is trustworthy and the sweep says so rather than
  // picking one.
  const overshot = typeof reported === 'number' && rows.length > reported;

  return {
    ok: !stoppedBy || rows.length > 0,
    query,
    rows,
    pages,
    reported,
    duplicates,
    overshot,
    stoppedBy,
    // COMPLETE only when the source told us a number AND we hold exactly
    // that many DISTINCT dockets. Anything else is partial -- including
    // "the pages ran out", which is what a rate limit looks like from here,
    // and including holding MORE than the source claims exist.
    complete: typeof reported === 'number' && rows.length === reported
      && !stoppedBy && !overshot,
  };
}

module.exports = { SEARCH, pageUrl, row, byYear, defendants, endedIn, sweep };
