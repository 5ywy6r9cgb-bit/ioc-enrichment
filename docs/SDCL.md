# The Sentinel Desk Command Language

> Never assume. Always verify.

SDCL is a vocabulary for asking investigative questions — `FOLLOWMONEY`,
`FOLLOWLAND`, `WHOPAYS`, `DISPROVE` — rather than for naming tools. It is
implemented in `modules/sdcl/` and reached as `sentinel ask`. The operator
manual documents how to use it (§4d). This page records **what was decided**
and, more usefully, **what is still missing**.

---

## The decision: a router, not fifty commands

The spec names 40 verbs. Implementing each as its own command would have
been the fastest way to make the desk *appear* to double in capability while
answering exactly as many questions as before. Every verb would print
something confident; nothing new would have been read.

So SDCL is a **router**. Each verb carries a status:

| Status | Count | Meaning |
|---|---|---|
| `BACKED` | 15 | A real connector or reader answers this. |
| `PARTIAL` | 14 | Something runs, and it answers less than the verb promises. The gap is printed above the commands. |
| `UNBACKED` | 11 | Nothing here reads that source. The route is a records request, and the verb says so. |

`modules/sdcl/test_sdcl.js` enforces the part that matters: **every command
string any verb can emit must resolve to a real dispatcher verb**, and one
level down to a real connector, `doc` action, `case` subcommand or `pra`
subcommand. Rename `connect expand` and the suite goes red — not the operator,
six weeks later, mid-investigation.

## The four tiers

Output separates:

| Tier | What it is |
|---|---|
| `LEAD` | Something worth looking at. Nobody has verified it. |
| `EVIDENCE` | A primary document, fetched and hashed. It says what it says. |
| `CLAIM` | What you assert the evidence shows. Yours, not the source's. |
| `FINDING` | A claim that survived a real attempt to disprove it. |

Every verb declares the **highest tier its own commands can reach**. No search
reaches `FINDING`; only the four verbs that route through the case gate can,
and the gate has four rules and no `--force`.

---

## The verbs

### THE CORE LOOP

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `INVESTIGATE` | `BACKED` | `EVIDENCE` | Everything every connected source holds on one name. |
| `WHOIS` | `BACKED` | `EVIDENCE` | What this entity legally is: where registered, under what name, owned by whom. |
| `NETWORK` | `PARTIAL` | `LEAD` | Who connects to whom across everything you have captured. |
| `TIMELINE` | `PARTIAL` | `EVIDENCE` | What happened in what order. |
| `WHOBENEFITS` | `PARTIAL` | `CLAIM` | Who is better off because this decision went the way it did. |
| `WHOPAYS` | `PARTIAL` | `CLAIM` | Who bears the cost, and were they in the room. |
| `CASEBUILD` | `BACKED` | `FINDING` | Turn captures into a case that can be published or refused. |
| `DOTCONNECT` | `PARTIAL` | `LEAD` | What shows up in more than one place. |
| `HYPOTHESIS` | `BACKED` | `LEAD` | State the thing you suspect, in a form that could be shown false. |
| `DISPROVE` | `BACKED` | `FINDING` | Try to kill your own claim. This is the verb that makes the rest trustworthy. |
| `PUBLICINTEREST` | `BACKED` | `FINDING` | Whether this should be published at all, and in what form. |

### FOLLOW THE MONEY

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `FOLLOWMONEY` | `BACKED` | `EVIDENCE` | Who paid whom, on the record, and how much. |
| `MONEYFLOW` | `PARTIAL` | `LEAD` | Which direction the money ran, and through how many hands. |
| `SUBSIDY` | `BACKED` | `EVIDENCE` | How much tax revenue a government gave up, and to whom. |
| `PUBLICBENEFIT` | `UNBACKED` | `LEAD` | What the public was promised in return, and whether it arrived. |
| `CONTRACTS` | `BACKED` | `EVIDENCE` | What this entity was paid to do by a government. |
| `NOBID` | `PARTIAL` | `EVIDENCE` | Whether anyone else was allowed to compete. |

### FOLLOW THE LAND

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `FOLLOWLAND` | `UNBACKED` | `LEAD` | Who owned the parcel, when it sold, and to whom. |
| `PROPERTY` | `UNBACKED` | `LEAD` | What the county says a parcel is worth and who is taxed on it. |
| `APPRECIATION` | `UNBACKED` | `LEAD` | How much a parcel gained in value, and who captured the gain. |
| `REZONING` | `UNBACKED` | `LEAD` | Who asked for the zoning change, who voted, and what changed. |
| `FOLLOWSCHOOLS` | `UNBACKED` | `LEAD` | What the school district lost or gained, and whether it agreed. |
| `BOR` | `UNBACKED` | `LEAD` | Who contested a valuation at the county board of revision, and what it moved. |
| `VALUATION` | `UNBACKED` | `LEAD` | What a property is valued at and by whose method. |

### FOLLOW THE POWER

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `FOLLOWPOWER` | `PARTIAL` | `EVIDENCE` | Where the electricity comes from, what it costs, and who agreed to that. |
| `RATEPAYER` | `PARTIAL` | `EVIDENCE` | Who pays for the power a data center needs. |
| `PUCO` | `UNBACKED` | `LEAD` | What was filed at the Public Utilities Commission of Ohio, and by whom. |
| `OPSB` | `UNBACKED` | `LEAD` | What the Ohio Power Siting Board approved, and over what objection. |
| `FOLLOWDECISION` | `PARTIAL` | `EVIDENCE` | Who was in the room before the vote. |
| `LOBBY` | `BACKED` | `EVIDENCE` | Who is paid to influence this, how much, and for whom. |
| `REVOLVINGDOOR` | `PARTIAL` | `EVIDENCE` | Which lobbyists used to hold the office they now lobby. |
| `DATACENTER` | `BACKED` | `EVIDENCE` | Everything the desk holds on the build-out. |
| `LOAD` | `UNBACKED` | `LEAD` | How much electricity it draws, and against what capacity. |
| `SOCIALIZATION` | `PARTIAL` | `LEAD` | Whether one customer's cost was spread across everyone's bill. |

### FOLLOW THE RECORDS

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `PUBLICRECORDS` | `BACKED` | `EVIDENCE` | What has been requested, from whom, and what is overdue. |
| `FOLLOWRECORDS` | `BACKED` | `EVIDENCE` | What you asked for, what came back, and what is late. |
| `RECORDGAP` | `BACKED` | `EVIDENCE` | What is missing from what they gave you. |
| `FOIASTRATEGY` | `BACKED` | `CLAIM` | What to ask for next, and how to word it so it cannot be refused on form. |

### FOLLOW THE LAW

| Verb | Status | Ceiling | Asks |
|---|---|---|---|
| `ORC` | `PARTIAL` | `EVIDENCE` | What the Ohio Revised Code actually says about this. |
| `SUNSHINE` | `PARTIAL` | `EVIDENCE` | Whether the meeting or the record was legally required to be open. |

---

## The gaps — what to connect next

This is the roadmap. Each line is a question the desk can be *asked* and
cannot yet *answer*, with the reason.

| Verb | Status | What is missing |
|---|---|---|
| `NETWORK` | `PARTIAL` | no denominator until `connect expand` has run against the same registrants |
| `TIMELINE` | `PARTIAL` | no timeline builder. `connect brief` lists dated captures; the ordering is still yours |
| `MONEYFLOW` | `PARTIAL` | no path tracer. The graph shows adjacency, and adjacency is not flow |
| `PUBLICBENEFIT` | `UNBACKED` | development agreements are local contracts. No API. Records request only. |
| `FOLLOWLAND` | `UNBACKED` | county auditor and recorder records are not connected. The dispatcher says so on its own help screen. |
| `PROPERTY` | `UNBACKED` | no auditor connector |
| `APPRECIATION` | `UNBACKED` | no auditor connector |
| `REZONING` | `UNBACKED` | no municipal records connector. R.C. 121.22 minutes are requestable. |
| `FOLLOWPOWER` | `PARTIAL` | no PUCO docket connector — federal sources only |
| `RATEPAYER` | `PARTIAL` | no PUCO docket connector |
| `PUCO` | `UNBACKED` | no PUCO connector. `doc get` fetches one known URL; it does not find one. |
| `OPSB` | `UNBACKED` | no OPSB connector |
| `FOLLOWDECISION` | `PARTIAL` | federal only |
| `REVOLVINGDOOR` | `PARTIAL` | no personnel-history source. You are reading a field the lobbyist filled in. |
| `ORC` | `PARTIAL` | no statute search — you supply the URL of the section |
| `SUNSHINE` | `PARTIAL` | reads the law, not the conduct |
| `NOBID` | `PARTIAL` | federal only |
| `FOLLOWSCHOOLS` | `UNBACKED` | no school district connector. The consent resolution is a public record under R.C. 149.43. |
| `BOR` | `UNBACKED` | no BOR connector |
| `VALUATION` | `UNBACKED` | no auditor connector |
| `LOAD` | `UNBACKED` | no interconnection-queue connector |
| `SOCIALIZATION` | `PARTIAL` | the decisive document is a PUCO filing and PUCO is not connected |
| `WHOBENEFITS` | `PARTIAL` | this is an analytic question. No command answers it; the commands only assemble the record. |
| `WHOPAYS` | `PARTIAL` | analytic. Same as WHOBENEFITS. |
| `DOTCONNECT` | `PARTIAL` | coverage of the other side is unknown until expand runs |

Read that table as a list of connectors that do not exist yet. Four of the
eleven UNBACKED verbs — `FOLLOWLAND`, `PROPERTY`, `APPRECIATION`, `VALUATION`
— are all the same missing thing: a **county auditor** reader. `BOR` is the
fifth. That is one connector standing between the desk and an entire family
of questions, and it is visible here only because the verbs were written down
before the code was.

---

## Denominators, verb by verb

Every verb states what you must know before its output means anything. These
are the lines that stop a capture count from being read as a finding.

**`INVESTIGATE`** — How many records each source HAS for this name, not how many it returned. A capped page is not a count.

**`WHOIS`** — A registry hit proves the name exists there. It proves nothing about who controls it.

**`NETWORK`** — Until expand runs, every shared name is shared only among names YOU searched. A firm with 400 clients and 8 of yours is nothing; a firm with 12 and 6 of yours is a story. Crosslink alone cannot tell those apart.

**`TIMELINE`** — Capture date is when YOU found it. Filing date is when it happened. They are different columns.

**`FOLLOWMONEY`** — ZERO IS A RESULT AND IT IS NOT NOTHING. Early Warning Services returned zero USAspending contracts while spending six figures a quarter on lobbying. That contrast is the finding. Do not discard an empty result — record it.

**`MONEYFLOW`** — The graph draws only what you captured. An absent edge means nobody searched it.

**`SUBSIDY`** — One ACFR is one government for one year. New Albany, Licking County and the school district are three separate books, and the same abatement appears differently in each.

**`PUBLICBENEFIT`** — Promised jobs versus verified jobs are two numbers. Almost every story confuses them.

**`FOLLOWLAND`** — The parcel number is the key, not the address. One address can be six parcels.

**`PROPERTY`** — Market value, assessed value and taxable value are three different numbers in Ohio. Assessed is 35% of market. Quoting the wrong one overstates by nearly three times.

**`APPRECIATION`** — Ohio reappraises on a six-year cycle with a three-year update. A jump between two years may be a reappraisal, not a sale.

**`REZONING`** — The application date versus the purchase date. Buying before the change is the question.

**`FOLLOWPOWER`** — A tariff applies to a CLASS of customer. "A data center pays X" is only true if the data center is in that class. Read the class definition before the rate.

**`RATEPAYER`** — Residential class versus mercantile class versus a special contract. Three denominators, and the answer changes with each.

**`PUCO`** — A case number is the unit. Intervenor lists say who thought it mattered enough to show up.

**`OPSB`** — Applications filed versus applications approved. A 100% approval rate is a finding.

**`FOLLOWDECISION`** — Comments filed is not comments read. The docket count is the denominator, and Regulations.gov returns false positives freely — check that each hit is your subject.

**`LOBBY`** — The LDA and FARA are different statutes. 22 U.S.C. 613(h) lets a firm working for a foreign commercial client register under the LDA INSTEAD of FARA. A FARA absence is therefore not an absence of foreign work.

**`REVOLVINGDOOR`** — Self-reported. A blank covered-position field means "not disclosed", never "none".

**`ORC`** — A section quoted without its exceptions subsection is a section quoted wrong.

**`SUNSHINE`** — An executive session is lawful only for an enumerated purpose, stated in the motion. A motion that does not state one is the violation.

**`PUBLICRECORDS`** — Ohio has no statutory deadline — R.C. 149.43 says "reasonable". The clock the desk runs is yours, not the law's. Say so if you publish it.

**`CONTRACTS`** — Obligated is not outlaid. A $40M award may have paid out $2M.

**`NOBID`** — One offer received is not the same as not competed. Both are disclosed, separately.

**`FOLLOWSCHOOLS`** — A district usually must CONSENT to an abatement above a threshold. Consent given in exchange for a payment is a different story from consent given for nothing.

**`BOR`** — Complaints filed versus reductions granted. A high grant rate for one filer is the story.

**`VALUATION`** — Same three-number trap as PROPERTY: market, assessed, taxable.

**`DATACENTER`** — The named entity is rarely the operator. A parcel bought by an LLC with a law-firm address tells you a lawyer filed it, and nothing else.

**`LOAD`** — Nameplate capacity, contracted load and actual draw are three numbers and they differ by multiples. Which one a press release quotes is itself informative.

**`SOCIALIZATION`** — Cost causation is the entire argument: who caused the cost decides who should bear it. You need the allocation study, not the bill.

**`FOLLOWRECORDS`** — Requests sent versus requests answered versus requests answered COMPLETELY. Three numbers.

**`RECORDGAP`** — Page numbers, Bates numbers, exhibit letters and date ranges are four separate sequences. A gap in one is not a gap in the others.

**`FOIASTRATEGY`** — One narrow request answered beats four broad ones denied. Count what you can realistically read, not what you can name.

**`WHOBENEFITS`** — Name the beneficiary from a DOCUMENT. A beneficiary inferred from an outcome is a hypothesis wearing a conclusion's clothes.

**`WHOPAYS`** — Total cost, and the share. "Ratepayers pay $X" needs the class size to mean anything.

**`CASEBUILD`** — Pages read versus pages in the exhibit. R-01 exists because the number that ruins a story is on page 40 of a 44-page filing.

**`DOTCONNECT`** — Crosslink prints NO DENOMINATOR on every row until expand has run. That warning is the honest state of the output, not a formatting quirk.

**`HYPOTHESIS`** — A hypothesis with no disproving observation is not a hypothesis. Write down what you would have to see to abandon it, before you look.

**`DISPROVE`** — The innocent explanation, stated as strongly as you can state it. If you cannot argue the other side well, you have not tested anything.

**`PUBLICINTEREST`** — Named private individuals are the exposure. Institutions can answer; a person named in passing cannot. Decide who is a subject and who is a bystander before you write.

---

## What SDCL is not

It is not natural language. It does not interpret the target, search anything
itself, or decide that a result means something. It routes a question to
commands and states the limits of those commands.

The thinking stays yours.
