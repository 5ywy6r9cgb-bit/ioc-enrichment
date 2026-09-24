#!/usr/bin/env node
'use strict';
/**
 * test_command.js — Sentinel Command, end to end, against a throwaway desk.
 *
 *   node modules/command/test_command.js
 *
 * No network beyond 127.0.0.1, no browser, nothing installed. Builds a desk
 * in a temp directory through each module's own API (fixture.js), starts the
 * real server on a free port, and asks it questions over HTTP.
 *
 * What it is mostly checking is what the screen must NOT be able to do.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-command-test-'));
const fixture = require('./fixture.js');
const ENV = fixture.build(DIR);            // sets process.env for everything below

const { createServer, normalise } = require('./server.js');
const { Outbox, bodyHash } = require('../pra/server/outbox.js');
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0; let failed = 0; const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`    PASS  ${label}`); }
  else { failed++; failures.push(label); console.log(`    FAIL  ${label}${detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
function suite(name) { console.log(`\n  ${name}`); }

function req(port, method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ Host: host || `127.0.0.1:${port}` },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) },
    (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n  Sentinel Command');

  // ════════════════════════════════════════════════════ it serves this machine only
  suite('it serves this machine only');
  let threw = null;
  try { createServer({ host: '0.0.0.0' }); } catch (e) { threw = e.message; }
  check('binding 0.0.0.0 is refused outright', threw && /refusing to bind/.test(threw), threw);
  threw = null;
  try { createServer({ host: '192.168.1.10' }); } catch (e) { threw = e.message; }
  check('so is a LAN address', !!threw);

  const app = createServer({ port: 0 });
  const port = await app.listen();
  const T = app.token;
  const H = (extra = {}) => Object.assign({ 'X-Sentinel-Token': T }, extra);

  let r = await req(port, 'GET', '/api/health', { host: 'evil.example' });
  check('a request naming another Host is refused (DNS rebinding)', r.status === 421, r.status);
  r = await req(port, 'GET', '/api/health', { host: `evil.example:${port}` });
  check('even with the right port on it', r.status === 421, r.status);
  r = await req(port, 'GET', '/api/health', { host: `localhost:${port}` });
  check('localhost is accepted', r.status === 200, r.status);

  // ════════════════════════════════════════════════════ the page
  suite('the page loads nothing from outside this machine');
  r = await req(port, 'GET', '/');
  check('the page is served', r.status === 200 && /Sentinel Command/.test(r.text));
  check('with a Content-Security-Policy', /default-src 'none'/.test(r.headers['content-security-policy'] || ''));
  check('that forbids other origins for scripts', /script-src 'self'/.test(r.headers['content-security-policy'] || ''));
  check('and cannot be framed', r.headers['x-frame-options'] === 'DENY');
  check('the per-launch token is written into the page', r.text.includes(T));
  check('and the placeholder is gone', !r.text.includes('%%TOKEN%%'));

  const appFiles = ['index.html', 'app.js', 'app.css'].map((f) => [f, fs.readFileSync(path.join(__dirname, 'app', f), 'utf8')]);
  for (const [f, text] of appFiles) {
    check(`${f} references no external URL`, !/\bhttps?:\/\/(?!127\.0\.0\.1)/i.test(text),
      (text.match(/https?:\/\/[^\s'"`)]+/i) || [])[0]);
    check(`${f} has no inline style attribute (the CSP would block it)`, !/\sstyle="/.test(text));
  }
  const html = appFiles[0][1];
  check('index.html has no inline script', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
  check('index.html loads no font or stylesheet from a font host', !/fonts\.(googleapis|gstatic)|typekit|use\.fontawesome/.test(html));

  r = await req(port, 'GET', '/../server.js');
  check('a path outside app/ is not served', r.status === 404, r.status);
  r = await req(port, 'GET', '/app.js/../../server.js');
  check('nor through a dot-dot dance', r.status === 404, r.status);
  r = await req(port, 'GET', '/fixture.js');
  check('nor any file that is not on the allow-list', r.status === 404, r.status);

  // ════════════════════════════════════════════════════ what it cannot do
  suite('what it cannot do');
  const ob = new Outbox();
  const drafted = ob.list({ state: 'drafted' })[0];
  const unknown = ob.list({ state: 'unknown' })[0];

  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/send`, { body: {}, headers: H() });
  check('there is no send route', r.status === 404, r.status);
  check('and no route of any kind names sending',
    !/\/send\b|sendApproved|sendMail|smtpTransport/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')));

  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: { hash: bodyHash(drafted) } });
  check('a change without the token is refused', r.status === 403, r.status);
  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: { hash: bodyHash(drafted) }, headers: { 'X-Sentinel-Token': 'x'.repeat(48) } });
  check('a change with the wrong token is refused', r.status === 403, r.status);
  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: { hash: bodyHash(drafted) }, headers: H({ Origin: 'https://evil.example' }) });
  check('a change from another origin is refused, even with the token', r.status === 403, r.status);
  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: 'hash=x', headers: H({ 'Content-Type': 'application/x-www-form-urlencoded' }) });
  check('a form post (the shape a hostile page can send) is refused', r.status === 415 || r.status === 403, r.status);
  check('after all of that the letter is still unapproved', new Outbox().get(drafted.message_id).state === 'drafted');

  // ════════════════════════════════════════════════════ approve binds to what was read
  suite('approval is bound to the text that was read');
  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: {}, headers: H() });
  check('approve without a hash is refused', r.status === 400, r.status);

  const staleHash = bodyHash(drafted);
  const data = JSON.parse(fs.readFileSync(ENV.PRA_OUTBOX, 'utf8'));
  data.messages.find((m) => m.message_id === drafted.message_id).body += '\n\nP.S. re-drafted by the desk';
  fs.writeFileSync(ENV.PRA_OUTBOX, JSON.stringify(data, null, 2));

  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: { hash: staleHash }, headers: H() });
  check('approving text that changed after it was read is refused', r.status === 409, r.status);
  check('and says so', /changed after you read it/.test((r.json || {}).error || ''), r.json);
  check('the letter stays unapproved', new Outbox().get(drafted.message_id).state === 'drafted');

  const fresh = new Outbox().get(drafted.message_id);
  r = await req(port, 'POST', `/api/outbox/${drafted.message_id}/approve`, { body: { hash: bodyHash(fresh) }, headers: H() });
  check('approving the text as it now stands works', r.status === 200 && r.json.state === 'approved', r.json);
  check('signed by the configured operator', new Outbox().get(drafted.message_id).approved_by === 'Test Operator');
  check('and the signature is the hash of that text', new Outbox().get(drafted.message_id).approved_hash === bodyHash(fresh));

  // ════════════════════════════════════════════════════ reject + reconcile
  suite('reject and reconcile carry their reasons');
  const other = new Outbox().queue({ request_id: 'TEST-NODATE-004', to: 'auditor@example-county.test',
    subject: 'Request', body: 'To the Records Custodian:\n\nPlease provide the parcel records described above.\n\nThank you,' });
  r = await req(port, 'POST', `/api/outbox/${other.message_id}/reject`, { body: { reason: '' }, headers: H() });
  check('a rejection with no reason is refused', r.status === 409, r.status);
  r = await req(port, 'POST', `/api/outbox/${other.message_id}/reject`, { body: { reason: 'wrong custodian — this is a county recorder record' }, headers: H() });
  check('with a reason it is rejected and kept', r.status === 200 && r.json.state === 'rejected', r.json);

  r = await req(port, 'POST', `/api/outbox/${unknown.message_id}/reconcile`, { body: { outcome: 'sent', basis: 'ok' }, headers: H() });
  check('reconciling on a token basis is refused', r.status === 409 && /requires a basis/.test(r.json.error), r.json);
  r = await req(port, 'POST', `/api/outbox/${unknown.message_id}/reconcile`, { body: { outcome: 'maybe', basis: 'checked the sent folder at 14:02' }, headers: H() });
  check('an outcome other than sent or failed is refused', r.status === 409, r.status);
  r = await req(port, 'POST', `/api/outbox/${unknown.message_id}/reconcile`, { body: { outcome: 'sent', basis: 'sent folder of records@ shows it at 14:02, no bounce' }, headers: H() });
  check('a real basis resolves it', r.status === 200 && r.json.state === 'sent', r.json);
  check('and the basis is kept', /14:02, no bounce/.test(new Outbox().get(unknown.message_id).reconciled_basis));

  // ════════════════════════════════════════════════════ one rule, not two
  suite('every number comes from the module that owns it');
  r = await req(port, 'GET', '/api/requests');
  const cli = JSON.parse(execFileSync('node', [path.join(ROOT, 'modules/pra/scripts/foia.js'), '--json'], { env: process.env }).toString());
  const strip = (x) => JSON.stringify(Object.assign({}, x, { run_at: null, store: null, store_exists: null }));
  check('the requests screen is exactly `sentinel pra foia --json`', strip(r.json) === strip(cli));
  check('four requests, two needing attention', r.json.total === 4 && r.json.needs_attention === 2, [r.json.total, r.json.needs_attention]);
  check('the denial sorts first', r.json.items[0].request_id === 'TEST-PUCO-003', r.json.items[0].request_id);
  check('normalise() maps the legacy field names', normalise({ id: 'A', agency: 'B', filed_date: '2026-01-02' }).submitted_on === '2026-01-02');

  r = await req(port, 'GET', '/api/requests/TEST-ALPR-001');
  check('one request carries its evaluation', r.status === 200 && r.json.evaluation.request_id === 'TEST-ALPR-001');
  check('and a drafted follow-up that is marked as not sent', typeof r.json.draft === 'string' && r.json.draft.length > 40);
  r = await req(port, 'GET', '/api/requests/NOPE');
  check('an unknown request is a 404, not a crash', r.status === 404, r.status);

  r = await req(port, 'GET', '/api/cases');
  const byId = Object.fromEntries((r.json.cases || []).map((c) => [c.id, c]));
  check('cases come back with case.py\'s gate', r.status === 200 && r.json.total === 2, r.json);
  check('the fully-read case is publishable', byId['test-clear'] && byId['test-clear'].publishable === true);
  check('the open one is blocked', byId['test-alpr'] && byId['test-alpr'].publishable === false);
  check('by R-01, R-03 and R-04 exactly',
    JSON.stringify((byId['test-alpr'] || {}).blockers.map((b) => b[0]).filter((x) => x !== '--')) === '["R-01","R-03","R-04"]',
    (byId['test-alpr'] || {}).blockers);
  check('blocked cases sort first', r.json.cases[0].id === 'test-alpr');
  // The terminal and the screen must give the same verdict for BOTH cases.
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const status = (id) => plain(execFileSync('python3',
    [path.join(ROOT, 'modules/research-desk/case.py'), 'status', id], { env: process.env }).toString());
  check('`sentinel case status` also says test-alpr is BLOCKED', /\bBLOCKED\b/.test(status('test-alpr')));
  check('and test-clear PUBLISHABLE', /\bPUBLISHABLE\b/.test(status('test-clear')));

  r = await req(port, 'GET', '/api/cases/nope');
  check('an unknown case is a 404 with the reason', r.status === 404 && /no case/.test(r.json.error), r.json);

  r = await req(port, 'GET', '/api/claims');
  check('a missing claim layer is reported, not faked', r.status === 200 && r.json.exists === false, r.json);

  r = await req(port, 'GET', '/api/today');
  check('Today returns the five sections of `sentinel today`', r.status === 200 && r.json.sections.length === 5, r.json && r.json.sections && r.json.sections.length);
  const clocks = (r.json.sections || []).find((s) => s.key === 'clocks') || {};
  check('and CLOCKS reads the real records store', /4 request\(s\) tracked, 2 need you/.test(clocks.text || ''), clocks.text);
  check('a backup that never happened is the first thing it asks for', /back up/.test((r.json.next || [])[0] || ''), r.json.next);

  // ════════════════════════════════════════════════════ library + ledger
  suite('the library shows what the ledger holds, and whether it was altered');
  r = await req(port, 'GET', '/api/library');
  check('three captures from three connectors', r.json.total === 3 && Object.keys(r.json.by_connector).length === 3, r.json.by_connector);
  check('the chain verifies', r.json.verify && r.json.verify.ok === true, r.json.verify);
  check('every capture is labelled REPORTED-until-read in the note', /REPORTED/.test(r.json.note));
  r = await req(port, 'GET', '/api/library?q=surveillance');
  check('search narrows to the one that matches', r.json.matched === 1, r.json.matched);
  r = await req(port, 'GET', '/api/library?connector=fec');
  check('a connector filter narrows too', r.json.matched === 1 && r.json.rows[0].connector === 'fec');

  const ledgerFile = path.join(DIR, 'manifests', 'provenance.jsonl');
  const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n');
  lines[1] = lines[1].replace('Example PAC', 'Example PAC (edited)');
  fs.writeFileSync(ledgerFile, lines.join('\n'));
  r = await req(port, 'GET', '/api/library');
  check('an edited ledger line is caught', r.json.verify && r.json.verify.ok === false, r.json.verify);
  check('and named by line number', (r.json.verify.tampered || []).some((t) => t.line === 2), r.json.verify.tampered);

  // ════════════════════════════════════════════════════ search + system
  suite('one search box across the desk');
  r = await req(port, 'GET', '/api/search?q=alpr');
  const kinds = (r.json.groups || []).map((g) => g.kind).sort();
  check('it finds requests, letters and cases together',
    ['case', 'letter', 'request'].every((k) => kinds.includes(k)), kinds);
  r = await req(port, 'GET', '/api/search?q=a');
  check('a one-letter query returns nothing rather than everything', r.json.groups.length === 0);

  r = await req(port, 'GET', '/api/system');
  check('System lists what the screen cannot do', r.json.cannot.some((x) => /send mail/.test(x)));
  check('and every store with whether it exists', r.json.stores.length === 6 && r.json.stores.every((s) => typeof s.exists === 'boolean'));

  r = await req(port, 'GET', '/api/nope');
  check('an unknown route is a JSON 404', r.status === 404 && r.json && /no such route/.test(r.json.error));

  await app.close();
  fs.rmSync(DIR, { recursive: true, force: true });

  console.log('');
  const total = passed + failed;
  if (failed) {
    console.log(`  FAIL — ${failed} of ${total} checks failed`);
    failures.forEach((f) => console.log(`    ${f}`));
  } else {
    console.log(`  PASS — ${total}/${total} checks`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
