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

function tooGeneric(norm) {
  if (STOPWORDS.has(norm)) return true;
  if (norm.length < 4) return true;
  // A single very common word is not an entity.
  if (!norm.includes(' ') && norm.length < 6) return true;
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
    try {
      const body = JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8'));
      results = R.CONNECTORS[connector].parse(body) || [];
    } catch {
      // A capture that will not parse is not a crash. It stays on disk, hashed,
      // and is reported in the summary rather than silently skipped.
      out.push({ file: f, connector, subject, results: [], unparsed: true });
      continue;
    }
    out.push({ file: f, connector, subject, results });
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

      // Lobbying filings assert a relationship rather than merely co-occur.
      if (cap.connector === 'senatelda' && raw.includes(' — ')) {
        const [client, registrant] = raw.split(' — ').map((x) => x.trim());
        if (client && registrant && !/\?/.test(client) && !/\?/.test(registrant)) {
          edges.push({
            client, registrant,
            client_key: normalise(client), registrant_key: normalise(registrant),
            amount: r.amount || '', issues: r.issues || '',
            subject: cap.subject, url: r.url || '',
          });
        }
      }

      for (const piece of splitParties(raw)) {
        const key = normalise(piece);
        if (tooGeneric(key)) continue;
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

module.exports = {
  readCaptures, index, crossSubject, sharedRegistrants,
  normalise, tooGeneric, splitParties,
};
