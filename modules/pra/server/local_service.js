'use strict';
/**
 * server/local_service.js — the localhost-only bridge.
 *
 * The browser desk cannot open a Postgres socket, so this sits between them.
 * It is deliberately small and deliberately boxed in:
 *
 *   * BINDS TO 127.0.0.1 ONLY. Not 0.0.0.0. It is not on your network, so it
 *     does not have to be defended from your network. Binding elsewhere is
 *     refused outright rather than warned about.
 *   * NO CORS BY DEFAULT beyond the configured local origins. No wildcard.
 *   * READ-MOSTLY. The write endpoints it does expose are the ones the desk
 *     genuinely needs; there is no generic "run SQL" route.
 *   * EVERY RESPONSE IS METADATA. No endpoint returns file bytes or document
 *     text, because no such column exists to return.
 *
 * If the database is down, /health says so and the desk degrades. A desk that
 * shows stale numbers is worse than one that admits it cannot see.
 */

const http = require('http');
const { URL } = require('url');
const { Db, loadEnv } = require('./db.js');
const { MetadataRepository } = require('./metadata_repository.js');
const clock = require('./deadline_engine.js');
const drafter = require('./request_drafter.js');
const exportLedger = require('./export_ledger.js');
const audit = require('./audit_ledger.js');

const LOCAL_BIND = new Set(['127.0.0.1', 'localhost', '::1']);

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // The desk is a local file; it must not be framed or sniffed.
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function createService(options = {}) {
  const env = options.env || loadEnv();
  const host = options.host || env.PRA_SERVICE_HOST || '127.0.0.1';
  const port = Number(options.port || env.PRA_SERVICE_PORT || 4317);

  if (!LOCAL_BIND.has(host)) {
    throw new Error(
      `local_service: refusing to bind to ${host}. This service is loopback-only by design.\n`
      + '  It exposes an investigative case store; putting it on a network interface\n'
      + '  turns a local desk into a target. Set PRA_SERVICE_HOST=127.0.0.1.'
    );
  }

  const allowedOrigins = String(env.PRA_ALLOWED_ORIGINS || 'null')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const db = options.db || new Db();
  const repo = options.repo || new MetadataRepository(db);

  function applyOrigin(req, res) {
    const origin = req.headers.origin;
    // A desk opened as file:// sends Origin: null. No wildcard, ever.
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (!origin && allowedOrigins.includes('null')) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  const server = http.createServer(async (req, res) => {
    applyOrigin(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let url;
    try { url = new URL(req.url, `http://${host}:${port}`); }
    catch { return jsonResponse(res, 400, { ok: false, error: 'bad url' }); }
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---------------------------------------------------------- health
      if (p === '/health') {
        const available = await db.isAvailable();
        return jsonResponse(res, 200, {
          ok: true,
          db_available: available,
          database: available ? db.config.database : null,
          host: db.config.host,
          error: available ? null : db.lastError(),
          service: 'sentinel-pra',
          bound: `${host}:${port}`,
        });
      }

      // The rest all need the database.
      if (!(await db.isAvailable())) {
        return jsonResponse(res, 503, {
          ok: false, db_available: false, error: db.lastError(),
          hint: 'Postgres is not reachable. The desk should fall back to session/JSON behavior.',
        });
      }

      // ------------------------------------------------------- dashboard
      if (p === '/dashboard') {
        const [counts, attention] = await Promise.all([
          repo.dashboardCounts(),
          repo.needsAttention(),
        ]);
        return jsonResponse(res, 200, { ok: true, counts, needs_attention: attention });
      }

      // ----------------------------------------------------------- clock
      if (p === '/clock') {
        const [requests, rules] = await Promise.all([
          repo.listRequests({}), repo.listDeadlineRules(),
        ]);
        return jsonResponse(res, 200, { ok: true, triage: clock.triage(requests, rules) });
      }

      // -------------------------------------------------------- requests
      if (p === '/requests' && req.method === 'GET') {
        return jsonResponse(res, 200, {
          ok: true,
          requests: await repo.listRequests({ status: url.searchParams.get('status') || null }),
        });
      }
      if (p === '/requests' && req.method === 'POST') {
        const body = await readBody(req);
        return jsonResponse(res, 201, { ok: true, request: await repo.createRequest(body) });
      }
      if (/^\/requests\/[^/]+$/.test(p) && req.method === 'GET') {
        const id = decodeURIComponent(p.split('/')[2]);
        const r = await repo.getRequest(id);
        if (!r) return jsonResponse(res, 404, { ok: false, error: 'no such request' });
        const records = await repo.listReceivedRecords(id);
        return jsonResponse(res, 200, { ok: true, request: r, records });
      }
      if (/^\/requests\/[^/]+\/status$/.test(p) && req.method === 'POST') {
        const id = decodeURIComponent(p.split('/')[2]);
        const body = await readBody(req);
        return jsonResponse(res, 200, {
          ok: true,
          request: await repo.setRequestStatus(id, body.status, { note: body.note || null }),
        });
      }

      // ------------------------------------------------- received records
      if (p === '/received_records' && req.method === 'POST') {
        const body = await readBody(req);
        return jsonResponse(res, 201, { ok: true, record: await repo.addReceivedRecord(body) });
      }

      // ----------------------------------------------------------- draft
      if (p === '/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const [tpl] = (await repo.listTemplates()).filter((t) => t.template_id === body.template_id);
        if (!tpl) return jsonResponse(res, 404, { ok: false, error: `no such template: ${body.template_id}` });
        const request = body.request_id ? await repo.getRequest(body.request_id) : (body.request || {});
        if (body.request_id && !request) return jsonResponse(res, 404, { ok: false, error: 'no such request' });
        const agency = request && request.agency_id
          ? (await db.query('SELECT * FROM agencies WHERE agency_id = $1', [request.agency_id])).rows[0] || {}
          : {};
        const recordType = request && request.record_type_id
          ? (await db.query('SELECT * FROM record_types WHERE record_type_id = $1', [request.record_type_id])).rows[0] || null
          : null;
        const out = drafter.draft(tpl, {
          agency, request, recordType,
          operator: { name: env.PRA_OPERATOR_NAME || '', contact: env.PRA_OPERATOR_CONTACT || '' },
          extra: body.extra || {},
        });
        return jsonResponse(res, 200, { ok: true, draft: out });
      }

      // ---------------------------------------------------------- export
      if (p === '/export') {
        // Read REAL state first, then ledger it. The row describes these bytes.
        const requests = await repo.getAllRequestsWithRecords();
        const payload = {
          kind: 'sentinel_pra_export',
          version: '0.7',
          exported_at: new Date().toISOString(),
          exported_metadata_only: true,
          requests,
        };
        const row = await exportLedger.recordExport(db, payload, {
          scopeLabel: 'all requests with received-record metadata',
          suggestedFilename: `sentinel_pra_export_${new Date().toISOString().slice(0, 10)}.json`,
          recommendedFolder: 'Sentinel_Public_Records_Atlas/Exports/',
          note: 'via local_service /export',
        });
        return jsonResponse(res, 200, { ok: true, ledger: row, payload });
      }

      // ----------------------------------------------------------- audit
      if (p === '/audit') {
        return jsonResponse(res, 200, { ok: true, recent: await audit.recent(db, 50) });
      }

      // ------------------------------------------------------- reference
      if (p === '/agencies') {
        return jsonResponse(res, 200, {
          ok: true,
          agencies: await repo.listAgencies({
            search: url.searchParams.get('q') || null,
            jurisdiction: url.searchParams.get('jurisdiction') || null,
          }),
        });
      }
      if (p === '/templates') {
        return jsonResponse(res, 200, { ok: true, templates: await repo.listTemplates(url.searchParams.get('kind')) });
      }
      if (p === '/rules') {
        return jsonResponse(res, 200, { ok: true, rules: await repo.listDeadlineRules() });
      }

      return jsonResponse(res, 404, {
        ok: false,
        error: `no such endpoint: ${p}`,
        endpoints: ['/health', '/dashboard', '/clock', '/requests', '/requests/:id',
                    '/requests/:id/status', '/received_records', '/draft', '/export',
                    '/audit', '/agencies', '/templates', '/rules'],
      });
    } catch (err) {
      // Never leak a stack to the browser; the operator reads the terminal.
      process.stderr.write(`  [service] ${req.method} ${p} → ${err.stack || err.message}\n`);
      return jsonResponse(res, 500, { ok: false, error: err.message });
    }
  });

  return { server, db, repo, host, port };
}

module.exports = { createService, LOCAL_BIND };
