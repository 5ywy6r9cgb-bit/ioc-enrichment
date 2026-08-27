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
bin/sentinel doc get <url>        # fetch one primary source, hashed
bin/sentinel corpus <sub> ...     # inventory / OCR a folder of records
bin/sentinel shelf <sub> ...      # external drives, by volume identity
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
bin/sentinel connect brief "<name>"          # everything the library holds on one name
bin/sentinel doc get "<url>"                 # fetch a primary source, hashed
bin/sentinel corpus inventory <dir>          # what a records folder ACTUALLY holds
bin/sentinel corpus ocr <dir> --out <dir>    # read the bundles that only look like PDFs
bin/sentinel connect sweep                   # list the named subject sets
bin/sentinel connect sweep datacenters       # the plan, no calls
bin/sentinel connect sweep datacenters --go  # run it
bin/sentinel connect expand                  # ask every registrant you already have
bin/sentinel connect expand --limit 25
bin/sentinel connect senatelda --registrant "<firm>"   # every client a firm files for
bin/sentinel connect senatelda --registrant "<firm>" --pages 20
bin/sentinel connect graph                   # preview the Neo4j graph (writes nothing)
bin/sentinel connect graph --push            # write it into Neo4j
bin/sentinel connect graph --dashboard       # → evidence/graph-dashboard.html
bin/sentinel connect graph --dashboard --side-a "ENERGY|POWER|GAS" --side-b "AWS|META|MICROSOFT"
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

### `connect brief` — read what you captured

```bash
bin/sentinel connect brief "Alpine Group Partners"
bin/sentinel connect brief "Licking Heights"
```

Four hundred captures is not a library you can read. This pulls everything
mentioning one name out of all of them, no network call, and prints it
graded by what the source actually establishes:

| | |
|---|---|
| **Sworn lobbying filings** | A statement under 2 U.S.C. 1603–1604 that a named firm lobbied for a named client. Period, amount and issues, with the filing URL. |
| **Corporate registrations** | A filed fact about a legal entity — not proof it is the same company as anything else on the page. |
| **Court dockets** | A real case with a real caption. Read the docket before characterising it. |
| **Federal awards** | Money that moved, to a named recipient. |
| **Documents that mention the name** | The weakest thing here, and labelled as such. A document containing a string is not a fact about the entity. |

Printed in one list they would all read as "evidence". They are printed
apart because they are not the same kind of thing.

**A name match is not an identification.** `AWS PUBLIC POLICY LLC` registered
in Oklahoma answers a search for AWS and is almost certainly not Amazon.
Matches that hit only as a substring are flagged rather than dropped —
dropping silently is the worse error.

Nothing in a brief has been read. It is the shortlist of documents to go and
read, and then put in a case file.

### `connect sweep` — run a whole named subject list

```bash
bin/sentinel connect sweep                    # what sets exist
bin/sentinel connect sweep datacenters        # the plan and the exact call count
bin/sentinel connect sweep datacenters --go   # actually run it
```

The sets live in `modules/connectors/subjects.json` — `datacenters`,
`energy`, `newalbany`, `lobbying`. Edit that file as you learn names; every
abatement agreement and utility filing names the actual contracting entity,
and that name is the one worth searching. **Putting a name in the list
asserts nothing about it.** It says the name is worth asking about.

**Nothing runs without `--go`.** A sweep is subjects × connectors — a dozen
subjects is easily a hundred live calls to public services, which is not
something to set off by typing a word slightly wrong. The default prints the
plan, the subjects, the connectors that will be skipped and why, and the
exact number of calls.

That count is computed by the same rules `connect all` uses, so it is the
number of calls that will actually be made, not the number of connectors that
exist. A connector taking an identifier rather than a name (BLS) is skipped,
and so is one whose key is not set.

Then `connect crosslink` and `connect graph --push`.

### Getting the WHOLE filing history, not the first 25

The single largest limit on this library is the page size. Your own run said
so:

```
ALPINE GROUP PARTNERS LLC   kept 25 of 7346
HARBINGER STRATEGIES LLC    kept 25 of 2450
SQUIRE PATTON BOGGS         kept 25 of 23043
```

A 90-client roster drawn from 107 filings out of 7,346 is a **floor**, and
not a high one. `--registrant --pages` walks the whole history:

```bash
bin/sentinel connect senatelda --registrant "ALPINE GROUP PARTNERS, LLC." --pages 294
```

It writes a capture per page, so everything downstream — `crosslink`,
`lobby`, `draft`, `graph --push` — sees the new filings automatically. It
reports coverage honestly at the end (`PARTIAL — fetched 100 of 7346`) and
prints the exact command for full coverage rather than leaving you to work
out the page count.

**This connector is paced at 650ms.** Deep pagination is the one place a
sequential run still looks like a flood: 294 requests as fast as the socket
allows will trip a per-minute ceiling, and a revoked key costs far more than
the three minutes the pacing spends.

### `connect expand` — ask every registrant you already have

```bash
bin/sentinel connect expand --dry-run     # who it would ask, no calls
bin/sentinel connect expand               # top 10 registrants, one page each
bin/sentinel connect expand --limit 25
```

Every registrant in your library is a question you have not asked. Searching a
client tells you which firms filed for it — one hop. Those firms' **other**
clients are the second hop, and they were invisible while the connector only
asked `client_name`.

This walks the registrants you already have, most filings first, asks each one
`registrant_name`, and prints only the clients that are **not already in your
library**. Listing back the ones you searched to get here would look like a
discovery and be nothing of the kind.

The call count is announced before any call is made, and the calls are
sequential — a burst of parallel requests is how a free tier revokes a key.
One page per firm, so every client list it prints is a floor; go deeper on
anything interesting with `--registrant "<firm>" --pages N`.

Then `connect graph --push` to fold the new captures in.

### `connect senatelda --registrant` — turn the lobbying search around

```bash
bin/sentinel connect senatelda "Meta Platforms"                     # who lobbied FOR Meta
bin/sentinel connect senatelda --registrant "Harbinger Strategies"  # who Harbinger lobbies FOR
bin/sentinel connect senatelda --registrant "Harbinger Strategies" --pages 20
```

**These are different questions and they had different answers.** The ordinary
search asks `client_name`; this asks `registrant_name`. Until this existed,
every answer about a registrant was silently bounded by which *clients* had
been searched — the library reported `HARBINGER STRATEGIES, LLC` with **2
clients across 4 filings**, and the API returns **2,450 filings** for the same
firm. The 2 was never a fact about Harbinger. It was a measurement of the
search.

So: whenever the graph shows a registrant worth caring about, ask this before
concluding anything about how many clients it has.

**It pages, and it stops.** 2,450 filings is 98 requests at the API's page
size — a lot of traffic to a public service for one question. It fetches four
pages by default and then says exactly what it did:

```
PARTIAL — fetched 100 of 2450 filings (4 of 98 pages).
This client list is a FLOOR. There are almost certainly more.
```

`--pages N` goes deeper. Each page is saved as its **own** capture with its
own hash; pages are never merged into one file, because the bytes on disk
would then be something no server ever sent.

Captures land in the evidence store like any other search, so
`connect graph --push` folds them straight into Neo4j.

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

**The dashboard.** `--dashboard` writes one self-contained HTML page — no
script, no CDN, no font host, no request of any kind — from the same `build()`
the push uses, so the page and the database cannot disagree. It works with or
without `--push`.

```bash
bin/sentinel connect graph --dashboard
bin/sentinel connect graph --dashboard ~/Desktop/graph.html
bin/sentinel connect graph --push --dashboard \
  --side-a "ENERGY|POWER|ELECTRIC|GAS|UTILIT|NISOURCE|AEP|RWE" \
  --side-b "AWS|AMAZON|META|MICROSOFT|GOOGLE|DATA CENTER|COLOGIX"
```

It deliberately does **not** draw the network. With 1,500 organisations a
force-directed picture is a hairball that invites you to see structure which
is an artifact of the layout. It charts the three things the graph can
actually answer: firms carrying more than one client, which of those carry
clients matching **both** patterns you supply, and how much each search
contributed — that last one labelled as a fact about your searching rather
than about the world.

`--side-a` and `--side-b` are regular expressions and they come from you.
What counts as "both sides" is a judgement about the investigation, not a
property of lobbying data; a tool that decided it for you would smuggle an
editorial call in as arithmetic.

Where captures were truncated the page says **every number here is a floor**
at the top, in the same size as the totals. A bar chart looks complete, which
is exactly why that cannot be a footnote.

**Queries worth running.** Paste these into Neo4j Browser
(<http://localhost:7474>), not the terminal — zsh will try to interpret
Cypher as shell.

**One query at a time.** Neo4j Browser runs whatever is in the editor as a
single statement, so two queries pasted together become one malformed query.
Clear the box before each paste — if the editor still holds the `:connect`
from signing in, your paste lands on the end of it and Browser reports
`Unknown command ":connectMATCH ..."`.

*Did the push land?* Compare these to what the preview printed. Run them
separately.

```cypher
MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC
```

```cypher
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

*The one that matters for a data-center story.* Not "who shares a lobbyist"
but who shares one **across the energy/compute line** — a firm carrying both a
utility and a hyperscaler. Widen the patterns to your own subjects.

```cypher
MATCH (r:Org)-[:FILED_FOR]->(c:Org)
WITH r, collect(DISTINCT c.name) AS clients
WHERE size(clients) > 1
  AND any(x IN clients WHERE toUpper(x) =~ '.*(ENERGY|POWER|ELECTRIC|GAS|UTILIT|NISOURCE|AEP|FIRSTENERGY|DUKE).*')
  AND any(x IN clients WHERE toUpper(x) =~ '.*(AWS|AMAZON|META|MICROSOFT|GOOGLE|DATA CENTER|COLOGIX|VADATA|DIGITAL).*')
RETURN r.name AS registrant, clients
```

A match is a **lead**, and the next step is not another query. Open the
filings themselves — `filing_document_url` is on every FILED_FOR edge — and
read which issues were lobbied, in which quarters, for both clients. Same bill
in the same quarter for a utility and a hyperscaler is specific and checkable.
Non-overlapping issues means a firm with two unrelated clients, which is most
of them.

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

## 4a. What is actually in your records folder — `sentinel corpus`

```bash
bin/sentinel corpus inventory ~/sentinel/library --out ~/sentinel/inventory
bin/sentinel corpus ocr ~/sentinel/library --out ~/sentinel/library_derived --dry-run
bin/sentinel corpus ocr ~/sentinel/library --out ~/sentinel/library_derived
```

**A `.pdf` extension is a claim, not a fact.** An inventory of a real 349-file
records library found this:

| Verdict | Files |
|---|---|
| ZIP archive mislabelled as PDF | **78** |
| Not actually a PDF | **14** |
| Empty file | **3** |
| Actually a readable PDF | **0** |

All 95 files carrying a `.pdf` extension failed. Not one was a readable PDF.
The portal serving them emits ZIP bundles of page images under a PDF name,
**universally** — and `grep`, `pdftotext` and every keyword search ever run
against those files returned nothing regardless of what was inside.

**A null search result on a file in that table is not evidence of absence.**

`corpus inventory` reads every file's magic bytes, not its extension, and
writes `inventory.csv` — one row per file with real type, size, SHA-256, and
for PDFs how much text can actually be extracted. Charts are written too if
matplotlib is installed; without it you still get the CSV, which is the
dataset.

`corpus ocr` unpacks the ZIP bundles and produces searchable text. It needs
`brew install tesseract`. It is resumable — interrupt it and re-run the same
command; completed bundles are keyed on source SHA-256 and skipped.

### The output is DERIVED, and the distinction is load-bearing

Every page is tagged with where its text came from:

| | |
|---|---|
| `native` | the bundle's own text layer. Reliable. |
| `ocr` | machine-read off a page image. **Contains character errors.** |

**Never quote from OCR text.** Open the page image in `pages/` and quote what
you see. Shelve the derived output separately so a `PRIMARY_ONLY` gate does
not mistake a machine transcript for a document.

### One thing the verdict column will not say

If `pdftotext` cannot run at all, readability was never tested — and that is
not the same as a PDF with no text. Those files read
`UNKNOWN — readability never tested`, never `ok`. The reassuring word is
never the default for a check that did not happen.

---

## 4b. Getting the document itself — `sentinel doc`

```bash
bin/sentinel doc get "https://www.courtlistener.com/opinion/.../x.pdf"
bin/sentinel doc get "<url>" --case pataskala-valuation --as EX-01
```

**Every connector collects metadata ABOUT documents. None of them fetches
one.** That is why a library of hundreds of captures can sit beside a case
file with zero exhibits: the step from a link to a file you have read stayed
manual, and manual steps do not happen.

`doc get` fetches over https only, hashes the bytes **as received** before
anything is derived from them, saves the file under `evidence/documents/`
with the hash in its name, writes a provenance record, and prints the exact
`case add` line to file it as an exhibit.

**Install the extractor once:**

```bash
brew install poppler
```

That gives `pdftotext` and `pdfinfo`. Without them the document is still
fetched and hashed — only the text is missing, and the run says so.

### HTML records are extracted too

The Senate LDA serves its filings as **HTML, not PDF** — and those filings are
the strongest evidence this desk handles. They used to land under *"Not a PDF
— saved as fetched, no extraction attempted"* and sit on disk unsearchable,
which six months later reads exactly like a record that says nothing.

`doc get` now extracts HTML text, and reports the bill numbers it finds:

```
text    evidence/documents/…__print.txt  4,812 chars
Bills named in this document: H.R. 9126, S. 4207
```

Bill numbers are the reason to open a lobbying filing at all. A shared
registrant is a roster; **the same bill in two clients' filings is a
position.**

A page carrying under 400 characters is flagged rather than filed as
readable — an error page, a cookie banner and a JavaScript shell all produce
one, and filing one as a record is how "the filing does not mention that"
gets written about a filing nobody could read.

### `doc bills` — the step that turns a roster into a position

```bash
bin/sentinel doc bills
```

A shared registrant is a **roster**: one firm files for a hyperscaler and a
gas utility. That is a sworn fact about who retained whom and nothing at all
about either client's position.

The same **bill** named in two clients' filings is different. Both told
Congress, under 2 U.S.C. 1603–1604, that they lobbied on that specific
legislation. Two sworn statements about one object — not a co-occurrence.

```
H.R. 9126  — 2 clients
  AWS PUBLIC POLICY, AMERICAS  (filed by ALPINE GROUP PARTNERS, LLC.)
    …Specific lobbying issues: H.R. 9126 data center energy siting…
  ATMOS ENERGY CORPORATION  (filed by ALPINE GROUP PARTNERS, LLC.)
    …HR 9126 concerning pipeline siting…
```

**What it does not establish.** Two clients on one bill does **not** mean the
same side. A filing names the bill; it does not say for or against. Opposing
parties appear on the same bill in the same quarter routinely, and reporting
a shared bill as an alignment is the easiest way to publish something false
out of accurate records. The output says so every time.

Three things it refuses to get wrong:

- **Correlation is by client, not by file.** The same filing fetched twice,
  or a filing and its amendment, is one party. Counting files would
  manufacture a correlation out of a single sworn statement.
- **A false bill number is worse than a missed one** — it links two unrelated
  filings and reads like a finding. A bare `S.` needs two digits, because
  `S. 1` is also a signature, a section, a rule. Unambiguous forms
  (`H.Res.`, `S.J.Res.`) take one digit, since resolutions really are
  numbered that low.
- **A document naming no bill is reported, not dropped.** Silence about it
  reads as "shares nothing" when the fact may be that extraction failed.

### The failure this is built around

A scanned PDF and a text PDF have the same extension and look identical in a
viewer. Run a text extractor over the scan and it returns almost nothing —
no error, no warning. The document then sits in your library looking
extracted, matches no search ever, and every search that misses it reads as
*"the record does not mention that"*.

So extraction reports **characters per page** and says plainly when a
document is almost certainly a scan. A real page of a filing runs into the
thousands; a scan yields a handful. Three things that all look like "no
text" are kept separate:

| | |
|---|---|
| the tool is not installed | says so, and how to install it |
| the extractor errored | says so, with the error |
| the document is a scan | says so, with characters per page, and gives the `ocrmypdf` line |

For scans: `brew install ocrmypdf`, then
`ocrmypdf in.pdf out_ocr.pdf` and fetch the result back in.

**Fetching is not reading.** The gate counts pages you have marked read with
`case read`, and that is the only thing standing between a lead and a
published claim.

---

## 4c. Records that do not fit on the laptop — `sentinel shelf`

```bash
bin/sentinel shelf add N1 /Volumes/N1 --subpath records
bin/sentinel shelf add N2 /Volumes/N2 --subpath records
bin/sentinel shelf list
bin/sentinel shelf check --probe
bin/sentinel shelf where N1

bin/sentinel corpus inventory N1 N2 --out ~/sentinel/inventory
bin/sentinel corpus ocr N1 --out N2/derived
```

A **shelf** is a name for an external drive. Every command that reads a
corpus accepts a shelf name anywhere it accepts a folder path.

### Why a shelf is not just a shorter path

Because of one failure that has no local equivalent:

> **An unplugged drive is indistinguishable from an empty corpus.**

A scan of a folder that is not there finds zero files. Zero files prints
calmly, exits clean, and reads as *"no records match that."* The fact is
*"nobody looked."* Same silent-green failure as everything else on this
desk; the trigger is a USB connector instead of a bug.

So a shelf resolves to a **volume identity** — a `.sentinel-volume.json`
marker written once onto the drive — and never to a literal path. The path
is an output of resolution, never an input. That defeats four separate
things `/Volumes/N1` does wrong, all of which are ordinary macOS behaviour:

| What happens | What you would have seen |
|---|---|
| **Stale mount point.** Eject uncleanly and `/Volumes/N1` survives as an empty folder. | Every path resolves. Every scan finds nothing. |
| **Name collision.** Something already holds `/Volumes/N1`, so the real drive mounts at `/Volumes/N1 1`. | Your path still points at the stub. |
| **Label swap.** The drives get swapped in the ports. | `/Volumes/N1` is now N2's contents. Every identifier recorded is attributed to the wrong physical object, permanently and silently. |
| **A clone.** A drive and its backup are both mounted. | Nothing can tell you which one the inventory read. |

Each of these is refused by name, with the reason, and with the words
**"Nothing was read. This is NOT a result about the records."**

### Resolution is total, not per-root

`corpus inventory N1 N2` resolves **both** shelves before scanning
**either**. Scanning as it went would inventory N1, hit an unplugged N2,
and leave behind a CSV that looks like a complete two-drive inventory and
is not. Nothing is written unless everything asked for is present.

### What goes on the drives, and what does not

| On the drives | On the laptop |
|---|---|
| documents, page images, OCR output | the provenance ledger |
| anything bulk and re-derivable | inventories, case files, captures |

This is not about size. The ledger is an append-only hash chain, and a
flash drive pulled mid-write truncates the last line — which breaks
verification for **every record before it**. Small and irreplaceable stays
on the machine that is not designed to be unplugged. `shelf check` refuses
outright if `SENTINEL_EVIDENCE_DIR` points at removable media.

### `shelf check --probe`

Reports free space, filesystem, and whether the drive can tell `Exhibit_A.pdf`
from `exhibit_a.pdf`. Flash drives ship formatted exFAT, which **cannot** —
two records differing only in case become one file on copy, the second
overwrites the first, and nothing reports it. Worth knowing before 37GB
moves onto it. `--probe` writes one temporary file to find out, which is
why it is not the default.

### The inventory carries the drive with it

`inventory.csv` gained `shelf` and `volume_id` columns. Without them a
merged inventory of two drives is a list of relative paths you cannot
locate — `records/a.pdf` exists on both, and nothing says which physical
object to plug in.

### When a drive drops off mid-scan

USB drives disconnect. Power management, a marginal cable, a hub. On macOS
the mount point goes with it and every subsequent read raises
`OSError: [Errno 6] Device not configured`.

An 8,000-file scan takes minutes, so this happens *during* a run, not
before one. Three things follow:

- **A completed shelf is kept.** If N1 finished and N2 dropped, N1's rows
  are not thrown away. Re-hashing 8,000 files every time a flaky drive
  hiccups is how an inventory gets started four times and finished never.
- **The output is not called `inventory.csv`.** A truncated scan writes
  `inventory.PARTIAL.csv` plus `_INCOMPLETE.txt`, and exits **4**. The
  filename is the only label that survives into Numbers, into next month —
  and a partial read as complete turns "the drive fell off the bus" into
  "these records do not exist."
- **`--resume` continues it.** Reuses hashes from the previous run in
  `--out`, keyed on shelf + path + **size**. A file whose size changed is
  re-read, because reusing that hash would put a digest in the ledger that
  does not match the bytes on the drive.

```bash
bin/sentinel corpus inventory N1 N2 --out ~/sentinel/inventory --resume
```

An **unreadable file** and a **vanished drive** are different facts and are
never conflated. A file that cannot be read gets a row saying
`UNREADABLE — <reason>` and carries no hash; the scan continues. A drive
that has gone stops the scan for that shelf. The old code did
`except OSError: continue`, which dropped the file from the inventory
entirely — so a file the desk could not read became a file the desk had
never heard of, and the count looked clean.

### Are the two drives copies of each other?

The summary reports files that appear more than once by SHA-256, and says
how many of those exist on **more than one shelf**. Two drives with nearly
identical file counts usually means one is a copy, and a merged inventory
then double-counts the corpus. That changes what "37 GB of records" means.

### Rebinding

`shelf add` refuses to point an existing name at a different drive. Every
inventory row already recorded under that name came from the old one, and
rebinding silently makes those rows describe a drive that is no longer
what the name means. `--rebind` if you mean it.


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

## 7a. From captures to the desk — `sentinel draft`

```bash
bin/sentinel draft list
bin/sentinel draft <case-slug> --subject "Aligned Data Centers"
bin/sentinel draft <case-slug> --subject "Aligned Data Centers" --apply
```

Hundreds of captures sit in `evidence/captures/` and every claim on the desk
is typed by hand, so the collecting and the reasoning never meet. This is the
bridge.

### It writes RED and only RED

**A capture is a search result.** It is a row of metadata an API returned —
a case name, a filing period, a URL. It is not the document, nobody has read
it, and its presence means only that a keyword matched.

The tempting version of this tool writes GREEN claims with the capture's URL
as the citation. That would launder a search hit into a cited fact several
hundred at a time, and every one would look exactly like a claim somebody had
checked. So every drafted claim is **RED — an open question** — and its gate
names the record that would close it *and the command that fetches it*:

```
RED  Does Aligned Data Centers (Pataskala) PropCo LLC v. Licking Cty. Bd. of
     Revision (Ohio BTA, 2024-11-02) establish anything about Aligned Data
     Centers?
     gate: The CourtListener record itself, fetched and read —
           bin/sentinel doc get https://www.courtlistener.com/opinion/9912/...
```

Promotion out of RED takes three deliberate acts: fetch it (`doc get`),
ingest it, cite it. The desk's schema enforces this on its own — `citations`
takes a `doc_id` into `documents`, so **there is no way to cite a URL.**

A test asserts against the source that no tier other than RED can be written,
and it is drift-tested in both directions.

### Every drafted claim is marked as machine-drafted, and cannot be published

**A machine-drafted claim and a hand-entered one are indistinguishable in the
ledger about a week later.** Six months on, nobody remembers whether claim 441
came from a page somebody read or from a search result nobody opened. The
ledger outlives the memory of how each row got there, so the row carries it:

```
claim 12 recorded [RED]  [machine-drafted — nobody has read the source]
  gates: BLOCKED
    · MACHINE_UNDISPOSED: This claim was drafted by a machine from a search
      result and no person has disposed of it. Open the source, decide, then:
      sentinel claim dispose 12 --by "<your name>"
```

`MACHINE_UNDISPOSED` is the only gate that **ignores the tier.** A drafted
claim promoted to GREEN with a citation attached still fails it, because
attaching a citation says "this document is related" and disposing says "I
opened it and this sentence is mine now." Those are different acts and only
the second one is a person taking responsibility.

```bash
bin/sentinel sdesk claim list --needs-disposition   # find the ids
bin/sentinel sdesk claim dispose 12 --by "Mark Rosenburg" --note "read p.12 image"
```

`claim list` exists because `dispose` and `cite` both take a claim id and
there was previously no way to obtain one — both commands were documented and
unreachable. It takes an optional case slug, plus `--needs-disposition`,
`--blocked` and `--tier`.

**A note on placeholders in this manual.** Where a command needs a value you
supply, it is written as a bare word (`12`, `pataskala`). It is never written
in angle brackets: in zsh `<slug>` is input redirection, and pasting it gets
you `zsh: no such file or directory: slug` rather than a usage message.

The name goes in the audit chain.

**A claim from before origin tracking reads `unknown`, never `human`.**
Backfilling it as human would assert something nobody can support, and would
launder exactly the drafted claims the column exists to keep visible. Those
claims need disposing once, each.

### Dry run by default

Nothing is written without `--apply`. Filing several hundred claims into your
desk by accident is not something to find out about afterwards.

### The claim is about the record, not about the search

A first run against a real library produced these two, adjacent:

```
Does ALPINE GROUP PARTNERS' lobbying for AWS PUBLIC POLICY establish
anything about AWS?                                       — 8 records
Does ALPINE GROUP PARTNERS' lobbying for AWS PUBLIC POLICY establish
anything about AWS Public Policy?                        — 16 records
```

Same registrant, same client, same period span. **One relationship, two
claims**, differing only by which search string surfaced it — the same "one
entity is several search strings" problem this tool exists to work around,
recreated inside the desk.

The subject is now kept as provenance on the claim (`origin_note`) instead of
inside its text:

```
origin: machine
sentinel draft: senatelda capture u0 · found via subject: AWS,
  AWS Public Policy · 8 records
```

Lobbying questions ask what the filing **covered**, because a filing already
states who lobbied for whom — what it does not state, and what is worth
opening it to find, is what they lobbied *for*.

### Counts are of records, not of appearances

The same filing comes back from several searches. Counting appearances
reports a relationship as twice as well evidenced as it is:

```
2 capture file(s) → 16 row(s) → 1 distinct question(s)
    8 separate records fold into this one question
    found via: AWS · AWS Public Policy
```

Sixteen appearances, **eight** filings. Rows are deduplicated on the record's
own identity (`filing_uuid` for LDA) before anything is counted. A count that
is wrong and looks right is the failure the lobbying module was built around,
and it must not come back in through this door.

### `--match` — narrowing a roster to what you can actually read

The LDA returns a registrant's whole client roster. On a real library one
firm produced **92 questions**. Drafting all of them files 92 claims nobody
will ever dispose of — and an undisposed claim can never reach a dossier, so
the desk fills with permanently unpublishable material that looks like
progress.

`--match` filters on what the question *says*, and is repeatable:

```bash
bin/sentinel draft datacenters --connector senatelda \
  --subject "Alpine Group Partners" \
  --match RWE --match "SIEMENS ENERGY" --match ATMOS --match PRIMORIS
```

The run reports how many it kept out of how many, so the narrowing is
visible rather than silent. A `--match` that hits nothing yields nothing —
never everything.

### More filings than periods means amendments

`Q2` and `Q2A` are one quarter filed twice — an amendment **restates** a
period, it does not add one. `connect lobby` dedupes these; this path cannot,
because an amendment carries its own `filing_uuid` and is a genuinely
separate record. So the count stays honest and the shortfall is named:

```
8 separate records fold into this one question  ·  2024 Q4 – 2026 Q2
8 filings across 7 period(s) — 1 period(s) filed more than once
```

Eight filings is not eight quarters of activity, and a reader will infer
that it is unless told.

### The fold, and why it is announced

A registrant that filed seventeen quarterly reports for one client raises
**one** question, not seventeen identical ones. So drafting folds records into
questions — and says how many folded:

```
  1 capture file(s) → 7 row(s) → 2 distinct question(s)
  5 further record(s) stand behind those questions

  RED  Does ALPINE GROUP PARTNERS, LLC.'s lobbying for AWS PUBLIC POLICY,
       AMERICAS establish anything about AWS?
       6 separate records fold into this one question  ·  2024 Q1 – 2025 Q2
```

Silence here would be the failure. On a real library **79 sworn filings
collapsed into 9 questions** with nothing on screen saying 70 more stood
behind them — which reads as a thin record when it is the opposite of one.

The count is shown but **never written into the claim text.** Text must stay
deterministic: a later run with more captures behind it would otherwise
generate a different sentence for the same relationship and file it as a
second claim. Counts are derived at render time, not frozen into a claim.

### Re-running is safe

Claim text is deterministic — the same capture row always produces the same
sentence — so a re-run detects what is already on the desk by exact match and
skips it. The same record returned by two different searches is one question,
not two, and the run reports the reduction (`3 row(s) → 2 distinct question(s)`)
rather than hiding it.

### What it will not hide

- **Unparseable captures are counted**, not skipped. They stay on disk and
  hashed; nothing can be drafted from them and the run says how many.
- **Truncated captures are flagged** in `draft list`. A capture that stopped
  at the page size is a slice, so the questions drawn from it are a slice too.
- **A desk it cannot read is an error**, never an empty desk. If "I could not
  look" returned nothing-to-do, every run would re-draft the whole library on
  top of what is already there.

### Every write goes through the audit chain

`draft --apply` shells out to `sentinel claim add` rather than writing to
`sentinel.db`. Direct SQL would be faster and would leave several hundred
claims in the desk with no audit entry — a chain that still verifies as
intact while no longer describing what happened. Verified live: the chain
went from 3 entries to 9 across three drafted claims.

---

## 8a. There are two case systems, and they do not know about each other

This is the most confusing thing in the repo. Both are called "case". Both
have a gate. Neither can see the other's data.

| | `bin/sentinel case` | `bin/sentinel sdesk case` |
|---|---|---|
| Module | `modules/research-desk` | `modules/sentinel-desk` |
| Storage | JSON, `evidence/sentinel_cases/*.json` | SQLite, `$SENTINEL_ROOT` (default `~/SentinelDesk`) |
| Unit of work | **exhibits** — documents, with pages read | **claims** — sentences, with tiers |
| The gate asks | have you *read* the evidence? | is this claim *supported*? |
| Rules | R-01 financial exhibits read to the last page · R-02 no broken exhibit · R-03 no open questions · R-04 no open contradictions | GREEN needs a citation · ARITH needs its formula · REPORTED needs its outlet · RED must be a question naming what would close it · DEAD needs its resolution |
| Also has | dashboard over all cases | audit hash chain, document vault, dossier export, web UI |
| Tests | 42 | 53 |

**Neither is wrong and they are not duplicates.** They gate different things.
The research desk asks whether you did the reading; the Sentinel Desk asks
whether the sentence you wrote can stand up. A claim can pass one and fail
the other, and both failures are real.

What you must not do is keep half a case in each. Pick the one a given
investigation lives in and put everything there — the failure mode is a
contradiction logged in one system and a dossier exported from the other
that has never heard of it.

`bin/sentinel status` reports both, so neither can go quiet.

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
| Neo4j Browser: `Unknown command ":connectMATCH ..."` | Two things ran together. The editor still held `:connect` from signing in and the paste landed on the end of it. Clear the editor box, paste one query, run it. |
| Neo4j Browser errors on a block that looks fine | Browser runs the whole editor as ONE statement. Two queries pasted together are one malformed query. Run them one at a time. |
| `connect graph --push` says the credentials are rejected, and the password looks right | Read the length it prints. A stray character pasted in front or behind is invisible in an editor and shows up as a length one longer than what you set. This happened: a rogue `w` in front, reported as *17 chars, starts with "w"* against a 16-character password. The length is the tell. |
| Terminal: `zsh: no such file or directory: http://localhost:7474` | A URL is not a command. `open http://localhost:7474`. |
| A sweep reports `courtlistener … HTTP 429 — Rate limit exceeded: 5/min` | CourtListener allows five calls a minute and enforces it. The runner now paces itself to that and retries once on a 429, reading the wait out of the response. A long sweep is slower because of it — that is the source arriving instead of being refused. |
| `regulationsgov … HTTP 403 — invalid api_key` | Regulations.gov needs its own key. `bin/sentinel connect test` will say `KEY MALFORMED` if what is in `.env` is the wrong length. |
| USAspending says *N of 25 match only inside a longer word* | A substring hit — `INTERWEST CONSTRUCTION` matching a search for `RWE`. They are kept and flagged rather than dropped, because dropping silently is worse. Short subjects produce more of them. |
| `zsh: event not found: …` | zsh expands `!` as history even inside double quotes. Wrap the whole command in SINGLE quotes, or avoid `!` in it. Same family as the `#` pitfall. |
| `connect brief "<name>"` finds nothing you know is there | Sources abbreviate, and court captions abbreviate hardest — the caption is `Licking Hts. Local School Dist. Bd. of Edn.`, so a search for "Licking Heights" matches nothing while the case sits in the capture. The brief now tries the longest distinctive word and tells you what it found. Search the distinctive token, not the full formal name. |
| A single-connector search returns nonsense, e.g. Mississippi murder cases for an Ohio school district | A flag value was leaking into the subject. `--into new-albany` left `new-albany` in the query, because the flag was stripped and its value was not. Fixed; if a subject still looks wrong, read the `subject` line the run prints — it is the exact string that was sent. |
| The run says `filing to evidence/investigations/<name>/` | Old output. It never wrote there. `--into` tags the ledger record; captures live in `evidence/captures/`. The line now says `tagging`. |
| `corpus inventory` finishes and reports very few files | If the corpus is on a drive, **check the drive before believing the number.** `bin/sentinel shelf check`. An unplugged volume used to scan as an empty folder; it is now refused, but a folder you passed as a raw path still is not. |
| `SHELF UNAVAILABLE — not mounted` | The drive is out, or macOS mounted it somewhere else. `bin/sentinel shelf list` shows what is actually mounted. Nothing was read; this is not a result about the records. |
| `SHELF UNAVAILABLE — a volume labelled "N1" is mounted, but it is NOT the drive shelf "N1" was bound to` | A different physical drive with the same label. Reading it under that name would file its contents under the wrong volume. `--rebind` only if the swap is intended. |
| `SHELF UNAVAILABLE — matches N mounted volumes` | A drive and its clone are both mounted; the volume id cannot pick between them. Unmount one. |
| `NOTE: /Volumes/N1 exists but carries no volume marker` | A stale mount point — an empty folder left behind by an unclean eject. Scanning that path directly would report zero files as a finding. |
| `NOT ENOUGH ROOM on the output drive` | OCR extracts page images alongside the text, so derived output runs to roughly the size of the source. Point `--out` at the other drive. |
| `OSError: [Errno 6] Device not configured` mid-scan | The drive dropped off the USB bus. This no longer crashes: completed shelves are kept, output is written as `inventory.PARTIAL.csv`, exit is 4. Re-seat the drive and re-run with `--resume`. |
| `inventory.PARTIAL.csv` and `_INCOMPLETE.txt` in the output folder | The scan did not finish. Rows are a prefix of the drive, not a list of it. A file missing from that CSV was not necessarily absent. |
| `*.superseded` in the output folder | A previous run's CSV, kept out of the way so a stale complete file is not read beside a newer partial one (or the reverse). Delete when you no longer want it. |
| A document you know you copied is missing from the drive | exFAT is case-insensitive. If two files differed only in case, the copy silently kept one. `bin/sentinel shelf check --probe` reports whether the drive does this. |


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
