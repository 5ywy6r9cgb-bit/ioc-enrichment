'use strict';
/**
 * server/schema_version.js — what migrations are applied, and whether the code
 * and the database agree.
 *
 * The failure this prevents: code that expects a v0.7 column running against a
 * v0.6.1 database, and producing a confusing "column does not exist" error deep
 * inside an unrelated operation. Better to say so at startup, in one sentence.
 */

/** Migrations this code expects. Add a row here when you add a migration.
 *
 * This list had stopped at 0002 while migrations/ had reached 0007, so a
 * correctly-migrated database reported five "migrations this code does not
 * know about" and the check that exists to catch drift was itself the thing
 * drifting. A stale checker is worse than no checker: it trains you to ignore
 * the one message that matters. */
const EXPECTED = [
  { version: '0.6.1', migration_id: '0001_v0_6_1_metadata_schema' },
  { version: '0.7.0', migration_id: '0002_v0_7_master_schema' },
  { version: '0.7.1', migration_id: '0003_connector_runs' },
  { version: '0.7.2', migration_id: '0004_lobbying' },
  { version: '0.7.3', migration_id: '0005_federal_jurisdiction' },
  { version: '0.7.4', migration_id: '0006_push_subscriptions' },
  { version: '0.7.5', migration_id: '0007_mandamus_and_delivery' },
  { version: '0.8.0', migration_id: '0008_evidence_relationships' },
];

async function applied(exec) {
  try {
    const res = await exec.query('SELECT version, migration_id, applied_at, description FROM schema_version ORDER BY version');
    return res.rows;
  } catch {
    return [];   // table absent = nothing applied
  }
}

/**
 * Compare expected against applied.
 * Returns { ok, applied, missing, unexpected, message }.
 */
async function check(exec) {
  const rows = await applied(exec);
  const have = new Set(rows.map((r) => r.version));
  const want = new Set(EXPECTED.map((e) => e.version));

  const missing = EXPECTED.filter((e) => !have.has(e.version));
  const unexpected = rows.filter((r) => !want.has(r.version));

  let message;
  if (!rows.length) {
    message = 'No migrations applied. Run: ./scripts/setup_macos.sh (or apply migrations/ by hand).';
  } else if (missing.length) {
    message = `Database is behind the code. Missing: ${missing.map((m) => m.migration_id).join(', ')}`;
  } else if (unexpected.length) {
    message = `Database has migrations this code does not know about: ${unexpected.map((u) => u.version).join(', ')}. `
            + 'The code may be older than the database.';
  } else {
    message = `Schema current: ${rows.map((r) => r.version).join(', ')}`;
  }

  return { ok: missing.length === 0, applied: rows, missing, unexpected, message };
}

module.exports = { check, applied, EXPECTED };
