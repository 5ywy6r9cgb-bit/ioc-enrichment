'use strict';
/**
 * test_farascan.js — a scan that cannot state its own coverage is not allowed
 * to make a claim about the register.
 *
 * The whole point of this module is the denominator. Every test here is
 * ultimately about one failure: reporting "no matches" over a register that
 * was only 90% read, which turns an unknown into a confident absence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./farascan.js');

let PASS = 0;
let FAIL = 0;
function check(what, cond, got) {
  if (cond) { PASS += 1; console.log(`    PASS  ${what}`); }
  else { FAIL += 1; console.log(`    FAIL  ${what}${got !== undefined ? `  (got: ${got})` : ''}`); }
}

const row = (o) => Object.assign({
  name: '(no foreign principal named on this document)',
  country: '', registrant: 'Some Firm, LLC', document: 'Short-Form',
  filed: '2025-01-01', url: 'https://efile.fara.gov/d/1',
}, o);

module.exports = function run() {
  console.log('\n  farascan\n');

  // ══ A PLACEHOLDER IS NOT A NAME ══════════════════════════════════════
  //
  // The parser writes "(no foreign principal named on this document)" where
  // FOREIGN_PRINCIPAL_NAME is blank. Matching a pattern against that string
  // would make a search for "no" or "document" hit every Short-Form in the
  // register — thousands of rows, all of them meaningless.
  {
    check('a row with a real principal counts as naming one',
      F.namesPrincipal(row({ name: 'Kingdom of Morocco' })));
    check('the placeholder does NOT count as naming a principal',
      !F.namesPrincipal(row({})));
    check('and the placeholder is never matched by a pattern that appears in it',
      !F.matches(row({}), /document/i));
    check('an empty name does not count either',
      !F.namesPrincipal(row({ name: '' })));
  }

  // ══ THE FIRM IS NOT THE PRINCIPAL ════════════════════════════════════
  //
  // Every row carries the registrant's own name. If the pattern were matched
  // against it, searching for "Mercury" would return Mercury's entire filing
  // history as "hits" — 1,826 rows that answer a question nobody asked.
  {
    const r = row({ name: 'Hikvision USA Inc.', country: 'CHINA', registrant: 'Mercury Public Affairs, LLC' });
    check('a pattern matching the principal hits', F.matches(r, /hikvision/i));
    check('a pattern matching the country hits', F.matches(r, /china/i));
    check('a pattern matching only the REGISTRANT does not hit',
      !F.matches(r, /mercury/i));
  }

  // ══ ROLL-UP ═══════════════════════════════════════════════════════════
  {
    const rows = [
      row({ name: 'Q Cyber Technologies Ltd', country: 'ISRAEL', document: 'Exhibit AB', filed: '2019-12-25' }),
      row({ name: 'Q Cyber Technologies Ltd', country: 'ISRAEL', document: 'Informational Materials', filed: '2021-10-25' }),
      row({ name: 'Q Cyber Technologies Ltd', country: 'ISRAEL', document: 'Informational Materials', filed: '2020-05-01' }),
      row({ name: 'Embassy of Denmark', country: 'DENMARK', document: 'Exhibit AB', filed: '2025-05-14' }),
      row({}),
    ];
    const s = F.summarise(rows, /q cyber/i);
    check('one line per principal, not one per document', s.length === 1, s.length);
    check('the document count is the count', s[0].docs === 3, s[0].docs);
    check('the date span runs earliest to latest, not first-seen to last-seen',
      s[0].first === '2019-12-25' && s[0].last === '2021-10-25',
      `${s[0].first}..${s[0].last}`);
    check('every document type is kept, so a registration is not read as a mailing',
      s[0].types.includes('Exhibit AB') && s[0].types.includes('Informational Materials'),
      s[0].types.join(','));
    check('a non-matching principal is left out', !/Denmark/.test(JSON.stringify(s)));
  }

  // ══ AN UNANSWERED REGISTRANT IS UNKNOWN, NOT ZERO ════════════════════
  //
  // This is the reason the module exists in this shape. A scan where 2 of 5
  // registrants failed and 0 matched must NOT be reportable as "nothing in
  // the register" — it read 3.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farascan-'));
    const listFile = path.join(dir, 'captures', 'farascan', 'active_registrants.json');
    fs.mkdirSync(path.dirname(listFile), { recursive: true });
    fs.writeFileSync(listFile, JSON.stringify({ REGISTRANTS_ACTIVE: { ROW: [
      { Registration_Number: '1', Name: 'Alpha LLC' },
      { Registration_Number: '2', Name: 'Bravo LLC' },
      { Registration_Number: '3', Name: 'Charlie LLC' },
      { Registration_Number: '4', Name: 'Delta LLC' },
      { Registration_Number: '5', Name: 'Echo LLC' },
    ] } }));

    // Two registrants refuse to answer; one holds the match.
    const fakeRequest = async (method, url) => {
      const m = /RegDocs\/json\/(\d+)/.exec(url);
      const n = m && m[1];
      if (n === '2' || n === '4') return { status: 500, error: null, body: Buffer.from('') };
      const principal = n === '3' ? 'Hikvision USA Inc.' : '';
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ REGDOCS: { ROW: [{
          DATE_STAMPED: '2024-01-01', REGISTRATION_NUMBER: n,
          FOREIGN_PRINCIPAL_COUNTRY: principal ? 'CHINA' : '',
          DOCUMENT_TYPE: 'Exhibit AB', REGISTRANT_NAME: 'X',
          URL: `https://efile.fara.gov/d/${n}`, FOREIGN_PRINCIPAL_NAME: principal,
        }] } })),
      };
    };

    const opts = { evidenceRoot: dir, request: fakeRequest, intervalMs: 0, freshDays: 99 };

    return F.scan(/hikvision/i, opts).then((out) => {
      check('the scan completes', out.ok === true, out.error);
      check('only the registrants that answered are counted as read',
        out.registrantsRead === 3, out.registrantsRead);
      check('the ones that did not answer are counted as failures',
        out.registrantsFailed === 2, out.registrantsFailed);
      check('and each failure is named, so it can be retried',
        out.failures.length === 2 && out.failures.every((f) => f.number && f.error),
        JSON.stringify(out.failures));
      check('the register total is carried, not just what was attempted',
        out.registrantsInRegister === 5, out.registrantsInRegister);
      check('the real match is found', out.hits.length === 1
        && out.hits[0].principals[0].principal === 'Hikvision USA Inc.',
        JSON.stringify(out.hits));

      const line = F.coverageLine(out);
      check('the coverage sentence says how many answered',
        /read 3 of 5/.test(line), line);
      check('and says plainly that the failures are unknown, not zero',
        /unknown, not zero/i.test(line), line);

      // The same scan for something genuinely absent must still refuse to
      // read as "the register holds none of these".
      return F.scan(/nothing-matches-this/i, opts).then((zero) => {
        check('a true zero still reports its coverage',
          zero.hits.length === 0 && zero.registrantsRead === 3, zero.registrantsRead);
        check('and a zero-hit scan still names the registrants it could not read',
          zero.registrantsFailed === 2, zero.registrantsFailed);

        // ══ A CACHE HIT IS NOT A FETCH ══════════════════════════════════
        // The second run reads the files the first one wrote. If cached
        // reads were counted as fresh, "read 3 of 5" would silently become
        // a claim about data that could be months old.
        return F.scan(/hikvision/i, opts).then((again) => {
          check('a re-run serves answered registrants from cache',
            again.fromCache === 3, again.fromCache);
          check('and still retries the ones that failed rather than caching a failure',
            again.registrantsFailed === 2, again.registrantsFailed);

          // ══ A BAD PATTERN IS AN ERROR, NOT AN EMPTY RESULT ════════════
          return F.scan('([unclosed', opts).then((bad) => {
            check('an unparseable pattern is refused, not run as zero hits',
              bad.ok === false && /not a valid pattern/.test(bad.error), bad.error);

            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
            return FAIL;
          });
        });
      });
    });
  }
};

if (require.main === module) {
  Promise.resolve(module.exports()).then((f) => process.exit(f ? 1 : 0));
}
