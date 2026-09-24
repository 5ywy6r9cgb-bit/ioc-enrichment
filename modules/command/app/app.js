'use strict';
/*
 * Sentinel Command — the front of the desk.
 *
 * Plain JavaScript, no framework, no build step, nothing fetched from the
 * internet. It reads what the server gives it and renders it; it holds no
 * state of its own that matters. Every number comes from the module that owns
 * it, and every screen tries to answer the same four questions:
 *
 *     What do I know?   What am I missing?   What changed?   What next?
 */

const TOKEN = document.querySelector('meta[name="sentinel-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

// ─────────────────────────────────────────────────────────── helpers
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const date = (s) => (s ? String(s).slice(0, 10) : '—');
const when = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function api(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sentinel-Token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  const out = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 9000 : 4000);
}

function cmd(text) {
  return `<div class="cmd"><code>${esc(text)}</code>`
    + `<button class="small ghost" data-copy="${esc(text)}" type="button">Copy</button></div>`;
}

function brief(know, missing, next) {
  return `<div class="brief">
    <div><div class="k">WHAT I KNOW</div><div class="v">${know}</div></div>
    <div><div class="k">WHAT IS MISSING</div><div class="v">${missing}</div></div>
    <div><div class="k">WHAT NEXT</div><div class="v">${next}</div></div></div>`;
}

function failure(e) {
  return `<div class="panel bad"><strong>Could not load this.</strong>
    <div class="error u-mt4">${esc(e.message || e)}</div>
    <div class="muted small u-mt6">Nothing was changed. The terminal command for
    this section still works, and the System page shows which store is missing.</div></div>`;
}

// Rungs from foia_tracker.js, most urgent first. Colour follows urgency.
const RUNG_TONE = {
  denied_needs_review: 'bad', partial_needs_completion: 'warn', fee_quote_pending: 'warn',
  no_response_escalate: 'bad', no_response_followup: 'warn', awaiting_agency: 'info', no_action: 'dim',
};
const rungBadge = (e) => `<span class="badge b-${RUNG_TONE[e.rung] || 'dim'}">${esc(e.label || e.rung)}</span>`;

const STATE_TONE = { unknown: 'bad', in_flight: 'bad', drafted: 'warn', approved: 'info', sent: 'ok', failed: 'bad', rejected: 'dim' };
const stateBadge = (s) => `<span class="badge b-${STATE_TONE[s] || 'dim'}">${esc(String(s).replace('_', ' ').toUpperCase())}</span>`;

// ─────────────────────────────────────────────────────────── navigation
// Ordered the way work actually moves: collect, analyse, publish.
const NAV = [
  { stage: 'COMMAND', items: [{ path: '/', label: 'Today', badge: 'today' }] },
  { stage: 'COLLECT', items: [
    { path: '/requests', label: 'Records requests', badge: 'requests' },
    { path: '/outbox', label: 'Outbox', badge: 'outbox' },
    { path: '/library', label: 'Library' },
  ] },
  { stage: 'ANALYZE', items: [
    { path: '/cases', label: 'Cases & claims', badge: 'cases' },
    { path: '/matrix', label: 'Link Matrix', off: true },
    { path: '/chronology', label: 'Chronology', off: true },
  ] },
  { stage: 'PUBLISH', items: [{ path: '/publication', label: 'Publication Station', off: true }] },
  { stage: 'SYSTEM', items: [{ path: '/system', label: 'System' }] },
];
const badges = {};

function renderNav(active) {
  $('#nav').innerHTML = NAV.map((g) => `<div class="stage">${g.stage}</div>` + g.items.map((i) => {
    const b = i.badge && badges[i.badge];
    const on = active === i.path || (i.path !== '/' && active.startsWith(i.path));
    return `<a href="#${i.path}" class="${on ? 'active' : ''} ${i.off ? 'off' : ''}"
      ${on ? 'aria-current="page"' : ''}><span>${esc(i.label)}</span>`
      + (b ? `<span class="n ${b.tone || ''}">${esc(b.text)}</span>` : (i.off ? '<span class="n">soon</span>' : ''))
      + '</a>';
  }).join('')).join('');
}

async function refreshBadges() {
  try {
    const [rq, ob] = await Promise.all([api('/api/requests'), api('/api/outbox')]);
    badges.requests = rq.needs_attention ? { text: rq.needs_attention, tone: 'warn' } : { text: rq.total };
    const unres = ob.unresolved.length;
    badges.outbox = unres ? { text: `${unres} ?`, tone: 'bad' }
      : ob.drafted.length ? { text: ob.drafted.length, tone: 'warn' } : null;
  } catch { /* the page itself will say what failed */ }
  try {
    const cs = await api('/api/cases');
    const blocked = cs.total - cs.publishable;
    badges.cases = cs.total ? { text: `${cs.publishable}/${cs.total}`, tone: blocked ? 'warn' : '' } : null;
  } catch { /* ditto */ }
  renderNav(currentPath);
}

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    $('#health').innerHTML = `<span class="badge b-ok">LIVE</span> <span class="muted">operator: ${esc(h.operator)}</span>`;
  } catch {
    $('#health').innerHTML = '<span class="badge b-bad">SERVER STOPPED</span>';
  }
}

// ─────────────────────────────────────────────────────────── views
const VIEWS = {};

VIEWS.today = async () => {
  const t = await api('/api/today');
  const next = t.next && t.next[0];
  return `<h1>Today</h1>
    <p class="lede">What needs you, in the order you would lose it. Produced by
    <span class="mono">sentinel today</span> — the same rules, the same order.</p>
    ${next ? `<div class="next"><div class="k">NEXT — ONE THING, NOT THE LIST</div>
      <div class="v">${esc(next)}</div>
      ${t.then && t.then.length ? `<ol>${t.then.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div>`
    : `<div class="next"><div class="k">NEXT</div><div class="v">Nothing is losable today. Do the work you wanted to do.</div></div>`}
    ${t.sections.map((s) => `
      <div class="panel ${s.error ? 'bad' : s.todo.length ? 'warn' : ''}">
        <div class="panel-head"><h3>${s.n}. ${esc(s.title)}</h3>
          ${s.error ? '<span class="badge b-bad">SECTION FAILED</span>'
            : s.todo.length ? `<span class="badge b-warn">${plural(s.todo.length, 'item')}</span>`
            : '<span class="badge b-ok">CLEAR</span>'}</div>
        ${s.error ? `<div class="error">${esc(s.error)}</div>` : ''}
        ${s.text ? `<pre class="text">${esc(s.text)}</pre>` : ''}
      </div>`).join('')}
    <p class="dim small">${esc(t.rule)} · generated ${esc(when(t.generated_at))}</p>`;
};

VIEWS.requests = async (_p, q) => {
  const r = await api('/api/requests');
  const showAll = q.get('all') === '1';
  const rows = showAll ? r.all : r.items;
  const noDate = r.all.filter((e) => !e.filed_on).length;
  const top = r.items[0];
  return `<h1>Records requests</h1>
    <p class="lede">Every request and its clock, most urgent first. The rungs and the
    cadence are <span class="mono">foia_tracker.js</span> — the same ones
    <span class="mono">sentinel pra foia</span> prints.</p>
    ${brief(
      `${plural(r.total, 'request')} tracked; <strong>${r.needs_attention}</strong> need you.`,
      noDate ? `<span class="error">${plural(noDate, 'request')} with no filing date — no clock can run.</span>` : 'Every request has a filing date.',
      top ? `<a href="#/requests/${encodeURIComponent(top.request_id)}">${esc(top.request_id)}</a> — ${esc(top.label)}` : 'Nothing is due.')}
    <p class="dim small">${esc(r.clock_note)}</p>
    ${!r.store_exists ? `<div class="empty">No requests are recorded yet. Record one from the terminal:
        ${cmd('bin/sentinel pra foia add REQ-ID "Agency Name" --on YYYY-MM-DD --via electronic')}</div>`
    : `<div class="row u-my10">
        <a class="chip ${showAll ? '' : 'on'}" href="#/requests">Needs you <span class="n">${r.needs_attention}</span></a>
        <a class="chip ${showAll ? 'on' : ''}" href="#/requests?all=1">All <span class="n">${r.total}</span></a></div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Request</th><th>Agency</th><th>Where it stands</th><th>Filed</th><th class="num">Business days</th></tr></thead>
        <tbody>${rows.map((e) => `<tr class="click" data-href="#/requests/${encodeURIComponent(e.request_id)}">
          <td class="mono nowrap">${esc(e.request_id)}</td><td>${esc(e.agency || '—')}</td>
          <td>${rungBadge(e)}</td><td class="nowrap">${esc(date(e.filed_on))}</td>
          <td class="num">${e.business_days_elapsed ?? '—'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nothing needs you. Every request is inside its cadence.</div>'}`}
    <p class="dim small u-mt14">Store: <span class="mono">${esc(r.store)}</span></p>`;
};

VIEWS.request = async (id) => {
  const d = await api(`/api/requests/${encodeURIComponent(id)}`);
  const e = d.evaluation, r = d.request;
  const skip = new Set(['request_id', 'agency', 'label', 'rung', 'reason', 'operator_decision', 'priority']);
  const extra = Object.entries(e).filter(([k, v]) => !skip.has(k) && (v === null || typeof v !== 'object'));
  return `<p class="small"><a href="#/requests">← Records requests</a></p>
    <h1 class="mono">${esc(e.request_id)}</h1>
    <p class="lede">${esc(e.agency || '')}</p>
    <div class="panel ${RUNG_TONE[e.rung] === 'bad' ? 'bad' : RUNG_TONE[e.rung] === 'warn' ? 'warn' : ''}">
      <div class="panel-head"><h3>Where it stands</h3>${rungBadge(e)}</div>
      ${e.reason ? `<p class="u-mb6">${esc(e.reason)}</p>` : ''}
      ${e.operator_decision ? `<p class="muted u-m0"><strong>Your decision:</strong> ${esc(e.operator_decision)}</p>` : ''}
    </div>
    <div class="grid2">
      <div class="panel"><h3>The clock</h3><dl class="kv">
        ${extra.map(([k, v]) => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${esc(v === null ? '—' : v)}</dd>`).join('')}
      </dl></div>
      <div class="panel"><h3>The record</h3><dl class="kv">
        ${Object.entries(r).filter(([, v]) => v === null || typeof v !== 'object')
          .map(([k, v]) => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${esc(v === null ? '—' : v)}</dd>`).join('')}
      </dl></div>
    </div>
    <h2>Drafted follow-up — not sent, not queued</h2>
    ${d.draft ? `<pre class="text letter">${esc(d.draft)}</pre>
      <p class="muted small">To put it in the outbox for your sign-off:</p>${cmd(`bin/sentinel pra mail queue ${e.request_id}`)}`
    : '<div class="empty">The desk drafts no letter at this rung. It needs a decision from you first.</div>'}
    <h2>Letters for this request</h2>
    ${d.messages.length ? messageTable(d.messages) : '<div class="empty">None queued.</div>'}
    <h2>Correspondence &amp; history</h2>
    ${historyBlock(r)}`;
};

function historyBlock(r) {
  const corr = r.correspondence || [];
  const hist = r.history || [];
  if (!corr.length && !hist.length) return '<div class="empty">Nothing logged yet.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead><tbody>
    ${corr.map((c) => `<tr><td class="nowrap">${esc(date(c.occurred_at || c.on))}</td>
      <td>${esc(c.direction || 'letter')} · ${esc(c.channel || '')}</td><td>${esc(c.note || '')}</td></tr>`).join('')}
    ${hist.map((h) => `<tr><td class="nowrap">${esc(when(h.at))}</td><td>${esc(h.field || 'change')}</td>
      <td class="mono small">${esc(h.from ?? '')} → ${esc(h.to ?? '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function messageTable(msgs) {
  return `<div class="table-wrap"><table><thead><tr><th>Letter</th><th>State</th><th>To</th><th>Subject</th><th>Queued</th></tr></thead>
    <tbody>${msgs.map((m) => `<tr class="click" data-href="#/outbox"><td class="mono nowrap">${esc(m.message_id)}</td>
      <td>${stateBadge(m.state)}</td><td>${esc(m.to)}</td><td>${esc(m.subject)}</td>
      <td class="nowrap">${esc(date(m.queued_at))}</td></tr>`).join('')}</tbody></table></div>`;
}

VIEWS.outbox = async () => {
  const o = await api('/api/outbox');
  const nothing = !o.unresolved.length && !o.drafted.length && !o.approved.length && !o.history.length;
  return `<h1>Outbox</h1>
    <p class="lede">Letters to public offices, over your name. This screen can approve what you
    have read, reject with a reason, and record what you found about an unknown send.
    <strong>It cannot send.</strong> Sending stays a command you type.</p>
    ${nothing ? `<div class="empty">The outbox is empty. Queue a follow-up from a request:
      ${cmd('bin/sentinel pra mail queue REQ-ID')}</div>` : ''}

    ${o.unresolved.length ? `<h2 class="t-bad">Outcome unknown — check these before anything else</h2>
      ${o.unresolved.map(unresolvedCard).join('')}` : ''}

    ${o.drafted.length ? `<h2>Awaiting your sign-off (${o.drafted.length})</h2>
      ${o.drafted.map(draftCard).join('')}` : ''}

    ${o.approved.length ? `<h2>Approved — will go on the next send (${o.approved.length})</h2>
      <div class="panel">${o.approved.map((m) => `<div class="row u-py4">
          ${m.sendable ? '<span class="badge b-ok">READY</span>' : '<span class="badge b-bad">REFUSED</span>'}
          <span class="mono">${esc(m.message_id)}</span><span class="muted">→ ${esc(m.to)}</span>
          <span class="grow">${esc(m.subject)}</span></div>
          ${m.gate_reason ? `<div class="error small u-ml70">${esc(m.gate_reason)}</div>` : ''}`).join('')}
        <p class="muted small u-mt10 u-mb4">Check first, then send, from the terminal:</p>
        ${cmd('bin/sentinel pra mail send --dry-run')}${cmd('bin/sentinel pra mail send')}</div>` : ''}

    ${o.history.length ? `<h2>History</h2>${messageTable(o.history)}` : ''}
    <p class="dim small u-mt14">Outbox: <span class="mono">${esc(o.file)}</span></p>`;
};

function draftCard(m) {
  return `<div class="panel warn">
    <div class="panel-head"><div><span class="mono">${esc(m.message_id)}</span>
      <span class="muted"> · ${esc(m.request_id)} · ${esc(m.agency || '')}</span></div>${stateBadge(m.state)}</div>
    <dl class="kv"><dt>to</dt><dd>${esc(m.to)}</dd>${m.cc ? `<dt>cc</dt><dd>${esc(m.cc)}</dd>` : ''}
      <dt>subject</dt><dd>${esc(m.subject)}</dd></dl>
    <pre class="text letter u-mt10">${esc(m.body)}</pre>
    <div class="row u-mt10">
      <button class="primary" data-approve="${esc(m.message_id)}" data-hash="${esc(m.current_hash)}" type="button">
        Approve this exact text</button>
      <input type="text" class="grow" placeholder="Reason, if rejecting" data-reason-for="${esc(m.message_id)}">
      <button class="danger" data-reject="${esc(m.message_id)}" type="button">Reject</button>
    </div>
    <p class="dim small u-mt6">Approval is bound to this text by its fingerprint
      <span class="mono">${esc(m.current_hash.slice(0, 12))}</span>. If the desk re-drafts it, the approval is void.</p>
  </div>`;
}

function unresolvedCard(m) {
  return `<div class="panel bad">
    <div class="panel-head"><div><span class="mono">${esc(m.message_id)}</span>
      <span class="muted"> · ${esc(m.request_id)} → ${esc(m.to)}</span></div>${stateBadge(m.state)}</div>
    <p class="u-mb6">${esc(m.subject)}</p>
    <p class="error u-mb10">${esc(m.state === 'in_flight'
      ? 'A send run is in progress, or died mid-send. The next `mail send` will mark it unknown.'
      : m.unknown_reason || '')}</p>
    ${m.state === 'unknown' ? `
    <p class="muted small u-mb6">Look in the SENT folder of the records mailbox. If it is there,
      the agency has it. Do not re-send and do not queue a replacement until this is recorded.</p>
    <div class="row">
      <select data-outcome-for="${esc(m.message_id)}" class="u-wauto">
        <option value="sent">It was sent</option><option value="failed">It did not go</option></select>
      <input type="text" class="grow" data-basis-for="${esc(m.message_id)}"
        placeholder="What you checked, and what it showed — e.g. sent folder shows it at 14:02, no bounce">
      <button class="primary" data-reconcile="${esc(m.message_id)}" type="button">Record it</button>
    </div>` : ''}
  </div>`;
}

VIEWS.library = async (_p, q) => {
  const term = q.get('q') || '';
  const conn = q.get('connector') || '';
  const qs = new URLSearchParams(); if (term) qs.set('q', term); if (conn) qs.set('connector', conn);
  const L = await api(`/api/library?${qs}`);
  const v = L.verify;
  const integrity = !L.exists ? '<span class="badge b-dim">NO LEDGER YET</span>'
    : v && v.ok ? `<span class="badge b-ok">CHAIN INTACT · ${v.total} LINES</span>`
    : `<span class="badge b-bad">${v && v.tampered ? v.tampered.length : '?'} LINE(S) ALTERED</span>`;
  const conns = Object.entries(L.by_connector).sort((a, b) => b[1] - a[1]);
  return `<h1>Library</h1>
    <p class="lede">Every capture the connectors have made, from the provenance ledger. ${esc(L.note)}</p>
    <div class="row"><form id="libform" class="row grow" role="search">
      <input type="search" name="q" class="grow" value="${esc(term)}" placeholder="Search subject, source, connector, investigation…">
      <button type="submit">Search</button></form>${integrity}</div>
    ${conns.length ? `<div class="chips"><a class="chip ${conn ? '' : 'on'}" href="#/library${term ? `?q=${encodeURIComponent(term)}` : ''}">All <span class="n">${L.total}</span></a>
      ${conns.map(([k, n]) => `<a class="chip ${conn === k ? 'on' : ''}" href="#/library?connector=${encodeURIComponent(k)}${term ? `&q=${encodeURIComponent(term)}` : ''}">${esc(k)}<span class="n">${n}</span></a>`).join('')}</div>` : ''}
    ${v && !v.ok && v.tampered && v.tampered.length ? `<div class="panel bad">Lines altered after they were written:
      <span class="mono">${v.tampered.slice(0, 10).map((t) => `#${t.line}`).join(' ')}</span>
      ${cmd(`bin/sentinel prov verify "${L.file}"`)}</div>` : ''}
    ${!L.exists ? `<div class="empty">No captures yet. Pull from a source:
        ${cmd('bin/sentinel connect all "SUBJECT" --dry-run')}</div>`
    : L.rows.length ? `<p class="muted small">${L.matched} matching · showing ${L.rows.length}</p>
      <div class="table-wrap"><table><thead><tr><th>Captured</th><th>Source</th><th>What was asked</th><th>Tier</th><th>Fingerprint</th></tr></thead>
      <tbody>${L.rows.map((r) => `<tr><td class="nowrap">${esc(when(r.recorded_at))}</td>
        <td class="nowrap">${esc(r.connector || r.kind)}</td>
        <td>${esc(r.subject || r.label)}${r.investigation ? ` <span class="badge b-info">${esc(r.investigation)}</span>` : ''}
          ${r.source_url ? `<div class="dim small wrap-any">${esc(r.source_url)}</div>` : ''}</td>
        <td><span class="badge b-dim">${esc(r.tier)}</span></td>
        <td class="mono small">${esc((r.sha256 || '').slice(0, 12))}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Nothing matches. That means nothing was asked, not that nothing exists.</div>'}
    <p class="dim small u-mt14">Ledger: <span class="mono">${esc(L.file)}</span></p>`;
};

VIEWS.cases = async () => {
  const [c, cl] = await Promise.all([api('/api/cases'), api('/api/claims').catch((e) => ({ error: e.message }))]);
  const blocked = c.cases.filter((x) => !x.publishable);
  const first = blocked[0];
  return `<h1>Cases &amp; claims</h1>
    <p class="lede">A case is publishable only when every financial exhibit is read to the last page, no
    exhibit is broken, and no question or contradiction is open. The gate is
    <span class="mono">case.py</span>'s — this screen shows it, it does not decide it. There is no override.</p>
    ${brief(`${plural(c.total, 'case')}; <strong>${c.publishable}</strong> clear the gate.`,
      blocked.length ? `${plural(blocked.length, 'case')} blocked.` : 'Nothing is blocked.',
      first ? `<a href="#/cases/${encodeURIComponent(first.id)}">${esc(first.id)}</a> — ${esc((first.blockers[0] || [])[1] || '')}` : 'Do the reporting you wanted to do.')}
    ${c.cases.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Case</th><th>About</th><th>Gate</th><th>Read</th><th class="num">Q</th><th class="num">X</th><th>Blocking</th></tr></thead>
      <tbody>${c.cases.map((x) => `<tr class="click" data-href="#/cases/${encodeURIComponent(x.id)}">
        <td class="mono nowrap">${esc(x.id)}</td><td>${esc(x.subject)}</td>
        <td>${x.publishable ? '<span class="badge b-ok">CLEAR</span>' : '<span class="badge b-bad">BLOCKED</span>'}</td>
        <td><div class="bar ${x.pct_read === 100 ? 'ok' : ''}" title="${x.pct_read}% of pages read"><i data-pct="${Math.min(100, x.pct_read)}"></i></div>
          <span class="dim small">${x.pages_read}/${x.pages_total} pp</span></td>
        <td class="num">${x.open_questions}</td><td class="num">${x.open_contradictions}</td>
        <td class="small">${x.blockers.map((b) => `<div><span class="mono dim">${esc(b[0])}</span> ${esc(b[1])}</div>`).join('')}</td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="empty">No case files yet. ${cmd('bin/sentinel case new CASE-ID "What the case is about"')}</div>`}
    <h2>Claim layer</h2>
    ${cl.error ? failure(cl) : !cl.exists ? `<div class="panel warn">${esc(cl.note)} ${cmd(cl.command)}</div>`
      : `<div class="tiles">
        <div class="tile"><div class="k">Claims</div><div class="v">${cl.claims ?? '—'}</div></div>
        <div class="tile ${cl.uncited ? 'bad' : 'ok'}"><div class="k">Uncited — blocked</div><div class="v">${cl.uncited ?? '—'}</div></div>
        <div class="tile"><div class="k">Citations</div><div class="v">${cl.citations ?? '—'}</div></div>
        <div class="tile"><div class="k">Documents</div><div class="v">${cl.documents ?? '—'}</div></div></div>
        ${cmd('bin/sentinel sdesk claim list')}`}
    <p class="dim small u-mt14">Cases: <span class="mono">${esc(c.dir)}</span></p>`;
};

VIEWS.case = async (id) => {
  const c = await api(`/api/cases/${encodeURIComponent(id)}`);
  const f = c.file;
  const ex = Object.values(f.exhibits || {});
  const rules = [
    ['R-00', 'Has at least one exhibit', ex.length > 0],
    ['R-01', 'Every financial exhibit read to the last page', !c.blockers.some((b) => b[0] === 'R-01')],
    ['R-02', 'No exhibit marked broken', c.broken === 0],
    ['R-03', 'No open questions', c.open_questions === 0],
    ['R-04', 'No open contradictions', c.open_contradictions === 0],
  ];
  return `<p class="small"><a href="#/cases">← Cases</a></p>
    <h1 class="mono">${esc(c.id)}</h1><p class="lede">${esc(c.subject)}</p>
    <div class="panel ${c.publishable ? 'ok' : 'bad'}">
      <div class="panel-head"><h3>Publication gate</h3>${c.publishable ? '<span class="badge b-ok">CLEAR</span>' : '<span class="badge b-bad">BLOCKED</span>'}</div>
      <ul class="gate">${rules.map(([rid, text, ok]) => `<li><span class="id">${rid}</span>
        ${ok ? '<span class="badge b-ok">PASS</span>' : '<span class="badge b-bad">FAIL</span>'}<span>${esc(text)}</span></li>`).join('')}</ul>
      ${c.blockers.length ? `<p class="muted small u-mt8">${c.blockers.map((b) => `${esc(b[0])}: ${esc(b[1])}`).join(' · ')}</p>` : ''}
    </div>
    <h2>Exhibits (${ex.length})</h2>
    ${ex.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>File</th><th>Kind</th><th>Read</th><th>State</th></tr></thead>
      <tbody>${ex.map((e) => `<tr><td class="mono">${esc(e.id)}</td><td class="wrap-any">${esc(e.file)}</td>
        <td>${e.kind === 'financial' ? '<span class="badge b-warn">FINANCIAL</span>' : esc(e.kind)}</td>
        <td class="nowrap"><div class="bar ${e.pages_read >= e.pages_total ? 'ok' : ''}"><i data-pct="${Math.min(100, 100 * e.pages_read / (e.pages_total || 1))}"></i></div>
          <span class="dim small">${e.pages_read}/${e.pages_total} pp</span></td>
        <td>${e.broken ? `<span class="badge b-bad">BROKEN</span> <span class="small">${esc(e.broken)}</span>` : '<span class="badge b-ok">OK</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No exhibits.</div>'}
    ${cmd(`bin/sentinel case add ${c.id} EX-N path/to/file.pdf --kind financial --pages N`)}
    ${cmd(`bin/sentinel case read ${c.id} EX-N PAGES`)}
    <div class="grid2">
      <div><h2>Open questions (${(f.questions_open || []).length})</h2>
        ${(f.questions_open || []).length ? (f.questions_open || []).map((x) => `<div class="panel warn"><span class="mono dim">${esc(x.id)}</span> ${esc(x.text)}
          <div class="dim small">asked ${esc(date(x.asked_at))}</div></div>`).join('') : '<div class="empty">None open.</div>'}
        ${cmd(`bin/sentinel case ask ${c.id} "The question"`)}</div>
      <div><h2>Contradictions (${(f.contradictions || []).length})</h2>
        ${(f.contradictions || []).length ? (f.contradictions || []).map((x) => `<div class="panel ${x.status === 'open' ? 'bad' : ''}">
          <span class="mono dim">${esc(x.id)}</span> ${esc(x.text)}
          <div class="small">${x.status === 'open' ? '<span class="badge b-bad">OPEN</span>' : `<span class="badge b-ok">RESOLVED</span> ${esc(x.resolution || x.how || '')}`}</div></div>`).join('')
          : '<div class="empty">None recorded.</div>'}
        ${cmd(`bin/sentinel case conflict ${c.id} "Source A says X, source B says Y"`)}</div>
    </div>
    <h2>Log</h2>
    ${(f.log || []).length ? `<div class="table-wrap"><table><tbody>${(f.log || []).slice().reverse().map((l) =>
      `<tr><td class="nowrap mono small">${esc(when(l.at))}</td><td>${esc(l.what)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Nothing logged.</div>'}`;
};

const NOT_BUILT = {
  matrix: ['Link Matrix', 'Entities and the relationships between them, where every edge carries the document that establishes it and its GlassMark tier.',
    'A common entity format across every connector. The plan is FollowTheMoney (MIT licence) as the shared model, written by each connector with its source stamp. Until then an edge drawn here would be a guess about how two files spell the same company.',
    ['bin/sentinel connect edges', 'bin/sentinel connect graph --dashboard']],
  chronology: ['Chronology', 'Every dated event across requests, filings and captures on one timeline, each linked to its source.',
    'The same entity layer as the Link Matrix — events need to point at the same entities.',
    ['bin/sentinel pra foia history REQ-ID']],
  publication: ['Publication Station', 'Briefs, case reports and evidence packages built only from claims that cleared the gate.',
    'The case gate and the claim layer agreeing on one publish rule. Today there are two (case.py and the sdesk desk), and a station built on top of two gates would have to pick one silently.',
    ['bin/sentinel case status CASE-ID', 'bin/sentinel redact --check modules/openmontage/episodes']],
};

function notBuilt(key) {
  const [name, what, blocked, cmds] = NOT_BUILT[key];
  return `<h1>${esc(name)}</h1><span class="badge b-dim">NOT BUILT YET</span>
    <div class="panel u-mt14"><h3>What it will do</h3><p class="u-m0">${esc(what)}</p></div>
    <div class="panel warn"><h3>What it is waiting on</h3><p class="u-m0">${esc(blocked)}</p></div>
    <h2>What works today</h2>${cmds.map(cmd).join('')}`;
}

VIEWS.system = async () => {
  const s = await api('/api/system');
  return `<h1>System</h1><p class="lede">What exists on this machine, and what this screen is and is not allowed to do.</p>
    <div class="table-wrap"><table><thead><tr><th>Store</th><th>State</th><th>Where</th></tr></thead><tbody>
    ${s.stores.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.exists ? '<span class="badge b-ok">PRESENT</span>' : '<span class="badge b-warn">NOT YET</span>'}</td>
      <td class="mono small wrap-any">${esc(x.path)}</td></tr>`).join('')}</tbody></table></div>
    <div class="grid2 u-mt14">
      <div class="panel ok"><h3>This screen can</h3><ul>${s.can.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="panel bad"><h3>This screen cannot</h3><ul>${s.cannot.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    <div class="panel ${s.backup_age_days === null || s.backup_age_days > 7 ? 'bad' : 'ok'}"><h3>Backup</h3>
      ${s.backup_age_days === null ? 'No backup has ever been recorded.' : `Last recorded ${s.backup_age_days.toFixed(1)} days ago.`}
      ${cmd('touch "$SENTINEL_EVIDENCE_DIR/.last_backup"   # after copying the evidence store to another device')}</div>
    <p class="dim small">Sentinel Command v${esc(s.version)} · Node ${esc(s.node)} · port ${esc(s.port)} · ${esc(s.root)}</p>`;
};

// ─────────────────────────────────────────────────────────── router
let currentPath = '/';
function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [p, qs] = raw.split('?');
  return { path: p || '/', q: new URLSearchParams(qs || '') };
}

async function route() {
  const { path, q } = parseHash();
  currentPath = path;
  renderNav(path);
  $('#crumb').textContent = path;
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  let view;
  if (!seg.length) view = () => VIEWS.today();
  else if (seg[0] === 'requests' && seg[1]) view = () => VIEWS.request(seg[1]);
  else if (seg[0] === 'requests') view = () => VIEWS.requests(null, q);
  else if (seg[0] === 'outbox') view = () => VIEWS.outbox();
  else if (seg[0] === 'library') view = () => VIEWS.library(null, q);
  else if (seg[0] === 'cases' && seg[1]) view = () => VIEWS.case(seg[1]);
  else if (seg[0] === 'cases') view = () => VIEWS.cases();
  else if (NOT_BUILT[seg[0]]) view = async () => notBuilt(seg[0]);
  else if (seg[0] === 'system') view = () => VIEWS.system();
  else view = async () => `<div class="empty"><strong>${esc(path)}</strong> does not exist. <a href="#/">Back to Today</a></div>`;

  main.innerHTML = '<div class="loading">Loading…</div>';
  try { main.innerHTML = await view(); } catch (e) { main.innerHTML = failure(e); }
  // Widths are set here, not in markup: the page's CSP forbids inline style
  // attributes, and element.style is the sanctioned way around that.
  main.querySelectorAll('[data-pct]').forEach((el) => { el.style.width = `${Number(el.dataset.pct) || 0}%`; });
  main.focus({ preventScroll: true });
}

// ─────────────────────────────────────────────────────────── actions
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-copy],[data-href],[data-approve],[data-reject],[data-reconcile]');
  if (!t) return;
  if (t.dataset.copy !== undefined) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied. Paste it into Terminal.', 'ok'); }
    catch { toast('Could not copy — select the command and copy it by hand.', 'bad'); }
    return;
  }
  if (t.dataset.href) { location.hash = t.dataset.href.slice(1); return; }

  t.disabled = true;
  try {
    if (t.dataset.approve) {
      const id = t.dataset.approve;
      await post(`/api/outbox/${encodeURIComponent(id)}/approve`, { hash: t.dataset.hash });
      toast(`${id} approved — signed against the text you read. Send it from the terminal.`, 'ok');
    } else if (t.dataset.reject) {
      const id = t.dataset.reject;
      const reason = document.querySelector(`[data-reason-for="${CSS.escape(id)}"]`).value.trim();
      if (!reason) { toast('Say why. A rejected draft with no reason teaches nothing.', 'bad'); return; }
      await post(`/api/outbox/${encodeURIComponent(id)}/reject`, { reason });
      toast(`${id} rejected and kept on the record.`, 'ok');
    } else if (t.dataset.reconcile) {
      const id = t.dataset.reconcile;
      const outcome = document.querySelector(`[data-outcome-for="${CSS.escape(id)}"]`).value;
      const basis = document.querySelector(`[data-basis-for="${CSS.escape(id)}"]`).value.trim();
      await post(`/api/outbox/${encodeURIComponent(id)}/reconcile`, { outcome, basis });
      toast(`${id} recorded as ${outcome}. Your basis is kept.`, 'ok');
    }
    await route(); refreshBadges();
  } catch (e) {
    toast(e.message, 'bad');
  } finally { t.disabled = false; }
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'libform') return;
  ev.preventDefault();
  const term = new FormData(ev.target).get('q').trim();
  const { q } = parseHash();
  const qs = new URLSearchParams(); if (term) qs.set('q', term);
  if (q.get('connector')) qs.set('connector', q.get('connector'));
  location.hash = `/library${qs.toString() ? `?${qs}` : ''}`;
});

// ─────────────────────────────────────────────────────────── palette
const pal = $('#palette'); const palIn = $('#palette-input'); const palList = $('#palette-list');
let palItems = []; let palSel = 0; let palSeq = 0;
const NAV_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ title: i.label, detail: g.stage, route: `#${i.path}` })));

function openPalette() {
  pal.hidden = false; palIn.value = ''; renderPalette(NAV_ITEMS.map((i) => ({ ...i, group: 'Go to' })));
  palIn.focus();
}
function closePalette() { pal.hidden = true; }
function renderPalette(items) {
  palItems = items; palSel = 0;
  let lastGroup = null;
  palList.innerHTML = items.map((it, i) => {
    const hdr = it.group !== lastGroup ? `<li class="hdr" aria-hidden="true">${esc(it.group).toUpperCase()}</li>` : '';
    lastGroup = it.group;
    return `${hdr}<li role="option" data-i="${i}" class="${i === 0 ? 'sel' : ''}"><span class="t">${esc(it.title)}</span><span class="g">${esc(it.detail || '')}</span></li>`;
  }).join('') || '<li class="hdr">NOTHING MATCHES — WHICH MEANS NOTHING WAS ASKED, NOT THAT NOTHING EXISTS</li>';
}
function movePalette(d) {
  if (!palItems.length) return;
  palSel = (palSel + d + palItems.length) % palItems.length;
  palList.querySelectorAll('li[data-i]').forEach((li) => li.classList.toggle('sel', Number(li.dataset.i) === palSel));
  const sel = palList.querySelector('li.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function choosePalette(i) {
  const it = palItems[i]; if (!it) return;
  closePalette(); location.hash = it.route.slice(1);
}
let palTimer = null;
palIn.addEventListener('input', () => {
  const v = palIn.value.trim();
  const nav = NAV_ITEMS.filter((i) => i.title.toLowerCase().includes(v.toLowerCase())).map((i) => ({ ...i, group: 'Go to' }));
  renderPalette(nav);
  clearTimeout(palTimer);
  if (v.length < 2) return;
  palTimer = setTimeout(async () => {
    const seq = ++palSeq;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(v)}`);
      if (seq !== palSeq) return;   // a newer keystroke already asked
      renderPalette(nav.concat(r.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })))));
    } catch (e) { /* keep the navigation results */ }
  }, 140);
});
palIn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); choosePalette(palSel); }
  else if (e.key === 'Escape') { closePalette(); }
});
palList.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choosePalette(Number(li.dataset.i)); });
pal.addEventListener('click', (e) => { if (e.target === pal) closePalette(); });
$('#search-open').addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); }
  else if (e.key === '/' && pal.hidden && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); openPalette(); }
});
if (!/Mac/i.test(navigator.platform || navigator.userAgent)) $('#kbd').textContent = 'Ctrl K';

// ─────────────────────────────────────────────────────────── start
window.addEventListener('hashchange', route);
route(); refreshHealth(); refreshBadges();
setInterval(() => { refreshHealth(); refreshBadges(); }, 30000);
