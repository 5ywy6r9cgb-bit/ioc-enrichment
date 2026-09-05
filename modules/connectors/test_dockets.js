#!/usr/bin/env node
'use strict';
/**
 * test_dockets.js — when did a whole class of cases end?
 *
 * Built to answer whether the Comerica dismissal was one case or a
 * pattern. Every check names the false sentence it prevents.
 */

const fs = require('fs');
const D = require('./dockets.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  dockets.js — one case, or a pattern?\n');

  const rows = [
    { docket_id: 1, case_name: 'Consumer Financial Protection Bureau v. Comerica Bank',
      terminated: '2025-04-11', filed: '2024-12-06' },
    { docket_id: 2, case_name: 'Consumer Financial Protection Bureau v. Stratfs, LLC (f/k/a Strategic Financial Solutions, LLC)',
      terminated: '', filed: '2025-06-04' },
    { docket_id: 3, case_name: 'Consumer Financial Protection Bureau v. Stratfs, LLC',
      terminated: '2025-05-29', filed: '2025-05-29' },
    { docket_id: 4, case_name: 'Consumer Financial Protection Bureau v. Acima Holdings',
      terminated: '2025-03-07', filed: '2024-07-26' },
  ];

  // ══ 1. A NULL TERMINATION DATE IS NOT "STILL OPEN" ═══════════════════
  //
  // RECAP is assembled from what people upload. A docket nobody refreshed
  // after judgment carries a null forever. Folding those into "open" would
  // report cases as live years after they ended.
  {
    const r = D.byYear(rows);
    check('unknown terminations get their own bucket',
      r.unknown === 1 && r.terminated === 3 && r.total === 4, JSON.stringify(r));
    check('and are never counted into a year',
      r.years.reduce((n, y) => n + y.dockets, 0) === 3);
    check('years come back newest first',
      r.years[0].year === '2025' && r.years[0].dockets === 3, JSON.stringify(r.years));
    const src = fs.readFileSync(require.resolve('./dockets.js'), 'utf8');
    check('the reason is recorded in the source',
      /Null means UNKNOWN/.test(src));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('and the command says so where the number is printed',
      /a null termination date is NOT "still open"/.test(cli));
  }

  // ══ 2. A DOCKET IS NOT A CASE ════════════════════════════════════════
  //
  // Stratfs appears twice -- a district docket and a Second Circuit one.
  // Counting dockets over-counts actions, always.
  {
    const defs = D.defendants(rows);
    const stratfs = defs.find((d) => /Stratfs/i.test(d.defendant));
    check('two dockets for one defendant collapse to one defendant',
      !!stratfs && stratfs.dockets.length === 2, JSON.stringify(defs.map((d) => d.defendant)));
    check('and the "(f/k/a ...)" alias does not split them',
      defs.filter((d) => /Stratfs/i.test(d.defendant)).length === 1);
    check('three defendants across four dockets', defs.length === 3, String(defs.length));
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the command calls the docket count a CEILING on actions',
      /docket count is a CEILING on actions/.test(cli));
    check('and the defendant count a floor that merges separate suits',
      /defendant count is a floor/.test(cli));
  }

  // ══ 3. dateTerminated SAYS WHEN, NEVER HOW ═══════════════════════════
  //
  // Settled, dismissed by the court, won, and abandoned by the plaintiff
  // are four different stories. This field cannot tell them apart, and the
  // whole Comerica finding turns on WHICH one it was.
  {
    const hits = D.endedIn(rows, 2025);
    check('only the dockets from that year come back',
      hits.length === 3, JSON.stringify(hits.map((h) => h.terminated)));
    check('and they are in ascending date order',
      hits.map((h) => h.terminated).join(',') === '2025-03-07,2025-04-11,2025-05-29',
      hits.map((h) => h.terminated).join(','));
    check('a year with nothing in it returns empty, not everything',
      D.endedIn(rows, 2019).length === 0);
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the command refuses to let WHEN stand in for HOW',
      /SAYS WHEN, NEVER HOW/.test(cli));
    check('and names the four stories it cannot distinguish',
      /Settled, dismissed by the court, won, or abandoned/.test(cli));
    check('and hands over the command that answers HOW',
      /docket-entries\/\?docket=/.test(cli));
  }

  // ══ 4. A THROTTLED SWEEP IS PARTIAL, NOT COMPLETE ════════════════════
  //
  // CourtListener enforces its rate limit. A sweep that stops halfway
  // returns a list that looks exactly like a finished one.
  {
    const page = (n, count, next) => ({
      status: 200,
      body: Buffer.from(JSON.stringify({
        count,
        next,
        results: [{ docket_id: n, caseName: `X v. Y${n}`, dateFiled: '2025-01-01' }],
      })),
    });
    // A page that repeats a docket already seen. CourtListener's deep
    // paging really does this: a live sweep reported "260 docket(s) of
    // 203" at page 13 -- more rows than the source said existed, because
    // the pages overlap and nothing was deduping them.
    const repeatOf = (n, count, next) => page(n, count, next);

    const twoPages = [page(1, 2, 'more'), page(2, 2, null)];
    let i = 0;
    return Promise.resolve()
      .then(() => D.sweep('q', { intervalMs: 0, request: async () => twoPages[i++] }))
      .then((ok) => {
        check('a sweep that got everything is COMPLETE',
          ok.complete === true && ok.rows.length === 2, JSON.stringify(ok.rows.length));

        let j = 0;
        const throttled = [page(1, 50, 'more'), { status: 429, body: Buffer.from('') }];
        return D.sweep('q', { intervalMs: 0, request: async () => throttled[j++] });
      })
      .then((bad) => {
        check('a sweep stopped by a rate limit is NOT complete',
          bad.complete === false, JSON.stringify({ c: bad.complete, s: bad.stoppedBy }));
        check('and says what stopped it',
          /429/.test(bad.stoppedBy || ''), bad.stoppedBy);
        check('and keeps the rows it did get',
          bad.rows.length === 1);

        // A count that is a URL, not a number: Number(url) is NaN, and NaN
        // compares false against everything, so `rows >= count` would be
        // false -- which is right by accident. Assert it explicitly so a
        // future "fix" that coerces the URL cannot make it complete.
        const urlCount = [{
          status: 200,
          body: Buffer.from(JSON.stringify({
            count: 'https://www.courtlistener.com/api/rest/v4/search/?count=on',
            next: null,
            results: [{ docket_id: 9, caseName: 'A v. B', dateFiled: '2025-01-01' }],
          })),
        }];
        let k = 0;
        return D.sweep('q', { intervalMs: 0, request: async () => urlCount[k++] });
      })
      .then((u) => {
        check('a URL in count never makes a sweep complete', u.complete === false);
        check('and the reported total stays null rather than NaN',
          u.reported === null, String(u.reported));

        // OVERLAPPING PAGES. Page 2 serves the same docket as page 1.
        // Appending blindly would report 2 dockets of a universe of 1 --
        // a denominator larger than the thing it came from.
        const dup = [page(1, 1, 'more'), repeatOf(1, 1, 'more'), page(2, 1, null)];
        let m = 0;
        return D.sweep('q', { intervalMs: 0, request: async () => dup[m++] })
          .then((o) => {
            check('a docket served twice is counted once',
              o.rows.length === 1 && o.duplicates === 1,
              JSON.stringify({ rows: o.rows.length, dup: o.duplicates }));
            check('and a page with nothing new stops the sweep',
              /only rows already seen/.test(o.stoppedBy || ''), o.stoppedBy);
            check('which is never reported as complete', o.complete === false);

            // MORE DISTINCT DOCKETS THAN THE SOURCE CLAIMS EXIST. Neither
            // number can be trusted, and the sweep must not pick one.
            const over = [
              page(1, 1, 'more'),
              { status: 200,
                body: Buffer.from(JSON.stringify({ count: 1, next: null,
                  results: [{ docket_id: 2, caseName: 'A v. B', dateFiled: '2025-01-01' }] })) },
            ];
            let q = 0;
            return D.sweep('q', { intervalMs: 0, request: async () => over[q++] });
          })
          .then((o) => {
            check('holding more dockets than the source claims is flagged',
              o.overshot === true && o.rows.length === 2 && o.reported === 1,
              JSON.stringify({ n: o.rows.length, r: o.reported, o: o.overshot }));
            check('and overshoot is never complete', o.complete === false);

            const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
            check('a partial sweep prints in red and forbids totalling it',
              /Do not total this as the universe/.test(cli));
            check('and an empty result is called a fact about the query',
              /a fact about this query, not about the courts/.test(cli));
            check('overshoot says the source disagrees with itself',
              /THE SOURCE DISAGREES WITH ITSELF/.test(cli));
            check('and that neither number is trustworthy alone',
              /Neither number is trustworthy/.test(cli));
            check('repeats dropped are reported, not silently swallowed',
              /were repeats of dockets already seen/.test(cli));
            const src = fs.readFileSync(require.resolve('./dockets.js'), 'utf8');
            check('and the live 260-of-203 run is recorded in the source',
              /260 docket\(s\) of 203/.test(src));

            console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
            return FAIL;
          });
      });
  }
};

if (require.main === module) {
  Promise.resolve(module.exports()).then((f) => process.exit(f ? 1 : 0));
}
