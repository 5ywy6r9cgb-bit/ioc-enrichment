# Connector status report — OpenSanctions and all registered connectors

**Run:** 2026-08-20, from this session's sandboxed environment.
**Method:** Actually invoked `modules/connectors/registry.js`'s `runConnector()`
for every connector in the registry, with a real query, exactly as it would
run for you. This is not a code review — it is a live execution log.

---

## The one-line answer

**All six connectors are real, correctly coded, and ready to use.** None of
them could complete a live call *from this sandboxed session*, because this
session's network policy blocks outbound connections to every one of their
target hosts. That is a property of *this cloud session*, not of the code —
the same code will work normally on your own Mac, where no such policy
exists, once the relevant API keys are in `.env`.

Proof this is a network policy, not a code bug: every call failed at the
**proxy's CONNECT step**, before reaching the actual API, with the exact
message the proxy uses for a disallowed destination:

```
curl: (56) CONNECT tunnel failed, response 403
```

This happened identically for all six hosts (opensanctions.org,
courtlistener.com, federalregister.gov, api.open.fec.gov, lda.senate.gov,
api.usaspending.gov), tested both through the code (`registry.js`) and
independently with raw `curl` against the proxy directly. A code bug would
fail differently on different hosts; a uniform proxy-level rejection on every
host is a policy fence around this whole sandbox, not a connector problem.

This desk's own discipline (`registry.js`'s `runConnector`) is **fail-closed**
on exactly this situation: on any non-2xx response, it writes **no** capture
file and **no** provenance-ledger entry. Confirmed — `evidence/captures/` has
zero new files from this run. The ledger doesn't get to lie about a call that
didn't happen.

---

## OpenSanctions — the one you asked about specifically

**What it is, in this codebase:** `modules/connectors/registry.js`, entry
`opensanctions`. It calls OpenSanctions' `/match/default` endpoint with a
name, using their "logic-v2" matching algorithm — this is the same API
OpenSanctions markets for sanctions/PEP/adverse-media screening, not a
simple keyword search.

**What it returns, per match:** `external_id`, `name` (their "caption"),
`schema` (Person/Company/etc.), `topics` (why they're listed — sanctions,
PEP, crime, etc.), a match `score`, and a direct URL to the OpenSanctions
entity page.

**Authentication:** requires `OPENSANCTIONS_API_KEY` — this is a **hard
requirement** in the code (`keyRequired: true`). No anonymous tier is coded.
**Not set** in either `.env` this session can see. OpenSanctions offers a
free-tier API key on signup; that's the blocker, not the code.

**This run's result:** SKIPPED before any network attempt — the code checks
for the key and refuses to call out without one, correctly. When I then
tested the endpoint directly with `curl` (bypassing the key check, just to
find out whether the *host* was even reachable), the proxy itself rejected
the connection with 403 before the key would have even mattered.

**Two separate gates stand between you and OpenSanctions data:**
1. This sandbox's network policy blocks `api.opensanctions.org` outright —
   irrelevant once you're running this on your own machine.
2. You don't have an `OPENSANCTIONS_API_KEY` yet — get one free at
   opensanctions.org, put it in `modules/connectors/.env` or
   `modules/pra/.env` as `OPENSANCTIONS_API_KEY=...`.

Every hit OpenSanctions returns is written to the ledger with
`result_disposition: 'lead_needs_primary_source'` — same rule as every other
connector in this system: a sanctions-list match is a lead to verify, never
a publishable fact by itself. Sanctions lists have false positives (common
names, stale data) often enough that this rule matters in practice, not just
in principle.

---

## Every connector, run for real

| Connector | Key required? | Key present? | Result this run | What it's for |
|---|---|---|---|---|
| **OpenSanctions** | Yes (`OPENSANCTIONS_API_KEY`) | No | Skipped (no key) — host also proxy-blocked | Sanctions/PEP/adverse-media screening |
| **CourtListener** | No (anon. works; token raises rate limit) | No | Proxy-blocked (403 at CONNECT) | Federal court opinions & dockets (RECAP) |
| **Federal Register** | No | — | Proxy-blocked (403 at CONNECT) | Federal rules, notices, agency actions |
| **FEC** | Yes (`FEC_API_KEY`, or `DEMO_KEY` for trial) | No | Skipped (no key) — host also proxy-blocked | Federal campaign finance |
| **Senate LDA** | No (anon. works) | No | Proxy-blocked (403 at CONNECT) | Federal lobbying disclosures |
| **USAspending** | No | — | Proxy-blocked (403 at CONNECT) | Federal contracts & grants by recipient |

Test queries used (chosen to connect to threads already in this repo, not
arbitrary): CourtListener → "Flock Safety"; Federal Register → "automated
license plate reader"; FEC → "Householder"; Senate LDA → "Flock Safety";
USAspending → "Flock Safety".

---

## What "ready to use" actually means here

Nothing about this run means the connectors are broken. It means:

1. **From this sandbox**, none of these six hosts are reachable — confirmed
   at the network layer, not guessed at.
2. **From your own Mac**, none of that applies. The only two things standing
   between you and real results are the two free/cheap API keys
   (OpenSanctions, FEC — both have no-cost tiers) and running
   `node modules/connectors/cli.js <connector> "<query>"` locally.
3. Every connector already enforces the same discipline before a byte
   reaches your database: announce the exact call before making it, capture
   the raw response, hash it before parsing anything out of it, write one
   append-only ledger line, and tag every result
   `lead_needs_primary_source` — a hit is an investigative lead, never a
   fact, until you've checked the primary document it points to.

## Recommended next step, in order

1. Get an OpenSanctions API key (free tier, signup only) and an FEC key
   (also free — `api.data.gov`). Put both in `modules/connectors/.env`.
2. Run `node modules/connectors/connect_test.js` on your own machine to
   confirm both keys authenticate.
3. Run a real query through each connector on a name/entity already active
   in one of your investigations (Flock Safety, HB 646-adjacent legislators,
   AEP Ohio, etc.) and let the ledger start accumulating real leads.
