'use strict';
/**
 * modules/connectors/lobby_chart.js — render the lobbying analysis as one
 * self-contained HTML file.
 *
 * NO LIBRARIES, NO CDN, NO NETWORK. The charts are hand-written inline SVG.
 * That is deliberate: this file gets opened on a laptop with no internet, in
 * five years, possibly from a backup. A chart that needs to fetch a script
 * from a CDN is a chart that renders as a blank rectangle the day the CDN
 * moves, and a blank rectangle where a finding used to be is the worst
 * possible failure for a research record.
 *
 * WHAT THE CHARTS REFUSE TO DO
 *   - No total mixes `income` with `expenses`. They are different money.
 *     Each axis says which one it is.
 *   - No bar is drawn from a null. A missing figure leaves a gap and is
 *     counted in the caption, because an absent disclosure drawn as zero
 *     reads as a disclosed zero.
 *   - Every count of clients or registrants is labelled "in this library",
 *     because the capture only covers subjects that were actually searched.
 */

const PALETTE = ['#3b6ea5', '#a5603b', '#5a8a4a', '#8a5a8a', '#8a7a3b', '#3b8a8a'];

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

/** Nice round axis maximum, so the top gridline is a number a person reads. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/**
 * Horizontal bars. Used wherever the label is a name, because names are wide
 * and a vertical bar chart turns them into unreadable diagonal text.
 */
function hbar(rows, opts = {}) {
  const fmt = opts.format || ((v) => String(v));
  const shown = rows.slice(0, opts.limit || 15);
  if (!shown.length) return '<p class="empty">Nothing to chart yet.</p>';

  const max = niceMax(Math.max(...shown.map((r) => r.value || 0)));
  const rowH = 26;
  const labelW = 260;
  const barW = 380;
  const h = shown.length * rowH + 24;
  const colour = opts.colour || PALETTE[0];

  const bars = shown.map((r, i) => {
    const y = i * rowH + 8;
    const w = max > 0 ? Math.max(1, (r.value / max) * barW) : 1;
    const label = esc(r.label.length > 38 ? r.label.slice(0, 37) + '…' : r.label);
    return `<g>
      <title>${esc(r.label)} — ${esc(fmt(r.value))}</title>
      <text x="${labelW - 8}" y="${y + 13}" text-anchor="end" class="lbl">${label}</text>
      <rect x="${labelW}" y="${y + 3}" width="${w}" height="${rowH - 10}" rx="2" fill="${colour}"/>
      <text x="${labelW + w + 6}" y="${y + 13}" class="val">${esc(fmt(r.value))}</text>
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${labelW + barW + 90} ${h}" class="chart" role="img"
     aria-label="${esc(opts.title || 'chart')}">${bars}</svg>`;
}

/**
 * One series of money over years, on its own axis.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EACH SERIES GETS ITS OWN AXIS
 *
 * The first version drew income and expenses as grouped bars on a SHARED
 * axis. On real captures that produced $580,000 of income next to
 * $15,020,000 of in-house expenses — and at that ratio the income bars were
 * two pixels tall. The chart was arithmetically correct and read as
 * "outside firms were paid approximately nothing", which is false by three
 * orders of magnitude.
 *
 * A shared axis is a claim that two quantities are comparable. These two are
 * not: they are different money, reported by different kinds of filer, and
 * the whole module exists to keep them apart. So each gets its own panel and
 * its own scale, and the page says out loud that the scales differ — because
 * two side-by-side charts with different axes is the OTHER way to mislead
 * somebody, and the only defence is to label it.
 */
function moneyPanel(rows, key, colour, heading, note) {
  const present = rows.filter((y) => y[key] !== null);
  if (!present.length) {
    return `<div class="pane"><h3>${esc(heading)}</h3>
      <p class="empty">No ${esc(key)} figures in the captured filings.</p></div>`;
  }

  const max = niceMax(Math.max(...present.map((y) => y[key])));
  const W = 460, H = 220, padL = 82, padB = 32, padT = 10;
  const plotW = W - padL - 14, plotH = H - padB - padT;
  const groupW = plotW / rows.length;
  const barW = Math.min(34, groupW * 0.55);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + plotH - f * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${W - 14}" y2="${y}" class="grid"/>
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="val">${esc(usd(f * max))}</text>`;
  }).join('');

  const bars = rows.map((y, i) => {
    const cx = padL + i * groupW + groupW / 2;
    const label = `<text x="${cx}" y="${H - 11}" text-anchor="middle" class="lbl">${esc(String(y.year))}</text>`;
    if (y[key] === null) {
      // Not zero. A year with no figure filed gets a dash, never a flat bar
      // sitting on the axis — that reads as "they reported nothing", which
      // is a different and much stronger claim than "nothing was reported".
      return `<text x="${cx}" y="${padT + plotH - 6}" text-anchor="middle" class="val">—</text>${label}`;
    }
    const bh = Math.max(1, (y[key] / max) * plotH);
    return `<g><title>${esc(String(y.year))} ${esc(heading)}: ${esc(usd(y[key]))}</title>
      <rect x="${cx - barW / 2}" y="${padT + plotH - bh}" width="${barW}"
            height="${bh}" rx="2" fill="${colour}"/></g>${label}`;
  }).join('');

  return `<div class="pane">
    <h3><span class="sw" style="background:${colour}"></span>${esc(heading)}</h3>
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
      aria-label="${esc(heading)} by year">${grid}${bars}</svg>
    <p class="legend">${esc(note)}</p>
  </div>`;
}

/** Two series of money over years, on two axes, never added together. */
function yearBars(byYear) {
  const rows = byYear.filter((y) => y.income !== null || y.expenses !== null);
  if (!rows.length) return '<p class="empty">No reported figures in the captured filings.</p>';

  return `<div class="panes">
    ${moneyPanel(rows, 'income', PALETTE[0], 'Income reported by outside firms',
      'What a lobbying firm reports receiving from a client.')}
    ${moneyPanel(rows, 'expenses', PALETTE[1], 'In-house expenses reported by organisations',
      'What an organisation reports spending lobbying for itself.')}
  </div>
  <p class="note"><b>The two panels use different scales.</b> They have to: these
  are different kinds of money and putting them on one axis makes the smaller
  one look like zero. Compare each panel against itself over time, never one
  panel against the other.</p>`;
}

function render(data) {
  const { analysis, shared, subjects, unparsed, superseded, kept, generated } = data;

  const truncatedSubjects = subjects.filter((s) => s.truncated);
  const unknownCoverage = subjects.filter((s) => s.total === null);

  const coverage = `
    <div class="panel warn">
      <h3>What this covers, and what it does not</h3>
      <p>Built from <b>${subjects.length}</b> captured Senate LDA search${subjects.length === 1 ? '' : 'es'},
      holding <b>${kept}</b> distinct filings after collapsing
      ${superseded} amended filing${superseded === 1 ? '' : 's'} into the quarter${superseded === 1 ? '' : 's'} they restate.</p>
      ${truncatedSubjects.length ? `<p class="bad"><b>${truncatedSubjects.length} search${truncatedSubjects.length === 1 ? ' is' : 'es are'} truncated.</b>
        The connector asks for 25 filings and does not page. These totals are
        floors, not totals:</p>
        <ul>${truncatedSubjects.map((s) => `<li>${esc(s.subject)} — kept ${s.kept} of ${s.total}</li>`).join('')}</ul>` : ''}
      ${unknownCoverage.length ? `<p>${unknownCoverage.length} capture${unknownCoverage.length === 1 ? '' : 's'} did not report a total count,
        so whether they are complete is unknown — not assumed.</p>` : ''}
      ${unparsed.length ? `<p class="bad">${unparsed.length} capture${unparsed.length === 1 ? '' : 's'} would not parse and
        ${unparsed.length === 1 ? 'is' : 'are'} excluded: ${unparsed.map((u) => esc(u.file)).join(', ')}</p>` : ''}
      <p>The connector searches by <b>client name</b>. A registrant's other
      clients are visible only where those clients were also searched, so
      every client count below means <b>in this library</b> — never in the
      world.</p>
    </div>`;

  const sharedRows = shared.length ? `
    <table>
      <thead><tr><th>Registrant</th><th>Clients in this library</th><th>Filings</th><th>Reported income</th></tr></thead>
      <tbody>${shared.slice(0, 25).map((g) => `<tr>
        <td><b>${esc(g.name)}</b></td>
        <td>${g.clients.map((c) => `<span class="chip">${esc(c)}</span>`).join(' ')}</td>
        <td class="num">${g.filings}</td>
        <td class="num">${esc(usd(g.income))}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<p class="empty">No registrant in this library files for more than one captured client yet. Search more clients.</p>';

  const edgeRows = analysis.edges.slice(0, 40).map((e) => `<tr>
      <td>${esc(e.client)}</td>
      <td>${esc(e.registrant)}</td>
      <td class="num">${e.filings}</td>
      <td>${e.years.length ? esc(e.years[0] + (e.years.length > 1 ? '–' + e.years[e.years.length - 1] : '')) : '—'}</td>
      <td class="num">${esc(usd(e.income))}</td>
      <td class="issues">${e.issues.slice(0, 4).map((i) => esc(i)).join(', ')}${e.issues.length > 4 ? ' …' : ''}</td>
    </tr>`).join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>Lobbying filings — Sentinel OS</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg:#ffffff; --fg:#1a1a1a; --dim:#666; --line:#e2e2e2;
    --panel:#f7f7f5; --warn:#fff8e6; --warnline:#e8d9a8; --bad:#a33;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e8e8e6; --dim:#9a9a97; --line:#2c3038;
            --panel:#1d2026; --warn:#2a2418; --warnline:#4a4028; --bad:#e08a8a; }
  }
  * { box-sizing:border-box }
  body { background:var(--bg); color:var(--fg); margin:0; padding:2rem 1.25rem 4rem;
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
         max-width:1000px; margin-inline:auto }
  h1 { font-size:1.6rem; margin:0 0 .25rem }
  h2 { font-size:1.1rem; margin:2.5rem 0 .35rem; padding-bottom:.3rem;
       border-bottom:1px solid var(--line) }
  h3 { font-size:.95rem; margin:0 0 .5rem }
  .sub { color:var(--dim); margin:0 0 1.5rem; font-size:.9rem }
  .note { color:var(--dim); font-size:.85rem; margin:.35rem 0 1rem }
  .panel { background:var(--panel); border:1px solid var(--line);
           border-radius:8px; padding:1rem 1.1rem; margin:1rem 0 }
  .panel.warn { background:var(--warn); border-color:var(--warnline) }
  .panel p { margin:.4rem 0 } .panel ul { margin:.4rem 0 .4rem 1.1rem }
  .bad { color:var(--bad) }
  .empty { color:var(--dim); font-style:italic }
  svg.chart { width:100%; height:auto; display:block; margin:.5rem 0 }
  .lbl { font-size:11px; fill:var(--fg) }
  .val { font-size:10px; fill:var(--dim) }
  .grid { stroke:var(--line); stroke-width:1 }
  .legend { font-size:.82rem; color:var(--dim); margin:.2rem 0 0 }
  .sw { display:inline-block; width:10px; height:10px; border-radius:2px;
        margin:0 .35rem 0 1rem; vertical-align:baseline }
  .legend .sw:first-child { margin-left:0 }
  h3 .sw { margin-left:0 }
  .panes { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:1rem }
  .pane { background:var(--panel); border:1px solid var(--line); border-radius:8px;
          padding:.8rem .9rem }
  .pane h3 { font-size:.85rem; margin:0 0 .25rem }
  .pane .legend { margin-top:.15rem }
  .scroll { overflow-x:auto }
  table { border-collapse:collapse; width:100%; font-size:.86rem; margin-top:.5rem }
  th,td { text-align:left; padding:.42rem .55rem; border-bottom:1px solid var(--line);
          vertical-align:top }
  th { color:var(--dim); font-weight:600; white-space:nowrap }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums }
  td.issues { color:var(--dim); font-size:.8rem }
  .chip { display:inline-block; background:var(--panel); border:1px solid var(--line);
          border-radius:10px; padding:.05rem .45rem; margin:.1rem .15rem .1rem 0;
          font-size:.78rem; white-space:nowrap }
  footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line);
           color:var(--dim); font-size:.82rem }
</style>

<h1>Lobbying filings</h1>
<p class="sub">Senate Lobbying Disclosure Act filings captured by this desk · generated ${esc(generated)}</p>

${coverage}

<h2>Registrants filing for more than one captured client</h2>
<p class="note">A registrant appearing here filed for two or more of the clients
you searched. Unlike a name that merely turns up twice, each row rests on
signed filings under 2 U.S.C. 1603–1604 asserting the relationship. It is
still a lead: a firm with four hundred clients will appear here for reasons
that mean nothing.</p>
<div class="scroll">${sharedRows}</div>

<h2>Registrants by clients in this library</h2>
${hbar(analysis.registrants.map((g) => ({ label: g.name, value: g.clients.length })),
    { title: 'registrants by client count', colour: PALETTE[2] })}

<h2>Clients by number of filings</h2>
${hbar(analysis.clients.map((c) => ({ label: c.name, value: c.filings })),
    { title: 'clients by filing count', colour: PALETTE[0] })}

<h2>Reported figures by year</h2>
<p class="note"><b>These two series are never added together.</b> Income is what
an outside firm reports receiving from a client. Expenses are what an
organisation reports spending on its own in-house lobbying. A filing carries
one or the other, and a total combining them means nothing.</p>
${yearBars(analysis.byYear)}

<h2>Issues lobbied on</h2>
${hbar(analysis.issues.map((s) => ({ label: s.issue, value: s.filings })),
    { title: 'general issue codes by filing count', colour: PALETTE[3], limit: 18 })}

<h2>Every asserted client → registrant relationship</h2>
<p class="note">Top ${Math.min(40, analysis.edges.length)} of ${analysis.edges.length},
by filing count. Income is blank where no figure was reported — that is an
absent disclosure, not a reported zero.</p>
<div class="scroll"><table>
  <thead><tr><th>Client</th><th>Registrant</th><th>Filings</th><th>Years</th>
    <th>Reported income</th><th>Issues</th></tr></thead>
  <tbody>${edgeRows || '<tr><td colspan="6" class="empty">No filings captured yet.</td></tr>'}</tbody>
</table></div>

<footer>
  Every figure here is a <b>lead requiring a primary source</b>. The filings
  themselves are at lda.gov, linked from the captures in
  <code>evidence/captures/</code>, and each capture is hashed in
  <code>evidence/manifests/provenance.jsonl</code>. Nothing on this page is
  evidence until you have read the filing it came from.
</footer>
`;
}

module.exports = { render, hbar, yearBars, moneyPanel, niceMax, usd, esc };
