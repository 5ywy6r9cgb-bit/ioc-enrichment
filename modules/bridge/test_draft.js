'use strict';
/**
 * test_draft.js
 *
 * The dangerous output here is not a crash. It is a few hundred confident
 * GREEN claims, each carrying a URL as its citation, for documents nobody
 * opened. They would be indistinguishable from claims someone had checked.
 *
 * So most of these tests are about the tier and the gate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./draft.js');

let PASS = 0, FAIL = 0;
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

module.exports = async function run() {
  console.log('\n  captures → claims\n');

  // ══ 1. A CAPTURE NEVER BECOMES A FACT ═════════════════════════════════
  {
    const rows = [
      ['courtlistener', { name: 'Smith v. Jones', court: 'Ohio BTA', date: '2024-01-02',
        external_id: '1', url: 'https://www.courtlistener.com/opinion/1/x/' }],
      ['federalregister', { name: 'A Rulemaking Notice', agencies: 'EPA',
        date: '2025-01-01', external_id: '2', url: 'https://x.gov/d/2' }],
      ['fec', { name: 'DOE, JOHN', party: 'REP', office: 'House', state: 'OH',
        external_id: 'H0OH1', url: 'https://fec.gov/data/candidate/H0OH1/' }],
      ['senatelda', { name: 'ALPINE GROUP', client: 'NISOURCE', external_id: '3', url: '' }],
      ['opensanctions', { name: 'SOME ENTITY', external_id: '4', url: 'https://x/4' }],
    ];
    for (const [conn, row] of rows) {
      const c = D.toClaim(conn, 'data centers', row);
      ok(`${conn}: the claim is a QUESTION, not a statement`,
        c && c.text.endsWith('?'), c && c.text);
      ok(`${conn}: it names a record that would close it`,
        c && c.gate && c.gate.length > 20, c && c.gate);
    }
  }

  // ══ 2. THE GATE TELLS YOU THE NEXT COMMAND ════════════════════════════
  {
    const c = D.toClaim('courtlistener', 'X',
      { name: 'A v. B', external_id: '9', url: 'https://www.courtlistener.com/opinion/9/a/' });
    ok('a row with a url gets a fetch command in its gate',
      /bin\/sentinel doc get https:\/\//.test(c.gate), c.gate);

    const noUrl = D.toClaim('senatelda', 'X', { name: 'FIRM', external_id: '77', url: '' });
    ok('a row with NO url still names the record rather than inventing a link',
      !/doc get/.test(noUrl.gate) && noUrl.gate.includes('77'), noUrl.gate);
  }

  // ══ 3. THE SAME ROW ALWAYS PRODUCES THE SAME TEXT ═════════════════════
  // Idempotency depends entirely on this. If the text drifted -- a timestamp,
  // a counter, a reordered clause -- every re-run would re-draft the whole
  // library and the desk would fill with near-duplicate questions.
  {
    const row = { name: 'A v. B', court: 'BTA', date: '2024-01-01',
      external_id: '5', url: 'https://x/5' };
    const a = D.toClaim('courtlistener', 'subj', row);
    const b = D.toClaim('courtlistener', 'subj', JSON.parse(JSON.stringify(row)));
    ok('the same row twice produces byte-identical text', a.text === b.text, a.text);
    ok('and an identical gate', a.gate === b.gate);
  }

  // ══ 4. A ROW WITH NO NAME PRODUCES NOTHING, NOT A BLANK QUESTION ══════
  {
    ok('an empty name yields no claim',
      D.toClaim('courtlistener', 'x', { name: '', external_id: '6' }) === null);
    ok('a whitespace name yields no claim',
      D.toClaim('courtlistener', 'x', { name: '   ', external_id: '7' }) === null);
  }

  // ══ 5. GATHERING: DEDUPE, AND UNPARSEABLE CAPTURES ARE COUNTED ════════
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
    const capDir = path.join(dir, 'captures');
    fs.mkdirSync(capDir, { recursive: true });

    const body = JSON.stringify({ count: 2, results: [
      { id: 1, caseName: 'A v. B', court: 'BTA', dateFiled: '2024-01-01',
        absolute_url: '/opinion/1/a/' }] });
    // The SAME record returned by two different searches.
    fs.writeFileSync(path.join(capDir,
      'live_capture_courtlistener_Alpha_2026-01-01T00-00-00-000Z.json'), body);
    fs.writeFileSync(path.join(capDir,
      'live_capture_courtlistener_Alpha_2026-01-02T00-00-00-000Z.json'), body);
    fs.writeFileSync(path.join(capDir,
      'live_capture_courtlistener_Alpha_2026-01-03T00-00-00-000Z.json'), '{ not json');

    const saved = process.env.SENTINEL_EVIDENCE_DIR;
    process.env.SENTINEL_EVIDENCE_DIR = dir;
    delete require.cache[require.resolve('../connectors/registry.js')];
    delete require.cache[require.resolve('../connectors/crosslink.js')];
    delete require.cache[require.resolve('./draft.js')];
    const D2 = require('./draft.js');
    const g = D2.gather({});
    if (saved === undefined) delete process.env.SENTINEL_EVIDENCE_DIR;
    else process.env.SENTINEL_EVIDENCE_DIR = saved;

    ok('the same record from two searches is ONE question',
      g.claims.length === 1, `${g.claims.length} claims from ${g.raw} rows`);
    ok('the duplicate rows are still counted, so the reduction is visible',
      g.raw === 2, String(g.raw));
    ok('an unparseable capture is COUNTED, not silently skipped',
      g.unparsed === 1, String(g.unparsed));
    ok('an unparseable capture contributes no claims',
      !g.claims.some((c) => /not json/.test(c.text)));
  }

  // ══ 5b. ONE ENTITY IS SEVERAL SEARCH STRINGS ══════════════════════════
  // The subject on a capture is the string that was SEARCHED, not the entity
  // that was found. On a real library "AWS" holds 113 rows while the same
  // company also sits under "Amazon Web Services" (240), "Amazon Data
  // Services" (210), "AWS Public Policy" (108) and "Vadata" (48). A dossier
  // drawn from the literal spelling misses 606 of 719 rows and reads as
  // though the record is thin.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-'));
    const capDir = path.join(dir, 'captures');
    fs.mkdirSync(capDir, { recursive: true });
    const mk = (subject, id, name) => fs.writeFileSync(
      path.join(capDir, `live_capture_courtlistener_${subject}_2026-01-0${id}T00-00-00-000Z.json`),
      JSON.stringify({ count: 1, results: [
        { id, caseName: name, court: 'BTA', dateFiled: '2024-01-01',
          absolute_url: `/opinion/${id}/x/` }] }));
    mk('AWS', 1, 'Alpha v. One');
    mk('Amazon_Web_Services', 2, 'Beta v. Two');
    mk('Unrelated_Co', 3, 'Gamma v. Three');

    const saved = process.env.SENTINEL_EVIDENCE_DIR;
    process.env.SENTINEL_EVIDENCE_DIR = dir;
    for (const m of ['../connectors/registry.js', '../connectors/crosslink.js', './draft.js']) {
      delete require.cache[require.resolve(m)];
    }
    const D3 = require('./draft.js');
    const one = D3.gather({ subjects: ['AWS'] });
    const both = D3.gather({ subjects: ['AWS', 'Amazon Web Services'] });
    const none = D3.gather({});
    if (saved === undefined) delete process.env.SENTINEL_EVIDENCE_DIR;
    else process.env.SENTINEL_EVIDENCE_DIR = saved;

    ok('one --subject matches only that spelling', one.claims.length === 1,
      String(one.claims.length));
    ok('--subject may be repeated, and the results are unioned',
      both.claims.length === 2, String(both.claims.length));
    ok('an unrelated subject is still excluded',
      !both.claims.some((c) => /Gamma/.test(c.text)));
    ok('no --subject at all still means everything', none.claims.length === 3,
      String(none.claims.length));
  }

  // ══ 5c. THE FOLD IS REAL, AND MUST NOT BE SILENT ══════════════════════
  // A registrant that filed seventeen quarterly reports for one client raises
  // ONE question, not seventeen identical ones -- so folding is right. But on
  // a real library 79 sworn filings collapsed into 9 questions with nothing
  // on screen saying 70 more stood behind them, which reads as a thin record
  // when it is the opposite.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'));
    const capDir = path.join(dir, 'captures');
    fs.mkdirSync(capDir, { recursive: true });
    // Four quarterly filings, one registrant, one client.
    const results = ['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => ({
      filing_uuid: `uuid-${i}`,
      client: { name: 'AWS PUBLIC POLICY' },
      registrant: { name: 'ALPINE GROUP PARTNERS' },
      filing_year: 2025, filing_period_display: q,
      filing_document_url: `https://lda.gov/f/${i}/`,
    }));
    fs.writeFileSync(path.join(capDir,
      'live_capture_senatelda_AWS_2026-01-01T00-00-00-000Z.json'),
      JSON.stringify({ count: 4, results }));

    const saved = process.env.SENTINEL_EVIDENCE_DIR;
    process.env.SENTINEL_EVIDENCE_DIR = dir;
    for (const m of ['../connectors/registry.js', '../connectors/crosslink.js', './draft.js']) {
      delete require.cache[require.resolve(m)];
    }
    const D4 = require('./draft.js');
    const g = D4.gather({});
    if (saved === undefined) delete process.env.SENTINEL_EVIDENCE_DIR;
    else process.env.SENTINEL_EVIDENCE_DIR = saved;

    ok('four filings for one registrant/client pair make ONE question',
      g.claims.length === 1, `${g.claims.length} claims`);
    ok('and the question carries how many records stand behind it',
      g.claims[0].folded === 4, String(g.claims[0].folded));
    ok('the period span is reported so the relationship has a shape',
      /2025 Q1/.test(g.claims[0].span) && /2025 Q4/.test(g.claims[0].span),
      g.claims[0].span);
    ok('the raw row count is still visible, so the fold is checkable',
      g.raw === 4, String(g.raw));
    ok('the stored TEXT carries no count, so a later run stays idempotent',
      !/\b4\b/.test(g.claims[0].text), g.claims[0].text);
  }

  // ══ 5d. A LOBBYING QUESTION NAMES BOTH PARTIES ════════════════════════
  // The connector bakes both into one field as "CLIENT — REGISTRANT".
  // Reading that as a single name produced "AWS PUBLIC POLICY, AMERICAS —
  // ALPINE GROUP PARTNERS, LLC.'s lobbying filing" -- which reads as one
  // party and is two.
  {
    const d = D.describe('senatelda',
      { name: 'AWS PUBLIC POLICY, AMERICAS — ALPINE GROUP PARTNERS, LLC.' });
    ok('the registrant is named as the one doing the lobbying',
      d.startsWith('ALPINE GROUP PARTNERS'), d);
    ok('and the client as the one lobbied for',
      /for AWS PUBLIC POLICY, AMERICAS$/.test(d), d);
    ok('a name with no separator still produces something readable',
      /lobbying filing/.test(D.describe('senatelda', { name: 'SOLO FIRM' })));
  }

  // ══ 5e. MORE FILINGS THAN PERIODS MEANS AMENDMENTS ════════════════════
  // Q2 and Q2A are one quarter filed twice -- an amendment RESTATES a period,
  // it does not add one. Eight filings across seven quarters is not eight
  // quarters of activity, and a reader will infer that it is unless told.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-'));
    const capDir = path.join(dir, 'captures');
    fs.mkdirSync(capDir, { recursive: true });
    const mk = (uuid, period) => ({
      filing_uuid: uuid,
      client: { name: 'AWS' }, registrant: { name: 'ALPINE' },
      filing_year: 2025, filing_period_display: period,
      filing_document_url: `https://lda.gov/f/${uuid}/`,
    });
    fs.writeFileSync(path.join(capDir,
      'live_capture_senatelda_AWS_2026-01-01T00-00-00-000Z.json'),
      JSON.stringify({ count: 4, results: [
        mk('a', 'Q1'), mk('b', 'Q2'), mk('c', 'Q2'), mk('d', 'Q3')] }));

    const saved = process.env.SENTINEL_EVIDENCE_DIR;
    process.env.SENTINEL_EVIDENCE_DIR = dir;
    for (const m of ['../connectors/registry.js', '../connectors/crosslink.js', './draft.js']) {
      delete require.cache[require.resolve(m)];
    }
    const D6 = require('./draft.js');
    const g = D6.gather({});
    if (saved === undefined) delete process.env.SENTINEL_EVIDENCE_DIR;
    else process.env.SENTINEL_EVIDENCE_DIR = saved;

    const c = g.claims[0];
    ok('four filings over three quarters counts four FILINGS', c.folded === 4,
      String(c.folded));
    ok('and reports three periods, not four', c.periodCount === 3,
      String(c.periodCount));
    ok('the restated period is named as such', c.amended === 1, String(c.amended));
  }

  // ══ 6. THE SEARCH STRING IS NOT PART OF THE CLAIM ═════════════════════
  // Putting it in the text split ONE relationship into several claims,
  // differing only by which search surfaced it:
  //
  //   ...establish anything about AWS?                 -- 8 records
  //   ...establish anything about AWS Public Policy?   -- 16 records
  //
  // Same registrant, same client, same period span. The subject is the
  // search string, not a property of the record.
  {
    const row = { name: 'AWS PUBLIC POLICY — ALPINE GROUP PARTNERS',
      external_id: 'bc30', url: 'https://lda.gov/x', period: '2025 Q2' };
    const a = D.toClaim('senatelda', 'AWS', row);
    const b = D.toClaim('senatelda', 'AWS Public Policy', row);
    ok('two different searches for one record produce ONE claim text',
      a.text === b.text, `${a.text}\n          ${b.text}`);
    ok('and the text names both parties',
      /ALPINE GROUP PARTNERS/.test(a.text) && /AWS PUBLIC POLICY/.test(a.text), a.text);

    const court = D.toClaim('courtlistener', 'anything',
      { name: 'A v. B', court: 'BTA', date: '2024-01-01',
        external_id: '8', url: 'https://x/8' });
    ok('a court record is still identified by caption, court and date',
      /A v\. B/.test(court.text) && /BTA/.test(court.text), court.text);
  }

  // ══ 6b. A FILING SEEN BY TWO SEARCHES IS ONE FILING ═══════════════════
  // Counting appearances rather than records reports a relationship as twice
  // as well evidenced as it is. A count that is wrong and looks right is the
  // exact failure the lobbying module was built around.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
    const capDir = path.join(dir, 'captures');
    fs.mkdirSync(capDir, { recursive: true });
    const filings = [0, 1, 2].map((i) => ({
      filing_uuid: `same-${i}`,
      client: { name: 'AWS PUBLIC POLICY' },
      registrant: { name: 'ALPINE GROUP PARTNERS' },
      filing_year: 2025, filing_period_display: `Q${i + 1}`,
      filing_document_url: `https://lda.gov/f/${i}/`,
    }));
    // The SAME three filings, returned by two different searches.
    for (const subj of ['AWS', 'AWS_Public_Policy']) {
      fs.writeFileSync(path.join(capDir,
        `live_capture_senatelda_${subj}_2026-01-01T00-00-00-000Z.json`),
        JSON.stringify({ count: 3, results: filings }));
    }

    const saved = process.env.SENTINEL_EVIDENCE_DIR;
    process.env.SENTINEL_EVIDENCE_DIR = dir;
    for (const m of ['../connectors/registry.js', '../connectors/crosslink.js', './draft.js']) {
      delete require.cache[require.resolve(m)];
    }
    const D5 = require('./draft.js');
    const g = D5.gather({});
    if (saved === undefined) delete process.env.SENTINEL_EVIDENCE_DIR;
    else process.env.SENTINEL_EVIDENCE_DIR = saved;

    ok('two searches over the same relationship make ONE question',
      g.claims.length === 1, `${g.claims.length} claims`);
    ok('and the count is 3 filings, not 6 appearances',
      g.claims[0].folded === 3, `folded=${g.claims[0].folded}`);
    ok('both searches are recorded as how it was found',
      g.claims[0].foundVia.length === 2, JSON.stringify(g.claims[0].foundVia));
    ok('the raw appearance count is still reported, so the fold is checkable',
      g.raw === 6, String(g.raw));
  }

  // ══ 7. RED IS THE ONLY TIER THIS TOOL CAN WRITE ═══════════════════════
  // Asserted against the SOURCE, because the write goes out through a
  // subprocess and a unit test of toClaim() cannot see the --tier argument.
  //
  // Comments are stripped first. Guards in this repo have four times matched
  // the comment in the very file explaining why the guarded-against thing is
  // wrong, and passed while the code did the wrong thing.
  {
    const raw = fs.readFileSync(path.join(__dirname, 'draft.js'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

    const tiers = [...code.matchAll(/'(GREEN|ARITH|REPORTED|VERIFY|DEAD)'/g)].map((m) => m[1]);
    ok('the code cannot write any tier but RED',
      tiers.length === 0, `found: ${[...new Set(tiers)].join(', ')}`);
    ok("and it does pass --tier RED", /'--tier',\s*'RED'/.test(code));
    ok('every write declares itself as machine-origin',
      /'--origin',\s*'machine'/.test(code),
      'without this the desk cannot tell a drafted claim from a typed one');
    ok('and says what drafted it',
      /'--origin-note'/.test(code));

    // Drift check: the guard must fail if the wrong thing appears in CODE.
    const tampered = code.replace(/'--tier',\s*'RED'/, "'--tier', 'GREEN'");
    ok('the guard would catch a tier change (drift-tested)',
      /'GREEN'/.test(tampered));

    // ...and must NOT fire on the same word appearing only in a comment.
    const commentOnly = code + "\n// never write GREEN here\n";
    const strippedAgain = commentOnly.split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok('the guard ignores the word when it appears only in a comment',
      !/'GREEN'/.test(strippedAgain));

    ok('citations are never written from a url',
      !/citations|doc_id/.test(code), 'the bridge must not touch the citations table');
    ok('the desk is written through the CLI, not by SQL insert',
      !/insert\s+into/i.test(code));
  }

  // ══ 8. A DESK THAT CANNOT BE READ IS AN ERROR, NOT AN EMPTY DESK ══════
  // If "I could not look" returned [], every run would re-draft the entire
  // library on top of what is already there.
  {
    const { execFileSync } = require('child_process');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesk-'));
    let code = 0, out = '';
    try {
      out = execFileSync('node', [path.join(__dirname, 'draft.js'), 'somecase'],
        { encoding: 'utf8', env: { ...process.env, SENTINEL_ROOT: empty },
          stdio: 'pipe' });
    } catch (e) {
      code = e.status;
      out = (e.stdout || '') + (e.stderr || '');
    }
    ok('drafting against a desk that does not exist exits non-zero',
      code !== 0, `exit ${code}`);
    ok('and says how to create it rather than reporting nothing to do',
      /sdesk init/.test(out), out.slice(0, 200));
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  if (FAIL) process.exitCode = 1;
  return { pass: PASS, fail: FAIL };
};

if (require.main === module) {
  module.exports().then(() => { if (process.exitCode) process.exit(process.exitCode); });
}
