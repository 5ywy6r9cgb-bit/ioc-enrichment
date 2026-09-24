#!/usr/bin/env node
'use strict';
/**
 * modules/command/server.js — SentinelOS Command. One screen over the whole desk.
 *
 *   sentinel command              start it and open the browser
 *   sentinel command --port 8790  a different port
 *   sentinel command --no-open    start it, do not open a browser
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 * A front door, not a second system. Every number on every screen is produced
 * by the module that already owns it:
 *
 *   Today          scripts/today.py --json         (the losable-first order)
 *   Requests       foia_store + foia_tracker        (the clock and the rungs)
 *   Outbox         outbox.js                        (the signature gate)
 *   Cases          research-desk/case.py compute()  (the publish gate)
 *   Claims         ~/SentinelDesk/sentinel.db       (read-only)
 *   Library        evidence/manifests/provenance.jsonl + its verify()
 *
 * Nothing is re-implemented here, because a rule that exists twice drifts,
 * and the copy that drifts is always the one on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT CAN CHANGE — THREE THINGS, ALL IN THE OUTBOX
 *
 *   approve     only if the text you read is still the text on disk
 *   reject      only with a reason
 *   reconcile   only with a written basis
 *
 * It cannot SEND. Sending is irreversible and goes to a public office over
 * your name, so it stays a terminal command (`sentinel pra mail send`) that a
 * person types. A browser tab that can send mail is one stray click, or one
 * malicious page, away from doing it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A WEBSITE YOU VISIT CANNOT DRIVE THIS
 *
 * A server on 127.0.0.1 is reachable from every page open in your browser.
 * Three things stop another site from using it:
 *
 *   1. It binds to loopback only, and refuses any other address.
 *   2. The Host header must name this machine and this port. That defeats DNS
 *      rebinding, where evil.example is made to resolve to 127.0.0.1.
 *   3. Every change needs a token minted when the server starts and written
 *      only into the page it serves. Another origin cannot read that page,
 *      so it cannot learn the token; and a custom header cannot be sent
 *      cross-origin without a preflight this server never approves.
 *
 * Nothing here loads from the internet: no fonts, no scripts, no maps. A
 * Content-Security-Policy says so, and the test suite checks it.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(__dirname, 'app');
const PRA = path.join(ROOT, 'modules', 'pra', 'server');

const { FoiaStore } = require(path.join(PRA, 'foia_store.js'));
const T = require(path.join(PRA, 'foia_tracker.js'));
const { Outbox, OutboxError, bodyHash } = require(path.join(PRA, 'outbox.js'));
const P = require(path.join(ROOT, 'core', 'provenance', 'provenance.js'));

const VERSION = '0.1.0';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

function evidenceDir() {
  return process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
}

/** The same normalisation scripts/foia.js applies. The test suite checks
 *  that this server's triage equals `foia.js --json` on the same store. */
function normalise(r) {
  return Object.assign({}, r, {
    request_id: r.request_id || r.id,
    agency_name: r.agency_name || r.agency,
    submitted_on: r.submitted_on || r.filed_date || r.filed_on,
    status: (r.status || 'submitted').toLowerCase(),
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ────────────────────────────────────────────────────────── subprocesses
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: ROOT, timeout: opts.timeout || 30000, maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function runJson(cmd, args) {
  const r = await run(cmd, args);
  if (r.err && r.err.code === 'ENOENT') {
    throw new HttpError(503, `${cmd} is not installed on this machine`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new HttpError(502, `${path.basename(args[0] || cmd)} did not return JSON`
      + (r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''));
  }
}

const bridge = (...args) => runJson('python3', [path.join(__dirname, 'bridge.py'), ...args]);

// ────────────────────────────────────────────────────────── the data
function requestsReport(opts = {}) {
  const store = new FoiaStore(process.env.PRA_FOIA_STORE || null);
  const raw = store.list();
  const report = T.triage(raw.map(normalise), opts);
  report.store = store.file;
  report.store_exists = fs.existsSync(store.file);
  return report;
}

function requestDetail(id) {
  const store = new FoiaStore(process.env.PRA_FOIA_STORE || null);
  const rec = store.find(id);
  if (!rec) throw new HttpError(404, `no request ${id}`);
  const r = normalise(rec);
  const evaluation = T.evaluate(r, {});
  const letter = T.draftFollowup(evaluation, r, {
    name: process.env.PRA_MAIL_FROM_NAME || process.env.PRA_OPERATOR_NAME || r.requester || 'Requester',
  });
  const messages = new Outbox().list({ request_id: id }).map(outboxView);
  return { request: rec, evaluation, draft: letter || null, messages };
}

function outboxView(m) {
  const ob = new Outbox();
  const gate = ob.sendable(m);
  return Object.assign({}, m, {
    current_hash: bodyHash(m),
    sendable: gate.ok, gate_reason: gate.ok ? null : gate.reason,
  });
}

function outboxReport() {
  const ob = new Outbox();
  const all = ob.list().map(outboxView);
  const by = (s) => all.filter((m) => m.state === s);
  return {
    file: ob.file,
    // Unresolved first, always: the only state where the desk does not know
    // whether a letter already reached an agency.
    unresolved: all.filter((m) => m.state === 'unknown' || m.state === 'in_flight'),
    drafted: by('drafted'),
    approved: by('approved'),
    history: all.filter((m) => ['sent', 'failed', 'rejected'].includes(m.state))
      .sort((a, b) => String(b.sent_at || b.queued_at).localeCompare(String(a.sent_at || a.queued_at)))
      .slice(0, 50),
    counts: all.reduce((acc, m) => { acc[m.state] = (acc[m.state] || 0) + 1; return acc; }, {}),
  };
}

let ledgerCache = { key: null, rows: [], verify: null };
function ledger() {
  const file = path.join(evidenceDir(), 'manifests', 'provenance.jsonl');
  let st = null;
  try { st = fs.statSync(file); } catch { return { file, exists: false, rows: [], verify: null }; }
  const key = `${st.size}:${st.mtimeMs}`;
  if (ledgerCache.key !== key) {
    const L = new P.Ledger(file);
    let rows = [];
    let parseError = null;
    try { rows = L.readAll(); } catch (e) { parseError = e.message; }
    let verify = null;
    try { verify = L.verify(); } catch (e) { verify = { ok: false, error: e.message }; }
    ledgerCache = { key, rows, verify, parseError };
  }
  return { file, exists: true, rows: ledgerCache.rows, verify: ledgerCache.verify,
    parseError: ledgerCache.parseError };
}

function libraryReport(q, connector, limit = 200) {
  const L = ledger();
  const needle = (q || '').toLowerCase().trim();
  const rows = L.rows.map((r) => ({
    artifact_id: r.artifact_id, kind: r.kind, label: r.label, tier: r.tier,
    recorded_at: r.recorded_at, sha256: r.sha256 || null, local_path: r.local_path || null,
    source_url: r.source_url || null,
    connector: (r.extra && r.extra.connector) || null,
    subject: (r.extra && r.extra.subject) || null,
    investigation: (r.extra && r.extra.investigation) || null,
    results: r.extra && typeof r.extra.result_count === 'number' ? r.extra.result_count : null,
  }));
  const counts = {};
  for (const r of rows) {
    const k = r.connector || r.kind || 'other';
    counts[k] = (counts[k] || 0) + 1;
  }
  let hits = rows;
  if (connector) hits = hits.filter((r) => r.connector === connector);
  if (needle) {
    hits = hits.filter((r) => [r.label, r.subject, r.connector, r.artifact_id, r.investigation, r.source_url]
      .some((v) => v && String(v).toLowerCase().includes(needle)));
  }
  hits = hits.slice().sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
  return {
    file: L.file, exists: L.exists, total: rows.length, matched: hits.length,
    by_connector: counts, verify: L.verify, parse_error: L.parseError || null,
    rows: hits.slice(0, limit),
    note: 'Every connector hit is REPORTED until you have read the filing itself. '
      + 'A capture proves what an API returned, not that it is true.',
  };
}

async function searchAll(q) {
  const needle = String(q || '').toLowerCase().trim();
  if (needle.length < 2) return { q, groups: [] };
  const has = (...vals) => vals.some((v) => v && String(v).toLowerCase().includes(needle));
  const groups = [];

  try {
    const rep = requestsReport();
    const reqs = rep.all.filter((e) => has(e.request_id, e.agency, e.label, e.status));
    if (reqs.length) {
      groups.push({ kind: 'request', label: 'Records requests',
        items: reqs.slice(0, 20).map((e) => ({ id: e.request_id, title: e.request_id,
          detail: `${e.agency || ''} — ${e.label}`, route: `#/requests/${encodeURIComponent(e.request_id)}` })) });
    }
  } catch { /* a broken store must not break search */ }

  try {
    const ob = new Outbox().list().filter((m) => has(m.message_id, m.request_id, m.subject, m.to, m.agency));
    if (ob.length) {
      groups.push({ kind: 'letter', label: 'Letters', items: ob.slice(0, 20).map((m) => ({
        id: m.message_id, title: m.subject, detail: `${m.state} → ${m.to}`, route: '#/outbox' })) });
    }
  } catch { /* ditto */ }

  try {
    const cases = await bridge('cases');
    const hit = (cases.cases || []).filter((c) => has(c.id, c.subject));
    if (hit.length) {
      groups.push({ kind: 'case', label: 'Cases', items: hit.slice(0, 20).map((c) => ({
        id: c.id, title: c.id, detail: c.subject,
        route: `#/cases/${encodeURIComponent(c.id)}` })) });
    }
  } catch { /* ditto */ }

  const lib = libraryReport(needle, null, 20);
  if (lib.rows.length) {
    groups.push({ kind: 'capture', label: 'Library', items: lib.rows.map((r) => ({
      id: r.artifact_id, title: r.label || r.artifact_id,
      detail: `${r.connector || r.kind} · ${String(r.recorded_at || '').slice(0, 10)}`,
      route: `#/library?q=${encodeURIComponent(needle)}` })) });
  }
  return { q, groups };
}

function systemReport(port) {
  const ev = evidenceDir();
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const age = (p) => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 86400000; } catch { return null; } };
  const foia = new FoiaStore(process.env.PRA_FOIA_STORE || null).file;
  const ob = new Outbox().file;
  const casesDir = process.env.SENTINEL_CASES || path.join(ev, 'sentinel_cases');
  const sdesk = path.join(process.env.SENTINEL_ROOT || path.join(require('os').homedir(), 'SentinelDesk'), 'sentinel.db');
  const ledgerFile = path.join(ev, 'manifests', 'provenance.jsonl');
  return {
    version: VERSION, node: process.version, root: ROOT, port,
    stores: [
      { name: 'Evidence store', path: ev, exists: exists(ev) },
      { name: 'Records requests', path: foia, exists: exists(foia) },
      { name: 'Outbox', path: ob, exists: exists(ob) },
      { name: 'Case files', path: casesDir, exists: exists(casesDir) },
      { name: 'Claim layer', path: sdesk, exists: exists(sdesk) },
      { name: 'Provenance ledger', path: ledgerFile, exists: exists(ledgerFile) },
    ],
    backup_age_days: age(path.join(ev, '.last_backup')),
    can: ['read every store above', 'approve a letter (the text you read, only)',
      'reject a letter (with a reason)', 'reconcile an unknown send (with a basis)'],
    cannot: ['send mail — that is `sentinel pra mail send`, typed by you',
      'edit a case, a claim or a citation', 'reach the internet',
      'be reached from another machine'],
    not_built: ['Link Matrix (graph)', 'Chronology (timeline)', 'Publication Station',
      'FollowTheMoney entity layer'],
  };
}

// ────────────────────────────────────────────────────────── http plumbing
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, `invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing to bind ${host}: the command center serves this machine only`);
  }
  const token = opts.token || crypto.randomBytes(24).toString('hex');
  const operator = process.env.PRA_OPERATOR_NAME || process.env.PRA_MAIL_FROM_NAME || 'operator';
  let port = opts.port || 8790;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) {
        throw new HttpError(421, 'wrong Host — this server answers only to 127.0.0.1 and localhost');
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && p === '/') {
        const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
          .replace('%%TOKEN%%', token).replace('%%VERSION%%', VERSION);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(APP, file), 'utf8'), type);
      }

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, 'cross-origin request refused');
        if (!safeEqual(req.headers['x-sentinel-token'], token)) {
          throw new HttpError(403, 'missing or wrong token — reload the page');
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'send JSON');
        }
      }

      // ---- reads
      if (req.method === 'GET') {
        if (p === '/api/health') return send(res, 200, { ok: true, version: VERSION, operator });
        if (p === '/api/today') return send(res, 200, await runJson('python3', [path.join(ROOT, 'scripts', 'today.py'), '--json']));
        if (p === '/api/requests') return send(res, 200, requestsReport());
        let m = /^\/api\/requests\/([^/]+)$/.exec(p);
        if (m) return send(res, 200, requestDetail(decodeURIComponent(m[1])));
        if (p === '/api/outbox') return send(res, 200, outboxReport());
        if (p === '/api/cases') return send(res, 200, await bridge('cases'));
        m = /^\/api\/cases\/([^/]+)$/.exec(p);
        if (m) {
          const d = await bridge('case', decodeURIComponent(m[1]));
          if (d.error) throw new HttpError(404, d.error);
          return send(res, 200, d);
        }
        if (p === '/api/claims') return send(res, 200, await bridge('claims'));
        if (p === '/api/library') {
          return send(res, 200, libraryReport(url.searchParams.get('q'), url.searchParams.get('connector'),
            Math.min(Number(url.searchParams.get('limit')) || 200, 1000)));
        }
        if (p === '/api/search') return send(res, 200, await searchAll(url.searchParams.get('q')));
        if (p === '/api/system') return send(res, 200, systemReport(port));
      }

      // ---- the three changes it can make
      if (req.method === 'POST') {
        const m = /^\/api\/outbox\/([^/]+)\/(approve|reject|reconcile)$/.exec(p);
        if (m) {
          const id = decodeURIComponent(m[1]);
          const body = await readJson(req);
          const ob = new Outbox();
          try {
            let msg;
            if (m[2] === 'approve') {
              if (!body.hash) throw new HttpError(400, 'approve needs the hash of the text you read');
              msg = ob.approve(id, operator, String(body.hash));
            } else if (m[2] === 'reject') {
              msg = ob.reject(id, String(body.reason || '').trim());
            } else {
              msg = ob.reconcile(id, String(body.outcome || ''), String(body.basis || ''));
            }
            return send(res, 200, outboxView(msg));
          } catch (e) {
            if (e instanceof OutboxError) throw new HttpError(409, e.message);
            throw e;
          }
        }
      }

      throw new HttpError(404, `no such route: ${req.method} ${p}`);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) process.stderr.write(`  [command] ${req.method} ${req.url} → ${e.stack || e.message}\n`);
      send(res, status, { error: e.message });
    }
  });

  return {
    server, token,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { port = server.address().port; resolve(port); });
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
    get port() { return port; },
  };
}

// ────────────────────────────────────────────────────────── main
if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const app = createServer({ port: Number(val('port', 8790)) });
  app.listen().then((port) => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  \x1b[1mSENTINEL COMMAND\x1b[0m   ${url}`);
    console.log('  \x1b[2mThis machine only. It can read everything and approve, reject or');
    console.log('  reconcile a letter. It cannot send one: that stays `sentinel pra mail send`.');
    console.log('  Ctrl-C to stop.\x1b[0m\n');
    if (!argv.includes('--no-open') && process.platform === 'darwin') {
      execFile('open', [url], () => {});
    }
  }).catch((e) => {
    console.error(`\n  ${e.code === 'EADDRINUSE' ? `port is in use — try: sentinel command --port ${Number(val('port', 8790)) + 1}` : e.message}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, normalise, VERSION, CSP };
