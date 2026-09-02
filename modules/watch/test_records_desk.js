'use strict';
/**
 * modules/watch/test_records_desk.js
 *
 * The overnight run is the one part of this system nobody watches while it
 * works. Everything here is about what happens when it goes wrong at 3am:
 * a missing store, a corrupt store, a tracker that moved. In every case the
 * run must survive, and it must never report a quiet morning it did not verify.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const D = require('./records_desk.js');
const { FoiaStore } = require('../pra/server/foia_store.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

const TODAY = new Date('2026-08-25T12:00:00Z');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-desk-'));
}

module.exports = function run() {
  console.log('\n  records desk (overnight stage)\n');

  // ── nothing tracked yet ─────────────────────────────────────────────
  {
    const dir = tmp();
    const r = D.run({ storePath: path.join(dir, 'none.json'), today: TODAY });
    check('a missing store is not an error — it is an empty desk', r.ok === true);
    check('and reports nothing needing attention', r.total === 0);
    check('with no notification, because there is nothing to say',
      D.notifyLine(r) === null);

    const brief = D.writeBrief(r, { path: path.join(dir, 'b.md'), today: TODAY });
    const text = fs.readFileSync(brief, 'utf8');
    check('the brief tells you how to start', /sentinel pra foia add/.test(text));
  }

  // ── a corrupt store must be LOUD, not quiet ─────────────────────────
  {
    const dir = tmp();
    const p = path.join(dir, 'corrupt.json');
    fs.writeFileSync(p, '{ this is not json');
    const r = D.run({ storePath: p, today: TODAY });
    check('a corrupt store fails the stage rather than reporting zero',
      r.ok === false && r.corrupt === true);
    check('the notification says the clocks were NOT checked',
      /FAILED/.test(D.notifyLine(r)) && /not checked/i.test(D.notifyLine(r)),
      D.notifyLine(r));

    const text = fs.readFileSync(
      D.writeBrief(r, { path: path.join(dir, 'b.md'), today: TODAY }), 'utf8');
    check('and the brief refuses to let you read it as good news',
      /No clocks were checked/.test(text), text.slice(0, 200));
    check('the failure reason is in the brief', /not valid JSON/.test(text));
  }

  // ── the ordinary morning ────────────────────────────────────────────
  {
    const dir = tmp();
    const p = path.join(dir, 'store.json');
    const S = new FoiaStore(p);
    S.add({ request_id: 'A-OVERDUE', agency_name: 'City of Gahanna',
            submitted_on: '2026-06-23' });
    S.add({ request_id: 'B-QUIET', agency_name: 'Columbus PD',
            submitted_on: '2026-08-24' });
    S.add({ request_id: 'C-DENIED', agency_name: 'Franklin County',
            submitted_on: '2026-07-01', status: 'denied',
            denial_basis: 'R.C. 149.43(A)(1)(h)' });

    const r = D.run({ storePath: p, today: TODAY });
    check('the desk runs', r.ok === true);
    check('all three are counted', r.total === 3);
    check('the one inside cadence is not in the action list', r.needs_attention === 2);
    check('the denial sorts first', r.items[0].request_id === 'C-DENIED');
    check('and is counted as needing a decision, not a letter', r.judgment === 1);

    // The content rule. This is the test that matters most in this file.
    const line = D.notifyLine(r);
    check('the notification carries the count', /2 records request/.test(line), line);
    check('and the request IDs', /C-DENIED/.test(line), line);
    check('but NEVER an agency name',
      !/Gahanna/.test(line) && !/Columbus/.test(line) && !/Franklin/.test(line), line);

    const brief = D.writeBrief(r, { path: path.join(dir, 'b.md'), today: TODAY });
    const text = fs.readFileSync(brief, 'utf8');
    check('the brief on disk MAY name the agency — it never leaves the machine',
      /Gahanna/.test(text));
    check('it states the deadline basis for each request',
      /operator_policy/.test(text));
    check('it never claims an Ohio statutory deadline',
      /no fixed day count/i.test(text) && !/statutory deadline/i.test(text));
    check('it gives the exact command to draft each one',
      /sentinel pra foia draft C-DENIED/.test(text));
    check('and the command to log the letter afterwards',
      /sentinel pra foia sent/.test(text));
    check('the brief is written owner-only',
      (fs.statSync(brief).mode & 0o077) === 0);
  }

  // ── a quiet morning is reported as quiet, and rings no doorbell ──────
  {
    const dir = tmp();
    const p = path.join(dir, 'store.json');
    const S = new FoiaStore(p);
    S.add({ request_id: 'A-1', agency_name: 'X', submitted_on: '2026-08-24' });
    const r = D.run({ storePath: p, today: TODAY });
    check('a request inside cadence needs nothing', r.needs_attention === 0);
    check('and rings no doorbell', D.notifyLine(r) === null);
    const text = fs.readFileSync(
      D.writeBrief(r, { path: path.join(dir, 'b.md'), today: TODAY }), 'utf8');
    check('the brief says so plainly', /Nothing needs you/.test(text));
  }

  // ── damages only appear when a mandamus is actually on file ──────────
  {
    const dir = tmp();
    const p = path.join(dir, 'store.json');
    const S = new FoiaStore(p);
    S.add({ request_id: 'A-1', agency_name: 'X', submitted_on: '2026-06-23' });
    let text = fs.readFileSync(
      D.writeBrief(D.run({ storePath: p, today: TODAY }),
        { path: path.join(dir, 'b.md'), today: TODAY }), 'utf8');
    check('an overdue request with no case mentions no damages',
      !/Damages accruing/.test(text));

    S.set('A-1', 'delivery_method', 'certified_mail');
    S.set('A-1', 'mandamus_filed_on', '2026-08-18');
    text = fs.readFileSync(
      D.writeBrief(D.run({ storePath: p, today: TODAY }),
        { path: path.join(dir, 'b.md'), today: TODAY }), 'utf8');
    check('with the predicates met, the brief reports accrual',
      /Damages accruing/.test(text), text.slice(0, 400));
    check('and refuses to call it a prediction of an award',
      /not a prediction of an award/i.test(text));
    check('naming the provision that lets a court deny them',
      /149\.43\(C\)\(2\)\(c\)/.test(text));
  }

  // ── the brief is current state, not an append-only log ──────────────
  {
    const dir = tmp();
    const b = path.join(dir, 'b.md');
    const p = path.join(dir, 'store.json');
    new FoiaStore(p).add({ request_id: 'A-1', agency_name: 'X', submitted_on: '2026-06-23' });
    D.writeBrief(D.run({ storePath: p, today: TODAY }), { path: b, today: TODAY });
    const first = fs.readFileSync(b, 'utf8');
    D.writeBrief(D.run({ storePath: p, today: TODAY }), { path: b, today: TODAY });
    const second = fs.readFileSync(b, 'utf8');
    check('re-running overwrites rather than appending', first === second);
  }

  // ══ the notification must survive a BUSY night ══════════════════════
  // Regression guard. The first real overnight run produced 289 hits across
  // 13 watches, the body came to 254 characters against a 240 cap, and
  // notify.js refused it — so a perfect run sent nothing. The busier the
  // night, the more certain the doorbell did not ring.
  {
    const notify = require('./notify.js');
    const { buildNotifyBody } = require('./run.js');

    const mkWatches = (n) => Array.from({ length: n }, (_, i) => ({
      watch: { id: `WATCH-SOMETHING-RATHER-LONG-${String(i).padStart(2, '0')}` },
      newHits: [1],
    }));

    // The exact shape that failed.
    const busy = buildNotifyBody(289, mkWatches(13), [],
      '1 records request(s) need you: PRR-2026-391');
    check('a busy night produces a body within the cap',
      busy.length <= notify.MAX_LEN, `${busy.length} chars: ${busy}`);
    check('and notify.js accepts it', notify.guard(busy).ok === true);
    check('it still reports the total', /289 new/.test(busy), busy);
    check('and the number of watches', /13 watch/.test(busy), busy);
    check('the records desk leads — a legal clock outranks a search result',
      busy.startsWith('1 records request'), busy);

    // A quiet night still names the watches, because it fits.
    const quiet = buildNotifyBody(2, mkWatches(1), [], null);
    check('a quiet night names the watch rather than counting',
      /WATCH-SOMETHING/.test(quiet), quiet);

    // Failures are never dropped, however busy it is.
    const withFail = buildNotifyBody(500, mkWatches(30), [{}, {}], null);
    check('failures survive truncation',
      /2 watch\(es\) FAILED/.test(withFail) && withFail.length <= notify.MAX_LEN,
      `${withFail.length}: ${withFail}`);

    // The absolute worst case still sends SOMETHING.
    const monstrous = buildNotifyBody(9999, mkWatches(200), [{}],
      'x'.repeat(300));
    check('an impossible body is trimmed, never refused outright',
      monstrous.length <= notify.MAX_LEN && monstrous.length > 0,
      String(monstrous.length));
    check('and it is still accepted by the guard',
      notify.guard(monstrous).ok === true);

    check('the cap is read from notify.js, not copied',
      require('fs').readFileSync(require.resolve('./run.js'), 'utf8')
        .includes('notify.MAX_LEN'));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) { process.exit(module.exports() ? 1 : 0); }
