# Sentinel OS

**Named Sources · Public Documents · Verified Facts**

One local system for public-records work: find the office, draft the request,
run the clock, hold the evidence, and prove the chain of custody — on your own
machine, with nothing leaving it.

This repository is a monorepo of modules that share **one evidence store** and
**one provenance discipline**. That sharing is the whole point. Before it, a
received record, a rendered video, and a CVE report each described where they
came from in a different shape, so nothing could index all three. Now they all
speak `provenance/1`, and one ledger covers everything the system produces.

---

## Start here

```bash
bin/sentinel status     # what is set up and what is not
bin/sentinel test       # every module's tests
bin/sentinel desk       # open the desk in a browser
```

The desk (`modules/research-desk/app/desk.html`) is the single surface over the
whole system. It opens offline, makes no network request to load, and reads the
local service if that service happens to be running.

**Current state:** the provenance spine, the connectors, the ingest seam, the
desk, the database schema, and the seed data all work. The PRA server runtime
(`modules/pra/server/`) is not yet in the repository, so the live database
features are not runnable end to end. See
[`docs/RECONSTRUCTION_STATUS.md`](docs/RECONSTRUCTION_STATUS.md) for an exact
inventory — what is present, what is missing, and what was verified by running
it rather than by reading it.

---

## The shape of it

```
bin/sentinel                    one entry point; dispatches to the module that owns each job

core/provenance/                THE SPINE — every module writes this one record shape
  provenance.py                 Python half
  provenance.js                 JavaScript half — byte-identical output, proven by test
  test_provenance.py            16 checks, including cross-language hash agreement
  ingest_to_pra.js              the seam: provenance ledger -> PRA citation ledger

modules/
  pra/                          Public Records Atlas — the database and the clock
  connectors/                   OpenSanctions, CourtListener — authorized runs only
  research-desk/                the desk, and the Flock analysis scripts
  openmontage/                  the montage engine (video, with build manifests)
  atlas-vuln/                   CVE tiering + the IOC enrichment tool
  tsr-bus/                      the desk <-> montage message bus

evidence/                       raw files, captures, ledgers — GITIGNORED, never pushed
docs/                           architecture, ratification record, status
```

---

## The two rules everything else follows

**1. The database may make the system remember better. It may not make it
collect more.**

Raw files never enter the database. They live in `evidence/`, referenced by a
*relative* path and a SHA-256. The database says what a file is and that it is
intact; the directory holds the bytes; `sentinel prov verify` proves the two
still agree. An absolute path is refused by both the schema constraint and the
provenance spine, because an absolute path leaks your machine layout and breaks
portability.

**2. Custody is not verification.**

Holding a document's bytes and its hash means you have custody. It does not mean
anyone has read it. Every import lands as `unverified`. Every connector hit lands
as a **lead requiring a primary source** — a name match is not an identification.
Nothing in this system can promote a claim to a fact; only a human reading the
underlying document can do that.

---

## What it refuses to do

Each of these is enforced by a constraint, a trigger, or a code path — not by
remembering to be careful.

| Refusal | Enforced by |
|---|---|
| Store raw files in the database | No content column exists on `received_records` |
| Send a records request for you | The drafter writes text; there is no transport |
| Index document text without per-document consent | `document_text_index` — consent flag, confirmed redaction, and a trigger re-checking prior human approval on every write |
| Rewrite the audit trail | `prevent_ledger_mutation()` trigger + INSERT-only grants |
| Store a private individual's street address | `entities_no_private_home_address` CHECK |
| Store credentials | `portals_no_credentials` CHECK |
| Connect to a hosted database | Host allowlist in `db_policy` and in the ingest seam |
| Ingest a tampered ledger | `verify()` runs first; one bad line means nothing imports |
| Turn a search hit into a fact | Results land as `lead_needs_primary_source` |

---

## The clock, stated correctly

Ohio R.C. 149.43 sets **no fixed day count**. Inspection is "promptly"; copies
come "within a reasonable period of time."

Every Ohio day-number in this system is *your own follow-up cadence*, not a
statutory deadline. The `deadline_rules.rule_basis` column records which is
which — `operator_policy` versus `statutory` — so the distinction can never
quietly blur into a claim you cannot support. The federal FOIA 20-business-day
rule is the one row genuinely marked `statutory`.

---

## Connectors

```bash
sentinel connect test                              # which keys are set and reachable
sentinel connect opensanctions "<name>" --dry-run  # rehearse: announce, make no call
sentinel connect opensanctions "<name>"            # one authorized run
```

Every run follows the procedure your `docs/RATIFICATION.md` already ratified for
EDGAR, the Federal Register, and OpenSanctions:

1. **Announce** exactly what call will be made, before making it
2. **Capture** the verbatim response bytes to `evidence/captures/`
3. **Hash** the capture *before* anything is derived from it
4. **Record** one provenance record, appended to the ledger
5. **Lead, not fact** — every hit is a lead requiring a primary source

The API key is read from `.env`, sent in the `Authorization` header, and never
logged, never written into a capture, never stored in a provenance record.
`sentinel connect test` prints presence and length only.

A run makes the number of calls it announced. Failures are **fail-closed**: if
the call does not return 2xx, no capture is written and no ledger line is
created. Verified by observation, not by assertion.

---

## Setup

```bash
# 1. Postgres (macOS): install Postgres.app, click Initialize, then:
cd modules/pra && npm install && ./scripts/setup_macos.sh

# 2. Keys, if you want the connectors
cp modules/pra/config/local.example.env .env
chmod 600 .env          # then add OPENSANCTIONS_API_KEY / COURTLISTENER_API_TOKEN
sentinel connect test

# 3. The desk
sentinel desk
```

`setup_macos.sh` is idempotent and wraps everything in transactions, so a failure
rolls back cleanly. It creates a least-privilege role — no superuser, no
createdb, no createrole, no DDL at runtime, and INSERT-only on the ledgers.

**Using it from Linux, or another machine:** the setup script is macOS-specific
but everything it does is ordinary `psql`. The database itself binds to
localhost by design and `db_policy` rejects a remote host — reaching it from a
phone or another machine means an SSH tunnel to the machine that holds it, not
opening the database to a network. That is deliberate: a reachable copy of an
investigative case store is a subpoena target and a breach target at once.

---

## Credits and standard

Built by Mark Rosenburg — The Sentinel Report.

The governing documents are [`docs/SENTINEL_GROUP_ARCHITECTURE.md`](docs/SENTINEL_GROUP_ARCHITECTURE.md)
and [`docs/RATIFICATION.md`](docs/RATIFICATION.md). Where this code and those
documents disagree, the documents are the intent and the disagreement is a bug.

> Corrections run first, always.
