# ONE PROGRAM
**How the separate parts become one thing you run without AI, on almost no
money, and keep. 2026-09-15.**

---

## FIRST: IT IS ALREADY ONE PROGRAM, AND THE AI WAS NEVER DOING THE WORK

This is the thing worth knowing before you spend a day rebuilding anything.

**Every piece of analysis in this repository is deterministic code.** The
connectors, the name matching, the denominators, the nexus bridges, the edge
table, the evidence cards, the publication gate — all of it is plain Node and
Python, reading files and applying rules that are written down in the open. It
runs with the network off. It runs in ten years. It runs after you stop paying
anyone for anything, including us.

**What the AI actually did, day to day, was decide what to look at next.**
That is one job, not a hundred, and it is now a command:

```bash
bin/sentinel today
```

No model. No network. No key. It reads the evidence store, the ledger, the
claim database and the subject sets, and prints what needs you **in the order
a one-person newsroom actually loses things**:

| 1 | **BACKUP** | evidence you no longer have is not evidence |
| 2 | **CLOCKS** | a records-request deadline is the only thing here a statute cares about |
| 3 | **SECURITY** | a credential in the open, and anything about to ship that describes the machine |
| 4 | **PUBLISH** | what is blocked, and what is ready |
| 5 | **GAPS** | what has never been asked |
| 6 | **NEXT** | *one* thing |

**It sorts by what is LOSABLE, not by what is interesting.** A dashboard that
shows you the graph every morning will let the records clock run out.

---

## 0. YOUR CHECKOUT IS BEHIND — THAT IS THE WHOLE ERROR

```
unknown connector: coverage
unknown connector: explain
```

Those shipped after your last pull. `nexus --gaps` worked because you pulled
before *that* commit and not since.

```bash
cd ~/sentinel && git pull
bin/sentinel connect coverage
bin/sentinel connect explain "MINDSET ADVOCACY"
bin/sentinel connect challenge "MINDSET ADVOCACY"
bin/sentinel connect edges --out edges.csv
bin/sentinel today
```

**`bin/sentinel investigate` was never built.** It was in a proposal, and
building it would have meant one command that fans out and tells you what it
all means. `explain` and `challenge` are what that became instead — one says
what the desk knows, the other argues against it, and you do the meaning.

---

## 1. THE ACTUAL FRAGMENTATION IS ONE DEPENDENCY

It is not six modules. It is **four state stores, three of which are already
files.**

| connectors | JSON captures + a JSONL ledger | **files** |
| sdesk | `~/SentinelDesk/sentinel.db` | **SQLite** |
| openmontage | episode specs, assets, builds | **files** |
| **pra** | **PostgreSQL** | ← *this one* |

**Postgres is the only thing standing between you and "copy one folder = full
backup."** It needs a server process, a user, a password, migrations, and a
version that has to keep matching. For a one-person operation that is a
permanent tax with no return.

**Move `pra` to SQLite.** Everything else is already there. Then:

- the entire system is **one directory**
- backup is **copying a folder**
- there is no daemon, no port, nothing listening
- it runs on a laptop with the wifi off

That is the single highest-value engineering change left, and it is the one
that makes the rest of this document possible.

---

## 2. DO NOT PUT IT ON A SERVER. NOT YET.

You asked about loading the databases onto a server. **I would not, and the
reason is not cost.**

A VPS is a machine with a public IP that you are now responsible for patching,
firewalling, backing up and monitoring — forever, alone, for free. It is
**strictly more attack surface and strictly more work** than the alternative,
and it buys you nothing you need yet, because there is one user and that user
is you.

### What to do instead, and it is cheaper

```
  LAPTOP                    the working copy. Everything runs here.
     │
     ├── EXTERNAL DRIVE     encrypted, plugged in weekly, then UNPLUGGED
     │                      (sentinel shelf already tracks drives by identity)
     │
     └── OFFSITE COPY       a second encrypted drive at a different address,
                            or an encrypted archive in cheap cloud storage
```

**Three copies. Two media. One offsite.** That is the whole rule, it is what
archivists have used for decades, and it costs the price of two drives.

**Encrypt both drives at the OS level** — FileVault on the Mac, and the
external in Disk Utility as APFS (Encrypted). A stolen unencrypted drive with
an evidence store on it is the actual worst case here, not a hacker.

You already have the tool for the tracking half:

```bash
bin/sentinel shelf add archive /Volumes/SENTINEL
bin/sentinel shelf check
```

### When a server IS right

Put it on a server when **a second person needs to read it at the same time as
you**. Not before. That is the only requirement a server meets that a folder
does not, and until you have a collaborator you are paying in time for a
feature you cannot use.

---

## 3. THE THREAT MODEL, HONESTLY

Security advice is useless without naming what you are defending against. For
accountability journalism run by one person, ranked by how likely it is to
actually happen:

| **1. You lose the evidence.** | Drive failure, theft, a bad `rm`. **By far the most likely thing on this list**, and the only one that is unrecoverable. → three copies, two media, one offsite. |
| **2. You publish something wrong.** | Second most likely and the most damaging to the mission. → `sdesk`, the denominators, `challenge`, and the controls you publish either way. This is a *security* problem, not just an editorial one, because a retraction is what ends the project. |
| **3. You leak your own backend or a source.** | → `bin/sentinel redact --check` before anything ships. Exits 3 on a leak. |
| **4. Your accounts get taken.** | Email and GitHub are the keys to everything. → **hardware key or app-based 2FA on both, today.** Not SMS. |
| **5. Someone targets the machine.** | Real but *last*, because there is one user, nothing listening on a port, and no public service. Keep it that way and this stays last. |

**Notice that the top two are not technical.** The work you have already done
— the denominators, the assertion grades, `challenge` — is *security work*
against the second-most-likely failure, and it is the part most people skip.

### The one open item, and it is real

**The FEC key is in the provenance ledger in cleartext.** That ledger is the
file you would hand to a lawyer. **Rotate the key, then verify the chain.**
`bin/sentinel today` now checks for this every morning and will keep saying so
until it is done.

---

## 4. WHAT "RUNS WITHOUT AI" ACTUALLY REQUIRES

Four things, and you have three.

| ✅ | **Deterministic analysis** | every command in this repo, already |
| ✅ | **A routine** | `bin/sentinel today` |
| ✅ | **A gate that refuses** | `sdesk` blocks an uncited claim; `redact` exits 3 |
| ⬜ | **Vendored dependencies** | ← the one gap |

**The gap:** if `npm install` or `pip install` stops resolving in five years,
or you are offline, some of this stops. Fix it once:

```bash
cd ~/sentinel
npm ci --omit=dev          # then COMMIT node_modules, or keep a tarball of it
pip download -r requirements.txt -d vendor/wheels   # if any python deps appear
```

Then write down, in the repo, the exact versions of `node`, `python3` and
`ffmpeg` that worked. **A system that needs the internet to start is not a
system you own.**

---

## 5. THE BUSINESS ANSWER, FOR SOMEONE WITH TIME AND NOT MONEY

You have the two things that are actually scarce: **time, and a reason.** What
you do not have is the thing that is easy to get later. So spend the time on
what compounds and refuse to spend money on what does not.

### Spend nothing on

Hosting, a custom domain pipeline, a design tool subscription, AI image
generation, analytics, a logo. **None of those produce a single sentence that
survives scrutiny**, and every one of them is a recurring bill against zero
revenue. The cards render locally for free. The videos render locally for
free.

### Spend time on

1. **The FOIA clock.** Requests are free, they take months, and they are the
   only thing that produces evidence *nobody else has*. Everything else in
   this toolkit reads registers anyone could read. **A records request you
   sent in March is a story in July that has no competition.** This is your
   single biggest advantage over better-funded outlets and it costs postage.

2. **One register nobody else reads.** You already know which — the Licking
   and Franklin County parcel records. Free, online, ungranted, and still not
   pulled. Whoever reads the boring register first owns the story.

3. **The corrections record.** Publish your killed claims. `sdesk` has a
   `DEAD` tier for exactly this. **Being the outlet that publishes what it got
   wrong is a moat that money cannot buy and that a competitor cannot copy
   without the same discipline.**

### What makes this a business rather than a hobby

Not scale. **Reliability.** One piece a week that is right, sourced, and
carries its own limitations will outperform five a week that are merely
interesting — and it is the only model a single person can actually sustain
for years without burning out or cutting a corner.

**And when you do bring someone on:** the repository IS the onboarding. The
comments in this codebase explain every defect and why the guard exists. A
collaborator reads `docs/MAKE_ONE_VIDEO.md` and `docs/THREE_INVESTIGATIONS.md`
and can run the desk the same way you do. That is worth more than any
documentation you would write later, and it is already done.

---

## 6. THE ORDER, IF YOU DO SIX THINGS

```bash
# 1  catch up — four verbs shipped after your last pull
cd ~/sentinel && git pull && bin/sentinel today

# 2  back up the evidence store to an encrypted external drive, then:
touch "$SENTINEL_EVIDENCE_DIR/.last_backup"

# 3  rotate the FEC key, then verify the chain
bin/sentinel prov verify "$SENTINEL_EVIDENCE_DIR/manifests/provenance.jsonl"

# 4  2FA on email and GitHub. Hardware key or app, not SMS.

# 5  stand up the claim layer — it has never been used
bin/sentinel sdesk doctor && ./scripts/desk_bootstrap.sh

# 6  send two records requests. They are free and they take months.
bin/sentinel pra foia
```

Then the engineering, in this order: **pra to SQLite** · vendor the
dependencies · a FARA connector · the county parcel records.

---

## ON WHY YOU ARE DOING THIS

You said a false accusation left you distrusting a system that never
acknowledged it, and that you want to make it right for people in the same
position. I am not going to tell you how to feel about that, and I am not
going to give you advice about your own case.

But there is something worth saying about the method, because it is not a
coincidence.

**A false accusation is a claim with no denominator and no control.** It is
asserted, it is not tested against the base rate, nobody runs the check that
would falsify it, and when it collapses nobody publishes the correction. That
is the exact failure this desk has been built, defect by defect, to refuse.

Every guard in this repository is the opposite of what happened to you:

- **a claim must carry a citation or it is blocked** — no assertion without a document
- **a number must carry its denominator** — no figure without what it is a figure OF
- **the control is published either way** — including when it clears the subject
- **a killed claim is kept, not deleted** — the correction is part of the record
- **`challenge` runs last, and argues against you** — because the person most likely to fool you is you

You are not building a tool that accuses better. **You are building one that
refuses to accuse without a document, and that publishes it when the document
says no.** That is a genuinely rare thing, and it is worth more to the people
you are trying to help than any exposé, because it is the standard they were
denied.

That standard is also the only durable protection you have. An outlet that
never overreaches cannot be dismissed, and cannot be sued into silence.

**Documents first. Connections second. Conclusions last.**
