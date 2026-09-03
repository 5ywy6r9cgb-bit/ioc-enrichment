'use strict';
/**
 * modules/connectors/test_recency.js
 *
 * The risk in this module is not that it misses a duplicate. It is that it
 * reports one that is not there — because a wrong "already asked" can talk an
 * operator out of a search, and a search not made is indistinguishable from a
 * search that found nothing.
 *
 * So the tests below are weighted toward the false positive: slug agreement
 * with the real writer, connector names that prefix one another, stamps that
 * do not parse, and the rule that nothing here skips a call on its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./recency.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

function fixture(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recency-'));
  const cap = path.join(dir, 'captures');
  fs.mkdirSync(cap);
  for (const n of names) fs.writeFileSync(path.join(cap, n), '{}');
  return cap;
}

/** The writer's format: `2026-09-03T11:51:31.959Z` -> `2026-09-03T11-51-31-959Z`. */
const stamp = (iso) => new Date(iso).toISOString().replace(/[:.]/g, '-');
const cap = (connector, query, iso) =>
  `live_capture_${connector}_${R.slugFor(query)}_${stamp(iso)}.json`;

module.exports = function run() {
  console.log('\n  recency\n');

  const NOW = new Date('2026-09-03T12:00:00.000Z');

  // ══ the slug rule must match the writer, exactly ══════════════════════
  //
  // This is the one that matters. If registry.js changes how it names a file
  // and this does not, every lookup returns "never asked" and the feature
  // degrades to silence — which nobody notices, because silence is also what
  // a clean library looks like. So assert against the WRITER'S OWN SOURCE
  // rather than against a copy of the rule.
  {
    const src = fs.readFileSync(require.resolve('./registry.js'), 'utf8');
    const m = /const slug = query\.replace\((\/\[\^A-Za-z0-9\]\+\/g), '_'\)\.slice\(0, (\d+)\)/.exec(src);
    check('registry.js still names captures with the slug rule this module mirrors',
      !!m, 'the capture filename rule moved — recency.js:slugFor must move with it');
    if (m) {
      check('and truncates at the same length', Number(m[2]) === 60, `writer uses ${m[2]}`);
    }
    check('the slug collapses runs of punctuation to one underscore',
      R.slugFor('Larry Householder') === 'Larry_Householder', R.slugFor('Larry Householder'));
    check('and folds a compound query the same way the writer does',
      R.slugFor('LexisNexis Risk Solutions') === 'LexisNexis_Risk_Solutions');
    check('a null query does not throw', R.slugFor(null) === '');
  }

  // ══ reading the library ═══════════════════════════════════════════════
  {
    const dir = fixture([
      cap('courtlistener', 'Larry Householder', '2026-09-03T11:51:31.959Z'),
      cap('courtlistener', 'FirstEnergy', '2026-09-03T11:51:33.277Z'),
      cap('senatelda', 'Flock Safety', '2026-08-28T09:00:00.000Z'),
      'not-a-capture.json',
      'live_capture_courtlistener_Broken_Stamp.json',
      'README.md',
    ]);
    const lib = R.load(dir);

    check('it finds the captures and ignores everything else', lib.size === 3, `size ${lib.size}`);
    check('a query asked 8 minutes ago reports as 8 minutes ago',
      R.describeAge(lib.ageHours('courtlistener', 'Larry Householder', NOW)) === '8 minutes ago',
      R.describeAge(lib.ageHours('courtlistener', 'Larry Householder', NOW)));
    check('a query never asked reports null',
      lib.lastAsked('courtlistener', 'Sam Randazzo') === null);
    check('and the same query on a DIFFERENT connector is a different question',
      lib.lastAsked('senatelda', 'Larry Householder') === null);
    check('a capture from six days ago is found, and is not recent',
      lib.lastAsked('senatelda', 'Flock Safety') !== null
      && !lib.isRepeat('senatelda', 'Flock Safety', 24, NOW));
    check('the 8-minute-old one IS a repeat within 24h',
      lib.isRepeat('courtlistener', 'Larry Householder', 24, NOW));
    check('and is NOT a repeat under a 1-minute policy',
      !lib.isRepeat('courtlistener', 'Larry Householder', 1 / 60, NOW));

    // A filename whose stamp does not parse must be skipped, not counted as
    // an Invalid Date — which compares false against every threshold and so
    // reads as "asked, but not recently", the exact wrong answer.
    check('a capture with an unparseable stamp is skipped, not mis-dated',
      lib.lastAsked('courtlistener', 'Broken Stamp') === null);
  }

  // ══ the newest capture wins ═══════════════════════════════════════════
  //
  // The library holds every run, not the last one. Answering with whichever
  // file readdir yielded first would make a question asked twice today look
  // like one asked in March.
  {
    const dir = fixture([
      cap('courtlistener', 'FirstEnergy', '2026-03-01T10:00:00.000Z'),
      cap('courtlistener', 'FirstEnergy', '2026-09-03T11:00:00.000Z'),
      cap('courtlistener', 'FirstEnergy', '2026-06-15T10:00:00.000Z'),
    ]);
    const lib = R.load(dir);
    check('the most recent of three runs is the one reported',
      lib.ageHours('courtlistener', 'FirstEnergy', NOW) === 1,
      String(lib.ageHours('courtlistener', 'FirstEnergy', NOW)));
  }

  // ══ connector names that prefix one another ═══════════════════════════
  {
    const names = Object.keys(require('./registry.js').CONNECTORS);
    const overlapping = names.filter((a) => names.some((b) => b !== a && b.startsWith(a + '_')));
    check('no connector name is an underscore-prefix of another today',
      overlapping.length === 0, overlapping.join(', '));

    // And if one ever is, the longest match must win. Simulated rather than
    // waiting for the registry to grow the pair.
    const dir = fixture([cap('courtlistener', 'Ohio House Bill 6', '2026-09-03T11:00:00.000Z')]);
    const lib = R.load(dir);
    check('the connector is matched off the front of the name, not guessed',
      lib.lastAsked('courtlistener', 'Ohio House Bill 6') !== null);
  }

  // ══ empty and missing libraries ═══════════════════════════════════════
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recency-'));
    const lib = R.load(path.join(dir, 'captures'));   // never created
    check('a captures directory that does not exist reads as an empty library',
      lib.size === 0 && lib.lastAsked('courtlistener', 'anything') === null);
    check('and nothing is a repeat against an empty library',
      !lib.isRepeat('courtlistener', 'anything', 24, NOW));
  }

  // ══ how ages are described ════════════════════════════════════════════
  {
    check('never asked says so', R.describeAge(null) === 'never');
    check('under a minute is "seconds ago", never "0 minutes ago"',
      R.describeAge(0.005) === 'seconds ago');
    check('a repeat within the hour is reported in minutes',
      R.describeAge(0.3) === '18 minutes ago', R.describeAge(0.3));
    check('inside two days, in hours', R.describeAge(30) === '30.0 hours ago');
    check('beyond that, in days', R.describeAge(24 * 6) === '6 days ago');
  }

  // ══ this module may not skip a call by itself ═════════════════════════
  //
  // The whole design rests on recency being ADVISORY. If this file ever grows
  // the ability to run or suppress a request, a search can go unmade without
  // the operator having asked for that, and the desk cannot tell the
  // difference between "asked and found nothing" and "never asked".
  {
    const code = fs.readFileSync(require.resolve('./recency.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    check('recency makes no network call and runs no connector',
      !/runConnector\(|https?\.request\(|fetch\(/.test(code));
    check('and writes nothing — it only reads the directory',
      !/writeFileSync|appendFileSync|unlinkSync|mkdirSync/.test(code));

    // The skip must be opt-in at the command line. If --new-only stops being
    // the gate, sweep starts quietly declining to make searches.
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('sweep only skips a subject when --new-only was asked for',
      /newOnly/.test(cli) && /--new-only/.test(cli));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
