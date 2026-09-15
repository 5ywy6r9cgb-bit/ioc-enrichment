'use strict';
/**
 * modules/connectors/coverage.js — THE DENOMINATOR FOR EVERYTHING.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE QUESTION THIS ANSWERS
 *
 * "We found nothing" and "we did not look" produce identical output, and
 * every serious error in this investigation has been one read as the other.
 * A DNS failure read as absence. A contracts-only filter read as no CHIPS
 * money. A page cap read as four awards when there were forty-six. An
 * opinions index read as "the courts".
 *
 * So before any figure leaves this desk it needs the thing underneath it:
 *
 *     of how many?
 *     out of what?
 *     is this a total, a FLOOR, or a CEILING?
 *
 * This reads the capture library and answers those three, for every subject
 * set, every connector, and every number the library can currently produce.
 * No network call — it is arithmetic over what is already on disk, hashed,
 * in the ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE SHAPES A NUMBER CAN HAVE, AND WHY THEY ARE NEVER THE SAME
 *
 *   TOTAL    the register was exhausted. Every row that exists is counted.
 *   FLOOR    the query stopped at a page cap. THE REAL NUMBER IS LARGER by
 *            an unknown amount. `$26,699,034` from a run that hit 2,500 rows
 *            is not what the vendor was paid; it is where the paging ran out.
 *   CEILING  the query was fuzzy and the count includes rows that are not
 *            the subject. `recipient_search_text` is a fuzzy search, so a
 *            contract total under a stem name is a ceiling until the
 *            namesakes come out.
 *
 * A number with no shape attached is the most dangerous object this desk
 * produces, because it reads as a TOTAL to everybody.
 */

const X = require('./crosslink.js');
const N = require('./nexus.js');
const NM = require('./namematch.js');
const R = require('./registry.js');

const TOTAL = 'TOTAL';
const FLOOR = 'FLOOR';
const CEILING = 'CEILING';
const UNKNOWN = 'UNKNOWN';

/**
 * Subject-set coverage: of the subjects DEFINED, how many were ever ASKED?
 *
 * This is the denominator that stops "nothing bridges these two domains"
 * being read as "these two domains are unconnected". Nothing can bridge to a
 * set nobody has swept, and the difference is not visible anywhere else.
 */
function setCoverage(captures, subjects) {
  const index = N.domainIndex(subjects);
  const asked = new Map();     // folded subject -> Set(connectors that answered)
  const rowsBy = new Map();    // folded subject -> row count

  for (const c of captures) {
    const k = N.foldSubject(c.subject);
    if (!k) continue;
    if (!asked.has(k)) asked.set(k, new Set());
    // A capture exists only when the call SUCCEEDED — a failed call writes no
    // file and no ledger line, by design. So presence here is evidence the
    // question was asked and answered, not merely attempted.
    asked.get(k).add(c.connector);
    rowsBy.set(k, (rowsBy.get(k) || 0) + (c.results ? c.results.length : 0));
  }

  const out = [];
  for (const [set, def] of Object.entries(subjects || {})) {
    if (!def || !Array.isArray(def.subjects)) continue;
    const subs = def.subjects.map((s) => {
      const k = N.foldSubject(s);
      const cs = asked.get(k);
      return {
        subject: s,
        asked: !!cs,
        connectors: cs ? [...cs].sort() : [],
        rows: rowsBy.get(k) || 0,
      };
    });
    const done = subs.filter((s) => s.asked);
    out.push({
      set,
      defined: subs.length,
      asked: done.length,
      // NOT a percentage of anything real until `defined` is itself
      // defensible — a set is a list somebody typed, not a census.
      share: subs.length ? done.length / subs.length : 0,
      rows: subs.reduce((n, s) => n + s.rows, 0),
      missing: subs.filter((s) => !s.asked).map((s) => s.subject),
      connectors: [...new Set(done.flatMap((s) => s.connectors))].sort(),
      subjects: subs,
    });
  }
  // Emptiest first. The ones with nothing in them are the ones that will be
  // misread as findings.
  return out.sort((a, b) => a.share - b.share || a.set.localeCompare(b.set));
}

/**
 * Per-connector coverage: which registers have actually been asked, and how
 * often did they carry a row that NAMES the subject rather than merely
 * matching something.
 *
 * A connector with a thousand rows and no name matches has not told you about
 * your subject. It has told you about its own index.
 */
function connectorCoverage(captures) {
  const by = new Map();
  for (const c of captures) {
    if (!by.has(c.connector)) {
      by.set(c.connector, {
        connector: c.connector,
        label: (R.CONNECTORS[c.connector] || {}).label || c.connector,
        captures: 0, subjects: new Set(), rows: 0, unparsed: 0,
        capped: 0, NAME: 0, CONTAINS: 0, SUBSTRING: 0, OTHER: 0, UNKNOWN: 0,
      });
    }
    const g = by.get(c.connector);
    g.captures += 1;
    g.subjects.add(N.foldSubject(c.subject));
    if (c.unparsed) { g.unparsed += 1; continue; }
    g.rows += c.results.length;
    // `truncated` is set when the source declared a count larger than the rows
    // it handed over. THAT IS THE FLOOR DETECTOR and it was already being
    // parsed and never reported anywhere.
    if (c.truncated) g.capped += 1;
    for (const r of c.results) {
      g[NM.bestVerdict(c.subject, r.name || r.title || '')] += 1;
    }
  }
  return [...by.values()]
    .map((g) => ({ ...g, subjects: g.subjects.size }))
    .sort((a, b) => b.rows - a.rows);
}

/**
 * Which captures are a FLOOR rather than a total, named individually.
 *
 * The page cap is the single most common way a number leaves this desk
 * wearing the wrong clothes.
 */
function flooredCaptures(captures) {
  return captures
    .filter((c) => c.truncated)
    .map((c) => ({
      connector: c.connector, subject: c.subject,
      held: c.results.length, declared: c.total,
      missing: (c.total || 0) - c.results.length,
      file: c.file,
    }))
    .sort((a, b) => b.missing - a.missing);
}

/**
 * The shape of a count, decided from the capture rather than from a habit.
 *
 * `fuzzy` is the caller's statement that the register matched loosely —
 * USAspending's `recipient_search_text` and OpenCorporates both do. A fuzzy
 * search that was not exhausted is BOTH a floor and a ceiling, which is worth
 * saying out loud rather than picking the friendlier one.
 */
function shapeOf({ truncated, fuzzy, nameShare }) {
  if (truncated && fuzzy) return 'FLOOR AND CEILING';
  if (truncated) return FLOOR;
  if (fuzzy && nameShare !== undefined && nameShare < 1) return CEILING;
  if (truncated === undefined) return UNKNOWN;
  return TOTAL;
}

/**
 * Every number the library can currently produce, WITH its denominator.
 *
 * Deliberately small. A long list of derived statistics is how a desk starts
 * quoting itself; this is the handful a sentence actually gets built on.
 */
function figures(captures, subjects) {
  const sets = setCoverage(captures, subjects);
  const conns = connectorCoverage(captures);
  const floors = flooredCaptures(captures);
  const built = N.build(captures, subjects);
  const bridges = N.bridges(built);

  const rows = conns.reduce((n, c) => n + c.rows, 0);
  const named = conns.reduce((n, c) => n + c.NAME, 0);
  const definedSubjects = sets.reduce((n, s) => n + s.defined, 0);
  const askedSubjects = sets.reduce((n, s) => n + s.asked, 0);

  return [
    {
      label: 'subjects asked',
      value: askedSubjects, of: definedSubjects,
      shape: askedSubjects === definedSubjects ? TOTAL : FLOOR,
      note: 'Of the subjects DEFINED in subjects.json. A set is a list somebody '
          + 'typed, not a census — so this is coverage of the plan, not of the world.',
    },
    {
      label: 'rows held',
      value: rows, of: null, shape: TOTAL,
      note: 'Rows parsed out of captures on disk. Exact, and about this library only.',
    },
    {
      label: 'rows FILED UNDER a subject name',
      value: named, of: rows,
      shape: rows ? TOTAL : UNKNOWN,
      note: 'The rest match somewhere else in the name, only inside a longer '
          + 'word, or not at all. THIS is the number a lead count should be.',
    },
    {
      label: 'captures that hit a page cap',
      value: floors.length, of: captures.length,
      shape: TOTAL,
      note: floors.length
        ? 'Every figure derived from one of these is a FLOOR. The real number '
          + 'is larger by an unknown amount.'
        : 'No capture declared more rows than it handed over.',
    },
    {
      label: 'entities bridging two domains',
      value: new Set(bridges.map((b) => b.key)).size,
      of: built.entities.length,
      shape: TOTAL,
      note: 'Of the entities in the library. Nothing can bridge to a domain '
          + 'with nothing in it, so read this against set coverage above.',
    },
    {
      label: 'bridges resting on a sworn filing or an award',
      value: bridges.filter((b) => b.grade === 'ASSERTED').length,
      of: bridges.length,
      shape: TOTAL,
      note: 'The rest rest on a registration, or on two names appearing in one '
          + 'document — which is never a finding on its own.',
    },
  ];
}

/** Sets defined and never swept at all. The most misreadable thing here. */
function neverAsked(sets) {
  return sets.filter((s) => s.asked === 0).map((s) => s.set);
}

module.exports = {
  TOTAL, FLOOR, CEILING, UNKNOWN,
  setCoverage, connectorCoverage, flooredCaptures, shapeOf, figures, neverAsked,
};
