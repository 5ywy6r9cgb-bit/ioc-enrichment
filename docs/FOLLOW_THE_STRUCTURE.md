# FOLLOW THE STRUCTURE
**Foreign lobbying, real-estate capital, and manufactured consensus — the
commands, and the three framings that would sink the story before it airs.
2026-09-15.**

You asked for what flies under the radar and what is hidden by design.

**Most of it is not hidden. It is filed, and nobody reads it.** That is a
better story than a secret, because a filed fact survives a lawyer and a
rumour does not. And the genuinely hidden parts are hidden by a **named
statute** you can put on screen — which is the strongest thing in this
document.

---

## 0. THE THREE FRAMINGS THAT WILL SINK YOU

Read these before running anything. Each one is a trap this subject sets for
everybody who works on it, and each has a true version that is *more*
interesting than the false one.

### TRAP 1 — "AIPAC is a foreign agent that should be registered under FARA"

**FARA covers agents acting at the order, request, or under the direction of a
FOREIGN PRINCIPAL.** A domestic advocacy organisation — *including one whose
entire subject matter is another country's affairs* — registers under the
Lobbying Disclosure Act instead and appears nowhere in FARA.

**AIPAC is not a FARA registrant.** A FARA search for it returns nothing, and
that nothing is a fact about the register, not a failed search. Whether it
*ought* to be a registrant is a live public argument in several places and
**no database settles it.** If you say "they're hiding from FARA" you have
made a legal claim you cannot source, and you have handed away the true part.

**THE TRUE VERSION, WHICH IS BETTER:** AIPAC's LDA footprint is **100 filings,
one client, and the client is the registrant** — in-house lobbying, no outside
firm retained under that name. Meanwhile the money layer is enormous, separate,
and entirely public. *The influence is not hidden. It is itemised, and it is
legal, and almost nobody has read the itemisation.* That is the story.

### TRAP 2 — "BlackRock owns everything"

**BlackRock and Blackstone are different companies.** This is the single most
common error in the subject and it is fatal on screen, because anyone who
knows the difference stops listening at that sentence.

| **BlackRock** | an **asset manager**. Its index funds hold shares as **fiduciary for other people's retirement money**. "BlackRock owns Company X" nearly always means "funds BlackRock manages hold X on behalf of pension holders." Different sentence, different consequences — and a **13F** states it plainly. |
| **Blackstone** | a **private equity and real-estate firm** that takes **direct ownership**. |

**THE TRUE VERSION, WHICH IS BETTER — AND IT CONNECTS TO YOUR OHIO WORK:**
**QTS Data Centers is Blackstone-owned**, and QTS is already in your
`datacenters` subject set. That is direct ownership, of a data-centre operator,
by a private-equity firm, in a story you are already reporting. That is a
documented corporate fact, not an inference about index funds.

### TRAP 3 — "coordinated accounts are manufacturing consensus"

From your own `THESIS.md`, and it is the most important sentence in this
repository:

> **The unfalsifiability of the claim "these accounts are coordinated" is
> precisely what makes it such an effective payload. It cannot be checked, so
> it never dies, and it recruits exactly the people who are right to be
> suspicious. A claim shaped like that IS the manipulation, whoever is
> repeating it.**

Joins 3 and 4 — distribution pattern, and account authenticity — **do not
exist outside the platforms, for anyone.** Anyone who claims to have made them
from public data is using an undisclosed proxy or lying.

**THE TRUE VERSION, WHICH IS ALREADY PROVEN IN YOUR REPO:** persuasion at
scale is a **procured service with published prices**, and the US government
is one of its largest customers. Fors Marsh at **$1,673,787,861** / 710
contracts (a ceiling), 69% from HHS. Contracts that literally say
**PSYCHOGRAPHIC… to TARGET** and **SOCIAL NORMING**. A USAID line item to
*"BOOST FACEBOOK POST TO STRATEGICALLY TARGETED AUDIENCES."* Government buys
audience **measurement** (Comscore, Nielsen) and **$0** of fraud
**verification** (IAS, DoubleVerify) — *yet both lobby.*

**You do not need a bot farm. You have a procurement register.**

---

## 1. FOREIGN LOBBYING — THE COMMANDS

```bash
git pull
bin/sentinel connect sweep foreign_lobby          # the plan — 12 subjects
bin/sentinel connect sweep foreign_lobby --go     # run it
```

### AIPAC, both directions — and they are different questions

```bash
bin/sentinel connect senatelda --client "AMERICAN ISRAEL PUBLIC AFFAIRS COMMITTEE"
bin/sentinel connect senatelda --registrant "AMERICAN ISRAEL PUBLIC AFFAIRS COMMITTEE"
```

The first asks *who lobbies FOR them.* The second asks *who they lobby for.*
The finding recorded in `FINDINGS §6` is that the second returns AIPAC itself —
in-house. **The first is the query that has not been exhausted**, because an
outside firm can file with AIPAC as *client* under a name you have not guessed.

### The money, by category, never summed

```bash
bin/sentinel connect fecpac "AMERICAN ISRAEL PUBLIC AFFAIRS COMMITTEE"
bin/sentinel connect fecpac --committee C00797670 --cycle 2026
bin/sentinel connect fecpac --committee C00799031 --cycle 2026   # United Democracy Project
bin/sentinel connect donors "UNITED DEMOCRACY PROJECT"
bin/sentinel connect asymmetry --dimension vendor
```

**The four categories are four numbers.** A committee's own contributions;
money it FORWARDED for donors who earmarked it; independent expenditures FOR;
independent expenditures AGAINST. **Forwarded money is not the committee's
money** — it belongs to the individual donors and passes through. Adding them
produces a figure describing nothing that happened.

### The control that keeps you honest — run it and be willing to lose

```bash
bin/sentinel connect control C00797670 C00799031
```

Shared treasurer, custodian, address, email, website, connected organisation —
**or not.** If it comes back with nothing shared, *that is a finding and you
publish it*, because it is the answer to the accusation you will otherwise be
accused of implying. **A negative control you report is worth more than a
positive one you assert.**

### Who represents actual foreign governments

```bash
bin/sentinel connect senatelda --registrant "MERCURY PUBLIC AFFAIRS"
bin/sentinel connect senatelda --registrant "QORVIS"
bin/sentinel connect senatelda --registrant "BGR GOVERNMENT AFFAIRS"
bin/sentinel connect senatelda --registrant "BALLARD PARTNERS"
bin/sentinel connect senatelda --registrant "SQUIRE PATTON BOGGS"
bin/sentinel connect senatelda --registrant "AKIN GUMP STRAUSS HAUER & FELD"
```

**These are search strings, not allegations.** A registrant list tells you who
a firm files for. It does not tell you what the firm argued, or which side its
client took — **the LDA has no such field, and any tool showing you one has
inferred it.**

### The FARA register itself — MANUAL, and this is the top gap

**There is no FARA connector in this toolkit.** `connect test` lists thirteen
and none of them reads FARA. So:

```
justice.gov/nsd-fara   →   Quick Search   →   registrant, or foreign principal
```

Pull the **Supplemental Statements** (activity, income, expenses) and the
**Exhibit AB** (the agreement itself). Then bring the PDF back in hashed:

```bash
bin/sentinel doc get "THE_PDF_URL" --case foreign-lobby --as EX-01
```

**A FARA connector is the highest-value thing left to build in this
repository.** It is the register that answers your actual question and it is
the one you do not have.

---

## 2. REAL-ESTATE CAPITAL — THE COMMANDS

```bash
bin/sentinel connect sweep real_estate_capital --go
```

### Start with the bridge you already own

```bash
bin/sentinel connect opencorporates "QTS Realty Trust"
bin/sentinel connect senatelda --client "QTS DATA CENTERS"
bin/sentinel connect awards "QTS" --all
bin/sentinel connect nexus --side datacenters --side lobbying --asserted
```

**QTS is Blackstone-owned and is in your data-centre set.** That is direct
ownership of an Ohio-relevant operator by a private-equity firm — concrete,
corporate, and already inside the investigation you are running.

### The two companies, kept apart

```bash
bin/sentinel connect senatelda --client "BLACKSTONE"
bin/sentinel connect senatelda --client "BLACKROCK"
bin/sentinel connect awards "Blackstone" --all --pages 5
bin/sentinel connect awards "BlackRock" --all --pages 5
bin/sentinel connect opencorporates "Blackstone Real Estate Income Trust"
bin/sentinel connect opencorporates "Invitation Homes"
bin/sentinel connect opencorporates "Progress Residential"
```

**Run them separately and report them separately.** The moment those two
columns merge in your notes, the story is unrecoverable.

### Single-family rental — where the public actually feels this

```bash
bin/sentinel connect courtlistener "Invitation Homes" --dockets
bin/sentinel connect courtlistener "Progress Residential" --dockets
bin/sentinel connect regulationsgov "single-family rental"
bin/sentinel connect senatelda --client "INVITATION HOMES"
```

**`--dockets`, not the default.** The default searches published opinions and
will hand you an unrelated divorce. Eviction and habitability litigation is in
RECAP, not in the opinions index.

### What none of these can see — say it on screen

| a **private REIT's** holdings | not a 13F filer in the same way; a non-traded REIT discloses differently |
| an **LLC's beneficial owner** | the Corporate Transparency Act's beneficial-ownership regime has been through repeated litigation and rule changes — **check its current status before you describe it**, because it has changed more than once |
| **a county parcel** | **this is where a real-estate story actually lives**, and no federal register carries one |

```bash
bin/sentinel connect nexus --gaps
```

**Licking and Franklin County Auditor parcel records are free, online, and
nobody has to grant them.** They have been open on your list since the first
ARSENAL draft.

---

## 3. MANUFACTURED CONSENSUS — THE VERSION THAT SURVIVES

```bash
bin/sentinel connect sweep message_buyers --go
bin/sentinel connect sweep bot_economy --go
bin/sentinel connect sweep persona_management --go
```

### The procurement spine — this is the episode

```bash
bin/sentinel connect awards "Fors Marsh Group" --all --pages 20
bin/sentinel connect awards "Porter Novelli" --all --pages 5
bin/sentinel connect awards "Ogilvy" --all --pages 5
bin/sentinel connect awards "Ketchum" --all --pages 5
bin/sentinel connect awards "IQ Solutions" --all --pages 5
```

**The question is whether Fors Marsh is a firm or a category.** If four more
firms sit at the same scale on the same NIH vehicles, the finding is *a
market*. If Fors Marsh stands alone at $1.67bn, the finding is *a firm*.
**Those are different stories and only division tells you which.**

### The asymmetry — measurement bought, verification not

```bash
bin/sentinel connect awards "Comscore" --all
bin/sentinel connect awards "Nielsen" --all --pages 5
bin/sentinel connect awards "Integral Ad Science" --all
bin/sentinel connect awards "DoubleVerify" --all
bin/sentinel connect awards "HUMAN Security" --all
bin/sentinel connect senatelda --client "INTEGRAL AD SCIENCE"
bin/sentinel connect senatelda --client "DOUBLEVERIFY INC."
```

**If every verification vendor is $0 while every measurement vendor is paid,
that is not an anecdote about two companies. It is a procurement policy — and
a procurement policy has an author who can be asked why.**

### The documented precedent, which is real and is not a theory

```bash
bin/sentinel connect awards "Ntrepid" --all --pages 5
bin/sentinel connect courtlistener "HBGary" --dockets
bin/sentinel connect courtlistener "1:18-cr-00633" --dockets   # US v. Zhukov, Methbot
bin/sentinel connect docket "1:18-cr-00633"
```

**Ntrepid held a US CENTCOM contract for online persona management. That is
federal contracting, in USAspending, with an award number.** It is the
strongest thing in this whole subject *because it is a contract and not an
allegation.*

---

## 4. WHAT IS ACTUALLY HIDDEN BY DESIGN — AND THE STATUTE THAT HIDES IT

**This is the best material in this document.** Each of these is a real,
deliberate, legal opacity. None needs a leak. Each can be put on screen with
the citation beside it.

| **JobsOhio** | **R.C. 187.04** places it **outside the Ohio Public Records Act**. It is a private non-profit that assembles most of the incentives in the Ohio data-centre story. **You cannot FOIA it, by statute.** That is a complete answer to "why doesn't anyone know," and it needs no records request — it is in the statute. |
| **501(c)(4) donors** | A social-welfare organisation may spend on politics without disclosing its donors. Money entering the system through one is **legally anonymous**. |
| **LLC beneficial ownership** | A property or a political vendor can be an LLC whose owner is not in any public register. **Check the Corporate Transparency Act's current status before describing it — it has changed repeatedly.** |
| **Non-traded REITs** | Disclose on a different schedule and in different detail from a listed REIT. |
| **Local tax abatement and TIF** | Granted by townships and municipal councils. **Appears in no federal register at all.** Ohio Dept of Development incentive reports; council minutes. |
| **Platform distribution data** | Joins 3 and 4. **Not public for anyone, ever.** No FOIA reaches it. |
| **Contract SOWs** | An award description says `RESEARCH` for $34,811,793. The **statement of work** says what was bought, and it is FOIA-able. **Expect a denial; the denial is publishable.** |

```bash
bin/sentinel pra foia add NSA-2026-01 "NSA/CSS" --statute FOIA
bin/sentinel pra foia
```

**Ohio: R.C. 149.43(C)(2).** Only **hand delivery, electronic submission, or
certified mail** preserves statutory damages. Email from your own account and
keep the sent copy.

---

## 5. THE ORDER

```bash
# 1  the two new sets
bin/sentinel connect sweep foreign_lobby --go
bin/sentinel connect sweep real_estate_capital --go

# 2  the bridge, graded, with a denominator on every row
bin/sentinel connect nexus --asserted
bin/sentinel connect nexus --side datacenters --side lobbying
bin/sentinel connect nexus --out nexus.csv --dot nexus.dot

# 3  the control you must be willing to lose
bin/sentinel connect control C00797670 C00799031

# 4  the money, by category, never summed
bin/sentinel connect fecpac --committee C00799031 --cycle 2026
bin/sentinel connect donors "UNITED DEMOCRACY PROJECT"

# 5  the procurement spine
bin/sentinel connect awards "Fors Marsh Group" --all --pages 20
bin/sentinel connect awards "Ntrepid" --all --pages 5

# 6  find out what blocks publication BEFORE you record
bin/sentinel sdesk ready minnesota-fraud
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json
```

---

## THE STANDARD

You are looking for what is hidden. **The most powerful finding available to
you is that almost none of it is** — that the structure is filed, itemised,
searchable, and unread, and that the parts genuinely closed are closed by a
statute with a number.

That is a harder story to tell than a secret. It is also the only one that
cannot be dismissed, because every line of it has a document behind it and a
critic who goes to check will find you were right.

**Documents first. Connections second. Conclusions last.**
