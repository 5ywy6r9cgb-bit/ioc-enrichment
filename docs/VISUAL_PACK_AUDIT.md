# AUDIT — THE EPISODE 1 VISUAL PACK
**Checked against the terminal output that produced it. 2026-09-15.**

The graphics look good. Three things in them would not survive a reader who
checks, and one of those is the same class of error the programme is about.

**Fix them before any of this posts.** Every correction below is small, and
every one of them makes the graphic *more* interesting, not less.

---

## 1. 🔴 THE RING CHART DOES NOT ADD UP — PANEL 3

The ring reads **71 TOTAL LEADS** in the centre and then:

| Senate LDA | 25 | 35.2% |
| OpenCorporates | 25 | 35.2% |
| CourtListener | 20 | 28.2% |
| Federal Register | 4 | 5.6% |

**25 + 25 + 20 + 4 = 74, not 71. The percentages sum to 104.2%. And
Regulations.gov (4 leads) is missing from the ring entirely.**

What happened: the **segments are row counts** and the **centre is the
name-match count**, and the percentages divide one by the other.

Your terminal said it correctly:

```
71 lead(s) that NAME the subject across 5 source(s) · 78 row(s) returned
   7 do not name it at all — matched on something else
```

**71 + 7 = 78.** That reconciles. The graphic does not.

**THE FIX — and it is a better graphic:** make the ring **78 ROWS RETURNED**,
segment it by source (20 + 4 + 25 + 4 + 25 = 78, all five sources present),
and put **71 NAME THE SUBJECT · 7 DO NOT** as the centre. Now the ring is the
denominator and the centre is the finding, which is exactly the argument the
episode is making.

## 2. 🟡 "8 SOURCES" AND "ACROSS 5 SOURCE(S)" ARE BOTH TRUE

Panel 2 says **8 SOURCES**. The terminal says **across 5 source(s)**.

Both are right and they are different sentences: **eight were queried, five
returned anything.** FEC returned nothing and USAspending returned nothing —
**and those two zeroes are findings.** A global investment firm with no FEC
candidate committee and no federal award is a fact about how that firm
engages, and the graphic currently throws it away by rounding to "8 sources."

**Say: `8 QUERIED · 5 ANSWERED · 2 RETURNED NOTHING, WHICH IS ITSELF A
RESULT.`**

## 3. 🔴 THE FARA NUMBERS ARE ON A PANEL LABELLED "DOCUMENTED"

Panel 10 lists under **DOCUMENTED**:

> FARA filings (3,912 records)

and under **WHAT WE DON'T KNOW**:

> Full scope of FARA registrants (448 UNKNOWN)

**There is no FARA connector in this repository.** `connect test` lists
thirteen and none of them reads FARA. Those numbers cannot be sourced from
this desk, and the panel that asserts the standard is the panel breaking it.

They may be entirely correct and from a tool you ran elsewhere — **but then
name that tool on the panel.** A number under a DOCUMENTED heading with no
nameable register is the exact failure the episode is about, printed on the
slide that claims the high ground.

**Until the register is named: take both lines off panel 10.** You lose
nothing — the panel still has Senate LDA, Federal Register, OpenCorporates and
CourtListener, all four of which you can point at a capture hash for.

---

## 4. 🔴 THE ONE THAT MATTERS MOST — PANEL 4

Panel 4: **"20 leads · 18 name Blackstone, Inc."** and then lists:

| `FIC Homes of Blackstone, Inc. v. Conservation Commission` | 1996, 1994 |
| `Hotel Blackstone, Inc. v. Tax Commission` | **1980** |
| `CMP Complaint Issued to ZA Blackstone Inc. d/b/a ZA Food Mart` | FDA, panel 5's sibling |

**None of those is Blackstone Inc.**

- **Blackstone is a town in Massachusetts.** A *Conservation Commission* is a
  town body. `FIC Homes of Blackstone` is a housing matter in a town called
  Blackstone.
- **The Hotel Blackstone case is from 1980. The Blackstone Group was founded
  in 1985.** A record five years older than the company is not that company,
  and that test costs nothing.
- **ZA Food Mart is a convenience store** with an FDA tobacco complaint
  against it.

**Every one of them passed the whole-word test legitimately** — "Blackstone"
*is* a whole word in all three. The string test was right and the headline was
still wrong, because the reader came looking for an investment firm.

### FIXED IN CODE TODAY

`awards.js` already knew about this — it has `sameHead`, written after
`awards "Intel"` reported eighteen "direct payments" that turned out to be
BLAC INTEL LLC, PALADIN INTEL LLC and BEVERAGE INTEL collecting COVID aid.
**That guard had never been applied to any other connector.**

There is now a fourth verdict. `git pull` and re-run:

```bash
bin/sentinel connect all "Blackstone Inc"
```

| **NAME** | the record is **filed under** the name — `BLACKSTONE INC.`, `Blackstone Private Credit Fund`, `THE BLACKSTONE GROUP INC.`, `Blackstone Inc. v. Somebody` |
| **CONTAINS** | the name is a whole word **somewhere else** — `Hotel Blackstone`, `FIC Homes of Blackstone`, `Carolyn Bridges v. Blackstone, Inc.` |
| **OTHER** | the name is not there at all — matched on document text |
| **SUBSTRING** | buried inside a longer word |

Your five sources now read:

```
CourtListener      1 filed under it · 4 contain it · 1 other
Senate LDA         2 filed under it
Regulations.gov    0 filed under it · 1 contain it · 1 other
```

**CONTAINS is not noise, and that is why it is its own answer.**
`Carolyn Bridges v. Blackstone, Inc.` *is* the company — as a defendant, in
the middle of a caption, which is where parties normally sit. What CONTAINS
means is: **the register did not file this under your subject's name**, so
whether it is your subject is a question you answer by opening it.

### What the head test still cannot do

`BLACKSTONE CONSULTING, INC.` scores **NAME** — it genuinely begins with
Blackstone. It is a security-services firm and has nothing to do with the
investment firm. **A head match narrows; it does not identify.** Same-entity
confirmation is still yours.

---

## 5. THE TWO COMMANDS THAT FAILED WERE RUN BEFORE THE PULL

Your log shows:

```
bin/sentinel connect nexus --ohio --asserted     →  unknown connector: nexus
bin/sentinel shots --spec .../episode.json       →  unknown command: shots
```

Then `git pull` at the end of the session. **Both exist now.** Re-run:

```bash
bin/sentinel connect nexus --ohio --asserted
bin/sentinel connect nexus --gaps
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json
```

---

## 6. THE BEST UNUSED DATA YOU ALREADY HAVE

`connect delegation OH --cycle 2026` returned a complete table and **nothing
in the visual pack uses it.** It is the strongest Ohio material in the run,
because it is money to *named officeholders*, filed under penalty.

```
raised        $47,405,708
spent         $25,177,680
from PACs     $14,582,896   (39.5% of all contributions)
cash on hand  $39,740,505
```

Three things in that table are episodes on their own:

**PAC share ranges from 13.9% to 74.2% across one delegation.**
Jordan 13.9% · Landsman 25.6% · Husted 26.8% … Joyce 71.6% · Rulli 73.5% ·
Beatty 74.2%. **Two members of the same state delegation funded in almost
opposite proportions.** That is a measurement with a denominator, and the tool
already states the denominator correctly: PAC% is a share of *contributions*,
not of receipts, so it cannot be flattered by a candidate lending their own
campaign money.

**One member spent more than they raised.** Jordan: raised $4,774,322, spent
$6,230,902.

**One member is 30% of the delegation's entire money.** Husted raised
$14,350,624 of $47,405,708 — with $5,675,891 of it arriving as *transfers from
another authorised committee*, which is a different kind of money from a
donation and the table says so on its own line.

### The denominator the tool flagged and the graphic would have missed

```
16 of 16 with totals filed
1 senator(s) here, not 2 — election_year 2026 is who is ON THE BALLOT
100 non-incumbent candidate(s) on the 116-name cycle roster were left out
```

**This is a 16-of-116 table.** Say that on the graphic, or the number is a
ceiling wearing a total's clothes.

```bash
bin/sentinel connect delegation OH --cycle 2026 --all --csv oh_delegation.csv
```

---

## 7. WHAT TO RUN NEXT, IN ORDER

```bash
git pull

# 1  re-run Blackstone with the fourth verdict — this is the corrected panel 4
bin/sentinel connect all "Blackstone Inc"
bin/sentinel connect all "Blackstone Real Estate"

# 2  the two that failed before the pull
bin/sentinel connect nexus --ohio --asserted
bin/sentinel connect nexus --gaps

# 3  the bridge you already own — QTS is Blackstone-owned and in the OH set
bin/sentinel connect opencorporates "QTS Realty Trust"
bin/sentinel connect senatelda --client "QTS DATA CENTERS"
bin/sentinel connect nexus --side datacenters --side real_estate_capital

# 4  MINDSET ADVOCACY is the strongest single lead in the whole run.
#    It is ASSERTED — a sworn filing, a named firm, a dollar figure.
bin/sentinel connect senatelda --registrant "MINDSET ADVOCACY"
bin/sentinel connect opencorporates "Mindset Advocacy"
bin/sentinel connect vendor "MINDSET ADVOCACY"

# 5  the delegation, with the real denominator
bin/sentinel connect delegation OH --cycle 2026 --all --csv oh_delegation.csv

# 6  the committees the graphics already name
bin/sentinel connect fecpac "AMERICAN ELECTRIC POWER" --committee C00096842 --cycle 2026
bin/sentinel connect fecpac "FIRSTENERGY" --committee C00140855 --cycle 2026
bin/sentinel connect control C00096842 C00140855

# 7  the assignment sheet for the corrected episode
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json --out sheet.md
```

**`MINDSET ADVOCACY, LLC` is the lead to pull first.** Four filings at
$40,000, one client, and the client is The Blackstone Group. A small registrant
with a large client is the shape worth understanding — and `--registrant`
answers who *else* they file for, which is the question the client-side search
cannot reach.

---

## THE STANDARD, APPLIED TO YOUR OWN GRAPHICS

**A connection is a fact. A conclusion is not.** Panel 10 says that, and it is
right.

The ring chart that sums to 104.2%, and the 1980 hotel counted as a 2026
investment firm, are the same error the episode is about — **the shape of the
question mistaken for a fact about the world.** Catching them in your own work
before publication is not a setback. It is the method operating correctly, and
it is the reason the true parts will hold.
