# THREE INVESTIGATIONS
**Gambling. Foreign-registered media. The influencer economy. 2026-09-15.**

Three questions, ranked by how much of each one a register can actually
answer. **One of them needs its method turned around before you run it**, and
that correction is the first section, because running it the other way round
is the fastest way to lose everything else you have built.

---

## 0. THE PUBLICATION GATE — RUN THIS BEFORE ANYTHING SHIPS

You asked that backend details never leak. That is now enforced in code, not
remembered:

```bash
bin/sentinel redact --check modules/openmontage/episodes/ep02
bin/sentinel redact --fix  modules/openmontage/episodes/ep02/builds
```

`--check` **exits 3** when anything leaks, so it can sit in front of a publish
step and stop it. It found real leaks on the first run:

| `builds/*.script.md` | **8 references to an internal doc file.** openmontage renders `source_note` and `delivery` into the shooting script — the artifact most likely to be sent to a collaborator. |
| `episode.json` | `_production` blocks, 38 production-note fields, and an evidence-store path |
| images | EXIF, and **GPS coordinates** if a photo came off a phone |

**Public register URLs are never touched.** `lda.gov/filings/...`,
`federalregister.gov/...`, `courtlistener.com/...` — those *are* the work. A
redactor that strips the citation has destroyed the artifact to protect
nothing.

`--fix` writes a `.clean` copy beside each file and **never edits the
original.**

And the cards are brighter now: `--theme bright`.

---

## 1. GAMBLING — THE STRONGEST OF THE THREE

```bash
bin/sentinel connect sweep gambling --go
bin/sentinel connect sweep prediction_markets --go
```

**This is the best-documented story on your list**, and the reason is
structural: legalisation happened through a legislative record, the operators
are publicly traded so their risk disclosures are filed under oath, and the
prediction-market fight is **already in a federal court record**.

### The question that is answerable

Not *"is gambling bad."* That is a moral claim and a register cannot settle
it. The answerable version:

> **Who spent what, to change which rule, in what order — and what did the
> harm data do afterwards?**

```bash
bin/sentinel connect senatelda --client "AMERICAN GAMING ASSOCIATION"
bin/sentinel connect senatelda --client "DRAFTKINGS"
bin/sentinel connect senatelda --client "FLUTTER ENTERTAINMENT"
bin/sentinel connect senatelda --registrant "AMERICAN GAMING ASSOCIATION"
bin/sentinel connect awards "DraftKings" --all
bin/sentinel connect fecpac "DRAFTKINGS"
bin/sentinel connect fecpac "AMERICAN GAMING ASSOCIATION"
```

### The prediction-market fight is a court case, not an opinion

Kalshi litigated against the CFTC over whether an event contract is a
derivative or a bet. **A judge decided it on a record you can read.** That is
worth ten times any amount of speculation about why apps are addictive.

```bash
bin/sentinel connect courtlistener "Kalshi" --dockets
bin/sentinel connect courtlistener "KalshiEX" --dockets
bin/sentinel connect regulationsgov "event contracts"
bin/sentinel connect federalregister "event contracts"
bin/sentinel connect senatelda --client "KALSHI"
```

**Read the rulemaking and the opinion, not the marketing.**

### THE DENOMINATOR NOBODY PRINTS

Every gambling story quotes handle and revenue. Almost none puts the harm
figure beside it:

> **Problem-gambling helpline call volume, by state, by year** — published by
> state problem-gambling councils and the National Council on Problem
> Gambling.

Put legalisation dates, handle, and helpline volume on one timeline and the
story tells itself with no adjectives. **That is your strongest single
graphic**, and it is free.

### Two register boundaries to say on screen

- **State lobbying is not in the Senate LDA.** Legalisation happened
  state-by-state, and each state's lobbying register is separate — fifty
  offices, none of them in this toolkit. A federal-only search will
  systematically under-count the effort.
- **"Addictive" is a clinical claim.** It needs clinical evidence — DSM
  gambling-disorder prevalence, published studies — not a screenshot of an
  app's push notifications. Say the clinical thing or say the design thing
  ("the product is built to maximise session frequency"), but do not dress
  the second as the first.

---

## 2. FOREIGN-REGISTERED MEDIA — AND THE CORRECTION YOU NEED

You asked: *which journalists are receiving foreign funds — Tucker and those
types, they've been loud lately and I wonder why.*

**I am going to answer the question you can actually run, and tell you plainly
why the version you asked is the one thing in this whole project that could
end it.**

### The problem is the ORDER of the query, not the subject

| **NAME-FIRST** | Pick a journalist whose output you dislike. Search for foreign money. |
| **REGISTER-FIRST** | Open the FARA register. Report who is on it. |

Name-first is motivated reasoning with a **named living target**. You will
find *something* — everybody has co-occurrences — and the something will not
be payment, it will be a shared appearance or a syndication deal or a
namesake. **This desk has already published thirteen names off a bad field
once, and one of them was a defence attorney.** That was a field error. This
would be a method error, which is worse, because the method guarantees you
keep going until you find something.

And "he's been loud lately, I wonder why" is not a hypothesis. It is a
feeling, and it is the exact shape that produces confident wrong answers.

### The register-first version is real journalism and it is free

**Media organisations genuinely do register under FARA**, and that list is
public and closed. Reporting who is on it is ordinary, defensible work:

```bash
bin/sentinel connect sweep foreign_media --go
bin/sentinel connect senatelda --registrant "QORVIS"
bin/sentinel connect senatelda --registrant "MERCURY PUBLIC AFFAIRS"
bin/sentinel connect senatelda --registrant "BGR GOVERNMENT AFFAIRS"
bin/sentinel connect awards "US Agency for Global Media" --all --pages 5
```

Every name in that set is an **organisation** that is a matter of public
record. **Not a person. Not an allegation about any individual's funding.**

### The FARA lookup itself is manual — and it is the top gap

**There is no FARA connector in this toolkit.** `connect test` lists thirteen
and none reads FARA. So:

```
justice.gov/nsd-fara  →  Quick Search  →  filter by registrant or foreign principal
```

Pull the **Supplemental Statement** (activity, income, expenses) and the
**Exhibit AB** (the agreement). Then hash it in:

```bash
bin/sentinel doc get "THE_PDF_URL" --case foreign-media --as EX-01
```

**Building a FARA connector is the single highest-value piece of work left in
this repository.** It is the register that answers your actual question, and
it is the one you do not have.

### What you can say, and what you cannot

| **CAN** | "These media organisations are registered foreign agents. Here is the register, the principal, and the filing." |
| **CAN** | "US government broadcasting is federally funded. Here is the award." |
| **CANNOT** | "This named commentator is funded by a foreign government" — unless you are holding the filing with their name on it. |

If you hold that filing, it is a huge story and you should run it. **If you do
not, there is no version of this that is worth the risk**, and the register
will not produce one by being searched harder.

---

## 3. THE INFLUENCER ECONOMY — WHAT IS AND IS NOT REACHABLE

You already have the strong version of this in `THESIS.md`, and it does not
need a bot farm:

**Persuasion at scale is a procured service with published prices, and the US
government is one of its largest customers.** Fors Marsh at $1,673,787,861 /
710 contracts (a ceiling), 69% from HHS. Contracts that literally read
**PSYCHOGRAPHIC… to TARGET** and **SOCIAL NORMING**. A USAID line item to
*"BOOST FACEBOOK POST TO STRATEGICALLY TARGETED AUDIENCES."* Measurement
bought — Comscore, Nielsen. Fraud verification bought — **$0**. *And both
lobby.*

```bash
bin/sentinel connect sweep message_buyers --go
bin/sentinel connect awards "Fors Marsh Group" --all --pages 20
bin/sentinel connect awards "Integral Ad Science" --all
bin/sentinel connect awards "DoubleVerify" --all
```

### What is not reachable, for anyone

**Who paid for the post you saw.** Meta Ad Library and the FCC Political File
are the only registers that touch it, and neither is built here. And the two
deeper joins — *distribution pattern* and *account authenticity* — **do not
exist outside the platforms for anybody**. Anyone claiming to have made them
from public data is using an undisclosed proxy or lying.

---

## 4. THE WARS — THE ONLY ANGLE A REGISTER SUPPORTS

Ukraine, Iran, Israel, Lebanon, Gaza, Africa, Nepal.

**This desk cannot tell you what is true about a conflict.** No register here
carries battlefield facts, casualty counts, or intent. Asking it to is how a
toolkit built for accountability becomes a toolkit for confirmation.

**What it CAN answer, exactly and with documents:** *which foreign governments
retain which American firms, and on what issues.* That is FARA and the Senate
LDA, it is filed under penalty, and it is almost never reported.

```bash
bin/sentinel connect sweep foreign_lobby --go
bin/sentinel connect senatelda --registrant "BALLARD PARTNERS"
bin/sentinel connect senatelda --registrant "SQUIRE PATTON BOGGS"
bin/sentinel connect senatelda --registrant "AKIN GUMP STRAUSS HAUER & FELD"
```

Then FARA by hand for the foreign-principal side.

**"Countries that are not often talked about" is a real and good instinct, and
the register-first version of it is excellent:** go to the FARA list of
foreign principals and find the governments retaining US firms that get no
coverage at all. That is a genuine, checkable, unreported story — and you get
it by reading a list, not by guessing which conflict is being hidden.

---

## 5. WHAT IS STILL UNRESOLVED — YOUR NEXT PATHS

Run these to find the next thread. All free, no network call:

```bash
bin/sentinel connect coverage                 # which sets are still unasked
bin/sentinel connect nexus --gaps             # joins nothing here can reach
bin/sentinel connect explain --unbuilt        # relationships with no register
bin/sentinel connect box                      # the whole library on one page
```

**Ranked by what each would change:**

1. **A FARA connector.** The register that answers the foreign question. Not built.
2. **Licking + Franklin County parcels.** Free, online, ungranted, still not pulled — and the whole Ohio land story.
3. **Problem-gambling helpline volumes by state.** One manual lookup; turns the gambling story from revenue reporting into harm reporting.
4. **CFTC event-contract dockets and the Kalshi opinion.** Reachable *today* with commands you already have.
5. **State lobbying registers.** Fifty offices. The gambling story is systematically under-counted without them.
6. **Rotate the FEC key**, then `prov verify` the ledger. Still cleartext.
7. **`sdesk`** — the claim layer, still barely used. `sdesk ready` before you record.

---

## THE RULE THAT APPLIES TO ALL THREE

**Register-first, not name-first.**

Open the list and report who is on it. Do not pick a person and go looking.
The first produces a story that survives a lawyer; the second produces one
that ends the project — and it feels identical from the inside while you are
doing it.

**Documents first. Connections second. Conclusions last.**
