# THE THESIS, AND WHAT IT STILL NEEDS
**2026-09-12 · Sentinel**

You asked for a conventional thesis and for a way to dismantle the bot
networks through public pressure. This document does both, and it starts by
saying plainly which parts of that are available and which are not.

---

## PART ONE — THE THESIS AS IT CAN CURRENTLY BE DEFENDED

> **Persuasion at scale is a procured service with published prices, and the
> United States government is one of its largest customers. The same
> government buys detailed measurement of who is watching, and buys nothing
> at all to verify that the audience it pays for is human. That gap is not
> hidden. Nobody has been made to answer for it because nobody has put the
> two halves of the register side by side.**

Every clause has a document.

| clause | evidence | tier |
|---|---|---|
| persuasion is procured | Fors Marsh **$1,673,787,861** / 710 contracts, **no page cap** | **GREEN** |
| at scale, from one buyer | HHS alone **$1,155,508,570** — **69%** | **GREEN** |
| targeting is explicit | `75N98021F00001` — *"…**PSYCHOGRAPHIC**… to **TARGET**…"* | **GREEN** |
| shaping norms is explicit | `75N98023F00002` — *"**SOCIAL NORMING** OF PEDIATRIC VACCINES CAMPAIGN"* | **GREEN** |
| platform buys are itemised | USAID `72067418P00054` — *"boost Facebook post to strategically targeted audiences… credit card… billed for each boost"* | **GREEN** |
| government calls it core work | FDA AdWords `IGF::CT::IGF` · CFPB paid search `IGF::CL::IGF` | **GREEN** |
| measurement is bought | Comscore FCC $500k / FTC $405k / **DOJ $148k "in support of the Google trial"** · Nielsen DoD $1.4m | **GREEN** |
| **verification is not** | **Integral Ad Science $0 · DoubleVerify $0**, across all five instrument families | **GREEN** |
| …yet both lobby anyway | IAS via S-3 Group · DoubleVerify via AVOQ + in-house $70–75k/qtr | **GREEN** |
| fake traffic is a crime | ***US v. Zhukov***, E.D.N.Y. **1:18-cr-00633** | **GREEN** |

**That thesis survives contact.** It names no villain, requires no inference,
and every number has a denominator or a stated floor.

---

## PART TWO — THE THESIS YOU WANT, AND WHY IT IS NOT AVAILABLE

> *"Coordinated inauthentic networks are pushing specific political content
> into Ohio feeds, and here is who is paying."*

**There is no register that will produce that, and I want to be exact about
why, because the reason is the story.**

The link requires **four joins**, and this toolkit can currently make one:

| join | needs | status |
|---|---|---|
| 1. buyer → ad spend | Meta Ad Library / FCC public file | **NOT BUILT** |
| 2. ad spend → specific creative | Ad Library creative archive | **NOT BUILT** |
| 3. creative → distribution pattern | platform-internal | **NOT PUBLIC, EVER** |
| 4. distribution → authenticity of accounts | platform-internal | **NOT PUBLIC, EVER** |

**Joins 3 and 4 do not exist outside the platforms.** No FOIA reaches them, no
subpoena you can issue reaches them, and no amount of scrutiny produces them.
Anyone who tells you they have made those joins from public data is either
using a proxy they have not disclosed, or lying.

**This is the most important sentence in the file:** the unfalsifiability of
the claim *"these accounts are coordinated"* is precisely what makes it such
an effective payload. It cannot be checked, so it never dies, and it recruits
exactly the people who are right to be suspicious. **A claim shaped like that
is the manipulation, whoever is repeating it.**

**So do not build toward join 4.** Build toward joins 1 and 2, which are real,
and then let the gap be the finding.

---

## PART THREE — "DISMANTLE THE NETWORKS"

**You cannot dismantle a network you have not demonstrated exists, and
pressure applied to an undemonstrated network lands on real people.** §78 is
the whole argument: I published thirteen names off a field that turned out to
be carrying another state's officials. That was one bad field. A pressure
campaign built on the same quality of evidence is not journalism, and it
would hand every target a defamation claim and every opponent a reason to
dismiss the true parts.

**But there are five mechanisms that do work, and each has an evidentiary
threshold you can actually clear.**

| mechanism | who | what it needs | do we have it? |
|---|---|---|---|
| **FTC Act §5** — deceptive practices | FTC | advertiser paid for impressions that were not human | **the gap is documented; the specific harm is not** |
| **FEC complaint** | FEC | coordination or an unreported in-kind contribution | **Quintus: 5 committees, 100%, one candidate — this is ready** |
| **State AG consumer protection** | Ohio AG | deception aimed at Ohio residents | needs Ohio-specific creative |
| **SEC disclosure** | SEC | a public company's stated user/engagement figures | **Meta's own 10-K duplicate-account estimate is a published denominator** |
| **R.C. 149.43 / FOIA** | any agency | a record exists and is not exempt | **ready, and idle since this session began** |

**The strongest lever you have is not the bot layer at all. It is the
advertiser layer** — because advertisers are the ones being defrauded when
impressions are fake, they have standing, they have lawyers, and *Feldman v.
Google*, *In re Facebook PPC* and *WickFire v. Woodruff* show that register
has been litigated for twenty years.

**Scrutiny works where there is a duty to answer.** A contracting officer, a
records custodian, a registrant, a filer under penalty. **Push there.**

---

## PART FOUR — THE COMMANDS

Two new ones first, because they close the "unread is unsayable" gap that has
been open since §76.

### A. READ THE DOCUMENTS WE ONLY HAVE TITLES FOR

```bash
git pull

bin/sentinel connect fedreg 2026-00512    # CMS hearing on Minnesota's state plan
bin/sentinel connect fedreg 2026-00596    # Somalia TPS — WHY did this match?
bin/sentinel connect fedreg 2026-05497    # Task Force To Eliminate Fraud
bin/sentinel connect fedreg 2026-03968    # RFI: uncovering suspicious healthcare
bin/sentinel connect fedreg 2025-19928    # 2020-election pardons
bin/sentinel connect fedreg 2026-10817    # Regulation for Federal Financial Assistance
```

**2026-00596 is the one to run first and read hardest.** If the match is
incidental wording, say so and close it. If it cites the prosecution, that is
a finding — and it is a finding about a *federal action*, not about a
community.

### B. GET THE REAL CAPTIONS — repairs §78

```bash
bin/sentinel connect docket "0:20-cv-02312"   # Feeding Our Future v. MDE
bin/sentinel connect docket "0:22-cr-00223"   # the indictment — REAL party table, with roles
bin/sentinel connect docket "0:22-cr-00364"
bin/sentinel connect docket "1:18-cr-00633"   # Methbot — the eight, properly
bin/sentinel connect docket "2:20-cv-13134"   # King v. Whitmer
```

Each prints the caption as the **court** records it, then the party table
**grouped by role**. Defendant means charged. That is the distinction no
search result in this toolkit carried.

### C. INTENSIFY THE MESSAGE LAYER

```bash
bin/sentinel connect awards "Fors Marsh Group" --all --pages 20
bin/sentinel connect vendor "Fors Marsh Group"
bin/sentinel connect senatelda --client "FORS MARSH GROUP"
bin/sentinel connect opencorporates "BLN Fors Marsh JV"

bin/sentinel connect awards "Porter Novelli" --all --pages 5
bin/sentinel connect awards "Ogilvy" --all --pages 5
bin/sentinel connect awards "IQ Solutions" --all --pages 5
bin/sentinel connect awards "Ketchum" --all --pages 5
```

**The question: is Fors Marsh a firm or a category?** If four more firms sit
at the same scale on the same NIH vehicles, the finding is *a market*. If
Fors Marsh stands alone at $1.67bn, the finding is *a firm*. **Those are
different stories and only division tells you which.**

### D. THE VERIFICATION GAP — nail it shut

```bash
bin/sentinel connect awards "HUMAN Security" --all --pages 3
bin/sentinel connect awards "Moat" --all --pages 3
bin/sentinel connect awards "Pixalate" --all --pages 3
bin/sentinel connect awards "Oracle America" --all --pages 8
bin/sentinel connect senatelda --client "INTEGRAL AD SCIENCE"
bin/sentinel connect senatelda --client "DOUBLEVERIFY INC."
```

**If every verification vendor is $0 while every measurement vendor is paid,
that is no longer an anecdote about two companies. It is a procurement
policy, and a procurement policy has an author who can be asked why.**

### E. THE OHIO CASE THAT IS ALREADY COMPLAINT-READY

```bash
bin/sentinel connect vendor "Quintus" --pages 25
bin/sentinel connect control
bin/sentinel connect filings "OHIO FLYER PAC" --form F1
bin/sentinel connect asymmetry --dimension vendor
```

**Quintus is the only thing in this entire investigation that clears a
regulator's threshold today**: five paying committees, all one candidate,
100%, HHI 1.000 — including a super PAC that is required to be independent.
**Everything else needs more work. This needs a cover letter.**

### F. THE HALF OF THE TOOLKIT THAT HAS NEVER RUN

```bash
bin/sentinel pra foia --list
bin/sentinel pra portals
```

Six of seven New Albany questions and the entire Minnesota denominator live
in **state and county** records. **`sentinel pra` has been idle for this whole
investigation.**

---

## PART FIVE — THE FIVE REQUESTS THAT WOULD ACTUALLY MOVE SOMETHING

Ranked by *likelihood of a substantive answer*, not by how interesting the
answer would be.

1. **Minnesota Secretary of State** — every entity with "Housing Stabilization Services" in its name, with incorporation dates. **Gives you the denominator that turns 19 companies from an anecdote into a rate.**
2. **Minnesota DHS** — HSS provider enrolment list with enrolment dates. **Join it to #1 and you have "incorporated N days before enrolling," which is a measurement, not an impression.**
3. **NIH / HHS OASH** — the statement of work behind `75N98021F00001`, the psychographic contract. **The SOW says what "psychographic" meant to the people who bought it.**
4. **NSA/CSS** — the statement of work behind `H982300820011`, the $16,800,000 grant whose description is the single word `RESEARCH`. **Expect a denial; the denial is itself publishable.**
5. **Licking County Auditor** — parcel transfers for the New Albany assembly, with sale prices and dates. **Free, online, and the one on this list nobody has to grant you.**

---

## THE RULE THAT HOLDS ALL OF IT UP

**Pressure is only as durable as its weakest citation.**

A campaign with nine documented facts and one bad name is not 90% right. It
is **finished**, because the one bad name is what the response will be about,
and every true thing you were carrying goes down with it.

**That is why §78 mattered more than the $220 million.**
