'use strict';
/**
 * modules/connectors/nexus.js — WHERE TWO DOMAINS TOUCH, AND ON WHOSE WORD.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUESTION THIS EXISTS TO ANSWER
 *
 * "Find me the companies involved in the data centres and the land deals who
 * are also involved with lobbyists, federal contracts or unions."
 *
 * `crosslink` already finds names appearing under more than one SUBJECT. That
 * is not the same question. Two data-centre operators both turning up under
 * two data-centre searches is a crosslink hit and tells you nothing: they were
 * both data-centre searches. What matters is a name that appears on the
 * DATA-CENTRE side of the library AND on the LOBBYING side, or the ENERGY
 * side, or in a federal award — because those are different registers asking
 * different questions, and a name in both had to get there twice.
 *
 * A subject set in `subjects.json` is already a domain. This reads the
 * capture library, assigns every sighting to the domain whose set contains
 * the subject that was searched, and reports entities that bridge two.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THING THAT MAKES THIS DIFFERENT FROM A CO-OCCURRENCE TOOL
 *
 * A bridge is only as good as the record underneath it, and the records in
 * this library are not of one kind. Three grades, and the grade is printed on
 * every row:
 *
 *   ASSERTED      Somebody swore to it. A Senate LDA filing is a sworn
 *                 statement that this firm lobbied for that client. A
 *                 USAspending award is an obligation of public money with a
 *                 contract number. These are records OF A TRANSACTION.
 *
 *   REGISTRY      The entity exists as filed — an OpenCorporates registration,
 *                 an FEC committee. Says the thing is real and where. Says
 *                 nothing about what it did.
 *
 *   CO-OCCURRENCE Two names showed up in the same document title, docket
 *                 caption or search index. THE WEAKEST THING IN THIS FILE.
 *                 Two companies named in one Federal Register notice have no
 *                 relationship whatsoever; they were both in a list.
 *
 * A bridge made entirely of CO-OCCURRENCE is a place to look, not a finding,
 * and the display says so on the row rather than in a footnote nobody reads.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE DENOMINATOR, BECAUSE THIS IS THE COMMAND MOST LIKELY TO PRODUCE A
 * CONFIDENT WRONG ANSWER
 *
 * "AEP Ohio bridges energy and lobbying" sounds like a finding until you ask
 * how many entities bridge energy and lobbying. If the answer is ninety, the
 * bridge is what a regulated utility IS. Every domain pair therefore carries
 * the count of entities that bridge it, and a pair crossed by many is ranked
 * DOWN, not up.
 *
 * Rarity is measured against what you asked, not against the world. A library
 * of ten searches makes everything look rare. The display says that too.
 *
 * No network call. Everything here is already on disk, hashed, in the ledger.
 */

const fs = require('fs');
const path = require('path');
const X = require('./crosslink.js');

/**
 * Which register carried this sighting, and how much weight it can hold.
 *
 * The connector is the evidence type. This is not a judgement about the
 * source's quality — CourtListener is excellent — it is a statement about
 * what a row from that source IS. A docket caption naming two parties asserts
 * that they are in litigation together, which is real; a full-text search
 * result naming two companies asserts only that a search matched.
 */
const GRADE = {
  senatelda: 'ASSERTED',        // a sworn filing: this firm lobbied for this client
  usaspending: 'ASSERTED',      // an obligation of public money, with an award id
  fec: 'REGISTRY',
  opencorporates: 'REGISTRY',   // filed with a state, in a jurisdiction, on a date
  opensanctions: 'REGISTRY',
  cldocket: 'ASSERTED',         // the caption as the court keeps it
  clparties: 'ASSERTED',        // the party table, with roles
  courtlistener: 'CO-OCCURRENCE',  // a relevance-ranked search index (see §78)
  federalregister: 'CO-OCCURRENCE',
  fedregdoc: 'CO-OCCURRENCE',
  fedregtext: 'CO-OCCURRENCE',
  regulationsgov: 'CO-OCCURRENCE',
  bls: 'CO-OCCURRENCE',
};

const GRADE_RANK = { ASSERTED: 3, REGISTRY: 2, 'CO-OCCURRENCE': 1 };

function gradeOf(connector) { return GRADE[connector] || 'CO-OCCURRENCE'; }

/**
 * subject-as-searched → the domain(s) it belongs to.
 *
 * Capture filenames carry the subject with punctuation flattened to
 * underscores, so "AXON ENTERPRISE, INC." comes back as
 * "AXON ENTERPRISE  INC ". Matching has to be loose on punctuation and strict
 * on words, or half the library lands in `ad-hoc` and the bridges vanish.
 */
function domainIndex(subjects) {
  const map = new Map();
  for (const [set, def] of Object.entries(subjects || {})) {
    if (!def || !Array.isArray(def.subjects)) continue;
    for (const s of def.subjects) {
      const k = foldSubject(s);
      if (!k) continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(set);
    }
  }
  return map;
}

function foldSubject(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Domains for one searched subject. A subject can sit in more than one set —
 * "Intel Corporation" is in both `datacenters` and `intel_newalbany` — and
 * that is not a problem to resolve, it is the map being accurate.
 *
 * A subject in NO set is `ad-hoc`: something typed by hand rather than swept.
 * Those are kept, because the best leads in this investigation were typed by
 * hand, and a domain called ad-hoc is honest about what it is.
 */
function domainsFor(subject, index) {
  const k = foldSubject(subject);
  if (index.has(k)) return [...index.get(k)];
  // A swept subject truncated by the 60-character slug cap still has a
  // recoverable head. Prefix match, longest first, so "Amazon Data Services"
  // does not silently answer for "Amazon".
  const keys = [...index.keys()].filter((x) => k && (k.startsWith(x + ' ') || x.startsWith(k + ' ')));
  if (keys.length) {
    keys.sort((a, b) => b.length - a.length);
    return [...index.get(keys[0])];
  }
  return ['ad-hoc'];
}

/**
 * Every entity, with the domains it was seen in and the register that carried
 * each sighting.
 *
 * Built on `crosslink.index`, deliberately: one name-folding implementation,
 * one set of too-generic rules. A second normaliser here would mean two
 * different answers to "is this the same company".
 */
function build(captures, subjects) {
  const index = domainIndex(subjects);
  const { byName, edges } = X.index(captures);

  const entities = [];
  for (const entry of byName.values()) {
    const domains = new Map();     // domain -> { connectors:Set, subjects:Set, grade }
    for (const s of entry.seen) {
      for (const d of domainsFor(s.subject, index)) {
        if (!domains.has(d)) {
          domains.set(d, { domain: d, connectors: new Set(), subjects: new Set(), sightings: new Set() });
        }
        const g = domains.get(d);
        g.connectors.add(s.connector);
        g.subjects.add(s.subject);
        // WHICH SEARCH PUT IT HERE.
        //
        // One row can land in several domains at once, because a subject can
        // be listed in several sets — "AEP Ohio" is in `energy`, `ratepayers`
        // AND `intel_newalbany`. Without this, a single USAspending award
        // produced three "bridges" between those three sets, every one of
        // them nothing but the subject file's own filing system reflected
        // back. That is the defect this whole repository is about: the shape
        // of the question mistaken for a fact about the world.
        g.sightings.add(`${s.connector}|${s.subject}`);
      }
    }
    const list = [...domains.values()].map((g) => ({
      domain: g.domain,
      connectors: [...g.connectors].sort(),
      subjects: [...g.subjects].sort(),
      sightings: [...g.sightings].sort(),
      grade: [...g.connectors].reduce(
        (best, c) => (GRADE_RANK[gradeOf(c)] > GRADE_RANK[best] ? gradeOf(c) : best),
        'CO-OCCURRENCE'),
    })).sort((a, b) => a.domain.localeCompare(b.domain));
    entities.push({
      name: entry.display, key: entry.key,
      domains: list,
      hits: entry.seen.length,
      connectors: [...new Set(entry.seen.map((s) => s.connector))].sort(),
    });
  }
  return { entities, edges, index };
}

/** Every unordered pair of distinct domains, as a stable key. */
function pairsOf(domains) {
  const names = [...new Set(domains.map((d) => d.domain))].sort();
  const out = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) out.push([names[i], names[j]]);
  }
  return out;
}

/**
 * The bridges, ranked.
 *
 * `opts.sides` restricts to bridges touching those domains. `opts.require`
 * demands a connector. `opts.grade` demands an evidence grade. `opts.minGrade`
 * is the useful one: `ASSERTED` drops every bridge that rests only on two
 * names appearing in the same document.
 */
function bridges(built, opts = {}) {
  const sides = (opts.sides || []).filter(Boolean);
  const out = [];

  for (const e of built.entities) {
    if (e.domains.length < 2) continue;
    for (const [a, b] of pairsOf(e.domains)) {
      if (sides.length === 1 && a !== sides[0] && b !== sides[0]) continue;
      if (sides.length >= 2
        && !(sides.includes(a) && sides.includes(b))) continue;
      const da = e.domains.find((d) => d.domain === a);
      const db = e.domains.find((d) => d.domain === b);

      // TWO DOMAINS REACHED BY ONE SEARCH IS NOT A BRIDGE.
      //
      // `subjects.json` lists "AEP Ohio" under energy, ratepayers AND
      // intel_newalbany. One USAspending award therefore lands in all three,
      // and a naive pairing reported three bridges — energy↔ratepayers,
      // energy↔intel_newalbany, intel_newalbany↔ratepayers — none of which
      // was anything but the subject file's own filing system, printed back
      // as a discovery.
      //
      // A bridge requires an independent sighting on EACH side: something
      // that reached domain A which did not also reach domain B, and the
      // reverse. That is what "it had to get there twice" means.
      if (!opts.allowTaxonomy) {
        const onlyA = da.sightings.some((s) => !db.sightings.includes(s));
        const onlyB = db.sightings.some((s) => !da.sightings.includes(s));
        if (!onlyA || !onlyB) continue;
      }

      const connectors = [...new Set([...da.connectors, ...db.connectors])].sort();
      if (opts.require && !connectors.includes(opts.require)) continue;

      // The grade of a BRIDGE is the WEAKER of its two sides. A sworn lobbying
      // filing on one side and a full-text search hit on the other is a
      // full-text search hit: the chain is only as strong as the link that
      // has to hold.
      const grade = GRADE_RANK[da.grade] <= GRADE_RANK[db.grade] ? da.grade : db.grade;
      if (opts.minGrade && GRADE_RANK[grade] < GRADE_RANK[opts.minGrade]) continue;
      if (opts.grade && grade !== opts.grade) continue;

      out.push({
        name: e.name, key: e.key,
        a, b, pair: `${a} ↔ ${b}`,
        grade,
        connectors,
        sides: { [a]: da, [b]: db },
        hits: e.hits,
      });
    }
  }

  // ---- the denominator -------------------------------------------------
  //
  // How many entities cross this same pair? A pair crossed by ninety is what
  // an industry looks like; a pair crossed by one is a question. The count
  // goes ON the row and into the sort.
  const pairCount = new Map();
  for (const b of out) pairCount.set(b.pair, (pairCount.get(b.pair) || 0) + 1);
  for (const b of out) b.pairPopulation = pairCount.get(b.pair);

  return out.sort((x, y) => {
    if (GRADE_RANK[y.grade] !== GRADE_RANK[x.grade]) return GRADE_RANK[y.grade] - GRADE_RANK[x.grade];
    if (x.pairPopulation !== y.pairPopulation) return x.pairPopulation - y.pairPopulation;
    if (y.connectors.length !== x.connectors.length) return y.connectors.length - x.connectors.length;
    return x.name.localeCompare(y.name);
  });
}

/** Domain pairs with their populations — the table that keeps rarity honest. */
function pairTable(bs) {
  const m = new Map();
  for (const b of bs) {
    if (!m.has(b.pair)) m.set(b.pair, { pair: b.pair, a: b.a, b: b.b, entities: new Set(), grades: {} });
    const g = m.get(b.pair);
    g.entities.add(b.key);
    g.grades[b.grade] = (g.grades[b.grade] || 0) + 1;
  }
  return [...m.values()]
    .map((g) => ({ pair: g.pair, a: g.a, b: g.b, count: g.entities.size, grades: g.grades }))
    .sort((x, y) => x.count - y.count);
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE NEGATIVE SPACE: JOINS THIS TOOLKIT CANNOT MAKE, AND WHO HOLDS THEM
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Asked for connections between Ohio officials and data centres, a tool that
 * only reports what it found will report federal lobbying and federal
 * contracts, because those are the registers it has — and the reader will
 * conclude that is where the connections are. It is not. It is where the
 * SEARCHABLE connections are. Every substantive join in the Ohio data-centre
 * story lives in a county or state office that no connector here can reach.
 *
 * This list is the most useful output of the command, and it is static on
 * purpose: it does not depend on what happened to be captured, because an
 * absence produced by a missing connector must not be reported as an absence
 * in the world. That mistake is §42, §61, §66 and §74 of this investigation.
 */
const UNREACHABLE = [
  { join: 'Ohio official → anything',
    why: 'No connector here holds Ohio state or county officeholders. FEC covers FEDERAL candidates only, so an Ohio legislator, a PUCO commissioner or a county commissioner is invisible to every command in this toolkit.',
    register: 'Ohio Secretary of State campaign finance (state candidates and PACs) · Ohio Ethics Commission financial disclosure statements (OEC Form A) · county board of elections filings',
    how: 'By hand. R.C. 149.43(C)(2): hand delivery, electronic submission or certified mail preserves statutory damages.' },

  { join: 'company → parcel, price, date',
    why: 'A land assembly is a chain of recorded deeds. No federal register carries one. USAspending will answer about a federal award to a company that bought land and say nothing whatever about the land.',
    register: 'Licking County Auditor and Recorder (parcel transfers, sale prices, dates) · Franklin County equivalents',
    how: 'Free, online, nobody has to grant it. This is the cheapest open item in the investigation.' },

  { join: 'company → tax abatement, TIF, community reinvestment area',
    why: 'The money that decides whether a data centre gets built in Ohio is forgone LOCAL tax, granted by a township or municipality. It never touches a federal register.',
    register: 'Ohio Department of Development annual tax incentive reports · municipal and township council minutes and ordinances · JobsOhio (a PRIVATE non-profit — R.C. 187.04 exempts it from public records)',
    how: 'JobsOhio being outside the Public Records Act is itself a publishable fact about who can be asked.' },

  { join: 'data centre → what ratepayers pay for it',
    why: 'A large-load tariff is litigated at the state utility commission, not at FERC, and not in any register queried here.',
    register: 'PUCO docketing system (DIS), by case number · Ohio Consumers Counsel filings',
    how: 'DIS is public and searchable. AEP Ohio\'s data-centre tariff case is the document.' },

  { join: 'company → union, labour agreement, workforce',
    why: 'NO CONNECTOR IN THIS TOOLKIT TOUCHES LABOUR. `bls` takes a series id and returns a statistic, not an organisation. Asking any command here about a union returns a name match in an unrelated register, and a name match is not a finding.',
    register: 'DOL Office of Labor-Management Standards — LM-2/LM-3/LM-4 filings, and the OLMS Online Public Disclosure Room · NLRB election and case records · project labour agreements, which are usually municipal contract exhibits',
    how: 'NOT BUILT. OLMS is the register to build against if this thread matters.' },

  { join: 'who paid for the post you saw',
    why: 'The advertiser layer. Documented as unavailable in THESIS.md part two, and nothing here has changed it.',
    register: 'Meta Ad Library · FCC Political File (broadcast buys, by station)',
    how: 'NOT BUILT. Joins 3 and 4 — distribution pattern and account authenticity — do not exist outside the platforms at all, for anyone.' },
];

/**
 * What the capture library can currently speak to, counted. Not a score — a
 * statement of coverage, so "no bridges found" can be read correctly.
 */
function coverage(built, subjects) {
  const seen = new Map();
  for (const e of built.entities) {
    for (const d of e.domains) {
      if (!seen.has(d.domain)) seen.set(d.domain, { domain: d.domain, entities: 0, connectors: new Set() });
      const g = seen.get(d.domain);
      g.entities += 1;
      for (const c of d.connectors) g.connectors.add(c);
    }
  }
  const known = Object.keys(subjects || {}).filter((k) => !k.startsWith('/'));
  const rows = [...seen.values()]
    .map((g) => ({ domain: g.domain, entities: g.entities, connectors: [...g.connectors].sort() }))
    .sort((a, b) => b.entities - a.entities);
  return {
    rows,
    empty: known.filter((k) => !seen.has(k)),
  };
}

/** Graphviz, because the Neo4j password is still a placeholder. */
function toDot(bs, opts = {}) {
  const lines = ['graph nexus {', '  graph [overlap=false, splines=true];',
    '  node [shape=box, fontname="Helvetica"];'];
  const domains = new Set();
  const seenEdge = new Set();
  const style = { ASSERTED: 'solid', REGISTRY: 'dashed', 'CO-OCCURRENCE': 'dotted' };
  for (const b of bs.slice(0, opts.limit || 200)) {
    domains.add(b.a); domains.add(b.b);
    const n = JSON.stringify(b.name);
    for (const d of [b.a, b.b]) {
      const k = `${b.key}|${d}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      lines.push(`  ${n} -- ${JSON.stringify(d)} [style=${style[b.grade]}];`);
    }
  }
  for (const d of domains) {
    lines.push(`  ${JSON.stringify(d)} [shape=ellipse, style=filled, fillcolor="#eeeeee"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

function toCsv(bs) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['entity', 'domain_a', 'domain_b', 'grade', 'entities_crossing_this_pair',
    'registers', 'subjects_a', 'subjects_b'];
  const rows = bs.map((b) => [
    b.name, b.a, b.b, b.grade, b.pairPopulation,
    b.connectors.join(' '),
    b.sides[b.a].subjects.join('; '),
    b.sides[b.b].subjects.join('; '),
  ]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

module.exports = {
  GRADE, GRADE_RANK, gradeOf, UNREACHABLE,
  foldSubject, domainIndex, domainsFor,
  build, bridges, pairsOf, pairTable, coverage, toDot, toCsv,
};
