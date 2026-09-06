'use strict';
/**
 * books.js — how big is that firm's book, actually?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 *
 * `connect crosslink` finds registrants whose filings bridge several threads
 * of an investigation and, for most of them, prints NO DENOMINATOR: every
 * client the library knows for that firm arrived from the operator's own
 * searches, so "bridges 3 of 3 clients we know" is true of any firm at all.
 * Brownstein Hyatt topped that list on 4-of-4 and turned out to have 16,026
 * filings. A firm that size bridges four of anyone's subjects by arithmetic.
 *
 * `connect expand` already learns the missing number. The Senate LDA answers
 * a registrant-scoped query with `count`: the size of that firm's WHOLE
 * federal book. Expand printed it —
 *
 *     ok  MCNEES WALLACE & NURICK      101 filings total
 *     ok  AKIN GUMP STRAUSS HAUER    20001 filings total
 *
 * — and then dropped it on the floor. The next crosslink run said NO
 * DENOMINATOR over both, because nothing had written the answer down. The
 * operator paid for the call, read the number, and the desk forgot it.
 *
 * So: a small append-only ledger of book sizes, written by expand, read by
 * crosslink. No new network call ever — this only records what was already
 * fetched.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A BOOK SIZE IS, AND WHAT IT IS NOT
 *
 * It is a count of FILINGS, not of clients. A firm with 101 filings might
 * have four clients or forty. So this never computes "your threads ÷ its
 * clients" and calls that concentration — that ratio is exactly the
 * overclaim crosslink already refuses to print.
 *
 * What it supports is the comparison that actually separates a finding from
 * arithmetic: 101 against 20,001. A boutique carrying both a utility and a
 * data-centre operator is a lead. A firm with twenty thousand filings
 * carrying the same two is a firm with twenty thousand filings.
 *
 * It is also FEDERAL only, and Senate LDA only. A firm doing most of its work
 * before a state commission has a small federal book and a large practice,
 * and this number cannot tell you which you are looking at. That caveat
 * travels with the number wherever it is printed.
 */

const fs = require('fs');
const path = require('path');

/** Where the ledger lives. Inside evidence/, so it is gitignored like the rest. */
function ledgerPath(evidenceRoot) {
  return path.join(evidenceRoot, 'registrant_books.json');
}

/**
 * Read the ledger. A missing or unreadable file is an EMPTY ledger, never an
 * error: not knowing a firm's book size is the normal state, and the whole
 * design is that crosslink degrades to the warning it printed before.
 */
function read(evidenceRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(evidenceRoot), 'utf8'));
    return raw && typeof raw === 'object' && raw.books ? raw.books : {};
  } catch {
    return {};
  }
}

/**
 * Record what one registrant-scoped call reported.
 *
 * `total` must be a finite number. The LDA returns `count: null` for some
 * queries and a URL for others; either way the answer is "the source did not
 * say", and an unknown must not be written down as a fact. Passing a
 * non-number is a no-op that returns the ledger unchanged.
 */
function record(books, key, registrant, total, when) {
  if (!key) return books;
  if (!Number.isFinite(total)) return books;
  const prev = books[key];
  // A LATER answer wins. Book sizes grow: a firm that had 96 filings in March
  // has 101 in September, and keeping the first number seen would freeze the
  // ledger at whenever the operator happened to look first.
  if (prev && prev.asked_at && when && String(prev.asked_at) > String(when)) return books;
  books[key] = {
    registrant: registrant || (prev && prev.registrant) || '',
    filings: total,
    asked_at: when || new Date().toISOString(),
    source: 'Senate LDA, registrant-scoped count',
  };
  return books;
}

/** Write the ledger, creating the directory if the desk is brand new. */
function write(evidenceRoot, books) {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const payload = {
    what: 'How many federal lobbying filings each registrant has, in total.',
    caveat: 'Senate LDA only, and FEDERAL only. A firm that works mainly before '
      + 'a state commission has a small book here and may have a large practice. '
      + 'This is a count of FILINGS, not of clients.',
    written_by: 'sentinel connect expand',
    books,
  };
  fs.writeFileSync(ledgerPath(evidenceRoot), JSON.stringify(payload, null, 2));
  return ledgerPath(evidenceRoot);
}

/**
 * How to describe a book size in one word.
 *
 * The cut is deliberately coarse and deliberately stated, because the honest
 * content of this number is an order of magnitude, not a rank. Two firms at
 * 4,700 and 5,700 filings are the same firm for this purpose; 101 and 20,001
 * are not the same universe.
 */
function size(filings) {
  if (!Number.isFinite(filings)) return null;
  if (filings < 250) return 'SMALL BOOK';
  if (filings < 2000) return 'MID BOOK';
  return 'LARGE BOOK';
}

module.exports = { ledgerPath, read, record, write, size };
