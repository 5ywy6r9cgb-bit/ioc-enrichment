# The workflow

Two loops run on this desk, and they are not the same loop.

**The investigation loop** is you, working: you ask sources a question, read
what came back, decide what it means, and file it. It is deliberate, it costs
API calls, and every step of it is a judgement.

**The standing watch** is the machine, waiting: the same questions asked on a
schedule, reporting only what changed. It is unattended, it costs nothing to
leave running, and it makes no judgement at all.

The investigation loop is documented first because it is the one you run, and
because the watch only makes sense as the automated tail of it.

---

# 1 · The investigation loop

```
  sentinel case new CASE "..."          open the file first, not last
        │
        ├─ sentinel case add CASE EX-01 FILE     what you already hold
        │
  sentinel connect sweep SET            ask the sources  (--new-only skips today's)
  sentinel connect NAME "QUERY"         or ask one, once
        │                                 ↓ writes evidence/captures/*.json
        │                                 ↓ hashes into provenance.jsonl
        │
  sentinel connect crosslink            what appears under more than one subject
  sentinel connect brief "NAME"         everything the library holds on one name
        │
  sentinel draft CASE --apply           file the survivors as OPEN QUESTIONS
        │
  sentinel doc get URL                  fetch the ACTUAL document, hashed
        │
  you       confirm same-entity, read the document, write the claim,
            cite the document — not the search result
        │
  sentinel case status CASE             what is still blocking publication
```

## What each step is allowed to assert

This is the part that matters, and it is the part a diagram cannot carry.

| Step | Produces | May be called |
|---|---|---|
| `connect` | a capture: the verbatim bytes a source returned | a **lead** |
| `crosslink` | names appearing under more than one subject | a **place to look** |
| `brief` | everything the library holds on one string | a **reading list** |
| `draft` | RED open questions on the desk | a **question** |
| `doc get` | the primary document, hashed and text-extracted | a **source** |
| you | a claim citing that document | a **finding** |

Nothing in the first four rows is a finding, and no command in this repo can
promote one into a finding. That promotion costs three deliberate human acts —
fetch the document, ingest it, cite it — and the desk schema enforces it: a
citation takes a `doc_id` into `documents`, and there is no way to cite a URL.

## Why the case file is opened first

Because a case opened at the end is a case built to fit what you found.

`sentinel case new` costs nothing and takes a subject line. Opening it before
the first search means the exhibits, the open questions and the contradictions
accumulate against a stated question rather than being assembled afterwards
into a story. `case status` will refuse to call an empty case publishable —
0 exhibits reads as 100% of nothing — and it will keep refusing while any
question is open or any conflict unresolved.

There is no `--force`. CI asserts there is no `--force`.

## The cost of asking

A sweep is subjects × connectors. Thirty subjects is over a hundred requests
to public services, so:

```bash
sentinel connect sweep hb6                 # the plan. Nothing runs.
sentinel connect sweep hb6 --go            # the calls, one at a time
sentinel connect sweep hb6 --go --new-only # skip subjects already captured today
```

The plan states the real call count and names any subject the library already
answered in the last 24 hours. `--new-only` skips those; without it they are
asked again, which is often what you want — re-asking is how you find out
something changed.

**Prefer `sweep` over a shell loop.** A `for s in ...; do sentinel connect ...`
loop works, but it re-runs a list you cannot re-run identically, it makes one
call per connector per subject with no plan step in front of it, and pressing
up-arrow on it an hour later silently pays for the same bytes twice. Duplicate
captures are not harmless: they both land in the library, both get counted by
`crosslink`, and a subject with two identical captures reads later like a
subject with corroboration. A single `connect` now says `repeat — asked 20
minutes ago` before it dials, for exactly that reason.

If a subject list is worth running twice, it belongs in
`modules/connectors/subjects.json` as a named set.

## Where things land

```
evidence/
├── captures/live_capture_<connector>_<query>_<stamp>.json   verbatim bytes
├── documents/                                               primary sources
├── manifests/provenance.jsonl                               the hash ledger
├── investigations/<name>/                                   watch filing
└── watch/state.json                                         the seen-set
```

Captures all live in **one** directory. `--into` tags a capture with an
investigation; it does not move it, because `crosslink`, `brief`, `lobby` and
`graph` all read one directory and filing by folder would hide captures from
the tools that read them back.

The whole of `evidence/` is gitignored, and CI fails the build if anything
under it becomes tracked. That is case material, not source.

## Checking the library has not been edited

```bash
sentinel prov verify evidence/manifests/provenance.jsonl
sentinel prov ingest evidence/manifests/provenance.jsonl
```

Every capture is hashed at the moment it arrives, before anything is derived
from the bytes. `verify` re-hashes and compares. A capture whose bytes no
longer match its ledger line is not a corrupted file — it is a file that
cannot be cited.

---

# 2 · The standing watch

The same questions, asked on a schedule, reporting only what changed.

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
