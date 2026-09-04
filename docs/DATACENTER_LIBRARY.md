# Building the data-center library

Central Ohio data centers, the companies behind them, and the land and power
they consume.

---

## Read this part first

**Your ten connectors are almost all FEDERAL.** They will find company
registrations, federal contracts, federal lobbying, federal litigation, and
federal rulemaking. They are genuinely useful for the corporate skeleton.

They will **not** find the documents this story actually turns on:

| What decides a data center | Where it lives | Connector? |
|---|---|---|
| Siting, zoning, rezoning | city/village council, county planning | **no — records request** |
| Tax abatements (JEDD/JEDZ, CRA, TIF) | city council, county auditor, school board | **no — records request** |
| Land assembly, LLC purchases | county auditor, county recorder | **no — records request** |
| Water and sewer capacity | city utilities, EPA district office | **no — records request** |
| Electric load, interconnection, rate cases | **PUCO**, AEP Ohio, PJM | **no — PUCO docket** |
| Development agreements | city, JobsOhio, One Columbus | **no — records request** |
| State incentives | Ohio Dept. of Development, JobsOhio | **no — records request** |
| Corporate registration | Ohio SOS / OpenCorporates | **yes** |
| Federal contracts | USAspending | **yes** |
| Federal lobbying | Senate LDA | **yes** |
| Litigation | CourtListener | **yes** |

So the library has two halves, and the connectors build the smaller one.
Everything above the line is a records request, which is what the FOIA desk is
for. **The land, the power, and the abatements are the story; the federal
filings are the corroboration.**

One more thing worth knowing going in: data center land is almost always bought
through **single-purpose LLCs with names that say nothing** — that is the
normal practice, not evidence of anything. The county auditor's transfer record
and the LLC's registered agent are how you connect a shell to a parent, and
OpenCorporates is good at exactly that link.

---

## The connector half

One subject, every source that can answer:

```bash
bin/sentinel connect all "Cologix" --into datacenters
```

`--into` **tags** each capture with an investigation name in the provenance
ledger. The files themselves stay in `evidence/captures/` — one directory,
because that is the one `crosslink`, `brief` and `graph` read.

Work the list. Each is one command:

```bash
bin/sentinel connect all "Cologix" --into datacenters
bin/sentinel connect all "Amazon Data Services" --into datacenters
bin/sentinel connect all "Amazon Web Services" --into datacenters
bin/sentinel connect all "Vadata" --into datacenters
bin/sentinel connect all "Meta Platforms" --into datacenters
bin/sentinel connect all "Microsoft" --into datacenters
bin/sentinel connect all "QTS Data Centers" --into datacenters
bin/sentinel connect all "Vantage Data Centers" --into datacenters
bin/sentinel connect all "Aligned Data Centers" --into datacenters
bin/sentinel connect all "New Albany Company" --into new-albany
bin/sentinel connect all "AEP Ohio" --into datacenters
bin/sentinel connect all "American Electric Power" --into datacenters
```

**`Vadata` is not a typo.** It is the Amazon subsidiary that has historically
appeared on data center property and utility filings, and it is the kind of
name that only turns up if you know to ask. Add others as you find them —
every abatement agreement names the actual contracting entity, and that name is
the one worth searching.

`--dry-run` first if you want to see the plan without spending calls. BLS is
skipped automatically: it takes series IDs, not names.

### Then the subject-specific angles

```bash
bin/sentinel connect opencorporates "New Albany" --into new-albany
bin/sentinel connect courtlistener "data center water usage Ohio" --into datacenters
bin/sentinel connect regulationsgov "data center energy consumption" --into datacenters
bin/sentinel connect senatelda "data center energy" --into datacenters
```

---

## Keep it updating

Add these to `watchlist.json` so the 06:00 run brings you what is new instead
of you re-running by hand. Copy into the `watches` array:

```json
{
  "id": "WATCH-DC-01",
  "label": "Data center operators — federal lobbying",
  "connector": "senatelda",
  "query": "data center",
  "cadence": "weekly",
  "investigation": "datacenters"
},
{
  "id": "WATCH-DC-02",
  "label": "Hyperscalers — federal awards",
  "connector": "usaspending",
  "query": "Amazon Data Services",
  "cadence": "monthly",
  "investigation": "datacenters"
},
{
  "id": "WATCH-DC-03",
  "label": "Data center energy — federal rulemaking",
  "connector": "regulationsgov",
  "query": "data center electricity demand",
  "cadence": "weekly",
  "investigation": "datacenters"
},
{
  "id": "WATCH-DC-04",
  "label": "Data center siting and water — litigation",
  "connector": "courtlistener",
  "query": "data center water groundwater zoning",
  "cadence": "weekly",
  "investigation": "datacenters"
},
{
  "id": "WATCH-NA-01",
  "label": "New Albany Company — registrations",
  "connector": "opencorporates",
  "query": "New Albany Company",
  "cadence": "monthly",
  "investigation": "new-albany"
},
{
  "id": "WATCH-AEP-01",
  "label": "AEP Ohio — federal filings",
  "connector": "federalregister",
  "query": "AEP Ohio data center tariff",
  "cadence": "weekly",
  "investigation": "datacenters"
}
```

Then:

```bash
bin/sentinel watch run --id WATCH-DC-01
```

---

## The records-request half — where the story is

These are the ones to file. Each becomes a tracked clock:

```bash
bin/sentinel pra foia add DC-2026-01 "City of New Albany" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "All development agreements, tax abatement agreements, and JEDD/JEDZ agreements executed 2020-present involving data center or high-density computing facilities, including all exhibits and amendments"

bin/sentinel pra foia add DC-2026-02 "Franklin County Auditor" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "Property transfer records and current owner of record for all parcels zoned or rezoned for data center use 2020-present, including grantee entity names"

bin/sentinel pra foia add DC-2026-03 "Licking County Auditor" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "Property transfer records, abatement agreements, and valuation complaints for data center parcels 2020-present"

bin/sentinel pra foia add DC-2026-04 "New Albany-Plain Local Schools" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "All compensation agreements with the City of New Albany or any developer relating to tax abatements 2020-present, and any board resolutions approving them"

bin/sentinel pra foia add DC-2026-05 "City of New Albany" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "Water and sanitary sewer capacity studies, allocation agreements, and correspondence regarding data center demand 2020-present"

bin/sentinel pra foia add DC-2026-06 "Ohio Department of Development" \
    --on 2026-08-25 --via electronic --scope OH \
    --about "All incentive agreements, job creation tax credit agreements, and clawback provisions for data center projects in Franklin and Licking Counties 2020-present"
```

Set the delivery method honestly — `electronic` only if you submit by email or
a portal that gives you a receipt. It decides whether R.C. 149.43(C)(2) damages
could ever be on the table.

Then the desk runs their clocks:

```bash
bin/sentinel pra foia
```

### The school board one is the sharpest

A tax abatement moves money away from a school district, and Ohio districts
usually negotiate a compensation agreement in exchange. **The number in that
agreement, next to the number the district would have collected, is the story.**
It is a public record, it is rarely posted, and almost nobody asks for it.

### PUCO is not a FOIA request

Ohio utility filings are a public docket — search it directly at
`dis.puc.state.oh.us`. AEP Ohio's data center tariff cases are there, and they
contain load forecasts that no press release will give you. That is a manual
source for now; if it proves central, it is worth a connector.

---

## Then the case gate

When a claim starts forming, open a case so the gate holds you to it:

```bash
bin/sentinel case new datacenters "Central Ohio data centers — land, power, abatements"
bin/sentinel case add datacenters EX-1 <the-abatement-agreement.pdf> --kind financial --pages 40
bin/sentinel case status datacenters
```

It will report BLOCKED until every financial exhibit is read to the last page.
For an abatement agreement that rule is not bureaucracy: the compensation
schedule and the clawback terms are in the exhibits at the back, and the exhibits
at the back are what people skip.
