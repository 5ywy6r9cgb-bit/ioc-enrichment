# Conditions brief — Columbus/Ohio, last few weeks

**Compiled:** 2026-08-20
**Method:** WebSearch only. Direct WebFetch of the primary articles (Axios,
Spectrum News, WOSU, NBC4, statenews.org, columbus.legistar.com) was blocked
by this session's network egress proxy on every domain tried — the material
below is built from search-engine result summaries of those articles, not
from the full original text. Treat every item as `REPORTED` tier: a real
outlet said this, but it has not been cross-checked against a primary
document (a council transcript, the PUCO order itself, the bill text) the
way this desk normally requires before something moves to `GREEN`. Anything
below that needs a primary-source pull before it goes in front of an
audience — the pull targets are listed under each item.

No claim below is mine — every one is attributed to the outlet that reported
it. Where only one outlet turned up, that's stated explicitly.

---

## 1. Flock Safety / ALPR — Columbus City Council hearing (Aug 10, 2026)

**REPORTED**, corroborated across WOSU, Axios Columbus, ABC6, NBC4, and
Columbus Underground (independent framing, consistent facts) — the strongest
multi-source item in this brief.

- City Council held a public hearing on the Flock Safety license-plate-reader
  contract at City Hall, ~4 p.m. Monday Aug 10. The session ran **nearly six
  hours**; **55 residents** gave public comment, described by WOSU as
  "overwhelmingly negative."
- A coalition calling itself **Safety Not Surveillance** demanded the city
  cancel all Flock contracts and dismantle the ALPR network. Protesters
  reportedly booed a Flock company representative, who left before public
  comment began.
- The headline statistic in circulation: Columbus police's own audit logs
  reportedly show the city's Flock cameras were **accessed 15,557 times for
  immigration-related purposes between November 2023 and June 2026**.
- Counter-statistic cited by the department: **49% of homicide arrests** in
  the first half of 2026 reportedly involved Flock data.
- No vote was taken or scheduled at this hearing — council said it was for
  information-gathering only.
- This directly continues the thread already in this repo (see the June 2,
  2026 hearing referenced in earlier TSR research: Emmanuel Remy chairing,
  same ICE-access question). Aug 10 appears to be a second, larger hearing
  on the same contract, not a new issue.

**Before this is published as fact, not lead:** the 15,557 figure and the 49%
figure both need to be pulled from the actual CPD audit log release or the
council hearing record — not from a news paraphrase of it. That's a
`records_request` against Columbus PD, or a request for the hearing's
official minutes/video from Legistar (blocked from this session — see
below).

**Primary-source targets, not yet pulled:**
- Columbus Legistar (`columbus.legistar.com`) — hearing minutes, any
  legislation number attached to the Flock contract.
- Columbus PD's audit log release itself (the source of the 15,557 figure).
- `www.axios.com/local/columbus/2026/08/11/flock-camera-hearing-ohio-contract`
- `www.wosu.org/politics-government/2026-08-10/flock-surveillance-cameras-are-watching-columbus-heres-what-to-know`

---

## 2. AEP Ohio / PUCO data center tariff order (Aug 5, 2026)

**REPORTED**, corroborated across Spectrum News 1, NBC4, and syndication via
AOL/Yahoo of what appears to be one wire piece — treat as closer to a single
source dressed up as three.

- PUCO ordered AEP Ohio to implement new ratepayer protections tied to data
  centers, this week of Aug 5.
- Core mechanism reported: large data-center customers must give AEP Ohio
  **180 days' notice** before connecting to the grid, so AEP can pre-buy or
  auction the added power rather than passing an unplanned spike onto
  everyone else's bill. The data-center customer, not other ratepayers, is
  supposed to cover the cost of securing that power.
- Context cited: Columbus-area residential electric bills are reportedly
  **~7% higher** this month than the same point in 2025; summer 2025 bills
  reportedly rose ~$27/month on average from generation-cost increases.
  Ohio is described as having ~200 data centers, about half of them central
  Ohio.

**Ties directly to this repo's existing thread:** the "48-Hour Bill" (HB 646,
see item 3) and this PUCO order are two halves of the same fight — one is
the legislature trying to write data-center rules, the other is the
regulator using existing tariff authority because the legislature stalled.
Worth noting in any writeup that these are not the same action and don't
have the same force: a PUCO tariff order can be revisited by PUCO; a statute
would bind everyone including future PUCO commissioners.

**Primary-source targets, not yet pulled:**
- The PUCO case docket itself (PUCO case search, by case number — not found
  in this search pass).
- `spectrumnews1.com/oh/columbus/news/2026/08/05/puco-orders-aep-ohio-to-set-protections-for-ohioans-against-data-center-energy-costs`

---

## 3. HB 646 ("data center" bill) — still stalled, expected back in November

**REPORTED**, corroborated (Ohio Municipal League, Statehouse News Bureau,
Ohio House GOP release, farmoffice.osu.edu, signalohio.org, civiccapacity.com
— genuinely independent outlets agreeing on the same facts). This is the
most solid single item in the brief.

- No material change since the June 10 collapse already documented in this
  repo's earlier TSR research (see "THE OPERATOR'S COMPASS" / 48-Hour Bill
  material). The bill remains parked in the Senate Energy Committee.
  Legislative leaders quoted as expecting the General Assembly to pick it
  back up when it returns from recess in **November 2026**.
- Substance unchanged from what's already on file: data centers pulling
  ≥250 MW/month would have to offset their own grid draw; the sales-tax
  exemption on qualifying equipment would drop from 100% to 50% for new
  agreements; local property-tax abatements capped at 50% of improved
  value; data centers excluded from "megaproject" status going forward.
- **Confirmed nothing new to report here** — this item exists in the brief
  mainly to confirm the November timeline still holds as of mid-August, for
  anyone tracking the case for a follow-up story.

---

## 4. DeWine executive order — recovery-housing oversight (~Aug 11, 2026)

**REPORTED**, single outlet found (Statehouse News Bureau/statenews.org) —
treat as a lead until a second source or the executive order text itself is
pulled.

- Governor DeWine issued an emergency executive order giving the Ohio
  Department of Behavioral Health direct authority to certify/vet addiction
  recovery houses, rather than relying solely on third-party accreditors
  (Ohio Recovery Housing, Oxford House Inc.).
- Cited growth: recovery houses in Ohio reportedly grew from **356 in 2022**
  to **over 1,700 in 2026** — the scale cited as the reason for the order.
- The order is time-limited (120 days); DeWine has reportedly asked JCARR
  (the legislature's Joint Committee on Agency Rule Review) to make it
  permanent through rule.
- Not Columbus-specific, but central Ohio has a large share of the state's
  recovery housing stock, so this is a legitimate local-impact thread if
  anyone wants to localize it (e.g., how many Franklin County recovery
  houses exist, how many are currently accredited by the two named
  organizations).

**Primary-source target:** the executive order itself, on governor.ohio.gov
— not pulled this pass (that domain wasn't blocked in the earlier
`governor.ohio.gov` hits from search, worth a direct WebFetch attempt next
time).

---

## 5. Lower-priority / not independently verified this pass

Flagged briefly so nothing gets lost, none of these were pulled in enough
depth to write up responsibly yet:

- **COTA Line 99** — new bus route connecting the airport to downtown/OSU,
  approved by the COTA board, targeted for ~2028 (ahead of the airport's new
  terminal opening ~early 2029). Single-source (NBC4 via search summary).
- **Columbus PD officer-involved shootings** — two separate incidents
  surfaced in this pass: an Aug 7 traffic-stop/standoff on Errington Road
  (officer grazed by a bullet, suspect Brandon Burtyk in custody facing at
  least one felony-assault count) and an Aug 18–19 incident on Gibbard
  Avenue in Milo-Grogan (two women hospitalized, an officer discharged a
  weapon, department says the officer's shot did not strike the women).
  Both are single-outlet, breaking-news-desk level detail — not verified
  against a CPD incident report or bodycam release. Do not publish either
  as settled fact without pulling the incident report.
- **Zoning reform Phase II** — ongoing citywide land-use rewrite affecting
  roughly 43% of the city's parcels (~66,000). No August 2026 vote confirmed
  in this pass; most recent concrete date found was a January 2026 council
  consideration of the land-use map. Needs a Legistar pull to find the
  current status, not a news search.
- **Franklin County Board of Commissioners** — no substantive August news
  surfaced; only finding was a canceled rezoning hearing. Likely means
  nothing happened, not that something was missed, but flagging since a
  canceled hearing sometimes indicates a story (why was it pulled?).

---

## What actually blocked this from being a fully sourced desk report

Every attempt to `WebFetch` the primary article or the primary government
record (Axios, Spectrum News, WOSU, NBC4, statenews.org, and
`columbus.legistar.com` itself) came back `EGRESS_BLOCKED` from this
session's network proxy. That is a session/environment limitation, not a
"these sources don't exist" finding — the material is real and multiply
corroborated by independent outlets in the search results, but this desk's
own standard (a claim needs a primary document, not a paraphrase of one)
isn't fully met yet for anything above. The `governor.ohio.gov` domain
appeared to work in search-result attribution and is worth trying directly
next session; Legistar and the news domains above did not.

**Recommended next step, in priority order:**
1. Public-records request to Columbus PD for the Flock audit-log export
   behind the 15,557 figure (this is the single highest-value document in
   this brief — it's the number driving the whole council debate).
2. Try `columbus.legistar.com` and `governor.ohio.gov` again from a session
   without the current egress block, to pull the Flock hearing minutes and
   the recovery-housing executive order text directly.
3. PUCO case-docket lookup for the Aug 5 AEP Ohio order (case number not yet
   identified — needs a search on PUCO's own docketing system, not general
   web search).
