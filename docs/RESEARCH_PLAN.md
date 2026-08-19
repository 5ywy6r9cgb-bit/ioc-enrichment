# Research plan — Ohio politics, money, and the seven counties

How to actually build the understanding you're after, in an order that compounds.

**Scope:** Franklin, Licking, Union, Pickaway, Knox, Mahoning, Fairfield.
Columbus is the anchor; the others radiate out from it except Mahoning, which
is a separate metro (Youngstown) and a deliberate contrast case.

---

## The honest constraint, first

Nobody understands seven counties "completely." What you can build is
**coverage that is systematic and provable** — you know which offices exist,
which you have asked, what they said, and what is still open. That is what
separates an analyst from someone with opinions.

So the goal is not omniscience. It is: *for any question about these counties,
you know where the answer is filed and whether you have it yet.*

---

## The three layers, and where each one is filed

Politics runs on three layers that almost nobody holds in their head at once.
Each has a different filing system, and the gaps between them are where things
hide.

| Layer | Money is filed at | Decisions are filed at | API? |
|---|---|---|---|
| **Federal** | FEC | Congress, Federal Register, agency dockets | **Yes — all three** |
| **State (Ohio)** | Ohio SOS campaign finance; JLEC for lobbying | Ohio Revised Code, PUCO, agency orders | No — web only |
| **County / local** | **County Board of Elections** | Commissioners, council, township trustees, school boards | **No — records request only** |

**The single most important line in that table is the last one.** Local
candidate campaign finance — county commissioner, city council, school board,
township trustee, levy committee — is filed at the county Board of Elections and
**never reaches the state system, and is not in FEC**. No API on earth returns
it. If you only use APIs, local money is invisible to you, which is precisely
where local decisions get made.

That is why `seed_agencies.csv` now carries a Board of Elections row for all
seven counties, and why it is listed first among the eight offices.

---

## What is now seeded

**73 agencies.** Eight offices per county, for all seven:

| Office | Holds |
|---|---|
| **Board of Elections** | local campaign finance, petitions, precinct results |
| Auditor | parcels, valuation, **tax abatements and exemptions**, GIS |
| Recorder | deeds, mortgages, liens, easements |
| Treasurer | tax billing, delinquency, lien sales |
| Clerk of Courts | common pleas civil and criminal |
| Prosecutor | charging decisions, county civil counsel |
| Commissioners | budget, contracts, **economic development agreements** |
| Engineer | road/bridge contracts, right-of-way, change orders |

Every one is `verified_status=unverified` with a VERIFY note, and **no address,
coordinates, or URL is invented**. They are seeded as research targets, not as
confirmed contacts. `sentinel pra portals` and a first records request are what
promote them.

**28 portals**, now including FEC, Senate LDA, Ohio JLEC, Ohio Checkbook, and a
County-BOE row that exists to remind you of the method rather than to link one site.

**6 connectors**, three of them new and aimed squarely at money:

```
fec           who gave, to whom, how much        needs a free api.data.gov key
senatelda     who is paid to lobby, by whom      works anonymously
usaspending   who received federal money         no key at all
```

---

## The order I would actually work in

### Phase 1 — Fix the map before you walk it (1–2 sessions)

Do not start with a subject. Start by making the directory true.

1. `sentinel pra setup` — get Postgres up, load the seeds.
2. `sentinel pra portals` — check every URL in the registry. 15 of 22 original
   portals are unverified, and the 49 new county offices have no URL at all.
3. For each of the seven counties, confirm by hand: does the Board of Elections
   exist under that name, what is its records contact, and does it take email?
   **Seven lookups. This is the highest-value hour in the whole project**, because
   every local money question afterward routes through it.
4. Promote what you confirm to `verified`. Leave the rest unverified — an
   unverified row you know is unverified is an asset; one you assume is fine is a
   liability.

### Phase 2 — Baseline the standing watch (1 session)

```bash
cp modules/watch/watchlist.example.json watchlist.json
sentinel watch run --all --dry-run      # rehearse
sentinel watch run --all                # baseline: everything reports as new
sentinel watch install 8                # daily at 08:00
```

Two of the money watches (`usaspending`, `senatelda`) need no key and work
immediately. Get an FEC key from api.data.gov when convenient.

After the baseline, quiet mornings are real information.

### Phase 3 — One county, all the way down (2–3 sessions)

Pick **Franklin**, because you already have depth there. Build the full picture
for one county before touching a second:

- Commissioners: current budget, every contract over a threshold, every
  economic development agreement in the last three years
- Auditor: every active tax abatement and exemption — *this is where corporate
  subsidy hides in plain sight, and it is a public record*
- BOE: campaign finance for every sitting county officeholder
- Clerk: any litigation the county is party to

Now you have a **template**. Counties two through seven are the same eight
requests with different addresses, which is exactly the kind of work the request
drafter and the clock are for.

### Phase 4 — Follow one entity across all three layers (ongoing)

This is where the system earns itself. Take a single company that appears in a
county contract and run it all the way up:

```bash
sentinel connect usaspending "<company>"     # federal contracts
sentinel connect senatelda "<company>"       # federal lobbying
sentinel connect fec "<company> PAC"         # federal giving
# then, by hand, because no API covers them:
#   Ohio SOS business search  → officers, agents, filing images
#   Ohio JLEC                 → Statehouse lobbying
#   County BOE                → local giving
#   County Auditor            → abatements received
```

A company that lobbies federally, gives locally, and holds a county abatement is
not a scandal — it is *normal*, and knowing the normal shape is what lets you
recognize the abnormal one. Do this for several ordinary entities before you do
it for a suspicious one. Baselines are how you avoid seeing a pattern in noise.

### Phase 5 — Mahoning as the contrast case

Mahoning is in your list and it is not adjacent to the others. Use that. A
different metro, a different political machine, a different set of vendors. When
a practice you thought was suspicious in Franklin turns out to be identical in
Mahoning, you have learned it is a norm, not a finding. That is one of the most
valuable things an analyst can discover, and it is the discovery most often
skipped.

---

## Questions worth asking, per layer

These are shaped so the answer is a document, not an opinion.

**County (records request):**
- Every tax abatement or exemption currently in force, with parcel, recipient, term, and forgone revenue
- Every contract over $25,000 executed in the last 3 years, with vendor and purpose
- Board of Elections: campaign finance for every county officeholder, last two cycles
- Commissioners: minutes and packets for any economic development agreement

**State (web + records request):**
- Ohio SOS: officers, agents, and filing images for each vendor (pull the images, not the summary)
- JLEC: who lobbies the Statehouse for that vendor
- Ohio Auditor Findings for Recovery against the county or its officials
- PUCO dockets where a utility's rate case touches your jurisdictions

**Federal (API):**
- FEC: contributions from the vendor's PAC and its executives
- Senate LDA: registrants, clients, issue codes, spend
- USAspending: awards, subawards, place of performance

---

## The discipline that makes this defensible

Every one of these is already enforced in code, not left to memory:

- A connector hit is a **lead**, not a fact. A name match is not an
  identification — confirm same-entity, then cite the underlying document.
- Everything imports as **unverified**. Custody is not verification.
- **Absence is not proof.** "No records exist" from one office's non-response is
  the `ABSENCE_OVERREACH` gate in your own architecture. A clean OpenSanctions
  result means one list said nothing.
- **Private individuals stay out.** `entities_no_private_home_address` is a
  database constraint. Public officials in their public role are fair; a donor
  who gave $50 is a private person.
- **Corrections run first.** When you get one wrong, that is the thing you
  publish fastest.

---

## On OSINT tooling — what fits and what doesn't

You asked about integrating OSINT tools, Wireshark especially. Being straight
with you saves you a wasted month:

**Wireshark has no role here.** It is a packet analyzer: it reads network
traffic on a wire you control. It cannot tell you anything about a lobbyist, a
county contract, or a campaign donation, because none of those are on your
network. And running it against traffic you do not own is wiretapping, not
research. Your own architecture already draws this line for Nmap and Shodan —
*"defensive visibility only"* — and Wireshark belongs on exactly that side of it:
in `modules/atlas-vuln/`, for defending your own machine. Not in the research
desk.

The tools that *do* belong, in rough order of value to this project:

| Tool | Why |
|---|---|
| **The filing APIs above** | Already wired. This is the real OSINT for politics. |
| **Ohio SOS filing images** | The officers and agents are on the scanned filings, not the summary screen. |
| **DocumentCloud** | OCR + annotation + public hosting for records you receive. Pairs with your `received_records`. |
| **Aleph (OCCRP)** | Cross-document entity search if your corpus outgrows Postgres FTS. |
| **Wayback / archive.today** | Capture a page *before* you cite it. Your `sources.archive_url` column already exists for this. |
| **Datasette** | Fast local browsing of any CSV you receive from an agency. |
| **`ioc_check.py`** | Already yours — but it is security tooling. Keep it in atlas-vuln. |

The pattern: **OSINT for this work means filings, dockets, and registries — not
network tooling.** Network tooling defends the desk; it does not investigate.
