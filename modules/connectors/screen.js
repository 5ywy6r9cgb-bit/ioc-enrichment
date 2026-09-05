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
  /^crime/, /^wanted$/, /^asset\.frozen$/,
];

/**
 * `poi` -- "person of interest" -- is NOT on that list, and was removed
 * after the first live run put the King of Saudi Arabia in NOTABLE.
 *
 * The topic is a catch-all: OpenSanctions applies it to heads of state,
 * their relatives, and anyone a dataset thought worth listing. Alongside
 * `role.pep` and `role.pol` it says the person is prominent, which
 * registering an agent under FARA already told you. It carries weight only
 * next to a real listing -- and when a real listing is there, that listing
 * is what makes the row NOTABLE, so nothing is lost by dropping `poi`.
 */
const AMBIGUOUS_TOPICS = [/^poi$/, /^role\.pol$/];

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
 * ─────────────────────────────────────────────────────────────────────────
 * NAME STRENGTH — added after the first live run, which was almost all noise
 * ─────────────────────────────────────────────────────────────────────────
 * The first screen of 40 principals returned seven NOTABLE candidates. Six
 * were wrong, and wrong in ways that would have been defamatory to publish:
 *
 *   "Kingdom of Saudi Arabia"  → "ISIL-Saudi Arabia"        score 0.72
 *   "Republic of Angola"       → "Cochan S.A."              score 0.72
 *   "Chamber of Commerce and Industry of Serbia"
 *                              → a RUSSIAN regional chamber score 0.76
 *   "Sinn Fein"                → "Continuity IRA"           score 0.91
 *
 * Every one of those matched on words that identify nobody: SAUDI ARABIA,
 * ANGOLA, CHAMBER OF COMMERCE AND INDUSTRY. The score was high because the
 * strings really do overlap. The overlap is just meaningless.
 *
 * So a second, independent test runs beside the score: do the two names
 * share a DISTINCTIVE word, or are their full token sets nearly identical?
 * If neither holds, the row is WEAK however confident the algorithm was.
 * A score answers "are these strings similar". This answers "is the
 * similarity on anything that identifies an entity".
 */

/**
 * Words that identify no one.
 *
 * Legal forms, institutional furniture, and the geography that appears in
 * the name of every ministry and chamber on earth. NOT exhaustive and
 * cannot be: this is a heuristic, and a name whose only shared word is a
 * country that is not on this list will still read as strong. It is a
 * filter on the loudest false positives, not a proof of identity.
 */
const GENERIC_TOKENS = new Set([
  // legal form and corporate furniture
  'inc', 'llc', 'ltd', 'limited', 'plc', 'corp', 'corporation', 'company',
  'co', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'spa', 'srl', 'ab',
  'oy', 'pte', 'pty', 'kk', 'group', 'holding', 'holdings', 'partners',
  'international', 'global', 'worldwide', 'services', 'solutions',
  // the institutional furniture that names most FARA principals
  'government', 'republic', 'kingdom', 'state', 'states', 'united',
  'embassy', 'ministry', 'department', 'office', 'bureau', 'agency',
  'authority', 'commission', 'council', 'committee', 'federation',
  'union', 'national', 'federal', 'central', 'public', 'peoples', 'people',
  'chamber', 'commerce', 'industry', 'trade', 'board', 'association',
  'organization', 'organisation', 'institute', 'foundation', 'fund',
  'bank', 'development', 'investment', 'general', 'consulate', 'mission',
  'permanent', 'representative', 'delegation', 'secretariat',
  // grammar
  'of', 'the', 'and', 'for', 'in', 'to', 'a', 'an', 'de', 'la', 'le', 'del',
]);

/**
 * Country and demonym words.
 *
 * Kept SEPARATE from the list above so the reason a token was ignored is
 * legible: "ARABIA is a place" and "CHAMBER is furniture" are different
 * kinds of meaningless, and a future reader deciding whether to add a word
 * needs to know which pile it belongs in.
 */
const PLACE_TOKENS = new Set([
  'saudi', 'arabia', 'arabian', 'angola', 'angolan', 'serbia', 'serbian',
  'russia', 'russian', 'ukraine', 'ukrainian', 'china', 'chinese', 'japan',
  'japanese', 'korea', 'korean', 'israel', 'israeli', 'india', 'indian',
  'bangladesh', 'pakistan', 'egypt', 'turkey', 'turkish', 'qatar', 'kuwait',
  'emirates', 'abu', 'dhabi', 'dubai', 'irish', 'ireland', 'britain',
  'british', 'england', 'france', 'french', 'germany', 'german', 'italy',
  'italian', 'spain', 'spanish', 'america', 'american', 'usa', 'us',
  'africa', 'african', 'asia', 'asian', 'europe', 'european', 'siberia',
  'eastern', 'western', 'northern', 'southern', 'north', 'south', 'east',
  'west', 'taiwan', 'azerbaijan', 'nigeria', 'kenya', 'brazil', 'mexico',
]);

/**
 * Pure grammar. Counted as generic (they identify nobody) but EXCLUDED from
 * the token-set overlap, because a leading "THE" is not a difference between
 * two names. Leaving it in scored "Republic of Angola" against "THE REPUBLIC
 * OF ANGOLA" at 0.75 and called the same entity a weak match.
 */
const GRAMMAR = new Set(['of', 'the', 'and', 'for', 'in', 'to', 'a', 'an',
  'de', 'la', 'le', 'del', 'du', 'des', 'el']);

/** Case-folded, accent-stripped, punctuation-free tokens. */
function tokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** The tokens in a name that could actually identify an entity. */
function distinctive(name) {
  return tokens(name).filter((t) => t.length > 1
    && !GENERIC_TOKENS.has(t) && !PLACE_TOKENS.has(t));
}

/** Overlap of two token SETS, 0..1. */
function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * Is the similarity between two names on anything that identifies an entity?
 *
 * TWO ways to pass, because one alone is wrong in a different direction:
 *
 *   a shared DISTINCTIVE word  — "Cochan" appears in both, so they are
 *                                talking about the same thing
 *   near-identical TOKEN SETS  — "Government of the People's Republic of
 *                                Bangladesh, Embassy" against the same
 *                                name without "Embassy". Every word is
 *                                generic, and the names are still the same
 *                                name. Requiring a distinctive token would
 *                                throw this away.
 */
function nameStrength(asked, matched) {
  const da = distinctive(asked);
  const db = distinctive(matched);
  const shared = da.filter((t) => db.includes(t));
  const core = (n) => tokens(n).filter((t) => !GRAMMAR.has(t));
  const overlap = jaccard(core(asked), core(matched));
  return {
    shared,
    overlap: Math.round(overlap * 100) / 100,
    // A name made only of generic and place words cannot be matched
    // distinctively at all, and saying so is more useful than a number.
    askedAllGeneric: da.length === 0,
    weak: shared.length === 0 && overlap < 0.8,
  };
}

/**
 * A clean exact match is evidence AGAINST the dirty near-matches beside it.
 *
 * The live run: "Sinn Fein" matched Sinn Féin at 1.00 with NO topics, and
 * Continuity IRA at 0.91 with sanctions topics. The party and the proscribed
 * group are different organisations, and the register holds both. When a
 * principal has a near-perfect match that carries nothing, a lower-scored
 * listed match is very likely a DIFFERENT ENTITY that shares some words.
 *
 * This does not delete the row. It attaches the fact, because the operator
 * is the one who decides -- and because "there is a clean exact match for
 * this name" is exactly the context that stops a bad publication.
 */
function annotate(rows) {
  const best = new Map();
  for (const r of rows) {
    const st = nameStrength(r.asked, r.matched_name);
    const clean = st.overlap >= 0.95 && r.significance !== 'NOTABLE';
    if (clean) {
      const cur = best.get(r.asked);
      if (!cur || (r.score || 0) > (cur.score || 0)) {
        best.set(r.asked, { name: r.matched_name, score: r.score, url: r.url });
      }
    }
  }
  return rows.map((r) => {
    const strength = nameStrength(r.asked, r.matched_name);
    const cleanExact = best.get(r.asked) || null;
    return {
      ...r,
      strength,
      // Only attached to a row that is NOT itself the clean exact match.
      cleanExact: cleanExact && strength.overlap < 0.95 ? cleanExact : null,
    };
  });
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
  GENERIC_TOKENS, PLACE_TOKENS, GRAMMAR, tokens, distinctive, jaccard, nameStrength, annotate,
};
