'use strict';
/**
 * server/foia_dashboard.js — every records request on one screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS WHEN app/dashboard.html ALREADY DID
 *
 * It did not. `app/dashboard.html` is a BUILD ARTIFACT: a snapshot rendered
 * out of Postgres by scripts/dashboard.js, committed to git, and headed
 * "Live view of your database · generated 8/11/2026". Opened in September it
 * still says "Live view", still shows one request, and gives no sign that
 * three weeks have passed. A dashboard that reports a stale number with a
 * confident label is worse than no dashboard, because it is consulted instead
 * of the truth.
 *
 * It also required a database. `sentinel pra foia` — the command actually used
 * to file and track requests — reads evidence/foia_requests.json and needs no
 * Postgres at all. So the surface that worked had no screen, and the screen
 * needed a server that is usually not running.
 *
 * This renders from the same store the CLI writes, so the screen and the
 * terminal cannot disagree, and it stamps the moment it was generated in the
 * header rather than the word "live".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT IS ALLOWED TO SAY
 *
 * Every number and every label on this page comes from foia_tracker.evaluate().
 * Nothing is computed here. That matters more than it looks:
 *
 *   - The Ohio thresholds are the OPERATOR'S CADENCE, not statutory deadlines.
 *     R.C. 149.43 sets no day count, and a page that renders "OVERDUE" in red
 *     next to an Ohio request is asserting a legal entitlement that does not
 *     exist. `triage()` hands us `clock_note` saying exactly this, and it is
 *     printed on the page rather than dropped for being wordy.
 *
 *   - Statutory damages are not accrued time. The tracker refuses to report
 *     accrual until the R.C. 149.43(C)(2) predicates are recorded as true, and
 *     says why when it declines. That refusal is rendered, not hidden — a
 *     blank where a dollar figure would go teaches nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO NETWORK, NO FONTS, NO SCRIPTS
 *
 * The page opens from a file:// URL on a machine that may be offline, and it
 * describes who the operator is pressing and what he is looking for. It must
 * not make a request to anyone. So: one self-contained file, system fonts, and
 * no <script> that phones anywhere. Sorting is done here, at render time.
 */

/** HTML-escape. Agency names and subjects are operator text, not markup. */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Colour by rung, not by elapsed days.
 *
 * Days elapsed is the tempting variable and the wrong one: an Ohio request at
 * 60 days is not "overdue", while a denial at 2 days is the most actionable
 * thing on the desk. The tracker already ranked these; the palette follows its
 * ranking rather than inventing a second opinion.
 */
const RUNG_TONE = {
  denied_needs_review: 'red',
  partial_needs_completion: 'amber',
  fee_quote_pending: 'amber',
  no_response_escalate: 'amber',
  no_response_followup: 'blue',
  awaiting_agency: 'muted',
  no_action: 'muted',
};

const STATUS_TONE = {
  denied: 'red', partial: 'amber', fee_quoted: 'amber',
  produced: 'green', closed: 'muted', withdrawn: 'muted',
};

function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  // Explicit and unambiguous. "9/3/2026" reads as March in half the world,
  // and this file gets sent to people.
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** One row of the attention table. */
function attentionRow(e) {
  const tone = RUNG_TONE[e.rung] || 'muted';
  const days = e.business_days_elapsed === null || e.business_days_elapsed === undefined
    ? '<span class="empty">no submission date</span>'
    : `${e.business_days_elapsed} <span class="unit">business days</span>`;
  const decision = e.operator_decision
    ? `<div class="decision"><span class="tag">your call</span> ${esc(e.operator_decision)}</div>`
    : '';
  return `<tr>
    <td class="mono">${esc(e.request_id)}</td>
    <td>${esc(e.agency) || '<span class="empty">no agency recorded</span>'}</td>
    <td><span class="pill ${tone}">${esc(e.label)}</span>${decision}</td>
    <td class="num">${days}</td>
    <td class="why">${esc(e.reason)}</td>
  </tr>`;
}

/** One row of the everything table. */
function allRow(e) {
  const tone = RUNG_TONE[e.rung] || 'muted';
  return `<tr>
    <td class="mono">${esc(e.request_id)}</td>
    <td>${esc(e.agency) || '<span class="empty">—</span>'}</td>
    <td>${e.filed_on ? esc(e.filed_on) : '<span class="empty">not submitted</span>'}</td>
    <td class="num">${e.business_days_elapsed ?? '<span class="empty">—</span>'}</td>
    <td><span class="pill ${tone}">${esc(e.rung.replace(/_/g, ' '))}</span></td>
    <td>${esc(e.jurisdiction_scope || '')}</td>
  </tr>`;
}

/**
 * The damages section renders the tracker's REFUSALS as prominently as any
 * figure, because "why you cannot claim this yet" is the actionable half.
 */
function damagesBlock(all) {
  const withPosture = all.filter((e) => e.damages);
  if (!withPosture.length) return '';
  const rows = withPosture.map((e) => {
    const d = e.damages;
    const eligible = d.eligible === true;
    const amount = eligible && d.accrued !== null && d.accrued !== undefined
      ? `$${esc(d.accrued)}`
      : '<span class="empty">not accruing</span>';
    const why = d.reason || d.why || (eligible ? '' : 'predicates not recorded');
    return `<tr>
      <td class="mono">${esc(e.request_id)}</td>
      <td class="num">${amount}</td>
      <td class="why">${esc(why)}</td>
    </tr>`;
  }).join('');
  return `<section>
    <h2>Statutory damages posture</h2>
    <p class="hint">Under R.C. 149.43(C)(2) statutory damages exist only where a
      mandamus action has been commenced, accrue from the date that action was
      filed — not from the date of the request — and require hand delivery,
      electronic submission, or certified mail. A court may reduce or deny them.
      Nothing here is a figure you are owed.</p>
    <table><thead><tr><th>Request</th><th>Accrued</th><th>Basis / why not</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </section>`;
}

/**
 * Render the whole page.
 *
 * `t` is the object foia_tracker.triage() returns, unmodified. Passing the
 * triage result rather than raw requests is deliberate: it makes it impossible
 * for this file to reach a different verdict than the CLI, because it never
 * sees the inputs a verdict is computed from.
 */
function render(t, opts = {}) {
  const items = t.items || [];
  const all = t.all || [];
  const storePath = opts.storePath || 'evidence/foia_requests.json';

  const attention = items.length
    ? `<table><thead><tr>
         <th>Request</th><th>Agency</th><th>What it needs</th>
         <th>Elapsed</th><th>Why</th></tr></thead>
       <tbody>${items.map(attentionRow).join('')}</tbody></table>`
    : `<p class="quiet">Nothing needs you right now. Every request on file is
       either closed or inside your follow-up cadence.</p>`;

  const everything = all.length
    ? `<table><thead><tr>
         <th>Request</th><th>Agency</th><th>Submitted</th>
         <th>Business days</th><th>State</th><th>Scope</th></tr></thead>
       <tbody>${all.map(allRow).join('')}</tbody></table>`
    : `<p class="quiet">No requests recorded yet. Add one:
       <code>sentinel pra foia add REQ-001 "Agency name"</code></p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel — Records requests</title>
<style>
  :root{color-scheme:dark light}
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#e6edf3;
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{padding:26px 32px 18px;border-bottom:1px solid #21262d;background:#161b22}
  header h1{margin:0;font-size:21px;letter-spacing:.3px}
  header .sub{color:#8b949e;font-size:13px;margin-top:5px}
  main{max-width:1150px;margin:0 auto;padding:26px 24px 80px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:26px}
  .card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px;text-align:center}
  .card .num{font-size:30px;font-weight:700;color:#58a6ff}
  .card.act .num{color:#d29922}
  .card .lbl{font-size:12px;color:#8b949e;margin-top:2px}
  section{margin:32px 0}
  section h2{font-size:16px;border-left:3px solid #58a6ff;padding-left:10px;margin:0 0 10px}
  .hint,p.hint{color:#8b949e;font-size:13px;margin:0 0 14px 13px;max-width:78ch}
  .quiet{color:#8b949e;font-style:italic;margin-left:13px}
  table{width:100%;border-collapse:collapse;background:#0d1117;
        border:1px solid #21262d;border-radius:10px;overflow:hidden}
  th{background:#161b22;text-align:left;padding:9px 12px;font-size:12px;
     text-transform:uppercase;letter-spacing:.4px;color:#8b949e}
  td{padding:10px 12px;border-top:1px solid #21262d;vertical-align:top}
  tr:hover td{background:#12171e}
  td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:nowrap}
  td.num{white-space:nowrap}
  td.why{color:#8b949e;font-size:13px;max-width:46ch}
  .unit{color:#6e7681;font-size:12px}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;
        font-weight:600;white-space:nowrap}
  .pill.green{background:#193b26;color:#3fb950}.pill.blue{background:#132b45;color:#58a6ff}
  .pill.amber{background:#3d2e10;color:#d29922}.pill.red{background:#3d1518;color:#f85149}
  .pill.muted{background:#21262d;color:#8b949e}
  .decision{margin-top:6px;font-size:12px;color:#d29922}
  .tag{background:#3d2e10;border-radius:4px;padding:1px 5px;margin-right:5px;
       text-transform:uppercase;font-size:10px;letter-spacing:.4px}
  .empty{color:#6e7681;font-style:italic}
  code{background:#161b22;border:1px solid #21262d;border-radius:5px;padding:1px 6px;font-size:13px}
  .law{background:#161b22;border:1px solid #30363d;border-left:3px solid #d29922;
       border-radius:8px;padding:14px 16px;margin:26px 0;color:#c9d1d9;font-size:13px;line-height:1.6}
  .law b{color:#e6edf3}
  .next{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px 18px}
  .next h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:#8b949e}
  .next li{margin:5px 0}
  footer{color:#6e7681;font-size:12px;text-align:center;padding:26px;line-height:1.7}
</style></head><body>
<header>
  <h1>Records requests</h1>
  <div class="sub">Generated ${esc(stamp(t.run_at))} from <code>${esc(storePath)}</code>
    &middot; this is a snapshot, not a live view — re-run <code>sentinel foia dash</code> to refresh</div>
</header>
<main>

  <div class="cards">
    <div class="card"><div class="num">${all.length}</div><div class="lbl">Requests tracked</div></div>
    <div class="card act"><div class="num">${items.length}</div><div class="lbl">Need you now</div></div>
    <div class="card"><div class="num">${all.filter((e) => e.filed_on).length}</div><div class="lbl">Submitted</div></div>
    <div class="card"><div class="num">${all.filter((e) => !e.filed_on).length}</div><div class="lbl">Not yet sent</div></div>
  </div>

  <div class="law">
    <b>The clock on this page is yours, not the statute's.</b><br>
    ${esc(t.clock_note || '')}
    Ohio R.C. 149.43(B)(1) requires inspection "promptly" and copies "within a
    reasonable period of time" — it sets no day count, and reasonableness is
    fact-specific. Nothing here is overdue as a matter of law. Federal FOIA's
    20-business-day determination period is statutory and is labelled as such.
  </div>

  <section>
    <h2>Needs you now</h2>
    <p class="hint">Ordered by what the tracker ranks most actionable — a denial
      outranks a long silence, because a denial is the moment the agency's
      stated exemption becomes a thing you can test.</p>
    ${attention}
  </section>

  ${damagesBlock(all)}

  <section>
    <h2>Everything on file</h2>
    <p class="hint">Every request in the store, including the quiet ones.</p>
    ${everything}
  </section>

  <section>
    <div class="next">
      <h3>From here</h3>
      <ul>
        <li><code>sentinel pra foia</code> — the same triage in the terminal</li>
        <li><code>sentinel pra foia draft ID</code> — draft the next letter for one request</li>
        <li><code>sentinel pra foia history ID</code> — every letter and field change, in order</li>
        <li><code>sentinel pra mail review</code> — letters waiting for your sign-off</li>
        <li><code>sentinel foia dash</code> — rebuild this page</li>
      </ul>
    </div>
  </section>

</main>
<footer>
  Sentinel OS &middot; generated locally &middot; nothing on this page left your machine.<br>
  It proposes; it does not send, file, or decide.
</footer>
</body></html>`;
}

module.exports = { render, esc, stamp, RUNG_TONE, STATUS_TONE };
