# Reading the graph without fooling yourself

`sentinel connect graph --push` writes four things into Neo4j:

```
(:Org      {key, name, subject_count, counts_are_floors})
(:Subject  {name})

(:Org)-[:FILED_FOR     {filings, subjects, urls, basis:'senate_lda_filing'}]->(:Org)
(:Org)-[:APPEARS_UNDER {hits, connectors, basis:'search_result'}]->(:Subject)
```

**Those two edge types are not the same kind of fact, and the whole value of
the graph depends on never mixing them.**

| Edge | What it asserts |
|---|---|
| `FILED_FOR` | A firm swore, in a federal filing, that it lobbied for that client. It carries the filing URLs. |
| `APPEARS_UNDER` | A search returned this name for that subject. It asserts **nothing** about the organisation. |

Two companies under the same subject are **two hops apart, through the
subject**. There is no edge between them, because your captures do not
establish one. Do not draw one in your head either.

On the run of 2026-09-06 the split was **3,075 sworn against 7,331 search
results** — so roughly **seven in ten edges in the graph assert nothing**.
Hold that number while you look at it.

Every count is a **floor**: 1,519 of 3,620 captures held fewer rows than the
source reported. Nodes carry `counts_are_floors: true` so the graph says so
about itself.

---

## Run them from the terminal

```bash
bin/sentinel connect graph --ask coverage
bin/sentinel connect graph --ask bridges --limit 30
bin/sentinel connect graph --ask noise
bin/sentinel connect graph --ask firm   --term "modern fortis"
bin/sentinel connect graph --ask thread --term securitization
bin/sentinel connect graph --ask pair
```

**Do not paste the Cypher below into your shell.** `(`, `[`, `>` and `*` are
all shell metacharacters, so Cypher at a zsh prompt does not fail cleanly — it
globs, opens process substitutions, and reports something that looks like a
filesystem error:

```
zsh: no matches found: (o:Org)-[:APPEARS_UNDER]-/dev/fd/12
zsh: command not found: WITH
```

That is why `--ask` exists. It runs the same query against the same database
`--push` writes to, with the same credentials, and prints a table. The Cypher
is written out below so you can read and adapt it — paste it into **Neo4j
Browser** if you want to change one, never into the shell.

### 0. What is actually in there

```cypher
MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC;
```

### 1. How much of this graph asserts nothing at all

```cypher
MATCH (o:Org)
WHERE NOT (o)-[:FILED_FOR]-()
RETURN count(o) AS orgs_with_no_sworn_edge;
```

Run this first, every time. It is the denominator for everything below: those
organisations are in the graph only because a search returned their name.

### 2. THE BRIDGES — the query worth running, read carefully

```cypher
MATCH (reg:Org)-[:FILED_FOR]->(cli:Org)-[:APPEARS_UNDER]->(s:Subject)
WITH reg, cli, count(DISTINCT s) AS per_client
WITH reg, count(DISTINCT cli) AS clients, max(per_client) AS from_one_client
WHERE clients >= 2
MATCH (reg)-[f:FILED_FOR]->(c2:Org)-[:APPEARS_UNDER]->(s2:Subject)
WITH reg, clients, from_one_client,
     count(DISTINCT s2)             AS threads,
     sum(f.filings)                 AS filings_in_library,
     collect(DISTINCT s2.name)[..4] AS via
WHERE threads >= 2
RETURN reg.name AS registrant, clients, threads, from_one_client,
       filings_in_library, via
ORDER BY clients ASC, threads DESC
LIMIT 30;
```

**Read `from_one_client` before anything else.** It is the largest number of
subjects reached through a *single* client. When it equals `threads`, the firm
bridges nothing — one client of theirs is simply a name you searched under many
spellings.

That column exists because the first version of this query had neither it nor a
client floor, and reported `MCGINLEY LLC — 17 threads` at the top of a list
called *bridges*. McGinley has **one** client, Meta Platforms. Those 17 threads
were Meta's own breadth, and Meta topped the noise query at 17 for exactly the
same reason. The row was the operator's own subject list handed back to him.

The first version also ordered `threads DESC, clients ASC`. Thread counts are
almost never tied, so the ascending clause never fired and the megafirms —
Akin Gump at 317 clients, Alpine at 398 — sat at the top. `clients ASC` is now
the primary sort.

`filings_in_library` counts filings **you captured**, not filings that exist.
The firm's real book size is in `evidence/registrant_books.json`, written by
`connect expand`.

### 3. Pull one firm's sworn book, with the citations

```cypher
MATCH (reg:Org)-[f:FILED_FOR]->(cli:Org)
WHERE toLower(reg.name) CONTAINS 'modern fortis'
RETURN cli.name AS client, f.filings, f.subjects, f.urls[0..3] AS cite
ORDER BY f.filings DESC;
```

`f.urls` is the filing itself. That is what you cite — never this graph.

### 4. Two hops, with the reason shown

Companies that share subjects. The `via` column is the *only* thing that makes
this readable: it names why they are near each other, so you can see when the
answer is "because you searched for both".

```cypher
MATCH (a:Org)-[:APPEARS_UNDER]->(s:Subject)<-[:APPEARS_UNDER]-(b:Org)
WHERE a.key < b.key
WITH a, b, count(DISTINCT s) AS shared, collect(DISTINCT s.name)[..5] AS via
WHERE shared >= 3
RETURN a.name, b.name, shared, via
ORDER BY shared DESC
LIMIT 25;
```

### 5. The noise filter — run it before you trust anything

An organisation appearing under a dozen unrelated subjects is usually a
generic name, a court caption word, or a company so large it turns up
everywhere. These are the rows to distrust first.

```cypher
MATCH (o:Org)-[:APPEARS_UNDER]->(s:Subject)
WITH o, count(DISTINCT s) AS breadth
WHERE breadth >= 10
RETURN o.name, breadth
ORDER BY breadth DESC
LIMIT 25;
```

### 6. One thread, everything under it

```cypher
MATCH (o:Org)-[a:APPEARS_UNDER]->(s:Subject)
WHERE toLower(s.name) CONTAINS 'phase-in'
   OR toLower(s.name) CONTAINS 'securitization'
   OR toLower(s.name) CONTAINS 'nonbypassable'
   OR toLower(s.name) CONTAINS 'pirb'
RETURN s.name AS subject, o.name AS org, a.hits AS hits, a.connectors AS sources
ORDER BY subject, hits DESC;
```

### 7. Reset, if you want to rebuild from scratch

```cypher
MATCH (n) DETACH DELETE n;
```

Every write is a `MERGE`, so re-running `graph --push` updates in place. You
only need this if you want to drop subjects you have since renamed.

---

## What the graph cannot do

It cannot tell you that two organisations are related. It holds sworn filings
and search results, and it labels which is which. Everything else is you
reading it.

A picture of a network is the most persuasive thing this desk can produce and
the least evidentiary. Cite the filing, never the graph.
