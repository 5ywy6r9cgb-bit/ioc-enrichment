# modules/cycle: the desk's daily cycle (cycle/1.0.1)

One command runs the desk's routine in a fixed order and leaves a record
you can check later:

```
bin/sentinel-cycle run --go
```

Without `--go` only the offline steps run. With the schedule installed
(`bin/sentinel-cycle schedule install`) it runs every morning; a Mac that
was asleep runs it when it wakes.

## What runs, in order

| Step | Command | Network | When |
|---|---|---|---|
| ledger-check | `bin/sentinel-ledger check` | no | daily |
| chain-verify | `bin/sentinel-ledger chain verify` | no | daily |
| seal-verify | `bin/sentinel-ledger seal verify` | no | daily, once a seal key exists |
| site-verify | `bin/sentinel-station verify site` | no | daily, once `site/` is built |
| routes | `bin/sentinel-routes build` | no | daily, once the routes module is installed |
| watch | `bin/sentinel watch run` | yes | daily, unless the watch job already runs it |
| keys | `bin/sentinel connect test` | yes | Mondays |
| watch-status | `bin/sentinel watch status` | no | daily |
| crosslink | `bin/sentinel connect crosslink` | no | daily |
| matrix | `bin/sentinel connect matrix` | no | Mondays |
| sources | `bin/sentinel-ledger verify-sources --go --delay 3` | yes | Sundays |
| library | `bin/sentinel-cycle library check --go` | yes | the 1st of the month |
| selftests | ledger, coin, station, routes, cycle | no | Sundays |
| records | `bin/sentinel pra foia` | no | daily |
| anchor | `bin/sentinel-ledger chain anchor` | no | daily |

A weekly or monthly step that was missed (the Mac was off) catches up on
the next run. `bin/sentinel-cycle plan` shows what runs today and why.

## What it will not do

The cycle runs only this desk's own commands (`bin/sentinel`, the `bin/sentinel-*` modules,
`sentinel-hunt`, `sentinel-fds`), never a shell. It refuses any command
containing a human act: send, approve, sign, publish, submit, mail, commit,
push, keygen, install-data, append, add, new, draft, apply, link, import,
delete, remove, install, uninstall, setup, init, correct, ingest, `--by`,
and `station build`. That holds even for steps you add yourself.

## What it writes

The cycle itself writes only under `evidence/`. The commands it runs
write what they always write (for example, `connect matrix` refreshes its
CSVs).

- `evidence/cycle/runs/<run>/`: one scrubbed log per step, `run.json`, `digest.md`
- `evidence/cycle/state.json`: last success per step, last record and its hash
- `evidence/cycle/library_decisions.jsonl`, `library_checks.jsonl`: append-only
- `evidence/ledger/cycle-<run>.sha256`: the run's record

Every log is scrubbed before it is written: credential values from your
environment and `.env` files, credential shapes (Authorization headers,
`api_key=`, `user:pass@`), every line of `~/.sentinel/ledger/forbidden.txt`,
your home path, your `user@host` prompt, your machine name, and terminal
colour codes.

## The record chain

Each record lists the SHA-256 of the run's logs, `run.json`, `digest.md`,
the ledger's integrity files, the built site's manifest, and the previous
record. `bin/sentinel-cycle verify` re-hashes the newest record and walks
back through every earlier one. `verify --deep` also re-hashes every old
run. Append-only files (chain, seals, anchors, checks) are checked by
prefix: they may grow, but no byte that was recorded may change.

The record is `shasum` format too. From the repo:
`shasum -a 256 -c evidence/ledger/cycle-<run>.sha256`. The ledger and site
lines will fail after a rebuild; `verify` explains the difference.

## Your own plan: evidence/cycle/plan.json

```json
{
  "disable": ["matrix"],
  "cadence": {"sources": "weekly:sat", "keys": "daily"},
  "timeout": {"watch": 10800},
  "extra": [
    {"id": "sweep-ratepayers", "what": "ratepayers sweep, CourtListener only",
     "argv": ["bin/sentinel", "connect", "sweep", "ratepayers", "--go", "--only", "courtlistener", "--new-only"],
     "network": true, "cadence": "weekly:tue", "timeout": 3600}
  ]
}
```

Cadences: `daily`, `weekly:mon` to `weekly:sun`, `monthly:1` to
`monthly:28`, `manual` (runs only with `--only ID`). Extra steps run just
before the records desk and the anchor, and pass the same refusal rules.
A step without `"network": false` is treated as a network step and needs
`--go`. Keep CourtListener sweeps inside the desk's 125-calls-a-day budget.

## The library

`modules/cycle/library.json` lists the connectors already on the desk
(ACTIVE) and 15 sources proposed on 2026-09-30 at your request (PROPOSED).
Each proposed row records what was checked and on which page. Nothing
proposed is used until you approve it:

```
bin/sentinel-cycle library show SRC-OFAC-SLS
bin/sentinel-cycle library approve SRC-OFAC-SLS --by "your initials"
```

`library check --go` makes one GET per source page, plus robots.txt once
per host (RFC 9309: a 4xx robots file means no rules; a 5xx or unreachable
one fails closed unless `--robots-unreachable-ok`). TLS verification stays
on; set `SENTINEL_CAFILE` if you need an extra CA bundle. A dropped
connection is retried once. BLOCKED (401/403/429) means the page answers
people and not scripts: open it in a browser.
