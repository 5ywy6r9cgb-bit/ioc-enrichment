# Anomaly hunting
### What actually counts as one, what only looks like one, and the commands that find them

**The Sentinel Report · working method · 10 September 2026**

---

## 0. The thing that must be said first

**A search artifact is not an anomaly.**

The surveillance sweep returned Fish & Wildlife hunting regulations under
"Flock Safety" and toxicology reviews under "Axon Enterprise". Those looked
like a company turning up somewhere strange. They were **our query matching
the words separately** — *flock* is ornithological, *axon* is anatomical.

**That distinction is the whole discipline.** An anomaly is a company
appearing where it has no business being **in a document that actually names
it**. Test every one the same way:

1. Does it survive a **quoted** search?
2. Open the document. **Does the company's name appear in it?**
3. If yes — why? If no — it was never there.

**Step 2 is not optional and it is the step everyone skips.**

---

## 1. WHAT COUNTS AS AN ANOMALY

Six shapes, ordered by how often they turn out to be real.

### 1.1 One entity, two legal names, two lobbying firms
**Strongest. Almost always structural, almost never accidental.**

Found in your library right now:

> **AMERICAN ELECTRIC POWER SERVICE CORPORATION** — 31 filings via Brownstein Hyatt Farber Schreck
> **AMERICAN ELECTRIC POWER COMPANY, INC.** — 17 filings via Cassidy & Associates

**Those are two different legal entities.** A "Service Corporation" is
typically the shared-services subsidiary that bills the operating utilities;
the "Company, Inc." is the holding company. **AEP is headquartered in
Columbus and is the distribution utility for central Ohio.**

**Why it matters:** anyone counting "AEP's lobbying" by one name gets a
fraction of it. Two firms may also be carrying two different asks.

**Not yet established:** that the split is deliberate, or that the asks
differ. **Read the issue-activity pages of both.**

### 1.2 A name in two registers that do different things
**Strong when the registers are genuinely independent.**

> **CLEARPATH ACTION FOR CONSERVATIVE CLEAN ENERGY INC** — Alpine Group lobbying client (5 filings)
> **CLEARPATH ACTION FUND** — spent independently at the Ohio Senate seat (in `outside_oh_senate`)

A lobbying client that also runs a committee spending at a seat is two
different legal activities by related names. **Confirm same-entity before
saying so** — that is the §12 lesson, where a Columbus non-profit did not
match a West Chester filing.

### 1.3 A shared VENDOR
**The most under-used signal in this entire system, and stronger than a
shared bill.**

Two committees naming the same bill is routine — opponents do it constantly.
**Two committees paying the same vendor is a contract**, and a small vendor
serving several committees is a structural link that nobody publishes
because it requires reading Schedule B.

**You have never run this.** `asymmetry --committee C00… --dimension vendor` exists and has
not been used once.

### 1.4 A committee whose spending has one shape and whose money has another
Ohio Flyer PAC: two candidates, one state — and **one donor at 35.3%**.
CFFE PAC: **89.3% organisations, two donors at 82%**.

**Both sides needed. Either alone is half a fact.**

### 1.5 A date that precedes its own reason
Ohio Flyer PAC filed **2025-07-21**. TEAM HUSTED filed **2025-01-30**. Jobs
Opportunity Now filed **2025-01-27** — three days before.

**Registration dates are cheap to get and almost never checked.** A vehicle
that exists before the thing it supposedly responds to is a real question.

### 1.6 An absence where presence is expected
**Flock Safety returned NOTHING from USAspending.**

Not a gap — it sells to city and county police, and those buys never touch a
federal register. **The absence tells you which register to use instead.**

---

## 2. WHAT ONLY LOOKS LIKE ONE

| looks like | actually |
|---|---|
| A word from the company's name in an unrelated document | **A search artifact.** Open the document. |
| Two committees on the same bill | **Routine.** A filing names a bill, not a side. |
| A registrant with 398 clients carrying two of your subjects | **Arithmetic.** Big practices carry everything. |
| A donor giving to several of one candidate's committees | **A donor network.** That is what they are. |
| A figure at a legal maximum | **The cap.** AIPAC's $10,000 to four members told us about the cap, not the givers. |
| Two committees at one seat | **Possibly opponents.** Read the side split first. |

---

## 3. THE ENERGY PICTURE IN YOUR DATA

**Boring and true, which is what you asked for.**

### 3.1 The HB6 cluster is adjudicated, not alleged

Your library already links: **FirstEnergy Corp · FirstEnergy Solutions ·
Energy Harbor · Generation Now · Larry Householder · Sam Randazzo · Jeff
Longstreth · Diane Owens.**

**This is federal corruption that has been through court** — not a lead, not
an allegation. It is the strongest ground in your whole library and it is
Ohio. **Everything else in this section is context around it.**

### 3.2 The only two bills in your corpus are energy bills

> **H.R. 4024 / S. 2291 — Energy Infrastructure Act**
> **Zero-Emission Nuclear Power Production Credit Act**

Of 64 documents fetched, three name a bill and **all three name these.**

**Why that is worth pulling:** a federal nuclear production tax credit is the
same subject matter as HB6's nuclear subsidy, one level up. Ohio's nuclear
plants are the assets in question. **Two clients swore they lobbied on it —
and the filings do not say which side.** Find out.

### 3.3 One lobbying firm sits at all three layers of the same stack

**ALPINE GROUP PARTNERS** — 123 clients found in 500 of 7,346 filings (**a
floor: 20 of 294 pages**):

| layer | clients |
|---|---|
| **surveillance** | Venntel · Babel Street · Palantir · Cellebrite · Axon |
| **cloud / data centre** | AWS Public Policy |
| **power and transmission** | NiSource · Vistra · RWE · Equinor · Shell *(via Acorn)* · Duke Energy · Edison Electric Institute · Siemens Energy · ITC Holdings · American Transmission Company · Tallgrass Energy · Atmos Energy · Elevate Renewables |

**Data centres need power. Surveillance needs data centres.** One firm
carries all three.

**This is still a co-occurrence** and a 7,346-filing practice carries
everything. **What would make it a finding:** two of those clients on the
**same bill**, in the **same quarter**. That is checkable and has not been
checked.

### 3.4 FERC and the interconnection queue

Your crosslink puts **Federal Energy Regulatory Commission** under: Dayton
Power and Light · Dominion Energy · Energy Harbor · FirstEnergy Solutions ·
Jeff Longstreth · Ohio Power Company · **PJM Interconnection** · SB Energy.

**PJM's interconnection queue decides whether a large load can be served at
all.** For a data centre in central Ohio it is the gate everything else waits
behind — and it is a federal proceeding with a public docket.

**This is the most under-reported energy story available to you** because it
is procedural, slow, and requires reading dockets.

---

## 4. THE COMMANDS

### 4.1 The one you have never run

```bash
# WHO A COMMITTEE PAYS. Not who it gives to — who it BUYS FROM.
bin/sentinel connect asymmetry --committee C00937797 --dimension vendor --cycle 2026
bin/sentinel connect asymmetry --committee C00912865 --dimension vendor --cycle 2026
bin/sentinel connect asymmetry --committee C00896928 --dimension vendor --cycle 2026
bin/sentinel connect asymmetry --committee C00896688 --dimension vendor --cycle 2026
```

**Run all four and compare the vendor lists.** SRCP Media already appears in
one. If a vendor appears in several, that is a contract relationship across
committees — **a far stronger link than a shared bill, and nobody publishes
it.**

### 4.2 The filings nobody reads

```bash
# F99 — miscellaneous text. Often the explanation of something odd:
# a treasurer's letter, an RFAI response, a correction narrative.
bin/sentinel connect filings --committee C00912865 --form F99
bin/sentinel connect filings --committee C00937797 --form F99
bin/sentinel connect filings --committee C00896928 --form F99

# F1 — registration. Treasurer, connected organisation, and for a joint
# fundraiser, THE PARTICIPANTS.
bin/sentinel connect filings --committee C00896928 --form F1

# Everything, so you can see the shape of a committee's filing history.
bin/sentinel connect filings --committee C00912865
```

### 4.3 Energy: the money, both directions

```bash
# AEP files under two names through two firms. Ask both.
bin/sentinel connect senatelda --registrant "Brownstein Hyatt Farber Schreck" --pages 20
bin/sentinel connect senatelda --registrant "Cassidy & Associates" --pages 20
bin/sentinel connect fecpac "American Electric Power"
bin/sentinel connect donors "American Electric Power" --cycle 2026

# The HB6 names, at the federal money layer.
bin/sentinel connect fecpac "FirstEnergy"
bin/sentinel connect fecpac "Energy Harbor"
bin/sentinel connect donors "FirstEnergy" --cycle 2026

# ClearPath appears as a lobbying client AND a committee. Both.
bin/sentinel connect fecpac "ClearPath Action"
bin/sentinel connect asymmetry "ClearPath Action Fund" --cycle 2026

# The utilities at the Ohio Senate seat.
bin/sentinel connect fecpac "NiSource"
bin/sentinel connect fecpac "Vistra"
bin/sentinel connect fecpac "Duke Energy"
bin/sentinel connect fecpac "Edison Electric Institute"
```

### 4.4 The bills — the corpus gap that blocks §3.2 and §3.3

```bash
# The issue-activity pages carry bill numbers. Cover sheets do not, which
# is why 61 of 64 documents name no bill.
bin/sentinel connect senatelda --registrant "Alpine Group Partners" --pages 294
bin/sentinel connect senatelda --registrant "Squire Patton Boggs" --pages 40
bin/sentinel connect senatelda --registrant "Akin Gump Strauss Hauer & Feld" --pages 40

# Then, and only then:
bin/sentinel doc bills
```

### 4.5 Widen the registrant net

```bash
# You have 181 registrants and have asked 10.
bin/sentinel connect expand --limit 181
bin/sentinel connect crosslink --verbose
```

### 4.6 Re-run what was broken

```bash
# The old sweeps asked the wrong question — unquoted phrases.
bin/sentinel connect sweep surveillance --go
bin/sentinel connect sweep surveillance_money --go
bin/sentinel connect sweep energy --go
bin/sentinel connect sweep hb6 --go
bin/sentinel connect sweep ratepayers --go
bin/sentinel connect sweep datacenters --go
```

### 4.7 Entity resolution, before anything downstream

```bash
# Three "Axon Enterprise" registrations in three states are not
# established as one company.
bin/sentinel connect opencorporates "Axon Enterprise"
bin/sentinel connect opencorporates "A Public Voice"
bin/sentinel connect opencorporates "SRCP Media"
bin/sentinel connect opencorporates "Ohio Flyer"
```

---

## 5. WHAT THE FEDERAL REGISTERS CANNOT SEE

**The most important list in this document.**

| question | register | where it actually lives |
|---|---|---|
| Did Columbus police buy Flock cameras? | **none** | City purchasing records |
| What does the Franklin County contract say? | **none** | County commissioners' minutes |
| Which data centre asked PJM for how many megawatts? | partial | **PJM interconnection queue** |
| What tariff will ratepayers pay for it? | **none** | **PUCO docket** |
| Who owns the land under the New Albany campus? | **none** | Franklin/Licking County auditor |
| Is there a non-disclosure agreement with the developer? | **none** | Records request, often refused |

**Six of the most important questions in your Ohio work are invisible to
every API in this system.** They are public records requests, and
`sentinel pra foia` is the part of the toolkit built for them.

**A federal sweep is a good way to find the names. It is a bad way to find
out what happened in Ohio.**

---

## 6. THE HABIT

Before any figure goes in a script:

1. **What is the denominator?** A number without one is not a finding.
2. **Which way does the error run?** Floor or ceiling — say which.
3. **Read it from the other side.** Every correction this desk has made came
   from one register disagreeing with another.
4. **Is the name an identity?** Two Sherrod Browns. Three Axon Enterprises.
5. **Would this look identical if it were a coincidence?** If yes, it is not
   yet a finding.
