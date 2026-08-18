#!/usr/bin/env node
'use strict';
/**
 * core/provenance/ingest_to_pra.js — the seam.
 *
 *   sentinel prov ingest evidence/manifests/provenance.jsonl --dry-run
 *   sentinel prov ingest evidence/manifests/provenance.jsonl
 *
 * This is the one place where an artifact produced by ANY module — a connector
 * capture, a rendered video, a vulnerability report, a received record — becomes
 * a row in the PRA `sources` citation ledger. Your architecture document calls
 * it out as the highest-value next step, and names the shape it has to take:
 * one field linking the case store to AtlasOS, not a mesh of cross-imports.
 *
 * What it will not do:
 *
 *   * It will not verify a source for you. Everything lands as `unverified`.
 *     Verification means a human read the underlying document; a successful
 *     import means bytes moved.
 *   * It will not write an absolute path. The schema's
 *     sources_relative_path_only constraint refuses one, and so does this.
 *   * It will not re-import a source_id that already exists. Re-running after
 *     adding new ledger lines imports only the new lines.
 *   * It will not ingest a tampered ledger. verify() runs first; if any line's
 *     self-hash does not recompute, nothing is imported at all.
 */

const fs = require('fs');
const path = require('path');
const P = require('./provenance.js');

const ROOT = path.resolve(__dirname, '..', '..');

// Map a provenance kind to a sources.source_type the v0.7 schema accepts.
const KIND_TO_SOURCE_TYPE = {
  connector_run: 'dataset',
  received_record: 'primary_document',
  video_build: 'other',
  vuln_report: 'dataset',
  source: 'primary_document',
  analysis_report: 'other',
};

// Map a provenance tier to how the citation ledger should regard it.
// Note GREEN means "we hold the bytes and their hash" — custody, not truth.
// It still enters as unverified, because nobody has read the document yet.
const TIER_TO_GLASSMARK = {
  GREEN: null,
  ATTRIBUTED: null,
  SOURCE_NEEDED: 'UNCLASSIFIED',
  GENERATED: null,
  NA: null,
};

function loadEnv() {
  const env = Object.assign({}, process.env);
  for (const candidate of [path.join(ROOT, '.env'), path.join(ROOT, 'modules', 'pra', '.env')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function toSource(rec) {
  const sourceType = KIND_TO_SOURCE_TYPE[rec.kind] || 'other';
  const extra = rec.extra || {};
  return {
    source_id: `PROV-${rec.artifact_id}`,
    title: rec.label || `${rec.kind} ${rec.artifact_id}`,
    source_type: sourceType,
    // A capture we hold the bytes for is primary; anything else is not.
    is_primary: rec.tier === 'GREEN',
    publisher: extra.connector || rec.tool || null,
    url: rec.source_url || null,
    retrieved_at: rec.recorded_at || null,
    local_path: rec.local_path || null,
    sha256: rec.sha256 || null,
    citation_text: buildCitation(rec, extra),
    glassmark: TIER_TO_GLASSMARK[rec.tier] || null,
    // Always. Import is custody, not verification.
    verified_status: 'unverified',
    notes: buildNotes(rec, extra),
  };
}

function buildCitation(rec, extra) {
  const bits = [];
  if (extra.connector) bits.push(`${extra.connector} query "${extra.subject || ''}"`.trim());
  else if (rec.label) bits.push(rec.label);
  if (rec.recorded_at) bits.push(`retrieved ${rec.recorded_at}`);
  if (rec.sha256) bits.push(`sha256 ${rec.sha256.slice(0, 16)}…`);
  return bits.join('; ') || null;
}

function buildNotes(rec, extra) {
  const lines = [`provenance tier ${rec.tier}; recorded by ${rec.tool || 'unknown'} ${rec.tool_version || ''}`.trim()];
  if (extra.result_disposition === 'lead_needs_primary_source') {
    lines.push('RESULTS ARE LEADS. A hit here is not an identification. Confirm same-entity and cite the underlying official document before any use.');
  }
  if (extra.result_count !== undefined) lines.push(`${extra.result_count} result(s) in the capture.`);
  if (extra.live_calls !== undefined) lines.push(`${extra.live_calls} live call(s) made.`);
  if (extra.parse_error) lines.push(`Capture did not parse: ${extra.parse_error}`);
  return lines.join(' ');
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const ledgerPath = argv.find((a) => !a.startsWith('--'));

  if (!ledgerPath) {
    console.error('usage: ingest_to_pra.js <ledger.jsonl> [--dry-run]');
    process.exit(2);
  }
  if (!fs.existsSync(ledgerPath)) {
    console.error(`no such ledger: ${ledgerPath}`);
    process.exit(2);
  }

  // ---- integrity gate: a tampered ledger is never partially imported ----
  const ledger = new P.Ledger(ledgerPath);
  const v = ledger.verify();
  if (!v.ok) {
    console.error(`\n  REFUSING TO INGEST — ${v.tampered.length} ledger line(s) fail their own hash:`);
    for (const t of v.tampered) console.error(`    line ${t.line}  ${t.artifact_id}`);
    console.error('\n  A line was edited after it was written. Nothing was imported.\n');
    process.exit(1);
  }

  const records = ledger.readAll();
  const sources = records.map(toSource);
  console.log(`\n  ledger    ${ledgerPath}`);
  console.log(`  records   ${records.length} (all ${v.total} lines verify)`);

  if (dryRun) {
    console.log('\n  DRY RUN — these rows would be inserted into sources:\n');
    for (const s of sources) {
      console.log(`    ${s.source_id}`);
      console.log(`      title        ${s.title}`);
      console.log(`      type         ${s.source_type}${s.is_primary ? ' (primary)' : ''}`);
      if (s.local_path) console.log(`      local_path   ${s.local_path}`);
      if (s.sha256) console.log(`      sha256       ${s.sha256.slice(0, 32)}…`);
      console.log(`      verified     ${s.verified_status}`);
      console.log('');
    }
    console.log('  Nothing was written.\n');
    return;
  }

  // ---- live import ------------------------------------------------------
  let Pg;
  try {
    Pg = require('pg');
  } catch {
    console.error('\n  the pg driver is not installed. Run: cd modules/pra && npm install\n');
    process.exit(2);
  }

  const env = loadEnv();
  const host = env.PGHOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !host.startsWith('/')) {
    console.error(`\n  refusing to connect to a non-local database host: ${host}`);
    console.error('  Sentinel OS is local-only by design. See modules/pra/config/local.example.env\n');
    process.exit(2);
  }

  const pool = new Pg.Pool({
    host,
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || 'sentinel_pra',
    user: env.PGUSER || 'sentinel_app',
    password: env.PGPASSWORD,
  });

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    // One transaction on one connection — the hardening lesson from
    // README_v0_7: BEGIN/COMMIT through a pool does not guarantee the
    // same connection, so a crash could leave a half-written import.
    await client.query('BEGIN');
    for (const s of sources) {
      const res = await client.query(
        `INSERT INTO sources
           (source_id, title, source_type, is_primary, publisher, url,
            retrieved_at, local_path, sha256, citation_text, glassmark,
            verified_status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (source_id) DO NOTHING`,
        [s.source_id, s.title, s.source_type, s.is_primary, s.publisher, s.url,
         s.retrieved_at, s.local_path, s.sha256, s.citation_text, s.glassmark,
         s.verified_status, s.notes]
      );
      if (res.rowCount) inserted += 1; else skipped += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n  import failed and was rolled back: ${e.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n  inserted  ${inserted}`);
  console.log(`  skipped   ${skipped} (already present)`);
  console.log('\n  All rows entered as verified_status=unverified.');
  console.log('  Import is custody, not verification — read the document before you cite it.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
