'use strict';
/**
 * modules/connectors/registry.js — the connectors themselves, and the one
 * procedure for running them.
 *
 * Extracted so the interactive CLI and the scheduled watch runner share a
 * single implementation. Two copies of a run procedure is two places for the
 * doctrine to drift, and the doctrine is the point: announce, capture, hash
 * before deriving, record, and treat every hit as a lead.
 *
 * Nothing in this file prints. Callers decide how to present a run.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const P = require('../../core/provenance/provenance.js');

const ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const CAPTURES = path.join(EVIDENCE, 'captures');
const LEDGER = path.join(EVIDENCE, 'manifests', 'provenance.jsonl');
const VERSION = '0.4.0';

// ------------------------------------------------------- full-text search
/**
 * Quote a multi-word query so a full-text search treats it as a PHRASE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY: THE NOISE WAS NOT NOISE, IT WAS A WRONG QUESTION
 *
 * Federal Register and Regulations.gov both do full-text search, and both
 * OR the words of an unquoted query. So "Magnet Forensics" asked for every
 * document containing "magnet" OR "forensics", and a sweep for a police
 * forensics vendor came back with EPA glyphosate spreadsheets and migratory
 * bird rules. "Ohio Peace Officer Training Commission" was worse: five
 * common words, twenty-five confident, irrelevant results.
 *
 * That is not merely untidy. Twenty-five junk rows per subject per connector
 * bury the real hits, and an operator who scrolls past them learns to
 * distrust the whole output — including the rows that matter. A search that
 * always returns something is indistinguishable from one that never works.
 *
 * Quoting makes it the search the operator actually asked for. A phrase that
 * genuinely appears nowhere now returns nothing, which is a real answer.
 */
/**
 * ── And the correction to that, which the register forced ───────────────
 *
 * Quoting EVERYTHING was too blunt. "Entity List additions Xinjiang iFLYTEK
 * Hikvision Dahua" became a demand for that exact string as a phrase, which
 * appears in no document ever written, and the search returned a confident
 * zero over a subject the Federal Register covers extensively. Fixing the
 * OR'd-junk problem created a false-null problem, which is worse: junk is
 * visible and a wrong zero is not.
 *
 * A short query is an entity name and wants to be a phrase. A long one is a
 * list of search terms and wants to be terms. Five words is the line — it
 * keeps "Ohio Peace Officer Training Commission" whole and lets a six-term
 * subject search behave like one — and it is a HEURISTIC, not a rule: a
 * longer proper name will fall the wrong side of it. `--exact` and `--any`
 * are the real answer, and the CHOICE IS ALWAYS REPORTED in the announced
 * request line, because a search that silently changes the question is the
 * whole problem this function exists to solve.
 */
const PHRASE_WORD_LIMIT = 5;

function phrase(q, opts = {}) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return s;
  if (/^".*"$/.test(s)) return s;                  // already quoted
  const words = s.split(/\s+/).length;
  if (words === 1) return s;                       // one word needs no quotes
  if (opts.any) return s;
  if (!opts.exact && words > PHRASE_WORD_LIMIT) return s;
  return `"${s.replace(/"/g, '')}"`;
}

/** How the query was actually sent, for the announced request line. */
function phraseMode(q, opts = {}) {
  const sent = phrase(q, opts);
  const s = String(q == null ? '' : q).trim();
  if (!s || s.split(/\s+/).length === 1) return 'single term';
  return /^".*"$/.test(sent)
    ? 'as an EXACT PHRASE — a document must contain these words together'
    : 'as SEPARATE TERMS — documents matching any of them can come back';
}

/**
 * Find the array of records in a JSON body whose shape you do not know.
 *
 * Government APIs wrap their data differently and inconsistently — a bare
 * array, `{ROW: [...]}`, `{RESULTS: {ROW: [...]}}`. Hard-coding one shape
 * means a body that arrives in another parses to nothing and reports a clean
 * zero, which is indistinguishable from "there is nothing there".
 *
 * So: take the deepest single array of objects and say what was found.
 */
/**
 * Turn the bytes a server actually sent into a string.
 *
 * DOJ's FARA API serves Windows-1252 bytes with no charset declared. Decoded
 * as UTF-8, the Turkish defence ministry came back as "Republic of T\uFFFDrkiye"
 * — a replacement character where the u-umlaut was. That is not cosmetic. A
 * principal's name is the identifier you carry into every other source, and a
 * mangled one silently fails to match the same entity anywhere else.
 *
 * Strict UTF-8 first, because valid UTF-8 is essentially never also a
 * plausible Windows-1252 document, so a successful strict decode is safe.
 * Only when that throws do we fall back — Windows-1252 rather than Latin-1,
 * because it is what Microsoft-stack government systems actually emit and it
 * differs from Latin-1 exactly in the byte range where quotes and dashes live.
 *
 * The CAPTURE ON DISK IS NEVER TOUCHED. It stays the raw bytes the server
 * sent, and the sha256 in the ledger is over those bytes. Decoding happens on
 * the way into the parser only, so provenance still points at what arrived.
 */
const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E',
  0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6',
  0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152',
  0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C',
  0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A',
  0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178',
};

const decodeBody = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let out = '';
    for (const byte of b) {
      out += (byte >= 0x80 && byte <= 0x9F)
        ? (CP1252_HIGH[byte] || '\uFFFD')
        : String.fromCharCode(byte);
    }
    return out;
  }
};

function findRecordArray(json, depth = 0) {
  if (Array.isArray(json)) {
    return json.every((x) => x && typeof x === 'object') ? json : [];
  }
  if (!json || typeof json !== 'object' || depth > 6) return [];
  for (const v of Object.values(json)) {
    const found = findRecordArray(v, depth + 1);
    if (found.length) return found;
  }
  return [];
}

// ---------------------------------------------------------------- env
function loadEnv() {
  // Keys live in a .env the operator controls. Read it, never echo it.
  const env = Object.assign({}, process.env);
  for (const candidate of [path.join(ROOT, '.env'), path.join(ROOT, 'modules', 'pra', '.env')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

/**
 * The key a connector will actually be given at run time.
 *
 * keyVarAlt lets one api.data.gov registration serve every connector in that
 * federation, so the operator is not asked to register twice for a key the
 * government already treats as one key.
 *
 * THIS EXISTS AS A FUNCTION BECAUSE IT WAS WRITTEN TWICE AND DIVERGED.
 *   `connect test` checked env[keyVar] alone while the runner checked
 *   env[keyVar] || env[keyVarAlt]. With only DATA_GOV_API_KEY set, the check
 *   reported FEC as having no key while `connect fec "X"` searched happily --
 *   a diagnostic contradicting the thing it exists to diagnose, in the
 *   direction that makes you go looking for a problem you do not have.
 *   One resolver, used by both, cannot drift.
 */
function resolveKey(c, env) {
  if (!c.keyVar) return '';
  return env[c.keyVar] || (c.keyVarAlt ? env[c.keyVarAlt] : '') || '';
}

/**
 * What a valid key for each provider looks like.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SHAPE-CHECKING EARNS ITS PLACE
 *
 * A real run reported:
 *
 *     FEC_API_KEY       you…0N (63 chars)   → KEY REJECTED (HTTP 403)
 *     DATA_GOV_API_KEY  you…01 (54 chars)   → KEY REJECTED (HTTP 403)
 *
 * An api.data.gov key is exactly 40 alphanumeric characters. Both of those
 * were far too long and both began "you" — surrounding prose had been pasted
 * along with the key, almost certainly from the "Your API key is: …" line of
 * a signup email.
 *
 * Everything needed to say that was already on screen. The length was right
 * there. But the advice said "check for a stray quote or a trailing space",
 * which sends you looking for a one-character mistake in a value that is
 * twenty-three characters too long.
 *
 * These checks run locally and cost nothing. A key that cannot possibly be
 * valid should never require a network round trip and a 403 to discover.
 *
 * NOTE ON WHAT IS NOT DONE HERE: the key is never logged, echoed, or included
 * in any error text. Only its length and whether it matched.
 */
const KEY_SHAPES = {
  DATA_GOV_API_KEY: {
    test: (k) => /^[A-Za-z0-9]{40}$/.test(k),
    describe: 'exactly 40 letters and digits',
    where: 'https://api.data.gov/signup',
  },
  FEC_API_KEY: {
    // FEC issues api.data.gov keys; DEMO_KEY is the documented trial value.
    test: (k) => /^[A-Za-z0-9]{40}$/.test(k) || k === 'DEMO_KEY',
    describe: 'exactly 40 letters and digits (it is an api.data.gov key)',
    where: 'https://api.data.gov/signup',
  },
  OPENSANCTIONS_API_KEY: {
    test: (k) => /^[A-Za-z0-9]{24,64}$/.test(k),
    describe: '24-64 letters and digits',
    where: 'https://www.opensanctions.org/account/',
  },
  COURTLISTENER_API_TOKEN: {
    test: (k) => /^[A-Za-z0-9]{20,64}$/.test(k),
    describe: '20-64 letters and digits',
    where: 'https://www.courtlistener.com/profile/api/',
  },
  OPENCORPORATES_API_KEY: {
    test: (k) => /^[A-Za-z0-9_]{20,64}$/.test(k),
    describe: '20-64 letters, digits, or underscores',
    where: 'https://opencorporates.com/api_accounts/new',
  },
  BLS_API_KEY: {
    test: (k) => /^[a-f0-9]{32}$/i.test(k),
    describe: '32 hex characters',
    where: 'https://data.bls.gov/registrationEngine/',
  },
};

/**
 * Check a key's shape without ever revealing it.
 * Returns null when it looks fine, or a problem description when it does not.
 */
function checkKeyShape(keyVar, key) {
  if (!key) return null;
  const shape = KEY_SHAPES[keyVar];
  if (!shape) return null;
  if (shape.test(key)) return null;

  // Say WHICH way it is wrong. "Malformed" sends you back to stare at it.
  const hints = [];
  if (/\s/.test(key)) hints.push('it contains a space or a line break');
  if (/^["'`]|["'`]$/.test(key)) hints.push('it starts or ends with a quote mark');
  if (/=/.test(key)) hints.push('it contains an "=", so the variable name may have been pasted twice');
  if (/^(your|paste|enter|api[_ -]?key|key)\b/i.test(key)) {
    hints.push('it begins with placeholder or label text — check for a '
      + '"Your API key is:" prefix pasted along with the key');
  }
  if (/[:<>]/.test(key)) hints.push('it contains ":" or "<" or ">"');

  return {
    length: key.length,
    expected: shape.describe,
    where: shape.where,
    hints,
  };
}

function mask(k) {
  return k ? `${k.slice(0, 3)}…${k.slice(-2)} (${k.length} chars)` : null;
}

// ---------------------------------------------------------------- transport
/**
 * Exactly one HTTPS request. Returns the raw body so it can be hashed before
 * anything reads it. No retries: a run makes the calls it announced.
 */
/**
 * Headers that authenticate us. These are dropped when a redirect crosses to a
 * different host — forwarding a key to whatever a 301 points at is how an API
 * key ends up somewhere you did not choose to send it.
 */
const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-auth-token', 'cookie'];
const MAX_REDIRECTS = 3;

function stripAuth(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!AUTH_HEADERS.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Per-connector pacing.
 *
 * CourtListener allows 5 requests a minute and says so in a 429. A sweep
 * fires one call per connector per subject with no gap, so on a twelve-subject
 * sweep CourtListener refused most of them -- and litigation is one of the
 * better sources for who is fighting whom over siting and power. The run
 * reported the failures rather than hiding them, which is why it was
 * noticeable, but reporting a loss is not the same as not losing it.
 *
 * So a connector may declare the minimum gap between its own calls, and the
 * runner waits. The clock is per connector: pacing CourtListener must not
 * slow down the eight other sources it has nothing to do with.
 */
const LAST_CALL = new Map();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pace(name, c) {
  const min = c.minIntervalMs || 0;
  if (!min) return 0;
  const last = LAST_CALL.get(name) || 0;
  const wait = last + min - Date.now();
  if (wait > 0) await sleep(wait);
  LAST_CALL.set(name, Date.now());
  return wait > 0 ? wait : 0;
}

/**
 * How long a 429 says to wait, in ms, or null if it does not say.
 *
 * Retry-After is the standard and is checked first. CourtListener does not
 * send it -- it puts "Expected available in 5 seconds." in the body, so that
 * is read too rather than falling back to a guess. A guessed backoff is
 * either too short to work or long enough to look like a hang.
 */
function retryAfterMs(res) {
  const h = res.headers && (res.headers['retry-after'] || res.headers['Retry-After']);
  if (h && /^\d+$/.test(String(h).trim())) return Number(String(h).trim()) * 1000;
  const body = res.body ? res.body.toString('utf8').slice(0, 500) : '';
  const m = /available in (\d+) second/i.exec(body);
  if (m) return (Number(m[1]) + 1) * 1000;
  return null;
}

/**
 * SEC asks every automated client to identify itself with a real contact
 * address. A request without one comes back 403 with an HTML body, which any
 * parser reads as "no results" -- a confident zero about a company that files
 * every year. So the address is explicit, and its absence is visible.
 */
function SEC_UA() {
  const who = process.env.SEC_CONTACT || process.env.SEC_USER_AGENT || '';
  return who
    ? `sentinel-connectors/${VERSION} (${who})`
    : `sentinel-connectors/${VERSION} (SEC_CONTACT not set - see docs/OPERATOR_MANUAL.md)`;
}

/**
 * Summarise an LDA filing's declared foreign entities.
 *
 * The array's INNER shape is not confirmed against live data: every filing in
 * the sample on disk declared none, which is itself the common case. So this
 * picks fields by key pattern rather than by name -- the same defence that was
 * added to `faradocs` after it reported FOREIGN_PRINCIPAL_COUNTRY as the
 * principal because Object.keys() happened to return it first -- and falls
 * back to naming the keys it actually saw, so a mismatch is visible in the
 * output instead of printing an empty string that reads as "no foreign entity".
 */
function foreignEntitySummary(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((e) => {
    if (typeof e === 'string') return e;
    if (!e || typeof e !== 'object') return String(e);
    const keys = Object.keys(e);
    const pick = (re) => {
      const k = keys.find((n) => re.test(n));
      return k && e[k] !== null && e[k] !== undefined && e[k] !== '' ? String(e[k]) : '';
    };
    const name = pick(/^name$|entity.?name/i);
    const country = pick(/country.?display/i) || pick(/country/i);
    const pct = pick(/ownership|percent/i);
    const parts = [name, country ? `[${country}]` : '', pct ? `${pct}%` : ''].filter(Boolean);
    // Nothing recognised: say what the record DID call its fields rather than
    // returning a blank that is indistinguishable from "none declared".
    return parts.length ? parts.join(' ') : `(unrecognised shape: ${keys.join(', ')})`;
  }).join('; ');
}

function requestOnce(method, url, headers, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, error: 'bad url' }); }
    if (u.protocol !== 'https:') {
      return resolve({ status: 0, error: `refusing non-https url (${u.protocol})` });
    }
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({
        'User-Agent': `sentinel-connectors/${VERSION} (public-records research desk)`,
        Accept: 'application/json',
      }, headers || {}),
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location || null,
        // Kept because a 429 answer may carry Retry-After, and guessing a
        // backoff is either too short to work or long enough to look like
        // a hang.
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timed out' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Follow redirects, because an API that has moved should not read as a
 * connector that is broken.
 *
 * Senate LDA answered a probe with HTTP 301 and `connect test` reported the
 * bare number in neutral yellow. A moved endpoint and a genuinely failing one
 * looked the same, and neither looked like something to fix.
 *
 * Two rules while following:
 *   - https only, so a redirect cannot downgrade the transport
 *   - authenticating headers are dropped the moment the host changes
 * The second is the one that matters: an Authorization header forwarded to
 * whatever a 301 names hands a key to a host we never chose to trust.
 */
async function request(method, url, headers, body) {
  let current = url;
  let hdrs = headers || {};
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(method, current, hdrs, body);
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && res.location;
    if (!isRedirect) {
      if (chain.length) res.redirected_from = chain;
      return res;
    }

    let next;
    try { next = new URL(res.location, current).toString(); }
    catch { return Object.assign(res, { error: `bad redirect target: ${res.location}` }); }

    if (new URL(next).hostname !== new URL(current).hostname) {
      hdrs = stripAuth(hdrs);
    }
    // 303, and 301/302 in practice, become GET on the way through.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET')) {
      method = 'GET';
      body = undefined;
    }
    chain.push({ from: current, status: res.status, to: next });
    current = next;
  }

  return {
    status: 0,
    error: `more than ${MAX_REDIRECTS} redirects starting at ${url}`,
    redirected_from: chain,
  };
}

/**
 * Turn a non-2xx into the reason the API actually gave.
 *
 * A live run reported `regulationsgov… failed: HTTP 403`. Three unrelated
 * things produce that status here and the operator cannot tell them apart:
 *
 *   - the key is wrong
 *   - the key is fine and the hourly quota is spent (api.data.gov answers
 *     OVER_RATE_LIMIT with 403, not 429 — a documented quirk that makes a
 *     temporary condition look like a permanent one)
 *   - something between you and the host refused the request
 *
 * The body says which. Throwing it away and printing the bare number turns a
 * "wait an hour" into "my key is broken", which is how someone re-registers a
 * key that was never the problem.
 *
 * The response body is untrusted remote text: it is trimmed hard, stripped of
 * control characters, and never interpreted — only shown.
 */
function explainHttpError(res) {
  const base = `HTTP ${res.status}`;
  const raw = res.body ? res.body.toString('utf8').slice(0, 2000) : '';
  if (!raw) return base;

  let detail = '';
  try {
    const j = JSON.parse(raw);
    detail = j.error?.message || j.error?.code || j.message
          || (Array.isArray(j.errors) && (j.errors[0]?.detail || j.errors[0]?.title))
          || j.detail || '';
  } catch {
    // Not JSON. Take the first line that carries words rather than markup —
    // an HTML error page's first line is "<html>", which tells nobody anything.
    detail = raw.split('\n')
      .map((l) => l.replace(/<[^>]*>/g, ' ').trim())
      .find((l) => l.length > 3) || '';
  }

  detail = String(detail).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
  if (!detail) return base;

  // The distinction worth calling out by name.
  if (/OVER_RATE_LIMIT|rate limit|quota/i.test(detail)) {
    return `${base} — rate limited, not a bad key. ${detail}`;
  }
  if (/API_KEY_INVALID|API_KEY_MISSING|invalid[ _]api[ _]?key|api[ _]?key.*(invalid|missing|not valid)/i.test(detail)) {
    return `${base} — the key was refused. ${detail}`;
  }
  return `${base} — ${detail}`;
}

/**
 * Flag a hit whose name only matches as a SUBSTRING of a longer word.
 *
 * A live search for "Cologix" returned, from USAspending:
 *
 *     ECOLOGIX ENVIRONMENTAL SYSTEMS LLC   $933,200   Department of Defense
 *
 * That is not Cologix. USAspending matches recipient text as a substring, so
 * "cologix" is inside "ecologix", and a data-center library quietly acquires a
 * wastewater-treatment contractor. The same trap catches "Meta" inside
 * "Metabolic", "AWS" inside "LAWSON", "Vantage" inside "Advantage".
 *
 * These are NOT dropped. A connector that silently discards results is worse
 * than one that returns noise, because you cannot audit what you never saw,
 * and the occasional real hit does live inside a longer legal name. They are
 * marked, so the eye can skip them and a later reader can see the judgement
 * that was made.
 *
 * The test is deliberately narrow: the query appears in the name, but not at a
 * word boundary. "COLOGIX, INC." keeps a clean match; "ECOLOGIX" does not.
 */
function looksLikeSubstringMatch(query, name) {
  if (!query || !name) return false;
  const q = String(query).toLowerCase().trim();
  const n = String(name).toLowerCase();
  // Minimum 2, not 4. The first version skipped queries under four characters
  // on the theory that short queries match everything — which is exactly
  // backwards. A live search for "AWS" returned twenty-five DAWSON companies,
  // $248m of Department of Agriculture money among them, and flagged none of
  // them, because "aws" is three characters. The shorter the query, the more
  // substring noise it draws and the more the flag is needed.
  if (q.length < 2) return false;
  if (!n.includes(q)) return false;        // no match at all is not this problem

  // A word-boundary occurrence anywhere means it is a real name match.
  const bounded = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  return !bounded.test(n);
}

// ---------------------------------------------------------------- registry
/**
 * Each connector declares what it will do BEFORE it does it, so the announce
 * step prints the truth rather than a summary someone wrote by hand.
 *
 * `identify(result)` returns the stable external id used to tell a genuinely
 * new hit from one already seen on a previous run. Getting this wrong makes a
 * watchlist either silent or a firehose, so it is a required field.
 */
const CONNECTORS = {
  opensanctions: {
    label: 'OpenSanctions',
    keyVar: 'OPENSANCTIONS_API_KEY',
    keyRequired: true,
    calls: 1,
    /**
     * ── THE WORST BUG IN THIS FILE, AND IT WAS SILENT ────────────────────
     *
     * This asked OpenSanctions to match every subject as `schema: 'Person'`.
     * A company is not a Person in the FollowTheMoney model, so every
     * organisation ever searched here came back with zero results — Internet
     * Research Agency, Social Design Agency, Structura National Technology,
     * all of them — while "Yevgeny Prigozhin" scored 1.0 and looked like
     * proof the connector worked.
     *
     * And the zero printed as "A clean result is not proof of absence — it is
     * one source saying nothing", which reads as a considered null. It was
     * not. The question was malformed: the desk had been asking a sanctions
     * database whether a company was a person, and reporting "no" as though
     * it meant "not sanctioned".
     *
     * Two queries now go in the same single POST — one Person, one
     * Organization — and the results are merged. It is still one call, as
     * announced, and an organisation can finally be found.
     */
    describe: (q) => 'POST https://api.opensanctions.org/match/default?algorithm=logic-v2'
      + `  (subject: ${q} — matched as BOTH a person and an organisation)`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.opensanctions.org/search/default?q=test&limit=1',
      headers: key ? { Authorization: `ApiKey ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'POST',
      url: 'https://api.opensanctions.org/match/default?algorithm=logic-v2',
      headers: { Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: {
          person: { schema: 'Person', properties: { name: [q] } },
          org: { schema: 'Organization', properties: { name: [q] } },
        },
      }),
    }),
    parse: (json) => {
      const bag = (json && json.responses) || {};
      const rows = [];
      const seen = new Set();
      for (const key of Object.keys(bag)) {
        for (const r of (bag[key] && bag[key].results) || []) {
          if (!r || seen.has(r.id)) continue;      // the same entity can match
          seen.add(r.id);                          // both queries; count once
          rows.push({
            external_id: r.id,
            name: r.caption,
            schema: r.schema,
            topics: (r.properties && r.properties.topics) || [],
            score: r.score,
            matched_as: key,
            url: `https://www.opensanctions.org/entities/${r.id}/`,
          });
        }
      }
      return rows.sort((a, b) => (b.score || 0) - (a.score || 0));
    },
    identify: (r) => r.external_id,
    /**
     * A zero here still has two very different causes, and the operator must
     * be able to tell them apart: the entity really is not in the database,
     * or the /match endpoint scored every candidate below its threshold.
     * /match is entity RESOLUTION, not search — it is deliberately strict,
     * and a near-miss on a name is dropped rather than shown.
     */
    diagnose: (json) => {
      const bag = (json && json.responses) || {};
      const keys = Object.keys(bag);
      if (!keys.length) {
        return 'The response carried no query results at all — that is a '
          + 'malformed request, not an empty database.';
      }
      const total = keys.reduce((n, k) => n + ((bag[k] && bag[k].total
        && bag[k].total.value) || 0), 0);
      return `Matched as ${keys.join(' and ')}; ${total} candidate(s) considered, `
        + 'none above the matching threshold. This endpoint is entity '
        + 'RESOLUTION, not full-text search: a near-miss on spelling is '
        + 'dropped rather than shown. Try the exact registered name, or the '
        + 'name in the original language, before concluding the entity is '
        + 'not sanctioned.';
    },
  },

  courtlistener: {
    label: 'CourtListener',
    keyVar: 'COURTLISTENER_API_TOKEN',
    // Documented as 5/min, and enforced: a sweep without this lost the source
    // on most subjects. 13s leaves headroom for clock drift.
    minIntervalMs: 13000,
    keyRequired: false, // anonymous search works; the token raises rate limits
    calls: 1,
    /**
     * Two failures the live desk hit on one search.
     *
     * 1. "Internet Research Agency" was sent unquoted and OR'd, returning
     *    Hachette v. Internet Archive and FCC v. Consumers' Research. The
     *    phrase fix had been applied to the Federal Register and
     *    Regulations.gov and never here.
     *
     * 2. type=o searches OPINIONS. An indictment, a criminal complaint and a
     *    seizure affidavit are none of those — they are filings on a docket,
     *    which live in the RECAP archive under type=r. Searching opinions for
     *    a charging document returns zero forever, and the zero looks like an
     *    answer. `--dockets` asks the right index.
     */
    describe: (q, o = {}) => 'GET https://www.courtlistener.com/api/rest/v4/search/'
      + `  (q: ${q} — ${o.dockets ? 'RECAP DOCKETS (filings, indictments, affidavits)'
        : 'OPINIONS ONLY — charging documents are not opinions; use --dockets'}`
      + `, sent ${phraseMode(q, o)})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/search/?q=test&type=o',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    run: (q, key, o = {}) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/search/'
        + `?q=${encodeURIComponent(phrase(q, o))}`
        + `&type=${o.dockets ? 'r' : 'o'}&order_by=score%20desc`,
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: String(r.id || r.cluster_id || r.docket_id || ''),
      name: r.caseName || r.case_name || '(untitled)',
      court: r.court || r.court_id || '',
      date: r.dateFiled || r.date_filed || '',
      docket: r.docketNumber || r.docket_number || '',
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}`
        : (r.docket_id ? `https://www.courtlistener.com/docket/${r.docket_id}/` : ''),
    })),
    identify: (r) => r.external_id,
  },

  federalregister: {
    label: 'Federal Register',
    // The `name` this returns is a DOCUMENT TITLE, not a party. crosslink
    // excludes it from the entity index: a rulemaking notice turning up under
    // four subjects means the full-text search matched it four times, which is
    // a search artifact, not a connection between those subjects.
    entityNames: false,
    keyVar: null,          // no key required — documented divergence
    keyRequired: false,
    calls: 1,
    describe: (q, o = {}) => 'GET https://www.federalregister.gov/api/v1/documents.json'
      + `  (term: ${q} — sent ${phraseMode(q, o)})`,
    probe: () => ({
      method: 'GET',
      url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=1',
      headers: {},
    }),
    run: (q, key, o = {}) => ({
      method: 'GET',
      url: 'https://www.federalregister.gov/api/v1/documents.json'
         + `?per_page=25&order=newest&conditions%5Bterm%5D=${encodeURIComponent(phrase(q, o))}`,
      headers: {},
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.document_number,
      name: r.title,
      agencies: (r.agencies || []).map((a) => a.name).join(', '),
      date: r.publication_date,
      type: r.type,
      url: r.html_url,
    })),
    identify: (r) => r.external_id,
  },

  // ======================================================================
  // THE MONEY LANE
  //
  // Politics is a money question before it is anything else, and the money
  // is filed. These three cover the federal layer end to end:
  //
  //   fec          who gave, to whom, how much          (campaign finance)
  //   senatelda    who is paid to lobby, by whom, on what   (lobbying)
  //   usaspending  who received federal money, for what     (contracts/grants)
  //
  // The Ohio layer has no equivalent API. Ohio SOS campaign finance and the
  // county boards of elections are web-only, and the county BOEs are where
  // LOCAL candidate filings live — those never reach the state system, so a
  // county commissioner's donors are invisible to every API here. That gap is
  // filled by a records request, not a connector. See docs/RESEARCH_PLAN.md.
  // ======================================================================

  fec: {
    label: 'FEC (campaign finance)',
    keyVar: 'FEC_API_KEY',
    keyVarAlt: 'DATA_GOV_API_KEY',   // same federation — one key serves both
    keyRequired: true,   // free from api.data.gov; DEMO_KEY works for a trial
    calls: 1,
    describe: (q) => `GET https://api.open.fec.gov/v1/candidates/search/  (q: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: `https://api.open.fec.gov/v1/candidates/search/?api_key=${encodeURIComponent(key || 'DEMO_KEY')}&per_page=1`,
      headers: {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: 'https://api.open.fec.gov/v1/candidates/search/'
         + `?api_key=${encodeURIComponent(key)}`
         + `&q=${encodeURIComponent(q)}&sort=-first_file_date&per_page=25`,
      headers: {},
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.candidate_id,
      name: r.name,
      party: r.party_full || r.party || '',
      office: r.office_full || r.office || '',
      state: r.state || '',
      district: r.district || '',
      cycles: Array.isArray(r.election_years) ? r.election_years.slice(-3).join(', ') : '',
      url: r.candidate_id ? `https://www.fec.gov/data/candidate/${r.candidate_id}/` : '',
    })),
    identify: (r) => r.external_id,
  },

  senatelda: {
    // PACED, because this is the connector that gets asked for 294 pages.
    //
    // `--registrant --pages N` walks a firm's entire filing history: Alpine
    // Group Partners alone reports 7,346 filings, which is 294 sequential
    // requests. Unpaced, those go out as fast as the socket allows, and the
    // documented authenticated ceiling is a per-minute one. A revoked key
    // costs far more than the four minutes this spends.
    //
    // 650ms is roughly 92 requests/minute -- comfortably under a 120/min
    // ceiling with room for the server being slow.
    minIntervalMs: 650,
    label: 'Senate LDA (lobbying)',
    keyVar: 'LDA_API_KEY',
    keyRequired: false,  // anonymous works; a free key raises the rate limit
    calls: 1,
    describe: (q) => `GET https://lda.gov/api/v1/filings/  (client/registrant: ${q})`,
    probe: (key) => ({
      method: 'GET',
      // lda.senate.gov 301s to lda.gov. Following it works (see request()),
      // but paying a redirect on every call to reach a known destination is
      // waste; the hop was observed in a real run on 2026-08-25.
      url: 'https://lda.gov/api/v1/filings/?page_size=1',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    // TWO WAYS TO SEARCH, AND THEY ANSWER DIFFERENT QUESTIONS.
    //
    //   client_name      "who lobbied FOR this company"
    //   registrant_name  "who does this firm lobby for"
    //
    // Only the first existed for a long time, and it silently bounded every
    // answer: a registrant's other clients were visible ONLY where those
    // clients had also been searched. On a real library that showed
    // HARBINGER STRATEGIES with 2 clients and 4 filings; registrant_name
    // returns 2,450 filings for the same firm. The 2 was never a fact about
    // Harbinger, it was a measurement of the search.
    //
    // Verified against the live API on 2026-08-26: registrant_name filters
    // (count 2450, every result HARBINGER STRATEGIES, LLC) and page_size is
    // honoured.
    run: (q, key, o = {}) => {
      const field = o.mode === 'registrant' ? 'registrant_name' : 'client_name';
      const page = o.page && o.page > 1 ? `&page=${o.page}` : '';
      return {
        method: 'GET',
        url: `https://lda.gov/api/v1/filings/?${field}=${encodeURIComponent(q)}`
           + `&page_size=25&ordering=-dt_posted${page}`,
        headers: key ? { Authorization: `Token ${key}` } : {},
      };
    },
    parse: (json) => (json.results || []).map((r) => {
      const client = r.client || {};
      return {
        external_id: r.filing_uuid || r.filing_document_url || '',
        name: `${client.name || '(client?)'} — ${(r.registrant && r.registrant.name) || '(registrant?)'}`,
        period: `${r.filing_year || ''} ${r.filing_period_display || r.filing_period || ''}`.trim(),
        amount: r.income || r.expenses || '',
        issues: (r.lobbying_activities || []).map((a) => a.general_issue_code_display).filter(Boolean).join('; '),
        // ── THE FOREIGN-CONNECTION FIELDS, WHICH WERE BEING THROWN AWAY ────
        //
        // Why they matter: 22 U.S.C. 613(h) exempts an agent from FARA
        // registration when the agent has registered under the LDA for a
        // foreign principal that is not a foreign government or political
        // party. So a foreign CORPORATION lobbying commercially appears in the
        // LDA and not in FARA -- lawfully, by design.
        //
        // A full sweep of the active FARA register (536/536 registrants,
        // 58,287 documents) found exactly one of eight foreign-linked names
        // taken off a single firm's LDA client list. Reading FARA to learn
        // which foreign interests lobby Washington misses the commercial
        // majority, and the LDA carries the disclosure instead -- in these
        // fields, which this parser was discarding.
        //
        // ppb_country is the PRINCIPAL PLACE OF BUSINESS and is the more
        // useful of the two: a Delaware subsidiary of a foreign parent has
        // country US and ppb_country abroad, and only the second says so.
        foreign_entities: foreignEntitySummary(r.foreign_entities),
        foreign_count: Array.isArray(r.foreign_entities) ? r.foreign_entities.length : 0,
        client_country: client.country_display || client.country || '',
        client_ppb_country: client.ppb_country_display || client.ppb_country || '',
        // A government client is the case FARA would have covered. Printed
        // only when true, because "government_client: no" on every domestic
        // row is noise that hides the rows where it is yes.
        government_client: client.client_government_entity ? 'yes' : '',
        affiliated: Array.isArray(r.affiliated_organizations) && r.affiliated_organizations.length
          ? String(r.affiliated_organizations.length) : '',
        url: r.filing_document_url || '',
      };
    }),
    identify: (r) => r.external_id,
  },

  // ======================================================================
  // THE PUBLIC-DATA LANE
  //
  // Two keys the operator holds as of 2026-08-24:
  //
  //   regulationsgov  federal rulemaking dockets + public comments
  //   bls             Bureau of Labor Statistics time series
  //
  // NOTE ON THE api.data.gov KEY: one key works across api.data.gov's
  // whole federation — regulations.gov, the FEC, and others. If you set
  // DATA_GOV_API_KEY, the fec connector above will accept it too, so you
  // do not need two separate registrations for those. BLS is NOT part of
  // that federation; it issues its own registration key separately.
  // ======================================================================

  regulationsgov: {
    label: 'Regulations.gov (federal rulemaking)',
    // The `name` this returns is a DOCUMENT TITLE, not a party. crosslink
    // excludes it from the entity index: a rulemaking notice turning up under
    // four subjects means the full-text search matched it four times, which is
    // a search artifact, not a connection between those subjects.
    entityNames: false,
    keyVar: 'DATA_GOV_API_KEY',
    keyRequired: true,   // free at api.data.gov/signup; DEMO_KEY works for a trial
    calls: 1,
    describe: (q, o = {}) => 'GET https://api.regulations.gov/v4/documents'
      + `  (searchTerm: ${q} — sent ${phraseMode(q, o)})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents?page[size]=5',
      headers: { 'X-Api-Key': key || 'DEMO_KEY' },
    }),
    run: (q, key, o = {}) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents'
         + `?filter[searchTerm]=${encodeURIComponent(phrase(q, o))}`
         + '&sort=-postedDate&page[size]=25',
      headers: { 'X-Api-Key': key },
    }),
    parse: (json) => (json.data || []).map((r) => {
      const a = r.attributes || {};
      return {
        external_id: r.id,
        name: a.title || '(untitled)',
        agency: a.agencyId || '',
        doc_type: a.documentType || '',
        date: a.postedDate || '',
        docket: a.docketId || '',
        comment_end: a.commentEndDate || '',
        url: r.id ? `https://www.regulations.gov/document/${r.id}` : '',
      };
    }),
    identify: (r) => r.external_id,
  },

  bls: {
    label: 'BLS (labor statistics)',
    // This API takes SERIES IDS, not names. "Cologix" is not a series id, and
    // a fan-out across every connector would otherwise spend a call asking a
    // statistics API about a company. `connect all` reads this flag and skips
    // it with a reason rather than making the call and reporting nothing.
    freeText: false,
    keyVar: 'BLS_API_KEY',
    keyRequired: false,  // v2 works unregistered at a low daily cap; a key raises it
    calls: 1,
    // The "query" for this connector is a BLS SERIES ID, not free text —
    // there is no keyword search in the public API. Franklin County
    // unemployment, for example, is LAUCN390490000000003. Passing a
    // phrase here returns an empty series, not an error, so the describe
    // line says so rather than letting a silent empty result look like
    // "no data exists."
    describe: (q) => `POST https://api.bls.gov/publicAPI/v2/timeseries/data/  (series id: ${q}`
                   + ` — this API takes SERIES IDS, not keywords)`,
    probe: () => ({
      method: 'GET',
      url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/LAUCN390490000000003',
      headers: {},
    }),
    run: (q, key) => {
      const year = new Date().getUTCFullYear();
      const body = { seriesid: [q], startyear: String(year - 5), endyear: String(year) };
      if (key) body.registrationkey = key;
      return {
        method: 'POST',
        url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    },
    parse: (json) => {
      const series = (json.Results && json.Results.series) || [];
      const out = [];
      for (const s of series) {
        for (const d of (s.data || [])) {
          out.push({
            // One observation per row, so the seen-set diffs per data point:
            // a revised prior month is genuinely new information.
            external_id: `${s.seriesID}:${d.year}-${d.period}`,
            name: `${s.seriesID} ${d.periodName} ${d.year}`,
            series_id: s.seriesID,
            period: `${d.year}-${d.period}`,
            value: d.value,
            footnotes: (d.footnotes || []).map((f) => f && f.text).filter(Boolean).join('; '),
            url: `https://data.bls.gov/timeseries/${s.seriesID}`,
          });
        }
      }
      return out;
    },
    identify: (r) => r.external_id,
  },

  opencorporates: {
    label: 'OpenCorporates (company registry)',
    keyVar: 'OPENCORPORATES_API_KEY',
    keyRequired: true,   // the open endpoints are heavily throttled without one
    calls: 1,
    describe: (q) => `GET https://api.opencorporates.com/v0.4/companies/search  (company: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.opencorporates.com/v0.4/companies/search?q=test&per_page=1'
         + (key ? `&api_token=${encodeURIComponent(key)}` : ''),
      headers: {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: 'https://api.opencorporates.com/v0.4/companies/search'
         + `?q=${encodeURIComponent(q)}&per_page=25&order=score`
         + (key ? `&api_token=${encodeURIComponent(key)}` : ''),
      headers: {},
    }),
    /**
     * A company registry entry is a REGISTRATION, not a finding. It says a
     * name was filed with a registrar on a date. It does not say the company
     * did anything, and — the trap here — two companies in different
     * jurisdictions can carry the same name and be unrelated. So the
     * jurisdiction and the company number travel with every row: they are what
     * make same-entity a question you can actually answer later.
     */
    parse: (json) => {
      const rows = (json.results && json.results.companies) || [];
      return rows.map(({ company: c }) => ({
        external_id: `${c.jurisdiction_code}/${c.company_number}`,
        name: c.name,
        company_number: c.company_number,
        jurisdiction: c.jurisdiction_code,
        status: c.current_status || '',
        type: c.company_type || '',
        incorporated: c.incorporation_date || '',
        dissolved: c.dissolution_date || '',
        address: (c.registered_address_in_full || '').slice(0, 160),
        url: c.opencorporates_url || '',
      }));
    },
    // jurisdiction + number, never the name. Names collide across registries
    // and change on re-registration; the pair is the registrar's own identity
    // for the filing and is what a later reader can check.
    identify: (r) => r.external_id,
  },

  usaspending: {
    label: 'USAspending (federal awards)',
    keyVar: null,        // no key at all
    keyRequired: false,
    calls: 1,
    describe: (q) => 'POST https://api.usaspending.gov/api/v2/search/spending_by_award/'
      + `  (recipient: ${q} — PROCUREMENT CONTRACTS ONLY)`,
    probe: () => ({
      method: 'GET',
      url: 'https://api.usaspending.gov/api/v2/references/toptier_agencies/',
      headers: {},
    }),
    run: (q) => ({
      method: 'POST',
      url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [q],
          // Codes A-D are procurement contracts and NOTHING else. A grant, a
          // cooperative agreement and a loan are different award groups with
          // different codes, and this filter has never seen any of them.
          //
          // That matters more than it sounds. The connector is labelled "who
          // received federal money", the operator reads a null as "no federal
          // money", and for a developer, a university or a non-profit the
          // money is almost never a procurement contract. Searching contracts
          // for a renewables developer and reporting nothing is a library
          // artifact, not a finding -- the same shape as reading "4 of 4
          // clients, 100%" off a 25-row slice of a 20,001-filing library.
          //
          // The API validates `fields` against the award GROUP, so contracts
          // and assistance cannot be asked for in one request. Grants get
          // their own connector below; see the gap noted there.
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
                 'Start Date', 'End Date', 'Description'],
        sort: 'Award Amount',
        order: 'desc',
        limit: 25,
        page: 1,
      }),
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.generated_internal_id || r['Award ID'] || '',
      name: r['Recipient Name'] || '(unnamed recipient)',
      award_id: r['Award ID'] || '',
      amount: r['Award Amount'] != null ? `$${Number(r['Award Amount']).toLocaleString()}` : '',
      agency: r['Awarding Agency'] || '',
      period: [r['Start Date'], r['End Date']].filter(Boolean).join(' → '),
      description: (r.Description || '').slice(0, 140),
      url: r.generated_internal_id ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : '',
    })),
    identify: (r) => r.external_id,
  },
  /**
   * The other half of "who received federal money".
   *
   * A separate connector rather than a flag on the one above, for one
   * reason: a flag is a thing you have to remember. This appears in
   * `connect test`, in `connect all`, and in every sweep, so the question
   * gets asked whether or not anyone remembered to ask it.
   *
   * NAMED `federalgrants`, not `usaspending_grants`, and the reason is not
   * taste. Captures are filed as `live_capture_<connector>_<slug>_<stamp>`,
   * and the connector is read back off the FRONT of that name -- so a
   * connector whose name starts with another connector's name silently
   * re-files its captures under the shorter one. test_recency.js asserts no
   * two connector names collide that way, and it caught this on the first
   * run under the original name.
   *
   * KNOWN GAP, stated here rather than discovered later: this covers grants
   * and cooperative agreements (02-05). DIRECT LOANS AND LOAN GUARANTEES
   * (07, 08) ARE NOT COVERED -- they are a different award group again, and
   * a DOE Loan Programs Office loan is exactly the kind of thing that would
   * hide in that gap. A null from this connector does not rule out a federal
   * loan. Check the LPO's own portfolio page for that.
   */
  /**
   * FARA — who is paid by a foreign principal to influence Americans.
   *
   * ─────────────────────────────────────────────────────────────────────
   * WHY THIS SOURCE AND NOT A THEORY
   *
   * "Which companies are paid by foreign interests to shape American
   * political opinion" is not a question that needs speculating about. Since
   * 1938 it has been a REGISTRATION REQUIREMENT: 22 U.S.C. 611 et seq. makes
   * anyone acting in the United States as an agent of a foreign principal —
   * for political or public-relations purposes — file with the Justice
   * Department, name the principal, state the activity, and report what they
   * were paid. Failing to register is a felony.
   *
   * So the answer is a public database, and this is it. What it will show is
   * PR firms, law firms and consultancies working for foreign governments and
   * companies, disclosed under oath. What it will not show is a secret
   * network, because a secret network by definition does not register — and
   * the absence of one here is a fact about FARA's coverage, not proof that
   * none exists.
   *
   * ─────────────────────────────────────────────────────────────────────
   * WHY THE PARSER DOES NOT ASSUME A SCHEMA
   *
   * DOJ publishes the whole active-registrant list at one URL; there is no
   * search endpoint, so the filtering is local. The exact field names were
   * not verifiable when this was written, and a parser that guesses them
   * fetches successfully, matches nothing, and reports a clean zero — the
   * worst failure this desk has: a confident wrong null.
   *
   * So it finds the record array wherever it sits, matches the query against
   * every string value in a record, and reports the record's OWN field names
   * back to the operator. It cannot silently mismatch a schema it never
   * claimed to know.
   */
  /**
   * SEC EDGAR full-text search — what a platform swore to the SEC about
   * its own fake accounts.
   *
   * ───────────────────────────────────────────────────────────────────────
   * WHY THIS CONNECTOR EXISTS
   * ───────────────────────────────────────────────────────────────────────
   * "The platforms are full of bots" is the single most common claim in this
   * subject area and the least evidenced. Nobody outside a platform can count
   * its inauthentic accounts: the data is server-side, and every public
   * estimate is a sample generalised to a population nobody can see.
   *
   * But the platforms themselves publish a number, under a different kind of
   * obligation. A 10-K is signed under 15 U.S.C. 78ff and Sarbanes-Oxley
   * s.302 by named officers, and Meta, Snap, Pinterest and Reddit all disclose
   * estimated duplicate and false accounts in it, because advertisers price
   * inventory on user counts and a materially wrong count is securities fraud.
   *
   * That makes the 10-K the only public, sworn, company-specific, comparable
   * figure that exists on this question. It is an ESTIMATE — the filings say
   * so themselves, usually at length — and this connector's job is to put the
   * operator in front of the company's own words rather than a headline about
   * them.
   *
   * ───────────────────────────────────────────────────────────────────────
   * WHAT IT DOES NOT ESTABLISH
   * ───────────────────────────────────────────────────────────────────────
   * A disclosed duplicate-account estimate is not a bot count, and the two get
   * conflated constantly. A duplicate account is a real person's second
   * account. A "false" account covers both user-misclassified accounts (a pet,
   * a business page on a personal profile) and accounts the company judges to
   * be undesirable — spam, scripted, malicious. Only that last slice is what
   * anyone means by "bot", and the filings do not break it out by campaign,
   * origin, or state sponsorship. Nothing here connects a platform's estimate
   * to any influence operation, and treating it as if it did would be the
   * easiest false claim in this entire subject.
   *
   * Full-text search covers 2001 onward and searches the filing text only.
   */
  sec: {
    label: 'SEC EDGAR (full-text search of filings)',
    // The `name` is a FILER, which is a real legal entity, so entity indexing
    // is on — unlike Federal Register, where the name is a document title.
    entityNames: true,
    keyVar: null,          // no key; SEC asks for a declared contact instead
    keyRequired: false,
    calls: 1,
    describe: (q, o = {}) => 'GET https://efts.sec.gov/LATEST/search-index'
      + `  (term: ${q} — sent ${phraseMode(q, o)}`
      + `; forms: ${o.allforms ? 'ALL' : '10-K only'})`,
    probe: () => ({
      method: 'GET',
      url: 'https://efts.sec.gov/LATEST/search-index?q=%22duplicate%20accounts%22&forms=10-K',
      headers: { Accept: 'application/json', 'User-Agent': SEC_UA() },
    }),
    run: (q, key, o = {}) => ({
      method: 'GET',
      url: 'https://efts.sec.gov/LATEST/search-index'
         + `?q=${encodeURIComponent(phrase(q, o))}`
         + (o.allforms ? '' : '&forms=10-K'),
      // SEC's access policy asks every automated client to identify itself
      // with a contact address. A request without one is refused, and the
      // refusal is an HTTP 403 that reads exactly like "no results" if it is
      // not caught. Set SEC_CONTACT in .env to your own address.
      headers: { Accept: 'application/json', 'User-Agent': SEC_UA() },
    }),
    parse: (json) => {
      const hits = (json && json.hits && Array.isArray(json.hits.hits))
        ? json.hits.hits : [];
      return hits.map((h) => {
        const s = (h && h._source) || {};
        // _id is "<accession>:<document filename>". Both halves are needed to
        // build a URL to the actual filing, and a URL that cannot be built is
        // reported as absent rather than guessed at — a constructed EDGAR path
        // that 404s is worse than no link, because it looks checkable.
        const id = String(h._id || '');
        const colon = id.indexOf(':');
        const accession = colon > 0 ? id.slice(0, colon) : '';
        const docName = colon > 0 ? id.slice(colon + 1) : '';
        const cik = Array.isArray(s.ciks) && s.ciks.length ? String(s.ciks[0]) : '';
        const url = (accession && docName && cik)
          ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/`
            + `${accession.replace(/-/g, '')}/${docName}`
          : '';
        // display_names arrive as "Meta Platforms, Inc.  (META)  (CIK 000...)".
        // The ticker and CIK are kept separately rather than left glued into
        // the name, because a name with a CIK inside it will never match the
        // same company coming from any other connector.
        const raw = Array.isArray(s.display_names) && s.display_names.length
          ? String(s.display_names[0]) : '';
        const name = raw.replace(/\s*\((?:CIK\s*)?[^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const tick = /\(([A-Z.\-]{1,6})\)/.exec(raw);
        return {
          external_id: id,
          name: name || raw || '(filer not named in this hit)',
          ticker: tick ? tick[1] : '',
          cik,
          form: s.root_form || s.file_type || '',
          date: s.file_date || '',
          url,
        };
      });
    },
    identify: (r) => r.external_id,
    /**
     * A zero here has four causes and only one of them is a real null.
     *
     * The dangerous ones are the 403 (no declared contact — SEC refuses and
     * the body is not JSON) and a schema change under hits.hits, either of
     * which reports "this company never disclosed a false-account estimate"
     * about a company that discloses one every February.
     */
    diagnose: (json) => {
      if (!json || typeof json !== 'object') {
        return 'THE RESPONSE WAS NOT JSON. SEC refuses automated requests that '
          + 'do not declare a contact address, and the refusal is an HTML page, '
          + 'not an empty result. Set SEC_CONTACT=you@example.com in .env and '
          + 'run this again before believing the zero.';
      }
      if (!json.hits || !Array.isArray(json.hits.hits)) {
        return 'NO hits.hits ARRAY IN THE RESPONSE. That is a schema mismatch, '
          + 'not a null result — the capture is on disk; send its top-level '
          + `keys (${Object.keys(json).join(', ').slice(0, 120)}) and this can `
          + 'be fixed.';
      }
      const total = (json.hits.total && (json.hits.total.value ?? json.hits.total)) ?? 0;
      return `${json.hits.hits.length} hit(s) returned of ${total} reported by `
        + 'EDGAR. Full-text search covers 2001 onward and searches filing TEXT '
        + 'only — a phrase the company words differently will not match, and '
        + 'that is a search result, not a fact about the company.';
    },
  },

  fara: {
    label: 'FARA (foreign agents registration)',
    keyVar: null,
    keyRequired: false,
    calls: 1,
    describe: (q) => 'GET https://efile.fara.gov/api/v1/Registrants/json/Active'
      + `  (whole active list, filtered locally for: ${q})`,
    probe: () => ({
      method: 'GET',
      url: 'https://efile.fara.gov/api/v1/Registrants/json/Active',
      headers: { Accept: 'application/json' },
    }),
    run: () => ({
      method: 'GET',
      url: 'https://efile.fara.gov/api/v1/Registrants/json/Active',
      headers: { Accept: 'application/json' },
    }),
    parse: (json, query) => {
      const rows = findRecordArray(json);
      if (!rows.length) return [];
      const q = String(query || '').toLowerCase().trim();
      if (!q) return [];
      const hits = rows.filter((r) => r && typeof r === 'object'
        && Object.values(r).some((v) => typeof v === 'string'
          && v.toLowerCase().includes(q)));
      // Uncapped for the same reason as `faradocs`: a cap that prints as a
      // count is a wrong answer to "how many registrants match".
      return hits.map((r) => {
        const k = Object.keys(r);
        const pick = (re) => {
          const key = k.find((n) => re.test(n));
          return key ? String(r[key]) : '';
        };
        return {
          external_id: pick(/registration.?number|reg.?num/i) || pick(/^id$/i),
          name: pick(/registrant.?name|^name$/i) || '(see fields)',
          // NOT the foreign principal. The active-registrant list does not
          // carry one — DOJ keeps principals in the registrant's DOCUMENTS,
          // which is what `faradocs` fetches by registration number. This
          // used to advertise a `principal` field that was always empty,
          // which reads as "registered, but no principal on file" and is the
          // opposite of true.
          state: pick(/^state$|jurisdiction/i),
          registered: pick(/registration.?date|date/i),
          address: '',                       // deliberately NOT collected
          // What the record actually called its columns, so a mismatch is
          // visible rather than silent.
          fields: k.join(', ').slice(0, 200),
        };
      });
    },
    identify: (r) => r.external_id || r.name,
    /**
     * What to say when nothing matched.
     *
     * A zero from a connector has two completely different causes and they
     * look identical: the source really holds nothing, or the parser missed
     * the schema and matched nothing it was handed. The second is the more
     * dangerous by far — it reports "no foreign-agent registration" for a
     * firm that may have several.
     *
     * The `fields` line was meant to expose that, and it only printed on a
     * HIT, which is precisely the case where you do not need it. So: on an
     * empty result, say how many records were actually read and what the
     * first one calls its columns. Thousands of records and no match is a
     * real null. Zero records read is a bug in this file.
     */
    diagnose: (json) => {
      const rows = findRecordArray(json);
      if (!rows.length) {
        return 'NO RECORDS WERE READ AT ALL. That is not a null result — the '
          + 'response arrived in a shape this parser did not find. The capture '
          + 'is on disk; send its top-level keys and this can be fixed.';
      }
      const keys = Object.keys(rows[0] || {});
      return `${rows.length} record(s) read, none matching. `
        + `Columns: ${keys.join(', ').slice(0, 200)}`;
    },
  },
  /**
   * FARA documents — WHO paid the registered agent.
   *
   * The active-registrant list answers "is this firm a registered foreign
   * agent". It does not say for whom: DOJ keeps the foreign principals, the
   * contracts and the money in the registrant's filed DOCUMENTS, addressed by
   * registration number.
   *
   * So the query here is a REGISTRATION NUMBER, not a name — the number that
   * `fara` prints as external_id. That is deliberate. Guessing a firm's
   * registration number would be the same error as guessing a schema: it
   * would return a clean, confident answer about the wrong entity.
   */
  faradocs: {
    label: 'FARA documents (who the principal is)',
    keyVar: null,
    keyRequired: false,
    calls: 1,
    takesFreeText: false,        // it takes a registration number
    describe: (q) => `GET https://efile.fara.gov/api/v1/RegDocs/json/${encodeURIComponent(q)}`
      + '  (documents filed BY that registration number)',
    probe: () => ({
      method: 'GET',
      url: 'https://efile.fara.gov/api/v1/Registrants/json/Active',
      headers: { Accept: 'application/json' },
    }),
    run: (q) => ({
      method: 'GET',
      url: `https://efile.fara.gov/api/v1/RegDocs/json/${encodeURIComponent(String(q).trim())}`,
      headers: { Accept: 'application/json' },
    }),
    parse: (json) => {
      const rows = findRecordArray(json);
      // NOT sliced. This is the one connector that returns a firm's whole
      // filing history rather than a page of search results: BGR's number
      // came back with 917 documents and the old `.slice(0, 25)` surfaced the
      // most recent 25 of them under the heading "25 candidate lead(s)". A
      // cap that reads as a count is how you conclude a firm started filing
      // in March when the record goes back years. The caller decides how many
      // to show, and it says how many it is not showing.
      return rows.map((r) => {
        const k = Object.keys(r);
        const pick = (re) => {
          const key = k.find((n) => re.test(n));
          return key ? String(r[key]).trim() : '';
        };
        // The live schema is
        //   DATE_STAMPED, REGISTRATION_NUMBER, FOREIGN_PRINCIPAL_COUNTRY,
        //   DOCUMENT_TYPE, REGISTRANT_NAME, URL, SHORT_FORM_NAME,
        //   FOREIGN_PRINCIPAL_NAME
        // and COUNTRY comes back from Object.keys() BEFORE NAME. A loose
        // /principal/ match therefore returned "SAUDI ARABIA" where the row
        // was supposed to name an entity. A country is not a principal; the
        // Kingdom of Saudi Arabia and a PR firm retained by it are different
        // facts, and only one of them is a party to a contract.
        const principal = pick(/foreign.?principal.?name/i)
          || pick(/principal.?name/i)
          || pick(/^foreign.?principal$/i);
        const country = pick(/foreign.?principal.?country/i)
          || pick(/^country$/i);
        const registrant = pick(/registrant.?name|^name$/i);
        // On a Short-Form registration this names the INDIVIDUAL at the firm
        // who is registering as an agent of the foreign principal. It is a
        // natural person, and it is here on purpose: it is that person's own
        // sworn filing under 22 U.S.C. 611, made in their professional
        // capacity, and it is the field that turns "a firm lobbied" into "a
        // named person did". Dropping it was throwing away the most specific
        // fact on the record.
        const shortForm = pick(/short.?form.?name/i);
        return {
          external_id: pick(/document.?id|^id$/i) || pick(/url/i),
          // The principal is the point of the whole exercise, so an absent
          // one says so. It does NOT fall back to the registrant's own name:
          // printing "Ballard Partners" in the principal column would read as
          // a firm that filed for itself, which is not what an empty
          // FOREIGN_PRINCIPAL_NAME means. Some document types (registration
          // amendments, short-form filings) genuinely name no principal.
          name: principal || '(no foreign principal named on this document)',
          country,
          registrant,
          agent: shortForm,
          document: pick(/document.?type|^type$/i),
          filed: pick(/date.?stamped|filed|date/i),
          url: pick(/url|link/i),
          fields: k.join(', ').slice(0, 200),
        };
      });
    },
    identify: (r) => r.external_id || r.name,
    diagnose: (json) => {
      const rows = findRecordArray(json);
      if (!rows.length) {
        return 'NO RECORDS READ. Either that registration number filed nothing, '
          + 'or the response shape was not recognised. Check the capture.';
      }
      return `${rows.length} document(s) read, none parsed into a row. `
        + `Columns: ${Object.keys(rows[0] || {}).join(', ').slice(0, 200)}`;
    },
  },
  federalgrants: {
    label: 'USAspending (grants & cooperative agreements)',
    keyVar: null,
    keyRequired: false,
    calls: 1,
    describe: (q) => 'POST https://api.usaspending.gov/api/v2/search/spending_by_award/'
      + `  (recipient: ${q} — GRANTS & COOPERATIVE AGREEMENTS)`,
    probe: () => ({
      method: 'GET',
      url: 'https://api.usaspending.gov/api/v2/references/toptier_agencies/',
      headers: {},
    }),
    run: (q) => ({
      method: 'POST',
      url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [q],
          // 02 block · 03 formula · 04 project · 05 cooperative agreement
          award_type_codes: ['02', '03', '04', '05'],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
                 'Start Date', 'End Date', 'Description'],
        sort: 'Award Amount',
        order: 'desc',
        limit: 25,
        page: 1,
      }),
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.generated_internal_id || r['Award ID'] || '',
      name: r['Recipient Name'] || '(unnamed recipient)',
      award_id: r['Award ID'] || '',
      amount: r['Award Amount'] != null ? `$${Number(r['Award Amount']).toLocaleString()}` : '',
      agency: r['Awarding Agency'] || '',
      period: [r['Start Date'], r['End Date']].filter(Boolean).join(' → '),
      description: (r.Description || '').slice(0, 140),
      url: r.generated_internal_id ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : '',
    })),
    identify: (r) => r.external_id,
  },
};

// ---------------------------------------------------------------- the run
/**
 * Run one connector once, under the ratified procedure.
 *
 * Returns { ok, status, error?, capturePath?, captureHash?, results, record? }.
 * On any non-2xx or transport failure it is FAIL-CLOSED: no capture file is
 * written and no ledger line is created. A ledger that records a run which did
 * not happen is worse than no ledger.
 */
async function runConnector(name, query, opts = {}) {
  const c = CONNECTORS[name];
  if (!c) return { ok: false, error: `unknown connector: ${name}`, results: [] };
  if (!query) return { ok: false, error: 'empty query', results: [] };

  const env = opts.env || loadEnv();
  const key = resolveKey(c, env);
  if (c.keyRequired && !key) {
    const names = c.keyVarAlt ? `${c.keyVar} (or ${c.keyVarAlt})` : c.keyVar;
    return { ok: false, error: `${names} is not set`, keyMissing: true, results: [] };
  }

  const spec = c.run(query, key,
    { mode: opts.mode, page: opts.page, exact: opts.exact, any: opts.any,
      dockets: opts.dockets });

  if (opts.dryRun) {
    return { ok: true, dryRun: true,
      announced: c.describe(query, { exact: opts.exact, any: opts.any }),
      url: spec.url, results: [] };
  }

  // ---- capture ---------------------------------------------------------
  await pace(name, c);
  let res = await request(spec.method, spec.url, spec.headers, spec.body);

  // A 429 is not a failure, it is "later". The service says how much later;
  // wait exactly that and try once more. Once, not in a loop -- a retry loop
  // against a rate limit is how you turn being throttled into being blocked.
  if (res.status === 429) {
    const wait = retryAfterMs(res);
    if (wait !== null && wait <= 90000) {
      await sleep(wait);
      LAST_CALL.set(name, Date.now());
      res = await request(spec.method, spec.url, spec.headers, spec.body);
    }
  }
  if (res.status === 0) return { ok: false, status: 0, error: res.error, results: [] };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status,
             error: explainHttpError(res), results: [] };
  }

  const evidenceRoot = opts.evidenceRoot || EVIDENCE;
  const captureDir = opts.captureDir || path.join(evidenceRoot, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = query.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  const capturePath = path.join(captureDir, `live_capture_${name}_${slug}_${stamp}.json`);
  fs.writeFileSync(capturePath, res.body);

  // ---- hash BEFORE anything is derived from these bytes ----------------
  const captureHash = P.sha256Bytes(res.body);

  let results = [];
  let parseError = null;
  try {
    // The query is passed because one connector (fara) serves a whole dataset
    // rather than a search: DOJ publishes the full active-registrant list and
    // the filtering happens here. Every other parser ignores the argument.
    results = c.parse(JSON.parse(decodeBody(res.body)), query);
  } catch (e) {
    parseError = e.message;
  }

  // ---- record ----------------------------------------------------------
  const ledger = new P.Ledger(opts.ledgerPath || LEDGER);
  const record = P.makeRecord({
    kind: 'connector_run',
    artifactId: `${name}-${stamp}`,
    label: `${c.label} search: ${query}`,
    tool: opts.tool || 'sentinel connect',
    toolVersion: VERSION,
    tier: 'GREEN',              // we hold the exact bytes and their hash
    sha256: captureHash,
    localPath: capturePath,
    evidenceRoot,
    sourceUrl: spec.url,
    extra: Object.assign({
      connector: name,
      subject: query,
      // What `--into` actually does: tag the record. It was passed in and
      // dropped on the floor while the terminal announced a folder that was
      // never written to.
      investigation: opts.investigation || null,
      // Which question was asked. A capture that does not say cannot be
      // told apart later from one that asked the other question.
      search_mode: opts.mode === 'registrant' ? 'registrant_name' : 'client_name',
      page: opts.page || 1,
      http_status: res.status,
      live_calls: 1,
      result_count: results.length,
      // The field that stops a hit becoming a fact.
      result_disposition: 'lead_needs_primary_source',
      parse_error: parseError,
    }, opts.extra || {}),
  });
  ledger.append(record);

  return { ok: true, status: res.status, capturePath, captureHash, results, parseError, record };
}

module.exports = {
  phrase, phraseMode, PHRASE_WORD_LIMIT, findRecordArray, decodeBody,
  foreignEntitySummary,
  explainHttpError, looksLikeSubstringMatch,
  checkKeyShape, KEY_SHAPES,
  stripAuth, AUTH_HEADERS, MAX_REDIRECTS,
  CONNECTORS, VERSION, EVIDENCE, CAPTURES, LEDGER, resolveKey, retryAfterMs, pace,
  loadEnv, mask, request, runConnector,
};
