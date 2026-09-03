'use strict';
/**
 * tests/foia_dashboard.test.js
 *
 * The risk in a dashboard is not that it looks wrong. It is that it looks
 * RIGHT while saying something false — a stale number under a confident
 * heading, an Ohio request marked overdue when no statute makes it so, or a
 * damages figure on a case nobody has filed. The screen is what gets believed
 * and what gets screenshotted, so these tests are mostly about what it is not
 * allowed to say.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const view = require('../server/foia_dashboard.js');
const tracker = require('../server/foia_tracker.js');
const dash = require('../scripts/foia_dash.js');
const { FoiaStore } = require('../server/foia_store.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

const TODAY = '2026-09-03';
const req = (o) => Object.assign({
  request_id: 'R-1', agency_name: 'Some Agency', status: 'submitted',
  jurisdiction_scope: 'OH', submitted_on: '2026-07-10',
  correspondence: [], history: [],
}, o);

function html(requests, opts) {
  return view.render(tracker.triage(requests, { today: TODAY }), opts || {});
}

module.exports = function run() {
  console.log('\n  foia dashboard\n');

  // ══ it must not claim to be live ══════════════════════════════════════
  //
  // The page it replaces was headed "Live view of your database" and was a
  // snapshot three weeks old. That single word is the whole defect: a reader
  // who believes it stops checking.
  //
  // Note the shape of this guard: the page DISCLAIMS being live ("a snapshot,
  // not a live view"), so a naive /live view/ match fires on the disclaimer
  // and the guard is red on a correct page. Match the AFFIRMATIVE claim — the
  // construction the old header actually used — not the words.
  {
    const h = html([req({})]);
    const header = h.split('<header>')[1].split('</header>')[0];
    check('the header makes no affirmative claim to be live',
      !/live view of/i.test(header) && !/\blive\b(?!.*\bnot\b)/i.test(
        header.replace(/snapshot, not a live view/i, '')),
      (header.match(/.{0,40}live.{0,40}/i) || [])[0]);
    check('it says it is a snapshot, and how to refresh',
      /snapshot, not a live view/i.test(h) && /sentinel foia dash/.test(h));
    check('and stamps when it was generated',
      /Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(h), h.match(/Generated[^<]*/));
  }

  // ══ the Ohio clock is not a statutory deadline ════════════════════════
  //
  // The predecessor Python agent asserted a 10-business-day R.C. 149.43
  // benchmark that does not exist, in letters sent to public offices. A
  // dashboard rendering "OVERDUE" makes the same false claim, silently.
  //
  // Same shape problem as above: the page EXPLAINS that nothing is overdue as
  // a matter of law, so a page-wide /overdue/ match fires on the explanation.
  // The defect would appear as a rendered LABEL on a request row, so look in
  // the tables — where a verdict about a specific request actually lives.
  {
    const h = html([req({ submitted_on: '2026-01-05' })]);   // ~6 months silent
    const tables = (h.match(/<table[\s\S]*?<\/table>/g) || []).join('');
    check('no request ROW is ever labelled overdue',
      !/overdue/i.test(tables), (tables.match(/.{0,40}overdue.{0,40}/i) || [])[0]);
    // \b matters: without it, "late" matches inside "escaLATE the channel" and
    // this guard fails on a page that is entirely correct.
    const badPill = /<span class="pill[^"]*">[^<]*\b(overdue|late|past due|violation)\b[^<]*<\/span>/i;
    check('and no pill anywhere asserts a missed deadline',
      !badPill.test(h), (h.match(badPill) || [])[0]);
    check('the page carries the tracker\'s clock note verbatim',
      h.includes('follow-up cadence') && /R\.C\. 149\.43 sets no fixed day count/.test(h));
    check('and states that reasonableness is fact-specific',
      /reasonable period of time/.test(h) && /fact-specific/.test(h));
    check('federal FOIA is still identified as statutory',
      /20-business-day determination period is statutory/.test(h));
  }

  // ══ a denial outranks a long silence ══════════════════════════════════
  //
  // Ordering IS the product here. Sorting by elapsed days would put a
  // six-month silence above a two-day denial, and the denial is the one where
  // something can actually be done today.
  {
    const h = html([
      req({ request_id: 'OLD', submitted_on: '2026-01-05' }),
      req({ request_id: 'DENIED', submitted_on: '2026-08-25', status: 'denied' }),
    ]);
    const iDenied = h.indexOf('DENIED');
    const iOld = h.indexOf('OLD');
    check('the denial is rendered above the older silent request',
      iDenied > 0 && iOld > 0 && iDenied < iOld, `denied@${iDenied} old@${iOld}`);
  }

  // ══ damages are not "days times a hundred" ════════════════════════════
  {
    const h = html([req({ status: 'denied', submitted_on: '2026-01-05' })]);
    check('no dollar figure is rendered for a request with no mandamus filed',
      !/\$\d/.test(h), (h.match(/.{0,50}\$\d.{0,30}/) || [])[0]);
    check('and R.C. 149.43(C)(2) predicates are explained where damages appear',
      !/Statutory damages posture/.test(h)
      || /mandamus action has been commenced/.test(h));
  }

  // ══ an empty desk says it is empty, not that it is clear ══════════════
  //
  // "0 tracked" and "0 needing attention" render identically as a calm page.
  // One of them means the desk is under control and the other means nothing
  // was ever recorded.
  {
    const h = html([]);
    check('an empty store says no requests are recorded',
      /No requests recorded yet/.test(h));
    check('and shows the command that adds one',
      /foia add REQ-001/.test(h));
    const busy = html([req({})]);
    check('a store with everything inside cadence says THAT instead',
      /Nothing needs you right now/.test(busy) || /Needs you now/.test(busy));
  }

  // ══ operator text is escaped ══════════════════════════════════════════
  //
  // Agency names and subjects are typed by a person and can contain anything.
  // A page written to disk and opened from file:// executing injected markup
  // is a real problem, not a theoretical one.
  {
    const h = html([req({ agency_name: '<img src=x onerror=alert(1)>Bad & Co' })]);
    check('markup in an agency name is escaped',
      !/<img src=x/.test(h) && /&lt;img src=x/.test(h));
    check('and ampersands survive as text',
      /Bad &amp; Co/.test(h));
    check('esc() handles null without printing "null"',
      view.esc(null) === '' && view.esc(undefined) === '');
  }

  // ══ the page phones nobody ════════════════════════════════════════════
  //
  // It names the agencies being pressed and what is being looked for, and it
  // opens from file:// on a machine that may be offline.
  {
    const h = html([req({})]);
    check('no <script> tag', !/<script/i.test(h));
    check('no external stylesheet, font, or image',
      !/(src|href)="https?:/i.test(h),
      (h.match(/(src|href)="https?:[^"]*/i) || [])[0]);
  }

  // ══ the screen and the terminal read the same store ═══════════════════
  //
  // The whole reason this file exists rather than a second Postgres query.
  // If these two normalisers drift, one surface gets a clock and the other
  // does not, and the quiet one reports "nothing needs you".
  {
    const cliSrc = fs.readFileSync(require.resolve('../scripts/foia.js'), 'utf8');
    const dashSrc = fs.readFileSync(require.resolve('../scripts/foia_dash.js'), 'utf8');
    const fields = ['request_id', 'agency_name', 'submitted_on', 'filed_on', 'filed_date'];
    const inBoth = fields.every((f) => cliSrc.includes(f) && dashSrc.includes(f));
    check('the dashboard normaliser reads the same alternate field names as the CLI',
      inBoth, 'a field name diverged — a request would load with no clock');

    // And prove it end to end, through the real store.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foiadash-'));
    const file = path.join(dir, 'store.json');
    const store = new FoiaStore(file);
    store.add({ request_id: 'E2E-1', agency_name: 'Gahanna', submitted_on: '2026-07-10' });
    store.add({ request_id: 'E2E-2', agency_name: 'Sheriff', submitted_on: '2026-08-20' });
    store.set('E2E-2', 'status', 'denied');

    const prev = process.env.PRA_FOIA_STORE;
    process.env.PRA_FOIA_STORE = file;
    const out = path.join(dir, 'out.html');
    let built = '';
    try {
      dash.main(['--out', out]);
      built = fs.readFileSync(out, 'utf8');
    } finally {
      if (prev === undefined) delete process.env.PRA_FOIA_STORE;
      else process.env.PRA_FOIA_STORE = prev;
    }
    check('a real store round-trips into a rendered page',
      built.includes('E2E-1') && built.includes('E2E-2') && built.includes('Gahanna'));
    check('and the denial is picked up from the store, not the seed defaults',
      /DENIAL/.test(built));
    check('both requests are counted as tracked',
      /<div class="num">2<\/div>\s*<div class="lbl">Requests tracked/.test(built),
      (built.match(/<div class="num">\d+<\/div>\s*<div class="lbl">Requests tracked/) || [])[0]);
  }

  // ══ the page is not committed ═════════════════════════════════════════
  //
  // It lists which agencies the operator is pressing. The predecessor lived at
  // app/dashboard.html and WAS committed; it only looked harmless because it
  // happened to hold seed data.
  {
    const src = fs.readFileSync(require.resolve('../scripts/foia_dash.js'), 'utf8');
    check('the default output path is inside the gitignored evidence tree',
      /'evidence', 'foia_dashboard\.html'/.test(src));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
