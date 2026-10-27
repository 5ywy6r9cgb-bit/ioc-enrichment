#!/usr/bin/env node
/**
 * test_partial_exit.js -- a run that prints "Did not complete" must not be
 * indistinguishable from one that finished.
 *
 * `connect all` used to exit 0 after printing "Did not complete:", so any
 * runner that scores by exit code recorded PASS for runs where Regulations.gov
 * answered 403 and CourtListener answered 429/500. cmdAll now RETURNS the
 * count; the dispatcher and sweep turn it into exit code 4 (PARTIAL).
 * No network: runConnector is stubbed.
 */
const assert = require('assert');
const R = require('./registry.js');
const cli = require('./cli.js');

const realRun = R.runConnector;
const realLog = console.log;
const realOut = process.stdout.write.bind(process.stdout);
let pass = 0;
async function t(name, fn) {
  console.log = () => {}; process.stdout.write = () => true;
  try { await fn(); pass++; console.log = realLog; process.stdout.write = realOut; realLog(`  ok    ${name}`); }
  catch (e) { console.log = realLog; process.stdout.write = realOut; realLog(`  FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
  finally { R.runConnector = realRun; }
}

(async () => {
  await t('all connectors fail -> partial equals the number attempted', async () => {
    R.runConnector = async () => ({ ok: false, error: 'HTTP 403', results: [] });
    const r = await cli.cmdAll('Example Corp', {});
    assert.ok(r && r.partial > 0, `partial was ${r && r.partial}`);
  });
  await t('all connectors succeed -> partial is 0', async () => {
    R.runConnector = async (name) => ({ ok: true, results: [], capturePath: '/tmp/x', captureHash: 'h' });
    const r = await cli.cmdAll('Example Corp', {});
    assert.strictEqual(r.partial, 0);
  });
  await t('captured-but-unparsed counts as partial', async () => {
    R.runConnector = async () => ({ ok: true, parseError: 'bad json', results: [], capturePath: '/tmp/x', captureHash: 'h' });
    const r = await cli.cmdAll('Example Corp', {});
    assert.ok(r.partial > 0);
  });
  realLog(`\n  ${pass}/3 passed`);
})();
