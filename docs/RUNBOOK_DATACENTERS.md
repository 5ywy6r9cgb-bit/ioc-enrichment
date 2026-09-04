# Runbook — Central Ohio data centers

One investigation, start to publishable, in the order the desk actually
supports. Every phase ends with something on disk that the next phase reads.

**The rule this runbook exists to enforce:** a sweep produces *leads*, a
lobbying filing is an *asserted relationship*, and only a document you
fetched, hashed and read supports a *claim*. Phases 1 and 2 are not
interchangeable, and Phase 3 will refuse to publish if you skip Phase 2.

---

## 0 · Ground truth before anything runs

```
cd ~/sentinel
git pull origin claude/franklin-county-alpr-evidence-pa59db
bin/sentinel status
bin/sentinel connect test
bin/sentinel prov verify evidence/manifests/provenance.jsonl
```

`connect test` tells you which sources are reachable and which keys are set.
`prov verify` re-hashes every captured file against the ledger written when it
arrived. A file whose hash no longer matches is not corrupted — it is a file
you can no longer cite.

---

## 1 · Collection — the leads layer

Sweeps are cheap and they are *not* evidence. `--new-only` skips subjects
already asked recently, so re-running costs nothing.

```
bin/sentinel connect sweep shell_entities --only opencorporates,courtlistener --go
bin/sentinel connect sweep datacenter_policy --new-only --go
bin/sentinel connect sweep ratepayers --new-only --go
bin/sentinel connect sweep energy --new-only --go
bin/sentinel connect sweep hb6 --new-only --go
```

Federal money, both halves — the contracts connector and the grants connector
are different questions and a null from one says nothing about the other:

```
bin/sentinel connect usaspending "SB Energy Global"
bin/sentinel connect federalgrants "SB Energy Global"
bin/sentinel connect federalgrants "Centrus Energy"
bin/sentinel connect usaspending "Fluor-BWXT Portsmouth"
```

Federal lobbying by the entities the state records name:

```
bin/sentinel connect senatelda "Williams Companies"
bin/sentinel connect senatelda "Stonepeak"
bin/sentinel connect senatelda "EdgeConneX"
bin/sentinel connect senatelda "Bloom Energy"
```

The one federal docket already named in a court caption:

```
bin/sentinel connect courtlistener "Cologix Col5"
```

---

## 2 · Primary documents — the claims layer

This is the phase that converts *reported* into *citable*. Each command
fetches the bytes, hashes them before deriving anything, extracts the text,
and writes a provenance row.

Fetch the regulator's own words, not a news account of them:

```
bin/sentinel doc get "<OPSB press release URL — Socrates the Younger, 26-0169-EL-BLN>"
bin/sentinel doc get "<OPSB press release URL — Apollo, 25-0973-EL-BLN>"
bin/sentinel doc get "<governor.ohio.gov press release — data center tax pause, 2026-05-27>"
bin/sentinel doc get "<ohiohouse.gov press release — HB 695>"
bin/sentinel doc get "<legislature.ohio.gov bill text — HB 15>"
bin/sentinel doc get "<legislature.ohio.gov bill text — HB 695>"
```

If a fetch reports **almost no text**, it is a nav shell or a JavaScript
page — saved and hashed, but not the record. If it reports a **ZIP wearing a
.pdf name**, unpack and OCR before treating a null keyword search as absence:

```
bin/sentinel corpus ocr <folder> --out <folder>_derived
```

Then ask what legislation the documents you now hold have in common:

```
bin/sentinel doc bills
```

`doc bills` reports a bill only when **two different clients** named it. One
party naming a bill twice is not a correlation.

---

## 3 · The case file — what can actually be published

```
bin/sentinel case new datacenters "Central Ohio data centers — land, power, abatements"
bin/sentinel case add datacenters EX-1 evidence/documents/<file>.pdf --kind financial --pages <n>
bin/sentinel case read datacenters EX-1 --pages <n>
bin/sentinel case ask datacenters "Does HB 695 reach city councils, or only villages, townships and counties?"
bin/sentinel case ask datacenters "Is the Worthington JEDD amendment a city action, and therefore outside HB 695 as written?"
bin/sentinel case status datacenters
```

`case status` is the gate. A case is BLOCKED while any exhibit is unread, any
question is open, or any contradiction is unresolved — **and there is no
override.** Answer a question with the answer, not with a decision to ignore
it:

```
bin/sentinel case answer datacenters Q-1 "<what the bill text actually says>"
```

---

## 4 · The shape of it — charts and the graph

```
bin/sentinel connect crosslink
bin/sentinel connect lobby --chart evidence/lobby.html
bin/sentinel connect graph --dashboard
```

`crosslink` ranks by how *improbable* an overlap is, not by how big the firm
is. Read the CONCENTRATED block first. A shared registrant is a roster, not a
relationship — the output says so, keep it saying so in the draft.

Do not pass a trailing `#` comment on any of these lines. zsh does not strip
it interactively, and `--chart` will happily write a file named `#`.

---

## 5 · Records requests — what no API can reach

The three state systems that hold the answers are not connectors: **OLAC**
(state lobbying), the **PUCO docketing system**, and **Ohio SOS** business
filings. Those are requests and human pulls, not sweeps.

```
bin/sentinel pra foia add OTCA-2026-01 "Ohio Development Services Agency" \
  --on <date> --via certified --scope OH \
  --about "Communications, calendars, and meeting materials between Ohio Tax Credit Authority staff, the Office of the Governor, and Cologix or Stonepeak representatives, May 25-27 2026"
bin/sentinel pra foia
bin/sentinel foia dash
```

Certified mail is not superstition here: it puts the R.C. 149.43(C)(2)
transmission predicate beyond argument if this ever goes further. Ohio sets
**no fixed day count** — every threshold the dashboard shows is your own
follow-up cadence, not a statutory deadline, and nothing on that page is
overdue as a matter of law.

---

## 6 · Publish

```
bin/sentinel case status datacenters
bin/sentinel sdesk ready <case>
bin/sentinel sdesk export <case>
bin/sentinel montage <deck>
```

`sdesk export` omits blocked claims from the body but leaves the omission
visible. That is deliberate: a dossier that silently drops what it could not
support is indistinguishable from one that never looked.

---

## What this runbook cannot do for you

- **OLAC** requires an interactive form. No connector reaches it.
- **Ohio SOS** business filings have no connector in this repo.
- **County auditor** parcel and deed records are web-only, per county.
- **Local candidate finance** never reaches the state system — a county
  commissioner's donors are invisible to every API here.

A null result from this desk on any of the above is a statement about the
desk, not about the world.
