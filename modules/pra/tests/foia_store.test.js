'use strict';
/**
 * tests/foia_store.test.js
 *
 * The store is the part an operator touches at 11pm, which makes its failure
 * modes the expensive kind: a silently reset file, a duplicate id that
 * overwrites a live clock, a status typo that quietly parks a request in a
 * state the ladder ignores. Each of those is a test here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const { FoiaStore, StoreError } = require('../server/foia_store.js');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foia-store-'));
  return new FoiaStore(path.join(dir, 'foia_requests.json'));
}

module.exports = function run() {
  H.suite('foia_store');

  // ── a machine that has never run this before ────────────────────────
  {
    const S = tmpStore();
    H.eq('a missing store reads as empty, not as an error', S.list().length, 0);
    const rec = S.add({ request_id: 'A-1', agency_name: 'City of Gahanna' });
    H.eq('add creates the file and the record', S.list().length, 1);
    H.eq('status defaults to submitted', rec.status, 'submitted');
    H.eq('jurisdiction defaults to OH', rec.jurisdiction_scope, 'OH');
    H.check('the file is written owner-only',
      (fs.statSync(S.file).mode & 0o077) === 0, (fs.statSync(S.file).mode & 0o777).toString(8));
  }

  // ── a corrupt store is never silently replaced ──────────────────────
  {
    const S = tmpStore();
    fs.mkdirSync(path.dirname(S.file), { recursive: true });
    fs.writeFileSync(S.file, '{ this is not json');
    const before = fs.readFileSync(S.file, 'utf8');
    H.throws('unparseable JSON refuses to load', () => S.list(), 'not valid JSON');
    H.eq('and the file is left exactly as it was',
      fs.readFileSync(S.file, 'utf8'), before);
  }

  // ── the bare-array shape the old foia_requests.json used still reads ─
  {
    const S = tmpStore();
    fs.mkdirSync(path.dirname(S.file), { recursive: true });
    fs.writeFileSync(S.file, JSON.stringify([
      { id: 'PRR-2026-391', agency: 'City of Gahanna', filed_date: '2026-06-23' },
    ]));
    H.eq('a legacy bare array loads without migration', S.list().length, 1);
  }

  // ── duplicate ids ───────────────────────────────────────────────────
  {
    const S = tmpStore();
    S.add({ request_id: 'A-1', agency_name: 'Agency One' });
    H.throws('a duplicate id is refused, not merged',
      () => S.add({ request_id: 'A-1', agency_name: 'Agency Two' }), 'already exists');
    H.eq('and the original survives untouched', S.find('A-1').agency_name, 'Agency One');
  }

  // ── validation at the door ──────────────────────────────────────────
  {
    const S = tmpStore();
    H.throws('a request with no id is refused',
      () => S.add({ agency_name: 'X' }), 'request_id is required');
    H.throws('a request with no agency is refused',
      () => S.add({ request_id: 'B-1' }), 'agency_name is required');
    H.throws('a malformed date is refused at entry',
      () => S.add({ request_id: 'B-1', agency_name: 'X', submitted_on: '6/23/26' }),
      'YYYY-MM-DD');
    H.throws('an invented status is refused',
      () => S.add({ request_id: 'B-1', agency_name: 'X', status: 'pending' }),
      'unknown status');
  }

  // ── field changes are recorded, not just applied ────────────────────
  {
    const S = tmpStore();
    S.add({ request_id: 'C-1', agency_name: 'City of Gahanna', status: 'submitted' });
    const { change } = S.set('C-1', 'status', 'denied');
    H.eq('the field is updated', S.find('C-1').status, 'denied');
    H.eq('the old value is preserved in history', change.from, 'submitted');
    H.eq('along with the new one', change.to, 'denied');
    H.check('and when it happened', /^\d{4}-\d{2}-\d{2}T/.test(change.at));
    H.eq('history has exactly one entry', S.find('C-1').history.length, 1);

    H.eq('a no-op set reports no change', S.set('C-1', 'status', 'denied').change, null);
    H.eq('and does not pad history with nothing',
      S.find('C-1').history.length, 1);

    H.throws('a field not on the settable list is refused',
      () => S.set('C-1', 'accrued_usd', '1000'), 'not settable');
    H.throws('an unknown status is refused on update too',
      () => S.set('C-1', 'status', 'ignored'), 'unknown status');
    H.throws('setting a field on a missing request is refused',
      () => S.set('NOPE', 'status', 'closed'), 'no request with id');
  }

  // ── delivery_method carries the damages predicate, so it is checked ──
  {
    const S = tmpStore();
    S.add({ request_id: 'D-1', agency_name: 'X' });
    H.throws('a misspelled delivery method is refused rather than stored',
      () => S.set('D-1', 'delivery_method', 'certified'), 'unknown delivery_method');
    H.check('and the refusal names which methods actually qualify',
      (() => { try { S.set('D-1', 'delivery_method', 'certified'); } catch (e) {
        return /149\.43\(C\)\(2\)/.test(e.message)
          && /hand_delivery, certified_mail, and electronic/.test(e.message); } })());
    S.set('D-1', 'delivery_method', 'web_form');
    H.eq('a non-qualifying but real method IS recordable',
      S.find('D-1').delivery_method, 'web_form');
  }

  // ── correspondence is append-only and is what dedupe reads ──────────
  {
    const S = tmpStore();
    S.add({ request_id: 'E-1', agency_name: 'X' });
    S.logCorrespondence('E-1', { direction: 'outbound', occurred_at: '2026-08-10', note: 'nudge' });
    S.logCorrespondence('E-1', { direction: 'inbound', occurred_at: '2026-08-12' });
    const c = S.find('E-1').correspondence;
    H.eq('both entries are kept', c.length, 2);
    H.eq('in the order they were logged', c[0].direction, 'outbound');
    H.check('each records when it was logged, separately from when it happened',
      c[0].occurred_at === '2026-08-10' && /^\d{4}-\d{2}-\d{2}T/.test(c[0].logged_at));
    H.check('there is no way to edit or delete a logged letter',
      typeof S.editCorrespondence === 'undefined'
      && typeof S.deleteCorrespondence === 'undefined');

    H.throws('a direction that is neither in nor out is refused',
      () => S.logCorrespondence('E-1', { direction: 'internal' }), "'inbound' or 'outbound'");
    H.throws('a malformed date is refused',
      () => S.logCorrespondence('E-1', { direction: 'outbound', occurred_at: 'yesterday' }),
      'YYYY-MM-DD');

    const today = new Date().toISOString().slice(0, 10);
    S.logCorrespondence('E-1', { direction: 'outbound' });
    H.eq('an omitted date means today', S.find('E-1').correspondence[2].occurred_at, today);
  }

  // ── the tracker can read what the store writes, unchanged ───────────
  {
    const T = require('../server/foia_tracker.js');
    const S = tmpStore();
    S.add({ request_id: 'F-1', agency_name: 'City of Gahanna', submitted_on: '2026-06-23' });
    const e = T.evaluate(S.find('F-1'), { today: new Date('2026-08-24T12:00:00Z') });
    H.eq('a stored request evaluates without translation', e.rung, 'no_response_escalate');

    S.logCorrespondence('F-1', { direction: 'outbound', occurred_at: '2026-08-21' });
    const after = T.evaluate(S.find('F-1'), { today: new Date('2026-08-24T12:00:00Z') });
    H.eq('and logging the letter is what quiets it', after.rung, 'awaiting_agency');
  }
};

if (require.main === module) { module.exports(); process.exit(H.report()); }
