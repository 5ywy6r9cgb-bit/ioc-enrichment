'use strict';
/**
 * modules/connectors/lobby.js — read every captured Senate LDA filing and say
 * what the filings actually assert.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SEPARATE FROM crosslink.js
 *
 * crosslink reports co-occurrence: two names turning up under the same
 * subject. That is a shortlist of places to look and nothing more.
 *
 * A lobbying filing is a different kind of object. It is a sworn statement,
 * filed under 2 U.S.C. 1603-1604, that a named registrant lobbied for a named
 * client, in a named quarter, on named issues, for a stated sum. The
 * relationship is asserted by the filer, not inferred by me. That difference
 * in evidentiary weight is the whole reason this file exists.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FOUR WAYS THIS DATA LIES TO YOU, AND WHAT IS DONE ABOUT EACH
 *
 * 1. income AND expenses ARE NOT THE SAME MONEY.
 *    `income` is what an outside firm reports RECEIVING from a client.
 *    `expenses` is what an organisation reports SPENDING on its own in-house
 *    lobbying. A filing carries one or the other. Adding them together
 *    produces a number that means nothing, and it will look completely
 *    plausible on a chart. They are kept in separate totals here and are
 *    never summed. Every reported figure says which one it is.
 *
 * 2. AMENDMENTS DOUBLE-COUNT.
 *    A quarter filed and then amended appears twice — e.g. filing_type "Q2"
 *    and "Q2A" — and the amendment RESTATES the quarter rather than adding
 *    to it. Summing both inflates the total. Filings are deduped per
 *    (registrant, client, year, period), keeping the latest posting.
 *
 * 3. THE CAPTURE IS TRUNCATED.
 *    The connector requests page_size=25 and does not follow `next`. A client
 *    with 60 filings gives you 25. The raw response carries `count`, so the
 *    shortfall is knowable — and it is reported per subject rather than
 *    quietly folded into a total. A truncated total presented as a total is
 *    exactly the silent-green failure this whole system is built against.
 *
 * 4. YOU ONLY HAVE WHAT YOU SEARCHED FOR.
 *    The connector queries `client_name`. Registrant-side coverage is
 *    therefore incidental: you see a registrant's OTHER clients only where
 *    you happened to search those clients too. "Registrant X has 2 clients"
 *    means 2 IN YOUR LIBRARY, never 2 in the world. Every registrant line
 *    says so.
 *
 * Makes no network call. Reads only what is already captured and hashed.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');

/** A filing period, folded to something sortable and comparable. */
function periodKey(f) {
  const raw = String(f.filing_period || f.filing_period_display || '').toLowerCase();
  if (/1st|q1|first/.test(raw)) return 'Q1';
  if (/2nd|q2|second/.test(raw)) return 'Q2';
  if (/3rd|q3|third/.test(raw)) return 'Q3';
  if (/4th|q4|fourth/.test(raw)) return 'Q4';
  if (/mid|1st half|first half/.test(raw)) return 'H1';
  if (/year|2nd half|second half/.test(raw)) return 'H2';
  return raw ? raw.slice(0, 12) : '?';
}

/**
 * Money, or null. Deliberately NOT zero for a missing value: "$0 reported"
 * and "no figure filed" are different facts, and collapsing them makes an
 * absent disclosure look like a disclosed absence.
 */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Read every senatelda capture on disk and flatten it to filings.
 *
 * Returns { filings, subjects, unparsed }. `subjects` carries per-search
 * coverage — how many filings the API said existed vs. how many were kept —
 * so truncation is reportable instead of invisible.
 */
function readFilings(captureDir) {
  const filings = [];
  const subjects = [];
  const unparsed = [];

  let files;
  try { files = fs.readdirSync(captureDir); }
  catch { return { filings, subjects, unparsed }; }

  for (const f of files.sort()) {
    if (!f.startsWith('live_capture_senatelda_') || !f.endsWith('.json')) continue;
    const stem = f.slice('live_capture_senatelda_'.length, -'.json'.length);
    const subject = stem.replace(/_\d{4}-\d{2}-\d{2}T.*$/, '').replace(/_/g, ' ');

    let body;
    try { body = JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8')); }
    catch (e) { unparsed.push({ file: f, subject, error: e.message }); continue; }

    const rows = Array.isArray(body.results) ? body.results : [];
    subjects.push({
      subject,
      file: f,
      kept: rows.length,
      // `count` is what the API said the full result set is. Absent on some
      // responses, in which case truncation is unknown, not absent.
      total: Number.isFinite(body.count) ? body.count : null,
      truncated: Number.isFinite(body.count) && body.count > rows.length,
    });

    for (const r of rows) {
      const client = (r.client && r.client.name) || '';
      const registrant = (r.registrant && r.registrant.name) || '';
      if (!client && !registrant) continue;
      filings.push({
        uuid: r.filing_uuid || '',
        subject,
        client,
        registrant,
        year: r.filing_year || null,
        period: periodKey(r),
        type: r.filing_type || '',
        typeDisplay: r.filing_type_display || '',
        // An amendment restates its quarter; see note 2 at the top.
        amended: /A$/.test(String(r.filing_type || '')) || /amend/i.test(String(r.filing_type_display || '')),
        posted: r.dt_posted || '',
        income: money(r.income),
        expenses: money(r.expenses),
        issues: (r.lobbying_activities || [])
          .map((a) => a.general_issue_code_display || a.general_issue_code)
          .filter(Boolean),
        lobbyists: (r.lobbying_activities || [])
          .flatMap((a) => (a.lobbyists || [])
            .map((l) => {
              const p = (l && l.lobbyist) || l || {};
              return [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
            })
            .filter(Boolean)),
        entities: (r.lobbying_activities || [])
          .flatMap((a) => (a.government_entities || []).map((g) => g.name).filter(Boolean)),
        url: r.filing_document_url || '',
      });
    }
  }
  return { filings, subjects, unparsed };
}

/**
 * Collapse amendments. One quarter of one relationship is ONE fact, however
 * many times it was filed. The latest posting wins; the count of what was
 * superseded is returned so the report can say it out loud.
 */
function dedupe(filings) {
  const best = new Map();
  let superseded = 0;
  for (const f of filings) {
    // JSON-encoded rather than joined on a separator: registrant "ALPINE
    // GROUP" + client "PARTNERS LLC" and registrant "ALPINE" + client "GROUP
    // PARTNERS LLC" produce the same string when you glue names together with
    // a space, and two unrelated relationships would silently collapse into
    // one. Company names contain every punctuation mark there is, so there is
    // no safe separator — encode the fields instead of delimiting them.
    const k = JSON.stringify([f.registrant, f.client, f.year, f.period]);
    const prev = best.get(k);
    if (!prev) { best.set(k, f); continue; }
    superseded++;
    // Prefer the amendment; failing that, the later posting.
    const better = (f.amended && !prev.amended)
      || (f.amended === prev.amended && String(f.posted) > String(prev.posted));
    if (better) best.set(k, f);
  }
  return { filings: [...best.values()], superseded };
}

/** Sum that stays null until there is something real to add. */
function sumOrNull(values) {
  let total = null;
  for (const v of values) {
    if (v === null) continue;
    total = (total === null ? 0 : total) + v;
  }
  return total;
}

/**
 * Roll filings up by client, by registrant, by year and by issue.
 *
 * Every money total is split income/expenses and never combined. Every count
 * of "clients" or "registrants" is a count WITHIN THE CAPTURED LIBRARY.
 */
function analyse(filings) {
  const clients = new Map();
  const registrants = new Map();
  const issues = new Map();
  const byYear = new Map();
  const edges = new Map();

  const bump = (map, key, make) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key);
  };

  for (const f of filings) {
    if (f.client) {
      const c = bump(clients, f.client, () => ({
        name: f.client, filings: 0, registrants: new Set(),
        years: new Set(), subjects: new Set(), income: [], expenses: [], issues: new Set(),
      }));
      c.filings++;
      if (f.registrant) c.registrants.add(f.registrant);
      if (f.year) c.years.add(f.year);
      c.subjects.add(f.subject);
      c.income.push(f.income);
      c.expenses.push(f.expenses);
      f.issues.forEach((i) => c.issues.add(i));
    }

    if (f.registrant) {
      const g = bump(registrants, f.registrant, () => ({
        name: f.registrant, filings: 0, clients: new Set(),
        years: new Set(), income: [], expenses: [], lobbyists: new Set(),
      }));
      g.filings++;
      if (f.client) g.clients.add(f.client);
      if (f.year) g.years.add(f.year);
      g.income.push(f.income);
      g.expenses.push(f.expenses);
      f.lobbyists.forEach((l) => g.lobbyists.add(l));
    }

    if (f.client && f.registrant) {
      const k = JSON.stringify([f.client, f.registrant]);
      const e = bump(edges, k, () => ({
        client: f.client, registrant: f.registrant,
        filings: 0, years: new Set(), income: [], expenses: [], issues: new Set(),
      }));
      e.filings++;
      if (f.year) e.years.add(f.year);
      e.income.push(f.income);
      e.expenses.push(f.expenses);
      f.issues.forEach((i) => e.issues.add(i));
    }

    for (const i of new Set(f.issues)) {
      const s = bump(issues, i, () => ({ issue: i, filings: 0, clients: new Set() }));
      s.filings++;
      if (f.client) s.clients.add(f.client);
    }

    if (f.year) {
      const y = bump(byYear, f.year, () => ({ year: f.year, filings: 0, income: [], expenses: [] }));
      y.filings++;
      y.income.push(f.income);
      y.expenses.push(f.expenses);
    }
  }

  const finishMoney = (o) => ({
    income: sumOrNull(o.income),
    expenses: sumOrNull(o.expenses),
    incomeFilings: o.income.filter((v) => v !== null).length,
    expenseFilings: o.expenses.filter((v) => v !== null).length,
  });

  return {
    clients: [...clients.values()].map((c) => ({
      name: c.name, filings: c.filings,
      registrants: [...c.registrants].sort(),
      years: [...c.years].sort(),
      subjects: [...c.subjects].sort(),
      issues: [...c.issues].sort(),
      ...finishMoney(c),
    })).sort((a, b) => b.filings - a.filings || a.name.localeCompare(b.name)),

    registrants: [...registrants.values()].map((g) => ({
      name: g.name, filings: g.filings,
      clients: [...g.clients].sort(),
      years: [...g.years].sort(),
      lobbyists: [...g.lobbyists].sort(),
      ...finishMoney(g),
    })).sort((a, b) => b.clients.length - a.clients.length
      || b.filings - a.filings || a.name.localeCompare(b.name)),

    edges: [...edges.values()].map((e) => ({
      client: e.client, registrant: e.registrant, filings: e.filings,
      years: [...e.years].sort(), issues: [...e.issues].sort(),
      ...finishMoney(e),
    })).sort((a, b) => b.filings - a.filings),

    issues: [...issues.values()].map((s) => ({
      issue: s.issue, filings: s.filings, clients: [...s.clients].sort(),
    })).sort((a, b) => b.filings - a.filings || a.issue.localeCompare(b.issue)),

    byYear: [...byYear.values()].map((y) => ({
      year: y.year, filings: y.filings,
      income: sumOrNull(y.income), expenses: sumOrNull(y.expenses),
    })).sort((a, b) => a.year - b.year),
  };
}

/**
 * Registrants filing for more than one client IN THIS LIBRARY. This is the
 * finding the whole module is for: one firm carrying both a hyperscaler and
 * a utility is a thread worth pulling, and unlike a name co-occurrence it
 * rests on two sworn filings.
 */
function sharedRegistrants(analysis) {
  return analysis.registrants
    .filter((g) => g.clients.length > 1)
    .sort((a, b) => b.clients.length - a.clients.length || b.filings - a.filings);
}

module.exports = {
  readFilings, dedupe, analyse, sharedRegistrants,
  periodKey, money, sumOrNull,
};
