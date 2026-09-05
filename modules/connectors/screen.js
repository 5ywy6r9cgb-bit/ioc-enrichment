#!/usr/bin/env node
'use strict';
/**
 * screen.js — the join between FARA and OpenSanctions that was never made.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * The desk scanned all 536 active FARA registrants, ranked fourteen
 * countries by disclosed footprint, and identified the highest-volume
 * conduit in the register. It never once asked the next question:
 *
 *   Of the foreign principals paying registered agents to act in the
 *   United States, which appear in sanctions, debarment or
 *   politically-exposed-person data?
 *
 * Both halves are public. FARA says who is paid to represent a foreign
 * interest; OpenSanctions says which interests carry a listing. Neither
 * requires a source, a leak, or anyone's word. The join is arithmetic on
 * two published registers, and it is checkable row by row.
 *
 * This runs off the farascan CACHE. No FARA network calls, so the scan's
 * coverage is the denominator and is carried into every result.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS MODULE EXISTS TO NOT FALL INTO
 * ─────────────────────────────────────────────────────────────────────────
 * A FARA principal is, very often, a foreign government or a person who
 * works for one. THAT IS WHAT FARA IS FOR. Registering as an agent of the
 * Embassy of Japan is lawful, disclosed, and the system working exactly as
 * designed.
 *
 * So a screen that reports "37 FARA principals matched politically-exposed
 * person data" has discovered NOTHING. It has rediscovered the purpose of
 * the statute and dressed it as a finding. Worse, it produces a number that
 * sounds alarming to a reader who does not know that, which is how an
 * honest dataset becomes a dishonest headline.
 *
 * Every row is therefore marked:
 *
 *   EXPECTED  — government, diplomatic or PEP topics on a foreign-government
 *               principal. The statute predicts this. Not a finding.
 *   NOTABLE   — sanctions, export control, debarment, criminal topics.
 *               These are not predicted by registering, and are worth a
 *               human reading the underlying filing.
 *   UNCLEAR   — matched, but the topics do not resolve either way.
 *
 * Only NOTABLE rows are candidates for a finding, and even they are
 * candidates, never conclusions. See below.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A NAME MATCH IS NOT AN IDENTIFICATION
 * ─────────────────────────────────────────────────────────────────────────
 * This is the part that can hurt a real person, so it is stated plainly:
 * entity resolution on names produces false positives, constantly. Common
 * surnames collide. Company names repeat across jurisdictions. A score of
 * 0.85 means the algorithm thinks two strings probably describe one entity;
 * it does not mean they do.
 *
 * Nothing here is called a "hit". Every row is a CANDIDATE carrying the
 * score, the matched entity's own name, and its OpenSanctions URL, so a
 * human can open both records and compare them. Publishing a candidate as
 * a fact is defamation, and the module refuses to make it easy: there is
 * no output mode that prints a conclusion.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');
const FS = require('./farascan.js');

const MATCH = 'https://api.opensanctions.org/match/default?algorithm=logic-v2';

/**
 * Topics that the act of FARA registration already predicts.
 *
 * A foreign government principal IS a government body. Its officers ARE
 * politically exposed. Reporting either as a discovery is a category error.
 */
const EXPECTED_TOPICS = [
  /^gov\b/, /^role\.pep$/, /^role\.rca$/, /^role\.diplo$/, /^role\.judge$/,
  /^role\.lawyer$/, /^role\.spy$/,
];

/**
 * Topics that registering does NOT predict, and that therefore mean
 * something a reader could not have guessed from the FARA filing alone.
 */
const NOTABLE_TOPICS = [
  /^sanction/, /^export\.control$/, /^export\.risk$/, /^debarment$/,
  /^crime/, /^poi$/, /^wanted$/, /^asset\.frozen$/,
];

function topicClass(topics) {
  const t = (Array.isArray(topics) ? topics : []).map((x) => String(x).toLowerCase());
  if (!t.length) return 'UNCLEAR';
  if (t.some((x) => NOTABLE_TOPICS.some((re) => re.test(x)))) return 'NOTABLE';
  if (t.every((x) => EXPECTED_TOPICS.some((re) => re.test(x)))) return 'EXPECTED';
  // A mix of expected and unrecognised topics is UNCLEAR, never EXPECTED:
  // silently absorbing an unknown topic into "nothing to see" is how a real
  // listing gets filed under routine.
  return 'UNCLEAR';
}

/**
 * Every distinct foreign principal in the farascan cache.
 *
 * Reuses farascan's own reader rather than re-walking the directory: two
 * readers of one cache drift, and the one that drifts is always the one
 * nobody tests.
 */
function principals(opts = {}) {
  const p = FS.principals(opts);
  if (!p.ok) return p;
  return {
    ok: true,
    // Field names come from farascan's own reader. The first version of
    // this function GUESSED them -- `principal`/`documents` against a
    // reader that returns `docs` -- and matched nothing, which printed as
    // "0 distinct principals" over a cache holding 19,384 rows. A shape
    // guess that returns zero looks exactly like a register with nothing
    // in it, so the reader that owns the cache now owns the shape too.
    rows: p.rows,
    // COVERAGE TRAVELS WITH THE ANSWER. A screen of 40 principals out of a
    // cache built from 12 registrants is not a screen of the register, and
    // the two must never be printed as though they were.
    registrantsRead: p.registrantsRead,
    principalsSeen: p.principalsSeen,
    distinct: p.distinct,
    unreadable: p.unreadable,
  };
}

/**
 * Chunk names into batched /match payloads.
 *
 * Each NAME becomes TWO queries -- one Person, one Organization -- for the
 * reason recorded in the registry: a company is not a Person in the
 * FollowTheMoney model, and asking a sanctions database whether a company
 * is a person returns a confident, meaningless zero.
 */
function matchBody(names) {
  const queries = {};
  names.forEach((n, i) => {
    queries[`p${i}`] = { schema: 'Person', properties: { name: [n] } };
    queries[`o${i}`] = { schema: 'Organization', properties: { name: [n] } };
  });
  return JSON.stringify({ queries });
}

/** Which input name a response key belongs to. */
function nameForKey(key, names) {
  const m = /^[po](\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const i = Number(m[1]);
  return i >= 0 && i < names.length ? names[i] : null;
}

/** Parse one batched response into candidate rows, keyed back to the input. */
function parseBatch(json, names) {
  const bag = (json && json.responses) || {};
  const out = [];
  const seen = new Set();
  for (const key of Object.keys(bag)) {
    const asked = nameForKey(key, names);
    if (asked === null) continue;
    for (const r of (bag[key] && bag[key].results) || []) {
      if (!r || !r.id) continue;
      const dedupe = `${asked}|${r.id}`;
      if (seen.has(dedupe)) continue;       // one entity can match Person AND Org
      seen.add(dedupe);
      const topics = (r.properties && r.properties.topics) || [];
      out.push({
        asked,
        matched_name: r.caption || '',
        entity_id: r.id,
        schema: r.schema || '',
        topics,
        // NEVER a boolean "sanctioned". The score and the matched name are
        // carried so a human can open both records and disagree.
        score: typeof r.score === 'number' ? r.score : null,
        significance: topicClass(topics),
        url: `https://www.opensanctions.org/entities/${r.id}/`,
      });
    }
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * Screen a list of names.
 *
 * `size` is names per POST, not queries per POST: each name costs two
 * queries. Kept small so one rejected batch loses little, and so a partial
 * run is a partial run of a KNOWN set rather than an unknown one.
 */
async function screen(names, opts = {}) {
  const req = opts.request || R.request;
  const key = opts.key;
  const size = opts.size || 5;
  const pause = opts.intervalMs === undefined ? 1500 : opts.intervalMs;

  const rows = [];
  const asked = [];
  let stoppedBy = null;
  let batches = 0;

  for (let i = 0; i < names.length; i += size) {
    const chunk = names.slice(i, i + size);
    const res = await req('POST', MATCH, {
      Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json',
    }, matchBody(chunk));

    if (!res || res.status !== 200) {
      stoppedBy = res && res.status
        ? `HTTP ${res.status} on batch ${batches + 1}` : `no answer on batch ${batches + 1}`;
      break;
    }
    let body;
    try { body = JSON.parse(R.decodeBody(res.body)); }
    catch (e) { stoppedBy = `unparseable batch ${batches + 1}: ${e.message}`; break; }

    rows.push(...parseBatch(body, chunk));
    asked.push(...chunk);
    batches += 1;
    if (opts.onBatch) opts.onBatch({ batch: batches, asked: asked.length, found: rows.length });
    if (pause && i + size < names.length) await new Promise((f) => setTimeout(f, pause));
  }

  return {
    rows,
    asked,
    batches,
    stoppedBy,
    // A screen that stopped halfway has NOT cleared the names it never
    // sent. Those are unscreened, and unscreened is not clean.
    unscreened: names.filter((n) => !asked.includes(n)),
    complete: !stoppedBy && asked.length === names.length,
  };
}

/** Group candidates by significance, keeping the empty classes visible. */
function bySignificance(rows) {
  const out = { NOTABLE: [], UNCLEAR: [], EXPECTED: [] };
  for (const r of rows) (out[r.significance] || out.UNCLEAR).push(r);
  return out;
}

module.exports = {
  MATCH, EXPECTED_TOPICS, NOTABLE_TOPICS,
  topicClass, principals, matchBody, nameForKey, parseBatch, screen, bySignificance,
};
