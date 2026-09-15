'use strict';
/**
 * modules/connectors/box.js — THE BOX. One page, everything the library
 * currently supports, with the denominator attached to every number.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PAGE AND NOT MORE TERMINAL
 *
 * Nine hundred captures is not a library anybody reads. The terminal is right
 * for one question at a time and wrong for "what do I actually have" — you
 * cannot scroll two screens apart and compare them.
 *
 * So: one self-contained HTML file. No CDN, no fonts fetched, no scripts from
 * anywhere. It opens from disk with the network off, because a page about
 * provenance that phones out for a stylesheet is not making the point.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO DO
 *
 * It does not draw a red-string board. Every edge on the chart is labelled
 * with the GRADE of the weaker of its two sides, and a CO-OCCURRENCE edge is
 * drawn as a faint dotted line with the words on it, because a picture is the
 * easiest place in the world to launder a co-occurrence into a relationship.
 *
 * It does not compute a score and call it a verdict. Every count carries what
 * it is a count OF.
 *
 * And it prints the UNASKED sets at the top, not the bottom — an empty
 * domain is the thing most likely to be read as a finding.
 */

const fs = require('fs');
const path = require('path');
const X = require('./crosslink.js');
const N = require('./nexus.js');
const V = require('./coverage.js');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A bipartite entity-to-domain chart, as inline SVG.
 *
 * Deliberately NOT a force-directed hairball. A force layout looks like
 * intelligence work and communicates nothing — every node ends up near every
 * other node and the eye reads proximity as relationship. Two columns:
 * entities on the left, domains on the right, one line each. You can count
 * the lines, which is the entire point.
 */
function chart(bridges, opts = {}) {
  const limit = opts.limit || 28;
  const byEntity = new Map();
  for (const b of bridges) {
    if (!byEntity.has(b.key)) byEntity.set(b.key, { name: b.name, domains: new Map(), best: b.grade });
    const g = byEntity.get(b.key);
    for (const d of [b.a, b.b]) {
      const prev = g.domains.get(d);
      if (!prev || N.GRADE_RANK[b.grade] > N.GRADE_RANK[prev]) g.domains.set(d, b.grade);
    }
    if (N.GRADE_RANK[b.grade] > N.GRADE_RANK[g.best]) g.best = b.grade;
  }
  const ents = [...byEntity.values()]
    .sort((a, b) => N.GRADE_RANK[b.best] - N.GRADE_RANK[a.best]
      || b.domains.size - a.domains.size
      || a.name.localeCompare(b.name))
    .slice(0, limit);

  const domains = [...new Set(ents.flatMap((e) => [...e.domains.keys()]))].sort();
  if (!ents.length || !domains.length) {
    return '<p class="none">Nothing bridges two domains yet. Sweep a second '
         + 'set — nothing can cross to a domain with nothing in it.</p>';
  }

  const rowH = 26;
  const H = Math.max(ents.length, domains.length) * rowH + 60;
  const W = 900;
  const lx = 250;
  const rx = 640;
  const ey = (i) => 40 + i * rowH;
  const dy = (i) => 40 + i * rowH;
  const dIndex = new Map(domains.map((d, i) => [d, i]));

  const STROKE = {
    ASSERTED: 'stroke="#1b6b4a" stroke-width="2"',
    REGISTRY: 'stroke="#b08426" stroke-width="1.5" stroke-dasharray="6 3"',
    'CO-OCCURRENCE': 'stroke="#8f98a6" stroke-width="1" stroke-dasharray="2 4"',
  };

  const lines = [];
  ents.forEach((e, i) => {
    for (const [d, grade] of e.domains) {
      lines.push(`<path d="M ${lx} ${ey(i)} C ${lx + 120} ${ey(i)}, `
        + `${rx - 120} ${dy(dIndex.get(d))}, ${rx} ${dy(dIndex.get(d))}" `
        + `fill="none" ${STROKE[grade]}><title>${esc(e.name)} — ${esc(d)} — `
        + `${esc(grade)}</title></path>`);
    }
  });

  const entLabels = ents.map((e, i) =>
    `<text x="${lx - 10}" y="${ey(i) + 4}" text-anchor="end" class="n ${e.best === 'ASSERTED' ? 'strong' : ''}">`
    + `${esc(e.name.slice(0, 38))}</text>`
    + `<circle cx="${lx}" cy="${ey(i)}" r="3" class="dot ${e.best}"/>`).join('');

  const domLabels = domains.map((d, i) =>
    `<circle cx="${rx}" cy="${dy(i)}" r="4" class="dom"/>`
    + `<text x="${rx + 12}" y="${dy(i) + 4}" class="d">${esc(d)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
   aria-label="Entities on the left, domains on the right, one line per bridge">
  <text x="${lx - 10}" y="22" text-anchor="end" class="hdr">ENTITY</text>
  <text x="${rx + 12}" y="22" class="hdr">DOMAIN</text>
  ${lines.join('\n  ')}
  ${entLabels}
  ${domLabels}
</svg>`;
}

function bar(share) {
  const w = Math.round(share * 100);
  const cls = share === 0 ? 'none' : (share === 1 ? 'full' : 'part');
  return `<span class="bar"><i class="${cls}" style="width:${w}%"></i></span>`;
}

function render(captures, subjects, opts = {}) {
  const sets = V.setCoverage(captures, subjects);
  const conns = V.connectorCoverage(captures);
  const floors = V.flooredCaptures(captures);
  const figs = V.figures(captures, subjects);
  const never = V.neverAsked(sets);
  const built = N.build(captures, subjects);
  const bridges = N.bridges(built);
  const pairs = N.pairTable(bridges);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const figRows = figs.map((f) => `
    <tr>
      <td class="num">${f.value.toLocaleString()}</td>
      <td class="of">${f.of !== null ? 'of ' + f.of.toLocaleString() : ''}</td>
      <td class="pc">${f.of ? ((f.value / f.of) * 100).toFixed(1) + '%' : ''}</td>
      <td>${esc(f.label)}</td>
      <td><span class="shape ${esc(f.shape).replace(/ /g, '_')}">${esc(f.shape)}</span></td>
    </tr>
    <tr class="note"><td colspan="5">${esc(f.note)}</td></tr>`).join('');

  const setRows = sets.map((s) => `
    <tr class="${s.asked === 0 ? 'empty' : ''}">
      <td>${bar(s.share)}</td>
      <td class="num">${s.asked}/${s.defined}</td>
      <td><b>${esc(s.set)}</b></td>
      <td class="num">${s.rows.toLocaleString()}</td>
      <td class="tiny">${esc(s.connectors.join(' '))}</td>
      <td class="tiny">${s.missing.length ? 'not asked: ' + esc(s.missing.slice(0, 5).join(', '))
        + (s.missing.length > 5 ? ` +${s.missing.length - 5}` : '') : ''}</td>
    </tr>`).join('');

  const connRows = conns.map((c) => {
    const share = c.rows ? c.NAME / c.rows : 0;
    return `
    <tr>
      <td>${esc(c.label)}</td>
      <td class="num">${c.rows.toLocaleString()}</td>
      <td class="num ${share >= 0.5 ? 'good' : (share > 0 ? 'warn' : 'bad')}">${c.NAME}</td>
      <td class="num">${c.CONTAINS}</td>
      <td class="num">${c.OTHER}</td>
      <td class="num">${c.SUBSTRING}</td>
      <td class="num">${c.subjects}</td>
      <td>${c.capped ? `<span class="shape FLOOR">${c.capped} capped</span>` : ''}</td>
    </tr>`;
  }).join('');

  const pairRows = pairs.slice(0, 20).map((p) => `
    <tr><td class="num">${p.count}</td><td>${esc(p.pair)}</td>
    <td class="tiny">${Object.entries(p.grades)
      .sort((a, b) => N.GRADE_RANK[b[0]] - N.GRADE_RANK[a[0]])
      .map(([k, v]) => `${v} ${esc(k.toLowerCase())}`).join(' · ')}</td></tr>`).join('');

  const floorRows = floors.slice(0, 20).map((f) => `
    <tr><td>${esc(f.subject)}</td><td class="tiny">${esc(f.connector)}</td>
    <td class="num">${f.held}</td><td class="num">${f.declared}</td>
    <td class="num warn">${f.missing}</td></tr>`).join('');

  const gapItems = N.UNREACHABLE.map((g) => `
    <div class="gap">
      <h4>${esc(g.join)}</h4>
      <p>${esc(g.why)}</p>
      <p class="reg"><b>REGISTER</b> ${esc(g.register)}</p>
      <p class="how">${esc(g.how)}</p>
    </div>`).join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>The Box — Sentinel</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--paper:#e9ebee;--white:#fcfcfa;--ink:#12161c;--accent:#a32222;
--green:#1b6b4a;--muted:#8f98a6;--rule:#c6cbd2;--cyan:#0e7480;--gold:#b08426}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:15px/1.5 ui-sans-serif,-apple-system,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 80px}
header{border-bottom:3px solid var(--ink);padding-bottom:10px;margin-bottom:6px}
h1{font-size:26px;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin:4px 0 0}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;
margin:34px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--rule)}
.lede{background:var(--white);border-left:3px solid var(--accent);
padding:12px 14px;margin:14px 0;font-size:14px}
.lede b{color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--white);font-size:13px}
th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;
color:var(--muted);padding:7px 8px;border-bottom:1px solid var(--rule)}
td{padding:6px 8px;border-bottom:1px solid #eef0f3;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.of,.pc{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.tiny{font-size:11px;color:var(--muted)}
tr.note td{border:0;padding:0 8px 9px;color:var(--muted);font-size:12px}
tr.empty{background:#fdf6f6}
.good{color:var(--green)}.warn{color:var(--gold)}.bad{color:var(--accent)}
.shape{font-size:10px;letter-spacing:.06em;padding:2px 6px;border-radius:2px;
background:var(--muted);color:#fff;white-space:nowrap}
.shape.TOTAL{background:var(--green)}
.shape.FLOOR,.shape.FLOOR_AND_CEILING,.shape.CEILING{background:var(--gold)}
.shape.UNKNOWN{background:var(--muted)}
.bar{display:inline-block;width:52px;height:8px;background:#e2e5e9;border-radius:1px}
.bar i{display:block;height:8px;border-radius:1px}
.bar i.full{background:var(--green)}.bar i.part{background:var(--gold)}
.bar i.none{background:var(--accent);width:100%!important;opacity:.25}
.chart{width:100%;height:auto;background:var(--white);margin-top:8px}
.chart .n{font:11px ui-sans-serif,Arial;fill:#41485a}
.chart .n.strong{fill:var(--ink);font-weight:600}
.chart .d{font:11px ui-sans-serif,Arial;fill:var(--ink);font-weight:600}
.chart .hdr{font:10px ui-sans-serif,Arial;fill:var(--muted);letter-spacing:.08em}
.chart .dot{fill:var(--muted)}.chart .dot.ASSERTED{fill:var(--green)}
.chart .dot.REGISTRY{fill:var(--gold)}
.chart .dom{fill:var(--cyan)}
.key{font-size:12px;color:var(--muted);margin-top:8px}
.key i{display:inline-block;width:26px;height:0;vertical-align:middle;margin:0 5px}
.k1{border-top:2px solid var(--green)}
.k2{border-top:2px dashed var(--gold)}
.k3{border-top:1px dotted var(--muted)}
.gap{background:var(--white);padding:11px 13px;margin:8px 0;border-left:3px solid var(--gold)}
.gap h4{margin:0 0 5px;font-size:13px;color:var(--accent)}
.gap p{margin:4px 0;font-size:12.5px}
.gap .reg{color:var(--ink)}.gap .how{color:var(--muted)}
.rule{background:var(--ink);color:#e6e9ee;padding:16px 18px;margin-top:34px;font-size:14px}
.rule b{color:#fff}
.none{color:var(--muted);font-style:italic;padding:14px;background:var(--white)}
code{background:#e2e5e9;padding:1px 5px;border-radius:2px;font-size:12px}
@media print{body{background:#fff}.wrap{max-width:none}}
</style>
<div class="wrap">
<header>
  <h1>The Box</h1>
  <p class="sub">${captures.length.toLocaleString()} capture(s) ·
  ${built.entities.length.toLocaleString()} entit(ies) · built ${esc(when)} ·
  no network call · every number below carries what it is a number OF</p>
</header>

<div class="lede">
  <b>&ldquo;We found nothing&rdquo; and &ldquo;we did not look&rdquo; produce
  identical output.</b> Every serious error in this investigation has been one
  read as the other. This page exists to tell them apart, so read the coverage
  before you read the findings.
</div>

${never.length ? `<div class="lede"><b>${never.length} set(s) never asked:</b>
${esc(never.join(', '))}. Those are not empty findings &mdash; they are
unasked questions. Nothing can bridge to a domain with nothing in it.</div>` : ''}

<h2>Every number, with its denominator</h2>
<table><thead><tr><th class="num">value</th><th class="of">of</th>
<th class="pc">share</th><th>what it counts</th><th>shape</th></tr></thead>
<tbody>${figRows}</tbody></table>
<p class="tiny"><b>TOTAL</b> the register was exhausted &middot;
<b>FLOOR</b> the paging ran out, the real number is larger by an unknown amount
&middot; <b>CEILING</b> the search was fuzzy and the count still contains rows
that are not your subject. A number with no shape reads as a TOTAL to
everybody.</p>

<h2>Connection chart &mdash; entities that bridge two domains</h2>
${chart(bridges, opts)}
<p class="key">
<i class="k1"></i>ASSERTED &mdash; somebody swore to it: a lobbying filing, a
federal award, a court docket
<i class="k2"></i>REGISTRY &mdash; the entity exists as filed
<i class="k3"></i>CO-OCCURRENCE &mdash; two names in one document, which is
never a finding on its own.<br>
Each line takes the grade of the <b>weaker</b> of its two sides, because a
chain is only as strong as the link that has to hold. Hover a line for the
pair and its grade.</p>

<h2>Domain pairs &mdash; rarest first, and the count IS the denominator</h2>
${pairs.length ? `<table><thead><tr><th class="num">entities</th><th>pair</th>
<th>grades</th></tr></thead><tbody>${pairRows}</tbody></table>
<p class="tiny">A pair crossed by ninety entities is what an industry looks
like. A pair crossed by one is a question.</p>`
  : '<p class="none">No pairs yet.</p>'}

<h2>Subject sets &mdash; asked, of defined</h2>
<table><thead><tr><th>coverage</th><th class="num">asked</th><th>set</th>
<th class="num">rows</th><th>registers</th><th>gaps</th></tr></thead>
<tbody>${setRows}</tbody></table>
<p class="tiny">A set is a list somebody typed, not a census &mdash; so this is
coverage of the plan, not of the world.</p>

<h2>Registers &mdash; what each one actually carried</h2>
<table><thead><tr><th>register</th><th class="num">rows</th>
<th class="num">filed under</th><th class="num">contains</th>
<th class="num">other</th><th class="num">substring</th>
<th class="num">subjects</th><th></th></tr></thead>
<tbody>${connRows}</tbody></table>
<p class="tiny">A register with many rows and few <b>filed under</b> rows has
not told you about your subject &mdash; it has told you about its own index.
That is not a fault in the register. It is the difference between a name field
and a full-text field, and it decides what a row can be used for.</p>

${floors.length ? `<h2>Captures that hit a page cap</h2>
<p class="tiny">Every figure derived from one of these is a <b>FLOOR</b>.</p>
<table><thead><tr><th>subject</th><th>register</th><th class="num">held</th>
<th class="num">declared</th><th class="num">never fetched</th></tr></thead>
<tbody>${floorRows}</tbody></table>
<p class="tiny">Page past them with <code>--pages 25</code>, or write FLOOR
beside the number.</p>` : ''}

<h2>What no command here can reach</h2>
<p class="tiny">Static on purpose. An absence produced by a missing connector
must never be reported as an absence in the world.</p>
${gapItems}

<div class="rule">
<b>A connection is a fact. A conclusion is not.</b><br>
Documents first. Connections second. Conclusions last.
</div>
</div>`;
}

module.exports = { render, chart, esc };
