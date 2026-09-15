# THE OHIO DATA-CENTRE QUESTION
**Officials, land, lobbying, contracts and unions — what is answerable, what
is not, and exactly who holds the rest. 2026-09-15.**

The question as put: *find connections between Ohio officials and data
centres; bridge the land deals and the companies to lobbyists, federal
contracts and unions.*

This file answers it in the only order that survives contact: **the four joins
this toolkit can make, the six it cannot, and the office that holds each of
the six.** The second list is longer than the first, and that is the finding —
not a failure of the tooling.

---

## 0. READ THIS BEFORE THE COMMANDS

**Every federal register in this desk is blind to an Ohio officeholder.**

- **FEC covers FEDERAL candidates only.** A state representative, a PUCO
  commissioner, a county commissioner, a township trustee, a mayor — none of
  them file with the FEC and none of them are visible to any command here.
- **Senate LDA covers FEDERAL lobbying only.** Lobbying the Ohio General
  Assembly is registered with the **Joint Legislative Ethics Committee**, which
  is not in this toolkit.
- **USAspending covers FEDERAL awards only.** The money that decides whether an
  Ohio data centre gets built is *forgone local tax* — an abatement, a TIF, a
  community reinvestment area — and it appears in no federal register at all.

So a `connect all "OHIO STATE SENATOR"` that returns nothing has told you
**nothing about that person**. It has told you which register you asked. That
is §42, §61, §66 and §74 of this investigation, and it is the single easiest
way to publish a wrong sentence about a named individual.

```bash
bin/sentinel connect nexus --gaps
```

Run that first. It prints the six unreachable joins and the office that holds
each, and it does not depend on what you have captured — because an absence
produced by a missing connector must never be reported as an absence in the
world.

---

## 1. THE FOUR JOINS THAT ARE REAL, FEDERAL, AND ALREADY BUILT

### JOIN 1 — company → the firm that lobbies for it, federally
**ASSERTED.** A Senate LDA filing is a sworn statement under 2 U.S.C.
§§1603–1604 that a named firm lobbied for a named client.

```bash
bin/sentinel connect senatelda --client "AMERICAN ELECTRIC POWER"
bin/sentinel connect senatelda --client "FIRSTENERGY"
bin/sentinel connect senatelda --client "INTEL CORPORATION"
bin/sentinel connect senatelda --client "AMAZON DATA SERVICES"
bin/sentinel connect senatelda --client "VANTAGE DATA CENTERS"
bin/sentinel connect senatelda --client "QTS DATA CENTERS"
bin/sentinel connect senatelda --client "DIGITAL REALTY"
bin/sentinel connect senatelda --client "ALIGNED DATA CENTERS"
bin/sentinel connect senatelda --client "COLOGIX"
bin/sentinel connect senatelda --client "JOBSOHIO"
bin/sentinel connect senatelda --client "LICKING COUNTY PORT AUTHORITY"
```

Then turn it around — **a different question, not the same one restated**:

```bash
bin/sentinel connect senatelda --registrant "ALPINE GROUP PARTNERS"
bin/sentinel connect senatelda --registrant "SQUIRE PATTON BOGGS"
bin/sentinel connect senatelda --registrant "VANTAGEKNIGHT"
bin/sentinel connect senatelda --registrant "HARBINGER STRATEGIES"
bin/sentinel connect senatelda --registrant "DCI GROUP"
bin/sentinel connect senatelda --registrant "ELEVATE GOVERNMENT AFFAIRS"
```

**A firm carrying a data-centre operator AND a utility AND a ratepayer
intervenor is the shape worth finding.** `connect nexus` will surface it with
a grade attached.

### JOIN 2 — company → federal money
**ASSERTED.** An award has an award id and an obligation behind it.

```bash
bin/sentinel connect awards "American Electric Power" --all --pages 5
bin/sentinel connect awards "AEP Ohio" --all
bin/sentinel connect awards "Intel Corporation" --all --pages 5
bin/sentinel connect awards "Intel Federal" --all
bin/sentinel connect awards "Amazon Data Services" --all --pages 5
bin/sentinel connect awards "Vadata" --all
bin/sentinel connect awards "Licking County Port Authority" --all
bin/sentinel connect awards "JobsOhio" --all
bin/sentinel connect awards "Columbus Regional Airport Authority" --all
```

Traps, all learned the expensive way: **the default is contracts only**
(`--all` for five families); **never sum across families**; **run the stem AND
the full name** — `"Intel"` returned $220,948,789 in the 09/11 family that
`"Intel Corporation"` did not.

### JOIN 3 — company → the politicians its PAC pays
**This is the closest thing to "officials ↔ data centres" that a federal
register will ever give you, and it has never been run in this investigation.**

A corporate PAC's Schedule B names the candidate committees it gave to, filed
under penalty. It is a public, ASSERTED, federal record connecting a
data-centre or utility company to **named politicians**, including Ohio's
federal delegation.

```bash
bin/sentinel connect fecpac "AMERICAN ELECTRIC POWER"
bin/sentinel connect fecpac "FIRSTENERGY"
bin/sentinel connect fecpac "INTEL"
bin/sentinel connect fecpac "AMAZON"
bin/sentinel connect fecpac "ALPHABET"
bin/sentinel connect fecpac "META PLATFORMS"
bin/sentinel connect fecpac "MICROSOFT"
```

`fecpac` resolves the name to a committee and **prints the matches for you to
choose** — so you are never guessing a committee id. If a company has no
committee it says so plainly, and says that lobbying for decades without ever
running one is ordinary.

Then the other side of the same ledger:

```bash
bin/sentinel connect delegation OH --cycle 2026
bin/sentinel connect delegation OH --outside
```

**The join you are looking for is a committee that appears in BOTH** — a
data-centre PAC's Schedule B and an Ohio member's Schedule A. That is a
documented federal contribution to a named officeholder, and it is the only
official-to-company link in this entire file that does not require a records
request.

### JOIN 4 — the entity behind the entity
**REGISTRY.** A registration says the thing exists, where, and since when.

```bash
bin/sentinel connect opencorporates "NEW ALBANY COMPANY"
bin/sentinel connect opencorporates "GEORGETOWN COMPANY"
bin/sentinel connect opencorporates "VADATA"
bin/sentinel connect opencorporates "AWS PUBLIC POLICY"
```

**A registration is not an operation.** `AWS PUBLIC POLICY LLC` registered in
Oklahoma matches a search for AWS and is almost certainly not Amazon.

---

## 2. THE BRIDGE, ONCE YOU HAVE RUN THEM

```bash
bin/sentinel connect sweep datacenters --go
bin/sentinel connect sweep lobbying --go
bin/sentinel connect sweep energy --go
bin/sentinel connect sweep ratepayers --go
bin/sentinel connect sweep newalbany --go
bin/sentinel connect sweep intel_newalbany --go

bin/sentinel connect nexus --ohio
bin/sentinel connect nexus --side datacenters --side lobbying
bin/sentinel connect nexus --asserted
bin/sentinel connect nexus --require senatelda
bin/sentinel connect nexus --out nexus.csv --dot nexus.dot
```

**`--asserted` is the one to trust.** It drops every bridge resting on two
names appearing in the same document — which is the weakest thing this desk
produces and is never a finding on its own.

**A sweep of one set cannot produce a bridge.** Nothing crosses a domain with
nothing in it, and `nexus` prints the empty domains before it prints any
result so that a missing bridge cannot be misread as a missing relationship.

**Read the pair population on every row.** "AEP Ohio bridges energy and
lobbying" is not a finding if ninety entities do — that is what a regulated
utility *is*. The count is on the row precisely so the sentence cannot be
written without it.

---

## 3. THE SIX JOINS NOTHING HERE CAN MAKE

`connect nexus --gaps` prints this list with the register for each. In short:

| join | who holds it | cost |
|---|---|---|
| **Ohio officeholder → anything** | Ohio SoS campaign finance · **Ohio Ethics Commission Form A** · county boards of elections | records request |
| **company → parcel, price, date** | **Licking County Auditor and Recorder** | **free, online, nobody has to grant it** |
| **company → abatement / TIF / CRA** | Ohio Dept of Development incentive reports · township and council minutes · **JobsOhio, which R.C. 187.04 puts OUTSIDE the Public Records Act** | mixed |
| **data centre → what ratepayers pay** | **PUCO docketing system (DIS)**, by case number · Ohio Consumers' Counsel filings | free, online |
| **company → union / labour agreement** | **DOL OLMS LM-2/LM-3/LM-4** · NLRB case and election records · project labour agreements as municipal contract exhibits | **NOT BUILT** |
| **who paid for the post you saw** | Meta Ad Library · FCC Political File | **NOT BUILT** |

### On unions, plainly
**No connector in this toolkit touches labour.** `bls` takes a series id and
returns a statistic, not an organisation. Asking any command here about a
union returns a name match in an unrelated register, and a name match is not a
finding. If the labour thread matters to the story, **the register to build
against is DOL OLMS**, and until it exists the honest sentence is "we have not
looked", not "we found nothing".

### On JobsOhio
JobsOhio is a **private non-profit** created by R.C. 187, and R.C. 187.04
places it outside the Ohio Public Records Act. It is the body that assembles
most of the incentives in this story. **That exemption is itself a publishable
fact** — it is a complete answer to "why doesn't anyone know", and it needs no
records request to establish, because it is in the statute.

---

## 4. WHAT WE MISSED — RANKED BY WHAT IT WOULD CHANGE

1. **Corporate PAC → Ohio federal delegation.** Join 3 above. Never run, free,
   ASSERTED, and it is the only official-to-company link available without a
   records request. **Do this first.**
2. **Licking County Auditor parcel transfers.** Free, online, ungranted, and
   it is the entire land-deal half of the question. Listed as open since the
   first ARSENAL draft and still not pulled.
3. **PUCO DIS — the AEP Ohio data-centre tariff case.** The ratepayer question
   is litigated there and nowhere else. Public and searchable.
4. **USDA FNS SNAP payment error rates.** Unrelated to Ohio, still the single
   highest-value manual lookup left, and it decides §89. A payment error rate
   is overpayments *plus* underpayments and measures administrative accuracy,
   not theft.
5. **`prov verify` has never been run** — and the ledger still holds a live FEC
   key in cleartext. **Rotate the key, then verify the chain.**
6. **The claim layer is still nearly empty.** 900+ captures, a vault, and a
   `sdesk ready` that has never been asked what blocks publication. Nothing in
   this file is publishable until it has been through that.
7. **DOL OLMS connector** — the union join. Not built.
8. **Meta Ad Library / FCC Political File** — joins 1 and 2 of the advertiser
   question in THESIS.md. Not built. Joins 3 and 4 of that question do not
   exist outside the platforms **for anyone**, and anybody claiming otherwise
   is using an undisclosed proxy.

---

## 5. THE RULE

**Pressure is only as durable as its weakest citation.**

A campaign with nine documented facts and one bad name is not 90% right. It is
finished, because the one bad name is what the response will be about, and
every true thing you were carrying goes down with it.

**§78 is why.** Thirteen names were published off a truncated RECAP `party`
field; one of them was **John C. Ellis, Jr., court-appointed Coordinating
Discovery Counsel — a defence lawyer** — and a real defendant was missing from
the list. One bad field.

This is the file most likely to produce that error again, because it is about
**named living officeholders in one county**. So: every sentence about a
person needs a document with that person's name in it, from a register that
asserts rather than indexes. `connect nexus --asserted` is the floor. It is
not the ceiling.
