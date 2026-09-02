'use strict';
/**
 * modules/connectors/olac/olac_crawler.js
 * Ohio Lobbying Activity Center (OLAC / JLEC) — Playwright crawler.
 *
 *   node modules/connectors/olac/olac_crawler.js probe
 *   node modules/connectors/olac/olac_crawler.js employer "Negev Foundation" --investigation=the-water
 *   node modules/connectors/olac/olac_crawler.js agent 1182 --investigation=the-water
 *   ...add --headed to watch it work, --dry-run to make no request at all
 *
 * WHY A CRAWLER AND NOT A CONNECTOR
 *
 * OLAC is a public disclosure registry with no API. Every other connector in
 * this system talks to a documented endpoint; this one drives a browser
 * because the state offers no other door. That makes it the most fragile
 * thing here, and the discipline below exists because of that fragility.
 *
 * THE FIVE RULES
 *
 * 1. PUBLIC PAGES ONLY. No login, no paywall, no form the public cannot use.
 *    OLAC's search is open; that is the whole surface this touches.
 *
 * 2. SLOW ON PURPOSE. One page at a time, with a real delay between requests.
 *    This is a small state agency's server, not a CDN. A crawler that costs
 *    the public money to serve is a crawler that deserves to be blocked.
 *
 * 3. THE BYTES ARE THE EVIDENCE. Every page is saved as raw HTML AND a
 *    screenshot, hashed, and written to the provenance ledger BEFORE anything
 *    is parsed out of it. Derived data without the source page is not
 *    evidence — it is a claim about a page nobody can check.
 *
 * 4. PARSED FIELDS ARE LEADS. A row scraped from a table is `unverified`
 *    until a human reads the filing. The selectors below are guesses about a
 *    page that will change; when they break, the capture still succeeded and
 *    can be re-parsed offline.
 *
 * 5. LOBBYISTS ARE PUBLIC ROLES. Agent and officer names are recorded as
 *    public-role entities. No home address, no personal contact detail.
 *
 * THE LIMITATION THAT SHAPES EVERYTHING
 *
 * OLAC's agent search shows ONLY CURRENT engagements — terminated ones are
 * not in the results. So this crawler treats every run as an OBSERVATION,
 * not a statement of fact: lobbying_engagements records first_seen_on /
 * last_seen_on / still_present, and the nightly run is what builds the
 * history the search tool refuses to give you. See migration 0004.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE = process.env.SENTINEL_EVIDENCE_DIR || path.join(ROOT, 'evidence');
const P = require(path.join(ROOT, 'core', 'provenance', 'provenance.js'));

const BASE = 'https://www2.jlec-olig.state.oh.us/olac';
const VERSION = '0.1.0';

// Politeness. Not configurable downward by accident.
const MIN_DELAY_MS = 2000;
const NAV_TIMEOUT_MS = 45000;
const UA = `SentinelOS-research/${VERSION} (public records research; contact via operator)`;

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function slug(s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60); }

// ---------------------------------------------------------------- evidence
/**
 * Save the page as bytes before reading it. Returns the provenance record.
 * This runs even when parsing later fails — that is the point.
 */
async function capturePage(page, { label, investigation, runId, url }) {
  const dir = path.join(EVIDENCE, 'investigations', investigation || 'unfiled', 'olac', stamp().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });

  const base = `olac_${slug(label)}_${stamp()}`;
  const htmlPath = path.join(dir, `${base}.html`);
  const shotPath = path.join(dir, `${base}.png`);

  const html = await page.content();
  fs.writeFileSync(htmlPath, html, 'utf8');
  await page.screenshot({ path: shotPath, fullPage: true });

  const htmlHash = crypto.createHash('sha256').update(html, 'utf8').digest('hex');

  const ledger = new P.Ledger(path.join(EVIDENCE, 'manifests', 'provenance.jsonl'));
  const record = P.makeRecord({
    kind: 'received_record',
    artifactId: `olac-${slug(label)}-${stamp()}`,
    label: `OLAC capture: ${label}`,
    tool: 'olac_crawler',
    toolVersion: VERSION,
    tier: 'GREEN',                 // we hold the exact bytes and their hash
    sha256: htmlHash,
    localPath: htmlPath,
    evidenceRoot: EVIDENCE,
    sourceUrl: url || page.url(),
    extra: {
      connector: 'olac',
      investigation: investigation || null,
      connector_run_id: runId || null,
      screenshot: path.relative(EVIDENCE, shotPath),
      capture_kind: 'rendered_html_plus_screenshot',
      note: 'Rendered page as served. Parsed fields are leads until a human reads the filing.',
    },
  });
  ledger.append(record);

  return {
    htmlPath, shotPath, htmlHash, html,
    relHtml: path.relative(EVIDENCE, htmlPath),
    relShot: path.relative(EVIDENCE, shotPath),
    record,
  };
}

// ---------------------------------------------------------------- parsing
/**
 * Pull every table on the page into arrays of rows.
 *
 * Deliberately generic. A selector tuned to today's markup breaks silently
 * when the page changes; a generic table sweep degrades to "found nothing",
 * which is visible. The capture is already on disk either way.
 */
async function extractTables(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('table')).map((t, idx) => {
      const rows = Array.from(t.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) => clean(c.textContent)));
      const links = Array.from(t.querySelectorAll('a[href]')).map((a) => ({
        text: clean(a.textContent), href: a.getAttribute('href'),
      }));
      return { index: idx, rowCount: rows.length, rows: rows.filter((r) => r.some(Boolean)), links };
    }).filter((t) => t.rowCount > 1);
  });
}

/** Heuristic: which captured table looks like a results grid? */
function pickResultsTable(tables) {
  if (!tables.length) return null;
  return tables.slice().sort((a, b) => b.rowCount - a.rowCount)[0];
}

/**
 * Turn a results table into records, using its own header row for keys.
 * No assumption about column order — OLAC reorders columns between reports.
 */
function tableToRecords(table) {
  if (!table || table.rows.length < 2) return [];
  const header = table.rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return table.rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = r[i] ?? null; });
    return o;
  }).filter((o) => Object.values(o).some((v) => v));
}

// ---------------------------------------------------------------- browser
async function withBrowser(opts, fn) {
  const { chromium } = require('playwright');
  const launch = { headless: !opts.headed };
  // The sandbox ships a browser at a known path; respect it when present.
  if (fs.existsSync('/opt/pw-browsers/chromium')) launch.executablePath = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(launch);
  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1400, height: 1000 },
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- commands
/** probe — does the site answer, and what does the entry page look like? */
async function cmdProbe(opts) {
  console.log('\n' + C.b('OLAC — probe'));
  console.log(`  target      ${BASE}/`);
  console.log(`  calls       1 (exactly)`);
  console.log(`  politeness  ${MIN_DELAY_MS}ms between requests, one page at a time`);
  console.log(`  captures    raw HTML + full-page screenshot, hashed before parsing`);
  if (opts.dryRun) { console.log('\n  ' + C.y('DRY RUN — no request made.') + '\n'); return; }

  await withBrowser(opts, async (page) => {
    const url = `${BASE}/`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => ({ _err: e.message }));
    if (res && res._err) { console.log('  ' + C.r(`navigation failed: ${res._err}`)); return; }
    const status = res ? res.status() : 0;
    console.log(`\n  HTTP ${status}`);
    console.log(`  title       ${await page.title()}`);

    const cap = await capturePage(page, { label: 'probe', investigation: opts.investigation, url });
    console.log(`  capture     evidence/${cap.relHtml}`);
    console.log(`  screenshot  evidence/${cap.relShot}`);
    console.log(`  sha256      ${cap.htmlHash}`);

    const tables = await extractTables(page);
    console.log(`  tables      ${tables.length} found`);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ t: (a.textContent || '').replace(/\s+/g, ' ').trim(), h: a.getAttribute('href') }))
        .filter((x) => x.t && /search|report|agent|employer|filing|activity/i.test(x.t + ' ' + x.h))
        .slice(0, 20));
    if (links.length) {
      console.log('\n  ' + C.b('navigation worth knowing about'));
      for (const l of links) console.log(`    ${l.t.slice(0, 52).padEnd(54)} ${l.h}`);
    }
    console.log('');
  });
}

/** employer — search filings by employer name. */
async function cmdEmployer(name, opts) {
  console.log('\n' + C.b('OLAC — employer search'));
  console.log(`  employer    ${name}`);
  console.log(`  target      ${BASE}/Reports/SearchGrid.aspx`);
  if (opts.dryRun) { console.log('\n  ' + C.y('DRY RUN — no request made.') + '\n'); return; }

  await withBrowser(opts, async (page) => {
    const url = `${BASE}/Reports/SearchGrid.aspx`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(MIN_DELAY_MS);

    // Find a text input that plausibly takes an employer name. ASP.NET WebForms
    // ids are unstable, so match on several signals rather than one selector.
    const filled = await page.evaluate((employer) => {
      const inputs = Array.from(document.querySelectorAll('input[type=text], input:not([type])'));
      const scored = inputs.map((el) => {
        const hay = `${el.id} ${el.name} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        let score = 0;
        if (/employer|company|client|organization/.test(hay)) score += 3;
        if (/name|search|txt/.test(hay)) score += 1;
        return { el, score };
      }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
      if (!scored.length) return null;
      const target = scored[0].el;
      target.value = employer;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { id: target.id || null, name: target.name || null };
    }, name);

    if (!filled) {
      console.log('  ' + C.y('could not identify the employer field on this page.'));
      const cap = await capturePage(page, { label: `employer_${slug(name)}_form`, investigation: opts.investigation, url });
      console.log(`  captured the page anyway: evidence/${cap.relHtml}`);
      console.log('  ' + C.dim('Read the capture, then update the selector heuristic in cmdEmployer.'));
      return;
    }
    console.log(`  field       ${filled.id || filled.name}`);

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('input[type=submit], button'))
          .find((b) => /search|submit|go/i.test(b.value || b.textContent || ''));
        if (btn) btn.click();
      }),
    ]);
    await sleep(MIN_DELAY_MS);

    const cap = await capturePage(page, { label: `employer_${slug(name)}`, investigation: opts.investigation, url: page.url() });
    console.log(`  capture     evidence/${cap.relHtml}`);
    console.log(`  sha256      ${cap.htmlHash}`);

    const tables = await extractTables(page);
    const results = pickResultsTable(tables);
    const records = tableToRecords(results);
    console.log(`  results     ${records.length} row(s) parsed from ${tables.length} table(s)`);

    if (records.length) {
      const outDir = path.join(EVIDENCE, 'investigations', opts.investigation || 'unfiled', 'olac');
      fs.mkdirSync(outDir, { recursive: true });
      const jsonPath = path.join(outDir, `employer_${slug(name)}_${stamp()}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify({
        query: { type: 'employer', employer: name },
        captured_at: new Date().toISOString(),
        source_url: page.url(),
        raw_html: path.relative(EVIDENCE, cap.htmlPath),
        raw_html_sha256: cap.htmlHash,
        disposition: 'lead_needs_primary_source',
        records,
      }, null, 2));
      console.log(`  parsed      evidence/${path.relative(EVIDENCE, jsonPath)}`);
      console.log('\n  ' + C.b('first rows'));
      for (const r of records.slice(0, 5)) console.log('    ' + JSON.stringify(r).slice(0, 130));
    } else {
      console.log('  ' + C.y('no rows parsed — the capture is on disk; re-parse offline.'));
    }
    console.log('\n  ' + C.y('Parsed rows are LEADS.') + C.dim(' Read the filing before citing anything.\n'));
  });
}

/** agent — the "Employers for [agent]" report. Current engagements only. */
async function cmdAgent(agentId, opts) {
  console.log('\n' + C.b('OLAC — agent report'));
  console.log(`  agent id    ${agentId}`);
  const url = `${BASE}/reports/ViewAgent.aspx?id=${encodeURIComponent(agentId)}`;
  console.log(`  target      ${url}`);
  console.log('  ' + C.y('NOTE: this report lists CURRENT engagements only.'));
  console.log(C.dim('        Terminated engagements are absent. History comes from repeated'));
  console.log(C.dim('        observation (lobbying_engagements) and from the AER filings.'));
  if (opts.dryRun) { console.log('\n  ' + C.y('DRY RUN — no request made.') + '\n'); return; }

  await withBrowser(opts, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(MIN_DELAY_MS);

    const cap = await capturePage(page, { label: `agent_${agentId}`, investigation: opts.investigation, url });
    console.log(`\n  capture     evidence/${cap.relHtml}`);
    console.log(`  sha256      ${cap.htmlHash}`);

    const tables = await extractTables(page);
    const records = tableToRecords(pickResultsTable(tables));
    console.log(`  employers   ${records.length} row(s)`);

    const outDir = path.join(EVIDENCE, 'investigations', opts.investigation || 'unfiled', 'olac');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `agent_${agentId}_${stamp()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({
      query: { type: 'agent', agent_id: agentId },
      captured_at: new Date().toISOString(),
      observation_note:
        'CURRENT engagements only. Absence here does not mean an engagement never existed.',
      source_url: url,
      raw_html: path.relative(EVIDENCE, cap.htmlPath),
      raw_html_sha256: cap.htmlHash,
      disposition: 'lead_needs_primary_source',
      records,
    }, null, 2));
    console.log(`  parsed      evidence/${path.relative(EVIDENCE, jsonPath)}`);
    for (const r of records.slice(0, 10)) console.log('    ' + JSON.stringify(r).slice(0, 130));
    console.log('');
  });
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const args = argv.filter((a) => !a.startsWith('--'));
  const opts = {
    dryRun: flags.includes('--dry-run'),
    headed: flags.includes('--headed'),
    investigation: (flags.find((f) => f.startsWith('--investigation=')) || '').split('=')[1] || null,
  };

  const cmd = args[0] || 'probe';
  if (cmd === 'probe') return cmdProbe(opts);
  if (cmd === 'employer') return cmdEmployer(args.slice(1).join(' '), opts);
  if (cmd === 'agent') return cmdAgent(args[1], opts);

  console.error('usage: olac_crawler.js probe | employer "<name>" | agent <id>  [--investigation=ID] [--headed] [--dry-run]');
  process.exit(2);
}

module.exports = { extractTables, tableToRecords, pickResultsTable, capturePage, BASE, VERSION, MIN_DELAY_MS };

if (require.main === module) {
  main().catch((e) => { console.error('\n  crawler failed:', e.message, '\n'); process.exit(1); });
}
