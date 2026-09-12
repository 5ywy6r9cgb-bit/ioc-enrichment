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
/**
 * A MULTI-WORD SUBJECT IS A PHRASE, NOT A BAG OF WORDS.
 *
 * Three full-text connectors sent the subject unquoted, so the APIs matched
 * the words INDEPENDENTLY. The results were not near-misses; they were
 * documents about entirely different things that happened to contain one
 * common word:
 *
 *   "Axon Enterprise"  → IRIS Toxicological Review of Formaldehyde,
 *                        Tox Profile for Carbon Disulfide
 *                        AXON is an anatomical term. Carbon disulfide is a
 *                        classic AXONAL neurotoxin.
 *
 *   "Flock Safety"     → migratory bird hunting regulations,
 *                        National Poultry Improvement Plan
 *                        FLOCK is an ornithological term.
 *
 *   "Peregrine Technologies" → FWS migratory bird notices. A falcon.
 *   "Fusus"                  → 1990s Colombian cut-flower dumping notices.
 *
 * This was STRUCTURAL: it corrupted every multi-word subject in every sweep,
 * on every connector that takes free text. Roughly half of a 1,600-lead
 * surveillance sweep was this, and it was reported as leads requiring
 * verification rather than as an artifact of how the query was built.
 *
 * Quoting is not a filter on the results. It is the difference between
 * asking the right question and the wrong one.
 *
 * A SINGLE WORD IS LEFT ALONE. Quoting it changes nothing and some APIs
 * treat a quoted single term differently from a bare one.
 */
function phrase(q) {
  const t = String(q == null ? '' : q).trim();
  if (!t) return t;
  // Already quoted by the operator: respect it rather than double-quoting.
  if (/^".*"$/.test(t)) return t;
  // A quote inside the subject would break the phrase syntax. Drop it — a
  // company name with an embedded double quote is rarer than a broken query.
  const clean = t.replace(/"/g, '');
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

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
    describe: (q) => `POST https://api.opensanctions.org/match/default?algorithm=logic-v2  (subject: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.opensanctions.org/search/default?q=test&limit=1',
      headers: key ? { Authorization: `ApiKey ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'POST',
      url: 'https://api.opensanctions.org/match/default?algorithm=logic-v2',
      headers: { Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: { q1: { schema: 'Person', properties: { name: [q] } } } }),
    }),
    parse: (json) => {
      const results = (json.responses && json.responses.q1 && json.responses.q1.results) || [];
      return results.map((r) => ({
        external_id: r.id,
        name: r.caption,
        schema: r.schema,
        topics: (r.properties && r.properties.topics) || [],
        score: r.score,
        url: `https://www.opensanctions.org/entities/${r.id}/`,
      }));
    },
    identify: (r) => r.external_id,
  },

  courtlistener: {
    label: 'CourtListener',
    keyVar: 'COURTLISTENER_API_TOKEN',
    // Documented as 5/min, and enforced: a sweep without this lost the source
    // on most subjects. 13s leaves headroom for clock drift.
    //
    // THE PER-MINUTE PACE IS NOT THE BINDING LIMIT. A live 429 read
    // "Rate limit exceeded: 50/hour" — an HOURLY cap that 13s spacing sails
    // straight through at roughly 277/hour. Two back-to-back sweeps spent
    // the whole hour's budget and the next single search was refused. The
    // pacer cannot fix that; only asking for less can. Sweep first, then
    // run individual searches, and expect roughly fifty an hour in total.
    minIntervalMs: 13000,
    keyRequired: false, // anonymous search works; the token raises rate limits
    calls: 1,
    describe: (q, key, o = {}) => 'GET https://www.courtlistener.com/api/rest/v4/search/'
      + `  (q: ${q}, ${o.mode === 'dockets' ? 'type=r — RECAP DOCKETS' : 'type=o — published opinions'})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/search/?q=test&type=o',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    /**
     * `type=o` IS PUBLISHED OPINIONS, AND MOST PROSECUTIONS DO NOT HAVE ONE.
     *
     * The live failure: `courtlistener "Feeding Our Future"` returned exactly
     * one result — Mart v. Mart, Iowa Court of Appeals, 2012 — against a
     * prosecution with roughly seventy charged defendants in D. Minn.
     * `"Aimee Bock"` returned zero.
     *
     * Neither is an absence in the courts. A criminal case that ends in a
     * jury verdict or a plea agreement frequently produces NO published
     * opinion at all: it produces a DOCKET. Published opinions are what
     * happens when a judge writes about a contested legal question, which is
     * a small and badly unrepresentative slice of what courts do.
     *
     * So this was the §61 error wearing a robe — a query shape manufacturing
     * an absence — and it shipped inside the section arguing against exactly
     * that. `type=r` searches the RECAP archive, which is dockets and the
     * documents filed in them.
     *
     * Opinions stay the default because they are what you cite for a HOLDING.
     * Dockets are what you cite for the fact that a case EXISTS.
     */
    run: (q, key, o = {}) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/search/'
        + `?q=${encodeURIComponent(phrase(q))}`
        + `&type=${o.mode === 'dockets' ? 'r' : 'o'}`
        + '&order_by=score%20desc',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    parse: (json) => (json.results || []).map((r) => ({
      // RECAP results key on docket_id; opinion results on id/cluster_id.
      external_id: String(r.id || r.cluster_id || r.docket_id || ''),
      // SURFACED SEPARATELY because `external_id` on a RECAP row may be the
      // docket-ENTRY id, and only the docket id can be handed to `clparties`
      // to get the real caption. §78 is unfixable without this number.
      docket_id: r.docket_id != null ? String(r.docket_id) : '',
      name: r.caseName || r.case_name || '(untitled)',
      court: r.court || r.court_id || '',
      date: r.dateFiled || r.date_filed || '',
      docket: r.docketNumber || r.docket_number || '',
      // A docket hit carries the charge or the filing text; an opinion hit
      // does not. Keeping it is the difference between "a case exists" and
      // "a case exists and here is what it says on its face".
      description: String(r.description || r.suitNature || ''),
      // ⚠ DO NOT CITE THIS FIELD. IT IS NOT THE CAPTION.
      //
      // Three things observed in one live run:
      //
      //   - `King v. Whitmer` (2:20-cv-13134) came back with parties
      //     "Robert Davis; Daren Rubingh; Charles Ritchard; James Hooper;
      //     Jocelyn Benson; Brandon Johnson" — and NEITHER King NOR Whitmer.
      //
      //   - `O'Rourke v. Dominion Voting Systems` (D. Colo. 1:20-cv-03747)
      //     came back carrying Tony Evers, Mark Thomsen and Robert Spindell
      //     — the GOVERNOR and ELECTION COMMISSIONERS OF WISCONSIN, who are
      //     parties to Feehan in E.D. Wis. and have no business in a
      //     Colorado case.
      //
      //   - `Adoptee Rights Law Center PLLC v. USCIS` came back with docket
      //     `0:23-cr-00160` — a CRIMINAL number — under the description
      //     "895 Freedom of Information Act".
      //
      // Whatever the cause, the operational rule is absolute: this is a
      // TRUNCATED and sometimes CROSS-CONTAMINATED sample, useful only for
      // deciding whether a row is worth opening. Publishing a person's name
      // from it puts a real individual next to a criminal docket on the
      // strength of a field that has already been caught carrying the wrong
      // state's officials.
      //
      // The caption lives on the docket page. Open it.
      party: Array.isArray(r.party) ? r.party.slice(0, 6).join('; ') : '',
      documents: Array.isArray(r.recap_documents) ? r.recap_documents.length : 0,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : '',
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
    describe: (q) => `GET https://www.federalregister.gov/api/v1/documents.json  (term: ${q})`,
    probe: () => ({
      method: 'GET',
      url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=1',
      headers: {},
    }),
    run: (q) => ({
      method: 'GET',
      url: 'https://www.federalregister.gov/api/v1/documents.json'
         + `?per_page=25&order=newest&conditions%5Bterm%5D=${encodeURIComponent(phrase(q))}`,
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
    // `q` matches a candidate's NAME. A query like "Ohio Senate" is an office
    // and a state, matches no person, and returns zero — which reads as "no
    // such candidates" when the fact is "that is not what this field asks."
    //
    // So a query of the shape "OH/S" or "OH/H/15" is translated into the
    // structured filters the endpoint actually has, and anything else is
    // still a name search. A delegation is a filter, not a name.
    // A state and an office alone returns every person who ever filed for it.
    // For OH/S that is forty years of write-ins and minor-party candidates
    // sorted by who filed most recently, so the incumbent is nowhere near the
    // top and the list reads as noise. An election year is what turns "who
    // has ever run" into "who is running", so the grammar carries one:
    //
    //   OH/S            every Senate filer in Ohio, ever
    //   OH/S/2026       Ohio Senate, that election
    //   OH/H/15         Ohio 15th district, ever
    //   OH/H/15/2026    Ohio 15th, that election
    //
    // Four digits is a year and one or two is a district, which is
    // unambiguous because there is no 2026th congressional district.
    run: (q, key) => {
      const s = String(q).trim();
      const m = /^([A-Za-z]{2})\s*\/\s*([HSPhsp])((?:\s*\/\s*\d{1,4})*)$/.exec(s);
      const base = 'https://api.open.fec.gov/v1/candidates/search/'
                 + `?api_key=${encodeURIComponent(key)}`
                 + '&sort=-first_file_date&per_page=100';
      if (m) {
        let u = base + `&state=${m[1].toUpperCase()}&office=${m[2].toUpperCase()}`;
        const parts = (m[3] || '').split('/').map((x) => x.trim()).filter(Boolean);
        for (const part of parts) {
          if (part.length === 4) u += `&election_year=${part}`;
          else u += `&district=${part.padStart(2, '0')}`;
        }
        // Without a year, at least drop the people who have stopped running.
        if (!parts.some((x) => x.length === 4)) u += '&is_active_candidate=true';
        return { method: 'GET', url: u, headers: {} };
      }
      return { method: 'GET', url: base + `&q=${encodeURIComponent(q)}`, headers: {} };
    },
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
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.filing_uuid || r.filing_document_url || '',
      name: `${(r.client && r.client.name) || '(client?)'} — ${(r.registrant && r.registrant.name) || '(registrant?)'}`,
      period: `${r.filing_year || ''} ${r.filing_period_display || r.filing_period || ''}`.trim(),
      amount: r.income || r.expenses || '',
      issues: (r.lobbying_activities || []).map((a) => a.general_issue_code_display).filter(Boolean).join('; '),
      url: r.filing_document_url || '',
    })),
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
    describe: (q) => `GET https://api.regulations.gov/v4/documents  (searchTerm: ${phrase(q)})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents?page[size]=5',
      headers: { 'X-Api-Key': key || 'DEMO_KEY' },
    }),
    run: (q, key) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents'
         + `?filter[searchTerm]=${encodeURIComponent(phrase(q))}`
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

  /**
   * ─────────────────────────────────────────────────────────────────────
   * READING A DOCUMENT, NOT SEARCHING FOR ONE
   * ─────────────────────────────────────────────────────────────────────
   * Every connector above answers "does this string appear anywhere". None
   * of them answers "what does THIS document say" — so six Federal Register
   * documents have been sitting in the findings file as TITLES ONLY, under
   * a rule this desk wrote for itself: unread is unsayable.
   *
   * Chief among them, 2026-00596: a Somalia TPS termination returned by a
   * full-text search for "Feeding Our Future". Nobody knows why it matched.
   * A co-occurrence between a fraud case and an immigration action is
   * exactly the shape a frame gets built on, and exactly the shape that
   * collapses when someone opens the document. **So open it.**
   *
   * Takes a DOCUMENT NUMBER (2026-00512), not a search term.
   */
  fedregdoc: {
    label: 'Federal Register (one document)',
    keyVar: null,
    keyRequired: false,
    calls: 1,
    describe: (q) => `GET https://www.federalregister.gov/api/v1/documents/${q}.json`,
    probe: () => ({
      method: 'GET',
      url: 'https://www.federalregister.gov/api/v1/documents/2026-00512.json?fields[]=title',
      headers: {},
    }),
    run: (q) => ({
      method: 'GET',
      url: `https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(String(q).trim())}.json`
        + ['title', 'abstract', 'action', 'agencies', 'publication_date',
           'effective_on', 'comments_close_on', 'docket_ids', 'document_number',
           'type', 'html_url', 'pdf_url', 'raw_text_url', 'dates',
           'regulation_id_numbers', 'cfr_references', 'significant', 'page_length']
          .map((f) => `&fields[]=${f}`).join('').replace('&', '?'),
      headers: {},
    }),
    // One document, returned as one row, so the generic display prints every
    // field it carries instead of a truncated list of leads.
    parse: (json) => (json && json.document_number ? [{
      external_id: json.document_number,
      name: json.title || '(untitled)',
      type: json.type || '',
      published: json.publication_date || '',
      agencies: Array.isArray(json.agencies)
        ? json.agencies.map((a) => a.name || a.raw_name).filter(Boolean).join('; ') : '',
      action: json.action || '',
      abstract: json.abstract || '',
      dates: json.dates || '',
      effective: json.effective_on || '',
      comments_close: json.comments_close_on || '',
      docket_ids: Array.isArray(json.docket_ids) ? json.docket_ids.join('; ') : '',
      rin: Array.isArray(json.regulation_id_numbers) ? json.regulation_id_numbers.join('; ') : '',
      significant: json.significant === true ? 'YES' : '',
      pages: json.page_length || '',
      url: json.html_url || '',
      pdf: json.pdf_url || '',
      raw_text: json.raw_text_url || '',
    }] : []),
    identify: (r) => r.external_id,
  },

  /**
   * THE AUTHORITATIVE CAPTION, WHICH THE SEARCH RESULT IS NOT.
   *
   * §78: the `party` line on a RECAP SEARCH result is a truncated sample
   * and was caught carrying Wisconsin's governor into a Colorado docket.
   * Thirteen names were published off it before that was noticed.
   *
   * This hits the DOCKETS endpoint by docket number, which returns the case
   * as the court records it — case_name_full, cause, nature of suit, the
   * judge, the filing and termination dates. Paired with `clparties` below
   * it is the only combination in this toolkit that can answer "who is on
   * this case" without guessing.
   */
  cldocket: {
    label: 'CourtListener (docket record)',
    keyVar: 'COURTLISTENER_API_TOKEN',
    minIntervalMs: 13000,
    keyRequired: false,
    calls: 1,
    describe: (q) => `GET https://www.courtlistener.com/api/rest/v4/dockets/?docket_number=${q}`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/dockets/?docket_number=2%3A20-cv-13134',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/dockets/'
        + `?docket_number=${encodeURIComponent(String(q).trim())}`,
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    parse: (json) => (json.results || []).map((d) => ({
      external_id: String(d.id || ''),
      name: d.case_name_full || d.case_name || '(untitled)',
      short_name: d.case_name || '',
      docket: d.docket_number || '',
      court: d.court_id || d.court || '',
      filed: d.date_filed || '',
      terminated: d.date_terminated || '',
      nature_of_suit: d.nature_of_suit || '',
      cause: d.cause || '',
      judge: d.assigned_to_str || '',
      referred_to: d.referred_to_str || '',
      pacer_id: d.pacer_case_id || '',
      url: d.absolute_url ? `https://www.courtlistener.com${d.absolute_url}` : '',
    })),
    identify: (r) => r.external_id,
  },

  /**
   * WHO IS ACTUALLY ON THE CASE. Takes a numeric DOCKET ID from `cldocket`.
   *
   * This is the field §78 should have used. It is the party table as the
   * court keeps it, not a relevance-ranked sample from a search index.
   */
  clparties: {
    label: 'CourtListener (parties on a docket)',
    keyVar: 'COURTLISTENER_API_TOKEN',
    minIntervalMs: 13000,
    keyRequired: false,
    calls: 1,
    describe: (q) => `GET https://www.courtlistener.com/api/rest/v4/parties/?docket=${q}`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/parties/?docket=18693929',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: `https://www.courtlistener.com/api/rest/v4/parties/?docket=${encodeURIComponent(String(q).trim())}`,
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    parse: (json) => (json.results || []).map((p) => ({
      external_id: String(p.id || ''),
      name: p.name || '(unnamed party)',
      // party_types carries the ROLE — Defendant, Plaintiff, Movant. That
      // distinction is the whole difference between "named on a case" and
      // "charged", and no search result carries it.
      role: Array.isArray(p.party_types)
        ? [...new Set(p.party_types.map((t) => t.name).filter(Boolean))].join('; ') : '',
      terminated: Array.isArray(p.party_types)
        ? (p.party_types.map((t) => t.date_terminated).filter(Boolean)[0] || '') : '',
    })),
    identify: (r) => r.external_id,
  },

  usaspending: {
    label: 'USAspending (federal awards)',
    keyVar: null,        // no key at all
    keyRequired: false,
    calls: 1,
    describe: (q) => `POST https://api.usaspending.gov/api/v2/search/spending_by_award/  (recipient: ${q})`,
    probe: () => ({
      method: 'GET',
      url: 'https://api.usaspending.gov/api/v2/references/toptier_agencies/',
      headers: {},
    }),
    // PAGED. One page of 25 sorted by amount is a CEILING on what was asked,
    // not a floor on what exists — NTREPID returned 25 and the run reported
    // 25, which is the page size. `connect awards` walks the pages.
    //
    // THE INSTRUMENT IS AN ARGUMENT, NOT A CONSTANT. This defaulted to
    // A/B/C/D — contracts — and nothing else could be asked for. The live
    // consequence: `awards "Intel Corporation"` returned NASA software
    // licence renewals and no CHIPS money, because CHIPS is financial
    // assistance. A filter that cannot be changed reports an absence it
    // created. One group per request, with that group's own fields and
    // sort: USAspending validates `fields` against the award types asked
    // for, "Contract Award Type" is not legal on an assistance query, and
    // a loan has no Award Amount at all.
    run: (q, key, o = {}) => ({
      method: 'POST',
      url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [q],
          award_type_codes: Array.isArray(o.instruments) && o.instruments.length
            ? o.instruments
            : ['A', 'B', 'C', 'D'],
        },
        fields: Array.isArray(o.fields) && o.fields.length ? o.fields
          : ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
             'Awarding Sub Agency', 'Start Date', 'End Date', 'Description',
             'Contract Award Type'],
        sort: o.sort || 'Award Amount',
        order: 'desc',
        limit: 100,
        page: o.page && o.page > 1 ? o.page : 1,
      }),
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: r.generated_internal_id || r['Award ID'] || '',
      name: r['Recipient Name'] || '(unnamed recipient)',
      award_id: r['Award ID'] || '',
      // Loans have no Award Amount. They have a Loan Value, which is FACE
      // VALUE of credit and not money that changed hands — it is carried
      // here under the same key so the display works, and the instrument
      // label above it is what stops the two being read as one thing.
      amount: r['Award Amount'] != null ? `$${Number(r['Award Amount']).toLocaleString()}`
        : (r['Loan Value'] != null ? `$${Number(r['Loan Value']).toLocaleString()}` : ''),
      subsidy_cost: r['Subsidy Cost'] != null
        ? `$${Number(r['Subsidy Cost']).toLocaleString()}` : '',
      agency: r['Awarding Agency'] || '',
      sub_agency: r['Awarding Sub Agency'] || '',
      period: [r['Start Date'] || r['Issued Date'], r['End Date']]
        .filter(Boolean).join(' → '),
      // What the government calls this transaction — "BPA CALL",
      // "DEFINITIVE CONTRACT", "DIRECT PAYMENT FOR SPECIFIED USE". It is
      // the answer to "is this money bought, given, or lent", and this
      // desk was not asking for it.
      award_type: r['Contract Award Type'] || r['Award Type'] || '',
      has_more: json && json.page_metadata ? !!json.page_metadata.hasNext : undefined,
      // NOT truncated at parse time: the capture is the evidence and a
      // display limit is a display's business. 140 chars cut the end off
      // every contract description before any reader or word count saw it.
      description: String(r.Description || ''),
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

  const spec = c.run(query, key, {
    mode: opts.mode,
    page: opts.page,
    instruments: opts.instruments,
    fields: opts.fields,
    sort: opts.sort,
  });

  if (opts.dryRun) {
    return { ok: true, dryRun: true, announced: c.describe(query), url: spec.url, results: [] };
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
    results = c.parse(JSON.parse(res.body.toString('utf8')));
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
    sourceUrl: redactUrl(spec.url),
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


/**
 * A URL with its credentials removed.
 *
 * The ledger is the file you would hand to a lawyer, a collaborator or an
 * editor to show where a number came from. Several services take their key
 * as a QUERY PARAMETER — the FEC is one — so recording `source_url` verbatim
 * writes the operator's API key into exactly the file whose purpose is to be
 * shown to other people.
 *
 * The evidence store is gitignored, so this never reached a remote. It was
 * still a secret sitting in the artefact most likely to be shared by hand.
 *
 * The parameter NAME is kept and only the value replaced, because "which
 * credential was used" is sometimes the question and "what was it" never is.
 */
const SECRET_PARAMS = /^(api[_-]?key|key|token|access[_-]?token|apikey|auth|secret|password|signature|sig)$/i;


/**
 * STRINGS A WEB FIREWALL REFUSES TO CARRY, AND THE BLIND SPOT THEY CREATE.
 *
 * One registrant out of 181 answered 403: MCGINLEY LLC. It was not rate
 * limiting (403 on the first request of a fresh run), not the connection (a
 * control succeeded in the same minute), and not the corporate suffix. A
 * four-request ladder found the cause:
 *
 *     MCGINLEY LLC  403      GINLEY                   200
 *     MCGIN         403      MCNEES WALLACE & NURICK  200
 *
 * M-C-G-I-N. The refused strings contain **cgi** and the accepted ones do
 * not — and from the full run MCGUIREWOODS and MCALLISTER, which share the
 * "MC" and even the "MCG", both answered normally.
 *
 * `cgi` is Common Gateway Interface, and generic web-firewall rules block
 * request strings containing it because of decades-old /cgi-bin/ exploits.
 * Nothing is denying anything about McGinley; a rule written for a 1990s
 * attack is eating three letters of a surname.
 *
 * WHY THIS MATTERS BEYOND ONE FIRM: it is a SYSTEMATIC BLIND SPOT. Any
 * organisation whose name contains those letters is unreachable through
 * this route — and CGI FEDERAL, a large federal IT contractor, is exactly
 * such a name. An empty result for a name like that would otherwise read as
 * "this company does not lobby", which is the §42 failure with a different
 * cause.
 *
 * So the toolkit names it rather than leaving the operator to a theory.
 */
const FIREWALL_SNAGS = [
  { re: /cgi/i, what: 'cgi', why: 'Common Gateway Interface — generic firewall '
    + 'rules block it because of /cgi-bin/ exploits' },
  { re: /\.\.\//, what: '../', why: 'path traversal' },
  { re: /<script/i, what: '<script', why: 'cross-site scripting' },
  { re: /\bunion\s+select\b/i, what: 'union select', why: 'SQL injection' },
];

/** Which snag, if any, a query string carries. Null when it carries none. */
function firewallSnag(query) {
  const q = String(query == null ? '' : query);
  if (!q) return null;
  return FIREWALL_SNAGS.find((s) => s.re.test(q)) || null;
}

function redactUrl(url) {
  const raw = String(url == null ? '' : url);
  if (!raw) return raw;
  let u;
  try { u = new URL(raw); } catch { return raw; }
  let touched = false;
  for (const name of [...u.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) { u.searchParams.set(name, 'REDACTED'); touched = true; }
  }
  return touched ? u.toString() : raw;
}

/**
 * Write bytes to a capture, hash them, and record the run in the ledger.
 *
 * Extracted from runConnector so the FEC commands can use the same path.
 * They could not: every FEC command drives a bespoke fetcher, so the
 * strongest figures on this desk — the ones an editor is most likely to
 * challenge — were the only ones with no capture file, no hash and no ledger
 * entry behind them. A number you cannot reproduce is a number you cannot
 * defend.
 *
 * Pages are NEVER merged into one file. The bytes on disk are bytes a server
 * actually sent, or they are not evidence.
 */
function recordCapture({ connector, subject, url, body, tool, extra = {},
  evidenceRoot, ledgerPath, prefix = 'live_capture' } = {}) {
  const root = evidenceRoot || EVIDENCE;
  const captureDir = path.join(root, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = String(subject || 'query').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  const capturePath = path.join(captureDir, `${prefix}_${connector}_${slug}_${stamp}.json`);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  fs.writeFileSync(capturePath, bytes);

  // Hash BEFORE anything is derived from these bytes.
  const sha256 = P.sha256Bytes(bytes);

  const ledger = new P.Ledger(ledgerPath || LEDGER);
  const record = P.makeRecord({
    kind: 'connector_run',
    artifactId: `${connector}-${stamp}`,
    label: `${connector}: ${subject}`,
    tool: tool || 'sentinel connect',
    toolVersion: VERSION,
    tier: 'GREEN',
    sha256,
    localPath: capturePath,
    evidenceRoot: root,
    sourceUrl: redactUrl(url),
    extra: Object.assign({
      connector, subject,
      result_disposition: 'lead_needs_primary_source',
    }, extra),
  });
  ledger.append(record);
  return { capturePath, sha256, record };
}

module.exports = { phrase,
  explainHttpError, looksLikeSubstringMatch,
  checkKeyShape, KEY_SHAPES,
  stripAuth, AUTH_HEADERS, MAX_REDIRECTS,
  CONNECTORS, VERSION, EVIDENCE, CAPTURES, LEDGER, resolveKey, retryAfterMs, pace,
  loadEnv, mask, request, runConnector, redactUrl, recordCapture,
  firewallSnag, FIREWALL_SNAGS,
};
