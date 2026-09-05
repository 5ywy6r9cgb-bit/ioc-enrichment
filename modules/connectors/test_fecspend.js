#!/usr/bin/env node
'use strict';
/**
 * test_fecspend.js — the Schedule E connector.
 *
 * Every check below names the real-world false claim it prevents. A funding
 * question is the easiest place on this desk to publish something wrong,
 * because the numbers look authoritative the moment they are written down.
 */

const fs = require('fs');
const R = require('./registry.js');

module.exports = function run() {
  let PASS = 0;
  let FAIL = 0;
  const check = (name, ok, detail) => {
    if (ok) { PASS++; console.log(`    PASS  ${name}`); }
    else { FAIL++; console.log(`    FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  };

  console.log('\n  fecspend — who spent to elect or defeat, and what that cannot show\n');

  const C = R.CONNECTORS.fecspend;
  check('the connector is registered', !!C);

  // ══ 1. SUPPORTING AND OPPOSING ARE NOT THE SAME NUMBER ════════════════
  //
  // Roughly half of large independent-expenditure money is spent AGAINST a
  // candidate. "$4M on Candidate X" is the sentence that gets written when
  // the S/O indicator is dropped, and it can mean $4M spent trying to
  // destroy X. This is the single most reversible error in the dataset.
  {
    const rows = C.parse({ results: [
      { spender_name: 'SOME PAC', support_oppose_indicator: 'O',
        candidate_name: 'DOE, JANE', expenditure_amount: 250000 },
      { spender_name: 'SOME PAC', support_oppose_indicator: 'S',
        candidate_name: 'ROE, RICHARD', expenditure_amount: 100 },
      { spender_name: 'SOME PAC', candidate_name: 'NOE, PAT', expenditure_amount: 5 },
    ] });
    check('money spent AGAINST is labelled OPPOSING, spelled out',
      /OPPOSING/.test(rows[0].spent) && !/^O\b/.test(rows[0].spent), rows[0].spent);
    check('money spent FOR is labelled SUPPORTING',
      /SUPPORTING/.test(rows[1].spent), rows[1].spent);
    check('a row with no indicator says so rather than defaulting to support',
      /not stated/.test(rows[2].spent), rows[2].spent);
    check('the two directions are never rendered identically',
      rows[0].spent !== rows[1].spent);
  }

  // ══ 2. THE DENOMINATOR ════════════════════════════════════════════════
  //
  // One page is 100 rows. A committee can have thousands. A page total
  // written down as a committee total is off by a factor of fifty and looks
  // exactly as authoritative.
  {
    const partial = C.coverage({ pagination: { count: 5000, page: 1, pages: 50 },
      results: new Array(100).fill({}) });
    check('a capped page is described as a page, not an answer',
      /100 rows of 5000/.test(partial), partial);
    check('and the operator is told not to total it',
      /not of the committee/i.test(partial), partial);

    const whole = C.coverage({ pagination: { count: 7 }, results: new Array(7).fill({}) });
    check('a complete result is allowed to say complete',
      /COMPLETE/.test(whole), whole);

    // A missing count is UNKNOWN. Treating it as complete is how "we have
    // everything" gets asserted about a page.
    const none = C.coverage({ results: [{}] });
    check('a response with no count reports UNKNOWN, not complete',
      /UNKNOWN/.test(none) && !/^COMPLETE/.test(none), none);
    check('and forbids totalling it',
      /Do not total/i.test(none), none);
  }

  // ══ 3. AN ID FILTER HANDED A NAME RETURNS SILENCE, NOT A FINDING ══════
  //
  // `--committee "United Democracy Project"` matches zero rows and prints
  // exactly what a committee that never spent a dollar prints.
  {
    const byName = C.run('United Democracy Project', 'KEY', {});
    check('with no flag the query goes to the SPENDER NAME filter',
      /q_spender=United\+Democracy\+Project|q_spender=United%20Democracy%20Project/.test(byName.url),
      byName.url);
    const byCmte = C.run('c00799031', 'KEY', { committee: true });
    check('--committee sends it to committee_id instead',
      /committee_id=C00799031/.test(byCmte.url), byCmte.url);
    check('and upper-cases the id, because the API does not',
      !/c00799031/.test(byCmte.url));
    const byCand = C.run('H8OH12345', 'KEY', { candidate: true });
    check('--candidate sends it to candidate_id',
      /candidate_id=H8OH12345/.test(byCand.url), byCand.url);
    check('an id filter never also sends q_spender',
      !/q_spender/.test(byCmte.url) && !/q_spender/.test(byCand.url));
    check('a cycle is passed as digits only',
      /cycle=2024/.test(C.run('X', 'KEY', { cycle: '2024x' }).url));

    // The describe line is what the operator reads BEFORE authorising the
    // call. If it says "spender name" while the URL filters on committee_id,
    // the announcement is a lie and the zero is unexplainable afterwards.
    check('the announced request names the filter actually used',
      /committee id/.test(C.describe('C00799031', { committee: true }))
        && /spender name/.test(C.describe('UDP', {})));
  }

  // ══ 4. THE FIVE THINGS A ZERO DOES NOT MEAN ═══════════════════════════
  {
    const z = C.diagnose({ results: [], pagination: { count: 0 } });
    check('a zero is not reported as "they spent nothing"',
      /does not mean no money was spent/i.test(z));
    check('and says state and local office is not covered at all',
      /state or local/i.test(z));
    check('and warns that an id filter given a name looks identical to silence',
      /looks identical to silence/i.test(z));
    check('and separates the spender from the donor behind them',
      /names the SPENDER/.test(z));

    const err = C.diagnose({ message: 'API rate limit exceeded' });
    check('an API error is not reported as an empty result',
      /ERROR, NOT AN EMPTY RESULT/.test(err), err);
    const shape = C.diagnose({ objects: [] });
    check('a schema mismatch is named as one and lists the keys it got',
      /schema mismatch/.test(shape) && /objects/.test(shape), shape);
  }

  // ══ 5. THE HOP THIS TOOL DOES NOT MAKE ════════════════════════════════
  //
  // Schedule E names the committee that SPENT. Who funded that committee is
  // a different filing, and for a 501(c)(4) donor there may be no filing at
  // all. A tool that lets the committee read as the origin of the money
  // manufactures a chain that was never disclosed.
  {
    const src = fs.readFileSync(require.resolve('./registry.js'), 'utf8');
    check('the source records that the committee is one hop, not the chain',
      /one hop, not the whole chain/.test(src));
    check('and that a 501\\(c\\)\\(4\\) funder may have no donor filing at all',
      /there may be no donor filing at all/.test(src));
    check('and that ordinary lobbying is the LDA, not this',
      /that is the LDA, see `connect foreign`/.test(src));
  }

  // ══ 6. THE PAYEE IS KEPT, BECAUSE THE VENDOR IS THE CHECKABLE LINK ════
  //
  // Committees are independent by law and share vendors in practice. The
  // same media buyer under two supposedly unrelated committees is a fact
  // anyone can verify from the filings -- unlike an assertion about intent.
  {
    const [row] = C.parse({ results: [{
      spender_name: 'A PAC', payee_name: 'MEDIA BUYER LLC',
      expenditure_description: 'TV ADS', pdf_url: 'https://docquery.fec.gov/x.pdf',
      expenditure_date: '2024-10-01T00:00:00', transaction_id: 'SE.1',
    }] });
    check('the payee survives the parse', row.payee === 'MEDIA BUYER LLC');
    check('the date is trimmed to a date', row.date === '2024-10-01', row.date);
    check('the filing PDF is carried so the row can be cited to the document',
      row.url === 'https://docquery.fec.gov/x.pdf');
    check('the row has a stable id for dedupe', row.external_id === 'SE.1');
  }

  // ══ 7. CRLINK: A COMMITTEE IS AN ENTITY, A FACEBOOK PAGE IS NOT ═══════
  {
    check('spender names are offered to crosslink as entity names',
      C.entityNames !== false);
    check('the ad-library page name still is not',
      R.CONNECTORS.adlibrary.entityNames === false);
  }

  // ══ 8. THE COVERAGE LINE IS PRINTED ON HITS, NOT ONLY ON ZEROES ═══════
  //
  // A denominator that only appears when there are no results is a
  // denominator that never appears when it matters.
  {
    const cli = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    const at = cli.indexOf('candidate lead(s)');
    const zero = cli.indexOf('if (!out.results.length) {', at);
    const cov = cli.indexOf('connFor.coverage', at);
    check('the coverage line runs before the zero-result branch',
      cov > 0 && zero > 0 && cov < zero, `cov ${cov} zero ${zero}`);
    check('and is labelled coverage where the count is read',
      /C\.y\('coverage'\)/.test(cli));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
