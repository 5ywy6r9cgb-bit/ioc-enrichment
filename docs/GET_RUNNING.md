# Getting Sentinel OS running on your Mac

Written to be typed, in order, with nothing skipped and nothing assumed.

The short version: **two of the three desks need nothing but Node and Python,
both of which your Mac may already have.** You can be doing real records work
in about five minutes. Postgres is only required for the database-backed
features, and you can add it later without redoing anything.

---

## Step 0 — Get the code onto your Mac

This is the one step that is currently blocked, and it is not blocked by
anything you did wrong.

Pushing to GitHub fails with:

> Claude doesn't have GitHub access to `5ywy6r9cgb-bit/ioc-enrichment` for your
> organization.

The Claude GitHub App is not installed on your account, so the session has no
write path to the repo. Fix it either way:

- Install the app and grant it `ioc-enrichment`:
  <https://github.com/apps/claude/installations/select_target>
- Or reconnect GitHub: claude.ai → Settings → Connectors → GitHub

Then, on your Mac:

```bash
cd ~
git clone https://github.com/5ywy6r9cgb-bit/ioc-enrichment.git sentinel
cd sentinel
git checkout claude/atlasos-public-records-3yhj5h
```

**If you would rather not wait on GitHub**, ask for a bundle. `git bundle`
writes the whole branch to a single file; you clone from that file and end up
with identical history and no remote involved.

---

## Step 1 — Check what you already have

```bash
node --version      # want v18 or newer
python3 --version   # want 3.9 or newer
```

macOS ships `python3`. If `node` is missing:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
```

Then:

```bash
cd ~/sentinel
bin/sentinel status
bin/sentinel test
```

`test` should end with **All present suites passed.** If it does, the system
is working on your machine. That is the whole verification.

---

## Step 2 — The records desk (no database, works right now)

This is the FOIA tracker. It runs against a local file at
`evidence/foia_requests.json`, which is gitignored and mode 600 — it never
leaves your Mac.

**Record a request you have already filed:**

```bash
bin/sentinel pra foia add PRR-2026-391 "City of Gahanna" \
    --on 2026-06-23 --via certified_mail \
    --about "Contract award file, Jan-Jun 2026"
```

`--via` matters more than it looks. Only `hand_delivery`, `certified_mail`,
and `electronic` satisfy the R.C. 149.43(C)(2) transmission predicate, and you
cannot reconstruct that fact six months later. Record it when you file.

**See what needs you:**

```bash
bin/sentinel pra foia
```

**Draft the follow-up, read it, then send it yourself:**

```bash
bin/sentinel pra foia draft PRR-2026-391
bin/sentinel pra foia sent  PRR-2026-391 --via email --note "status enquiry"
```

That last command is the one people skip. Logging an outbound letter is how
the desk knows to stop proposing the same letter tomorrow. Skip it and the
tracker nags you into sending three letters in a week, which reads as
harassment rather than diligence.

**Everything else:**

```bash
bin/sentinel pra foia --all                 # including the quiet ones
bin/sentinel pra foia history PRR-2026-391  # every letter and field change
bin/sentinel pra foia heard PRR-2026-391 --note "acknowledged, no records yet"
bin/sentinel pra foia set  PRR-2026-391 status denied
bin/sentinel pra foia set  PRR-2026-391 denial_basis "R.C. 149.43(A)(1)(h)"
```

A note on damages, because the old Python agent got this wrong and it reached
drafted letters: statutory damages under R.C. 149.43(C)(2) require a filed
mandamus action and accrue **from the mandamus filing date**, not from the
date of your request. Until you record one, the desk reports nothing accrued
and says why. If you do file:

```bash
bin/sentinel pra foia mandamus PRR-2026-391 2026-09-15
```

---

## Step 3 — The case desk (also no database)

A request gets you a document. A case is the claim that document supports.
The case desk decides whether a case can be published, and it is deliberately
not overridable — there is no `--force`.

```bash
bin/sentinel case new GAHANNA-2026 "Contract award timeline vs. council minutes"
bin/sentinel case add GAHANNA-2026 EX-1 gahanna_award.pdf --kind financial --pages 44
bin/sentinel case add GAHANNA-2026 EX-2 council_minutes_0612.pdf --kind record --pages 8
bin/sentinel case read GAHANNA-2026 EX-1 43
bin/sentinel case conflict GAHANNA-2026 "Filing says \$2.1M, minutes say \$1.4M"
bin/sentinel case status GAHANNA-2026
```

```
  GAHANNA-2026  Contract award timeline vs. council minutes
  BLOCKED  82.7% read (43/52 pages, 2 exhibit(s))

    R-01  unread financial exhibit: EX-1
    R-04  1 open contradiction(s)
    --    unread: EX-2
```

Four rules, each one there because of the failure it prevents:

| | Rule | Why |
|---|---|---|
| **R-01** | every financial exhibit read to the last page | the number that ruins a story is on page 40 of 44 |
| **R-02** | no exhibit marked broken | a dead link cannot support a claim |
| **R-03** | no open questions | an open question is a hole you already know about |
| **R-04** | no open contradictions | two sources disagreeing is the best predictor a published claim is wrong |

Clear them and the gate opens:

```bash
bin/sentinel case read     GAHANNA-2026 EX-1 44
bin/sentinel case read     GAHANNA-2026 EX-2 8
bin/sentinel case resolve  GAHANNA-2026 X-1 "Minutes were a draft; the filing controls"
bin/sentinel case status   GAHANNA-2026
```

The gate says you have read everything you have. It does not say the story is
right. Nothing can say that.

**The dashboard over all of it:**

```bash
bin/sentinel dash
```

Writes one self-contained HTML file and opens it. No port, no process, nothing
to forget to start. Re-run it whenever the cases change.

---

## Step 4 — Postgres (only when you want the database features)

Everything above works without this. Add it when you want the daily brief,
the seed data, the local service, or the phone app.

1. Download Postgres.app from <https://postgresapp.com>, drag to Applications,
   open it, click **Initialize**.
2. Put `psql` on your PATH, once:

   ```bash
   sudo mkdir -p /etc/paths.d && \
   echo /Applications/Postgres.app/Contents/Versions/latest/bin \
     | sudo tee /etc/paths.d/postgresapp
   ```

3. Close and reopen Terminal, then:

   ```bash
   bin/sentinel pra setup
   ```

That script is safe to re-run. It creates the database and a least-privilege
role, applies the migrations inside transactions, loads the seed data, and
verifies the result. It touches nothing on the network.

Then:

```bash
bin/sentinel pra brief      # the daily brief
bin/sentinel pra backup     # before you do anything risky
```

---

## Step 5 — Connectors and the overnight run (needs keys and network)

```bash
bin/sentinel connect test
```

Prints which connector keys are set and which hosts answer. Keys go in
`modules/pra/.env`, which is gitignored. Free ones worth having first:
OpenSanctions, CourtListener, FEC.

Once keys are in:

```bash
bin/sentinel watch status
bin/sentinel watch run --all     # run every saved search once, by hand
bin/sentinel watch install       # schedule the nightly run via launchd
```

The overnight run does two things. It runs your saved searches, and it runs the
records desk — the clocks on every request you have filed. The desk stage runs
first and unconditionally: it reads a local file and does arithmetic on dates,
so it cannot fail because a connector is down.

Each morning it writes:

```
evidence/watch/MORNING_BRIEF.md
```

That is the file to read with coffee. It names the agency, the rung, the exact
draft command, and the deadline basis for each request. It is overwritten each
run, because it answers "what needs me now" — the history lives in the request
store.

The notification is a doorbell, not a delivery. It carries counts and request
IDs and never an agency name, because a notification crosses a lock screen and
a third party's servers. Open the brief to see what arrived.

If the store is corrupt, the stage fails LOUDLY and the brief says "No clocks
were checked this morning." A quiet morning you did not verify is the one
failure that would actually cost you something.

`install` uses launchd rather than cron because launchd catches up a job whose
window was missed while the Mac was asleep, and a laptop is asleep at 3am.

---

## What is not done yet

Stated plainly so you are not surprised:

- **Connector hosts were unreachable from the build sandbox**, so no connector
  has been proven against live data. That was a network policy, not the code —
  see `docs/CONNECTOR_STATUS_REPORT_2026-08-20.md`. This is the only gap left,
  and it is the one that needs your API keys and your machine to close.

Everything else on this list is now done: the records desk runs overnight and
writes `evidence/watch/MORNING_BRIEF.md`, `foia --db` works against live
Postgres, and the Python desk (`bin/sentinel sdesk`) imports and passes 53
checks.

---

## Where your data lives

Everything sensitive is under `evidence/`, which is gitignored in full:

```
evidence/foia_requests.json      your records requests + correspondence log
evidence/sentinel_cases/*.json   your case files
evidence/sentinel_dashboard.html the generated dashboard
evidence/watch/MORNING_BRIEF.md  what needs you today
~/SentinelDesk/                  the Python desk: claims, vault, audit chain
```

All written mode 600 — your user only. `modules/pra/.env` holds your API keys
and is gitignored separately. **Back up `evidence/` yourself.** Nothing in the
system copies it anywhere, which is the point, and also means nothing will
save you if the disk dies.
