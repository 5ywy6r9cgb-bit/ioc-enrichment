#!/usr/bin/env node
'use strict';
/** test_entity.js — a candidate you cannot open is a rumour with a link. */
const fs = require('fs');
const E = require('./entity.js');

let PASS = 0; let FAIL = 0;
function check(name, cond, got) {
  if (cond) { PASS += 1; console.log(`    PASS  ${name}`); }
  else { FAIL += 1; console.log(`    FAIL  ${name}${got === undefined ? '' : `  (${got})`}`); }
}

console.log('\n  entity — reading the record behind a candidate\n');

// ══ 1. WHICH LIST IS THE LOAD-BEARING FACT ═══════════════════════════
//
// "sanction" spans the OFAC SDN list, an EU listing, a national
// debarment register and a research watchlist. A topic without its
// dataset has told you almost nothing.
{
  const r = E.reading({
    id: 'us-bis-oac-abc', caption: 'GOVERNMENT OF X', schema: 'Company',
    datasets: ['us_bis_denied', 'wikidata'],
    first_seen: '2019-04-02T00:00:00', last_seen: '2026-08-01T00:00:00',
    target: true,
    properties: {
      topics: ['export.risk'],
      sourceUrl: ['https://www.bis.doc.gov/some-order'],
      program: ['Denied Persons List'],
      country: ['bd'],
      alias: ['GOV OF X'],
    },
  });
  check('the datasets are carried — which list it came from',
    r.datasets.join(',') === 'us_bis_denied,wikidata', r.datasets.join(','));
  check('the publisher\'s own source URL is surfaced',
    r.sourceUrl[0] === 'https://www.bis.doc.gov/some-order');
  check('and the program that listed it', r.program[0] === 'Denied Persons List');
  check('aliases are kept, since a match may have run through one',
    r.aliases[0] === 'GOV OF X');
  check('first and last seen both travel',
    r.firstSeen.startsWith('2019') && r.lastSeen.startsWith('2026'));
  check('and whether it is a listing TARGET at all', r.target === true);
}

// ══ 2. DESIGNATED AND FLAGGED ARE DIFFERENT FACTS ════════════════════
{
  check('sanction is stated as a government designation',
    /DESIGNATED/.test(E.TOPIC_WEIGHT.sanction));
  check('sanction.linked is explicitly NOT itself designated',
    /not itself designated/.test(E.TOPIC_WEIGHT['sanction.linked']));
  check('export.risk says plainly it is NOT a designation',
    /NOT a designation/.test(E.TOPIC_WEIGHT['export.risk']));
  check('poi says it designates nothing on its own',
    /designates nothing/.test(E.TOPIC_WEIGHT.poi));
  check('and state ownership is called ownership, not wrongdoing',
    /not wrongdoing/.test(E.TOPIC_WEIGHT['gov.soe']));

  const r = E.reading({ properties: { topics: ['export.risk', 'made.up.topic'] } });
  check('every topic gets a weight line', r.weights.length === 2);
  check('an unknown topic says the weight is not stated, rather than guessing',
    /not stated/.test(r.weights[1].means), r.weights[1].means);
}

// ══ 3. A FAILED FETCH IS NOT AN EMPTY RECORD ═════════════════════════
{
  check('the id is URL-encoded, not interpolated raw',
    E.entityUrl('a/b c') === 'https://api.opensanctions.org/entities/a%2Fb%20c',
    E.entityUrl('a/b c'));

  Promise.resolve()
    .then(() => E.fetchEntity('x', { request: async () => ({ status: 404, body: Buffer.from('') }) }))
    .then((r) => {
      check('a 404 is an error, never a record that says nothing',
        r.ok === false && /404/.test(r.error), JSON.stringify(r));
      check('and it reports the URL it tried', /entities\/x/.test(r.url));
      return E.fetchEntity('x', { request: async () => ({ status: 200, body: Buffer.from('nope') }) });
    })
    .then((r) => {
      check('an unparseable body is an error too', r.ok === false && /unparseable/.test(r.error));
      return E.fetchEntity('x', {
        key: 'k',
        request: async (m, u, h) => {
          check('the key travels in the Authorization header',
            h.Authorization === 'ApiKey k', JSON.stringify(h));
          check('and never in the URL, where it would reach a filename',
            !/k/.test(u.split('/entities/')[1] || ''), u);
          return { status: 200, body: Buffer.from(JSON.stringify({
            id: 'x', caption: 'X', schema: 'Company', datasets: ['d'],
            properties: { topics: ['sanction'] } })) };
        },
      });
    })
    .then((r) => {
      check('a real read returns the reading', r.ok === true && r.reading.id === 'x');
      check('and keeps the raw entity beside it, so nothing is lost in summarising',
        r.entity && r.entity.caption === 'X');

      // Missing properties must not throw or invent.
      const empty = E.reading({});
      check('an entity with no properties yields empty lists, not a crash',
        empty.topics.length === 0 && empty.datasets.length === 0);
      check('and a non-array property is ignored rather than coerced',
        E.prop({ properties: { topics: 'sanction' } }, 'topics').length === 0);
      check('a nested object property yields its caption, not [object Object]',
        E.prop({ properties: { x: [{ caption: 'Named Thing' }] } }, 'x')[0] === 'Named Thing');

      const src = fs.readFileSync(require.resolve('./entity.js'), 'utf8');
      check('the reason a candidate must be opened is recorded in the source',
        /a rumour with a link on it/.test(src));
      check('and that the dataset outweighs the topic',
        /It is WHICH DATASET/.test(src));

      console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
      process.exitCode = FAIL === 0 ? 0 : 1;
    });
}
