#!/usr/bin/env node
/**
 * test_capture_integrity.js -- what counts as a capture, and what identifies one.
 * No network: runConnector takes an injected requester.
 *
 *  A7  two different calls that return the same bytes share a body hash;
 *      they must not share a capture ID.
 *  A4  an HTML page is not a result, even under HTTP 200.
 */
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('./registry.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cap-'));
const dirs = { evidenceRoot: tmp, captureDir: path.join(tmp, 'captures'), ledgerPath: path.join(tmp, 'ledger.jsonl') };
const json = (b) => async () => ({ status: 200, headers: {}, body: Buffer.from(b) });
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}: ${e.message}`); }
}

(async () => {
  await t('same empty body, two different queries: same hash, different capture_id', async () => {
    const a = await R.runConnector('federalregister', 'alpha one', Object.assign({ env: {}, requester: json('{"results":[]}') }, dirs));
    const b = await R.runConnector('federalregister', 'beta two', Object.assign({ env: {}, requester: json('{"results":[]}') }, dirs));
    assert.ok(a.ok && b.ok, 'both calls should succeed');
    assert.strictEqual(a.captureHash, b.captureHash);
    assert.ok(/^[0-9a-f]{64}$/.test(a.captureId));
    assert.notStrictEqual(a.captureId, b.captureId);
  });
  await t('capture_id and captured_at are written to the ledger line', async () => {
    const lines = fs.readFileSync(dirs.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = lines[lines.length - 1];
    const flat = JSON.stringify(rec);
    assert.ok(/capture_id/.test(flat) && /captured_at/.test(flat));
  });
  await t('HTTP 200 with an HTML body is a failure, not a capture', async () => {
    const before = fs.readdirSync(dirs.captureDir).length;
    const r = await R.runConnector('federalregister', 'gamma three', Object.assign({ env: {},
      requester: json('<link rel="search" type="application/opensearchdescription+xml"><html>throttled</html>') }, dirs));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.htmlBody, true);
    assert.strictEqual(fs.readdirSync(dirs.captureDir).length, before, 'nothing may be written');
  });
  await t('fedregtext is text/plain by design and is not rejected for starting with <', async () => {
    const r = await R.runConnector('fedregtext', 'https://www.federalregister.gov/documents/full_text/text/2023/11/06/x.txt',
      Object.assign({ env: {}, requester: json('<P>Privacy Act notice</P>') }, dirs));
    assert.ok(r.ok, r.error);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
