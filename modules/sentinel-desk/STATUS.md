# Sentinel Desk — status in this repo

**Runnable.** All thirteen modules present, `test_sentinel.py` passes 53/53,
and the full path — `init → case new → claim add → gate → export` — runs
end to end with the audit chain verifying intact.

Last verified 2026-08-26 against a fresh desk root.

---

## What this file used to say, and why that matters

Until this revision, this page said:

> **Not yet runnable** — six of thirteen modules are present; seven exist
> only as call signatures inferred from the code that imports them.
>
> ## What to do next
> Paste the seven files above...

That was true when it was written and false by the time anyone read it. The
seven modules — `guard.py`, `store.py`, `audit.py`, `ingest.py`, `gates.py`,
`export.py`, `ui.py` — were written and tested in this repo, and the page
was never updated.

A status page that is confidently wrong about the state of the system is the
same failure this desk is built around, pointed at the documentation instead
of the data: calm, plausible, and it would have sent the operator hunting
through old sessions for source he already had. **Re-derive this page from
the code, do not maintain it by hand.**

---

## Verify it yourself

```bash
cd modules/sentinel-desk && python3 test_sentinel.py     # 53 checks
bin/sentinel sdesk doctor                                # what is set up
bin/sentinel sdesk verify                                # audit chain + vault
```

`bin/sentinel test` runs the first of these as part of the full suite.

---

## What the desk enforces

The gate is the point. A claim does not become publishable by being typed in.

| Tier | What it must carry |
|---|---|
| `GREEN` | a primary citation |
| `ARITH` | the formula that produces the figure |
| `REPORTED` | the outlet that reported it |
| `RED` | written **as a question**, naming the record that would close it (`--gate`) |
| `DEAD` | what closed it (`--resolution`) |

Observed on a live run: a RED claim entered as a statement was refused with

```
RED_AS_FACT: An open question must be written as a question (it does not
end in '?') and must name the specific record that would close it
```

`export` then splits the case into publishable claims and **withheld** ones,
and lists the withheld with their reasons inside `dossier.md` rather than
dropping them. A claim that cannot be published is still visible.

---

## Where the data lives

`$SENTINEL_ROOT` (default `~/SentinelDesk`):

```
sentinel.db          SQLite — cases, claims, citations, requests, audit
audit.jsonl          append-only mirror of the audit table
vault/               ingested documents, content-addressed
exports/<slug>/      dossier.md, findings.json, sha256
```

Back up by copying the whole folder. There is no daemon and no dump command.

---

## Known gaps

- **`sentinel security` has no CLI subparser.** `security.py`'s docstring and
  `server.py`'s `/security` page both reference `sentinel security --strict`,
  but `cli.py`'s `build_parser()` never defines it. The checks run — they are
  exercised by `test_sentinel.py` — they just are not reachable from the CLI
  by that name.
- **`defenders/lessons/05-write-a-finding-that-survives-scrutiny.md`** is
  named as the capstone in the curriculum README's sequence table and does
  not exist.
- **Two case systems.** `bin/sentinel case` (research-desk, JSON, the
  R-01…R-04 publication gate) and `bin/sentinel sdesk case` (this desk,
  SQLite, GlassMark tiers) both exist, both are called "case", and neither
  knows the other is there. See `docs/OPERATOR_MANUAL.md` §8a.
- **Nothing flows in from the connectors.** 465 captures, a Neo4j graph and a
  lobbying dataset sit in `evidence/`, and every claim in this desk is typed
  by hand.
