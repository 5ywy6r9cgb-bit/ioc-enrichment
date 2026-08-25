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
    keyRequired: false, // anonymous search works; the token raises rate limits
    calls: 1,
    describe: (q) => `GET https://www.courtlistener.com/api/rest/v4/search/  (q: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://www.courtlistener.com/api/rest/v4/search/?q=test&type=o',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(q)}&type=o&order_by=score%20desc`,
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    parse: (json) => (json.results || []).map((r) => ({
      external_id: String(r.id || r.cluster_id || ''),
      name: r.caseName || r.case_name || '(untitled)',
      court: r.court || r.court_id || '',
      date: r.dateFiled || r.date_filed || '',
      docket: r.docketNumber || r.docket_number || '',
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : '',
    })),
    identify: (r) => r.external_id,
  },

  federalregister: {
    label: 'Federal Register',
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
         + `?per_page=25&order=newest&conditions%5Bterm%5D=${encodeURIComponent(q)}`,
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
    label: 'Senate LDA (lobbying)',
    keyVar: 'LDA_API_KEY',
    keyRequired: false,  // anonymous works; a free key raises the rate limit
    calls: 1,
    describe: (q) => `GET https://lda.senate.gov/api/v1/filings/  (client/registrant: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://lda.senate.gov/api/v1/filings/?page_size=1',
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
    run: (q, key) => ({
      method: 'GET',
      url: `https://lda.senate.gov/api/v1/filings/?client_name=${encodeURIComponent(q)}&page_size=25&ordering=-dt_posted`,
      headers: key ? { Authorization: `Token ${key}` } : {},
    }),
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
    keyVar: 'DATA_GOV_API_KEY',
    keyRequired: true,   // free at api.data.gov/signup; DEMO_KEY works for a trial
    calls: 1,
    describe: (q) => `GET https://api.regulations.gov/v4/documents  (searchTerm: ${q})`,
    probe: (key) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents?page[size]=5',
      headers: { 'X-Api-Key': key || 'DEMO_KEY' },
    }),
    run: (q, key) => ({
      method: 'GET',
      url: 'https://api.regulations.gov/v4/documents'
         + `?filter[searchTerm]=${encodeURIComponent(q)}`
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
    run: (q) => ({
      method: 'POST',
      url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [q],
          award_type_codes: ['A', 'B', 'C', 'D'],   // contracts
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
  // keyVarAlt lets one api.data.gov registration serve every connector in
  // that federation, so the operator is not asked to register twice for a
  // key the government already treats as one key.
  const key = c.keyVar ? (env[c.keyVar] || (c.keyVarAlt ? env[c.keyVarAlt] : '') || '') : '';
  if (c.keyRequired && !key) {
    const names = c.keyVarAlt ? `${c.keyVar} (or ${c.keyVarAlt})` : c.keyVar;
    return { ok: false, error: `${names} is not set`, keyMissing: true, results: [] };
  }

  const spec = c.run(query, key);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, announced: c.describe(query), url: spec.url, results: [] };
  }

  // ---- capture ---------------------------------------------------------
  const res = await request(spec.method, spec.url, spec.headers, spec.body);
  if (res.status === 0) return { ok: false, status: 0, error: res.error, results: [] };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, results: [] };
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
    sourceUrl: spec.url,
    extra: Object.assign({
      connector: name,
      subject: query,
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
  stripAuth, AUTH_HEADERS, MAX_REDIRECTS,
  CONNECTORS, VERSION, EVIDENCE, CAPTURES, LEDGER,
  loadEnv, mask, request, runConnector,
};
