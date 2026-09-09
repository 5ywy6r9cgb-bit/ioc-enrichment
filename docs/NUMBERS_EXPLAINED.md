# All the numbers, and what each one actually means

Every figure below came off a federal register on this machine. This file
explains what each one measures, because most of them measure something
narrower than they look like they do.

**The rule underneath all of it:** a number is only as good as its
denominator and its label. Almost every wrong figure in campaign-finance
coverage is a real number with the wrong word attached.

---

## Part 1 — The four registers, and what each can prove

| register | what it records | what it CANNOT tell you |
|---|---|---|
| **FEC** | money into and out of political committees | why anyone gave it |
| **LDA** (Senate Lobbying Disclosure) | who is paid to lobby, by whom, on what | whether lobbying worked |
| **FARA** | agents acting for a **foreign principal** | anything about domestic advocacy |
| **USASpending** | who received federal money | whether they should have |

These are different filings by different people under different laws. A name
appearing in two of them is a name appearing in two of them.

---

## Part 2 — The three kinds of political money

This is the part everyone collapses into one number.

### 1. A direct contribution

An organisation's PAC writes a cheque to a candidate's campaign committee.

- **Capped at $5,000 per candidate per election.** A primary and a general
  are two elections, so ~$10,000 a cycle is the ceiling.
- Itemised, dated, attributable to the organisation.
- **This is the strong material.** It is the closest thing to "X gave Y
  money" that exists in the record.

### 2. An independent expenditure

A super PAC buys advertising **for or against** a named candidate.

- **Uncapped.** No limit at all.
- **Not a donation.** The candidate never receives it and by law may not
  coordinate on it.
- Carries a `support_oppose_indicator` — S or O. **Money spent AGAINST
  someone is not a gift to anyone**, and a total that ignores this field is
  wrong in both directions at once.

### 3. Bundled or conduit money

Individuals each give in their own name; an organisation collects and
forwards the cheques.

- **The money is the individual's.** The FEC records the individual.
- Attributing it to the organisation is an **inference about affiliation**,
  not a filing.
- This is where nearly every inflated "organisation X gave $N million"
  headline comes from.

**These three are never added together.** One number describing all three
describes none of them.

---

## Part 3 — AIPAC: the $2 million that isn't

### What the register says

| committee | type | first filed |
|---|---|---|
| **C00797670** AIPAC PAC | PAC — Qualified · *Lobbyist/Registrant PAC* | **2021-12-15** |
| **C00799031** United Democracy Project | Super PAC (independent-expenditure only) | **2022-01-03** |

**The first date is a finding on its own.** For decades AIPAC lobbied and ran
**no political committee at all**. Any account of "AIPAC donations to
Congress" before the 2022 cycle is describing individuals who were identified
with the organisation — which the FEC records under the individual, not the
organisation.

*Lobbyist/Registrant PAC* is the FEC's own designation, tying the committee to
a registered lobbying operation. Not our inference.

### The disbursements, cycle 2022

```
$2,089,843   across 2,482 rows
```

That figure is **not** AIPAC's giving, and three numbers in the same filing
prove it:

| signal | value | why it matters |
|---|---|---|
| Largest single recipient | **$248,936** to ELAINE FOR CONGRESS | **50× the legal cap.** A PAC cannot legally give this |
| Average payment | **$842** | The size of a person's donation, not a committee's |
| Rows carrying a memo code | **2,418 of 2,482 (97.4%)** | Memo entries are not additive with the rest |

All three say the same thing: **AIPAC PAC is operating as a conduit.**
Thousands of individuals earmark contributions for named candidates and the
committee forwards them. The money is theirs, disclosed under their own names,
moving through.

**So the honest sentence is:** roughly $2.09 million was *forwarded* through
AIPAC PAC on behalf of individual donors in the 2022 cycle. AIPAC PAC's own
giving is the residue — the ~64 rows with no memo code.

The top recipients by amount forwarded, 2022 (a **floor** — the pull hit its
page cap):

| forwarded | recipient committee |
|---:|---|
| $248,936 | ELAINE FOR CONGRESS |
| $97,623 | DON BACON FOR CONGRESS |
| $46,350 | DEBBIE WASSERMAN SCHULTZ FOR CONGRESS |
| $45,710 | TAMMY FOR ILLINOIS |
| $38,275 | KEN CALVERT FOR CONGRESS |
| $36,750 | GRACE FOR NEW YORK |
| $36,300 | MIKE GALLAGHER FOR WISCONSIN |
| $34,400 | ROBERT ADERHOLT FOR CONGRESS |
| $33,570 | TEXANS FOR HENRY CUELLAR |
| $30,900 | JIMMY PANETTA FOR CONGRESS |

**Read that column as "money that reached this campaign through AIPAC's
conduit from many individual donors" — not "AIPAC gave this."**

### How the error was caught

Not by a source, not by a second database. The number was internally
consistent, correctly formatted, and traceable to a real filing.

**A $5,000 statutory cap caught it.** $248,936 cannot satisfy it. Arithmetic
failing a fact about the world.

---

## Part 4 — United Democracy Project

UDP is a **super PAC**. It makes no contributions to candidates; it buys
advertising.

From the first pull — **totals AMBER, direction GREEN:**

```
$103,974,317   spent FOR candidates    (615 expenditures)
$132,209,388   spent AGAINST candidates (631 expenditures)
```

**The direction is documented.** It comes from the FEC's own
`support_oppose_indicator`. UDP spends **more against candidates than for
them** — the majority of its money is opposition advertising.

**The dollar totals are not usable yet.** `two_year_transaction_period` is a
Schedule A/B field; Schedule E ignores it. The request succeeded and returned
**three cycles**: 692 of 1,246 rows fell outside 2024, spanning 2022-04-22 to
2026-08-11. Fixed to `min_date`/`max_date` and clamped locally — needs
re-running.

The largest single lines (again spanning three cycles, so **not** a 2024
figure):

| against | candidate |
|---:|---|
| $40,279,808 | EL-SAYED, ABDUL |
| $19,699,933 | BOWMAN, JAMAAL |
| $10,461,877 | BUSH, CORI |
| $9,224,192 | MIN, DAVE |

| for | candidate |
|---:|---|
| $20,997,470 | STEVENS, HALEY |
| $11,468,027 | BOAFO, ADRIAN |
| $9,937,001 | CONYEARS-ERVIN, MELISSA |
| $9,326,397 | LATIMER, GEORGE |

**None of these people received a dollar of it.** That is the whole point of
an independent expenditure. Money spent against Bowman helped his opponent;
it was not a gift to Bowman, and it was not a gift to the opponent either.

---

## Part 5 — The committees against AIPAC

Searching the acronym `AIPAC` returned **only these two** — AIPAC's own
committees are not registered under it:

| committee | type | first filed |
|---|---|---|
| **C00879080** CITIZENS AGAINST AIPAC CORRUPTION | Hybrid PAC (with non-contribution account) — Qualified | **2024-05-16** |
| **C00876649** REJECT AIPAC PAC | Super PAC (independent-expenditure only) | **2024-04-19** |

**What we can say:** both exist, both are registered, both were formed in
spring 2024 — roughly two years after AIPAC's own committees, and during the
cycle in which UDP's largest opposition spending appears.

**What we have not pulled:** their money. Nothing about their size, funding or
spending is known from this session. Two commands, and the picture is
symmetrical:

```bash
bin/sentinel connect fecpac "CITIZENS AGAINST AIPAC" --committee C00879080 --cycle 2024
bin/sentinel connect fecpac "REJECT AIPAC" --committee C00876649 --cycle 2024
```

**"Unauthorized"** on both means simply *not authorised by a candidate* — it
is the FEC's word for an ordinary independent committee, not a judgement.

**The methodology lesson worth keeping:** searching an organisation's acronym
surfaced only the organisations named after opposing it. If we had stopped
there, the file would have said AIPAC has no PAC.

---

## Part 6 — Ohio's delegation

`bin/sentinel connect delegation OH --cycle 2026`

### What "PAC%" means here

```
                  money from political committees
PAC%  =  ─────────────────────────────────────────────────
          individuals  +  committees  +  party  (CONTRIBUTIONS)
```

**Not** a share of *receipts*. Receipts include transfers between committees a
candidate controls, and loans — including their own money. Eleven of sixteen
members here received transfers; Husted's are **$5.68M of $14.35M receipts**.
Using receipts as the denominator would move his number materially and flatter
every self-funder in the country.

### The table

| PAC% | member | raised | spent | cash |
|---:|---|---:|---:|---:|
| 74.2 | BEATTY, JOYCE (D-03) | $1,201,451 | $1,137,204 | $2,776,821 |
| 73.5 | RULLI, MICHAEL (R-06) | $1,112,553 | $913,479 | $269,711 |
| 71.6 | JOYCE, DAVID (R-14) | $1,410,643 | $1,031,924 | $3,121,595 |
| 65.9 | CAREY, MIKE (R-15) | $3,299,679 | $1,404,260 | $2,056,713 |
| 62.3 | BALDERSON, TROY (R-12) | $1,743,281 | $767,354 | $1,982,352 |
| 62.2 | DAVIDSON, WARREN (R-08) | $661,353 | $526,145 | $529,910 |
| 61.7 | BROWN, SHONTEL (D-11) | $1,183,643 | $882,901 | $1,156,556 |
| 57.0 | LATTA, ROBERT (R-05) | $1,461,648 | $1,038,450 | $1,019,993 |
| 51.5 | TURNER, MICHAEL (R-10) | $894,595 | $768,735 | $556,284 |
| 41.5 | MILLER, MAX (R-07) | $2,142,562 | $937,959 | $1,379,132 |
| 40.7 | TAYLOR, DAVID (R-02) | $1,095,248 | $780,078 | $442,977 |
| 34.2 | SYKES, EMILIA (D-13) | $3,137,440 | $1,362,656 | $1,897,462 |
| 32.8 | KAPTUR, MARCY (D-09) | $4,303,416 | $1,260,674 | $3,491,462 |
| 26.8 | HUSTED, JON (R-SEN) | $14,350,624 | $4,931,806 | $9,418,818 |
| 25.6 | LANDSMAN, GREG (D-01) | $4,633,250 | $1,203,152 | $3,610,214 |
| 13.9 | JORDAN, JIM (R-04) | $4,774,322 | $6,230,902 | $6,030,301 |

**Delegation:** $47.4M raised · $25.2M spent · $14.6M from PACs (39.5%) ·
**$39.7M cash on hand.**

### What holds up

- **Nine of sixteen take more than half their contributions from political
  committees.** Range 13.9% to 74.2% — a **5.3× spread** inside one state.
- **It does not sort by party.** Highest is a Democrat, lowest a Republican.
  Republican median 57.0%, Democratic median 34.2% — but the Democratic side
  runs 25.6% to 74.2%, so the medians describe the middle, not the members.
- **Jordan spent more than he raised**: $6.23M out against $4.77M in.
- **The delegation holds more cash ($39.7M) than it spent all cycle
  ($25.2M).**

### What does NOT hold up

**A senator is missing.** Ohio has two; this table has one. `election_year`
returns who is *on the ballot*, and a senator mid-term is not. Every figure in
the table is correct and the heading is still wrong until the other class is
merged in.

**Nothing here says money changed a vote.** PAC share describes where money
came from. What it bought is a different question and this data cannot answer
it.

---

## Part 7 — Lobbying

| registrant | filings | clients |
|---|---:|---|
| AIPAC | 100 | **1 — itself** |
| BlackRock | 72 | **1 — BlackRock Funds Services Group LLC** |

Both are **in-house lobbying**: the organisation registers and files for
itself, rather than retaining an outside firm.

This does not rule out outside firms working for them — those would appear as
*other* registrants filing with AIPAC or BlackRock as the **client**, which is
a different query.

For contrast, the big outside shops in the captured library:

| firm | clients |
|---|---:|
| CORNERSTONE GOVERNMENT AFFAIRS | 876 |
| SQUIRE PATTON BOGGS | 716 |
| BROWNSTEIN HYATT FARBER SCHRECK | 683 |
| ALPINE GROUP PARTNERS | 398 |
| BALLARD PARTNERS | 364 |
| AKIN GUMP STRAUSS HAUER & FELD | 317 |

**A firm with 876 clients is not a network.** Any two of those clients share a
lobbyist and nothing else, and that is exactly the co-occurrence the graph
refuses to draw as an edge.

---

## Part 8 — Institutional PACs

| committee | first filed |
|---|---|
| C00479246 BlackRock PAC | 2010-03-23 |
| C00679175 BlackRock Institute | 2018-05-19 |
| C00072751 State Street Bank & Trust PAC | 1976-11-15 |
| C00384818 CVS Health PAC | 2003-02-06 |
| C00160770 Walgreen Co PAC | 1982-08-23 |

Registered and dated. **No money pulled yet.**

**The trap to build against before pulling holdings data.** BlackRock, Vanguard
and State Street hold 5–8% of nearly every S&P 500 company — because index
funds mechanically buy the index. A graph showing "BlackRock → CVS" and
"BlackRock → Vantage" looks like a network and is an artifact of indexing.

**A holding is an edge to the holder, never between the held.** What earns its
keep is *change*: a position opened, doubled or exited in the quarter before a
contract award or a rezoning is a dated sequence worth a records request. A
static ownership percentage is not.

---

## Part 9 — The library, and why every number is a floor

```
5,698   captures
105,624 results
275     subjects
7,411   organisations
5,053   FILED_FOR      sworn lobbying filings
9,099   APPEARS_UNDER  search results, NOT links between organisations
3,771   captures that held FEWER ROWS than the source reported
```

**That last line is why nothing here is a total.** Where a source said it had
1,000 rows and the capture holds 400, the count is short by an unknown amount.
Every figure in this file is a **minimum**.

**FILED_FOR vs APPEARS_UNDER is the distinction the whole system is built
around.** A sworn filing is one hop: a registrant filed for a client, under
penalty. A search result is two hops, through the search itself: both names
came back from the same query. **There are 9,099 of the second kind and no
edge is ever drawn between them**, because two companies answering one search
is not a relationship.

---

## What to do next, in order

1. **Merge the other Ohio Senate class** — the table is not a delegation until
   both senators are in it
2. **Re-run UDP** with the fixed date filter, so the totals mean one cycle
3. **Pull the two anti-AIPAC committees**, so the picture is symmetrical
4. **Re-run AIPAC PAC 2022 past the page cap** — the current figure is
   truncated, and the residue of non-memo rows is the real answer to "what did
   AIPAC PAC give"
5. **Push the graph** — `.env` still holds a placeholder password

---

## The one-line versions, if you need them today

- **Ohio:** *Nine of sixteen Ohio members in Congress take more than half
  their contributions from political committees. The range runs 14% to 74%,
  and it does not sort by party.* **GREEN.**
- **AIPAC:** *AIPAC's PAC is mostly a conduit — 97% of its 2022 disbursement
  rows are individuals' earmarked money passing through, not the
  organisation's own giving.* **GREEN.**
- **Timeline:** *AIPAC ran no political committee at all until December 2021.*
  **GREEN.**
- **UDP:** *The super PAC spends more against candidates than for them.*
  **GREEN on direction, AMBER on amount.**
