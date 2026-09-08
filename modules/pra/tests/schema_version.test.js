'use strict';
/**
 * tests/schema_version.test.js — the EXPECTED list must match the migrations.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DRIFT THIS EXISTS TO STOP
 *
 * Migrations 0003–0007 each insert their own schema_version row (0.7.1
 * through 0.7.5). None of them was added to EXPECTED. So on a correctly
 * migrated database the startup check reported, every time:
 *
 *   Database has migrations this code does not know about: 0.7.1 … 0.7.5.
 *   The code may be older than the database.
 *
 * The code was not older than the database. And because `ok` is computed
 * from `missing` alone, the check PASSED while printing that sentence — a
 * warning that is wrong on every healthy startup, which is precisely the
 * kind an operator learns to scroll past.
 *
 * Nothing compared the list to the directory, so nothing noticed. This does.
 */
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const SV = require('../server/schema_version.js');

const MIG = path.join(__dirname, '..', 'migrations');

/**
 * Every (version, migration_id) a migration actually inserts.
 *
 * The column list is NOT fixed across files — 0007 writes
 * (version, migration_id, applied_at, description) while the others write
 * (version, migration_id, description) — so the parser reads the VALUES
 * tuple's first two string literals rather than assuming a shape. A parser
 * that assumed one shape would silently skip 0007 and report agreement that
 * was not there.
 */
function declaredByMigrations() {
  const out = [];
  for (const file of fs.readdirSync(MIG).sort()) {
    if (!file.endsWith('.sql')) continue;
    // The rollback only DROPs tables; it declares no version.
    if (file.includes('rollback')) continue;
    const sql = fs.readFileSync(path.join(MIG, file), 'utf8');
    const m = /INSERT\s+INTO\s+schema_version\s*\([^)]*\)\s*VALUES\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/i.exec(sql);
    if (m) out.push({ version: m[1], migration_id: m[2], file });
  }
  return out;
}

module.exports = function run() {
  H.suite('schema_version — the code and the migrations agree');

  const declared = declaredByMigrations();
  H.check(`every migration declares a version (found ${declared.length})`,
    declared.length >= 7, JSON.stringify(declared.map((d) => d.version)));

  // Every .sql that is not a rollback must declare one, or it applies
  // silently and the database's own record of itself is incomplete.
  const files = fs.readdirSync(MIG)
    .filter((f) => f.endsWith('.sql') && !f.includes('rollback'));
  H.check('no migration applies without recording its own version',
    declared.length === files.length,
    `${files.length} migration(s), ${declared.length} declared`);

  // ── the two lists, compared both ways ────────────────────────────────
  const expectedIds = SV.EXPECTED.map((e) => `${e.version} ${e.migration_id}`);
  const declaredIds = declared.map((d) => `${d.version} ${d.migration_id}`);

  for (const d of declaredIds) {
    H.check(`EXPECTED lists the migration that declares ${d}`,
      expectedIds.includes(d),
      `missing from server/schema_version.js — the startup check will call it `
      + `"a migration this code does not know about"`);
  }
  for (const e of expectedIds) {
    H.check(`EXPECTED entry ${e} has a migration file behind it`,
      declaredIds.includes(e),
      'no migrations/*.sql inserts this version — check() will report '
      + '"Database is behind the code" for something nobody can apply');
  }

  H.check('the lists are the same length, in the same order',
    expectedIds.length === declaredIds.length
    && expectedIds.every((v, i) => v === declaredIds[i]),
    `EXPECTED: ${expectedIds.join(' | ')}\n          FILES:    ${declaredIds.join(' | ')}`);

  // ── and the check itself behaves ─────────────────────────────────────
  const asRows = (list) => list.map((e) => ({
    version: e.version, migration_id: e.migration_id, applied_at: 'x', description: '',
  }));
  const run1 = (rows) => SV.check({ query: async () => ({ rows }) });

  return Promise.all([
    run1(asRows(SV.EXPECTED)).then((r) => {
      H.check('a fully migrated database is ok', r.ok === true, r.message);
      // The bug in one line: this said "the code may be older than the
      // database" on a healthy startup for five versions running.
      H.check('and is NOT told the code may be older than the database',
        !/does not know about/.test(r.message), r.message);
      H.check('it reports the versions it found', /Schema current/.test(r.message));
    }),
    run1(asRows(SV.EXPECTED.slice(0, 2))).then((r) => {
      H.check('a database behind the code is not ok', r.ok === false);
      H.check('and the message names the missing migrations',
        /Database is behind the code/.test(r.message), r.message);
    }),
    run1([]).then((r) => {
      H.check('an empty database says nothing is applied',
        r.ok === false && /No migrations applied/.test(r.message), r.message);
    }),
    run1(asRows(SV.EXPECTED.concat([{ version: '9.9.9', migration_id: '9999_from_the_future' }])))
      .then((r) => {
        H.check('a genuinely unknown version IS reported',
          /does not know about: 9\.9\.9/.test(r.message), r.message);
        // It is a warning, not a failure: the database being ahead does not
        // stop this code from working, it just means someone should look.
        H.check('but does not make the check fail — being ahead is not broken',
          r.ok === true, r.message);
      }),
  ]);
};
