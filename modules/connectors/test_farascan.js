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
            return layerTests();
          });
        });
      });
    });
  }
};

/**
 * ══ A RATE LIMIT IS NOT AN ANSWER ══════════════════════════════════════
 *
 * The first live run paced at 700ms and got 478 of 536 registrants back as
 * HTTP 429. The scan then reported them as "did not answer — unknown, not
 * zero", which is true and useless: the tool had manufactured the silence it
 * was reporting, and nothing in the output said the fix was simply to slow
 * down and go again.
 */
/**
 * ══ THE GRAMMAR INVERTS, AND GETTING IT BACKWARDS INVERTS THE FINDING ═══
 *
 * "X through Y" puts the client on the LEFT. "X on behalf of Y" puts the
 * client on the RIGHT. A parser that read both left-to-right would publish a
 * table asserting that Hogan Lovells is a foreign principal of the Chinese
 * state, and that Tanzania is a pass-through for a Spanish consultancy. Both
 * sentences are defamatory and both would be the tool's fault.
 */
function layerTests() {
  const S = F.splitPrincipal;

  const zte = S('ZTE Corporation (through Hogan Lovells US LLP)');
  check('"through" puts the client on the left',
    zte.party === 'ZTE Corporation' && zte.conduit === 'Hogan Lovells US LLP',
    JSON.stringify(zte));

  const tz = S('Drift Advisors, SL on behalf of United Republic of Tanzania');
  check('"on behalf of" puts the client on the RIGHT — the opposite side',
    tz.party === 'United Republic of Tanzania' && tz.conduit === 'Drift Advisors, SL',
    JSON.stringify(tz));

  const nso = S('NSO Group via Pillsbury Winthrop Shaw Pittman LLP');
  check('"via" reads like "through", not like "on behalf of"',
    nso.party === 'NSO Group' && nso.conduit === 'Pillsbury Winthrop Shaw Pittman LLP',
    JSON.stringify(nso));

  const bgr = S('BGR Gabara, Ltd. (for Bidzina Ivanishvili)');
  // Note "Ltd." keeps its period. An earlier version of tidy() stripped
  // trailing punctuation blindly and produced "BGR Gabara, Ltd" — a
  // truncation of the company's actual name, and one more way a principal
  // stops matching itself in the next source you look it up in.
  check('"(for …)" names the client inside the parenthesis',
    bgr.party === 'Bidzina Ivanishvili' && bgr.conduit === 'BGR Gabara, Ltd.',
    JSON.stringify(bgr));

  // The connector is usually inside a parenthetical, so the character before
  // it is "(" and not a space. Requiring plain whitespace missed every
  // parenthesised layer in the register — which is most of them.
  const haiti = S('Presidency of the Republic of Haiti (through Mercury International UK Ltd)');
  check('a layer opened by a bracket is found, not skipped',
    haiti && haiti.conduit === 'Mercury International UK Ltd', JSON.stringify(haiti));
  check('and the closing bracket is not left glued to the name',
    haiti && !/[()]/.test(haiti.conduit), haiti && haiti.conduit);

  check('a principal that names no layer returns null rather than a guess',
    S('Kingdom of Morocco') === null);
  check('an empty name is not split', S('') === null);
  check('a connector with nothing on one side is not split',
    S('through Hogan Lovells') === null);

  const deep = S('A Ltd on behalf of B through C');
  check('a name with two layers is flagged rather than silently truncated',
    deep && deep.ambiguous === true, JSON.stringify(deep));

  // Routing through your own affiliate is a different fact from routing
  // through an unrelated law firm.
  check('a firm passing work through its own affiliate is detected',
    F.looksSelfAffiliated('Mercury Public Affairs, LLC', 'Mercury International UK Ltd'));
  check('and generic corporate words do not create a false match',
    !F.looksSelfAffiliated('Sitrick Group, LLC', 'Vogel Group LLC'));
  check('a real affiliate whose name shares nothing is MISSED — a heuristic, '
    + 'so absence here is not evidence of independence',
    !F.looksSelfAffiliated('The Burson Group LLC', 'BCW Asia Pacific'));

  // ══ A NESTED BRACKET IS DEBRIS, NOT PART OF THE NAME ═════════════════
  //
  // Principals are written with a parenthetical inside a parenthetical, and
  // blind trailing-punctuation stripping leaves the wreckage glued on:
  // "Mercury International UK Ltd.) (MFA". A name mangled that way never
  // matches the same entity anywhere else — the same failure as the mojibake
  // in the Türkiye principal, reached by a different route.
  {
    const z = S('Ministry of Foreign Affairs and International Trade of Zimbabwe '
      + '(through Mercury International UK Ltd.) (MFA)');
    check('the conduit ends where its own bracket closes',
      z.conduit === 'Mercury International UK Ltd.', z.conduit);

    const adb = S('African Development Bank (through Actum International UK Ltd.) ("ADB")');
    check('a trailing quoted abbreviation is not welded onto the conduit',
      adb.conduit === 'Actum International UK Ltd.', adb.conduit);

    const sar = S('Saudi Arabia Railways ("SAR") , through HIll +Knowlton Strategies GMBH');
    check('a PAIRED quote inside the client name survives — it is the name',
      sar.party === 'Saudi Arabia Railways ("SAR")', sar.party);

    const qfc = S('Education Above All Foundation (through Portland PR Limited (QFC Branch))');
    check('nesting is respected, so a real inner bracket is kept',
      qfc.conduit === 'Portland PR Limited (QFC Branch)', qfc.conduit);

    check('balanceParens cuts at the first unmatched close and nowhere else',
      F.balanceParens('A Ltd.) (B)') === 'A Ltd.'
      && F.balanceParens('A (B) C') === 'A (B) C',
      F.balanceParens('A Ltd.) (B)'));
  }

  // ══ WHEN GRAMMAR AND MEANING DISAGREE, REFUSE TO ANSWER ══════════════
  //
  // Live in the register: "Ministry of Economy of the Argentine Republic …
  // (on behalf of Sullivan & Cromwell LLP)". The connector rule makes the law
  // firm the foreign principal and the finance ministry its pass-through.
  // That is the inversion this module exists to prevent, and it cannot be
  // resolved from the string — so it must not be resolved.
  {
    const arg = S('Ministry of Economy of the Argentine Republic - Legal and '
      + 'Administrative Secretariat (on behalf of Sullivan & Cromwell LLP)');
    check('a law firm named as the principal OF a ministry is flagged contested',
      arg.contested === true, JSON.stringify(arg));

    const palau = S('Akin, Gump, Strauss, Hauer & Feld, on behalf of the '
      + 'Government of the Republic of Palau');
    check('the same construction written correctly is NOT flagged',
      palau.contested === false && palau.party === 'the Government of the Republic of Palau',
      `${palau.contested} / ${palau.party}`);

    const isr = S('State of Israel via Havas Media Germany GmbH');
    check('a state client with a corporate conduit is not flagged',
      isr.contested === false && isr.party === 'State of Israel', isr.party);

    check('looksContested needs BOTH signals, not either one',
      !F.looksContested('Some Firm LLP', 'Another Firm LLC')
      && !F.looksContested('Republic of X', 'Ministry of Y'));
  }

  return rateLimitTests();
}

function rateLimitTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farascan429-'));
  const listFile = path.join(dir, 'captures', 'farascan', 'active_registrants.json');
  fs.mkdirSync(path.dirname(listFile), { recursive: true });
  fs.writeFileSync(listFile, JSON.stringify({ REGISTRANTS_ACTIVE: { ROW: [
    { Registration_Number: '10', Name: 'Alpha' },
    { Registration_Number: '11', Name: 'Bravo' },
  ] } }));

  const body = (principal) => Buffer.from(JSON.stringify({ REGDOCS: { ROW: [{
    DATE_STAMPED: '2024-01-01', REGISTRATION_NUMBER: '10',
    FOREIGN_PRINCIPAL_COUNTRY: 'CHINA', DOCUMENT_TYPE: 'Exhibit AB',
    REGISTRANT_NAME: 'X', URL: 'https://efile.fara.gov/d/1',
    FOREIGN_PRINCIPAL_NAME: principal,
  }] } }));

  // Header form: Retry-After in seconds.
  check('Retry-After in seconds is read',
    F.retryAfterMs({ headers: { 'retry-after': '3' } }) === 3000);
  check('Retry-After as an HTTP date is read',
    F.retryAfterMs({ headers: { 'retry-after': new Date(Date.now() + 5000).toUTCString() } }) > 3000);
  check('a response with no Retry-After returns null, not zero',
    F.retryAfterMs({ headers: {} }) === null);

  // 10 throttles twice then succeeds; 11 throttles forever.
  let seen10 = 0;
  const waits = [];
  const req = async (method, url) => {
    const n = (/RegDocs\/json\/(\d+)/.exec(url) || [])[1];
    if (n === '10') {
      seen10 += 1;
      if (seen10 <= 2) return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
      return { status: 200, headers: {}, body: body('Hikvision USA Inc.') };
    }
    return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
  };

  return F.scan(/hikvision/i, {
    evidenceRoot: dir, request: req, intervalMs: 0, freshDays: 99,
    onNote: (m) => waits.push(m),
  }).then((out) => {
    check('a registrant that throttles then answers is READ, not written off',
      out.registrantsRead === 1 && out.hits.length === 1, out.registrantsRead);
    check('it retried rather than giving up on the first 429',
      seen10 === 3, String(seen10));
    check('a registrant that never stops throttling is a failure, not a zero',
      out.registrantsFailed === 1, out.registrantsFailed);
    check('and that failure is labelled as throttling specifically',
      out.registrantsThrottled === 1 && /rate limited, not empty/.test(out.failures[0].error),
      JSON.stringify(out.failures));
    check('the operator is told the retry is happening, not left staring at a pause',
      waits.some((w) => /rate limited, waiting/.test(w)), waits[0]);

    const line = F.coverageLine(out);
    check('the coverage sentence says re-running clears a throttle',
      /re-running clears them/i.test(line), line);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
    return FAIL;
  });
}

if (require.main === module) {
  Promise.resolve(module.exports()).then((f) => process.exit(f ? 1 : 0));
}
