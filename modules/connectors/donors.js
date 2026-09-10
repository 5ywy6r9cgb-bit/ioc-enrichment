#!/usr/bin/env node
'use strict';
/**
 * donors.js — who funded a committee, and how much of it that actually is.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE GAP THIS FILLS
 * ─────────────────────────────────────────────────────────────────────
 * `fecpac` reads Schedule B and Schedule E. Both are money OUT. There was
 * no way in this repo to read Schedule A for a committee — money IN — so
 * "whose money is this" could not be asked at all, and was asked anyway:
 *
 *   OHIO FLYER PAC, C00912865: $4,459,869, two candidates, one state.
 *
 * A committee that concentrated is only interesting once you know who paid
 * for it, and that answer lives in Schedule A.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SCHEDULE A IS NOT ALL THE MONEY, AND THIS IS THE WHOLE DISCIPLINE
 * ─────────────────────────────────────────────────────────────────────
 * Schedule A itemises contributions above $200. Everything below that is
 * reported only as a lump sum on the summary page. A committee funded by
 * ten thousand $50 donors has an almost EMPTY Schedule A.
 *
 * So the sum of Schedule A rows is never "the money that funded this
 * committee". It is the itemised part. Reporting the top donor's share of
 * the ITEMISED total as though it were their share of the whole is the
 * single easiest way to make a grassroots committee look captured, or a
 * captured one look broader than it is.
 *
 * Every result here therefore carries `coverage` — itemised total over
 * reported receipts, taken from the committee's own summary filing — and
 * refuses to state a share of the whole when coverage is low.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MEMO ROWS ARE SOMEONE ELSE'S MONEY
 * ─────────────────────────────────────────────────────────────────────
 * A conduit (ActBlue, WinRed, AIPAC) forwards earmarked contributions. On
 * the receiving committee's Schedule A those arrive with a memo code. The
 * conduit is the filer, not the donor. Counting them as the conduit's
 * giving is the error `fecpac` was built to stop, and it is the same error
 * here in the other direction.
 */

const API = 'https://api.open.fec.gov/v1';

/**
 * Schedule A — money INTO a committee.
 *
 * NOTE the absence of `is_individual`. The member view sets it false
 * because a candidate's PAC money is the question there. Here individuals
 * ARE the question: a super PAC's funders are usually people and companies,
 * not other committees.
 */
function receiptsUrl(committeeId, cycle, key, lastIndex, lastDate) {
  let u = `${API}/schedules/schedule_a/?api_key=${encodeURIComponent(key)}`
        + `&committee_id=${encodeURIComponent(committeeId)}`
        + `&two_year_transaction_period=${encodeURIComponent(cycle)}`
        + '&per_page=100&sort=-contribution_receipt_date';
  if (lastIndex) u += `&last_index=${encodeURIComponent(lastIndex)}`;
  if (lastDate) u += `&last_contribution_receipt_date=${encodeURIComponent(lastDate)}`;
  return u;
}

function parseReceipts(json) {
  return (json.results || []).map((r) => ({
    from: r.contributor_name || '',
    from_id: r.contributor_id || '',
    // The FEC's own classification. IND = individual, COM/PAC = committee,
    // ORG = organisation, CCM = candidate committee, PTY = party.
    kind: (r.entity_type || '').toUpperCase(),
    employer: r.contributor_employer || '',
    occupation: r.contributor_occupation || '',
    city: r.contributor_city || '',
    state: r.contributor_state || '',
    amount: Number(r.contribution_receipt_amount) || 0,
    date: (r.contribution_receipt_date || '').slice(0, 10),
    memo_code: r.memo_code || '',
    memo_text: r.memo_text || '',
  }));
}

/** A memo-coded row is money passing through, not money given by the filer. */
function isEarmarked(row) {
  return String(row.memo_code || '').trim() !== ''
    || /earmark/i.test(String(row.memo_text || ''));
}

const KINDS = {
  IND: 'individuals',
  ORG: 'organisations',
  COM: 'committees',
  PAC: 'committees',
  CCM: 'candidate committees',
  PTY: 'party committees',
};

/** What kind of money is this, in words a reader can check. */
function kindOf(row) {
  return KINDS[row.kind] || 'unclassified';
}

/**
 * Group rows by donor, keeping the categories apart.
 *
 * Returns one entry per donor with `direct` and `forwarded` separated, for
 * the same reason fecpac separates them: a conduit's row is not its gift.
 */
function byDonor(rows) {
  const out = new Map();
  for (const r of rows) {
    const name = r.from || '(unnamed)';
    if (!out.has(name)) {
      out.set(name, {
        name,
        kind: kindOf(r),
        direct: 0,
        forwarded: 0,
        rows: 0,
        employer: r.employer || '',
        occupation: r.occupation || '',
        where: [r.city, r.state].filter(Boolean).join(', '),
        first: r.date,
        last: r.date,
      });
    }
    const d = out.get(name);
    if (isEarmarked(r)) d.forwarded += r.amount;
    else d.direct += r.amount;
    d.rows += 1;
    if (r.date && (!d.first || r.date < d.first)) d.first = r.date;
    if (r.date && (!d.last || r.date > d.last)) d.last = r.date;
  }
  return [...out.values()].sort((a, b) => (b.direct + b.forwarded) - (a.direct + a.forwarded));
}

/** Totals by the FEC's own entity classification. */
function byKind(rows) {
  const out = new Map();
  for (const r of rows) {
    if (isEarmarked(r)) continue;
    const k = kindOf(r);
    out.set(k, (out.get(k) || 0) + r.amount);
  }
  return [...out.entries()]
    .map(([kind, amount]) => ({ kind, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * How much of the money this view can actually see.
 *
 * `receipts` comes from the committee's own summary filing. The itemised
 * sum comes from the rows. The gap is unitemised small-dollar money plus
 * anything the page cap cut off, and a reader who does not know the size of
 * that gap cannot read a top-donor share correctly.
 */
function coverage(itemisedTotal, totals, truncated) {
  if (!totals || !(totals.receipts > 0)) {
    return { share: null, receipts: null, itemised: itemisedTotal, truncated,
      verdict: 'unknown',
      note: 'The committee\'s summary totals were not read, so what share of '
        + 'its money these rows represent is unknown. Treat every figure as '
        + 'a floor.' };
  }
  const share = Math.round((itemisedTotal / totals.receipts) * 1000) / 10;
  let verdict;
  // OVER 100% IS NOT "VERY COMPLETE", IT IS A BROKEN DENOMINATOR.
  // The first live run printed "NEAR COMPLETE 119.2% of reported receipts",
  // which is not a coverage figure at all -- you cannot see more of the
  // money than exists. The cause was memo rows: an earmarked contribution
  // appears TWICE in Schedule A, once as the conduit's receipt and once as
  // the memo row naming the original giver. Summing both counted that money
  // twice. Subtracting the memo total landed within $2 of reported receipts.
  //
  // The rule stands even now that the caller passes direct-only: any share
  // materially above 100% means the denominator does not match the rows, and
  // a number that cannot be true must never be dressed as the best case.
  if (share > 105) verdict = 'over_reported';
  else if (truncated) verdict = 'truncated';
  else if (share >= 90) verdict = 'near_complete';
  else if (share >= 60) verdict = 'partial';
  else verdict = 'thin';
  return {
    share, receipts: totals.receipts, itemised: itemisedTotal, truncated,
    verdict,
    note: {
      over_reported: 'These rows sum to MORE than the committee reported '
        + 'receiving, which cannot be true and means the two numbers are not '
        + 'measuring the same thing. Usual cause: earmarked money counted '
        + 'twice, or rows from outside the summary\'s coverage period. No '
        + 'share below should be read until it is resolved.',
      truncated: 'A page cap was reached. These rows are a SAMPLE, not the '
        + 'itemised total, and no share below should be read as a share of '
        + 'anything.',
      near_complete: 'Itemised rows account for nearly all reported receipts, '
        + 'so shares below are close to shares of the whole.',
      partial: 'A meaningful part of this committee\'s money is not in these '
        + 'rows. Shares below are shares OF THE ITEMISED MONEY, not of the '
        + 'committee.',
      thin: 'Most of this committee\'s money is NOT itemised — it came in '
        + 'under the $200 reporting threshold or from sources not on '
        + 'Schedule A. A top-donor share computed here would describe a '
        + 'minority of the money and is not reported as a share of the '
        + 'committee.',
    }[verdict],
  };
}

/** Is it honest to state "X% of this committee's money"? */
function canStateShareOfWhole(cov) {
  return cov.verdict === 'near_complete';
}

/**
 * The summary a reader needs before any single donor is named.
 */
function summarise(rows, totals, truncated) {
  const direct = rows.filter((r) => !isEarmarked(r));
  const forwarded = rows.filter(isEarmarked);
  const directTotal = direct.reduce((a, r) => a + r.amount, 0);
  const forwardedTotal = forwarded.reduce((a, r) => a + r.amount, 0);
  const donors = byDonor(rows);
  // DIRECT ONLY. An earmarked contribution is in Schedule A twice — the
  // conduit's receipt AND the memo row naming who it came from — and only
  // one of those is a dollar the committee received. Summing both put
  // coverage at 119.2% on the first live run; direct-only landed within $2
  // of the committee's own reported receipts.
  const cov = coverage(directTotal, totals, truncated);
  return {
    rows: rows.length,
    direct_total: Math.round(directTotal * 100) / 100,
    forwarded_total: Math.round(forwardedTotal * 100) / 100,
    forwarded_rows: forwarded.length,
    distinct_donors: donors.length,
    by_kind: byKind(rows),
    coverage: cov,
    can_state_share_of_whole: canStateShareOfWhole(cov),
    donors,
  };
}

/** Keyset pagination, same contract as the other modules. */
async function collect(fetchJson, urlFor, parse, maxPages, hardCap, onPage) {
  const rows = [];
  let lastIndex = null, lastDate = null, pages = 0, truncated = false;
  for (;;) {
    const json = await fetchJson(urlFor(lastIndex, lastDate));
    const batch = parse(json);
    rows.push(...batch);
    pages += 1;
    if (onPage) onPage(pages, batch.length, rows.length, maxPages);
    const pg = json.pagination || {};
    const li = (pg.last_indexes || {});
    lastIndex = li.last_index || null;
    lastDate = li.last_contribution_receipt_date || null;
    if (!batch.length || !lastIndex) break;
    if (pages >= maxPages || rows.length >= hardCap) { truncated = true; break; }
  }
  return { rows, pages, truncated };
}

module.exports = {
  API, receiptsUrl, parseReceipts, isEarmarked, kindOf, KINDS,
  byDonor, byKind, coverage, canStateShareOfWhole, summarise, collect,
};
