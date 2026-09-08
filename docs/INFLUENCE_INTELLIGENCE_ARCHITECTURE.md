# SentinelOS — Government Influence & Public Benefit Intelligence

**Architecture proposal. No code. No migration. Nothing built.**
Companion to `FINANCIAL_INTELLIGENCE_ASSESSMENT.md`, which established that
the assertion ladder must be fixed before any new source is added.

---

## 0. Two corrections and one finding, before the architecture

### 0.1 Correction: JCARR is not the Ohio lobbying registry

I have written "Ohio lobbying (JCARR/OLIG)" in `moneyflow`'s output and in
the previous assessment. **JCARR is the Joint Committee on Agency Rule
Review — it reviews administrative RULES, not lobbyists.** Going there for
lobbying registrations finds nothing, and the nothing looks like an answer.

Ohio legislative and executive agent registration is administered by the
**Joint Legislative Ethics Committee (JLEC)** through the **Office of the
Legislative Inspector General (OLIG)**, and the public search is the **Ohio
Lobbying Activity Center (OLAC)**.

Migration `0004_lobbying.sql` already had this right — its registry default
is `'oh_olac'`. My shorthand was wrong, the schema was not. The string in
`moneyflow`'s footer should be corrected when code next changes.

### 0.2 Correction: JobsOhio is not subject to Ohio public records law

This is the single most important structural fact for Ohio public-benefit
research and it should be stated at the top of any Ohio incentive work.

Ohio's economic development function was moved in 2011 from the Department
of Development to **JobsOhio, a private nonprofit corporation**. It is
funded through a lease of the state's liquor enterprise. It is **not a
public office** for purposes of R.C. 149.43, and records requests to it are
not enforceable the way they are against a state agency. `[UNVERIFIED —
confirm current statutory status at codes.ohio.gov before relying on it]`

Practical consequence for the data-center work: the incentive negotiation
that precedes a site announcement may have **no requestable record at the
state level**. What remains requestable is the downstream residue — the
county/municipal agreement, the tax-increment or CRA ordinance, the school
board's GASB 77 disclosure, the utility interconnection filing. **The
absence of a JobsOhio record is a fact about Ohio's disclosure architecture,
not evidence of concealment, and must never be reported as the latter.**

### 0.3 The finding in your Cornerstone run

You now hold 500 of Cornerstone's 15,124 filings — **3.3%**. In that 3.3%,
367 distinct clients. Inside those 367, in one registrant, simultaneously:

| Layer of the data-centre power stack | Clients in your 3.3% sample |
|---|---|
| Data-centre operator | VANTAGE DATA CENTERS MANAGEMENT COMPANY, LLC |
| Very large electrical load | RIOT PLATFORMS, INC. |
| Compute / silicon demand | GOOGLE CLIENT SERVICES · SAMSUNG SEMICONDUCTOR · ADVANCED MICRO DEVICES · AMPERE COMPUTING · SEMICONDUCTOR INDUSTRY ASSOCIATION · PSIQUANTUM · SNOWFLAKE · PALANTIR · HEWLETT PACKARD ENTERPRISE |
| New generation | TREATY OAK CLEAN ENERGY (5 filings — the top client in the sample) · FERVO ENERGY · MAINSPRING ENERGY · BORDAS RENEWABLE · AGILITAS ENERGY · NELSON ENERGY |
| Retail supply, **Ohio** | INTERSTATE GAS SUPPLY, LLC DBA IGS ENERGY (Dublin, Ohio) |
| Regulated utilities | GEORGIA POWER · MIDAMERICAN ENERGY · AVANGRID MANAGEMENT |
| Fuel cycle | LOUISIANA ENERGY SERVICES DBA URENCO USA · PEABODY ENERGY |

Demand, compute, generation, retail supply and the utility — every layer of
the same stack, inside one firm, on sworn filings.

**And here is the discipline that has to travel with it.**

That is a **lead, not a finding**, for a reason that would destroy the work
if it were skipped: *a firm with 15,124 filings carries everything.* The
base rate is the whole question. Cornerstone also represents Big Brothers
Big Sisters, the National Wild Turkey Federation, NASCAR and forty
universities. A firm that large having both a data-centre client and an
energy client may be no more meaningful than its having both a hospital
client and a college client.

**Shared registrant is the weakest form of this evidence.** The narrow,
publishable version of the claim needs three things the shared-registrant
view does not have:

1. **The same NAMED LOBBYIST on both filings.** A firm is an organisation;
   a lobbyist is a person who was in specific rooms.
2. **The same GOVERNMENT ENTITY contacted**, in both.
3. **The same QUARTER.**

All three fields are already parsed by `lobby.js`, and commit `c611af0` put
all three into the graph as `LOBBIED_FOR`, `REGISTERED_WITH`, `LOBBIED` and
`ON_ISSUE`. **The data is there and there is no query that asks this
question.** `graph --ask` offers `coverage`, `bridges`, `noise`, `firm`,
`thread`, `pair` — none of them reach the person or the agency.

That gap is the highest-value thing in this entire document, and it costs
one query, not a new data source.

---

## 1. HIGH-VALUE RESEARCH DOMAINS — ranked for implementation

Ranking is by **(analytical value) × (evidence quality) ÷ (acquisition
cost)**, against the investigation actually running, not in the abstract.

### Tier 1

#### 1. Regulatory proceedings — PUCO / OPSB

*Promoted above contracts and campaign finance. It is ranked first here and
sixth in your list, and the reason matters.*

| | |
|---|---|
| **Data sources** | PUCO Docketing Information System (DIS); Ohio Power Siting Board (same system) `[UNVERIFIED — access method]` |
| **Primary documents** | Applications, testimony **under oath**, discovery responses, staff reports, stipulations, Commission orders, transcripts |
| **Entity types** | utility, applicant, intervenor, expert witness, law firm, consultant, Commission, ALJ |
| **Relationship types** | `applied_before`, `intervened_in`, `testified_in`, `represented_by`, `settled_with`, `ordered` |
| **Expected evidence** | The strongest tier available anywhere in this list. Sworn testimony, cross-examination, and a docketed decision with a date |
| **Analytical value** | **Highest.** A rate case or siting docket is where the money, the government decision, the public cost and the named participants all appear in ONE document set, already assembled by the agency, with dates |
| **Priority** | **1** |

Why first: every other domain gives you one edge. A PUCO docket gives you
the whole chain — who applied, who objected, who testified, who was paid to
testify, what was decided, when, and what it cost ratepayers — in a filing
that is already indexed. For a data-centre investigation, the **large-load
tariff and interconnection dockets are the single richest source that
exists**, and they are free.

#### 2. Tax incentives and abatements

| | |
|---|---|
| **Data sources** | GASB 77 notes in ACFRs (already read by `doc abatements`); county auditor CRA/EZ agreements; Ohio Department of Taxation biennial Tax Expenditure Report; municipal ordinances |
| **Primary documents** | The audited ACFR; the signed abatement agreement; the enacting ordinance; annual compliance reports |
| **Entity types** | government body, school district, beneficiary company, property |
| **Relationship types** | `abated_taxes_of`, `party_to_agreement`, `bears_revenue_loss` |
| **Expected evidence** | Audited, mandatory, dated, with a dollar figure the government signed |
| **Analytical value** | **Very high** — this is public benefit measured in the government's own numbers, and almost nobody reads it |
| **Priority** | **2** |

The reader already exists. This is the shortest distance between where the
desk is and a public-cost layer. Every figure is a **floor** — TIFs are
generally outside GASB 77, statutory exemptions are not "agreements," and
no cost side is disclosed.

#### 3. Corporate ownership and acquisitions

| | |
|---|---|
| **Data sources** | Ohio SOS business search; Delaware; SEC 13D/G, DEF 14A, 8-K; OpenCorporates (connector exists) |
| **Primary documents** | Articles, foreign registrations, annual reports, merger agreements, proxy statements |
| **Entity types** | corporation, LLC, PE/investment firm, registered agent, officer, director |
| **Relationship types** | `owns`, `subsidiary_of`, `general_partner_of`, `registered_agent_for`, `officer_of`, `director_of`, `acquired` |
| **Expected evidence** | Filed with a state; strong for existence and officers, **weak for beneficial ownership** |
| **Analytical value** | High — it is the spine everything else hangs on |
| **Priority** | **3** |

**The honest limit, and it must be stated wherever this data appears:** an
Ohio or Delaware LLC filing does **not** disclose beneficial ownership. It
discloses a registered agent and sometimes a member. `Vantage Data Centers
OH-E, LLC` tells you a Delaware formation date, an Ohio registration date,
and a status of Dead. It does not tell you who owns it. The `OH-E` suffix
implies siblings A–D; that is an **inference from a naming convention**, not
a filed fact, and must be recorded as `derived` with that reasoning attached.

#### 4. Lobbying

| | |
|---|---|
| **Data sources** | Senate LDA (built, 17,324 rows); House Clerk; **Ohio OLAC** (schema built in migration 0004, no reader) |
| **Primary documents** | LD-1, LD-2, LD-203; Ohio agent registrations and Activity & Expenditure Reports |
| **Entity types** | client, registrant firm, **lobbyist (person)**, government entity, issue |
| **Relationship types** | `lobbied_for`, `registered_with`, `contacted`, `on_issue` |
| **Expected evidence** | Sworn under 2 U.S.C. 1604. Very strong for the relationship; silent on what was said |
| **Analytical value** | High — and **currently under-exploited**, per §0.3 |
| **Priority** | **4** — because the next gain is a QUERY, not a source |

Ohio OLAC has a property the federal LDA does not, and migration 0004
already encodes it: **OLAC shows only CURRENT engagements. Terminated ones
vanish.** So the search that looks like a history is a snapshot, and the
only way to build the history is to crawl nightly and record
`first_seen_on` / `last_seen_on` / `still_present`. The night an engagement
stops appearing is the night you learn it ended. **Every day this is not
running is a day of history that cannot be recovered later.**

#### 5. Government contracts and procurement

| | |
|---|---|
| **Data sources** | USAspending (built, 770+19 rows); Ohio OAKS/procurement `[UNVERIFIED]`; county and municipal purchasing |
| **Primary documents** | The contract, amendments, bid tabulations, sole-source justifications |
| **Entity types** | agency, prime, subcontractor |
| **Relationship types** | `awarded_to`, `subcontracted_to`, `amended` |
| **Expected evidence** | Strong at federal level; state and local vary enormously |
| **Analytical value** | High, with two large caveats |
| **Priority** | **5** |

Two caveats already enforced in `moneyflow`: an award is a **ceiling over a
period, not money moved**; and **amendments are where the story usually
is** — a contract that triples through four amendments is a different fact
from one awarded at the final figure, and only the amendment series shows it.

#### 6. Public-private development

| | |
|---|---|
| **Data sources** | Municipal ordinances and minutes (R.C. 121.22); port authorities; CIC/JEDD agreements; **JobsOhio — see §0.2** |
| **Primary documents** | Development agreement, TIF ordinance, minutes, infrastructure commitments |
| **Entity types** | developer, municipality, port authority, CIC, JEDD, school district |
| **Relationship types** | `party_to_agreement`, `committed_infrastructure`, `diverted_increment` |
| **Expected evidence** | Strong once obtained; **records request, not API** |
| **Analytical value** | Very high — this is where the public cost is actually decided |
| **Priority** | **6** — high value, high acquisition cost |

#### 7. Campaign finance

| | |
|---|---|
| **Data sources** | FEC (connectors built); Ohio SOS campaign finance; **88 county boards of elections** |
| **Primary documents** | FEC Forms 3/3X Schedules A and E; Ohio 30-B reports |
| **Entity types** | committee, candidate, donor, vendor |
| **Relationship types** | `contributed_to`, `spent_supporting`, `spent_opposing`, `paid_vendor` |
| **Expected evidence** | Strong and dated |
| **Analytical value** | High — but see the ranking note |
| **Priority** | **7** |

Ranked last in Tier 1 deliberately, and this is a disagreement with your
ordering worth stating. For **this** investigation, campaign finance is the
weakest Tier 1 domain, because:

- The decisions that matter here are made by **appointed** PUCO
  commissioners, county auditors, township trustees and school boards.
  PUCO commissioners do not run for office.
- Local candidates file with **county boards of elections**, which never
  reach the state system and have no API. The relevant money is the least
  accessible money.
- Federal Schedule E covers only express advocacy by non-candidate
  committees.

It stays in Tier 1 because when it does land it is dated and specific. It
ranks seventh because for a data-centre siting question it will mostly
return silence, and silence here is a library artefact.

### Tier 2

| # | Domain | Sources | Key relationship types | Evidence | Priority |
|---|---|---|---|---|---|
| 8 | **Utility / energy infrastructure** | FERC eLibrary, EIA-860/861, PJM interconnection queue, RTO filings | `interconnects_at`, `serves_load`, `contracted_capacity` | Strong, technical | **8 — arguably Tier 1 for this case** |
| 9 | **Personnel movement** | SEC Forms 3/4/5, DEF 14A, agency ethics filings, LD-2 lobbyist rosters, obituaries/bios | `employed_by`, `officer_of`, `board_member_of`, `registered_as_agent_for` | Mixed; **hardest to source** | 9 |
| 10 | **Property / real estate** | County auditor, county recorder, transfer records | `owns_parcel`, `transferred_to`, `valued_at` | Strong, per-county | 10 |
| 11 | **Litigation** | CourtListener (built), PACER, Ohio Supreme Court/appellate | `party_to`, `settled_with`, `testified_in` | Very strong when it exists | 11 |
| 12 | **Nonprofits / foundations** | IRS Form 990 (ProPublica API), Ohio AG charitable registration | `granted_to`, `officer_of`, `related_organization` | Strong but 12–18 months stale | 12 |

**Utility infrastructure is arguably Tier 1 for the case you are actually
running.** The **PJM interconnection queue** and large-load service requests
are where a data centre becomes visible as an engineering fact — often
*before* any incentive, siting or corporate filing exists. It is one of very
few sources that is **early** rather than retrospective.

**Personnel movement is the hardest and I will not pretend otherwise.**
There is no employment-history database. What exists in fragments: SEC Form
4 (officers and directors of listed issuers, dated), DEF 14A (directors and
their other boards — interlocking directorates), LD-2 lobbyist rosters
(agents by firm by quarter), and agency ethics filings. Each is partial.
Assembling them is largely manual and every derived employment edge needs
its reasoning recorded.

---

## 2. OHIO INTELLIGENCE LAYER

**All access methods below are `[UNVERIFIED]` — I could not reach any
external host. Confirm each before building.**

| Source | Access | Searchable | Entity linkage | Evidence quality |
|---|---|---|---|---|
| **PUCO / OPSB DIS** | Web docket search | By case no., company, date | Strong — parties are named legal entities | **Highest.** Sworn testimony + dated order |
| **Ohio SOS business search** | Web; bulk file may exist | By name, charter no., agent | Strong — charter number is a real key | High for existence/agent; **silent on beneficial ownership** |
| **County auditor** | 88 separate systems | Per county, by parcel/owner | Parcel ID is the key, **not the address** | High; per-county formats |
| **County recorder** | 88 separate systems | By grantor/grantee | Strong | High — the deed is the primary document |
| **Ohio campaign finance (SOS)** | Web + downloadable | By candidate/committee | Moderate | High for state office |
| **County boards of elections** | 88 separate, often none | Frequently paper | Weak | High once obtained; **hardest access in this table** |
| **OLAC (JLEC/OLIG)** | Web agent search | By agent/employer | Moderate | **Snapshot only — see §1.4** |
| **Ohio Tax Expenditure Report** | PDF, biennial | Full-text only | Weak — categories, not entities | High as a statewide denominator |
| **GASB 77 in ACFRs** | PDF per government per year | `doc abatements` reads it | Moderate — beneficiary named inconsistently | **Audited.** Always a floor |
| **Ohio LSC fiscal notes** | Web per bill | By bill number | Weak | High for stated fiscal intent |
| **JobsOhio** | **Not a public office — see §0.2** | — | — | **Structural gap, not an empty result** |
| **Ohio procurement (OAKS)** | Web | By vendor/agency | Moderate | High for the award; amendments often separate |

### The three Ohio-specific traps

1. **The parcel number is the key, not the address.** One address can be six
   parcels; one project can straddle two townships and two school districts.
2. **Market ≠ assessed ≠ taxable.** Ohio assessed value is 35% of market.
   Quoting the wrong one overstates by nearly three times. Already noted in
   the SDCL denominators.
3. **Abatement asymmetry.** When a city abates and a school district loses
   the revenue, both must disclose — and districts routinely disclose far
   less about another government's agreement than about their own. The
   smaller figure is not the smaller loss.

---

## 3. `sentinel investigate ENTITY` — workflow

### 3.1 It must not become a wrapper that hides its own emptiness

The risk is specific: a command that prints sixteen headings will print
sixteen headings whether or not anything is behind them, and a reader
skims past `(none)` sixteen times and concludes the entity is clean.

**Design rule: every section prints one of three states, never two.**

```
DOCUMENTED     n rows, from <sources>
NOT SEARCHED   no capture for this entity from <connector> — run: <command>
NO SOURCE      SentinelOS has no connector for this. Records request only.
```

`NOT SEARCHED` and `NO SOURCE` are different facts and neither is `none
found`. A section with nothing behind it must say **which** of the three it
is, or the command becomes a machine for manufacturing false negatives.

### 3.2 Order of output

Deliberately not your listed order. Ownership and identity first, because
every later section is meaningless if the entity is misidentified.

```
IDENTITY          canonical name, every alias, every registry id
                  SIBLING/SUCCESSOR NAMES NOT MERGED, listed separately
OWNERSHIP         parent, subsidiaries, registered agent, officers
                  (each: documented | derived + reasoning)
PEOPLE            officers, directors, registered lobbyists
MONEY OUT         moneyflow, per kind, never summed
MONEY IN          moneyflow, per kind, never summed
GOVERNMENT ACTION dockets, contracts, grants, incentives, ordinances
PUBLIC BENEFIT    value at stake, per kind (§5)
PROPERTY          parcels, transfers, valuations
LITIGATION        cases, dispositions
TIMELINE          every dated fact above, merged, one line each
RECURRENCE        counterparties/people/agencies also in your other cases
UNKNOWNS          §4 — and this is the section that earns the command
EVIDENCE          every source id, sha256, URL, retrieved_at
```

### 3.3 Two rules carried from `moneyflow`

- **Coverage before findings.** The header states what fraction of each
  source was captured. A profile built on 3.3% of a firm's filings says
  `3.3%` at the top, not at the bottom.
- **No cross-kind arithmetic, anywhere.** Not in the profile, not in
  value-at-stake, not in the score.

---

## 4. THE UNKNOWNS ENGINE

The most valuable section, and the only one that is genuinely novel.

### 4.1 An unknown is a computed absence, not a missing row

An unknown must be **derived from the shape of the evidence**, not from an
empty table. The rule that makes it real:

> An UNKNOWN exists where SentinelOS holds a fact that *implies* another
> fact should exist, and that second fact is absent.

That is falsifiable. "We have no property records" is not an unknown, it is
an empty table. "We have an abatement agreement naming a beneficiary, and no
parcel for that beneficiary" **is** an unknown, because the agreement
implies a parcel.

### 4.2 Implication rules — the seed set

| Held fact | Implies | Unknown when absent |
|---|---|---|
| LDA filing names a client | client is a legal entity | no corporate registration found |
| Corporate registration exists | it has a registered agent | agent not captured |
| `OH-E` suffix | siblings A–D exist | siblings not searched |
| Abatement agreement | a parcel, an ordinance | parcel or ordinance missing |
| Lobbying on an issue in Q_n | a bill, rule or docket in that window | no government action captured |
| Federal award | a contract document, a solicitation | contract text not fetched |
| Data centre announced | interconnection request, large-load tariff | no PUCO/PJM record |
| Person is a registered agent | an employer, a role | employment not established |
| Entity status `Dead` | dissolution, merger or successor | successor not identified |
| Two entities share a lobbyist | same agency and quarter, or not | **agency/quarter never queried** |

### 4.3 Every unknown carries its next action

An unknown that does not tell you what to do next is a complaint.

```
UNKNOWN   Beneficial ownership of VANTAGE DATA CENTERS OH-E, LLC
WHY       Ohio and Delaware registrations disclose a registered agent,
          not a beneficial owner. This is a disclosure-regime limit,
          not a gap in the capture.
IMPLIED BY  Ohio foreign registration 2025-07-10 (status: Dead)
NEXT      1. Ohio SOS filing history — successor or merger
          2. Delaware — formation and any amendments
          3. PUCO/PJM interconnection — the operating entity is named there
          4. County recorder — the deed names the titleholder
CEILING   May be unobtainable. A private LLC has no beneficial-ownership
          disclosure obligation to the public. Record as UNRESOLVED
          MECHANISM (Layer D), never as concealment.
```

That last line is the discipline. **An unknown that cannot be resolved is a
statement about the disclosure regime, not about the subject.**

---

## 5. VALUE AT STAKE

### 5.1 It cannot be one number, for the reason `moneyflow` already proves

Your directive lists thirteen things under `value_at_stake` — contract
value, tax expenditure, rate impact, property-value change, acquisition
price, estimated economic benefit. **These are not the same unit and adding
them produces exactly the meaningless figure `moneyflow` refuses to
compute.**

- A **contract value** is a ceiling that may not be spent.
- A **tax abatement** is revenue never collected — a floor, not a payment.
- A **rate impact** is a recurring cost spread across ratepayers over years.
- An **estimated economic benefit** is a *projection*, usually produced by
  the party seeking approval, and is not evidence of anything but what they
  claimed.

So: `value_at_stake` is a **vector, per kind, each with its unit, its
source, and its assertion type** — never a scalar.

### 5.2 The distinction that carries the most weight

| Class | Meaning | Example |
|---|---|---|
| `PUBLIC_COST_INCURRED` | money the public paid | contract paid, grant disbursed |
| `PUBLIC_REVENUE_FORGONE` | money never collected | abatement, exemption, TIF diversion |
| `PUBLIC_COST_PROJECTED` | a claim about future cost | rate-case impact estimate |
| `PRIVATE_BENEFIT_DOCUMENTED` | a filed private figure | acquisition price, award |
| `PRIVATE_BENEFIT_CLAIMED` | **asserted by the beneficiary** | "will create 300 jobs" |

`PRIVATE_BENEFIT_CLAIMED` must be visually distinct in every output. A
promised-jobs number and a verified-jobs number are two different facts and
*almost every published story confuses them* — the SDCL denominators already
say so under `PUBLICBENEFIT`.

---

## 6. SCRUTINY PRIORITY

### 6.1 What it must never become

A number that sorts entities by suspicion. It sorts **research effort**, and
the difference has to be visible in the output or it will be lost by the
first person who screenshots it.

### 6.2 It is a vector too — never a single number

A single score hides which factor drove it, and a score whose reason cannot
be recovered is unusable in an investigation.

```
SCRUTINY PRIORITY — VANTAGE DATA CENTERS (illustrative shape, not a result)

  financial magnitude       ███░░  documented $400k lobbying; siting value UNKNOWN
  government discretion     █████  PUCO siting + local abatement, both discretionary
  public money at stake     ░░░░░  NOT SEARCHED — no abatement capture
  political activity        ██░░░  8 LDA quarters, no state-level capture
  ownership complexity      ████░  DE parent, OH foreign reg status Dead, siblings implied
  recurring intermediaries  ███░░  Cornerstone — but 3.3% coverage
  personnel overlap         ░░░░░  NO SOURCE
  temporal proximity        ░░░░░  NOT SEARCHED
  cross-case recurrence     ██░░░  IGS Energy also in Ohio energy thread
  EVIDENCE GAPS             █████  ← highest factor

  READS AS: high priority for RESEARCH, driven mainly by what is MISSING.
  This is not a finding about the entity.
```

### 6.3 The counterintuitive rule

**Evidence gaps must raise priority, not lower it.** A naive score rewards
the entity you happen to know most about — so the best-documented subject
looks most suspicious and the opaque one scores low precisely because it is
opaque. That inverts the tool.

### 6.4 What must never enter the score

Anything derived from **inference about intent**. Co-occurrence, timing
proximity and shared intermediaries may raise research priority. They may
not be weighted as though they measured misconduct, and the output label
must be `HIGH PRIORITY FOR REVIEW` — never a risk, likelihood, or
integrity score.

---

## 7. GOVERNMENT ACTION AND PUBLIC BENEFIT — the missing object

The schema has entities, relationships, sources and money. It has **no
object for a government decision**, which is why `outcome` and
`before-after` were unbackable.

Conceptually (not a migration — that comes after the ladder is fixed):

```
government_action
  action_kind    ordinance | resolution | rule | order | permit | award |
                 abatement_agreement | rate_order | siting_certificate |
                 vote | appointment | settlement
  body           the entity that acted
  docket_ref     the identifier IN THAT BODY'S OWN SYSTEM
  decided_on     when
  effective_on   when it bit -- often not the same day
  disposition    granted | denied | modified | withdrawn | settled
  discretionary  boolean -- ministerial vs. discretionary is the whole
                 question for influence analysis
  source_id      the order itself
  beneficiaries  entity refs, EACH with its own assertion_type
```

Two fields carry the weight:

- **`discretionary`** — a ministerial act (a permit issued because criteria
  were met) is not the same object as a discretionary one (a body choosing
  among lawful options). Only the second can meaningfully be influenced, and
  conflating them makes routine administration look like a decision point.
- **`beneficiaries` with per-row assertion type** — the named applicant is
  `documented`. "Who actually benefits" is frequently `derived` or
  `hypothesis`, and the distinction has to live on the row, not in prose.

**`before-after` becomes computable the moment this object exists**, because
you finally have a dated government act to place lobbying, money and
personnel movement around. Until then, `outcome` and `before-after` have
nothing to anchor to.

---

## 8. RECOMMENDED ORDER

Not your ordering. The differences are argued above; here is the whole
sequence with reasons.

| # | Step | Cost | Why here |
|---|---|---|---|
| **1** | **`graph --ask lobbyist` / `--ask agency`** — shared PERSON + shared AGENCY + same QUARTER | one query | Data already in the graph since `c611af0`. Turns §0.3 from a lead into a narrow claim. **Cheapest high-value move available.** |
| **2** | Migration 0008 — assertion ladder | one migration | Nothing derived can be honestly stored until this exists |
| **3** | `government_action` object (§7) | one migration | Unblocks `outcome`, `before-after`, and the discretionary distinction |
| **4** | GASB 77 abatement bridge into `moneyflow` | plumbing | Reader exists; gives `PUBLIC_REVENUE_FORGONE` |
| **5** | **PUCO/OPSB reader** | new connector | Highest-value single source. Sworn testimony + dated orders |
| **6** | **Ohio OLAC nightly crawl** | connector + watch | **Time-critical.** Terminated engagements vanish; unrun days are unrecoverable |
| **7** | Unknowns engine (§4) | analysis | Needs 2 and 3 first |
| **8** | Ohio SOS + county auditor | connectors | Entity spine and property |
| **9** | `sentinel investigate` | orchestration | Last. It orchestrates the above; built earlier it orchestrates emptiness |
| **10** | Value-at-stake vector, scrutiny vector | analysis | Both are views over 1–9 |

**Step 6 is the only time-critical item in this document.** Everything else
can be built next month against the same data. OLAC's terminated
engagements cannot.

---

## 9. THE SENTENCE THE WHOLE ARCHITECTURE HAS TO SURVIVE

Your framing:

> *Where do concentrated private interests, public money, government
> discretion, and recurring institutional relationships intersect — and what
> primary evidence establishes each connection?*

That is a good question and every clause is answerable from filed records.
The one word to hold onto is **"intersect."** An intersection is an
observation. It is not a mechanism, and it is not an intent.

The Cornerstone finding in §0.3 is a real intersection: one registrant
carrying every layer of the data-centre power stack, on sworn filings.
It is also 3.3% of that firm's filings, and that firm carries the National
Wild Turkey Federation.

**Both of those are true at once, and any output that shows the first
without the second is not evidence — it is a claim wearing evidence's
clothes.**
