'use strict';
/**
 * modules/connectors/crosslink.js — which names appear in more than one place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND THE HARD LIMIT ON IT
 *
 * After a dozen searches the evidence store holds hundreds of leads across
 * separate captures, and the interesting question is no longer "what did the
 * search return" but "what turns up under more than one subject". A lobbying
 * registrant that files for an energy company AND for a data-center operator
 * is a thread worth pulling. So is a company that appears in a court docket
 * and a federal award.
 *
 * That is a CO-OCCURRENCE, and co-occurrence is not a relationship. Two firms
 * with similar names, a common registrant that lobbies for four hundred
 * clients, a court caption that happens to contain a word — all of those look
 * identical to this code. What it produces is a shortlist of places to look,
 * ranked by how unlikely the overlap is, and nothing more.
 *
 * It reads only what is already captured. It makes no network call, so running
 * it costs nothing and can be repeated as the library grows.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY LOBBYING FILINGS ARE TREATED SEPARATELY
 *
 * Senate LDA results carry "client — registrant" in one field, which is an
 * actual asserted relationship rather than a coincidence of names: a filing is
 * a sworn statement that this firm lobbied for that client. Those are split
 * and reported as edges in their own right, distinct from mere co-occurrence,
 * because the evidentiary weight is completely different.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');

/** Corporate suffixes and filler that make the same entity look like two. */
const SUFFIXES = [
  'llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'co',
  'company', 'ltd', 'limited', 'lp', 'llp', 'plc', 'gmbh', 'ag', 'bv', 'nv',
  'sa', 'pty', 'holdings', 'holding', 'group', 'partners', 'partnership',
  'the', 'and', 'of',
];

/**
 * Fold a name for comparison. Aggressive on punctuation and suffixes, because
 * "COLOGIX, INC." and "Cologix Inc" are one entity, and conservative about
 * anything else — dropping a real word would merge two entities that are not
 * the same, which is the error that matters here.
 */
function normalise(name) {
  if (!name) return '';
  let n = String(name).toLowerCase()
    // Periods and apostrophes are DELETED, not spaced. Spacing them turns
    // "L.L.C." into three single letters the suffix list never sees, and
    // splits "O'Brien" into "o brien" so it never matches "OBrien".
    .replace(/[.''`\u2019]/g, '')
    .replace(/[,"()]/g, ' ')
    .replace(/[^a-z0-9&\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = n.split(' ').filter((w) => w && !SUFFIXES.includes(w));

  // A name made ENTIRELY of suffix words folds to nothing, and every such name
  // then collapses onto the same empty key: "Partners Holdings", "Group
  // Holdings" and "Capital Partners" become one entity that appears to be
  // connected to everything it was ever filed beside. Real registrants and
  // clients are named this way.
  //
  // If there is nothing left, the suffixes ARE the name -- so keep them. This
  // only fires where the alternative was the empty string, so no name that
  // folded to something real folds differently now.
  if (!words.length) return n;

  return words.join(' ');
}

/**
 * Split a compound label into the entities inside it.
 *
 * A court caption is not an entity name. "WIDE REACH SYSTEMS v. Someone" is
 * two parties, and indexing it whole means the plaintiff never matches the
 * same company found in a corporate registry — which is precisely the link
 * worth having. Captions and lobbying filings are the two places in this
 * library where a single field carries more than one name.
 */
function splitParties(raw) {
  const s = String(raw);
  // Captions carry procedural noise whether or not they have two parties:
  // "In re AEP Ohio Tariff" has one party and still needs the prefix removed.
  const clean = (x) => x
    .replace(/^\s*(in re:?|ex parte|state ex rel\.?|united states ex rel\.?)\s+/i, '')
    .replace(/,?\s*et al\.?\s*$/i, '')
    .trim();

  if (s.includes(' — ')) return s.split(' — ').map(clean).filter(Boolean);
  // " v. ", " v ", " vs. " — the caption forms CourtListener returns.
  const m = s.split(/\s+v[s]?\.?\s+/i);
  if (m.length > 1 && m.length <= 4) return m.map(clean).filter(Boolean);
  return [clean(s)].filter(Boolean);
}

/** Names too generic to be worth reporting as a connection. */
const STOPWORDS = new Set([
  '', 'unnamed', 'untitled', 'client?', 'registrant?', 'no name',
  'united states', 'usa', 'department', 'state', 'city', 'county', 'court',
]);

/**
 * Markers in the ORIGINAL name that identify an organisation. This is
 * evidence, not a guess: "LLC" in the name someone filed under is a fact
 * about the entity.
 */
const ORG_MARKERS = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|group|partners|partnership|holdings?|lp|llp|plc|gmbh|ag|b\.?v|n\.?v|s\.?a|s\.r\.l|pty|associates|systems|services|solutions|technologies|energy|power|electric|gas|utilities|bank|capital|trust|foundation|association|university|college|county|city|state|department|authority|district|commission|board|agency|institute|society|union|council)\b/i;

/**
 * Is this name too generic — or not an entity at all — to report as a link?
 *
 * The hard case is a single bare word. Splitting court captions produced
 * "Williams", "Salter", "Patterson", "Woodhouse" — the plaintiffs' surnames.
 * A surname on its own connects nothing, matches thousands of unrelated
 * people, and reporting it as an overlap is actively misleading.
 *
 * An earlier version tried to tell a surname from a company by counting
 * letters and looking for uncommon ones. That is guessing, and it guessed
 * wrong in both directions — it dropped ALPINE GROUP PARTNERS and NISOURCE
 * INC. while keeping "Williams". The rule now asks for actual evidence: does
 * the name as filed carry a corporate marker? "NISOURCE INC." does.
 * "Williams" does not.
 *
 * A single-word company with no suffix anywhere ("Cologix" bare) is dropped
 * as a consequence. That is the right side of the trade: it almost always
 * appears elsewhere WITH a suffix, and a false link costs more than a missed
 * one in a tool whose entire output is a shortlist to check by hand.
 */
function tooGeneric(norm, raw, opts = {}) {
  if (!norm) return true;
  if (STOPWORDS.has(norm)) return true;

  // WHERE THE NAME CAME FROM DECIDES HOW MUCH GUESSING IS ALLOWED.
  //
  // The surname rule below exists because splitting court captions produced
  // plaintiffs' surnames, and "Williams" indexed as a company is noise. But
  // it is a GUESS, and applied everywhere it ate real companies: RWE,
  // VERIZON, LEIDOS, SPACEX, DOORDASH, COVISTA -- every single-word corporate
  // name without an Inc or LLC on it. Those were silently absent from the
  // index, so they never became subjects and were reported as "new" on every
  // single run.
  //
  // A Senate LDA filing does not need guessing. `client.name` and
  // `registrant.name` are structured fields that hold an organisation by
  // definition of the form; there is no caption to split and no plaintiff to
  // mistake. So a name taken from such a field skips the guess entirely.
  if (opts.assumeOrg) return false;

  if (norm.length < 4) return true;

  // A corporate marker in the filed name settles it.
  if (raw && ORG_MARKERS.test(String(raw))) return false;

  // No marker, and one word after folding: treat as a person's surname.
  if (!norm.includes(' ')) return true;

  return false;
}

/**
 * Read every capture and re-parse it with the connector that produced it.
 * The filename carries the connector and the subject, which is why the naming
 * convention in runConnector is load-bearing rather than cosmetic.
 */
function readCaptures(captureDir) {
  const out = [];
  let files;
  try { files = fs.readdirSync(captureDir); }
  catch { return out; }

  for (const f of files) {
    if (!f.startsWith('live_capture_') || !f.endsWith('.json')) continue;
    // live_capture_<connector>_<subject-slug>_<iso-stamp>.json
    const stem = f.slice('live_capture_'.length, -'.json'.length);
    const connector = Object.keys(R.CONNECTORS).find((n) => stem.startsWith(n + '_'));
    if (!connector) continue;
    const rest = stem.slice(connector.length + 1);
    const subject = rest.replace(/_\d{4}-\d{2}-\d{2}T.*$/, '').replace(/_/g, ' ');

    let results = [];
    let total = null;
    let truncated = false;
    try {
      const body = JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8'));
      results = R.CONNECTORS[connector].parse(body) || [];
      // `count` is what the source said the FULL result set was. Captures stop
      // at the page size, so a count larger than the rows we kept means this
      // capture is a slice. Absent count means truncation is unknown, which is
      // not the same as absent -- so it stays null rather than becoming false.
      total = Number.isFinite(body && body.count) ? body.count : null;
      truncated = total !== null && total > results.length;
    } catch {
      // A capture that will not parse is not a crash. It stays on disk, hashed,
      // and is reported in the summary rather than silently skipped.
      out.push({ file: f, connector, subject, results: [], unparsed: true });
      continue;
    }
    out.push({ file: f, connector, subject, results, total, truncated });
  }
  return out;
}

/**
 * Build the index: normalised name -> every place it was seen.
 */
function index(captures) {
  const byName = new Map();
  const edges = [];       // asserted client—registrant relationships

  for (const cap of captures) {
    for (const r of cap.results) {
      const raw = r.name || r.title || '';
      if (!raw) continue;

      // Some connectors return document titles rather than parties. A Federal
      // Register notice appearing under four subjects means the full-text
      // search matched it four times — a search artifact, not a connection.
      if (R.CONNECTORS[cap.connector] && R.CONNECTORS[cap.connector].entityNames === false) {
        continue;
      }

      // Lobbying filings assert a relationship rather than merely co-occur.
      if (cap.connector === 'senatelda' && raw.includes(' — ')) {
        const [client, registrant] = raw.split(' — ').map((x) => x.trim());
        if (client && registrant && !/\?/.test(client) && !/\?/.test(registrant)) {
          edges.push({
            client, registrant,
            client_key: normalise(client), registrant_key: normalise(registrant),
            amount: r.amount || '', issues: r.issues || '',
            // WHEN. Carried because "this firm lobbies for both sides" is a
            // claim about SIMULTANEITY, and without a date the strongest row
            // in this whole tool cannot be told apart from two engagements two
            // years apart. Real case: Akin Gump filed for Energy Harbor every
            // quarter from 2021 Q2 to 2024 Q1, and for AWS, Microsoft and Axon
            // in 2026. Never once at the same time. The undated view read as
            // one firm carrying the nuclear beneficiary and the data centers
            // together, which is a different and false story.
            period: r.period || '',
            year: (String(r.period || '').match(/\b(19|20)\d{2}\b/) || [])[0] || null,
            subject: cap.subject, url: r.url || '',
          });
        }
      }

      // A senatelda row's name is built from client.name and registrant.name --
      // structured organisation fields, not a caption that had to be split.
      const assumeOrg = cap.connector === 'senatelda';
      for (const piece of splitParties(raw)) {
        const key = normalise(piece);
        if (tooGeneric(key, piece, { assumeOrg })) continue;
        if (!byName.has(key)) byName.set(key, { key, display: piece.trim(), seen: [] });
        byName.get(key).seen.push({
          connector: cap.connector, subject: cap.subject,
          display: piece.trim(),
          detail: [r.jurisdiction, r.amount, r.agency, r.incorporated, r.date]
            .filter(Boolean).join(' · '),
          url: r.url || '',
        });
      }
    }
  }
  return { byName, edges };
}

/**
 * Names that appear under more than one SUBJECT — the thing worth looking at.
 * Appearing twice under one subject is just the same search returning the same
 * company twice, which says nothing.
 */
function crossSubject(byName, opts = {}) {
  const min = opts.minSubjects || 2;
  const out = [];
  for (const entry of byName.values()) {
    const subjects = [...new Set(entry.seen.map((s) => s.subject))];
    const connectors = [...new Set(entry.seen.map((s) => s.connector))];
    if (subjects.length < min) continue;
    out.push({
      name: entry.display, key: entry.key,
      subjects, connectors, hits: entry.seen.length, seen: entry.seen,
      // More subjects and more independent sources is a stronger signal than
      // the same source repeating.
      weight: subjects.length * 10 + connectors.length,
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Registrants that file for more than one client across the library. */
function sharedRegistrants(edges, opts = {}) {
  const min = opts.minClients || 2;
  const byReg = new Map();
  for (const e of edges) {
    if (!byReg.has(e.registrant_key)) {
      byReg.set(e.registrant_key, { registrant: e.registrant, clients: new Map() });
    }
    const g = byReg.get(e.registrant_key);
    if (!g.clients.has(e.client_key)) g.clients.set(e.client_key, { client: e.client, filings: [] });
    g.clients.get(e.client_key).filings.push(e);
  }
  const out = [];
  for (const g of byReg.values()) {
    if (g.clients.size < min) continue;
    out.push({
      registrant: g.registrant,
      clients: [...g.clients.values()].map((c) => ({
        client: c.client, filings: c.filings.length,
        subjects: [...new Set(c.filings.map((f) => f.subject))],
      })),
      client_count: g.clients.size,
    });
  }
  return out.sort((a, b) => b.client_count - a.client_count);
}

/**
 * The same filings, ranked by how UNLIKELY the overlap is instead of how big
 * the firm is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `sharedRegistrants` sorts by client_count, so ALPINE GROUP PARTNERS — 398
 * clients — is first, and will be first forever, on every investigation, no
 * matter what the subject list is. Then Harbinger with 118. Twenty rows of
 * mega-firms before anything specific to the question being asked.
 *
 * That ordering is exactly backwards. A firm that represents four hundred
 * clients carrying two of your subjects is the LEAST surprising thing in the
 * data — it carries almost everyone, so it carries these too. The interesting
 * row is the six-client boutique that happens to file for both a distribution
 * utility and a data-center operator. That is a firm whose whole book is this
 * fight, and it is currently buried.
 *
 * This module's own header promises results "ranked by how unlikely the
 * overlap is". Nothing implemented that. This does.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MEASURE, AND WHY IT IS THIS ONE
 *
 *     concentration = subjects_covered / client_count
 *
 * How much of a firm's book sits on your threads. Alpine: 12/398 = 0.03.
 * A boutique carrying two of your subjects across three clients: 2/3 = 0.67.
 *
 * TWO GUARDS, both learned from what the naive version surfaces:
 *
 *  1. `clients_on_subjects >= 2`. Without it, a registrant with ONE client
 *     scores 2.0 when that single client happens to appear under two of your
 *     search terms — which measures your duplicate searching (AEP Ohio is in
 *     both `energy` and `ratepayers`), not the firm's book. Two DISTINCT
 *     clients on two DISTINCT threads is the claim worth making.
 *
 *  2. client_count is the firm's WHOLE book as far as the library knows it,
 *     not just the matched clients — otherwise every firm scores 1.0 and the
 *     ranking says nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS STILL IS NOT
 *
 * A high score is a REGISTRANT WORTH READING, not a finding. The filings are
 * sworn under 2 U.S.C. 1603-1604, so the firm-client link is real — but "this
 * firm lobbies for both sides" is an inference about motive that no filing
 * states, and the library's client counts are floors (truncated captures mean
 * a firm shown with three clients may have thirty, which would collapse its
 * score). Pull the filings and read them.
 */
function concentrated(edges, opts = {}) {
  const minClients = opts.minClients || 2;
  const minSubjects = opts.minSubjects || 2;

  const byReg = new Map();
  for (const e of edges) {
    if (!byReg.has(e.registrant_key)) {
      byReg.set(e.registrant_key, { registrant: e.registrant, clients: new Map() });
    }
    const g = byReg.get(e.registrant_key);
    if (!g.clients.has(e.client_key)) {
      g.clients.set(e.client_key, { client: e.client, subjects: new Set(), filings: 0, years: new Set() });
    }
    const c = g.clients.get(e.client_key);
    c.filings++;
    if (e.subject) c.subjects.add(e.subject);
    if (e.year) c.years.add(Number(e.year));
  }

  const out = [];
  for (const g of byReg.values()) {
    const clients = [...g.clients.values()];
    const onSubjects = clients.filter((c) => c.subjects.size > 0);
    const subjects = new Set();
    for (const c of onSubjects) for (const s of c.subjects) subjects.add(s);

    if (onSubjects.length < minClients) continue;
    if (subjects.size < minSubjects) continue;

    const matched = onSubjects
      .map((c) => ({
        client: c.client,
        filings: c.filings,
        subjects: [...c.subjects],
        from: c.years.size ? Math.min(...c.years) : null,
        to: c.years.size ? Math.max(...c.years) : null,
      }))
      .sort((a, b) => b.filings - a.filings);

    // DO THE ENGAGEMENTS OVERLAP IN TIME?
    //
    // The whole force of this section is "one firm, several of your threads".
    // Whether those threads were carried AT THE SAME TIME is a different claim
    // and the one a reader will assume. Two clients whose filing years never
    // intersect is a sequence, not a both-sides engagement, and it must not be
    // presented as the latter.
    const dated = matched.filter((m) => m.from !== null);
    let concurrent = null;                       // null = not enough dates to say
    if (dated.length >= 2) {
      concurrent = dated.some((a, i) => dated.some((b, j) =>
        i !== j && a.from <= b.to && b.from <= a.to));
    }

    out.push({
      registrant: g.registrant,
      client_count: clients.length,
      clients_on_subjects: onSubjects.length,
      subjects: [...subjects],
      // Threads bridged. NOT a percentage: the old `subjects / client_count`
      // read as "how much of this firm's book is your investigation", and the
      // denominator is only the clients the LIBRARY knows — which is only the
      // clients you searched. Akin Gump showed "4 of 4 known clients, 100%"
      // while actually having hundreds. It also exceeded 100% whenever one
      // client matched two subject spellings of the same company
      // (SoundThinking / ShotSpotter after the rename).
      //
      // What the data does establish is the count of your threads this one
      // registrant connects. That is a fact about the filings, not an estimate
      // about the firm.
      threads: subjects.size,
      // Kept for ORDERING and never printed. As a displayed statistic it
      // overclaims (the denominator is only what you searched, and it can
      // exceed 1.0 when one client matches two spellings of the same
      // company). As a sort key it is exactly right: without it, a firm with
      // four hundred clients bridges more threads than a boutique simply by
      // having more clients, and the mega-firms retake the top of the list —
      // the whole defect this section was written to fix.
      _rank: subjects.size / clients.length,
      concurrent,
      span: dated.length
        ? { from: Math.min(...dated.map((m) => m.from)), to: Math.max(...dated.map((m) => m.to)) }
        : null,
      matched,
    });
  }

  return out.sort((a, b) => {
    // Concurrent engagements first: same firm, same period, different threads
    // is the strongest shape here. `null` (undated) ranks between yes and no
    // rather than at either end, because unknown is not the same as no.
    const rank = (x) => (x.concurrent === true ? 0 : x.concurrent === null ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (b._rank !== a._rank) return b._rank - a._rank;
    if (b.threads !== a.threads) return b.threads - a.threads;
    if (a.client_count !== b.client_count) return a.client_count - b.client_count;
    return b.clients_on_subjects - a.clients_on_subjects;
  });
}

module.exports = {
  readCaptures, index, crossSubject, sharedRegistrants, concentrated,
  normalise, tooGeneric, splitParties,
};
