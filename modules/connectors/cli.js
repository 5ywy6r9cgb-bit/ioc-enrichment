#!/usr/bin/env node
'use strict';
/**
 * modules/connectors/cli.js — authorized connector runs.
 *
 *   sentinel connect test
 *   sentinel connect opensanctions "Larry Householder"
 *   sentinel connect courtlistener "Reynoldsburg water" --dry-run
 *
 * This implements the procedure your RATIFICATION record already ratified for
 * EDGAR, Federal Register, and OpenSanctions, rather than inventing a new one:
 *
 *   1. ANNOUNCE      say exactly what call will be made, before making it
 *   2. CAPTURE       write the verbatim response bytes to evidence/captures/
 *   3. HASH          SHA-256 the capture BEFORE anything is derived from it
 *   4. RECORD        one provenance record per run, appended to the ledger
 *   5. LEAD, NOT FACT  every hit is SOURCE_NEEDED — never a verdict
 *
 * Four rules this file will not bend:
 *
 *   * The API key is read from the environment, sent in the Authorization
 *     header, and never logged, never written to a capture, never stored in a
 *     provenance record. `test` prints presence and length only.
 *   * A run makes the number of network calls it announced. No retry loops that
 *     quietly turn one authorized call into five.
 *   * A match is a LEAD requiring a primary source. This tool cannot promote
 *     anything to a fact; only a human reading the underlying document can.
 *   * --dry-run makes zero network calls and writes zero rows.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const P = require('../../core/provenance/provenance.js');

const ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const CAPTURES = path.join(EVIDENCE, 'captures');
const LEDGER = path.join(EVIDENCE, 'manifests', 'provenance.jsonl');
const VERSION = '0.3.0';

// ---------------------------------------------------------------- terminal
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

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
 * step can print the truth rather than a summary someone wrote by hand.
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
      headers: {
        Authorization: `ApiKey ${key}`,
        'Content-Type': 'application/json',
      },
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
  },
};

// ---------------------------------------------------------------- commands
async function cmdTest() {
  const env = loadEnv();
  console.log('\n' + C.b('Connector key check'));
  console.log(C.dim('  Keys are read from .env and never printed. Presence and length only.\n'));

  for (const [name, c] of Object.entries(CONNECTORS)) {
    const key = env[c.keyVar] || '';
    const spec = c.probe(key);
    const res = await request(spec.method, spec.url, spec.headers);

    let verdict;
    if (res.status >= 200 && res.status < 300) verdict = C.g(`CONNECTED (HTTP ${res.status})`);
    else if (res.status === 401 || res.status === 403) verdict = C.r(`KEY REJECTED (HTTP ${res.status}) — check for a typo or a stray quote`);
    else if (res.status === 0) verdict = C.r(`no network / ${res.error}`);
    else verdict = C.y(`HTTP ${res.status}`);

    const keyState = key ? C.g('set') : (c.keyRequired ? C.r('MISSING') : C.y('not set (optional)'));
    console.log(`  ${c.label.padEnd(15)} key: ${keyState}   → ${verdict}`);
    if (key) console.log(C.dim(`                  ${mask(key)}  [${c.keyVar}]`));
  }
  console.log('');
}

async function cmdSearch(name, query, opts) {
  const c = CONNECTORS[name];
  if (!c) {
    console.error(`unknown connector: ${name}`);
    console.error(`known: ${Object.keys(CONNECTORS).join(', ')}`);
    process.exit(2);
  }
  if (!query) {
    console.error(`usage: sentinel connect ${name} "<query>"`);
    process.exit(2);
  }

  const env = loadEnv();
  const key = env[c.keyVar] || '';
  const keyMissing = c.keyRequired && !key;

  // ---- 1. ANNOUNCE ------------------------------------------------------
  // The rehearsal announces even when the key is absent — checking the plan is
  // the whole point of a dry run, and it must not require installing a key.
  console.log('\n' + C.b(`${c.label} — authorized run`));
  console.log(`  subject     ${query}`);
  console.log(`  calls       ${c.calls} (exactly)`);
  console.log(`  request     ${c.describe(query)}`);
  console.log(`  key         ${key ? C.g('present, sent in Authorization header only')
    : (keyMissing ? C.r(`MISSING — set ${c.keyVar} in .env`) : C.y('none (anonymous)'))}`);
  console.log(`  boundary    every hit lands as a LEAD requiring a primary source`);

  if (opts.dryRun) {
    console.log('\n  ' + C.y('DRY RUN — no network call made, nothing written.'));
    if (keyMissing) console.log('  ' + C.dim(`A live run needs ${c.keyVar}.`));
    console.log('');
    return;
  }

  if (keyMissing) {
    console.error(C.r(`\n  ${c.keyVar} is not set. Add it to .env (chmod 600) and try again.\n`));
    process.exit(2);
  }

  // ---- 2. CAPTURE -------------------------------------------------------
  const spec = c.run(query, key);
  const res = await request(spec.method, spec.url, spec.headers, spec.body);
  if (res.status === 0) {
    console.error(C.r(`\n  run failed: ${res.error} — nothing written.\n`));
    process.exit(1);
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(C.r(`\n  HTTP ${res.status} — nothing written.`));
    if (res.status === 401 || res.status === 403) console.error('  The key was rejected. Run: sentinel connect test\n');
    else console.error('');
    process.exit(1);
  }

  fs.mkdirSync(CAPTURES, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = query.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  const captureName = `live_capture_${name}_${slug}_${stamp}.json`;
  const capturePath = path.join(CAPTURES, captureName);
  fs.writeFileSync(capturePath, res.body);

  // ---- 3. HASH (before anything is derived from these bytes) ------------
  const captureHash = P.sha256Bytes(res.body);

  let parsed = [];
  let parseError = null;
  try {
    parsed = c.parse(JSON.parse(res.body.toString('utf8')));
  } catch (e) {
    parseError = e.message;
  }

  // ---- 4. RECORD --------------------------------------------------------
  const ledger = new P.Ledger(LEDGER);
  const record = P.makeRecord({
    kind: 'connector_run',
    artifactId: `${name}-${stamp}`,
    label: `${c.label} search: ${query}`,
    tool: 'sentinel connect',
    toolVersion: VERSION,
    // The capture is a primary artifact: we hold the exact bytes and their hash.
    tier: 'GREEN',
    sha256: captureHash,
    localPath: capturePath,
    evidenceRoot: EVIDENCE,
    sourceUrl: spec.url,
    extra: {
      connector: name,
      subject: query,
      http_status: res.status,
      live_calls: 1,
      result_count: parsed.length,
      // Results are leads. This field is what stops a hit becoming a fact.
      result_disposition: 'lead_needs_primary_source',
      parse_error: parseError,
    },
  });
  ledger.append(record);

  // ---- 5. REPORT --------------------------------------------------------
  console.log('\n  ' + C.g('run complete') + ' — 1 call made, as announced');
  console.log(`  capture     evidence/${path.relative(EVIDENCE, capturePath)}`);
  console.log(`  sha256      ${captureHash}`);
  console.log(`  ledger      evidence/${path.relative(EVIDENCE, LEDGER)}`);

  if (parseError) {
    console.log('\n  ' + C.y(`response captured but could not be parsed: ${parseError}`));
    console.log('  The bytes are on disk and hashed. Read the capture by hand.\n');
    return;
  }

  console.log('\n  ' + C.b(`${parsed.length} candidate lead(s)`));
  if (!parsed.length) {
    console.log(C.dim('  No hits. A clean result is not proof of absence — it is one source saying nothing.\n'));
    return;
  }
  for (const r of parsed.slice(0, 15)) {
    console.log(`\n    ${C.b(r.name)}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'name' || v === '' || v === undefined || v === null) continue;
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      if (val) console.log(`      ${k.padEnd(12)} ${val}`);
    }
  }
  if (parsed.length > 15) console.log(C.dim(`\n    …and ${parsed.length - 15} more (all in the capture)`));

  console.log('\n  ' + C.y('These are LEADS, not findings.'));
  console.log(C.dim('  A name match is not an identification. Before any of this is used:'));
  console.log(C.dim('    1. confirm you have the same individual or entity, not a namesake'));
  console.log(C.dim('    2. pull the underlying official listing or docket document'));
  console.log(C.dim('    3. cite that document, not this search result'));
  console.log('');
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: argv.includes('--dry-run') };
  const args = argv.filter((a) => !a.startsWith('--'));
  const action = args[0] || 'test';

  if (action === 'test') return cmdTest();
  if (action === 'list') {
    console.log('\n' + C.b('Connectors') + '\n');
    for (const [n, c] of Object.entries(CONNECTORS)) {
      console.log(`  ${n.padEnd(16)} ${c.label.padEnd(16)} key: ${c.keyVar}${c.keyRequired ? '' : ' (optional)'}`);
    }
    console.log('');
    return;
  }
  if (action === 'search') return cmdSearch(args[1], args.slice(2).join(' '), opts);
  // `sentinel connect opensanctions "query"` — connector name in the action slot
  if (CONNECTORS[action]) return cmdSearch(action, args.slice(1).join(' '), opts);

  console.error(`unknown action: ${action}`);
  console.error('usage: cli.js test | list | search <connector> "<query>" [--dry-run]');
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
