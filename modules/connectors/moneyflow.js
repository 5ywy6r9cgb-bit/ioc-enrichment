'use strict';
/**
 * modules/connectors/moneyflow.js — every dollar figure already on disk,
 * as a payer to payee edge, with the kind of money never lost.
 *
 * -------------------------------------------------------------------------
 * WHY THIS IS ONE MODULE AND NOT FOUR REPORTS
 *
 * The desk already captures four separate federal money records, and each has
 * its own reader that reports it in isolation. That is why the obvious
 * question -- "what money is around this entity, from every direction" -- has
 * had no answer: the entity is a CLIENT in one file, a RECIPIENT in another,
 * and a PAYEE in a third, and nothing put those three facts next to each
 * other.
 *
 * This puts them next to each other. It does not merge them.
 *
 * -------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: NEVER SUM ACROSS KINDS
 *
 * A lobbying fee, a federal contract award, and an independent expenditure
 * are three different objects that happen to be denominated in dollars.
 *
 *   - A LOBBYING FEE is money that moved, in a quarter, for a service.
 *   - A CONTRACT AWARD is a ceiling authorised over a multi-year period.
 *     Much of it may never be spent. It is not a payment.
 *   - AN INDEPENDENT EXPENDITURE is money one committee spent on an ad,
 *     which tells you nothing about who gave that committee the money.
 *
 * Add them and you get a number that is arithmetically correct, visually
 * convincing, and means nothing at all. There is therefore NO grand total
 * anywhere in this module -- not as a field, not as a convenience, not
 * behind a flag. `summarise()` returns one total per kind and the CLI says
 * out loud why there is no line at the bottom.
 *
 * -------------------------------------------------------------------------
 * THE FAILURE THAT MADE THIS URGENT: THE SAME FILING, FIVE HUNDRED TIMES
 *
 * The capture directory on the live desk holds roughly five hundred
 * `senatelda` captures for ONE registrant, written one per second by a
 * pagination run. Every one of them contains the same filings.
 *
 * A naive reader that walked the directory adding up `income` would report
 * that registrant's lobbying revenue as five hundred times its real value,
 * with no warning, on a chart, sourced to real sworn filings. Nothing about
 * the output would look wrong.
 *
 * So every source below is deduplicated on the identity the SOURCE gives its
 * own rows, before a single figure is added:
 *
 *   senatelda      (registrant, client, year, period) -- which also collapses
 *                  amendments, since an amendment RESTATES a quarter rather
 *                  than adding to it
 *   fecspend       transaction_id / sub_id -- the FEC's own row identity
 *   usaspending    generated_internal_id / Award ID
 *   federalgrants  generated_internal_id / Award ID
 *
 * `readFlows` reports how many duplicate rows it dropped. A run that dropped
 * thousands is not an error -- it is the library being read correctly for
 * the first time -- but it must be visible, because the day that number is
 * ZERO on a directory that should have duplicates is the day the identity
 * keys stopped working.
 *
 * -------------------------------------------------------------------------
 * WHAT IS NOT IN HERE, STATED SO A NULL IS NEVER READ AS A ZERO
 *
 *   - STATE AND LOCAL MONEY, ENTIRELY. The FEC is federal office only. The
 *     LDA is the federal Congress and executive branch only. Ohio campaign
 *     finance, Ohio lobbying (JCARR/OLIG), county boards of elections and
 *     every municipal contract are absent from all four sources. For an
 *     Ohio subject this module can return nothing while large sums moved.
 *   - CANDIDATE COMMITTEE SPENDING. Schedule E is independent expenditures
 *     by non-candidate committees. A candidate's own spending is a different
 *     schedule and is not captured.
 *   - DONORS. Schedule E names who SPENT. Who funded the spender is
 *     Schedule A, and for a 501(c)(4) may not be filed anywhere.
 *   - FEDERAL LOANS AND LOAN GUARANTEES (award groups 07/08). Neither
 *     usaspending nor federalgrants requests them. A DOE Loan Programs
 *     Office loan is invisible here.
 *   - TAX ABATEMENTS. `doc abatements` reads GASB 77 disclosures out of
 *     audited annual reports, which are DOCUMENTS, not captures -- a
 *     different store with a different shape. Foregone revenue is also not
 *     a payment and would need its own kind. It is a deliberate gap, listed
 *     by the CLI so it reads as absent-by-design rather than as nothing
 *     found.
 *
 * Reads only what is already captured and hashed. Makes no network call.
 */

const fs = require('fs');
const path = require('path');
const X = require('./crosslink.js');
const REC = require('./recency.js');

// -------------------------------------------------------------------------
// THE KINDS OF MONEY
//
// `unit` is the field that stops the category error. Two flows may only be
// added when their kind is identical -- not when their unit merely matches --
// but the unit is what the report prints, because "authorised ceiling" and
// "reported paid" are the distinction a reader has to see before they read
// a number.
// -------------------------------------------------------------------------
const KINDS = {
  lobbying_fee: {
    label: 'lobbying fees',
    unit: 'reported paid, per quarter',
    what: 'a client paid an outside firm to lobby on its behalf',
    payerRole: 'client',
    payeeRole: 'lobbying firm',
    basis: 'senate_lda_filing',
    authority: 'Senate LDA LD-2, filed under 2 U.S.C. 1604',
  },
  lobbying_self_spend: {
    label: 'in-house lobbying spend',
    unit: 'reported spent, per quarter',
    // The payer and the payee are the SAME organisation. This is not a
    // transfer between two parties and must never be drawn as an arrow
    // between two nodes -- it is an organisation reporting what it spent on
    // itself. Kept as a separate kind for exactly that reason: folding it
    // into lobbying_fee would invent a counterparty that does not exist.
    unitNote: 'payer and payee are the same body',
    what: 'an organisation reported what it spent lobbying for itself',
    payerRole: 'organisation',
    payeeRole: 'itself',
    basis: 'senate_lda_filing',
    authority: 'Senate LDA LD-2, filed under 2 U.S.C. 1604',
  },
  independent_expenditure: {
    label: 'independent expenditures',
    unit: 'reported spent, per transaction',
    what: 'a committee spent to elect or defeat a named federal candidate',
    payerRole: 'spending committee',
    payeeRole: 'vendor paid',
    basis: 'fec_schedule_e',
    authority: 'FEC Form 3X Schedule E',
  },
  federal_contract: {
    label: 'federal contracts',
    unit: 'AWARD TOTAL over the award period -- a ceiling, not money moved',
    what: 'a federal agency awarded a procurement contract',
    payerRole: 'awarding agency',
    payeeRole: 'recipient',
    basis: 'usaspending_award',
    authority: 'USAspending, award groups A-D',
  },
  federal_grant: {
    label: 'federal grants and cooperative agreements',
    unit: 'AWARD TOTAL over the award period -- a ceiling, not money moved',
    what: 'a federal agency awarded a grant or cooperative agreement',
    payerRole: 'awarding agency',
    payeeRole: 'recipient',
    basis: 'usaspending_award',
    authority: 'USAspending, award groups 02-05',
  },
};

/** Money, or null. Never zero for a missing figure -- see lobby.js note 1. */
function amount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Sum that stays null until there is something real to add. */
function sumOrNull(values) {
  let total = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    total = (total === null ? 0 : total) + v;
  }
  return total;
}

function flow(o) {
  return {
    kind: o.kind,
    payer: o.payer || '',
    payee: o.payee || '',
    payer_key: X.normalise(o.payer || ''),
    payee_key: X.normalise(o.payee || ''),
    amount: o.amount === undefined ? null : o.amount,
    year: o.year || null,
    period: o.period || '',
    date: o.date || '',
    // For an independent expenditure: who the money was spent FOR or AGAINST.
    // This is not a party to the transaction and is never treated as one.
    about: o.about || '',
    purpose: o.purpose || '',
    basis: KINDS[o.kind].basis,
    url: o.url || '',
    capture: o.capture || '',
    row_id: o.row_id || '',
    // Layer A in the operator's model: a filed public record, asserted by the
    // filer, not inferred here.
    assertion: 'documented',
  };
}

// -------------------------------------------------------------------------
// READING THE LIBRARY
// -------------------------------------------------------------------------

/**
 * Coverage for one capture: what the source said existed vs. what is on disk.
 *
 * Reported BEFORE any figure that depends on it. A truncated capture yields a
 * floor, and a floor presented as a total is the silent-green failure this
 * whole desk is built against.
 */
function coverageOf(connector, body, rows) {
  const kept = rows.length;
  let total = null;

  if (connector === 'usaspending' || connector === 'federalgrants') {
    const pm = body && body.page_metadata;
    // USAspending reports `hasNext` rather than a count on this endpoint.
    // "more exist, how many is unstated" is a THIRD state, and it is not the
    // same as "complete" -- so total stays null and truncation is asserted
    // from hasNext on its own.
    if (pm && Number.isFinite(pm.count)) total = pm.count;
    return {
      kept,
      total,
      truncated: !!(pm && pm.hasNext) || (Number.isFinite(total) && total > kept),
      totalUnknown: !Number.isFinite(total),
    };
  }

  if (connector === 'senatelda') {
    total = body && Number.isFinite(body.count) ? body.count : null;
  } else if (connector === 'fecspend') {
    const pg = body && body.pagination;
    total = pg && Number.isFinite(pg.count) ? pg.count : null;
  }

  return {
    kept,
    total,
    truncated: Number.isFinite(total) && total > kept,
    totalUnknown: !Number.isFinite(total),
  };
}

/** Same folding as lobby.js periodKey -- kept in step deliberately. */
function ldaPeriod(r) {
  const raw = String(r.filing_period || r.filing_period_display || '').toLowerCase();
  if (/1st|q1|first/.test(raw)) return 'Q1';
  if (/2nd|q2|second/.test(raw)) return 'Q2';
  if (/3rd|q3|third/.test(raw)) return 'Q3';
  if (/4th|q4|fourth/.test(raw)) return 'Q4';
  if (/mid|1st half|first half/.test(raw)) return 'H1';
  if (/year|2nd half|second half/.test(raw)) return 'H2';
  return raw ? raw.slice(0, 12) : '';
}

function issuesOf(r) {
  return [...new Set((r.lobbying_activities || [])
    .map((a) => a.general_issue_code_display || a.general_issue_code)
    .filter(Boolean))].join(', ');
}

/** Senate LDA rows to lobbying_fee and lobbying_self_spend flows. */
function ldaFlows(rows, file) {
  const out = [];
  for (const r of rows) {
    const client = (r.client && r.client.name) || '';
    const registrant = (r.registrant && r.registrant.name) || '';
    if (!client && !registrant) continue;

    const period = ldaPeriod(r);
    const base = {
      year: r.filing_year || null,
      period,
      date: r.dt_posted ? String(r.dt_posted).slice(0, 10) : '',
      url: r.filing_document_url || '',
      capture: file,
      // The dedupe identity is the RELATIONSHIP-QUARTER, not the filing uuid:
      // an amendment has a different uuid and restates the same quarter, so
      // keying on uuid would keep both and double the quarter.
      row_id: JSON.stringify([registrant, client, r.filing_year || null, period]),
    };
    const income = amount(r.income);
    const expenses = amount(r.expenses);

    // A filing carries income OR expenses, never both meaningfully. Both are
    // emitted when both are present rather than picking one, because a filing
    // reporting both is a data oddity the operator should see, not one this
    // file should silently resolve. A filing reporting NEITHER still produces
    // the relationship row with a null amount: the relationship is a fact
    // even when the money is unreported.
    if (income !== null || expenses === null) {
      out.push(flow(Object.assign({}, base, {
        kind: 'lobbying_fee',
        payer: client,
        payee: registrant,
        amount: income,
        purpose: issuesOf(r),
      })));
    }
    if (expenses !== null) {
      out.push(flow(Object.assign({}, base, {
        kind: 'lobbying_self_spend',
        // Payer and payee are the same body. Stated identically on both sides
        // so nothing downstream can draw it as a transfer.
        payer: client || registrant,
        payee: client || registrant,
        amount: expenses,
        purpose: issuesOf(r),
        row_id: base.row_id + '|self',
      })));
    }
  }
  return out;
}

/** FEC Schedule E rows to independent_expenditure flows. */
function fecFlows(rows, file) {
  const out = [];
  for (const r of rows) {
    const spender = r.spender_name || (r.committee && r.committee.name) || '';
    if (!spender) continue;

    const c = String(r.support_oppose_indicator || '').trim().toUpperCase();
    // Spelled out, never abbreviated. Roughly half of large independent
    // expenditure money is spent AGAINST someone, and an S/O letter that can
    // be skimmed past reverses the meaning of the number beside it.
    const dir = c === 'S' ? 'SUPPORTING'
      : c === 'O' ? 'OPPOSING'
      : '(direction not stated on this row)';
    const target = [
      r.candidate_name || r.candidate_id || '(candidate not named)',
      r.candidate_office_full || r.candidate_office || '',
      r.candidate_office_state || '',
    ].filter(Boolean).join(' / ');
    const date = r.expenditure_date ? String(r.expenditure_date).slice(0, 10) : '';

    out.push(flow({
      kind: 'independent_expenditure',
      payer: spender,
      // The payee is the VENDOR -- a media buyer or consultancy. The same
      // vendor under two committees that present as unrelated is the finding
      // this row exists for.
      payee: r.payee_name || '(payee not named on row)',
      amount: amount(r.expenditure_amount),
      date,
      year: date ? Number(date.slice(0, 4)) : null,
      about: dir + ' ' + target,
      purpose: r.expenditure_description || '',
      url: r.pdf_url || '',
      capture: file,
      row_id: [r.transaction_id, r.sub_id, r.link_id].filter(Boolean).join('/')
        || [spender, date, r.expenditure_amount, r.payee_name || ''].join('|'),
    }));
  }
  return out;
}

/** USAspending award rows to federal_contract / federal_grant flows. */
function awardFlows(rows, file, kind) {
  const out = [];
  for (const r of rows) {
    const recipient = r['Recipient Name'] || '';
    if (!recipient) continue;
    const start = r['Start Date'] || '';
    const end = r['End Date'] || '';
    out.push(flow({
      kind,
      payer: r['Awarding Agency'] || '(agency not named on row)',
      payee: recipient,
      amount: amount(r['Award Amount']),
      date: start ? String(start).slice(0, 10) : '',
      year: start ? Number(String(start).slice(0, 4)) : null,
      period: [start, end].filter(Boolean).join(' to '),
      purpose: String(r.Description || '').slice(0, 140),
      url: r.generated_internal_id
        ? 'https://www.usaspending.gov/award/' + r.generated_internal_id : '',
      capture: file,
      // A row with neither id cannot be deduplicated on identity, so it falls
      // back to its own content. Two genuinely distinct awards with identical
      // agency, recipient, amount and dates would collapse -- that is the
      // safer direction: understating is recoverable, a multiplied total is
      // not.
      row_id: r.generated_internal_id || r['Award ID']
        || [kind, r['Awarding Agency'] || '', recipient, r['Award Amount'], start, end].join('|'),
    }));
  }
  return out;
}

const READERS = {
  senatelda: (b, f) => ldaFlows(Array.isArray(b.results) ? b.results : [], f),
  fecspend: (b, f) => fecFlows(Array.isArray(b.results) ? b.results : [], f),
  usaspending: (b, f) => awardFlows(Array.isArray(b.results) ? b.results : [], f, 'federal_contract'),
  federalgrants: (b, f) => awardFlows(Array.isArray(b.results) ? b.results : [], f, 'federal_grant'),
};

/** Connectors this module reads. Everything else on disk is skipped. */
const MONEY_CONNECTORS = Object.keys(READERS);

/**
 * Read every money-bearing capture on disk.
 *
 * Returns { flows, sources, unparsed, duplicatesDropped, capturesRead }.
 *
 * `flows` is deduplicated on each source's own row identity -- see the
 * five-hundred-captures note at the top of this file. Without that step the
 * totals are multiplied by however many times a search was re-run.
 */
function readFlows(captureDir) {
  const sources = [];
  const unparsed = [];
  const seen = new Map();          // "kind row_id" -> flow
  let duplicatesDropped = 0;

  const captures = REC.scan(captureDir)
    .filter((c) => MONEY_CONNECTORS.includes(c.connector))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));

  for (const cap of captures) {
    let body;
    try {
      body = JSON.parse(fs.readFileSync(path.join(captureDir, cap.file), 'utf8'));
    } catch (e) {
      unparsed.push({ file: cap.file, connector: cap.connector, error: e.message });
      continue;
    }
    const rows = Array.isArray(body.results) ? body.results : [];
    sources.push(Object.assign({
      connector: cap.connector,
      subject: String(cap.slug || '').replace(/_/g, ' '),
      file: cap.file,
      at: cap.at,
    }, coverageOf(cap.connector, body, rows)));

    for (const f of READERS[cap.connector](body, cap.file)) {
      // Namespaced by kind: a USAspending Award ID and an FEC transaction id
      // are both short strings from different universes and could collide.
      const k = f.kind + ' ' + f.row_id;
      if (seen.has(k)) {
        duplicatesDropped++;
        // Keep the row from the capture carrying a URL over one without; the
        // rest of the row is identical by construction.
        const prev = seen.get(k);
        if (!prev.url && f.url) seen.set(k, f);
        continue;
      }
      seen.set(k, f);
    }
  }

  return {
    flows: [...seen.values()],
    sources,
    unparsed,
    duplicatesDropped,
    capturesRead: captures.length,
  };
}

// -------------------------------------------------------------------------
// ASKING ABOUT ONE ENTITY
// -------------------------------------------------------------------------

/**
 * Find the flows touching an entity.
 *
 * TWO MATCH MODES, AND THE DIFFERENCE IS NOT COSMETIC.
 *
 * EXACT is the normalised name matching a party's normalised name. It cannot
 * merge two companies.
 *
 * WIDE is a substring match on the normalised key, used only when exact
 * returns nothing -- because an operator types "Vantage" and the filings say
 * "Vantage Data Centers Management Company LLC". It is also how two DIFFERENT
 * legal entities get silently merged: "Vantage Data Centers LLC" and "Vantage
 * Data Centers OH-E LLC" are separate corporations with separate filings, and
 * a substring match adds their money together as though one body spent it.
 *
 * So a wide match NEVER happens silently. The result carries `widened: true`
 * and `names` -- every distinct legal name that matched -- and the caller is
 * required to show them. Deciding those names are one company is an
 * identification the operator makes against a corporate record. It is not
 * something this file may assume from a shared prefix.
 */
function flowsFor(flows, entity, opts = {}) {
  const q = X.normalise(entity || '');
  if (!q) return { query: entity || '', key: '', widened: false, names: [], hits: [] };

  const touches = (f, test) => test(f.payer_key) || test(f.payee_key)
    || (f.about ? test(X.normalise(f.about)) : false);

  let hits = flows.filter((f) => touches(f, (k) => k === q));
  let widened = false;
  if (!hits.length && opts.exact !== true) {
    hits = flows.filter((f) => touches(f, (k) => !!k && k.includes(q)));
    widened = hits.length > 0;
  }

  // Every distinct legal name behind the match. This is the list that stops a
  // widened match from becoming an unstated claim of identity.
  const test = widened ? (k) => !!k && k.includes(q) : (k) => k === q;
  const names = new Set();
  for (const f of hits) {
    if (test(f.payer_key)) names.add(f.payer);
    if (test(f.payee_key)) names.add(f.payee);
  }

  return { query: entity, key: q, widened, names: [...names].sort(), hits };
}

/** The matcher `flowsFor` used, so callers cannot drift out of step with it. */
function matcher(key, widened) {
  return widened ? (k) => !!k && k.includes(key) : (k) => k === key;
}

/** Split an entity's flows by direction. */
function directions(hits, key, widened) {
  const test = matcher(key, widened);
  const out = { paid: [], received: [], self: [], mentioned: [] };
  for (const f of hits) {
    const isPayer = test(f.payer_key);
    const isPayee = test(f.payee_key);
    // In-house lobbying names the same body on both sides. It is neither
    // money out to someone nor money in from someone; calling it either
    // invents a counterparty.
    if (f.kind === 'lobbying_self_spend' && isPayer && isPayee) out.self.push(f);
    else if (isPayer) out.paid.push(f);
    else if (isPayee) out.received.push(f);
    else out.mentioned.push(f);   // the target of an independent expenditure
  }
  return out;
}

/**
 * Totals, PER KIND, and never across them.
 *
 * There is deliberately no `total` field on the return value. See the header:
 * a figure that adds a contract ceiling to a lobbying fee is arithmetically
 * correct and factually meaningless, and the only reliable way to stop one
 * being published is for it never to exist.
 */
function summarise(hits) {
  const byKind = new Map();
  for (const f of hits) {
    if (!byKind.has(f.kind)) {
      byKind.set(f.kind, {
        kind: f.kind,
        label: KINDS[f.kind].label,
        unit: KINDS[f.kind].unit,
        authority: KINDS[f.kind].authority,
        rows: 0,
        // "Reported nothing" and "reported $0" are different facts and are
        // counted apart. Collapsing them makes an absent disclosure look
        // like a disclosed absence.
        rowsWithNoAmount: 0,
        amounts: [],
        years: new Set(),
      });
    }
    const s = byKind.get(f.kind);
    s.rows++;
    if (f.amount === null) s.rowsWithNoAmount++;
    else s.amounts.push(f.amount);
    if (f.year) s.years.add(String(f.year));
  }
  return [...byKind.values()].map((s) => ({
    kind: s.kind,
    label: s.label,
    unit: s.unit,
    authority: s.authority,
    rows: s.rows,
    rowsWithNoAmount: s.rowsWithNoAmount,
    rowsWithAmount: s.amounts.length,
    reported: sumOrNull(s.amounts),
    years: [...s.years].sort(),
  })).sort((a, b) => b.rows - a.rows || a.kind.localeCompare(b.kind));
}

/**
 * Roll an entity's flows up by the party on the other side.
 *
 * Kind is part of the key, not just a label on the row: the same counterparty
 * may appear as a lobbying firm and as an awarding agency, and those two
 * relationships must not share a total.
 */
function byCounterparty(hits, key, widened) {
  const test = matcher(key, widened);
  const map = new Map();
  for (const f of hits) {
    const isPayer = test(f.payer_key);
    const other = isPayer ? f.payee : f.payer;
    const dir = f.kind === 'lobbying_self_spend' ? 'self' : (isPayer ? 'paid' : 'received');
    const k = JSON.stringify([f.kind, dir, X.normalise(other)]);
    if (!map.has(k)) {
      map.set(k, {
        kind: f.kind,
        label: KINDS[f.kind].label,
        direction: dir,
        counterparty: other,
        rows: 0,
        amounts: [],
        years: new Set(),
        urls: new Set(),
        names: new Set(),
      });
    }
    const e = map.get(k);
    e.rows++;
    e.names.add(other);
    if (f.amount !== null) e.amounts.push(f.amount);
    if (f.year) e.years.add(String(f.year));
    if (f.url) e.urls.add(f.url);
  }
  return [...map.values()].map((e) => ({
    kind: e.kind,
    label: e.label,
    direction: e.direction,
    counterparty: e.counterparty,
    // Distinct raw spellings folded into this row, so a normalisation that
    // merged two real bodies is visible rather than assumed correct.
    names: [...e.names].sort(),
    rows: e.rows,
    rowsWithAmount: e.amounts.length,
    reported: sumOrNull(e.amounts),
    years: [...e.years].sort(),
    urls: [...e.urls].slice(0, 3),
  })).sort((a, b) => (b.reported || 0) - (a.reported || 0) || b.rows - a.rows);
}

/**
 * A per-year series, PER KIND. Same rule: never merged.
 *
 * A year with rows but no reported figure returns null rather than 0, so a
 * gap in disclosure never draws as a dip in spending.
 */
function series(hits) {
  const map = new Map();
  for (const f of hits) {
    if (!f.year) continue;
    const k = JSON.stringify([f.kind, String(f.year)]);
    if (!map.has(k)) {
      map.set(k, { kind: f.kind, label: KINDS[f.kind].label,
        year: String(f.year), rows: 0, amounts: [] });
    }
    const e = map.get(k);
    e.rows++;
    if (f.amount !== null) e.amounts.push(f.amount);
  }
  return [...map.values()].map((e) => ({
    kind: e.kind,
    label: e.label,
    year: e.year,
    rows: e.rows,
    rowsWithAmount: e.amounts.length,
    reported: sumOrNull(e.amounts),
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.year.localeCompare(b.year));
}

/**
 * Coverage, folded per connector and per subject.
 *
 * ONE LINE PER SUBJECT, not per capture: five hundred captures of one
 * registrant produced five hundred identical truncation warnings on the live
 * desk and pushed the analysis off the top of the scrollback. A warning that
 * buries what it is warning about is not a warning.
 */
function coverage(sources) {
  const map = new Map();
  for (const s of sources) {
    const k = s.connector + ' ' + s.subject;
    if (!map.has(k)) {
      map.set(k, {
        connector: s.connector,
        subject: s.subject,
        captures: 0,
        truncated: 0,
        totalUnknown: 0,
        worstKept: null,
        worstTotal: null,
      });
    }
    const e = map.get(k);
    e.captures++;
    if (s.truncated) e.truncated++;
    if (s.totalUnknown) e.totalUnknown++;
    if (Number.isFinite(s.total) && (e.worstTotal === null || s.total > e.worstTotal)) {
      e.worstTotal = s.total;
      e.worstKept = s.kept;
    }
  }
  return [...map.values()].sort((a, b) =>
    (b.worstTotal || 0) - (a.worstTotal || 0) || a.subject.localeCompare(b.subject));
}

module.exports = {
  KINDS, MONEY_CONNECTORS,
  amount, sumOrNull, flow,
  readFlows, coverageOf, coverage,
  flowsFor, matcher, directions, summarise, byCounterparty, series,
  ldaFlows, fecFlows, awardFlows, ldaPeriod,
};
