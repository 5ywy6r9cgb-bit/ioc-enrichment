# modules/routes: the route ledger (routes/1.0.0)

Every number in the ledger, traced to every finding it serves, and marked:

- **IS**: concrete now. The record says it today, checked at its locator.
- **WAS**: concrete for a stated past date or period, per the record. It says nothing about today.
- **OPEN**: not concrete. That covers a question, a lead, an allegation, a contested number or a gap. Every OPEN line names the record that settles it, when one is known.

The module never edits the ledger. It reads two inputs:

- `evidence/ledger/current.json`, or any ledger JSON or `sentinel_master.sqlite` given with `--ledger`;
- every **strength pass** in `evidence/ledger/passes/`.

A strength pass is a `tsr.supplement/1` file. It records what primary records said when the desk went and looked:

- `confirms`: a second record agrees with a ledger row.
- `contests`: a record contradicts a row. The row turns OPEN until the desk rebuilds it.
- `resolves`: a record settles an unresolved row.
- `answered`: a finding's question now has an answer.
- `adds`: new rows. These are carried as *proposed* and kept out of the counts.
- `corrections_proposed`: corrections for the desk to accept or reject.

## Commands

```
bin/sentinel-routes build                 routes.json + routes.csv in evidence/ledger/
bin/sentinel-routes finding F-OH-03       every route into one finding
bin/sentinel-routes row MF-UDP-IE01       every finding one number feeds, and its divisions
bin/sentinel-routes denominators --flagged
bin/sentinel-routes open --p1
bin/sentinel-routes ladder                where every finding stands; `ladder F-ID` for one
bin/sentinel-routes pass SP-04            one strength-pass item in full
bin/sentinel-routes ie-audit --notices FILE
bin/sentinel-routes verify                SAME or DIFFERENT against the saved routes.json
bin/sentinel-routes selftest
```

Add `--json` to any read command for machine output.

## How a row gets its state

The rules are applied in order; the first one that matches decides.

1. **Contested by a pass**: OPEN.
2. **Resolved by a pass**: IS, with the new reading.
3. **Relationship rows**:
   - alleged: OPEN;
   - resting on a desk note or secondary report: OPEN;
   - otherwise WAS if dated, IS if not.
4. **Not found at its locator** (FAIL, NOT_FOUND, UNCHECKED): OPEN.
5. **Evidence class DESK_NOTE or SECONDARY_REPORT**: OPEN, as a lead.
6. **ALLEGED_TRANSFER**: OPEN. Never read as fact.
7. **UNRESOLVED or MISLABELLED**: OPEN.
8. **Document statements**: IS. These are contract schedules, contract terms, budget requests, program estimates and thresholds. Each carries the reading it must never be given, for example "a scheduled amount, not a payment".
9. **SHARE and RATIO**: WAS, because they are calculated from dated rows.
10. **Everything else** is a dated register row: WAS. The state notes when a second record agrees.

A floor (`is_floor`) always carries "at least this much".

## Divisions

Every arithmetic check written as `A ÷ B` is parsed into a numerator and a denominator. A division is flagged when any of these is true:

- an input is OPEN;
- an input is a floor;
- the inputs have different snapshot dates or come from different records;
- a pass contests an input or the result.

## The ladder

Each finding has a rung from its publication status:

| Rung | Status |
|---|---|
| 0 | held |
| 1 | question |
| 2 | publish after verify |
| 3 | publish with attribution |
| 4 | corroborated |

- **Blockers**: contested numbers, leads, failed numbers, open records, open corrections, and corrections proposed by a pass.
- **Next steps**: each open record's action and URL, marked when it would contact someone and so needs your authorization.
  - A record a pass has already worked shows as a review step instead.

## The IE audit

`ie-audit --notices independent_expenditure_2026.csv` compares every independent-expenditure row in the ledger with the FEC's 24/48-hour notice file. The file is at <https://www.fec.gov/files/bulk-downloads/2026/independent_expenditure_2026.csv>, and each notice is counted once. Each row's notices are counted up to its snapshot date.

| Class | Meaning |
|---|---|
| DOUBLED | Twice the notices: the row was counted as a notice and again on Schedule E. |
| MATCHES | Equal to the notices. |
| OVER | Higher, but by less than double. |
| UNDER | Lower. Usually a page-capped floor. |
| NO NOTICES | Nothing to compare. |

To rebuild a row cleanly, use each committee's periodic Schedule E (`is_notice=false`) plus any later notices, each counted once.
