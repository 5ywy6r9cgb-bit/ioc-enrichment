'use strict';
/**
 * modules/watch/records_desk.js — the records desk, in the overnight run.
 *
 * The watchlist answers "did any source I follow publish something new?"
 * This answers a different question that also has to be asked every morning:
 * "is any request I filed now overdue, denied, or waiting on me?"
 *
 * WHY IT IS A SEPARATE STAGE RATHER THAN A WATCH ENTRY
 *
 * Every watch entry is a connector call — a search against somebody else's
 * index, over the network, that can rate-limit or fail. The records desk is
 * none of those things. It reads a local file and does arithmetic on dates. It
 * cannot fail for a network reason, it has no cadence of its own (a clock is
 * always due), and it must run even when every connector is down. Modelling it
 * as a watch would have given it a `connector` field with nothing to put in it
 * and a cadence that could silently switch it off.
 *
 * WHAT IT WRITES
 *
 *   evidence/watch/MORNING_BRIEF.md   overwritten each run, newest state
 *
 * Overwritten, not appended, and that is deliberate. This file answers "what
 * needs me right now." An appended log answers "what needed me on some past
 * morning," which is what the correspondence history in the request store is
 * already for. Two files that both claim to be the current state is how you end
 * up reading the wrong one.
 *
 * WHAT GOES IN THE NOTIFICATION
 *
 * Counts and request IDs. No agency names — an agency name is a name, and
 * notify.js's content rule does not carve out an exception for organisations.
 * "2 records requests need you: PRR-2026-391, TSR-REQ-5" tells you to open the
 * desk. It does not tell a lock screen who you are pressing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const BRIEF_PATH = path.join(EVIDENCE, 'watch', 'MORNING_BRIEF.md');

/** Rungs that mean a human has to decide something, not just send a letter. */
const NEEDS_JUDGMENT = new Set([
  'denied_needs_review', 'fee_quote_pending', 'partial_needs_completion',
]);

/**
 * Run the desk. Never throws: the overnight run must survive a missing store,
 * a corrupt store, or a tracker that changed shape under it. A stage that can
 * abort the whole run is a stage that eventually takes the watchlist with it.
 */
function run(opts = {}) {
  const today = opts.today || new Date();
  let T;
  let S;
  try {
    T = require('../pra/server/foia_tracker.js');
    S = require('../pra/server/foia_store.js');
  } catch (e) {
    return { ok: false, reason: `records desk unavailable: ${e.message}`, items: [], total: 0 };
  }

  let requests;
  try {
    const store = new S.FoiaStore(opts.storePath || null);
    requests = store.list().map((r) => Object.assign({}, r, {
      request_id: r.request_id || r.id,
      agency_name: r.agency_name || r.agency,
      submitted_on: r.submitted_on || r.filed_date || r.filed_on,
      status: (r.status || 'submitted').toLowerCase(),
    }));
  } catch (e) {
    // A corrupt store is worth waking up for — it means the clocks are not
    // being kept. Report it rather than reporting a quiet morning.
    return { ok: false, reason: e.message, items: [], total: 0, corrupt: true };
  }

  if (!requests.length) {
    return { ok: true, items: [], total: 0, needs_attention: 0, judgment: 0 };
  }

  let report;
  try {
    report = T.triage(requests, { today });
  } catch (e) {
    return { ok: false, reason: `tracker failed: ${e.message}`, items: [], total: 0 };
  }

  return {
    ok: true,
    total: report.total,
    needs_attention: report.needs_attention,
    items: report.items,
    judgment: report.items.filter((i) => NEEDS_JUDGMENT.has(i.rung)).length,
    clock_note: report.clock_note,
  };
}

/** The brief you read with coffee. Written to disk; never sent anywhere. */
function writeBrief(result, opts = {}) {
  const today = (opts.today || new Date()).toISOString().slice(0, 10);
  const out = [];

  out.push('# Records desk — morning brief');
  out.push('');
  out.push(`_${today}. Overwritten each run; this is current state, not a log._`);
  out.push('');

  if (!result.ok) {
    out.push('## The desk could not run');
    out.push('');
    out.push('```');
    out.push(result.reason);
    out.push('```');
    out.push('');
    out.push('**No clocks were checked this morning.** Fix this before reading the');
    out.push('quiet as good news.');
  } else if (!result.total) {
    out.push('No requests are being tracked yet.');
    out.push('');
    out.push('```');
    out.push('sentinel pra foia add <REQUEST-ID> "<Agency>" --on YYYY-MM-DD --via certified_mail');
    out.push('```');
  } else if (!result.needs_attention) {
    out.push(`Nothing needs you. ${result.total} request(s) tracked, all inside cadence.`);
  } else {
    out.push(`## ${result.needs_attention} of ${result.total} need you`);
    out.push('');
    for (const e of result.items) {
      out.push(`### ${e.request_id} — ${e.label}`);
      out.push('');
      out.push(`- **Agency:** ${e.agency || '(not recorded)'}`);
      if (e.business_days_elapsed != null) {
        out.push(`- **Elapsed:** ${e.business_days_elapsed} business days`);
      }
      out.push(`- **Basis:** ${e.deadline_basis}`);
      out.push('');
      out.push(e.reason);
      if (e.operator_decision) {
        out.push('');
        out.push(`> **Your call:** ${e.operator_decision}`);
      }
      if (e.damages && e.damages.accruing) {
        out.push('');
        out.push(`> **Damages accruing:** $${e.damages.accrued_usd} — `
          + `${e.damages.business_days_since_mandamus} business days since the `
          + `mandamus filing. Not a prediction of an award; R.C. 149.43(C)(2)(c) `
          + `lets a court reduce or deny them entirely.`);
      }
      out.push('');
      out.push(`\`sentinel pra foia draft ${e.request_id}\``);
      out.push('');
    }
    out.push('---');
    out.push('');
    out.push(result.clock_note || '');
    out.push('');
    out.push('Nothing here has been sent. Read every draft before it goes anywhere,');
    out.push('and log it afterwards so the desk stops asking:');
    out.push('');
    out.push('```');
    out.push('sentinel pra foia sent <REQUEST-ID> --via email --note "what you said"');
    out.push('```');
  }
  out.push('');

  const target = opts.path || BRIEF_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out.join('\n'), { mode: 0o600 });
  return target;
}

/**
 * The notification line. Counts and IDs only — see notify.js.
 * Returns null when there is nothing worth a doorbell.
 */
function notifyLine(result) {
  if (!result.ok) return 'records desk FAILED — clocks not checked';
  if (!result.needs_attention) return null;
  const ids = result.items.slice(0, 3).map((i) => i.request_id);
  const more = result.needs_attention - ids.length;
  return `${result.needs_attention} records request(s) need you: `
    + ids.join(', ') + (more > 0 ? ` +${more} more` : '');
}

module.exports = { run, writeBrief, notifyLine, BRIEF_PATH, NEEDS_JUDGMENT };
