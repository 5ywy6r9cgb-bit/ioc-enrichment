#!/usr/bin/env node
/**
 * test_books.js — the desk must not forget a number it already paid for.
 *
 * THE DEFECT THIS EXISTS TO STOP
 *   `connect expand` asked the Senate LDA how many filings each registrant
 *   has, printed the answer, and dropped it. The next `connect crosslink` run
 *   then printed NO DENOMINATOR over firms whose denominator had just been
 *   fetched and read aloud. Nothing failed. The operator simply paid for the
 *   same fact twice and kept it zero times.
 *
 *   Nothing in the suite could have caught that, because every test asked
 *   whether the call was made correctly and none asked whether the ANSWER
 *   survived the function that received it.
 *
 * READING SOURCE
 *   Comment lines are stripped before any source is scanned. Six green tests
 *   in this repository have matched a phrase inside their own explanation.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const B = require('./books.js');
const X = require('./crosslink.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}

function uncommented(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

console.log('\n== book sizes: the denominator, kept ==\n');

// ── the ledger ────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-books-'));

ok(Object.keys(B.read(root)).length === 0, 'a desk with no ledger reads an empty one');
ok(Object.keys(B.read(path.join(root, 'nope', 'nope'))).length === 0,
  'and a missing directory is empty, not a crash');

{
  const books = {};
  B.record(books, 'mcnees wallace & nurick', 'MCNEES WALLACE & NURICK', 101, '2026-09-06T00:00:00Z');
  B.record(books, 'akin gump', 'AKIN GUMP STRAUSS HAUER & FELD', 20001, '2026-09-06T00:00:00Z');
  ok(books['mcnees wallace & nurick'].filings === 101, 'a recorded total is kept');
  ok(books['akin gump'].filings === 20001, 'and so is a large one');

  // UNKNOWN IS NOT ZERO. The LDA answers `count: null` for some queries and a
  // URL for others. Writing either down as a number would put a fact in the
  // ledger that no source ever stated, and it would then sort ABOVE every
  // measured firm as the smallest book on the desk.
  B.record(books, 'unknown co', 'UNKNOWN CO', null, '2026-09-06T00:00:00Z');
  B.record(books, 'weird co', 'WEIRD CO', 'https://example.gov/count', '2026-09-06T00:00:00Z');
  B.record(books, 'nan co', 'NAN CO', NaN, '2026-09-06T00:00:00Z');
  ok(!('unknown co' in books), 'a null count is not written down as a fact');
  ok(!('weird co' in books), 'and neither is a URL where a number was expected');
  ok(!('nan co' in books), 'and neither is NaN');
  ok(B.record(books, '', 'NO KEY', 5, '2026-09-06T00:00:00Z') === books,
    'a row with no key is a no-op, not a crash');

  // Book sizes GROW. Freezing the first number seen would leave the ledger
  // reporting a firm's size as of whenever the operator first happened to look.
  B.record(books, 'mcnees wallace & nurick', 'MCNEES WALLACE & NURICK', 108, '2026-12-01T00:00:00Z');
  ok(books['mcnees wallace & nurick'].filings === 108, 'a later answer replaces an earlier one');
  B.record(books, 'mcnees wallace & nurick', 'MCNEES WALLACE & NURICK', 44, '2026-01-01T00:00:00Z');
  ok(books['mcnees wallace & nurick'].filings === 108, 'and an older answer does not overwrite a newer');

  const p = B.write(root, books);
  ok(fs.existsSync(p), 'the ledger is written');
  const back = B.read(root);
  ok(back['akin gump'].filings === 20001, 'and reads back');

  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok(/FILINGS, not of clients/.test(raw.caveat),
    'the file says on its face that these are filings, not clients');
  ok(/FEDERAL only/.test(raw.caveat), 'and that it is federal only');
}

// ── the size bands ────────────────────────────────────────────────────
ok(B.size(101) === 'SMALL BOOK', '101 filings is a small book');
ok(B.size(20001) === 'LARGE BOOK', '20,001 filings is a large book');
ok(B.size(null) === null, 'an unknown size has no band');
ok(B.size(undefined) === null, 'and neither does a missing one');

// ── crosslink uses it, and ranks on it ────────────────────────────────
//
// The shape that matters: two firms, identical in every way the desk could
// previously see -- same number of threads bridged, same clients, both known
// only from the operator's own searches -- and one of them has a hundred
// filings while the other has twenty thousand. Before the ledger those two
// rows were indistinguishable. The small book must now come first.
{
  const edges = [];
  const mk = (registrant, client, subject, year) => edges.push({
    registrant, registrant_key: X.normalise(registrant),
    client, client_key: X.normalise(client),
    subject, year, period: `${year}Q1`,
    filing_id: `${registrant}-${client}-${year}`,
  });
  // ORDER IS ADVERSARIAL ON PURPOSE. Every earlier tiebreaker is equal for
  // these two firms, so the list falls through to insertion order. Written
  // the other way round, this test passes with the new sort DELETED -- which
  // is exactly what happened on the first draft of it. The firm that must end
  // up second is inserted first.
  mk('UNASKED LLP', 'A UTILITY CO', 'A Utility Co', 2025);
  mk('UNASKED LLP', 'A DATACENTER CO', 'A Datacenter Co', 2025);
  mk('MEGAFIRM LLP', 'A UTILITY CO', 'A Utility Co', 2025);
  mk('MEGAFIRM LLP', 'A DATACENTER CO', 'A Datacenter Co', 2025);
  mk('BOUTIQUE LLP', 'A UTILITY CO', 'A Utility Co', 2025);
  mk('BOUTIQUE LLP', 'A DATACENTER CO', 'A Datacenter Co', 2025);

  const bare = X.concentrated(edges, {});
  ok(bare.length === 3, `all three firms show without a ledger (got ${bare.length})`);
  ok(bare[0].registrant === 'UNASKED LLP',
    `without a ledger the order is insertion order (got ${bare[0].registrant})`);
  ok(bare.every((g) => g.book_filings === null),
    'and neither claims a book size nobody looked up');
  ok(bare.every((g) => g.denominator_is_search_list === true),
    'both correctly report they have no denominator');

  const books = {};
  B.record(books, X.normalise('MEGAFIRM LLP'), 'MEGAFIRM LLP', 20001, '2026-09-06T00:00:00Z');
  B.record(books, X.normalise('BOUTIQUE LLP'), 'BOUTIQUE LLP', 101, '2026-09-06T00:00:00Z');
  const withBooks = X.concentrated(edges, { books });

  ok(withBooks[0].registrant === 'BOUTIQUE LLP',
    `the small book sorts first (got ${withBooks[0].registrant})`);
  ok(withBooks[0].book_filings === 101, 'and carries its real size');
  ok(withBooks[1].book_filings === 20001, 'and the large one carries its own');

  // A firm nobody asked about must not be promoted past one that WAS measured
  // merely by being unknown -- the same rule that already governs `blind`.
  // UNASKED was inserted first, so without the rule it stays first.
  const names = withBooks.map((g) => g.registrant);
  ok(names.indexOf('UNASKED LLP') > names.indexOf('MEGAFIRM LLP'),
    `an unmeasured firm ranks below every measured one (got ${names.join(' > ')})`);
  ok(withBooks.find((g) => g.registrant === 'UNASKED LLP').book_filings === null,
    'and still says it has no book size');
}

// ── EXPAND MUST NOT DISCARD WHAT IT FETCHED ───────────────────────────
//
// The original defect, guarded at the source. `cmdExpand` reads `body.count`
// into a local, prints it, and returns. Nothing downstream could tell the
// difference between "the firm has 101 filings" and "nobody has ever asked",
// which is precisely the distinction the operator needed.
{
  const cli = uncommented(path.join(__dirname, 'cli.js'));
  const expand = cli.slice(cli.indexOf('async function cmdExpand'));
  const body = expand.slice(0, expand.indexOf('async function ', 10));
  ok(/B\.record\(/.test(body), 'cmdExpand records each total it receives');
  ok(/B\.write\(/.test(body), 'and writes the ledger before it returns');
  ok(/B\.read\(/.test(body), 'and loads the existing one first, rather than replacing it');

  const cross = cli.slice(cli.indexOf('function cmdCrosslink'));
  ok(/books: B\.read\(/.test(cross.slice(0, 4000)),
    'cmdCrosslink passes the ledger to concentrated()');
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
