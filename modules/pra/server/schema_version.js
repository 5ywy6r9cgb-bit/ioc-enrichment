'use strict';
/**
 * server/schema_version.js — what migrations are applied, and whether the code
 * and the database agree.
 *
 * The failure this prevents: code that expects a v0.7 column running against a
 * v0.6.1 database, and producing a confusing "column does not exist" error deep
 * inside an unrelated operation. Better to say so at startup, in one sentence.
 */

/**
 * Migrations this code expects, in order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS LIST DRIFTED, AND THE DRIFT MADE THE CHECK LIE
 *
 * Migrations 0003–0007 each insert their own row into schema_version (0.7.1
 * through 0.7.5) and none of them were added here. On a correctly migrated
 * database the startup check therefore said, every single time:
 *
 *   Database has migrations this code does not know about: 0.7.1, 0.7.2,
 *   0.7.3, 0.7.4, 0.7.5. The code may be older than the database.
 *
 * The code was not older than the database. The list was just stale — and
 * because `ok` is computed from `missing` alone, the check PASSED while
 * printing that sentence. A warning that is wrong on every healthy startup
 * is a warning an operator learns to scroll past, which is the only way a
 * startup check ever really fails.
 *
 * tests/schema_version.test.js now reads migrations/*.sql and asserts this
 * array matches what those files actually insert, so it cannot drift again.
 * ADD THE MIGRATION FILE FIRST. Adding a row here for a .sql that does not
 * exist yet makes `check()` report "Database is behind the code" and go
 * not-ok, for a migration nobody can apply.
 */
const EXPECTED = [
  { version: '0.6.1', migration_id: '0001_v0_6_1_metadata_schema' },
  { version: '0.7.0', migration_id: '0002_v0_7_master_schema' },
  { version: '0.7.1', migration_id: '0003_connector_runs' },
  { version: '0.7.2', migration_id: '0004_lobbying' },
  { version: '0.7.3', migration_id: '0005_federal_jurisdiction' },
  { version: '0.7.4', migration_id: '0006_push_subscriptions' },
  { version: '0.7.5', migration_id: '0007_mandamus_and_delivery' },
];

async function applied(exec) {
  try {
    // ORDER BY version is a STRING sort. It is correct through 0.9.x and
    // wrong the moment a 0.10.0 exists, which sorts before 0.7.0. Ordering
    // is cosmetic here — check() compares sets, not sequence — so this is
    // left as-is rather than papered over with a fragile cast, and named so
    // the next reader does not have to rediscover it.
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
