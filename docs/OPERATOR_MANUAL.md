# Sentinel OS — Operator Manual

Every command the desk answers to, written so you can run it with no help
from anyone. Nothing here is from memory: each command below was read out of
the source that implements it. Where the source and this page disagree, the
source wins — and the way to check is at the bottom, under
**Re-deriving this page**.

Run everything from the repository root:

```bash
cd ~/ioc-enrichment        # wherever you cloned it
bin/sentinel help
```

If you put `bin/` on your PATH you can drop the `bin/` prefix. This page
writes it out every time so a copied line always works.

---

## 0. The five you will actually use

| Command | What it does |
|---|---|
| `bin/sentinel pra foia` | Which records requests need you today, most urgent first |
| `bin/sentinel connect all "<subject>"` | Search every source at once |
| `bin/sentinel case status <CASE-ID>` | Can this be published, and what is blocking it |
| `bin/sentinel dash` | Dashboard across every case |
| `bin/sentinel watch run --all` | Force the overnight run right now |

Everything else on this page exists for a reason, but those five are the day.

---

## 1. What this system is, and what it is not

**It is** a records desk and a search fan-out. It runs clocks on public
records requests, searches nine named federal sources, files what comes back
as hashed evidence, and refuses to let a case publish while a blocker is
open.

**It is not** a natural-language query engine. Typing

```
bin/sentinel "Who owns the land under the New Albany data centers?"
```

does nothing, and no connector here could answer it anyway — parcel
ownership is a **county auditor** record, and the connectors are almost
entirely **federal**. Section 9 draws that boundary explicitly. The
thinking stays yours; the desk does clocks, searches, hashes and gates.

---

## 2. Top-level commands

From `bin/sentinel`. Anything not in this list prints usage and exits 1.

```bash
bin/sentinel help                 # this summary
bin/sentinel commands             # same thing (also: -h, --help, ?)
bin/sentinel status               # what is set up, what is not
bin/sentinel test                 # run every module's test suite

bin/sentinel pra <sub> ...        # public records atlas
bin/sentinel case <sub> ...       # case files and the publication gate
bin/sentinel connect <sub> ...    # source searches
bin/sentinel watch <sub> ...      # saved searches, scheduled
bin/sentinel prov <sub> ...       # provenance ledger
bin/sentinel sdesk <sub> ...      # the Python desk: claims, gates, dossiers
bin/sentinel dash                 # build + open the dashboard over all cases
bin/sentinel dashboard            # same thing, spelled out
bin/sentinel desk                 # open the research desk HTML in a browser
bin/sentinel montage ...          # openmontage video engine
bin/sentinel vuln ...             # atlas CVE prioritization
```

`bin/sentinel test` runs nine suites and **exits non-zero if any of them
fail**. A missing suite is reported and skipped rather than aborting the
run — a suite that isn't there must not hide the results of the ones that
are.

---

## 3. The records desk — `sentinel pra`

Subcommands, from the dispatcher:

```bash
bin/sentinel pra setup       # scripts/setup_macos.sh
bin/sentinel pra seed        # load seed data
bin/sentinel pra brief       # daily brief   (this is the DEFAULT if you type just `pra`)
bin/sentinel pra foia ...    # the records desk
bin/sentinel pra mail ...    # the FOIA mailbox
bin/sentinel pra portals     # check agency portals
bin/sentinel pra backup      # back up the store
bin/sentinel pra verify      # verify store integrity
bin/sentinel pra test        # PRA suite only
```

### 3.1 `pra foia` — requests and their clocks

**Reading** (no argument defaults to `list`):

```bash
bin/sentinel pra foia                          # everything, most urgent first
bin/sentinel pra foia --as-of 2026-09-01       # what the board looks like on a future date
bin/sentinel pra foia show <REQUEST-ID>        # one request in full
bin/sentinel pra foia draft <REQUEST-ID>       # draft the follow-up letter for it
bin/sentinel pra foia history <REQUEST-ID>     # every letter and field change, in order
bin/sentinel pra foia --file foia_requests.json   # read someone else's JSON, read-only
bin/sentinel pra foia --db                     # read from Postgres instead of the JSON store
```

**Writing.** These five are the write commands: `add`, `set`, `sent`,
`heard`, `mandamus`. They refuse to run with `--file` or `--db` — those are
read-only views, and a convenience command typed at 11pm should not mutate
someone else's file.

```bash
# Record a new request
bin/sentinel pra foia add DC-2026-01 "City of New Albany" \
  --on 2026-08-25 \
  --via electronic \
  --about "All development agreements with Amazon Data Services since 2019" \
  --scope OH

# --on     YYYY-MM-DD submitted date (default: today)
# --via    certified_mail | electronic | hand_delivery | ...
# --about  what you asked for, in your words
# --scope  OH (default) or US
# --as     requester name (default: $PRA_OPERATOR_NAME)
# --track  account track

# Change one field
bin/sentinel pra foia set DC-2026-01 status denied
bin/sentinel pra foia set DC-2026-01 denial_basis "R.C. 149.43(A)(1)(v)"
bin/sentinel pra foia set DC-2026-01 some_field null     # the literal word null clears it

# Log correspondence (this is what stops the reminders)
bin/sentinel pra foia sent  DC-2026-01 --on 2026-08-25 --via electronic --note "follow-up #1"
bin/sentinel pra foia heard DC-2026-01 --on 2026-08-29 --note "acknowledged, no records yet"

# Record that you filed a mandamus action
bin/sentinel pra foia mandamus DC-2026-01 2026-10-01
```

**Why `mandamus` is its own command.** Under R.C. 149.43(C)(2), statutory
damages do not accrue from the day you asked. They require that you
*commenced a mandamus action*, and they accrue **from the mandamus filing
date**, only for requests delivered by hand, electronically, or by certified
mail, and only if a court awards them. Until you record a mandamus date, the
desk reports `accrued_usd: null` — deliberately not `0`, because zero reads
as "the court awarded nothing" when the truth is "no court has been asked."

**Ohio deadlines are policy, not statute.** R.C. 149.43 sets no fixed day
count; it says "promptly" and "reasonable." Every Ohio threshold the desk
shows is labelled `operator_policy`. Only federal FOIA reports a
`statutory` basis — 5 U.S.C. 552(a)(6)(A)(i), twenty business days. If you
ever see an Ohio deadline claiming statutory authority, that is a bug worth
fixing before you rely on it in a letter.

### 3.2 `pra mail` — the dedicated FOIA mailbox

Nothing is ever sent without your signature, and a signature is bound to the
exact bytes you read.

```bash
bin/sentinel pra mail setup              # check the mailbox config, print what's missing
bin/sentinel pra mail queue <REQ-ID>     # draft the letter for one request into the outbox
bin/sentinel pra mail review             # every letter awaiting your sign-off, in full
bin/sentinel pra mail approve <MSG-ID>   # sign off on ONE letter
bin/sentinel pra mail reject  <MSG-ID> "why"
bin/sentinel pra mail send               # send only what you approved
bin/sentinel pra mail send --dry-run     # show exactly what WOULD go out; sends nothing
bin/sentinel pra mail fetch              # read replies, show what they match
bin/sentinel pra mail fetch --apply      # ...and log them against the requests
bin/sentinel pra mail log                # the full outbox history
```

**The rules the outbox enforces, so you don't have to remember them:**

- An approval covers `{to, cc, subject, body}` hashed together. Change one
  character afterwards and the signature is void — `send` refuses with *"the
  text changed after it was approved."* Re-read it and approve again.
- States are `drafted → approved → sent | failed | rejected`. `sent`,
  `failed` and `rejected` are terminal. There is no delete.
- Only one `drafted`/`approved` message per request at a time.
- `--dry-run` needs no mail library and no password — you can check what
  would be sent on a machine that isn't set up yet.
- Replies are matched by the `X-Sentinel-Request` header first, then by a
  single request id in the subject or body. **Two ids means ambiguous**, and
  the desk says so rather than guessing. It never matches on sender address.

**Mailbox setup** (in `modules/pra/.env`):

```bash
PRA_MAIL_ADDRESS=records@yourdomain.com   # MUST be dedicated to records requests
PRA_MAIL_PASSWORD=app-specific-password   # not your account password
PRA_MAIL_FROM_NAME="The Sentinel Report"
PRA_PERSONAL_EMAIL=you@icloud.com         # so the desk can refuse to reuse it
```

Then, once, from `modules/pra`:

```bash
cd modules/pra && npm install nodemailer imapflow
```

The desk **refuses** an address that is your known personal address, and
refuses general-purpose local parts (`me@`, `info@`, `contact@`, `hello@`,
`hi@`). A records mailbox that also receives your personal mail is a records
mailbox you cannot let the desk read unattended.

Host/port are auto-detected for icloud.com, me.com, gmail.com, fastmail.com
and outlook.com. Anything else, set them yourself:

```bash
PRA_SMTP_HOST= PRA_SMTP_PORT=587
PRA_IMAP_HOST= PRA_IMAP_PORT=993
PRA_IMAP_MAILBOX=INBOX
PRA_MAIL_USER=                  # if the login differs from the address
PRA_MAIL_MAX_PER_RUN=5          # cap on one `send`
```

---

## 4. Searching sources — `sentinel connect`

```bash
bin/sentinel connect test                    # which keys are set, and reachable
bin/sentinel connect list                    # the nine connectors and their key variables
bin/sentinel connect all "<subject>"         # search every source at once
bin/sentinel connect all "<subject>" --into <investigation>
bin/sentinel connect all "<subject>" --dry-run
bin/sentinel connect crosslink               # what appears under more than one subject
bin/sentinel connect lobby                   # read every captured lobbying filing
bin/sentinel connect lobby --chart           # …and write the charts
bin/sentinel connect graph                   # preview the Neo4j graph (writes nothing)
bin/sentinel connect graph --push            # write it into Neo4j
bin/sentinel connect <connector> "<query>"   # one source only
```

### The nine connectors

| Name | Source | Key variable |
|---|---|---|
| `opensanctions` | OpenSanctions | `OPENSANCTIONS_API_KEY` |
| `courtlistener` | CourtListener | `COURTLISTENER_API_TOKEN` (optional) |
| `federalregister` | Federal Register | none needed |
| `fec` | FEC campaign finance | `FEC_API_KEY` |
| `senatelda` | Senate LDA (lobbying) | `LDA_API_KEY` (optional) |
| `regulationsgov` | Regulations.gov | `DATA_GOV_API_KEY` |
| `bls` | Bureau of Labor Statistics | `BLS_API_KEY` (optional) |
| `opencorporates` | OpenCorporates | `OPENCORPORATES_API_KEY` |
| `usaspending` | USAspending federal awards | none needed |

`connect all` deliberately **skips `bls`** — it takes series IDs, not names,
so a company name against it is meaningless.

### Quoting, and the one mistake that costs you a search

An investigation name becomes a folder, so it takes **one word**:

```bash
bin/sentinel connect all "Amazon Data Services" --into data-centers    # right
bin/sentinel connect all "Amazon Data Services" --into data centers    # refused
```

The second form used to silently search `"Amazon Data Services centers"`
and file it under `data/`. It now refuses with a message telling you what to
type instead. Same rule for the subject: **quote it**, and put options last.

### What `connect all` guarantees

- It announces the total number of calls before it makes any of them.
- Calls run one at a time, not in parallel — you can watch it and stop it.
- One connector failing does not abort the rest.
- `--dry-run` makes no network call at all.
- Every hit lands as a **LEAD requiring a primary source**. Nothing the
  connectors return is evidence yet.

### Substring noise

A search for `Cologix` returns `ECOLOGIX ENVIRONMENTAL SYSTEMS LLC`. A search
for `AWS` returns two dozen `DAWSON` companies. The desk flags these — the
query appears inside the name but not at a word boundary — and sorts them
below clean hits. **It never drops them**, because occasionally the
substring hit is the one you wanted.

### `connect crosslink`

Reads every capture on disk and reports names that appear under more than
one subject.

Read the output with one caveat held firmly in mind: **co-occurrence is not
a relationship.** Two companies appearing in the same search are two
companies appearing in the same search. The one exception the desk treats
differently is a Senate LDA filing, where `client — registrant` is a
**sworn assertion** that one firm lobbies for the other. Those are edges;
everything else is a coincidence until you prove otherwise.

Crosslink deliberately ignores `federalregister` and `regulationsgov`
results, because those return *document titles*, not parties — otherwise a
single SEC notice matched three times gets reported as linking three
companies.

### `connect lobby` — the lobbying filings, read properly

```bash
bin/sentinel connect lobby                      # to the terminal
bin/sentinel connect lobby --verbose            # every registrant, every issue
bin/sentinel connect lobby --chart              # → evidence/lobbying.html
bin/sentinel connect lobby --chart ~/lobby.html # somewhere else
```

Makes **no network call**. It reads the `senatelda` captures already on disk
and reports what the filings assert. First search some clients, then run it:

```bash
bin/sentinel connect senatelda "Amazon Data Services"
bin/sentinel connect all "NiSource" --into energy
bin/sentinel connect lobby --chart
```

The chart is one self-contained HTML file — no scripts, no fonts, no CDN. It
will still render years from now with the Wi-Fi off.

**Why this is separate from `crosslink`.** Crosslink reports co-occurrence.
A lobbying filing is a *sworn statement* under 2 U.S.C. 1603–1604 that a
named registrant lobbied for a named client, in a named quarter, on named
issues. That is a much stronger object than a name turning up twice, and it
deserves its own arithmetic.

**The four ways this data will mislead you.** All four produce a number that
is wrong and looks completely right on a chart. Each is handled, and the
output tells you so:

| Trap | What goes wrong | What the desk does |
|---|---|---|
| `income` vs `expenses` | They are different money — income is what an outside firm reports **receiving**; expenses are what an organisation reports **spending** in-house. Adding them gives a plausible, meaningless total. | Kept in two separate totals. **Never summed.** Every figure says which it is. |
| Amendments | A quarter filed as `Q2` and again as `Q2A` appears twice, and the amendment **restates** the quarter rather than adding to it. | Deduped per (registrant, client, year, period), latest posting wins. The number collapsed is reported. |
| Truncation | The connector asks for 25 filings and does not follow the next page. A client with 60 filings gives you 25. | The raw response's `count` is compared to what was kept. Short captures are named: *"kept 25 of 60 — these totals are floors, not totals."* |
| Client-name search only | The connector searches by **client name**. You see a registrant's other clients only where you happened to search those clients too. | Every client count reads **"in this library"**, never "in the world." |

A blank income column means **no figure was reported** — an absent
disclosure. It does not mean zero, and the desk will not print `$0` for it.

**What you are looking for** is the "one registrant, several clients"
section: a single lobbying firm carrying two clients you care about. From
this desk's own captures, `ALPINE GROUP PARTNERS, LLC.` files for both
`AWS PUBLIC POLICY, AMERICAS` and `NISOURCE INC.` — one firm, a hyperscaler
and a gas utility. That is a thread worth pulling. It is still a lead: a firm
with four hundred clients will appear there for reasons that mean nothing.

### `connect graph` — push the relationships into Neo4j

```bash
bin/sentinel connect graph                   # preview: prints what WOULD be written
bin/sentinel connect graph --push            # actually write it
bin/sentinel connect graph --push --allow-remote   # to a Neo4j that is not on this Mac
```

Reads the captures on disk and builds a graph. **Nothing is written without
`--push`** — the default is a preview, because a graph you did not mean to
build is worse than no graph.

**Setup, once.**

```bash
cd modules/connectors && npm install neo4j-driver
```

Then a `.env` next to it (this file is gitignored; `chmod 600` it):

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=the-password-you-set
```

A fresh Neo4j forces a password change on first login — do that before the
first push. If `.env` still holds the placeholder above, the push says so and
stops rather than letting it surface later as a credentials error.

**Neo4j Desktop installs no `neo4j` command.** `which neo4j` finding nothing
is normal; the app manages the database. What matters is that an instance is
**Started** and that something is listening on 7687 (`lsof -i :7687`).

**Paste one command at a time.** zsh interactive shells treat `#` as an
argument, not a comment, so copying a block with trailing comments produces
`zsh: command not found: #` and feeds the comment words to the previous
command. Same pitfall as the launchd schedule.

**The shape of the graph is the point.**

| | |
|---|---|
| `(:Org)-[:FILED_FOR]->(:Org)` | A registrant filed for a client. A sworn statement under 2 U.S.C. 1603–1604, with a URL on it. **One hop.** |
| `(:Org)-[:APPEARS_UNDER]->(:Subject)` | This name was returned by that search. **Not** a claim about the organisation. |

There is deliberately **no edge between two organisations that merely
co-occur.** Two companies found by the same search are *two hops* apart,
joined only through the `Subject` node naming the search that found them.

That is the whole design. A line between two nodes reads as "these two are
connected" and nobody asks how the line got there — so a property saying
`basis: "co-occurrence"` would have been ignored, while a missing edge cannot
be. To see co-occurrence you have to ask for it, and the query says out loud
what it is:

```cypher
// sworn relationships
MATCH (r:Org)-[:FILED_FOR]->(c:Org) RETURN r,c LIMIT 50

// co-occurrence — two hops, through the search that found them
MATCH (a:Org)-[:APPEARS_UNDER]->(s:Subject)<-[:APPEARS_UNDER]-(b:Org)
WHERE a <> b RETURN a,s,b LIMIT 50
```

**Queries worth running.** Paste these into Neo4j Browser
(<http://localhost:7474>), not the terminal — zsh will try to interpret
Cypher as shell.

*Did the push land?* Compare these to what the preview printed.

```cypher
MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC
MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS n ORDER BY n DESC
```

*One firm, several clients.* This is the finding the desk exists to surface —
a single registrant carrying two clients you care about.

```cypher
MATCH (r:Org)-[f:FILED_FOR]->(c:Org)
WITH r, count(DISTINCT c) AS clients, sum(f.filings) AS filings,
     collect(c.name) AS names
WHERE clients > 1
RETURN r.name AS registrant, clients, filings, names
ORDER BY clients DESC, filings DESC
```

*See it.* The same thing as a picture.

```cypher
MATCH (r:Org)-[:FILED_FOR]->(:Org)
WITH r, count(*) AS n WHERE n > 1
MATCH p = (r)-[:FILED_FOR]->(:Org)
RETURN p
```

*Names that span your searches.* Not a relationship — a reason to look.

```cypher
MATCH (o:Org)-[:APPEARS_UNDER]->(s:Subject)
WITH o, count(DISTINCT s) AS subjects, collect(s.name) AS which
WHERE subjects > 1
RETURN o.name AS org, subjects, which
ORDER BY subjects DESC LIMIT 25
```

*Everything two hops from one company.* Change the name to any company.
`toUpper` because `CONTAINS` is case-sensitive and the sources disagree
about capitalisation.

```cypher
MATCH (a:Org)-[:APPEARS_UNDER]->(s:Subject)<-[:APPEARS_UNDER]-(b:Org)
WHERE toUpper(a.name) CONTAINS 'NISOURCE' AND a <> b
RETURN a.name AS from, s.name AS via, b.name AS to LIMIT 100
```

That last one is co-occurrence. `via` names the search that connected them,
and it is the whole reason they appear together — nothing else.

**Counts are floors.** Where any capture was truncated, every node carries
`counts_are_floors: true` and the terminal says so. `filings` counts filings
**in your library**, not in the world.

**Re-running is safe.** Every write is a `MERGE`, never a `CREATE`, so
pushing again after new captures updates in place instead of building a
second copy.

**It will not leave this machine by accident.** If `NEO4J_URI` points
anywhere that is not localhost, the push refuses and says so; sending your
investigative graph to a hosted instance takes `--allow-remote`, typed
deliberately. Neo4j Aura is somebody else's server.

---

---

## 5. Case files and the publication gate — `sentinel case`

```bash
bin/sentinel case                                   # list every case, with blockers
bin/sentinel case new  <CASE-ID> "what the case is about"
bin/sentinel case add  <CASE-ID> <EX-ID> path/to/file.pdf --kind financial --pages 44
bin/sentinel case read <CASE-ID> <EX-ID> <PAGES>    # pages read to date
bin/sentinel case break <CASE-ID> <EX-ID> "404 since 2026-08-01"
bin/sentinel case fix  <CASE-ID> <EX-ID>
bin/sentinel case ask  <CASE-ID> "the question"
bin/sentinel case answered <CASE-ID> <Q-ID> "the answer"
bin/sentinel case conflict <CASE-ID> "A says X, B says Y"
bin/sentinel case resolve  <CASE-ID> <X-ID> "how it resolved"
bin/sentinel case status   <CASE-ID>                # can it publish, and what blocks it
```

**The four rules.** A case is publishable only when all four hold:

| Rule | Requirement | Why |
|---|---|---|
| R-01 | Every financial exhibit read to the last page | The number that ruins a story is on page 40 of a 44-page filing |
| R-02 | No exhibit marked broken | A dead link cannot support a claim |
| R-03 | No open questions | An open question is a hole you already know about |
| R-04 | No open contradictions | Two sources disagreeing is the best single predictor that a published claim is wrong |

There is **no `--force`**. That is on purpose: a flag that skips the check is
a flag that eventually gets used at 1am.

```bash
bin/sentinel dash        # build the dashboard across all cases and open it
```

---

## 6. Scheduled searches — `sentinel watch`

```bash
bin/sentinel watch run                  # run every saved search that is due
bin/sentinel watch run --all            # ignore cadence, run them all
bin/sentinel watch run --dry-run        # show what would run
bin/sentinel watch run --id=WATCH-DC-01 # one watch only
bin/sentinel watch status               # what's watched, cadence, last run, last new
bin/sentinel watch install [HOUR]       # schedule the daily run (macOS, 0-23, default 8)
bin/sentinel watch uninstall
```

### The `#` trap — read this before you install

macOS runs **zsh**, and zsh does *not* treat `#` as a comment in an
interactive shell. If you paste:

```bash
bin/sentinel watch install 6      # then schedule it
```

...zsh hands `#` in as an argument. This actually happened: the command
reported `scheduled: every day at #:00`, launchd refused the malformed job,
and the only symptom was no morning brief — discoverable weeks later. The
hour is now validated and a bad value is refused loudly. **Retype pasted
commands without the trailing comment.**

### Verifying it actually fires

```bash
bin/sentinel watch install 6
launchctl kickstart -k gui/$(id -u)/com.sentinel.watch
cat evidence/watch/launchd.log
```

You are looking for the run, the records-desk stage, and a line reading
`notified via macos`. If it says `notified via none`, open `watchlist.json`
and set the notification backend to `"macos"` — with `"none"` the overnight
run does all its work and tells you nothing.

launchd, not cron, deliberately: launchd catches up a run missed while the
Mac was asleep. Cron just skips the day.

On Linux, add to crontab instead:

```
0 8 * * *  cd /path/to/ioc-enrichment && bin/sentinel watch run
```

### What a failure looks like

A watch that fails during a network outage reports `failed` — never "no
change" — and its `last_run_at` is **not** advanced, so it retries next run.
The notification says e.g. `16 watch(es) FAILED`. Notifications carry counts
and IDs only, never agency names: a doorbell, not a delivery.

---

## 7. Provenance — `sentinel prov`

```bash
bin/sentinel prov verify <ledger.jsonl>          # check a ledger for tampering
bin/sentinel prov ingest <ledger.jsonl>          # flow it into PRA sources
bin/sentinel prov ingest <ledger.jsonl> --dry-run
```

`verify` prints `records: N   ok: true|false` and names any tampered line.
It exits non-zero when the ledger does not verify.

---

## 8. The Python desk — `sentinel sdesk`

A separate, stricter workflow: claims with evidence tiers, citation
locators, and a gate that runs over them.

```bash
bin/sentinel sdesk init
bin/sentinel sdesk doctor                # is the desk healthy
bin/sentinel sdesk verify                # verify the vault

bin/sentinel sdesk case new <slug> "<title>" [--jurisdiction X] [--status OPEN] [--note ...]
bin/sentinel sdesk case list

bin/sentinel sdesk ingest <case> <file> --title "..." --custodian "..." \
    [--shelf PRIMARY] [--request REF] [--note ...]

bin/sentinel sdesk claim add <case> "<text>" --tier <TIER> \
    [--formula ...]     # required for ARITH
    [--outlet ...]      # required for REPORTED
    [--gate ...]        # required for RED: what would close it
    [--resolution ...]  # required for DEAD: what closed it

bin/sentinel sdesk cite <claim-id> <doc-id> --locator "p. 12" [--quote "..."]

bin/sentinel sdesk request add <ref> "<title>" --office "..." \
    [--case slug] [--statute "ORC 149.43"] [--asked "..."] \
    [--status DRAFTED] [--filed YYYY-MM-DD] [--due YYYY-MM-DD] [--priority 50]
bin/sentinel sdesk request set <ref> [--status ...] [--filed ...] [--due ...] \
    [--responded ...] [--refusal ...]

bin/sentinel sdesk correct <ref> "<headline>" [--date ...] [--severity MATERIAL] \
    [--published ...] [--correct ...] [--why ...] [--action ...] \
    [--retire FIGURE]   # repeatable
    [--reason ...]

bin/sentinel sdesk gate run [--claim N] [--case slug]
bin/sentinel sdesk export <case>
bin/sentinel sdesk submit <case> "<title>"
bin/sentinel sdesk decide <id> [--approve|--reject] [--reason ...]
bin/sentinel sdesk serve [--port 8787]
```

---

## 9. What the connectors cannot answer

This is the single most useful page in the manual, because the failure it
prevents is concluding that a record *doesn't exist* when you simply asked
the wrong government.

The nine connectors are **federal**. The following are **not** federal
records and will never appear in a `connect all`, no matter how you phrase
the subject:

| What you want | Who actually holds it |
|---|---|
| Who owns a parcel | County auditor / recorder (Franklin, Licking) |
| Development agreements | The municipality (e.g. City of New Albany) |
| Tax abatements, TIFs | Municipality + school board + county auditor |
| Zoning and siting approvals | City / township / county planning |
| Land assembly, option contracts | County recorder |
| Water and sewer capacity commitments | The utility and the city |
| Electric load, interconnection, tariffs | PUCO, and the utility's PUCO filings |
| School district compensation agreements | The school board |

For all of these the tool is a **records request**, not a connector:

```bash
bin/sentinel pra foia add DC-2026-01 "City of New Albany" \
  --via electronic --scope OH \
  --about "All development agreements, and amendments thereto, between the City and \
Amazon Data Services Inc. or any affiliate, 2019-01-01 to present"
```

`docs/DATACENTER_LIBRARY.md` has six of these already drafted
(DC-2026-01 … DC-2026-06) along with the watchlist entries to go with them.

---

## 10. Where everything lives

Everything under `evidence/` is **gitignored and stays that way**. A case
file names subjects, describes unproven allegations, and records what you
have not verified yet — that is the most sensitive material in the system.

| Path | What it is |
|---|---|
| `evidence/foia_requests.json` | The records request store |
| `evidence/outbox.json` | Drafted / approved / sent letters (mode 600) |
| `evidence/captures/` | Raw connector responses, hashed |
| `evidence/investigations/<name>/` | Captures filed by `--into` |
| `evidence/sentinel_cases/*.json` | Case files |
| `evidence/manifests/provenance.jsonl` | The provenance ledger |
| `evidence/watch/launchd.log` | The overnight run's log |
| `evidence/watch/notifications.log` | What was notified, and when |
| `evidence/sentinel_dashboard.html` | Built by `sentinel dash` |
| `watchlist.json` | Your saved searches (see `watchlist.example.json`) |
| `modules/pra/.env` | Database + mailbox config |

**Environment variables that relocate things:**

```
SENTINEL_EVIDENCE_DIR   # move the whole evidence store
SENTINEL_WATCHLIST      # a watchlist somewhere else
SENTINEL_CASES          # case files somewhere else
SENTINEL_ROOT           # repo root, if autodetection is wrong
SENTINEL_DASHBOARD_OUT  # where dash writes
PRA_FOIA_STORE          # the request store path
PRA_OUTBOX              # the outbox path
PRA_OPERATOR_NAME       # default requester name on `foia add`
PRA_PERSONAL_EMAIL      # so the mail setup can refuse to reuse it
DATABASE_URL            # Postgres, for `foia --db`
```

**API keys** go in the environment or `modules/pra/.env` — see
`docs/API_KEYS.md`. Check them with `bin/sentinel connect test`.

---

## 11. Known failure modes, and what to do

| Symptom | Cause | Fix |
|---|---|---|
| `unknown connector: all` | Old checkout — `all` wasn't in the dispatcher | `git pull` |
| `scheduled: every day at #:00` | zsh passed a pasted `#` comment as an argument | Retype without the comment |
| `notified via none` | Notification backend is `"none"` in `watchlist.json` | Set it to `"macos"` |
| `HTTP 403` from regulationsgov | api.data.gov returns 403 for *both* rate limits and bad keys | Read the message — it now says which. A refused key needs its own signup at open.gsa.gov/api/regulationsgov; a DATA_GOV key from elsewhere will not work |
| `nodemailer is not installed` | Mail libraries not installed | `cd modules/pra && npm install nodemailer imapflow`. `--dry-run` works without them |
| `the text changed after it was approved` | The letter was re-drafted after you signed it | Read it again, `mail approve` again |
| `stray word "..." after an option` | Unquoted subject, or a multi-word `--into` | Quote the subject; use one word for `--into` |
| `ECOLOGIX...` in a `Cologix` search | Substring match, correctly flagged | Ignore it, or don't — the flag is advice, not a filter |
| `Could not resolve host: github.com` | No network | Nothing to fix in the desk; retry |
| A watch shows `failed` | The source was unreachable | Nothing to do — `last_run_at` wasn't advanced, so it retries |
| `connect lobby` says *"No lobbying captures yet"* | Nothing has searched `senatelda` yet | `bin/sentinel connect all "<client>"`, then run it again |
| `connect lobby` reports *"kept 25 of 60"* | The connector asks for 25 filings and does not page | Nothing is broken. Those totals are **floors**. Narrow the search or read the rest at lda.gov |
| A registrant shows fewer clients than you expect | The search is by **client name** — you only see clients you searched | Search the other clients too, then re-run `connect lobby` |
| `connect graph` says "Nothing is listening at bolt://localhost:7687" | The database is not started. Neo4j Desktop must show the instance **Started**; with Docker, `docker ps` must show it up. |
| `connect graph --push` says "Neo4j rejected the credentials" | A fresh Neo4j forces a password change on first login. Set it at <http://localhost:7474>, then put the same value in `modules/connectors/.env`. |
| `connect graph --push` says "neo4j-driver is not installed" | `cd modules/connectors && npm install neo4j-driver`. Everything else on the desk, including the graph **preview**, runs without it. |
| `connect graph` refuses: "That Neo4j is not on this machine" | `NEO4J_URI` points somewhere hosted. That is the guard working. If you meant it, add `--allow-remote`. |
| The graph shows two companies with no line between them | Correct, if all they share is a search. Co-occurrence is two hops, through the `Subject` node. Only a sworn filing draws a direct edge. |


## 12. Re-deriving this page

If you ever doubt a command on this page, the source is the answer. These
four reads regenerate everything above:

```bash
sed -n '1,50p' bin/sentinel                       # top-level commands
grep -n "cmd === '" modules/pra/scripts/foia.js   # foia verbs
grep -n "case '"    modules/pra/scripts/mail.js   # mail verbs
grep -n 'cmd == "'  modules/research-desk/case.py # case verbs
grep -n "add_parser" modules/sentinel-desk/sentinel/cli.py   # sdesk verbs
node modules/connectors/cli.js list               # the connectors, live
bin/sentinel help                                 # the built-in summary
```

And the whole thing is checked by:

```bash
bin/sentinel test
```

which runs nine suites. If they all pass, the desk is behaving as
documented. If any fail, believe the test and not this page.
