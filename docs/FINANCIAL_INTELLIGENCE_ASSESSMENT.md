# SentinelOS — Financial Intelligence Layer: Architecture Assessment

**Status:** assessment only. No production code changed. Nothing built.
**Date of reconnaissance:** 2026-09-08
**Scope:** the repository as it stands at commit `0ac14a4`.

---

## 0. Two things to read before anything else

### 0.1 I could not reach a single one of the five named providers

```
plaid.com                  CONNECT tunnel failed, 403
www.alphavantage.co        CONNECT tunnel failed, 403
finnhub.io                 CONNECT tunnel failed, 403
financialmodelingprep.com  CONNECT tunnel failed, 403
data.nasdaq.com            CONNECT tunnel failed, 403
```

Every statement in this document about a provider's **pricing, rate limits,
free-tier terms, dataset coverage, or signup process** is recalled, not
checked. It is marked `[UNVERIFIED]` wherever it appears.

The rule this desk already runs on applies here: *fetching is not reading*,
and I could not even fetch. **No `[UNVERIFIED]` number should enter a
purchasing or architectural decision until you have loaded the page and
confirmed it.** Each one carries the URL to check.

What IS verified in this document: everything about the SentinelOS
repository, because I read it.

### 0.2 The directive assumes a live PostgreSQL layer. There isn't one.

The brief says *"Inspect the existing PostgreSQL database"* and *"extend the
existing architecture."* The schema exists — 33 tables across 7 migrations,
and it is good. But:

- `psql -l` on your Mac returned **connection refused** (established earlier
  this week). Postgres 16.14 is installed via Homebrew and **not running**.
- `intel_repo.js` — the only writer into `entities` / `entity_links` /
  `sources` — is called by exactly three things: its own test, the
  CourtListener connector, and a PACER stub.
- Every analysis module that produces findings today (`moneyflow`, `lobby`,
  `graph`, `crosslink`, `brief`, `recency`, `foreign`) reads the **file
  store**, not the database.

**SentinelOS currently has two parallel data architectures, and the one the
directive describes is the one nothing runs on.** That is the central
finding of this assessment and it changes the order of everything else.

---

## A. EXISTING SYSTEM — what is actually here

### A.1 The file store (live, and where all findings come from)

| Path | Holds | Read by |
|---|---|---|
| `evidence/captures/*.json` | raw API responses, verbatim bytes | moneyflow, lobby, graph, crosslink, brief, recency, foreign |
| `evidence/manifests/provenance.jsonl` | append-only hash-chained ledger | `prov verify`, `prov ingest` |
| `evidence/sentinel_cases/*.json` | case files, exhibits, publication gate | `case` (Python) |
| `evidence/investigations/<inv>/YYYY/MM/` | watch captures + `NEW_HITS.md` | `watch run` |

Scale as of the last run: **2,029 money captures, 17,324 distinct money
rows, 19,256 duplicate rows correctly dropped.**

### A.2 The PostgreSQL schema (built, migrated, not running)

33 tables. The ones that matter here:

**`entities`** — `entity_id`, `entity_kind` CHECK(`business`, `nonprofit`,
`government_body`, `public_official`, `private_individual`, `property`,
`contract`, `project`, `other`), `name`, `legal_name`, `registry_id`,
`registry_source`, `jurisdiction_id`, `verified_status`, timestamps.
Carries a privacy CHECK: `entity_kind = 'private_individual'` may not have a
street address. That constraint is doing real work and must survive.

**`entity_aliases`** — alias, alias_type, source_id. The entity-resolution
substrate the directive asks for in §8 **already exists.**

**`entity_links`** — `from_entity_id`, `to_entity_id`, `relation` (free
text), `started_on`, `ended_on`, `amount numeric(14,2)`, `source_id`,
`confidence`, `CHECK (from <> to)`.

**`sources`** — `source_type` CHECK (11 values), `is_primary`,
`published_at`, `url`, `archive_url`, `retrieved_at`, `local_path`
(relative-only, CHECK-enforced), `sha256`, `citation_text`, `glassmark`.

**`source_links`** — `(source_id, entity_type, entity_id)`, `entity_type`
CHECK(`request`, `received_record`, `investigation`, `entity`, `claim`).

**`connector_runs`** (migration 0003) — the best-designed table in the
schema for this purpose. `run_mode` CHECK(`live`,`dry_run`,`replay`),
`run_status` CHECK(`running`,`completed`,`failed`,`refused`),
`records_seen`, `records_imported`, and:

```sql
truncated boolean GENERATED ALWAYS AS (
    records_seen IS NOT NULL AND records_imported IS NOT NULL
    AND records_imported < records_seen) STORED
```

Coverage honesty enforced by the database itself. **Financial ingestion
should reuse this table verbatim, not invent `financial_ingestion_runs`.**

**`lobbying_engagements`** (migration 0004) — and this one already solves
§7's hardest problem. It records `first_seen_on`, `last_seen_on`,
`still_present`, `observation_count` — *when this system saw the
relationship listed*, explicitly **not** a claim about the contract's real
dates. That is the observed-vs-asserted distinction the directive wants
across the whole graph, already implemented correctly in one place.

### A.3 Provenance (strong, dual-layer)

- `core/provenance/provenance.js` + `.py` — identical record hashing across
  both languages, tested for byte-identical output.
- Sourcing tiers: `GREEN` / `ATTRIBUTED` / `SOURCE_NEEDED` / `GENERATED` / `NA`.
- Hash chain: `chain_sha256 = sha256(prev + ":" + record_sha256)`. Detects
  deletion, reorder, insertion. **Does not detect truncation** — stated in
  code, in output, and in the manual.
- sha256 taken at arrival, *before* anything is derived from the bytes.

### A.4 Secrets (already better than most production systems)

- `.gitignore` excludes `.env`, `.env.*`, `evidence/*`.
- `docs/API_KEYS.md`: keys live in `modules/pra/.env`, `chmod 600`, never in
  chat, never in a commit.
- `loadEnv()` merges into a **copy** and deliberately does not write into
  `process.env` — so no child process (pdftotext, git, psql) inherits a key
  it has no use for.
- `KEY_SHAPES` validates each key's shape **before any network call**, with
  the signup URL in the error. This caught a real failure where the "Your
  API key is:" sentence had been pasted along with the key.
- CI fails on any tracked `.env` or credential-shaped string.
- `guard.py` refuses credential-shaped text into the append-only audit chain.

### A.5 CLI and scheduler

26 top-level verbs. **`financial` does not collide with anything.**
`modules/watch/` has launchd scheduling, per-watch cadence, a seen-set so
repeat hits stay quiet, and files every capture into the investigation
folder + provenance ledger.

---

## B. GAPS — and the one that matters most

### B.1 The assertion ladder cannot be expressed. At all.

Directive §3 requires `DOCUMENTED` / `DERIVED` / `HYPOTHESIS`, never
collapsed. The schema says:

```sql
confidence text NOT NULL DEFAULT 'unverified'
    CHECK (confidence IN ('unverified','documented','confirmed','disputed'))
```

There is **no `derived` and no `hypothesis`.** `intel_repo.js`'s
`CONFIDENCE_MAP` has no route to either. Writing a derived relationship
today means writing it as `unverified` or `documented` — the first loses the
reasoning, the second is a lie.

Worse, that one column is **three different axes jammed together**:

| Value | Actually means |
|---|---|
| `unverified` | how sure we are |
| `documented` | what kind of claim it is |
| `confirmed` | how sure we are |
| `disputed` | its status in an argument |

`assertion_type` and `confidence` are orthogonal. A `hypothesis` can be
high-confidence; a `documented` fact can be disputed. They need separate
columns.

### B.2 `entity_links.amount` is the exact bug I removed from `moneyflow` two commits ago

```sql
amount numeric(14,2)
```

One nullable number. **No currency. No kind-of-money. No unit.**

A lobbying fee (money that moved, one quarter), a federal contract award (a
ceiling over four years, much never spent), and an independent expenditure
(a committee's ad buy) all land in that column and are `SUM()`-able. Any
report over it produces a figure that is arithmetically correct and
factually meaningless.

`moneyflow.js` refuses to have a grand total anywhere in its code and has a
test asserting no field holds the cross-kind sum. **Pushing that data into
`entity_links.amount` would undo that protection in one `INSERT`.**

There is a second failure in the same column. One relationship carries many
dated payments — Alpine ↔ ACA Connects is **92 filings over 28 years**. A
single `amount` on the edge forces either one edge per payment (destroying
the relationship) or overwrite-on-update. I hit exactly that in `graph.js`
in September: two spellings of one client made two money rows that both
`MERGE`d onto the same edge, and the second `SET` silently replaced $50,000
with $60,000.

**Money does not belong on the edge. It belongs in its own dated table that
references the edge.**

### B.3 `relation` is free text where §4 needs a controlled vocabulary

The comment lists five example values. §4 of the directive names eighteen
distinct semantic types (ownership, employment, lobbying, donation, payment,
contract, grant, investment, acquisition, board membership, executive
position, regulatory relationship, documented communication, shared address,
shared registered agent, shared officer, shared attorney, shared consultant,
temporal overlap). Free text means `owns` / `OWNS` / `owner_of` all coexist
and no query finds all three.

Note the last several are not relationships between the two entities at all
— *shared registered agent* is a **derived** observation about a third
object. Those need a different table shape, or they will be written as
though someone documented a link that nobody documented.

### B.4 `source_links.entity_type` is a closed CHECK with no room for a transaction

`('request','received_record','investigation','entity','claim')`. A
financial transaction cannot be tied to its source without a migration. This
is a one-line fix and it must not be forgotten, because the alternative is a
financial record with no provenance — the thing this whole system exists to
prevent.

`'claim'` is in that enum. **There is no claims table.** The claims register
— the thing that stops an unverified claim reaching an OpenMontage video —
is still unbuilt, and it is referenced by a constraint as though it exists.

### B.5 No `observed_on` outside `lobbying_engagements`

Directive §7 wants `occurred_on`, `effective_on`, `disclosed_on`,
`retrieved_at`, relationship start/end. `entity_links` has start and end
only. The correct pattern is already written in `lobbying_engagements` and
needs generalising, not inventing.

### B.6 The two-architecture split

`moneyflow` reads 2,029 captures off disk. `lobbying_filings` and
`lobbying_engagements` sit empty in a database that is not running. Neither
knows about the other. Adding a third store for financial data would make it
three.

---

## C. INTEGRATION POINTS — exactly where this connects

| New capability | Connects to | How |
|---|---|---|
| Provider adapters | `registry.js` `CONNECTORS` | Same shape: `describe`/`probe`/`run`/`parse`/`coverage`/`diagnose`. Gets `connect test`, key-shape checking, pacing, 429 handling, capture+hash+ledger **for free**. |
| Credential validation | `KEY_SHAPES` | One entry per new key. Shape checked before any call. |
| Raw capture | `runConnector()` | Already writes `live_capture_<connector>_<slug>_<stamp>.json`, hashes it, and appends a provenance record. Nothing new needed. |
| Ingestion runs | `connector_runs` | Reuse. Its `truncated` GENERATED column is the coverage discipline already. |
| Entity resolution | `entities` + `entity_aliases` | Extend; do not replace. |
| Relationships | `entity_links` | Extend **after** the fixes in §D. Not before. |
| Money amounts | **new `money_flows` table** | Because §B.2. |
| Provenance | `sources` + `source_links` + `provenance.jsonl` | Reuse both layers. `source_links` needs one CHECK widened. |
| Money reading | `moneyflow.js` | Add a reader per new kind. Its `KINDS` registry is the right place for the money taxonomy. |
| Cases | `evidence/sentinel_cases/*.json` | Financial exhibits attach here as any other exhibit. |
| Scheduling | `modules/watch` | Provider health checks and daily pulls are watches. |
| CLI | `bin/sentinel` | `financial` is free. |

---

## D. DATABASE PLAN

### D.1 Reuse unchanged

`entities`, `entity_aliases`, `sources`, `investigations`, `connector_runs`,
`audit_ledger`, `notes`, `tags`.

### D.2 Migration 0008 — you are already drafting this

You asked what `evidence_relationships` should hold and I asked whether it
was the claims register or the graph edges. You never answered, so here is
my recommendation: **it should be neither. It should be the three fixes that
make `entity_links` safe to write financial data into.**

```sql
-- 1. THE LADDER. A separate axis from confidence, because they are
--    orthogonal: a hypothesis can be high-confidence and a documented
--    fact can be disputed.
ALTER TABLE entity_links ADD COLUMN assertion_type text NOT NULL
    DEFAULT 'documented'
    CHECK (assertion_type IN ('documented','derived','hypothesis'));

-- 2. A CONTROLLED VOCABULARY for relation. Free text means owns / OWNS /
--    owner_of all coexist and no query finds all three.
CREATE TABLE relation_types (
    relation      text PRIMARY KEY,
    category      text NOT NULL,   -- ownership | control | money | access | co-occurrence
    directional   boolean NOT NULL,
    -- A co-occurrence relation (shared agent, shared address) is an
    -- OBSERVATION ABOUT A THIRD OBJECT, not a link between the two
    -- entities. Written as a plain edge it reads as though someone
    -- documented a connection nobody documented.
    implies_relationship boolean NOT NULL DEFAULT true,
    definition    text NOT NULL
);

-- 3. OBSERVATION WINDOW, generalising the lobbying_engagements pattern.
ALTER TABLE entity_links ADD COLUMN first_observed_on date;
ALTER TABLE entity_links ADD COLUMN last_observed_on  date;
ALTER TABLE entity_links ADD COLUMN still_present     boolean;

-- 4. source_links must be able to hold a financial record.
ALTER TABLE source_links DROP CONSTRAINT source_links_entity_type_check;
ALTER TABLE source_links ADD CONSTRAINT source_links_entity_type_check
    CHECK (entity_type IN ('request','received_record','investigation',
                           'entity','claim','money_flow','financial_account'));
```

**Deliberately NOT in 0008:** dropping `entity_links.amount`. Leave it,
stop writing to it, and let 0009 remove it once `money_flows` is proven.
A migration that removes a column and adds a table in one step cannot be
rolled back cleanly.

### D.3 Migration 0009 — `money_flows`

The one genuinely new table. It exists because money does not belong on an
edge (§B.2).

```sql
CREATE TABLE money_flows (
    flow_id          bigserial PRIMARY KEY,
    payer_entity_id  text REFERENCES entities(entity_id) ON DELETE RESTRICT,
    payee_entity_id  text REFERENCES entities(entity_id) ON DELETE RESTRICT,

    -- THE COLUMN THAT STOPS THE CATEGORY ERROR. Mirrors moneyflow.KINDS.
    -- No query may sum across two different flow_kinds. This is the whole
    -- reason the table exists.
    flow_kind        text NOT NULL REFERENCES money_flow_kinds(flow_kind),

    amount           numeric(20,2),        -- NULL means unreported, never 0
    currency         char(3) NOT NULL DEFAULT 'USD',

    -- Four different dates, because they are four different facts and
    -- collapsing them is how a disclosure date becomes a payment date.
    occurred_on      date,
    period_start     date,
    period_end       date,
    disclosed_on     date,

    -- Who the money was spent ABOUT, which is not a party to it. An
    -- independent expenditure names a candidate who never receives the
    -- money; putting them in payee_entity_id inverts the meaning.
    about_entity_id  text REFERENCES entities(entity_id) ON DELETE SET NULL,
    direction_note   text,   -- 'SUPPORTING' / 'OPPOSING', spelled out

    assertion_type   text NOT NULL DEFAULT 'documented'
                        CHECK (assertion_type IN ('documented','derived','hypothesis')),
    source_id        text REFERENCES sources(source_id) ON DELETE SET NULL,
    connector_run_id uuid REFERENCES connector_runs(run_id) ON DELETE SET NULL,

    -- The source's OWN row identity. This is what makes re-ingestion
    -- idempotent. Without it, 2,029 captures of the same filings insert
    -- the money 2,029 times -- which is the live shape of your capture
    -- directory today, not a hypothetical.
    source_row_id    text NOT NULL,
    content_hash     text NOT NULL,
    UNIQUE (flow_kind, source_row_id)
);

CREATE TABLE money_flow_kinds (
    flow_kind   text PRIMARY KEY,
    label       text NOT NULL,
    -- 'a ceiling, not money moved' vs 'reported paid'. Printed above any
    -- figure, every time.
    unit        text NOT NULL,
    authority   text NOT NULL,   -- the statute or form
    summable    boolean NOT NULL DEFAULT true
);
```

The `UNIQUE (flow_kind, source_row_id)` is the load-bearing constraint. It
is the database-level version of what `moneyflow.js` does in memory, and it
is what stops a re-ingestion from multiplying the money.

### D.4 Not needed

Of the ten tables the directive proposes in §12, seven are unnecessary:
`financial_ingestion_runs` (use `connector_runs`), `financial_source_records`
(use `sources` + the capture store), `financial_entities` (use `entities`),
`financial_relationships` (use `entity_links`), `financial_prices` /
`financial_instruments` / `financial_statements` (see §E — these serve a
mission the desk is not on). `financial_accounts` and
`financial_transactions` are Plaid-only; see §E.1.

---

## E. PROVIDER PLAN — and the finding you most need

### E.1 None of the five named providers advance the investigation you are running

This is the honest answer and I would be failing you to soften it.

Your live work is **Vantage Data Centers OH-E LLC** (a private Delaware/Ohio
subsidiary), **Ohio Phase-In-Recovery Funding LLC** (a securitisation SPV),
**Cornerstone Government Affairs**, Ohio lobbying, and county-level cost.

| Provider | What it actually covers | Value to that work |
|---|---|---|
| **Plaid** | *Your own* bank accounts, with your credentials | **None** unless you are a party to the transaction. It answers "where did MY money go." It cannot see a third party's accounts and must not be pointed at one. |
| **Alpha Vantage** | Listed equity prices, FX, macro series | **Near zero.** A private LLC has no ticker. |
| **Nasdaq Data Link** | Economic and alternative datasets | **Near zero** for entity work. |
| **Finnhub** | Listed-company fundamentals, filings metadata, **insider transactions**, institutional ownership | **Narrow but real** — see below. |
| **Financial Modeling Prep** | Listed-company statements, profiles, **Form 4 insider data**, institutional holders | **Narrow but real** — see below. |

**The narrow real value:** the parent companies in your Ohio energy work
*are* listed. Ohio Power Company's parent is American Electric Power
(NASDAQ: AEP). Duke Energy — which pays Alpine Group $6,240,000 across
2001–2026 in your own captures — is NYSE: DUK. For listed parents, Finnhub
and FMP expose two things you have **no source for at all today**:

1. **Insider transactions (SEC Forms 3/4/5)** — a *named person*, a *named
   issuer*, a *dated transaction*. That is a person↔organisation↔time edge
   with a document behind it. `revolving-door` and `institution` were
   unbackable because you have no person-level dated data. This is some.
2. **Institutional ownership (13F)** — who holds the parent.

### E.2 But you should not buy either one, and here is why

Both providers are **reselling SEC EDGAR.** Forms 3/4/5, DEF 14A proxy
statements (which name directors and their *other* boards — the
interlocking-directorate data), and Schedules 13D/G are all filed with the
SEC, free, and you **already have an EDGAR connector and `sentinel sec
history`.**

Paying a vendor for repackaged EDGAR data, when the vendor's copy is a
derived artifact and EDGAR's is the primary source, is a bad trade twice
over: it costs money and it *lowers* your evidence tier from `GREEN` (you
hold the filer's own bytes) to `ATTRIBUTED` (a vendor says so).

**The highest-value financial-intelligence source for your mission is SEC
EDGAR structured data, it requires no new credential, and you already have
the connector.**

### E.3 What I would actually build, in order

| Phase | Source | Credential | Why |
|---|---|---|---|
| **1** | **SEC EDGAR Form 4 / DEF 14A / 13D-G** | none (declared UA only, already set) | Person↔org↔date edges you have no other source for. Free. Primary. `GREEN` tier. |
| **2** | **Ohio Secretary of State + county auditor** | none / TBD | The actual gap under your live investigation. `moneyflow` prints "STATE AND LOCAL MONEY, ENTIRELY" absent on every run. |
| **3** | **GASB 77 abatement bridge** | none | `doc abatements` already reads the data; it is a document store not wired into `moneyflow`. Pure plumbing, real public-cost layer. |
| **4** | **FRED** | free key | Baselines for public-cost comparison. Low effort. |
| **5** | Finnhub **or** FMP (one, not both) | one key | Only if EDGAR parsing proves too costly. Compare against EDGAR before trusting. |
| **6** | Alpha Vantage / Nasdaq Data Link | — | Not recommended for this mission. |
| **Deferred** | Plaid **Sandbox only** | 3 vars | Build the adapter shape against Sandbox. Do not connect a real account. |

---

## F. CREDENTIAL PLAN

**I will never ask you to paste a secret into this chat, and you should
never do it if I slip and ask.** Everything below goes into
`modules/pra/.env` with `chmod 600`, per `docs/API_KEYS.md`.

### F.1 Phase 1–3 need no new credential at all

Phases 1, 2 and 3 above use sources you already have access to. **Do not buy
anything yet.**

### F.2 If and when you go further

| Variable | Provider | Where to get it | Cost `[UNVERIFIED]` |
|---|---|---|---|
| `FRED_API_KEY` | FRED | https://fredaccount.stlouisfed.org/apikeys | free |
| `FINNHUB_API_KEY` | Finnhub | https://finnhub.io/register | free tier exists; insider/ownership endpoints may be paid |
| `FMP_API_KEY` | Financial Modeling Prep | https://site.financialmodelingprep.com/developer/docs | free tier exists; low daily cap |
| `ALPHAVANTAGE_API_KEY` | Alpha Vantage | https://www.alphavantage.co/support/#api-key | free tier, tight rate limit |
| `NASDAQ_DATA_LINK_API_KEY` | Nasdaq Data Link | https://data.nasdaq.com/sign-up | free tier; most useful datasets paid |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Plaid | https://dashboard.plaid.com/signup | Sandbox free; Production requires approval |

Every cost and limit in that table is `[UNVERIFIED]` per §0.1. Load the URL
and read the current terms before acting on any of it.

### F.3 `PLAID_ENV` must default to `sandbox` and be checked at every call

Not documented — **enforced in code.** A `PLAID_ENV` of `production`
should be refused unless a separate explicit variable
(`PLAID_PRODUCTION_AUTHORIZED=yes-<date>`) is also set, so that promoting to
production is a deliberate two-key act and cannot happen by editing one line.

### F.4 Add to `KEY_SHAPES` before writing any adapter

Each new key gets a shape test and its signup URL, so a malformed key
reports as malformed before a network call — the mechanism that already
caught a pasted "Your API key is:" sentence.

---

## G. DATA FLOW

```
SOURCE (SEC EDGAR / Ohio SOS / provider API)
  |
  v
RAW CAPTURE            evidence/captures/live_capture_<c>_<slug>_<stamp>.json
                       verbatim bytes, never normalised in place
  |
  v
HASH                   sha256 taken BEFORE anything is derived
  |                    -> provenance.jsonl (hash-chained, append-only)
  |                    -> connector_runs (records_seen / records_imported /
  |                       truncated GENERATED)
  v
NORMALIZATION          reader per source; emits typed rows.
                       Missing figure -> NULL, never 0.
                       normalization_version stamped on every row.
  |
  v
ENTITY RESOLUTION      entities + entity_aliases.
                       Candidate matches only. NO automatic merge on name
                       similarity. Every merge records method, signals and
                       supporting source.
  |
  v
RELATIONSHIP GRAPH     entity_links  (relation, assertion_type, confidence,
                       observation window, source_id)
                       money_flows   (flow_kind, amount, currency, four
                       dates, source_row_id UNIQUE -> idempotent)
  |
  v
ANALYSIS               moneyflow / graph / lobby.
                       Per-kind totals only. No cross-kind sum exists.
                       Coverage printed before any figure.
  |
  v
CASE                   evidence/sentinel_cases/*.json — exhibits, gate
  |
  v
REPORT                 every row walks back: report -> flow -> source_row_id
                       -> capture file -> sha256 -> ledger chain -> URL +
                       retrieved_at
```

The reverse walk is the test. If any step cannot be reversed, the step is
wrong.

---

## H. SECURITY PLAN

**Already in place and to be preserved:** `.gitignore` on `.env` and
`evidence/`; `chmod 600`; `loadEnv()` not writing to `process.env`;
`KEY_SHAPES` pre-flight validation; CI credential scanning; `guard.py`
refusing credential-shaped text into the append-only chain; `stripAuth` on
redirect.

**To add for financial data specifically:**

1. **Sandbox-first, enforced.** §F.3.
2. **Account-level data is a separate store with a separate boundary.** If
   Plaid ever runs, `financial_accounts` / `financial_transactions` hold
   *your own* records. They must not be joinable to the investigative entity
   graph by default — a schema where your grocery spending sits one JOIN
   from a subject's lobbying record is a schema that will eventually leak
   one into a report.
3. **Never log a request URL carrying a key.** Several providers put the key
   in the query string. `describe()` must redact it, and captures must be
   written with the key stripped from any echoed URL.
4. **Provider terms are a legal boundary, not a technical one.** Some
   prohibit redistribution. A capture you may not republish must be marked
   at ingestion, or it will end up in an export.
5. **No third-party account access, ever.** Plaid authenticates *account
   owners*. Pointing it at anyone else's account is not an investigative
   technique; it is unauthorised access. The adapter should make this
   structurally impossible, not merely discouraged.

---

## I. TEST PLAN

Everything testable without a single real credential, matching the existing
pattern (`test_moneyflow.js` builds capture fixtures in a temp dir):

- **Fixture captures** shaped like each provider's real response.
- **Plaid Sandbox** for the adapter shape; never a live institution.
- **Idempotence** — ingest the same fixture 40 times, assert the money is
  counted once. This is the `moneyflow` 500-capture test, at the database
  layer. It is the single most important test in the plan.
- **Kind isolation** — assert no query and no column ever holds a
  cross-kind sum.
- **Assertion ladder** — a derived link must not be storable as
  `documented`; a co-occurrence must not become a plain edge.
- **Null vs zero** — a missing amount stays NULL through normalisation,
  storage, aggregation and export.
- **Entity resolution refusal** — two similarly-named entities must NOT
  auto-merge; assert they stay separate and the candidate is recorded.
- **Secret redaction** — a key in a query string never reaches a capture
  file, a log line, or a `describe()` string.
- **Provider failure modes** — 401, 403, 429 with `Retry-After`, 500,
  malformed JSON, HTML error page served as JSON, empty `results`.
- **Reverse walk** — from an exported row, reach the sha256 and the URL.

No real credential in any test, ever.

---

## J. IMPLEMENTATION PLAN — small, reviewable phases

| Phase | Deliverable | Reviewable because |
|---|---|---|
| **0** | *This document.* | Nothing built. |
| **1** | Migration 0008: assertion ladder, `relation_types`, observation window, `source_links` CHECK. No data movement. | Pure schema; rollback is trivial. |
| **2** | Get Postgres **running** and prove one round-trip: a `moneyflow` row → `entities` → `money_flows` → back out with its sha256. | One row, fully reversible. Settles the two-architecture question with evidence instead of argument. |
| **3** | Migration 0009: `money_flows` + `money_flow_kinds`, seeded from `moneyflow.KINDS`. | Additive. |
| **4** | Idempotent ingestion of the existing 17,324 rows. Assert the count does not change on a second run. | The 500-capture test at database scale. |
| **5** | **SEC EDGAR Form 4 / DEF 14A reader.** Person↔org↔date edges. | Free, primary, `GREEN` tier, unblocks `revolving-door`. |
| **6** | GASB 77 abatement bridge into `money_flows` as its own kind. | Public-cost layer. Data already read by `doc abatements`. |
| **7** | Entity resolution: candidates + evidence, **no auto-merge**. | Reviewable one candidate at a time. |
| **8** | Ohio SOS / county auditor readers. | The real gap. |
| **9** | Provider adapter framework + FRED as the first thin one. | Proves the plugin shape with a free key. |
| **10** | Anomaly detection, as leads only, with `algorithm_version` on every flag. | Last, because it is the easiest to misread. |
| **Deferred** | Plaid Sandbox adapter. | Only with explicit authorisation, Sandbox only. |

---

## K. The one line I would put above all of this

The directive's §25 says the system must never turn *"Company A and Company
B share a lobbyist"* into *"Company A and Company B coordinated."*

The schema as it stands cannot even record the first statement honestly — it
has no `derived`, no `hypothesis`, no controlled relation vocabulary, and a
money column that will silently add a contract ceiling to a lobbying fee.

**Fix the ladder before adding a single provider.** Every provider added
before that is more data flowing into a structure that cannot describe what
it knows, and re-typing 17,324 rows afterwards is not a migration anyone
will enjoy.
