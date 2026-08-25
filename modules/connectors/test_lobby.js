#!/usr/bin/env node
'use strict';
/**
 * test_lobby.js — the four ways lobbying data lies, each with a test.
 *
 * WHY THESE FOUR AND NOT A GENERAL TEST SUITE
 *
 * Every one of these produces a number that is WRONG AND LOOKS RIGHT. That
 * is the failure mode this whole system is built against: not a crash, not a
 * red line, but a plausible figure on a chart that nobody thinks to question.
 *
 *   1. income + expenses is a category error. Two different kinds of money.
 *   2. a quarter filed twice (Q2, Q2A) is one quarter, not two.
 *   3. a capture stops at 25 filings; a client with 60 gives you 25.
 *   4. a missing figure is not a reported zero.
 *
 * Each test below builds the exact capture shape that would produce the wrong
 * answer, and asserts the right one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lobby.js');
const CH = require('./lobby_chart.js');

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}
function eq(actual, expected, what) {
  ok(actual === expected, `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

/** Write a fake capture directory shaped exactly like the real connector's. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

function filing(o) {
  return {
    filing_uuid: o.uuid || Math.random().toString(36).slice(2),
    filing_year: o.year || 2024,
    filing_period: o.period || 'second_quarter',
    filing_period_display: o.periodDisplay || '2nd Quarter',
    filing_type: o.type || 'Q2',
    filing_type_display: o.typeDisplay || '2nd Quarter Report',
    dt_posted: o.posted || '2024-07-20T00:00:00Z',
    income: 'income' in o ? o.income : null,
    expenses: 'expenses' in o ? o.expenses : null,
    client: { name: o.client || 'CLIENT A' },
    registrant: { name: o.registrant || 'FIRM ONE' },
    lobbying_activities: o.activities || [],
    filing_document_url: 'https://lda.gov/filings/x',
  };
}

// ── 1. income and expenses are never summed ───────────────────────────────
{
  const dir = fixture({
    'live_capture_senatelda_client_a_2026-01-01T00-00-00.json': {
      count: 2,
      results: [
        filing({ client: 'CLIENT A', registrant: 'OUTSIDE FIRM', income: '100000', year: 2024 }),
        filing({ client: 'CLIENT A', registrant: 'CLIENT A', expenses: '250000', year: 2024, type: 'Q3', periodDisplay: '3rd Quarter' }),
      ],
    },
  });
  const { filings } = L.readFilings(dir);
  const a = L.analyse(L.dedupe(filings).filings);
  const y = a.byYear.find((r) => r.year === 2024);

  eq(y.income, 100000, 'income is reported on its own');
  eq(y.expenses, 250000, 'expenses are reported on their own');
  ok(!Object.prototype.hasOwnProperty.call(y, 'total'),
    'no combined total exists to be mistaken for one');
  // The wrong answer this guards against is $350,000 — plausible, and meaningless.
  ok(y.income + y.expenses === 350000 && y.income !== 350000 && y.expenses !== 350000,
    'the tempting wrong figure ($350,000) is nowhere in the output');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 2. amendments restate the quarter, they do not add to it ──────────────
{
  const dir = fixture({
    'live_capture_senatelda_client_a_2026-01-01T00-00-00.json': {
      count: 3,
      results: [
        filing({ uuid: 'orig', type: 'Q2', typeDisplay: '2nd Quarter Report',
          income: '40000', posted: '2024-07-20T00:00:00Z' }),
        filing({ uuid: 'amend', type: 'Q2A', typeDisplay: '2nd Quarter Amendment',
          income: '55000', posted: '2024-09-02T00:00:00Z' }),
        filing({ uuid: 'q3', type: 'Q3', period: 'third_quarter',
          periodDisplay: '3rd Quarter', income: '10000' }),
      ],
    },
  });
  const raw = L.readFilings(dir).filings;
  eq(raw.length, 3, 'all three filings are read from disk');

  const { filings, superseded } = L.dedupe(raw);
  eq(filings.length, 2, 'Q2 and Q2A collapse to one quarter');
  eq(superseded, 1, 'the collapse is counted, not silent');
  ok(filings.some((f) => f.uuid === 'amend'), 'the amendment wins over the original');

  const a = L.analyse(filings);
  eq(a.byYear[0].income, 65000, 'income counts the amendment once, not both filings');
  // 40000 + 55000 + 10000 = 105000 is the wrong answer that looks fine.
  ok(a.byYear[0].income !== 105000, 'the double-counted figure is not produced');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── two relationships must not collide into one ───────────────────────────
// Gluing names together with a separator makes "ALPINE GROUP"/"PARTNERS LLC"
// and "ALPINE"/"GROUP PARTNERS LLC" the same key. Two unrelated filings would
// then collapse into one and the loss would be invisible: fewer rows, no
// warning, every remaining figure still perfectly plausible.
{
  const dir = fixture({
    'live_capture_senatelda_split_2026-01-01T00-00-00.json': {
      count: 2,
      results: [
        filing({ registrant: 'ALPINE GROUP', client: 'PARTNERS LLC', income: '10000' }),
        filing({ registrant: 'ALPINE', client: 'GROUP PARTNERS LLC', income: '20000' }),
      ],
    },
  });
  const { filings, superseded } = L.dedupe(L.readFilings(dir).filings);
  eq(filings.length, 2, 'names that glue to the same string stay two filings');
  eq(superseded, 0, 'nothing was treated as an amendment of the other');
  eq(L.analyse(filings).edges.length, 2, 'and they stay two distinct relationships');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3. a truncated capture says so ────────────────────────────────────────
{
  const dir = fixture({
    'live_capture_senatelda_big_client_2026-01-01T00-00-00.json': {
      count: 60,
      results: [filing({ client: 'BIG CLIENT' })],
    },
    'live_capture_senatelda_small_client_2026-01-01T00-00-00.json': {
      count: 1,
      results: [filing({ client: 'SMALL CLIENT' })],
    },
    'live_capture_senatelda_no_count_2026-01-01T00-00-00.json': {
      results: [filing({ client: 'UNKNOWN COVERAGE' })],
    },
  });
  const { subjects } = L.readFilings(dir);
  const big = subjects.find((s) => s.subject.includes('big'));
  const small = subjects.find((s) => s.subject.includes('small'));
  const none = subjects.find((s) => s.subject.includes('no count'));

  eq(big.truncated, true, 'a capture holding 1 of 60 is flagged truncated');
  eq(big.total, 60, 'the shortfall is quantified from the raw count field');
  eq(small.truncated, false, 'a complete capture is not flagged');
  eq(none.total, null, 'a missing count reads as unknown coverage');
  eq(none.truncated, false, 'unknown coverage is not asserted as truncation either');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 4. a missing figure is not a reported zero ────────────────────────────
{
  eq(L.money(''), null, 'an empty income field is null, not 0');
  eq(L.money(null), null, 'an absent income field is null, not 0');
  eq(L.money(undefined), null, 'an undefined income field is null, not 0');
  eq(L.money('0'), 0, 'a genuinely reported zero survives as 0');
  eq(L.money('$1,250,000'), 1250000, 'a formatted figure parses');
  eq(L.money('n/a'), null, 'unparseable text is null, not NaN and not 0');

  eq(L.sumOrNull([null, null]), null, 'summing nothing reported stays null');
  eq(L.sumOrNull([null, 5, null]), 5, 'summing skips the nulls');
  eq(L.sumOrNull([0, null]), 0, 'a reported zero still totals zero');
  eq(L.sumOrNull([]), null, 'an empty set has no total');
}

// ── coverage arithmetic: counts mean "in this library" ────────────────────
{
  const dir = fixture({
    'live_capture_senatelda_aws_2026-01-01T00-00-00.json': {
      count: 2,
      results: [
        filing({ client: 'AWS PUBLIC POLICY', registrant: 'ALPINE GROUP', year: 2024 }),
        filing({ client: 'AWS PUBLIC POLICY', registrant: 'ALPINE GROUP', year: 2023,
          type: 'Q2', posted: '2023-07-20T00:00:00Z' }),
      ],
    },
    'live_capture_senatelda_nisource_2026-01-01T00-00-00.json': {
      count: 1,
      results: [filing({ client: 'NISOURCE INC.', registrant: 'ALPINE GROUP', year: 2024 })],
    },
  });
  const { filings } = L.readFilings(dir);
  const a = L.analyse(L.dedupe(filings).filings);
  const shared = L.sharedRegistrants(a);

  eq(shared.length, 1, 'a registrant with two captured clients is surfaced');
  eq(shared[0].clients.length, 2, 'both clients are listed');
  eq(a.edges.length, 2, 'each client-registrant pair is one edge');
  ok(a.clients.length === 2, 'clients are counted distinctly');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── an unparseable capture is excluded and reported, never skipped quietly ─
{
  const dir = fixture({
    'live_capture_senatelda_good_2026-01-01T00-00-00.json': { count: 1, results: [filing({})] },
    'live_capture_senatelda_broken_2026-01-01T00-00-00.json': '{"results": [ truncated',
    'live_capture_opencorporates_other_2026-01-01T00-00-00.json': { results: [{ name: 'x' }] },
  });
  const { filings, subjects, unparsed } = L.readFilings(dir);
  eq(unparsed.length, 1, 'the broken capture is listed as unparsed');
  eq(subjects.length, 1, 'it is not counted as covered');
  eq(filings.length, 1, 'only the good capture contributes filings');
  ok(!unparsed.some((u) => u.file.includes('opencorporates')),
    'a non-lobbying capture is not read as a broken lobbying one');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── period folding ────────────────────────────────────────────────────────
{
  eq(L.periodKey({ filing_period: 'second_quarter' }), 'Q2', 'second_quarter folds to Q2');
  eq(L.periodKey({ filing_period_display: '4th Quarter' }), 'Q4', '4th Quarter folds to Q4');
  eq(L.periodKey({ filing_period: 'mid_year' }), 'H1', 'mid_year folds to H1');
  eq(L.periodKey({}), '?', 'an absent period is unknown, not assumed to be Q1');
}

// ── the chart must state what it cannot show ──────────────────────────────
{
  const dir = fixture({
    'live_capture_senatelda_big_2026-01-01T00-00-00.json': {
      count: 60,
      results: [filing({ client: 'BIG CLIENT', income: '100000' })],
    },
  });
  const { filings, subjects, unparsed } = L.readFilings(dir);
  const d = L.dedupe(filings);
  const analysis = L.analyse(d.filings);
  const html = CH.render({
    analysis, shared: L.sharedRegistrants(analysis), subjects, unparsed,
    superseded: d.superseded, kept: d.filings.length, generated: '2026-01-01 00:00 UTC',
  });

  ok(/floors, not totals/.test(html), 'the page says truncated totals are floors');
  ok(/kept 1 of 60/.test(html), 'the page quantifies the shortfall');
  ok(/never added together/i.test(html), 'the page refuses to combine income and expenses');
  ok(/different scales/i.test(html), 'the page says the two money panels are scaled separately');
  ok(/in this library/.test(html), 'the page scopes every client count to the library');
  ok(/lead requiring a primary source/.test(html), 'the page keeps the evidentiary boundary');

  // A chart that fetches a script renders as a blank rectangle the day that
  // CDN moves. This page has to survive with the Wi-Fi off, permanently.
  ok(!/<script/i.test(html), 'the page runs no script');
  ok(!/\ssrc\s*=/i.test(html), 'the page pulls in no external resource');
  ok(!/<link\b/i.test(html), 'the page links no stylesheet');
  ok(!/@import/i.test(html), 'the page imports no stylesheet');
  ok(!/\b(fetch|XMLHttpRequest|cdn\.)/i.test(html), 'the page makes no request of its own');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── a small series must not be flattened by a large one ───────────────────
// $580,000 of income beside $15,020,000 of in-house expenses on one axis
// draws the income bars two pixels tall, and the chart then reads as
// "outside firms were paid approximately nothing" — false by three orders of
// magnitude, and perfectly calm about it.
{
  const rows = [
    { year: 2024, income: 250000, expenses: 7380000 },
    { year: 2025, income: 330000, expenses: 7640000 },
  ];
  const incomePane = CH.moneyPanel(rows, 'income', '#000', 'Income', 'note');
  const expensePane = CH.moneyPanel(rows, 'expenses', '#000', 'Expenses', 'note');

  // The top gridline label is the axis maximum for that panel alone.
  const axisOf = (svg) => (svg.match(/>(\$[\d,]+)</g) || []).map((m) => m.slice(1, -1));
  const incAxis = axisOf(incomePane);
  const expAxis = axisOf(expensePane);
  ok(incAxis.includes('$330,000') || incAxis.some((a) => /\$(3|4)\d{2},\d{3}/.test(a)),
    `the income panel is scaled to income (axis: ${incAxis.join(' ')})`);
  ok(expAxis.some((a) => /\$[78],\d{3},\d{3}/.test(a)),
    `the expenses panel is scaled to expenses (axis: ${expAxis.join(' ')})`);
  ok(incAxis.join() !== expAxis.join(), 'the two panels do not share an axis');

  // Independently scaled means the tallest bar in each panel is full height.
  const tallest = (svg) => Math.max(...[...svg.matchAll(/height="([\d.]+)"/g)].map((m) => +m[1]));
  ok(tallest(incomePane) > 100, 'the income bar is drawn at a readable height');

  const html = CH.yearBars(rows);
  ok(/different scales/i.test(html), 'and the page says the scales differ');
}

// ── a year with no figure filed is a dash, not a zero bar ─────────────────
{
  const pane = CH.moneyPanel(
    [{ year: 2024, income: 100000 }, { year: 2025, income: null }],
    'income', '#000', 'Income', 'note');
  ok(pane.includes('—'), 'a year with nothing reported is drawn as a dash');
  eq((pane.match(/<rect/g) || []).length, 1, 'and gets no bar at all, not a flat one');
}

// ── escaping: a client name is untrusted text ─────────────────────────────
{
  ok(CH.esc('<script>alert(1)</script>').indexOf('<script') === -1,
    'a registrant name containing markup cannot become markup');
  eq(CH.usd(null), '—', 'an absent figure renders as a dash, never as $0');
  eq(CH.usd(0), '$0', 'a reported zero renders as $0');
}

// ── an empty capture directory is a real answer, not a crash ──────────────
{
  const dir = fixture({});
  const { filings, subjects, unparsed } = L.readFilings(dir);
  eq(filings.length, 0, 'no captures means no filings');
  eq(subjects.length, 0, 'no captures means no coverage');
  eq(unparsed.length, 0, 'no captures means nothing failed to parse');
  fs.rmSync(dir, { recursive: true, force: true });

  const missing = L.readFilings(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()));
  eq(missing.filings.length, 0, 'a missing directory reads as empty, not as an exception');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
