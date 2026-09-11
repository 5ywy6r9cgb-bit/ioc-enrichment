'use strict';

/**
 * reconcile — the same money, read from both ends.
 *
 * Every correction this desk has made came from one register disagreeing
 * with another. This is that method as a command.
 *
 * When committee A transfers money to committee B, TWO filings describe it:
 * A's Schedule B says it paid, B's Schedule A says it received. The two
 * should agree. When they do not, the difference is almost always one of
 * three dull things — a reporting-period boundary, an amendment that
 * restated one side, or a memo row counted on one side and not the other.
 *
 * It is occasionally something else. The command does not decide which; it
 * shows the rows that do not have a partner and says what would settle it.
 *
 * NOTHING HERE IS A FINDING ON ITS OWN. A gap between two filings is a
 * question for the filings, not an allegation about the filers.
 */

/** Rows that are not the filer's own money, and would double-count. */
function isPassThrough(row) {
  if (String(row.memo_code || '').trim()) return true;
  return /earmark/i.test(String(row.memo_text || ''));
}

function sum(rows) {
  return rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
}

/** Whole days between two YYYY-MM-DD strings. NaN if either is unusable. */
function daysApart(a, b) {
  const ta = Date.parse(`${String(a || '').slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${String(b || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return Math.round((tb - ta) / 86400000);
}

/**
 * Rows from a committee's Schedule B that name a given counterparty.
 *
 * Prefer the committee id: it is an identity, and a name is not. Two
 * Sherrod Browns taught this desk that once already. Fall back to an exact,
 * case-folded name match only when the register left the id blank, and say
 * so in the output rather than silently widening the filter.
 */
function sentTo(rows, counterpartyId, counterpartyName) {
  const id = String(counterpartyId || '').toUpperCase();
  const name = String(counterpartyName || '').trim().toUpperCase();
  const out = [];
  for (const r of rows) {
    const rid = String(r.recipient_committee_id || '').toUpperCase();
    if (rid) { if (rid === id) out.push({ ...r, matched_on: 'id' }); continue; }
    if (name && String(r.recipient || '').trim().toUpperCase() === name) {
      out.push({ ...r, matched_on: 'name' });
    }
  }
  return out;
}

/** Rows from a committee's Schedule A that name a given counterparty. */
function receivedFrom(rows, counterpartyId, counterpartyName) {
  const id = String(counterpartyId || '').toUpperCase();
  const name = String(counterpartyName || '').trim().toUpperCase();
  const out = [];
  for (const r of rows) {
    const rid = String(r.from_id || '').toUpperCase();
    if (rid) { if (rid === id) out.push({ ...r, matched_on: 'id' }); continue; }
    if (name && String(r.from || '').trim().toUpperCase() === name) {
      out.push({ ...r, matched_on: 'name' });
    }
  }
  return out;
}

const NEAR_DAYS = 31;

/**
 * Pair each sent row with a received row.
 *
 * Two passes, in order of how much they prove:
 *   1. same amount AND same date — the same transaction, beyond argument
 *   2. same amount, within NEAR_DAYS — the same transaction reported on
 *      different days, which is what a period boundary looks like
 *
 * Each row is consumed at most once. Pass 1 runs to completion before pass
 * 2 begins, so an exact partner is never spent on a near one.
 */
function pair(sent, received, opts = {}) {
  const nearDays = Number.isFinite(opts.nearDays) ? opts.nearDays : NEAR_DAYS;
  const s = sent.map((r, i) => ({ row: r, i, taken: false }));
  const r2 = received.map((r, i) => ({ row: r, i, taken: false }));
  const exact = [];
  const near = [];

  for (const a of s) {
    const hit = r2.find((b) => !b.taken
      && b.row.amount === a.row.amount
      && String(b.row.date || '') === String(a.row.date || ''));
    if (hit) { a.taken = true; hit.taken = true; exact.push({ sent: a.row, received: hit.row, lag: 0 }); }
  }
  for (const a of s) {
    if (a.taken) continue;
    let best = null;
    let bestLag = Infinity;
    for (const b of r2) {
      if (b.taken || b.row.amount !== a.row.amount) continue;
      const d = daysApart(a.row.date, b.row.date);
      if (Number.isNaN(d) || Math.abs(d) > nearDays) continue;
      if (Math.abs(d) < Math.abs(bestLag)) { best = b; bestLag = d; }
    }
    if (best) {
      a.taken = true; best.taken = true;
      near.push({ sent: a.row, received: best.row, lag: bestLag });
    }
  }

  return {
    exact,
    near,
    onlySent: s.filter((a) => !a.taken).map((a) => a.row),
    onlyReceived: r2.filter((b) => !b.taken).map((b) => b.row),
  };
}

/**
 * The whole comparison, with every total carrying its own denominator.
 *
 * Pass-through rows are EXCLUDED from the totals and counted separately. A
 * memo row is money the filer handled, not money the filer moved, and
 * including it on one side only is itself a source of phantom gaps — the
 * 119.2% coverage lesson, in a different register.
 */
function reconcile(sentRows, receivedRows, opts = {}) {
  const sentMemo = sentRows.filter(isPassThrough);
  const recvMemo = receivedRows.filter(isPassThrough);
  const sent = sentRows.filter((r) => !isPassThrough(r));
  const received = receivedRows.filter((r) => !isPassThrough(r));

  const sentTotal = sum(sent);
  const receivedTotal = sum(received);
  const gap = sentTotal - receivedTotal;
  const paired = pair(sent, received, opts);

  // A verdict names what the ROWS show. It never names a cause: the causes
  // live in documents this command has not read.
  let verdict;
  if (!sent.length && !received.length) verdict = 'no_rows';
  else if (gap === 0 && !paired.onlySent.length && !paired.onlyReceived.length) {
    verdict = 'reconciled';
  } else if (gap === 0) verdict = 'totals_agree_rows_do_not';
  else if (paired.onlySent.length && !paired.onlyReceived.length) verdict = 'sender_reports_more';
  else if (paired.onlyReceived.length && !paired.onlySent.length) verdict = 'recipient_reports_more';
  else verdict = 'both_sides_unmatched';

  return {
    verdict,
    sentTotal,
    receivedTotal,
    gap,
    // Which way the error runs, stated rather than left to the reader.
    direction: gap > 0 ? 'sender_higher' : (gap < 0 ? 'recipient_higher' : 'level'),
    sentRows: sent.length,
    receivedRows: received.length,
    ...paired,
    passThrough: {
      sent: sentMemo.length,
      received: recvMemo.length,
      sentAmount: sum(sentMemo),
      receivedAmount: sum(recvMemo),
    },
    // A name match is weaker than an id match, and the reader is owed the
    // count rather than a footnote.
    byName: sent.filter((r) => r.matched_on === 'name').length
      + received.filter((r) => r.matched_on === 'name').length,
  };
}

/**
 * The gap expressed against something. A raw dollar figure is not a finding
 * until it is a share of a total someone reported.
 */
function gapShare(result) {
  const base = Math.max(result.sentTotal, result.receivedTotal);
  if (!base) return null;
  return Math.abs(result.gap) / base;
}

/**
 * What would actually settle it — ordered by how cheap the check is.
 *
 * These are the boring explanations. They are listed because they are the
 * likely ones, and because a reader who has not been told them will reach
 * for a more interesting one.
 */
function nextSteps(result) {
  const out = [];
  if (result.near.length) {
    out.push('Rows matched on amount but not date. A transfer that crosses a '
      + 'reporting-period boundary is filed by each side in its own period. '
      + 'Check whether the lags cluster at a period end.');
  }
  if (result.onlySent.length || result.onlyReceived.length) {
    out.push('Compare the FILINGS, not the totals: an amendment restates a '
      + 'period, and the API serves the current version of each side, which '
      + 'may have been amended on different days.');
    out.push('sentinel connect filings --committee <id>   (on both sides; '
      + 'look for an F3/F3X amendment covering the unmatched dates)');
  }
  if (result.byName) {
    out.push(`${result.byName} row(s) matched on NAME because the register `
      + 'left the committee id blank. A name is not an identity — read those '
      + 'rows before relying on them.');
  }
  if (result.passThrough.sent || result.passThrough.received) {
    out.push('Memo rows were excluded from both totals. If one side itemises '
      + 'a transfer as a memo and the other does not, the gap is an artefact '
      + 'of that and not of the money.');
  }
  return out;
}

module.exports = {
  isPassThrough, sum, daysApart, sentTo, receivedFrom, pair, reconcile,
  gapShare, nextSteps, NEAR_DAYS,
};
