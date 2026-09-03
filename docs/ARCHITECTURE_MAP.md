# The architecture map

Where the SENTINEL-X design lands against what this repo already runs — what
exists, what is partial, what is next, and the three things in the design that
this desk should deliberately not build.

Read this before adding a module. The most expensive mistake available here is
building a second, weaker version of something that already exists under a
different name.

---

## The short version

The ten-layer design describes an evidence pipeline:

```
collection → evidence → graph → threat → hypothesis
           → case → cognition → leads → prediction → publication
```

Seven of those ten layers are built. They are not named the way the design
names them, which is the main reason it looks like nothing is there:

| Design layer | In this repo | State |
|---|---|---|
| 1 Collection | `modules/connectors/registry.js` — 9 live sources, one shared run procedure, paced, fail-closed | **built** |
| 2 Evidence | `core/provenance/` — sha256 at arrival, append-only `provenance.jsonl`, `prov verify` | **built** |
| 3 Graph | `modules/connectors/graph.js` — Neo4j push where edge *shape* carries evidentiary weight | **built** |
| 4 Threat / scoring | `modules/connectors/crosslink.js` — co-occurrence ranked by improbability, labelled as leads | **built, deliberately unscored** |
| 5 Hypothesis | `modules/bridge/draft.js` — captures become RED open questions, never GREEN claims | **built** |
| 6 Case management | `modules/research-desk/case.py`, `modules/sentinel-desk/sentinel/gates.py` | **built** |
| 7 Cognitive fabric | partial: `connect brief` reads the library back; no gap detector, no question generator | **partial** |
| 8 Autonomous leads | `modules/watch/` — scheduled re-asks, seen-set, new-hits-only notification | **built for watches, not for the graph** |
| 9 Predictive | — | **not built, and see below** |
| 10 Publication | `modules/sentinel-desk/sentinel/export.py`, `case status` gate, video seam | **built** |

The connectors as of this writing: `opensanctions` `courtlistener`
`federalregister` `fec` `senatelda` `regulationsgov` `bls` `opencorporates`
`usaspending`.

---

## What the pasted modules would have duplicated

Mapping the seven files in the design onto their existing equivalents:

| Proposed | Already exists as | Note |
|---|---|---|
| `sentinel_core.py` orchestrator | `bin/sentinel` + `modules/connectors/cli.js` | the dispatcher is bash, the work is per-module |
| `intelligence_runtime.py` watchlists + leads | `modules/watch/run.js`, `watchlist.json` | with a seen-set, which the proposal lacks |
| `community_detection_engine.py` | `crosslink.js` + `graph.js` | co-occurrence is found, then *refused* the name "relationship" |
| `neo4j_node2vec_pipeline.py` | `graph.js` (`connect graph --push`) | see the embeddings note below |
| `realtime_intelligence_fabric.py` | `modules/watch/` | launchd rather than asyncio, on purpose — a Mac asleep at 08:00 still runs the job |
| `cognitive_fabric.py` | partially `draft.js` | the useful half is the question generator; see next |
| `signal_enrichment_engine.py` | — | see the sentiment note below |

Three of the proposed modules also carry defects worth naming, because they
show the risk of the whole approach rather than just a typo:

- `EventBus.emit` reads `for callback in self.listenerscallback(payload)` —
  it does not parse. It would fail on import.
- Every connector in `sentinel_core.py` returns a literal
  (`return ["social_data"]`). Run end to end, it manufactures entities,
  relationships, hypotheses and a threat score from three hardcoded strings,
  then prints a report that looks exactly like a real one.
- `ThreatEngine.score` is `len(relationships) * 2 + len(hypotheses) * 5`.
  That is not a model of risk. It is a model of how many rows were returned.

None of that is a reason not to write the layer. It is the reason to write it
against real captures on disk, where a wrong answer is checkable.

---

## The three things not to build

Not "later" — the design is right that they are the natural next layers, and
they are the three that would break this desk specifically.

### 1. A numeric threat score

The design rolls influence, money, coordination, narrative and anomaly into
one 0–100 number with fixed weights, and thresholds it into
`INFO / LOW / MEDIUM / HIGH / CRITICAL`.

The problem is not that the weights are arbitrary, though they are. It is that
the output is **an accusation with a decimal point on it**. `Threat 91 —
CRITICAL` attached to a named person or company, derived from search hits
nobody has read, is defamatory in the ordinary sense of the word, and the
number is what makes it persuasive. `crosslink` already does the useful part of
this — surfacing the unlikely overlap — and stops at "a shortlist of places to
look", which is the honest ceiling on what co-occurrence supports.

If ranking is wanted, rank **the work**, not the subject: how many unfetched
primary documents a lead implies, how cheaply it can be resolved, how long it
has been open. That prioritises the analyst's day without scoring a human
being.

### 2. Hypotheses generated from unread captures

`HypothesisEngine.generate` turns each observation into
`Possible Explanation: {category}`. At the volume this desk collects, that is
several hundred machine-written hypotheses per sweep, each one indistinguishable
in the case file from one a person reasoned their way to.

`draft.js` already faced this and chose the narrow version: captures become
**RED open questions**, each one naming the document that would close it and
the command that fetches it. That is the same idea with the claim removed, and
it is why draft is safe to run over hundreds of captures.

### 3. Sentiment and "emotional pressure" scoring

`SignalEnrichmentEngine` scores text for negative-word density and calls the
result pressure, then feeds it into priority. Two failures compound: a
transformer sentiment model over a court docket or an LDA filing measures the
register of legal prose, not anything about the subject; and counting words
like *crisis* and *attack* in news copy measures the outlet's style. Both then
become a number that ranks a person.

There is a real version of this — narrative propagation, where the same
sentences appear across accounts in a window — but it needs collection this
desk does not currently have, and it belongs after, not before, the layers
below.

---

## What is actually missing, in the order worth building

### 1. The question generator (design layer 7)

The single highest-value piece of the cognitive fabric, and the safest: it
produces *questions*, which are the one output that cannot be wrong in a way
that harms anyone.

Given an entity in the graph, generate the standing set — who else does this
registrant file for, what awards name this entity, which officers appear
elsewhere, what is the earliest and latest date we hold — and, for each, the
exact command that answers it. `connect expand` is one instance of this
already. Generalising it is a contained job.

### 2. Intelligence gaps as a first-class thing

`GapEngine` in the design is the right instinct with the wrong threshold
(`len(evidence) < 3`). The version that fits here: for each open question on a
case, say what class of document would close it and whether the desk holds it.
That turns `case status` from a blocker list into a work queue.

### 3. Embeddings — but on `FILED_FOR`, not on everything

The Node2Vec proposal is sound in principle and dangerous applied to the whole
graph, because `APPEARS_UNDER` edges are search artifacts: embedding over them
finds entities that were *searched together*, then presents that as structural
similarity. The graph is two-hop for exactly this reason.

The honest version runs over the asserted-relationship subgraph only —
`FILED_FOR` edges, which are sworn filings under 2 U.S.C. §1603–1604 — and
reports neighbours as *"structurally similar in the lobbying graph"*, which is
a claim the data actually supports. Everything reached that way is still a
lead needing a primary source.

### 4. Temporal edges

The design is right that every edge should carry `start_date`, `end_date`,
`confidence` and `source_document`, and the repo is currently weaker here than
the design: filings are dated, and the graph does not yet let you ask what the
network looked like in 2023. This is unglamorous and it is probably the highest
analytical return of anything on this list.

---

## The rule that governs all of it

Every layer above obeys the same constraint, and it is the reason the desk is
worth building on at all:

> A capture is a search result. A co-occurrence is a place to look. A filing is
> an asserted relationship. Only a fetched, hashed, read primary document
> supports a claim — and a claim cites the document, never the search that
> found it.

Any module that cannot state which of those four it produces does not belong in
this repo yet.
