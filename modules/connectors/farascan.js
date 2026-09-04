'use strict';
/**
 * FARA SCAN — read the whole register, not the four numbers you happened to
 * think of.
 *
 * `faradocs` answers "who paid THIS firm", and it only works if you already
 * know the registration number. That is the wrong shape for the actual
 * question, which is "which registered foreign agents have ever filed for a
 * surveillance company / a data broker / an ad-tech firm / a power company".
 * Asking that four numbers at a time means the answer is bounded by whose
 * name you already suspected — and an investigation that can only confirm
 * what you already believed is not an investigation.
 *
 * So: walk every active registrant, pull each one's documents, and match the
 * FOREIGN PRINCIPAL names against a pattern. Roughly 500 requests, paced.
 *
 * ── The failure mode this file is built around ────────────────────────────
 *
 * A scan of 536 registrants where 40 requests failed and 496 succeeded will
 * happily report "12 matches" — and that number reads as "12 matches in the
 * register". It is not. It is 12 matches in the 92% of the register that
 * answered. The 40 that failed are not zeroes; they are unknowns, and the
 * difference matters enormously when the output is "no registered foreign
 * agent has ever filed for this company."
 *
 * Every count this module reports therefore carries its own denominator, and
 * failures are listed by registration number so they can be re-run. A scan
 * that cannot say how much of the register it actually read does not get to
 * make a claim about the register.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');
const P = require('../../core/provenance/provenance.js');

const VERSION = '0.1.0';

/** Paced deliberately slowly. This is ~500 requests at a government API that
 *  nobody is paying to run. Being a good citizen is not optional and a scan
 *  that gets the desk blocked has cost more than it found.
 *
 *  700ms was too fast. The first live run got 478 of 536 registrants back as
 *  HTTP 429 and reported them as "did not answer" — technically true and
 *  practically useless, because the tool had caused the silence it was
 *  reporting. A scan that rate-limits itself and then tells you the register
 *  is unknown has manufactured its own null. */
const DEFAULT_INTERVAL_MS = 1500;

/** How many times to retry one registrant after a 429 before giving up on it
 *  for this run. Each wait is longer than the last. */
const MAX_429_RETRIES = 4;

/** Once the service pushes back, it stays pushed back for a while. Slowing
 *  only the retry and then returning to the old cadence walks straight into
 *  the next 429, so a 429 permanently raises the interval FOR THE WHOLE RUN. */
const BACKOFF_GROWTH = 1.6;
const MAX_INTERVAL_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the service says to wait, in ms, or null if it does not say.
 * Retry-After may be seconds or an HTTP date; both are legal.
 */
function retryAfterMs(res) {
  const h = (res && res.headers) || {};
  const v = h['retry-after'] || h['Retry-After'];
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/**
 * Where a registrant's document list is cached on disk.
 *
 * Separate from `evidence/captures/` on purpose. Those are one-off captures
 * an operator asked for by name; these are a bulk sweep, and mixing 500
 * machine-driven files into the folder an operator reads by eye would bury
 * the deliberate captures under the automatic ones.
 */
function cacheDir(evidenceRoot) {
  return path.join(evidenceRoot || R.EVIDENCE, 'captures', 'farascan');
}

function cachePath(regNum, evidenceRoot) {
  return path.join(cacheDir(evidenceRoot), `regdocs_${String(regNum)}.json`);
}

/**
 * Is a cached file recent enough to reuse?
 *
 * A stale cache is a real answer about a moment that has passed. Seven days
 * is a compromise: FARA filings arrive continuously, but re-pulling 500
 * documents to catch a week of drift is not worth the requests.
 */
function isFresh(file, days) {
  if (!fs.existsSync(file)) return false;
  const age = Date.now() - fs.statSync(file).mtimeMs;
  return age < (days || 7) * 86400000;
}

/**
 * The list of active registrants, as {number, name} pairs.
 *
 * Reads whatever `fara`'s capture already put on disk if one is recent, so a
 * re-run does not re-fetch a list that changes a few times a week.
 */
async function activeRegistrants(opts = {}) {
  const evidenceRoot = opts.evidenceRoot || R.EVIDENCE;
  const listFile = path.join(cacheDir(evidenceRoot), 'active_registrants.json');
  fs.mkdirSync(cacheDir(evidenceRoot), { recursive: true });

  let json = null;
  if (!opts.refresh && isFresh(listFile, opts.freshDays)) {
    json = JSON.parse(R.decodeBody(fs.readFileSync(listFile)));
  } else {
    const res = await R.request('GET',
      'https://efile.fara.gov/api/v1/Registrants/json/Active',
      { Accept: 'application/json' });
    if (res.status !== 200) {
      return { ok: false, error: `active-registrant list: ${res.error || `HTTP ${res.status}`}` };
    }
    fs.writeFileSync(listFile, res.body);
    json = JSON.parse(R.decodeBody(res.body));
  }

  const rows = R.findRecordArray(json);
  if (!rows.length) {
    return { ok: false, error: 'the active-registrant list parsed to zero records — '
      + 'that is a parser problem, not an empty register' };
  }
  const out = [];
  for (const r of rows) {
    const k = Object.keys(r);
    const numKey = k.find((n) => /registration.?number|reg.?num/i.test(n));
    const nameKey = k.find((n) => /^name$|registrant.?name/i.test(n));
    if (!numKey) continue;
    out.push({ number: String(r[numKey]).trim(), name: nameKey ? String(r[nameKey]).trim() : '' });
  }
  return { ok: true, registrants: out, total: rows.length };
}

/**
 * Fetch one registrant's documents, or read the cached copy.
 *
 * Returns `{ ok, rows, cached }` — and on failure `{ ok: false, error }`,
 * which the caller MUST carry into the report rather than treating as an
 * empty result. See the header.
 */
async function fetchDocs(regNum, opts = {}) {
  const evidenceRoot = opts.evidenceRoot || R.EVIDENCE;
  const file = cachePath(regNum, evidenceRoot);
  fs.mkdirSync(cacheDir(evidenceRoot), { recursive: true });

  if (!opts.refresh && isFresh(file, opts.freshDays)) {
    try {
      const rows = R.CONNECTORS.faradocs.parse(JSON.parse(R.decodeBody(fs.readFileSync(file))));
      return { ok: true, rows, cached: true };
    } catch (e) {
      // A corrupt cache file is a reason to re-fetch, not to report zero.
      if (opts.onNote) opts.onNote(`cache unreadable for ${regNum}: ${e.message}`);
    }
  }

  const spec = R.CONNECTORS.faradocs.run(regNum);
  const req = opts.request || R.request;
  const state = opts.state || {};

  // A 429 is not a failure, it is "later". Honour Retry-After when the
  // service sends one; otherwise back off geometrically. And carry the
  // slowdown into the rest of the run via `state.intervalMs`, because the
  // throttle does not lift the moment one request succeeds.
  let res = await req(spec.method, spec.url, spec.headers);
  for (let attempt = 0; res.status === 429 && attempt < (opts.maxRetries ?? MAX_429_RETRIES); attempt += 1) {
    const base = opts.intervalMs ?? state.intervalMs ?? DEFAULT_INTERVAL_MS;
    state.intervalMs = Math.min(MAX_INTERVAL_MS, Math.round(base * BACKOFF_GROWTH));
    const told = retryAfterMs(res);
    const wait = told !== null ? told : state.intervalMs * (2 ** attempt);
    if (opts.onNote) {
      opts.onNote(`${regNum}: rate limited, waiting ${Math.round(wait / 1000)}s `
        + `(attempt ${attempt + 1}) and slowing to ${state.intervalMs}ms`);
    }
    await sleep(Math.min(wait, 60000));
    res = await req(spec.method, spec.url, spec.headers);
  }

  if (res.status === 429) {
    return { ok: false, error: 'HTTP 429 after retries — rate limited, not empty', throttled: true };
  }
  if (res.status !== 200) {
    return { ok: false, error: res.error || `HTTP ${res.status}` };
  }
  fs.writeFileSync(file, res.body);

  let rows = [];
  try {
    rows = R.CONNECTORS.faradocs.parse(JSON.parse(R.decodeBody(res.body)));
  } catch (e) {
    return { ok: false, error: `captured but unparsed: ${e.message}` };
  }
  return { ok: true, rows, cached: false, sha256: P.sha256Bytes(res.body), file };
}

/** A row that actually names a principal. The placeholder text the parser
 *  writes when FOREIGN_PRINCIPAL_NAME is blank must never be matched against
 *  a search pattern — a search for "no" would hit every one of them. */
const UNNAMED = /^\(no foreign principal named/i;

function namesPrincipal(row) {
  return !!row && !!row.name && !UNNAMED.test(row.name);
}

/**
 * Match a row against the operator's pattern.
 *
 * The principal name and the country are searched; the REGISTRANT name is
 * deliberately NOT, because every row carries it and a pattern that happens
 * to match the firm would return the firm's entire history as "hits".
 */
function matches(row, re) {
  if (!namesPrincipal(row)) return false;
  return re.test(row.name) || (row.country ? re.test(row.country) : false);
}

/**
 * Roll a registrant's matching rows up into one line per principal.
 */
function summarise(rows, re) {
  const by = new Map();
  for (const r of rows) {
    if (!matches(r, re)) continue;
    const key = `${r.name} ${r.country || ''}`;
    const e = by.get(key) || {
      principal: r.name, country: r.country || '', docs: 0,
      first: r.filed, last: r.filed, types: new Set(), sample: r.url,
    };
    e.docs += 1;
    e.types.add(r.document || '(untyped)');
    if (r.filed && (!e.first || r.filed < e.first)) e.first = r.filed;
    if (r.filed && (!e.last || r.filed > e.last)) e.last = r.filed;
    if (!e.sample && r.url) e.sample = r.url;
    by.set(key, e);
  }
  return [...by.values()]
    .map((e) => Object.assign(e, { types: [...e.types] }))
    .sort((a, b) => b.docs - a.docs);
}

/**
 * Scan the register.
 *
 * `onProgress` is called per registrant so a nine-minute run is not a blank
 * terminal — an operator who cannot see progress cannot tell a slow scan
 * from a hung one, and will kill it.
 */
async function scan(pattern, opts = {}) {
  let re;
  try {
    re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  } catch (e) {
    return { ok: false, error: `--match is not a valid pattern: ${e.message}` };
  }

  const list = await activeRegistrants(opts);
  if (!list.ok) return list;

  let registrants = list.registrants;
  if (opts.limit) registrants = registrants.slice(0, opts.limit);

  const hits = [];
  const failures = [];
  let scanned = 0;
  let fromCache = 0;
  let docsRead = 0;
  let throttled = 0;

  // Shared across the whole run so one 429 slows every request after it.
  const state = { intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS };

  for (const reg of registrants) {
    const got = await fetchDocs(reg.number, Object.assign({}, opts, { state }));
    if (!got.ok) {
      // NOT a zero. An unknown.
      failures.push({ number: reg.number, name: reg.name, error: got.error, throttled: !!got.throttled });
      if (got.throttled) throttled += 1;
      if (opts.onProgress) opts.onProgress({ reg, failed: true, error: got.error, throttled: !!got.throttled });
      if (!got.cached) await sleep(state.intervalMs);
      continue;
    }
    scanned += 1;
    if (got.cached) fromCache += 1;
    docsRead += got.rows.length;

    const found = summarise(got.rows, re);
    if (found.length) hits.push({ registrant: reg.name, number: reg.number, principals: found });
    if (opts.onProgress) opts.onProgress({ reg, hits: found.length, docs: got.rows.length, cached: got.cached });

    if (!got.cached) await sleep(state.intervalMs);
  }

  return {
    ok: true,
    pattern: String(re),
    hits: hits.sort((a, b) => {
      const an = a.principals.reduce((s, p) => s + p.docs, 0);
      const bn = b.principals.reduce((s, p) => s + p.docs, 0);
      return bn - an;
    }),
    // The denominators. Every one of these is load-bearing: a claim about
    // "the register" is only as good as the share of it that answered.
    registrantsInRegister: list.total,
    registrantsAttempted: registrants.length,
    registrantsRead: scanned,
    registrantsFailed: failures.length,
    // Throttled is a DIFFERENT kind of unknown from a broken request: the
    // scan caused it, and re-running clears it. Reporting the two together
    // as "did not answer" hides the fact that the fix is simply to go again.
    registrantsThrottled: throttled,
    finalIntervalMs: state.intervalMs,
    fromCache,
    docsRead,
    failures,
  };
}

/**
 * The sentence an operator may safely repeat about a scan.
 *
 * Built here rather than in the CLI so it cannot drift from the numbers it
 * describes, and so a zero-result scan is stated as a bounded null instead
 * of "nothing found".
 */
function coverageLine(out) {
  const read = out.registrantsRead;
  const attempted = out.registrantsAttempted;
  const total = out.registrantsInRegister;
  const bits = [`read ${read} of ${attempted} registrant(s) attempted`];
  if (attempted < total) bits.push(`out of ${total} active in the register`);
  if (out.registrantsFailed) {
    const t = out.registrantsThrottled || 0;
    bits.push(t === out.registrantsFailed
      ? `${t} were RATE LIMITED — unknown, not zero, and re-running clears them`
      : `${out.registrantsFailed} did NOT answer and are unknown, not zero`
        + (t ? ` (${t} of them rate limited)` : ''));
  }
  return bits.join('; ');
}


/* ══ WHO IS ACTUALLY BEHIND THE PRINCIPAL ═════════════════════════════
 *
 * FARA makes the registrant name the foreign principal. It does not make
 * anyone say whether that principal is the party with the interest or a
 * conduit standing in front of one. But registrants write it down anyway,
 * in the name field, in plain English:
 *
 *   "ZTE Corporation (through Hogan Lovells US LLP)"
 *   "Drift Advisors, SL on behalf of United Republic of Tanzania"
 *   "NSO Group via Pillsbury Winthrop Shaw Pittman LLP"
 *   "BGR Gabara, Ltd. (for Bidzina Ivanishvili)"
 *
 * That layer is where the chain of control actually lives, and nobody
 * parses it because it is prose inside a name column.
 *
 * ── The trap ────────────────────────────────────────────────────────────
 *
 * The grammar INVERTS depending on the connector, and getting it backwards
 * would flip every single row:
 *
 *   "X through Y"        → X is the party,   Y is the conduit
 *   "X on behalf of Y"   → X is the conduit, Y is the party
 *
 * So "ZTE through Hogan Lovells" means ZTE is the client and the law firm
 * is the pass-through, while "Drift Advisors on behalf of Tanzania" means
 * Tanzania is the client and Drift is the pass-through. Same shape, opposite
 * meaning. A parser that treated both as left-to-right would publish a table
 * asserting that Hogan Lovells is a foreign principal of the Chinese state.
 *
 * ── What this is and is not ─────────────────────────────────────────────
 *
 * This is an INTERPRETATION OF WORDING, not a field the form provides. The
 * raw string is therefore carried on every row and printed, so the reading
 * can be checked against what the registrant actually wrote. Where the
 * wording is ambiguous the row is returned with `ambiguous: true` rather
 * than guessed at.
 */

// The connector is often inside a parenthetical — "ZTE Corporation (through
// Hogan Lovells US LLP)" — so the boundary before it may be an opening
// bracket rather than a space. Requiring plain whitespace missed every
// parenthesised layer in the register, which is most of them.
const LAYERS = [
  // party first, conduit second
  { re: /[\s(]+through\s+/i,          label: 'through',      partyFirst: true },
  { re: /[\s(]+via\s+/i,              label: 'via',          partyFirst: true },
  // conduit first, party second
  { re: /[\s(]+on\s+behalf\s+of\s+/i, label: 'on behalf of', partyFirst: false },
  { re: /[\s(]+o\/b\/o\s+/i,          label: 'o/b/o',        partyFirst: false },
  { re: /[\s(]+f\/b\/o\s+/i,          label: 'f/b/o',        partyFirst: false },
];

/** Trim the punctuation that survives a split out of a parenthetical. */
function tidy(s) {
  return String(s || '')
    .replace(/^[\s("'\u201c\u2018\[]+/, '')
    .replace(/[\s()"'\u201d\u2019\].,;]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a principal name into (party with the interest, conduit in front).
 * Returns null when the name names no layer at all — which is most of them.
 */
function splitPrincipal(name) {
  const raw = String(name || '');
  if (!raw) return null;
  for (const L of LAYERS) {
    const m = L.re.exec(raw);
    if (!m) continue;
    const left = tidy(raw.slice(0, m.index));
    const right = tidy(raw.slice(m.index + m[0].length));
    if (!left || !right) continue;
    return {
      raw,
      connector: L.label,
      party: L.partyFirst ? left : right,
      conduit: L.partyFirst ? right : left,
      // More than one connector in one name means the layering is deeper
      // than this two-way split can express. Say so rather than truncate it.
      ambiguous: LAYERS.filter((o) => o.re.test(raw)).length > 1,
    };
  }
  // "(for Someone)" is the same construction without a word this splits on.
  const paren = /\(\s*for\s+([^)]+)\)/i.exec(raw);
  if (paren) {
    const conduit = tidy(raw.slice(0, paren.index));
    const party = tidy(paren[1]);
    if (conduit && party) {
      return { raw, connector: '(for …)', party, conduit, ambiguous: false };
    }
  }
  return null;
}

/**
 * Does the conduit look like the registrant's own affiliate?
 *
 * "Mercury Public Affairs" routing through "Mercury International UK Ltd" is
 * a different fact from routing through an unrelated law firm — it is the
 * firm passing work through itself. Detected by a shared distinctive word,
 * which is a HEURISTIC and is labelled as one: it catches Mercury/Mercury,
 * and it will miss "The Burson Group" routing through "BCW Asia Pacific"
 * because those names share nothing. A miss here is not evidence of
 * independence.
 */
const STOPWORDS = new Set(['the', 'group', 'llc', 'ltd', 'inc', 'llp', 'plc',
  'company', 'co', 'corp', 'corporation', 'international', 'global', 'usa',
  'us', 'associates', 'partners', 'strategies', 'strategy', 'consulting',
  'communications', 'affairs', 'public', 'advisors', 'and', 'of', 'pllc', 'pc']);

function looksSelfAffiliated(registrant, conduit) {
  const words = (s) => String(s || '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const a = new Set(words(registrant));
  return words(conduit).some((w) => a.has(w));
}

/**
 * Read every cached registrant and return the layered principals.
 *
 * Runs entirely off the farascan cache — no network. A full scan must have
 * been run first, and how much of the register that scan covered is the
 * denominator for everything here, so it is counted and returned.
 */
function intermediaries(opts = {}) {
  const dir = cacheDir(opts.evidenceRoot);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: 'no farascan cache — run a scan first so there '
      + 'is a register to read' };
  }
  const files = fs.readdirSync(dir).filter((f) => /^regdocs_\d+\.json$/.test(f));
  if (!files.length) {
    return { ok: false, error: 'the cache holds no registrant documents yet — '
      + 'run `connect farascan --match ...` once to fill it' };
  }

  const found = new Map();
  let registrantsRead = 0;
  let unreadable = 0;
  let principalsSeen = 0;

  for (const f of files) {
    let rows;
    try {
      rows = R.CONNECTORS.faradocs.parse(
        JSON.parse(decodeCache(path.join(dir, f))));
    } catch { unreadable += 1; continue; }
    registrantsRead += 1;

    for (const r of rows) {
      if (!namesPrincipal(r)) continue;
      principalsSeen += 1;
      const split = splitPrincipal(r.name);
      if (!split) continue;
      const key = `${r.registrant}||${split.raw}`;
      const e = found.get(key) || {
        registrant: r.registrant || '(unnamed registrant)',
        regNumber: (f.match(/regdocs_(\d+)/) || [])[1] || '',
        party: split.party,
        conduit: split.conduit,
        connector: split.connector,
        ambiguous: split.ambiguous,
        raw: split.raw,
        country: r.country || '',
        docs: 0,
        first: r.filed,
        last: r.filed,
        sample: r.url,
        selfAffiliated: looksSelfAffiliated(r.registrant, split.conduit),
      };
      e.docs += 1;
      if (r.filed && (!e.first || r.filed < e.first)) e.first = r.filed;
      if (r.filed && (!e.last || r.filed > e.last)) e.last = r.filed;
      if (!e.sample && r.url) e.sample = r.url;
      found.set(key, e);
    }
  }

  const rows = [...found.values()].sort((a, b) => b.docs - a.docs);
  return {
    ok: true,
    rows,
    registrantsRead,
    unreadable,
    principalsSeen,
    layered: rows.length,
    // The share of named principals that carry a layer at all. Without this
    // "37 intermediaries" is a number with no size to compare it against.
    share: principalsSeen ? rows.reduce((n, r) => n + r.docs, 0) / principalsSeen : 0,
  };
}

/** Read a cache file through the same charset handling as a live response. */
function decodeCache(file) {
  return R.decodeBody(fs.readFileSync(file));
}

module.exports = {
  VERSION, DEFAULT_INTERVAL_MS,
  cacheDir, cachePath, isFresh,
  activeRegistrants, fetchDocs, retryAfterMs, MAX_429_RETRIES,
  namesPrincipal, matches, summarise, scan, coverageLine,
  splitPrincipal, looksSelfAffiliated, intermediaries, tidy,
};
