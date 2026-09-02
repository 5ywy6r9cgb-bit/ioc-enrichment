# Records requests — drafting batch, 2026-08-19

Ten Ohio public-records requests, grounded in the investigations documented in
your own architecture and ratification records — **not** in news I cannot verify
from here. Each is scoped narrow enough to get a clean answer and wide enough to
matter.

## How to use these

1. **Confirm the custodian first.** Every `[VERIFY: …]` marker is a fact you must
   check before sending — an office name, an email, a URL. Do not file a request
   to an address I guessed; I have deliberately not guessed any.
2. **Fill the brackets.** `[YOUR NAME]`, dates, parcel numbers.
3. **File it, log it.** Once sent, record it in the tracker so the clock starts.
   Ohio sets no fixed deadline (R.C. 149.43 says "promptly" / "reasonable"), so
   the clock here is *your* follow-up cadence.
4. **These are drafts.** Re-read every statutory citation against
   codes.ohio.gov before you rely on it. The drafter's rule stands: an
   unverified citation is not sendable.

Standing language, reused below:

> Under the Ohio Public Records Act, R.C. 149.43, I request copies of the
> following records. I am not required to state my identity or purpose, and I ask
> that you provide the records in electronic form where they exist electronically.
> If any portion is withheld, please cite the specific exemption in writing and
> release all non-exempt portions (R.C. 149.43(B)(1)). If you expect the cost to
> exceed $20, please tell me before proceeding.

---

## A. The money — HB6 / FirstEnergy thread

### REQ-01 · Ohio JLEC — Statehouse lobbying on energy legislation
**File with:** [VERIFY: Ohio Joint Legislative Ethics Committee, jlec-olig.state.oh.us — confirm records contact]
**Basis:** R.C. 149.43; JLEC records under R.C. 101.70+

> All lobbyist registration statements and expenditure/activity reports referencing
> "energy," "electric," "nuclear," "FirstEnergy," "HB6," or "House Bill 6," filed
> between January 1, 2019 and the present. Include the registrant (firm), the
> employer/client, the legislative agents named, and any reported expenditures.

*Why: federal LDA does not cover the Statehouse. This is the only place Ohio
legislative lobbying is filed.*

### REQ-02 · Ohio SOS — business filings for the entities of record
**File with:** [VERIFY: Ohio Secretary of State — businesssearch.ohiosos.gov is a search, not a request intake; confirm whether you need the search or a certified-copy request]

> Certified copies of all filed images — articles, statements of continued
> existence, agent changes, and any merger or dissolution filings — for
> [ENTITY NAME(S)], charter number [VERIFY], from formation to present.

*Why: officers and agents are on the filing images, not the summary screen. Pull
the images.*

---

## B. The cameras — Flock ALPR thread

### REQ-03 · Municipal Flock contract and the blank exhibit
**File with:** [VERIFY: the specific city/agency holding PO483191 — your record notes it; confirm the current records custodian]
**Basis:** R.C. 149.43

> A complete, unredacted-to-me copy of purchase order PO483191 and the underlying
> contract, statement of work, and all exhibits and attachments, including any
> exhibit currently blank or marked "intentionally left blank." Include all change
> orders, renewals, and amendments through the present, and any data-sharing
> addendum governing the sharing of automated license-plate-reader data with other
> agencies or with the vendor.

*Why: your record flags a blank Exhibit A. The exhibit is the substance.*

### REQ-04 · ALPR data-sharing and audit logs (aggregate, no PII)
**File with:** [VERIFY: same agency as REQ-03]

> For the period January 1, 2024 to present, aggregate records sufficient to show:
> (a) the total number of ALPR searches performed by this agency's personnel;
> (b) the number of those searches run against any shared or national network;
> (c) the audit-log fields captured for each search (e.g., user, date, reason,
> case number) — the field list and counts, **not** the individual search
> records. I am not requesting any personal data or individual plate reads.

*Why: mirrors your own Flock case-number analysis. Ask for the shape of the log
and the totals, which are non-exempt, not the reads.*

### REQ-05 · Surveillance-vendor procurement — the industry angle
**File with:** [VERIFY: county Commissioners or city purchasing, per county]

> All contracts, purchase orders, quotes, and communications from January 1, 2023
> to present with any of the following vendors or their subsidiaries: Flock Safety,
> Flock Nova, Lucidus Tech, CodeFour, or any vendor of "location intelligence,"
> "device-location," or "advertising-ID"–based location services. Include the
> scope of services and any data-handling or privacy terms.

*Why: connects the leaked client (LEAK-LOCATIONAPI-001) to public procurement —
who in your seven counties is buying location surveillance.*

---

## C. The water / cooling lane

### REQ-06 · Wholesale water/sewer service agreements
**File with:** [VERIFY: City of Columbus DPU — DPUpublicrecords@columbus.gov is on file; confirm it still routes]

> All current and historical wholesale or inter-municipal water and sewer service
> agreements between the City of Columbus and any other jurisdiction, from 2015 to
> present, including rate schedules, capacity commitments, and any provisions
> addressing large-volume industrial or data-center customers.

### REQ-07 · Data-center utility and abatement records
**File with:** [VERIFY: the auditor of the county where the facility sits — Franklin, Licking, or Union per site]

> For any data-center or large-load facility in [COUNTY], all tax abatement or
> exemption agreements currently in force, including the recipient, parcel ID,
> term, the value abated, and the forgone revenue by year; and any enterprise-zone
> or community-reinvestment-area agreement covering the same parcel.

*Why: abatements are where corporate subsidy sits in plain sight, and they are
public records.*

---

## D. County baseline — repeat per county

### REQ-08 · County contracts over threshold
**File with:** [VERIFY: County Commissioners' clerk, each county]

> A list of all contracts and purchase orders executed by [COUNTY] and its
> departments valued at $25,000 or more, from January 1, 2023 to present, showing
> the vendor, amount, purpose, and executing department. A spreadsheet or database
> export is preferred.

### REQ-09 · County tax abatements in force
**File with:** [VERIFY: County Auditor, each county]

> A list of all active real-property tax abatements and exemptions in [COUNTY],
> showing the recipient, parcel ID, program (CRA, enterprise zone, TIF, etc.),
> term, and the value exempted for the most recent tax year.

### REQ-10 · Local campaign finance — the API blind spot
**File with:** [VERIFY: County Board of Elections, each county — confirm intake]
**Basis:** R.C. 149.43; campaign finance under R.C. 3517.10

> Copies of the most recent two campaign-finance reports filed by each currently
> seated [COUNTY] county officeholder (commissioners, auditor, treasurer, recorder,
> clerk, prosecutor, engineer, sheriff), and by any county-level candidate
> committee active in the most recent election cycle.

*Why: this exists in no API. It is the single most important local-money request,
and it must go to the BOE directly.*

---

## Filing order I'd suggest

1. **REQ-10** for Franklin first — it's the blind spot and the highest value.
2. **REQ-08 + REQ-09** for Franklin — establishes the county-contract and
   abatement baseline you'll replicate across the other six.
3. **REQ-03 + REQ-04** — the Flock thread has the most documented specificity.
4. The rest as the earlier ones come back and sharpen the questions.

File no more than you can track. Ten open requests with a running clock beats
thirty you lose count of.
