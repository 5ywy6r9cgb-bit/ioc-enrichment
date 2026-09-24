'use strict';
/**
 * modules/command/fixture.js — a throwaway desk, built through each module's
 * own API, so the command center can be tested and looked at without touching
 * the real evidence store.
 *
 *   node modules/command/fixture.js /tmp/desk     build it and print the env
 *
 * Every record here is invented for the test. None of it is a real request,
 * a real letter, or a real case.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PRA = path.join(ROOT, 'modules', 'pra', 'server');

const LETTER = 'To the Records Custodian:\n\nThis follows up on the public records request '
  + 'referenced above, submitted under R.C. 149.43. Please provide a status update, the '
  + 'records produced so far, or the specific exemption relied on for any withholding.\n\nThank you,';

function envFor(dir) {
  return {
    SENTINEL_EVIDENCE_DIR: dir,
    PRA_FOIA_STORE: path.join(dir, 'foia_requests.json'),
    PRA_OUTBOX: path.join(dir, 'outbox.json'),
    SENTINEL_CASES: path.join(dir, 'sentinel_cases'),
    SENTINEL_ROOT: path.join(dir, 'SentinelDesk'),
    PRA_OPERATOR_NAME: 'Test Operator',
  };
}

function build(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const env = envFor(dir);
  Object.assign(process.env, env);

  // Fresh requires so the env above is what they read.
  const { FoiaStore } = require(path.join(PRA, 'foia_store.js'));
  const { Outbox } = require(path.join(PRA, 'outbox.js'));
  const P = require(path.join(ROOT, 'core', 'provenance', 'provenance.js'));

  const store = new FoiaStore(env.PRA_FOIA_STORE);
  store.add({ request_id: 'TEST-ALPR-001', agency_name: 'Example City Police',
    submitted_on: '2026-07-20', delivery_method: 'electronic', contact: 'records@example-city.test' });
  store.add({ request_id: 'TEST-DRONE-002', agency_name: 'Example Township',
    submitted_on: '2026-09-18', status: 'acknowledged' });
  store.add({ request_id: 'TEST-PUCO-003', agency_name: 'Example Utilities Commission',
    submitted_on: '2026-08-10', status: 'denied' });
  store.add({ request_id: 'TEST-NODATE-004', agency_name: 'Example County Auditor' });
  store.logCorrespondence('TEST-ALPR-001', { direction: 'outbound', occurred_at: '2026-07-20',
    channel: 'email', note: 'original request' });

  const ob = new Outbox(env.PRA_OUTBOX);
  const a = ob.queue({ request_id: 'TEST-ALPR-001', to: 'records@example-city.test',
    subject: 'Follow-up: public records request TEST-ALPR-001', body: LETTER, agency: 'Example City Police' });
  const b = ob.queue({ request_id: 'TEST-DRONE-002', to: 'clerk@example-township.test',
    subject: 'Follow-up: public records request TEST-DRONE-002', body: LETTER, agency: 'Example Township' });
  ob.approve(b.message_id, 'Test Operator');
  ob.claim(b.message_id);
  ob.markUnknown(b.message_id, 'the transport failed after the connection was open (ECONNRESET): '
    + 'socket hang up. Whether the server had already accepted the message cannot be determined from here.');

  const casePy = path.join(ROOT, 'modules', 'research-desk', 'case.py');
  const pyEnv = Object.assign({}, process.env, env);
  const c = (...args) => execFileSync('python3', [casePy, ...args], { env: pyEnv, stdio: 'pipe' });
  c('new', 'test-alpr', 'Example: licence plate reader procurement across three cities');
  c('add', 'test-alpr', 'EX-1', 'records/contract.pdf', '--kind', 'financial', '--pages', '44');
  c('add', 'test-alpr', 'EX-2', 'records/council-minutes.pdf', '--pages', '6');
  c('read', 'test-alpr', 'EX-1', '31');
  c('read', 'test-alpr', 'EX-2', '6');
  c('ask', 'test-alpr', 'Who signed the renewal?');
  c('conflict', 'test-alpr', 'Contract says 24 cameras; minutes say 18');
  c('new', 'test-clear', 'Example: a finished, fully read case');
  c('add', 'test-clear', 'EX-1', 'records/filing.pdf', '--kind', 'financial', '--pages', '3');
  c('read', 'test-clear', 'EX-1', '3');

  const ledger = new P.Ledger(path.join(dir, 'manifests', 'provenance.jsonl'));
  const caps = path.join(dir, 'captures');
  fs.mkdirSync(caps, { recursive: true });
  [['senatelda', 'Example Surveillance Co'], ['fec', 'Example PAC'], ['courtlistener', 'Example v. City']]
    .forEach(([conn, subject], i) => {
      const f = path.join(caps, `live_capture_${conn}_${subject.replace(/\W+/g, '_')}_2026-09-0${i + 1}.json`);
      fs.writeFileSync(f, JSON.stringify({ results: [] }));
      ledger.append(P.makeRecord({
        kind: 'connector_run', artifactId: `${conn}-${i}`, label: `${conn} search: ${subject}`,
        tool: 'sentinel connect', tier: 'GREEN', sha256: P.sha256Bytes(fs.readFileSync(f)),
        localPath: f, evidenceRoot: dir, sourceUrl: `https://api.example.test/${conn}`,
        extra: { connector: conn, subject, investigation: i === 0 ? 'test-alpr' : null },
      }));
    });
  return env;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || fs.mkdtempSync('/tmp/sentinel-desk-'));
  const env = build(dir);
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}="${v}"`);
}

module.exports = { build, envFor };
