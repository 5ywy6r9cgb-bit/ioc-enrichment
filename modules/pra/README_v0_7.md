# Sentinel Public Records Atlas — v0.7 (master research database)

**Status:** IMPLEMENTED / NOT FROZEN / NOT RELEASED.
**Builds on:** the frozen v0.5 behavior and the v0.6.1 metadata-only persistence layer, both unchanged.
**Start here:** [`OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md)

---

## What this is

One local Postgres database on one Mac that does four jobs:

1. **Knows where to file.** A registry of agencies, jurisdictions, and the actual portals — court dockets, records forms, e-filing, business registries, the Court of Claims appeal route — with fees, login requirements, and quirks.
2. **Drafts the request.** Statute-cited letter templates for the initial ask, two escalating follow-ups, the "too broad" response, the fee challenge, the denial response, and the Court of Claims prep checklist.
3. **Runs the clock.** Every open request is evaluated daily against your follow-up cadence, with the right letter already drafted when something goes quiet.
4. **Holds the due-diligence graph.** Entities, relationships, contracts, and a citation ledger that tracks which claims are still riding on unverified sources.

## What it deliberately does not do

- It does not store raw files. Those stay in `Received_Records/` on your disk.
- It does not send anything to anyone. It drafts; you send.
- It does not connect to a hosted database, sync, or emit telemetry.
- It does not index document text unless you explicitly, per-document, tell it to — after you have reviewed and approved that document by hand.

## Runtime model

```
browser UI  +  localhost-only service (127.0.0.1)  +  local Postgres
                                                          |
                              Received_Records/  <--------+  (referenced, never ingested)
```

If the service or database is unavailable, the app falls back to v0.5 session/JSON behavior automatically. No regression.

---

## What v0.7 added

| Area | Tables / files |
|---|---|
| Geography | `jurisdictions`, expanded `agencies` |
| Filing routes | `portals`, `agency_portals`, `seed_portals.csv` (22 routes) |
| Drafting | `request_templates`, `record_types`, `server/request_drafter.js` |
| The clock | `deadline_rules`, `followups` (append-only), `server/deadline_engine.js` |
| Investigation threads | `investigations` |
| Due diligence | `entities`, `entity_aliases`, `entity_links`, `request_entities` |
| Citations | `sources`, `source_links` |
| Search (opt-in) | `document_text_index` — gated three ways, see the runbook |
| Working views | `v_request_clock`, `v_needs_attention`, `v_filing_routes`, `v_unverified_sources` |
| Automation | `daily_brief.js`, `check_portals.js`, `backup.sh`, `verify_integrity.sh` |

The `requests` table gained the clock and cost columns: `submitted_at`, `acknowledged_at`, `first_response_at`, `next_action_at`, `followup_count`, `fee_quoted`, `denial_reason`, `exemption_cited`, `appeal_case_no`, and the rest.

---

## Privacy model, unchanged and extended

The v0.6.1 principle stands: *the database may make the system remember better; it may not make it collect more.*

New constraints enforce it at the database level rather than by convention:

- `entities_no_private_home_address` — a private individual cannot carry a street address
- `portals_no_credentials` — credential-like text is rejected outright
- `sources_relative_path_only` — no absolute paths escape into the database
- `document_text_index` — requires explicit consent, confirmed redaction, and prior human approval of the source record, checked again by trigger on every write
- `followups` — append-only, same trigger the ledgers use

---

## Merged: the hardened v0.6.1 revision

Your uploads contained loose files that were **newer than the zip** — a hardening pass that had not made it back into the packaged build. v0.7 adopts it, because one of those fixes matters a great deal:

- `db.js` gained `withTransaction()`, which checks out a single connection for a whole BEGIN/COMMIT sequence.
- `metadata_repository.js` now runs every multi-row write inside one transaction, so a crash can never leave a `received_records` row without its matching history row. `renameDisplayName` no longer writes a `__RECOMPUTE__` placeholder.
- **`local_service.js` `/export` was broken.** It always returned `{requests: []}` regardless of what was in the database, while still writing an `export_ledger` row claiming a successful export. A ledger that records an export that did not happen is worse than no ledger. The hardened version reads real state via `repo.getAllRequestsWithRecords()` before building the manifest, so the ledger row and the returned JSON agree.
- `fake_db.js` and the atomicity tests came along with it, now wired into the suite as `repo_atomicity`.

That same transaction bug was about to be repeated in the new seed loader — it was issuing `BEGIN`/`COMMIT` through the pool, which does not guarantee the same connection. It now uses `withTransaction`.

If you have other copies of these files elsewhere, the versions in this package are the hardened ones.

## Tests

```bash
npm test
```

11 suites, no database required. The four new ones:

- `deadline_engine` — day math, clock re-anchoring, jurisdiction filtering, triage ordering, and an assertion that no Ohio rule may ever be labeled statutory
- `request_drafter` — placeholder handling, private-data screening, and a hard rule that an incomplete or high-risk draft is never marked sendable
- `seed_integrity` — pre-flight validation of every CSV and SQL file against the schema's CHECK constraints, since the build machine has no Postgres
- `repo_atomicity` — proves a mid-sequence failure rolls back completely and leaves no orphaned rows (adopted from your hardening pass)

`seed_integrity` already earned its keep: it caught an unquoted comma in `seed_record_types.csv` that had been silently shifting every column of the "Police/fire incident aggregate statistics" row.

---

## Known limitations

- **Live Postgres integration has not been exercised.** The build environment has no database. The migrations are validated structurally (balanced transactions, matched dollar-quotes, enum values cross-checked against the CSVs) but must be applied on your Mac before this can be called working. `setup_macos.sh` wraps everything in transactions, so a failure rolls back cleanly.
- **15 of 22 portal URLs are unverified.** They are labeled as such and each carries an explicit VERIFY note. Run `npm run portals` to check them all in a few seconds.
- **The browser UI has not been rewired to the v0.7 tables.** The map, request builder, and tracker still run on the v0.5/v0.6.1 paths. The v0.7 layer is driven from the command line for now — that is the next piece of work.
- **The demo HTML loads Leaflet from unpkg.com.** That is the one outbound dependency in the app. Vendoring it locally would make the package fully offline.
