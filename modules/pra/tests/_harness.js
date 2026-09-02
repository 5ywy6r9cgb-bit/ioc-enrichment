'use strict';
/**
 * tests/_harness.js — a test runner small enough to read in one sitting.
 *
 * No dependencies on purpose. The whole point of this suite is that it runs on
 * a fresh machine with nothing installed and no database, so a failure means
 * the code is wrong rather than the environment.
 */

const state = { suite: null, passed: 0, failed: 0, failures: [] };

function suite(name) {
  state.suite = name;
  console.log(`\n  ${name}`);
}

function check(label, cond, detail) {
  if (cond) {
    state.passed += 1;
    console.log(`    PASS  ${label}`);
  } else {
    state.failed += 1;
    state.failures.push({ suite: state.suite, label, detail });
    console.log(`    FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
  return cond;
}

function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(label, ok, ok ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Assert fn throws, and that the message contains `needle`. */
function throws(label, fn, needle) {
  let threw = false;
  let msg = '';
  try { fn(); } catch (e) { threw = true; msg = e.message; }
  const ok = threw && (!needle || msg.includes(needle));
  return check(label, ok, ok ? null : (threw ? `threw "${msg}", wanted "${needle}"` : 'did not throw'));
}

async function throwsAsync(label, fn, needle) {
  let threw = false;
  let msg = '';
  try { await fn(); } catch (e) { threw = true; msg = e.message; }
  const ok = threw && (!needle || msg.includes(needle));
  return check(label, ok, ok ? null : (threw ? `threw "${msg}", wanted "${needle}"` : 'did not throw'));
}

function report() {
  const total = state.passed + state.failed;
  console.log('');
  if (state.failed) {
    console.log(`  FAIL — ${state.failed} of ${total} checks failed`);
    for (const f of state.failures) console.log(`    ${f.suite}: ${f.label}`);
  } else {
    console.log(`  PASS — ${total}/${total} checks`);
  }
  return state.failed;
}

module.exports = { suite, check, eq, throws, throwsAsync, report, state };
