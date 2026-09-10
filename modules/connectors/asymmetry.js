#!/usr/bin/env node
'use strict';
/**
 * asymmetry.js — concentration, measured against its own denominator.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY CONCENTRATION IS A SIGNAL
 * ─────────────────────────────────────────────────────────────────────
 * Most political committees spread money across many races. A few put all
 * of it on one. That difference is visible in the filings, requires no
 * inference about motive, and is not something anyone publishes — because
 * it only exists once you divide.
 *
 *   CITIZENS AGAINST AIPAC CORRUPTION, cycle 2024:
 *     $54,655 across 44 expenditures, 100% against one candidate.
 *
 * Single-purpose money. The purpose is on the filing.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AND WHY IT IS USELESS WITHOUT A BASE
 * ─────────────────────────────────────────────────────────────────────
 * THIS IS THE WHOLE POINT OF THE FILE. A committee with ONE expenditure is
 * 100% concentrated. So is a committee with two expenditures on the same
 * race. Neither means anything — the arithmetic guarantees the answer
 * before the data arrives.
 *
 * "100% concentrated" is a finding at 44 rows and $54,655. It is noise at 1
 * row and $200, and a tool that reports both the same way manufactures
 * findings out of small numbers. Every result here therefore carries n and
 * total, a MINIMUM below which nothing is called concentrated, and an
 * explicit verdict of `too_small` rather than a percentage that flatters.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO MEASURES, BECAUSE ONE HIDES THINGS
 * ─────────────────────────────────────────────────────────────────────
 *   TOP SHARE   the largest single target's share of the whole. Catches
 *               "all of it went to one place".
 *
 *   HHI         Herfindahl-Hirschman, the sum of squared shares. Catches
 *               "all of it went to three places", which a top share of 40%
 *               makes look diversified when it is not.
 *
 * A committee splitting evenly across 50 races scores ~0.02. One splitting
 * across 3 scores ~0.33. One on a single race scores 1.00.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT CONCENTRATION IS NOT
 * ─────────────────────────────────────────────────────────────────────
 * It is not intent, coordination, or wrongdoing. A committee formed in
 * September has one race left to spend on. A single-issue committee is
 * single-issue by design and says so in its name. A committee whose only
 * candidate lost early stops filing.
 *
 * The output says CONCENTRATED. It does not say why, and the reasons above
 * are printed with the result so the obvious innocent explanations are in
 * front of the reader before the number is.
 */

/**
 * Concentration of `rows` grouped by `key`.
 *
 * rows: [{ amount, ...}], key: (row) => string
 * Returns null when there is nothing to measure — never zero, because zero
 * is a claim about a distribution and no distribution exists.
 */
function concentrate(rows, key, { minRows = 5, minTotal = 1000, side = null } = {}) {
  if (!rows.length) return null;
  const byTarget = new Map();
  let total = 0;
  let forTotal = 0, againstTotal = 0;
  for (const r of rows) {
    const k = key(r) || '(unnamed)';
    const amt = Number(r.amount) || 0;
    const cur = byTarget.get(k) || { amount: 0, for: 0, against: 0 };
    cur.amount += amt;
    // WHICH WAY THE MONEY POINTED. Two committees that both appear at one
    // seat look like a pair until you read this field, and then one of them
    // is attacking the candidate the other is defending. Merging them into
    // "spent at this seat" manufactures a coalition out of an argument.
    if (side) {
      if (side(r) === 'O') { cur.against += amt; againstTotal += amt; }
      else { cur.for += amt; forTotal += amt; }
    }
    byTarget.set(k, cur);
    total += amt;
  }
  const targets = [...byTarget.entries()]
    .map(([name, v]) => ({ name, amount: v.amount, for: v.for, against: v.against }))
    .sort((a, b) => b.amount - a.amount);

  if (total <= 0) {
    return { rows: rows.length, total: 0, targets: targets.length,
      verdict: 'no_money', note: 'rows exist but carry no dollars' };
  }

  const shares = targets.map((t) => t.amount / total);
  const hhi = shares.reduce((a, s) => a + s * s, 0);
  const topShare = shares[0];

  // The gate. Below it the arithmetic decides the answer, not the data.
  const tooSmall = rows.length < minRows || total < minTotal;

  let verdict;
  if (tooSmall) verdict = 'too_small';
  else if (targets.length === 1) verdict = 'single_target';
  else if (topShare >= 0.9) verdict = 'concentrated';
  else if (hhi >= 0.25) verdict = 'narrow';
  else verdict = 'spread';

  return {
    rows: rows.length,
    total: Math.round(total * 100) / 100,
    targets: targets.length,
    top: targets[0],
    top_share: Math.round(topShare * 1000) / 10,
    hhi: Math.round(hhi * 1000) / 1000,
    // effective number of targets: 1/HHI. Reads more plainly than the index.
    effective_targets: Math.round((1 / hhi) * 10) / 10,
    verdict,
    min_rows: minRows,
    min_total: minTotal,
    // Present only when a side accessor was supplied. Absent means NOT
    // MEASURED, which is why it is undefined rather than zero.
    sides: side
      ? { for: Math.round(forTotal * 100) / 100,
        against: Math.round(againstTotal * 100) / 100,
        // A committee that only ever attacks is a different instrument from
        // one that only ever defends, and the mix is the plainest statement
        // of which it is.
        posture: againstTotal === 0 ? 'support_only'
          : forTotal === 0 ? 'opposition_only'
            : againstTotal / (forTotal + againstTotal) >= 0.5 ? 'mostly_opposition'
              : 'mostly_support' }
      : undefined,
    breakdown: targets.slice(0, 10),
    _caution: verdict === 'too_small'
      ? `${rows.length} row(s) and $${Math.round(total)} — below the floor of `
        + `${minRows} rows / $${minTotal}. At this size the arithmetic decides `
        + `the answer before the data does. Reported, not called concentrated.`
      : 'Concentration is not intent. A committee formed late has one race '
        + 'left; a single-issue committee is single-issue by design; a '
        + 'committee whose candidate lost early stops filing.',
  };
}

const VERDICTS = {
  single_target: 'every dollar named ONE target',
  concentrated: '90%+ on one target',
  narrow: 'a handful of targets, not a spread',
  spread: 'distributed across many targets',
  too_small: 'too few rows or dollars to mean anything',
  no_money: 'rows carry no dollars',
};

/** Rank many actors by how concentrated each one is. */
function rank(groups, opts) {
  const out = [];
  for (const [actor, rows] of groups) {
    const c = concentrate(rows, opts.key, opts);
    if (c) out.push({ actor, ...c });
  }
  const order = { single_target: 0, concentrated: 1, narrow: 2, spread: 3,
    too_small: 4, no_money: 5 };
  return out.sort((a, b) => {
    if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
    return b.total - a.total;
  });
}

/** Group rows into a Map keyed by actor. */
function groupBy(rows, actorKey) {
  const m = new Map();
  for (const r of rows) {
    const k = actorKey(r) || '(unnamed)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// The dimensions this can measure. Each is (actor, target) over a row set —
// the arithmetic is identical and only the two accessors change, which is
// why a fifth dimension costs two lines rather than a new module.
const DIMENSIONS = {
  // one committee's independent spending, across the candidates it named
  candidate: {
    label: 'a committee\'s spending, across the candidates it named',
    actor: (r) => r.by_committee_id || r.by,
    actorName: (r) => r.by,
    target: (r) => r.candidate || r.candidate_id || '(unnamed candidate)',
  },
  // one candidate's incoming outside money, across the committees spending it
  committee: {
    label: 'outside money at one candidate, across the committees spending it',
    actor: (r) => r.candidate || r.candidate_id,
    actorName: (r) => r.candidate,
    target: (r) => r.by || r.by_committee_id || '(unnamed committee)',
  },
  // one committee's payments, across the vendors it paid
  vendor: {
    label: 'a committee\'s payments, across the vendors it paid',
    actor: (r) => r.committee_id || r.committee || '(one committee)',
    actorName: (r) => r.committee || '',
    target: (r) => r.recipient || '(unnamed payee)',
  },
};

module.exports = { concentrate, rank, groupBy, VERDICTS, DIMENSIONS };
