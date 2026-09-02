# The workflow

How the standing watch, the filing cabinet, and the notifications fit together —
and the reasoning behind each choice, so you can change any of it deliberately.

---

## The shape of a day

```
  08:00  launchd wakes the watch runner
           │
           ├─ for each watch that is DUE:
           │     call the connector once
           │     write the capture, hash it, append the provenance ledger
           │     compare against the seen-set
           │
           ├─ NEW hits?  →  file into the investigation folder
           │                append NEW_HITS.md
           │                send ONE notification: a count and a watch id
           │
           └─ nothing new? → one quiet line, no notification

  you       open the desk, read NEW_HITS.md, confirm same-entity,
            pull the underlying document, then and only then cite it
```

---

## Setting it up

```bash
cp modules/watch/watchlist.example.json watchlist.json   # then edit
sentinel watch status                                    # what is configured
sentinel watch run --all --dry-run                       # rehearse: no calls
sentinel watch run --all                                 # the real first run
sentinel watch install 8                                 # daily at 08:00
```

`watchlist.json` is gitignored. Your subjects of interest are not something to
publish to a remote.

The first real run reports everything as new, because the seen-set starts empty.
That is the baseline; every run after it reports only what changed.

---

## Why only new hits

A watchlist that re-reports the same twelve results every morning gets muted
within a week — and a muted watchlist is worse than no watchlist, because it
produces the *feeling* of coverage without the fact of it.

So the runner keeps a seen-set per watch in `evidence/watch/state.json` and
reports only ids it has never seen. A quiet morning prints one line and sends
nothing. When your phone does buzz, something actually changed.

The id it remembers comes from each connector's `identify()` — OpenSanctions
entity id, CourtListener opinion id, Federal Register document number. Getting
that field wrong makes a watch either silent or a firehose, which is why it is
required rather than inferred.

**To re-baseline a watch** (you changed the query, or want a fresh look):
delete that watch's entry from `evidence/watch/state.json`. The next run treats
everything as new again.

---

## What lands in the folders

The filing cabinet builds itself as you work:

```
evidence/investigations/<investigation>/<YYYY>/<MM>/
    live_capture_<connector>_<query>_<stamp>.json     verbatim response bytes
    NEW_HITS.md                                       appended, human-readable
```

The `investigation` field on each watch decides the folder, so watches on the
same thread land together. Anything without one goes to `unfiled/`.

Every capture is hashed into `evidence/manifests/provenance.jsonl`, which means:

```bash
sentinel prov verify evidence/manifests/provenance.jsonl   # nothing was edited
sentinel prov ingest evidence/manifests/provenance.jsonl   # into the citation ledger
```

A watch capture is an artifact like any other. That is the entire benefit of
having one provenance shape.

---

## Notifications

### The content rule

**A notification carries a count, a label, and an id. Never a name, never a
quote, never anything from a capture.**

The notification is a doorbell, not a delivery. You open the desk to see what
arrived.

This is not fastidiousness. `"3 new hits on WATCH-HB6-01"` tells you to go look.
`"Larry Householder matched a sanctions list"` is a claim about a person, sitting
on a third party's server and on a lock screen, before you have confirmed it is
even the same individual. The first is a signal. The second is an allegation you
have not verified, published to a place you do not control.

`notify.js` enforces this: it refuses any message that looks like an SSN, a card
number, an account number, or a street address, and refuses anything over 240
characters on the grounds that a summary is not a signal. `modules/watch/test_notify.js`
covers 17 cases, including real addresses out of `seed_agencies.csv`.

### Choosing a backend

Set `notify.backend` in `watchlist.json`:

| backend | Reaches | Outbound traffic |
|---|---|---|
| `none` | nothing | none — the default |
| `macos` | your Mac's Notification Center | **none** |
| `file` | `evidence/watch/notifications.log` | none |
| `ntfy` | **your phone**, iOS and Android | yes — see below |

**For your phone**, `ntfy` is the honest option: free, no account, works on iOS
and Android, and self-hostable.

```bash
openssl rand -hex 16      # generate a topic name
```

1. Install the ntfy app
2. Subscribe to that topic
3. Put it in `watchlist.json` and set `"backend": "ntfy"`

Two things to understand before turning it on. **The topic name is effectively a
password** — anyone who guesses it can read your notifications, which is why it
should be random rather than `mark-sentinel`. And **the ntfy.sh server sees every
message**. Both are survivable *only* because of the content rule: what crosses
that server is `"2 new on WATCH-FLOCK-01"`. Set `notify.server` to your own host
if you want even that to stay yours.

---

## Scheduling

`sentinel watch install [HOUR]` writes a launchd agent to
`~/Library/LaunchAgents/com.sentinel.watch.plist`.

launchd rather than cron, deliberately: if the Mac is asleep at the scheduled
hour, launchd runs the job once it wakes. cron simply skips the day — and a
watchlist that silently did not run looks exactly like a watchlist with nothing
to report. That is the failure you would never notice.

Logs go to `evidence/watch/launchd.log`. To stop: `sentinel watch uninstall`.

On Linux, use a systemd timer or cron:

```
0 8 * * *  cd /path/to/SentinelOS && bin/sentinel watch run
```

---

## Failure behavior

- A connector returning non-2xx, or no network at all, is **fail-closed**: no
  capture is written, no ledger line is created, and `last_run_at` is *not*
  advanced. The watch is retried on the next run rather than being silently
  marked as checked.
- A failed watch is counted in the notification (`"2 new · 1 failed"`) so a
  connector that has been quietly broken for a week cannot pass as silence.
- A notification that cannot be delivered never fails the run. A missed doorbell
  must not lose the run that rang it.

---

## Adding a connector

Add an entry to `CONNECTORS` in `modules/connectors/registry.js` with:

| field | what it does |
|---|---|
| `label`, `keyVar`, `keyRequired` | identity and credentials |
| `describe(q)` | the announce line — must state the real call |
| `probe(key)` | a cheap call for `sentinel connect test` |
| `run(q, key)` | the actual request |
| `parse(json)` | response → array of result objects |
| `identify(r)` | the stable id used for new-vs-seen |

Both the CLI and the watch runner pick it up automatically — they share one
registry precisely so the run procedure cannot drift between them.

Good next candidates, given what you already have: SEC EDGAR and Federal Register
are live-proven in `docs/RATIFICATION.md`; Ohio SOS business search and the Ohio
Auditor's Findings for Recovery are in your portal registry and would flag a new
audit finding against an entity you are tracking.
