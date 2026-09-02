# Reconstruction status

An honest inventory of what is in this repository and what is not, as of the
current commit. Kept because a system that overstates its own completeness is
the failure mode this whole project was built to avoid.

`modules/pra/HASHES_v0_7.sha256` is your original manifest of the v0.7 package —
45 files. It is the checklist. Everything below is measured against it.

---

## Present and working

| Component | State |
|---|---|
| `core/provenance/provenance.py` | Your original. Runs. |
| `core/provenance/provenance.js` | **Written here.** The missing JS twin. Cross-language hash agreement verified. |
| `core/provenance/test_provenance.py` | Your original. **16/16 passing.** |
| `core/provenance/ingest_to_pra.js` | **Written here.** Ledger → PRA `sources`. Tamper refusal verified. |
| `modules/connectors/cli.js` | **Written here.** OpenSanctions + CourtListener under the ratified run procedure. Dry-run and fail-closed verified. |
| `modules/research-desk/app/desk.html` | **Written here.** The unified desk. Renders; offline degradation verified. |
| `modules/pra/migrations/*.sql` | Your originals — v0.6.1 base, v0.7 master, v0.6.1 rollback. |
| `modules/pra/scripts/grants.sql` | Your original. Least-privilege grants. |
| `modules/pra/scripts/setup_macos.sh` | Your original. |
| `modules/pra/seed/*.csv` | Your originals — 24 agencies, 11 jurisdictions, 23 portals, 12 record types. |
| `modules/pra/app/*` | Your originals — v0.5 demo, request builder, tracker, persistence client. |
| `modules/openmontage/engine/*` | Your originals — montage engine + motif library. |
| `modules/atlas-vuln/*` | Your originals — CVE tiering, priority policy, `ioc_check.py`. |
| `modules/tsr-bus/*` | Your originals — the desk ↔ montage bus. |
| `modules/research-desk/analysis/*` | Your originals — Flock case-number and profiler scripts. |
| `bin/sentinel` | Your original dispatcher. Paths now match the real tree. |

## Verified by running it, not by reading it

- `python3 core/provenance/test_provenance.py` → **16/16 PASS**, including both
  cross-language checks. Python and JavaScript build byte-identical records.
- `ingest_to_pra.js --dry-run` on a two-record ledger → correct `sources` rows.
- Same ledger with one line edited in place → **refused outright**, nothing
  imported, exit 1.
- `connect courtlistener` against a blocked network → **fail-closed**: no
  capture file, no ledger line, non-zero exit.
- `desk.html` with no service running → renders fully, states the service is
  down, stays useful.

---

## Missing — still needed from your v0.7 package

These are in your manifest but were not among the uploads. **The database layer
cannot run without the `server/` group**; everything else degrades gracefully.

### Priority 1 — the runtime (nothing runs without these)

```
server/db.js                    connection pool + withTransaction()
server/db_policy.js             the localhost-only host allowlist
server/metadata_repository.js   all reads/writes, one transaction per sequence
server/local_service.js         the 127.0.0.1:4317 bridge
server/schema_version.js        migration state
scripts/start_service.js        what `npm run service` runs
```

### Priority 2 — the working scripts

```
scripts/load_seeds.js           loads the four CSVs (present) into the DB
scripts/daily_brief.js          your morning read
scripts/check_portals.js        re-verifies the 15 unverified portal URLs
scripts/backup.sh
scripts/verify_integrity.sh
seed/seed_templates_and_rules.sql   the 8 letter templates + 7 deadline rules
```

### Priority 3 — the logic modules

```
server/deadline_engine.js       the clock
server/request_drafter.js       letter drafting + private-data screening
server/audit_ledger.js
server/export_ledger.js
server/import_sanitizer.js
server/json_roundtrip.js
```

### Priority 4 — the test suite (11 suites)

```
tests/run_all.js  tests/_harness.js  tests/_fakedb.js  tests/fakes/fake_db.js
tests/audit_export_ledger.test.js   tests/db_policy.test.js
tests/deadline_engine.test.js       tests/fallback_behavior.test.js
tests/json_export_metadata_only.test.js  tests/json_import_tamper_strip.test.js
tests/repo_atomicity.test.js        tests/request_drafter.test.js
tests/schema_metadata_only.test.js  tests/seed_integrity.test.js
tests/upload_review_history.test.js
```

### Priority 5 — docs and extras

```
OPERATOR_RUNBOOK.md   README_v0_6_1.md   HASHES_v0_6_1_implementation.sha256
migrations/0002_v0_7_rollback.sql       app/uploads.js   app/icon_legend.json
docs/QA_V0_6_1.md   docs/PRIVACY_REGRESSION_RESULTS_V0_6_1.md
docs/TEST_RESULTS_v0_6_1.txt
```

### Named in the architecture but never packaged

From `docs/SENTINEL_GROUP_ARCHITECTURE.md` — described in detail, no code seen:

- `prisma/schema.prisma` — the four table groups of the case store
- `src/content/site.ts` — the route constants that make links untypeable
- the eight verification gates and `resolveConflict()`
- `verifyChain()` and the `AuditEvent` hash chain
- the Publication Gate route at `/desk/gate`
- `modules/tsr-bus/schema.py` — `bus.py` and `client.py` both import it

**NoeticMesh**: no file has been provided under that name. Nothing here claims
to be it.

---

## The one deliberate deviation

`bin/sentinel status` looks for `modules/atlas-vuln` and `modules/research-desk`.
Your dispatcher listed the module names as `pra openmontage atlas-vuln
research-desk`; the tree now matches that exactly, so `status` reports truthfully
rather than printing four ✗ marks against a layout that was never built.
