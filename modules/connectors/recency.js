'use strict';
/**
 * modules/connectors/recency.js — when did we last ask this exact question?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS EXISTS FOR
 *
 * A sweep is subjects × connectors. Thirty subjects across the runnable
 * connectors is a hundred-odd requests to public services, and the one thing
 * the desk could not tell you before making them was how many of them it had
 * already made. So a subject list re-run an hour later — because the shell
 * loop was easier to press up-arrow on than to remember `sweep` — paid the
 * full price a second time and wrote a second identical capture beside the
 * first.
 *
 * That is not just courtesy to a rate limiter. Two identical captures taken
 * minutes apart both land in the library, both get counted by crosslink, and
 * both look like independent corroboration to anyone reading a capture count
 * later. Duplicate collection quietly inflates the appearance of evidence.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Filenames. Nothing else. `readCaptures` in crosslink.js opens and parses
 * every capture body, which is right for indexing results and wrong for this
 * — answering "have I asked this lately" should not cost a full library read
 * before a command that has not run yet. So this stats the directory and
 * parses the name:
 *
 *     live_capture_<connector>_<query-slug>_<iso-stamp>.json
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LIMIT ON THE ANSWER
 *
 * The slug is the query with non-alphanumerics collapsed and TRUNCATED AT 60
 * CHARACTERS by the writer in registry.js. Two different long queries that
 * agree for their first 60 slug characters therefore produce the same slug
 * and are indistinguishable here. So this reports "an identical question, as
 * far as the filename records it" — and every caller is advisory. Nothing in
 * this file may cause a capture to be skipped without the operator asking for
 * that in the command, because the failure mode of a wrong skip (a search
 * silently not made, looking exactly like a search made and found nothing) is
 * far worse than the failure mode of a wrong warning.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');

/**
 * The writer's slug rule, restated. This MUST stay identical to the line in
 * registry.js that names the file:
 *
 *     const slug = query.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
 *
 * If the two ever drift, this module reports "never asked" for every query
 * and the whole thing degrades to silence rather than to a wrong answer.
 * test_recency.js asserts they agree by writing through the real writer.
 */
function slugFor(query) {
  return String(query == null ? '' : query).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
}

/**
 * Turn the stamp back into a Date.
 *
 * The writer builds it as `toISOString().replace(/[:.]/g, '-')`, so
 * `2026-09-03T11:51:31.959Z` is on disk as `2026-09-03T11-51-31-959Z`. The
 * date half keeps its real dashes; only the time half was mangled. Undoing
 * that blindly with a global replace would turn the date half into garbage,
 * which is why this matches the whole shape at once and rebuilds it.
 *
 * Returns null for anything that does not match, rather than an Invalid Date
 * that compares false against every threshold and looks like "not recent".
 */
function parseStamp(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every capture on disk, as {connector, slug, at, file} — names only, no
 * bodies read. Unreadable directory means an empty library, not a crash: the
 * first sweep on a fresh checkout runs before evidence/captures/ exists.
 */
function scan(captureDir) {
  let files;
  try { files = fs.readdirSync(captureDir); }
  catch { return []; }

  const out = [];
  for (const f of files) {
    if (!f.startsWith('live_capture_') || !f.endsWith('.json')) continue;
    const stem = f.slice('live_capture_'.length, -'.json'.length);

    // Longest match wins. A connector named `senatelda` and one named
    // `senateldax` would both prefix-match a senateldax capture, and picking
    // whichever Object.keys happened to yield first would file it under the
    // wrong source. There is no such pair today; this costs nothing and means
    // adding one is not a silent bug.
    let connector = null;
    for (const n of Object.keys(R.CONNECTORS)) {
      if (stem.startsWith(n + '_') && (!connector || n.length > connector.length)) connector = n;
    }
    if (!connector) continue;

    const rest = stem.slice(connector.length + 1);
    const cut = rest.search(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    if (cut < 0) continue;

    const at = parseStamp(rest.slice(cut + 1));
    if (!at) continue;

    out.push({ connector, slug: rest.slice(0, cut), at, file: f });
  }
  return out;
}

/**
 * Index the library once, then answer many questions against it.
 *
 * A sweep asks `subjects × connectors` questions. Re-scanning the directory
 * for each one turns a 100-call plan into 100 readdirs of a folder holding a
 * couple of thousand files, which is slow enough to be noticed on the command
 * that is supposed to be the cheap one.
 */
function load(captureDir) {
  // Key is `connector::slug`. `::` cannot occur inside either half — connector
  // names are bare identifiers, and the slug rule above has already replaced
  // every non-alphanumeric with `_` — so no two different questions can fold
  // onto one key, which would silently report one as the other's repeat.
  const latest = new Map();          // `${connector}::${slug}` -> Date
  for (const c of scan(captureDir)) {
    const k = `${c.connector}::${c.slug}`;
    const prev = latest.get(k);
    if (!prev || c.at > prev) latest.set(k, c.at);
  }

  return {
    size: latest.size,

    /**
     * When this connector last answered this query, or null. `now` is
     * injectable so tests do not have to sleep, and so a caller can judge a
     * whole plan against one instant rather than against a clock that moves
     * while it prints.
     */
    lastAsked(connector, query) {
      return latest.get(`${connector}::${slugFor(query)}`) || null;
    },

    /**
     * Age in hours, or null if never asked. Fractional on purpose: the
     * interesting case is the twenty-minute repeat, and rounding it to "0h"
     * reads as "no information" rather than "just now".
     */
    ageHours(connector, query, now) {
      const at = this.lastAsked(connector, query);
      if (!at) return null;
      return ((now || new Date()).getTime() - at.getTime()) / 3600000;
    },

    /**
     * Is this question already answered recently enough that asking again is
     * paying twice for the same bytes? `withinHours` is the caller's policy,
     * never a default hidden in here — how stale is too stale depends on
     * whether you are refreshing a watch or building a library, and this
     * module has no way to know which.
     */
    isRepeat(connector, query, withinHours, now) {
      const age = this.ageHours(connector, query, now);
      return age !== null && age < withinHours;
    },
  };
}

/**
 * "18 minutes ago" / "2.4 hours ago" / "3 days ago".
 *
 * Deliberately coarse and deliberately never "0 minutes ago": the operator is
 * reading this to decide whether to spend a request, and the difference
 * between forty seconds and forty minutes changes that decision while the
 * difference between three and four days does not.
 */
function describeAge(hours) {
  if (hours === null || hours === undefined) return 'never';
  if (hours < 1 / 60) return 'seconds ago';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`;
  if (hours < 48) return `${hours.toFixed(1)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

module.exports = { load, scan, slugFor, parseStamp, describeAge };
