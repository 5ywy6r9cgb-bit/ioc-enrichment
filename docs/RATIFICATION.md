# Doctrine Ratification Record

**Ratified:** 2026-07-06 by the operator ("Yes lets keep going", following twice-reproduced foundation verification on the operator's MacBook).

**Governing instruments (in force):**
1. `COMMAND_CENTER_MASTER_BLUEPRINT.md` v2.0 (SHA recorded in MANIFEST.sha256)
2. `PHASE3_DIRECTIVE_RECONCILIATION.md` — folded in as v2.1 amendments:
   - confidence is a descriptive label, never a score
   - persons stay public-role-only; institutions and domains may carry sourced addresses
   - security work is notes-from-records, never probing/recon tooling
   - six-level science-claim taxonomy adopted for library notes
   - AI-generated report content must be source-labeled
   - persistence (close/reopen) and account-independence added to the QA bar

**Foundation status at ratification:** VERIFIED and REPRODUCED on the operator's
own machine (Homebrew PostgreSQL 16.14) — 23/23 acceptance checks, twice, clean
build and teardown each time. Evidence: qa-evidence/foundation_verification_operator_machine.txt.

**Amendment rule (from the blueprint):** this doctrine changes only by explicit
operator decision, recorded here and in a new document version. Agents do not
reinterpret doctrine; they ask.

**Build authorization:** Phase 2 begins per the Immediate Execution Order,
first file src/lib/search.ts (read-only). Phases advance one at a time, each
proven with saved evidence and reviewed before the next begins.

---

## Amendment — EDGAR live-run authorization (2026-07-07)

**Decision:** the operator reviewed `EDGAR_DEPLOYMENT_READINESS.md` (verdict
CONDITIONAL GO, connector v0.2.0 after remediations F1–F4) and authorized the
single live EDGAR run by replying **"continue, accepted"** (2026-07-07).

**Scope of this authorization — exactly one run:**
- Connector: `sec_edgar` v0.2.0 only. No other connector is authorized.
- Target: CIK 0000320193 (Apple Inc.) — the readiness report's recommended
  first target, directly comparable to the twice-proven dry-run fixture.
- Network: ONE HTTPS GET to `data.sec.gov`, declared User-Agent carrying the
  operator's contact address (atlasos.info@gmail.com).
- Procedure: Part 9 of `EDGAR_DEPLOYMENT_READINESS.md`, executed in order
  (backup → clone re-proof → rehearsal → live run → verification → this
  record → gates closed).
- Gates: opened per-command (inline env), never exported; the phase lock and
  per-connector authorization return to OFF the moment the run ends.

This authorization does NOT enable connectors generally, does not authorize
scheduled/batch execution, and does not extend to any second run — a second
run is a new recorded decision.

### Run record (executed 2026-07-07, 20:24 EDT / 2026-07-08T00:24:16Z)

| Item | Value |
|---|---|
| Connector | `sec_edgar` v0.2.0 |
| Target | CIK 0000320193 — Apple Inc. |
| Live calls | **1** (asserted by runner and verified) |
| UA sent | `TSR Atlas Sentinel Research Desk atlasos.info@gmail.com` |
| Capture file | `qa-evidence/edgar/live_capture_CIK0000320193_2026-07-08T00-24-16-281Z.json` |
| Capture SHA-256 | `ea2aa552e984a29e920cf80e0827cf32b632563935f029b6ec9de7f4fa3c026d` |
| Stored document_hash | identical (independently re-hashed post-run — custody intact) |
| Records created | 1 institution (Apple Inc., US-CA, `sec_edgar_cik`), 26 sources (1 submission + 25 filings) |
| Filings honesty | 1000 seen, 25 imported — truncation announced in run notes (cap working as designed) |
| Audit | 27 writes → 27 chained events; chain verified end-to-end post-run |
| Boundary | zero address data in DB (Apple Park/Cupertino present in raw capture, absent from all rows) |
| Provenance stamp | `run_mode=live; connector=sec_edgar@0.2.0`; structured `retrieved_at` populated |
| Pre-run evidence | backup `pre_live_backup_20260707.sql` (sha256 `e5ca4dcc…2078`); clone re-proof 12/12 (`edgar_dryrun_live_v020_output.txt`); unit 11/11 (`edgar_unit_v020_output.txt`); TRUNCATE guard drill rejected on `sentinel_dev` |
| Ops note | Postgres 16.14 had a stale orphaned `walwriter` holding shared memory (unclean prior shutdown); terminated, stale `postmaster.pid` removed, clean service start — recorded here for the honesty ledger |
| Posture after run | gates closed by construction: env vars were inline per-command, never exported; connectors remain OFF |

**Standing status:** EDGAR is live-PROVEN. This record does not authorize
further live runs; each subsequent run (new CIK, higher `maxFilings`) is a new
operator decision, though it may reference this procedure.

---

## Amendment — Federal Register live-run authorization (2026-07-08)

**Decision:** the operator reviewed `FEDERAL_REGISTER_DEPLOYMENT_READINESS.md`
(verdict CONDITIONAL GO, connector v0.2.0 after remediations FR-F1..F5) and
authorized the single live Federal Register run by replying **"continue"**
(2026-07-08) — the report's stated protocol ("'continue, accepted' or
equivalent"), same form as the EDGAR authorization above.

**Scope of this authorization — exactly one run:**
- Connector: `federal_register` v0.2.0 only. No other connector is authorized.
- Target: agency slug `securities-and-exchange-commission` — the readiness
  report's recommended first target (matches the fixture agency; interlinks
  with the live EDGAR SEC records already in the library).
- Network: exactly TWO HTTPS GETs to `www.federalregister.gov`
  (agency profile + documents list), 30s timeouts, single-threaded.
  No key, no User-Agent required — documented divergence, readiness report §2.
- Cap: `maxDocuments` = 25 (default), truncation announced honestly.
- Procedure: Part 9 of `FEDERAL_REGISTER_DEPLOYMENT_READINESS.md`, executed in
  order (backup → clone re-proof → rehearsal → live run → verification → this
  record → gates closed).
- Gates: opened per-command (inline env), never exported; phase lock and
  per-connector authorization return to OFF the moment the run ends.

This authorization does NOT enable connectors generally, does not authorize
scheduled/batch execution, and does not extend to any second run — a second
run (new slug, higher cap) is a new recorded decision.

### Run record (executed 2026-07-08, 00:19 EDT / 2026-07-08T04:19:52Z)

| Item | Value |
|---|---|
| Connector | `federal_register` v0.2.0 |
| Target | agency slug `securities-and-exchange-commission` (FR agency id 466) |
| Live calls | **2** (agency profile + documents list; asserted by runner and verified) |
| Capture 1 (agency) | `qa-evidence/federal_register/live_capture_securities-and-exchange-commission_2026-07-08T04-19-52-531Z_agency.json` — SHA-256 `685e1cc456734057ba04168f8dcd891faae28054c565d467fee2d857a571dac9` |
| Capture 2 (documents) | `…_documents.json` — SHA-256 `eede88ba7410b6e136e8e7b3ad0cbc02327b453d885f2c7ae957f56538b9e49a` |
| Stored document_hash | identical to capture 1 (independently re-hashed post-run — custody intact) |
| list_sha256 tie | every document source's note carries `list_sha256=eede88ba…` = capture 2 (spot-verified independently) |
| Records created | 1 institution (Securities and Exchange Commission, `kind=agency`, registry 466, `federal_register_agency_id`, US), 26 sources (1 profile + 25 documents) |
| Cap honesty | per_page derived from cap (25) — the API was never asked for more than the run keeps (FR-F4 design); 25 seen, 25 imported |
| Run log | `connector_runs` id `90d6605a-6665-4005-b2f7-f90af029e66a`, status `succeeded`, both capture paths + agency hash recorded; visible via `GET /api/connector-runs` (verified over HTTP) |
| Audit | chain verified end-to-end post-run: 57 events, PASS |
| Provenance stamp | `run_mode=live; connector=federal_register@0.2.0`; structured `retrieved_at=2026-07-08T04:19:52.538Z` |
| Pre-run evidence | backup `pre_live_backup_20260708.sql` (sha256 `9e5acc3b…cf59`); migrations re-applied clean on disposable clone (22 tables); FR unit 13/13 (`fr_unit_v020_prelive_output.txt`); full suite 182/182; announce-only rehearsal refused with zero run rows (`fr_rehearsal_20260708_output.txt`) |
| Ops note (honesty ledger) | the runner's stdout was truncated after self-check 2 by the *display* pipeline (`… \| head` → SIGPIPE through `tee`), not by the runner: checks 1–2 captured live; checks 3–5 (list_sha256 tie, live stamp, chain verify) re-executed independently post-run and appended to `fr_live_run_20260708_output.txt`. The connector executed exactly once; no re-run. |
| Interlink | the SEC now exists as a sourced *agency* institution alongside the EDGAR-side records — first cross-connector overlap in the library, as the readiness report anticipated |
| Posture after run | gates closed by construction: env vars were inline per-command, never exported; connectors remain OFF |

**Standing status:** Federal Register is live-PROVEN (second connector after
EDGAR). This record does not authorize further live runs; each subsequent run
(new slug, higher cap) is a new operator decision referencing this procedure.

---

## Amendment — Phase 4c studio + Congress.gov adaptation (2026-07-12)

**Operator directive (verbatim intent):** "create/build maximum efficient
command center from where we are… i actually want more connectors added and
hardened… so I want a lot done" — with Phase 4c (script builder) selected as
the next build when asked directly.

**Decisions recorded:**

1. **Phase 4c built and applied (v6.2).** Script builder, template library,
   export packages — intake (`docs/PHASE4C_INTAKE.md`) and tests written
   before code per §9; clone drill 23/23; migration 0007 applied to
   sentinel_dev after backup `pre_0007_backup_20260712.sql`
   (sha256 0dfccef9…46a9); suite 223/223 at apply time. No connector
   activity involved; no new gate opened.

2. **Congress.gov adaptation APPROVED at dry-run level.** The operator's
   "more connectors added" is recorded as resolving the flagged ProPublica
   decision (`docs/OPERATOR_KEY_CHECKLIST.md`, honesty item of 2026-07-07):
   `congress_gov` v0.1.0 built to the framework standard, dry-run proven 8/8
   (minimization proven in code — member photo/district dropped; key confined
   to the X-Api-Key header, never recorded provenance). `propublica` is
   SUPERSEDED, stays as history, will not be taken live.

**Interpretation note (agents do not reinterpret doctrine; they record):**
the directive was general; it has been applied ONLY to the already-flagged
pending decision. It does NOT authorize any live connector run, does not
open any phase gate, and does not batch-enable anything. Every go-live still
requires: its own readiness review to the EDGAR standard, a real captured
fixture, key installation where applicable, and a NEW recorded per-connector
authorization in this file. Suite at record time: 231/231.

---

## Amendment — OpenSanctions live-screen authorization (2026-07-14)

**Decision:** the operator reviewed `OPENSANCTIONS_DEPLOYMENT_READINESS.md`
(verdict CONDITIONAL GO, connector v0.2.0 after remediations OS-F1..F9),
installed the API key privately in `.env.local` (chmod 600; loader confirmed
it present by name only, value never shown), and authorized the single live
OpenSanctions screen by replying **"Authorized, run it"** (2026-07-14) — the
report's stated protocol, same form as the EDGAR and Federal Register
authorizations above.

**Scope of this authorization — exactly one run:**
- Connector: `opensanctions` v0.2.0 only. No other connector is authorized.
- Operation: ONE HTTPS POST to `https://api.opensanctions.org/match/default?algorithm=logic-v2`.
- Subject: screen **"Larry Householder"** (schema Person) — the readiness
  report's recommended first target, a principal in the operator's first real
  investigation (Ohio HB6 / FirstEnergy, inv `0fff6204-c98d-42cf-b543-432ca184360a`).
- Auth: the API key is read from `OPENSANCTIONS_API_KEY` (`.env.local`) and sent
  in the `Authorization` header only; never logged, never stored, never echoed.
- Boundary: every candidate lands as an `open_question` LEAD
  (`needs_primary_source`), attached to the HB6 investigation; NO auto-facts,
  NO Sentinel score/ranking. A match is a lead, not a verdict.
- Procedure: Part 9 of `OPENSANCTIONS_DEPLOYMENT_READINESS.md`
  (backup → live run → verification → this record → gates closed).
- Gates: opened per-command (inline env), never exported; phase lock and
  per-connector authorization return to OFF the moment the run ends.

This authorization does NOT enable connectors generally, does not authorize
scheduled/batch execution, and does not extend to any second screen (a new
name, org, or re-screen is a new recorded decision).

### Run record (executed 2026-07-14) — two-attempt honesty ledger

The authorized screen took two steps because attempt 1 hit a bug. The single
authorized HTTPS POST was made **exactly once**; the completion used that call's
own captured bytes (no second network call).

| Item | Value |
|---|---|
| Connector | `opensanctions` v0.2.0 |
| Subject | "Larry Householder" (schema Person) |
| Live HTTPS POSTs | **1** (attempt 1; response captured + SHA-256'd before any DB write) |
| Capture | `qa-evidence/opensanctions/live_capture_Larry_Householder_2026-07-14T19-48-34-405Z.json` |
| Capture SHA-256 | `48e29cc2e602a4d14abbf4eddb9e79bbe76925291baf4194f69f129299325de0` |
| Attempt 1 outcome | **FAILED at the DB write** — `label_context:'open_question'` was not a valid enum value. Root cause: connector unit tests use an in-memory repo that did not enforce the enum, and the disposable-clone re-proof step (readiness §9 step 3) had been skipped. Fail-closed worked: run `dd3a71c3-…` marked FAILED; partial write = 2 orphan sources, 0 claims. |
| Remediation | (a) surgically deleted the 2 orphan sources (0 references; audit trail + FAILED run row kept — corrections are additive); (b) **migration 0008** added `open_question` to the `label_context` enum (aligns schema with doctrine §4; also un-breaks the silently-empty "Open questions" filters in report/script/export); (c) hardened `makeMemoryRepo.insertClaim` to mirror the enum + regression test (suite 234→235); (d) clone re-proof — replayed the real capture against a fresh Postgres clone, **5/5** checks green (`clone_reproof_output.txt`). |
| Completion | persisted the authorized call's OWN captured bytes into `sentinel_dev` via `scripts/opensanctions_capture_replay.ts` — **no second network call** (honoring "exactly one POST"). Run `a158cf35-…` succeeded. |
| Result | **1 candidate LEAD** attached to the HB6 investigation (`0fff6204-…`): "Larry Householder" → OpenSanctions entity `Q6490529` (topics `role.pep, role.pol, poi`); match score **1.000** recorded as an EXTERNAL note datum only. Source URL `https://www.opensanctions.org/entities/Q6490529/`. |
| Boundary | lead is `label_context=open_question`, `review_status=needs_primary_source`, `publishable=false` — UNVERIFIED, safe-worded "confirm same individual before any use." No person dossier; no Sentinel score/ranking. |
| Custody | run source `document_hash` == capture SHA-256 (independently verified); no auth/key material in any stored note; audit chain verifies end-to-end. |
| Pre-run evidence | backup `pre_live_backup_20260714.sql` (sha256 `fbe0d1ac…4a53`); clone re-proof 5/5; full suite **235/235**. |
| Posture after run | gates closed by construction (env inline per-command, never exported); connectors OFF. |

**Standing status:** OpenSanctions is live-PROVEN (third connector after EDGAR
and Federal Register), via a screening that made exactly one authorized POST.
The result is a **lead, not a verdict** — nothing is publishable until the
operator confirms same-individual and cites the underlying official listing.
This record does not authorize any further screen; each new name/org is a new
recorded decision.
