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
function request(method, url, headers, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, error: 'bad url' }); }
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timed out' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
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
  const key = c.keyVar ? (env[c.keyVar] || '') : '';
  if (c.keyRequired && !key) {
    return { ok: false, error: `${c.keyVar} is not set`, keyMissing: true, results: [] };
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
  CONNECTORS, VERSION, EVIDENCE, CAPTURES, LEDGER,
  loadEnv, mask, request, runConnector,
};
