#!/usr/bin/env node
'use strict';
/**
 * test_screen.js — the FARA/OpenSanctions join must not manufacture a
 * finding out of the statute working as designed.
 */
const fs = require('fs');
const S = require('./screen.js');

let PASS = 0; let FAIL = 0;
function check(name, cond, got) {
  if (cond) { PASS += 1; console.log(`    PASS  ${name}`); }
  else { FAIL += 1; console.log(`    FAIL  ${name}${got === undefined ? '' : `  (${got})`}`); }
}

console.log('\n  screen — FARA principals against sanctions data\n');

// ══ 1. THE STATUTE WORKING AS DESIGNED IS NOT A FINDING ══════════════
//
// A FARA principal is very often a foreign government, and its officers
// are politically exposed BY DEFINITION. Reporting that as a discovery
// rediscovers the purpose of the Act and dresses it as a scandal.
{
  check('a government body is EXPECTED, not a finding',
    S.topicClass(['gov.national']) === 'EXPECTED', S.topicClass(['gov.national']));
  check('a politically exposed person is EXPECTED',
    S.topicClass(['role.pep']) === 'EXPECTED');
  check('a diplomat is EXPECTED',
    S.topicClass(['role.diplo']) === 'EXPECTED');

  // These are NOT predicted by registering, and are the only rows that
  // can become a finding.
  check('a sanctions listing is NOTABLE', S.topicClass(['sanction']) === 'NOTABLE');
  check('a linked sanctions listing is NOTABLE',
    S.topicClass(['sanction.linked']) === 'NOTABLE');
  check('export control is NOTABLE', S.topicClass(['export.control']) === 'NOTABLE');
  check('a criminal topic is NOTABLE', S.topicClass(['crime.fin']) === 'NOTABLE');

  // A sanctioned government body is NOTABLE. The sanction is the fact that
  // registering does not predict, and it must not be absorbed by the
  // government topic sitting next to it.
  check('a sanctioned government body is NOTABLE, not EXPECTED',
    S.topicClass(['gov.national', 'sanction']) === 'NOTABLE',
    S.topicClass(['gov.national', 'sanction']));

  // An unrecognised topic must never be filed under "nothing to see".
  check('an unknown topic is UNCLEAR, never EXPECTED',
    S.topicClass(['gov.national', 'something.new']) === 'UNCLEAR',
    S.topicClass(['gov.national', 'something.new']));
  check('no topics at all is UNCLEAR', S.topicClass([]) === 'UNCLEAR');
}

// ══ 2. EVERY NAME IS ASKED AS BOTH A PERSON AND AN ORGANISATION ══════
//
// The registry records this as the worst bug in the file: asking a
// sanctions database whether a COMPANY is a PERSON returns a confident,
// meaningless zero. That bug must not be reintroduced by the batcher.
{
  const body = JSON.parse(S.matchBody(['Acme GmbH', 'Jane Doe']));
  const qs = Object.keys(body.queries);
  check('two names produce four queries', qs.length === 4, JSON.stringify(qs));
  check('each name is asked as a Person',
    body.queries.p0.schema === 'Person' && body.queries.p1.schema === 'Person');
  check('and each name is asked as an Organization',
    body.queries.o0.schema === 'Organization' && body.queries.o1.schema === 'Organization');
  check('the first name reaches both queries',
    body.queries.p0.properties.name[0] === 'Acme GmbH'
    && body.queries.o0.properties.name[0] === 'Acme GmbH');

  check('a response key maps back to the name that was asked',
    S.nameForKey('o1', ['Acme GmbH', 'Jane Doe']) === 'Jane Doe');
  check('and an unknown key maps to nothing rather than the wrong name',
    S.nameForKey('junk', ['Acme GmbH']) === null);
  check('an out-of-range index is null, not undefined behaviour',
    S.nameForKey('p9', ['Acme GmbH']) === null);
}

// ══ 3. A NAME MATCH IS A CANDIDATE, NEVER AN IDENTIFICATION ══════════
{
  const json = { responses: {
    p0: { results: [{ id: 'NK-1', caption: 'Jane Doe', schema: 'Person',
      score: 0.91, properties: { topics: ['sanction'] } }] },
    o0: { results: [{ id: 'NK-1', caption: 'Jane Doe', schema: 'Person',
      score: 0.91, properties: { topics: ['sanction'] } }] },
  } };
  const rows = S.parseBatch(json, ['Jane Doe']);
  check('an entity matching both schemas is counted once',
    rows.length === 1, String(rows.length));
  const r = rows[0];
  check('the row carries the name that was ASKED', r.asked === 'Jane Doe');
  check('and the name that was MATCHED, so they can be compared',
    r.matched_name === 'Jane Doe');
  check('and the score, so a weak match is visible', r.score === 0.91);
  check('and a URL to the record itself', /opensanctions\.org\/entities\/NK-1/.test(r.url));
  check('there is no boolean saying the subject IS sanctioned',
    !('sanctioned' in r) && !('hit' in r), JSON.stringify(Object.keys(r)));

  const src = fs.readFileSync(require.resolve('./screen.js'), 'utf8');
  check('the false-positive warning is recorded in the source',
    /entity resolution on names produces false positives/.test(src));
  check('and the reason EXPECTED rows are not findings',
    /It has rediscovered the purpose of/.test(src));
}

// ══ 4. AN INTERRUPTED SCREEN HAS NOT CLEARED WHAT IT NEVER SENT ══════
//
// This is the rate-limit error one layer up: names that were never asked
// about read as names that came back clean.
{
  const ok = { status: 200, body: Buffer.from(JSON.stringify({ responses: {} })) };
  const names = ['A', 'B', 'C', 'D'];
  Promise.resolve()
    .then(() => S.screen(names, { size: 2, intervalMs: 0, key: 'k',
      request: async () => ok }))
    .then((out) => {
      check('a full screen is complete', out.complete === true && out.batches === 2,
        JSON.stringify({ c: out.complete, b: out.batches }));
      check('and nothing is left unscreened', out.unscreened.length === 0);

      let n = 0;
      return S.screen(names, { size: 2, intervalMs: 0, key: 'k',
        request: async () => { n += 1; return n === 1 ? ok : { status: 429, body: Buffer.from('') }; } });
    })
    .then((out) => {
      check('a rate-limited screen is NOT complete', out.complete === false, String(out.complete));
      check('and says which batch stopped it', /429/.test(out.stoppedBy || ''), out.stoppedBy);
      check('the names it never sent are listed as UNSCREENED',
        out.unscreened.join(',') === 'C,D', out.unscreened.join(','));
      check('and the names it did send are listed separately',
        out.asked.join(',') === 'A,B', out.asked.join(','));

      // Grouping keeps empty classes present: a run with no NOTABLE rows
      // must print "NOTABLE 0", not omit the heading and read as untested.
      const g = S.bySignificance([{ significance: 'EXPECTED' }]);
      check('empty significance classes stay visible',
        'NOTABLE' in g && 'UNCLEAR' in g && g.NOTABLE.length === 0,
        JSON.stringify(Object.keys(g)));

      console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
      process.exitCode = FAIL === 0 ? 0 : 1;
    });
}
