# Sentinel → Replit → reviewed publication

Updated October 10, 2026. Integration plan; the Replit export has not yet been inspected or connected. No Azure resources, Replit deployments or Substack posts are created by this update.

## One system, clear responsibilities

| Layer | Responsibility | Current state |
|---|---|---|
| Mac / Sentinel | Collect public records, preserve original responses, calculate denominators, retain private research | Working Census county-context collector and local HTML report |
| Private GitHub repository | Review source changes, run automated checks, version schemas and methods | Census change prepared for pull-request review |
| Replit app | Search, charts, source panels, timelines and relationship navigation | Awaiting the user's code export; mock data must be visibly marked |
| Substack / printable report | Share selected reviewed claims, methods, sources and corrections | Human publication decision; no automatic posting |
| Azure | Later, a bounded KQL/security learning exercise | Proposal only; separate approval and cost estimate required |

The first Replit connection should read a selected, verified context bundle. It does not need a Census key just to display that bundle. Keep the original Mac captures as the audit record. Moving private evidence to a cloud app requires a separate data-selection decision; do not upload the entire desk or its Git history.

## What to hand over from Replit

Provide the source-code export or a private repository link, package manifest and lockfile, database schema/migrations, start/build instructions, and a list of required environment-variable **names only**. Include a synthetic sample if the app depends on database records. Omit `.env`, live database dumps, private case files, tokens and credentials. A rendered website or screenshot alone cannot establish how its backend works.

Review the export before executing installation hooks: identify its framework, entry points, dependency scripts, network destinations, authentication and storage. Then run it locally, replace one mock dataset, exercise its controls, and only then decide how to deploy it. Exporting code does not prove that database records, attachments, authentication settings or production secrets transferred.

## The first working connection

```bash
cd "$HOME/sentinel"
./bin/sentinel connect census context list
./bin/sentinel connect census context plan
./bin/sentinel connect census context collect
```

`collect` prints a new private output directory. Verify that directory before import:

```bash
./bin/sentinel connect census context verify "/absolute/path/printed/by/collect"
```

Read `context.json` using its `schema: sentinel.county-context/1`. Preserve `profiles`, `receipts`, `metadata_receipts`, geography, vintage, observation period, retrieval time and review flags. Import a complete bundle through a server-side validator or review it locally first. A browser-only JSON import cannot independently verify missing capture files. Failed validation must stay visible; missing data must never become zero.

The current profile has six Ohio counties, four baselines and five rates. It is not a live crime, parcel, power, school-outcome or defense feed. `publication_approved: false` stays false when data are imported. The current verifier specifically expects an unreviewed bundle; later release approval should be a separate record bound to exact file hashes.

## Join records by the thing they actually identify

- Census: dataset + vintage + geography type + GEOID + variable/universe. County context does not describe each person or prove a project's effect.
- Land/energy: county + parcel ID + dated deed/owner record; project ID; permit/docket; utility service territory; school district. New Albany crosses Franklin and Licking counties. Geocode and verify district membership before allocating impacts.
- Lobbying: filing UUID/version, registrant ID, client ID, year/quarter and issues. A registrant's filing count is not its client count. Preserve amendments, report type and whether an amount is income or expense before aggregation.
- Procurement: agency + award identifier + transaction/action date + recipient identifier. Award ceiling, obligation, outlay and payment remain separate. A contractor relationship is not misconduct or intelligence-agency control.
- Schools: district IRN, fiscal/school year, actual versus forecast, and the eligible student cohort. Resident children and ACS adult attainment are not enrollment or school performance.

Every graph edge needs a named predicate, dated source, locator and review state. Keep ambiguous matches as candidates for review. Timelines distinguish event date, filing date and retrieval date. A second opinion gets its own citation and provenance; two articles repeating one original source are not independent corroboration.

## Next three investigations to connect

1. **Land → incentive → school compensation → public services.** Start with one New Albany project and its executed agreement/parcel exhibits, then annual performance, school compensation and actual payment records. County rent/poverty rates supply context only.
2. **Utility proposal → cost allocation → customer effects.** Follow Columbus 2560-2026's proposal and workbooks. Use actual customer classes/accounts and billing periods; Census households are not utility accounts.
3. **Defense/energy contractor → award actions → lobbying filings.** Start with an exact company identifier and specified time window. Retrieve official award transactions and original filings before building a relationship graph. Contracts and lawful lobbying do not establish improper influence.

Prioritize usable records over more keys. Census already works. Repair the known Congress access failure before requesting duplicates. Official local agendas, county GIS, EPA public data and many SEC endpoints can be useful without new paid access; check each source's current terms and technical requirements. Regrid remains pending until actual account access and permitted scope are confirmed.

## Secrets and Azure budget

A future Replit server can read credentials from Replit Secrets. Never place them in browser variables (`VITE_…`, `NEXT_PUBLIC_…`), HTML, source fixtures, URLs or logs. Code collaborators with execution access may be able to read runtime secrets; use minimal access. Static deployments cannot use Replit Secrets for server-side calls. [Official Replit guidance](https://docs.replit.com/core-concepts/project-editor/app-setup/secrets).

Keep Azure credits for the separately approved pilot in `AZURE-PILOT.md`. Check actual balance/expiry and retain the subscription spending limit. Budget alerts **do not stop consumption**, and cost reporting can lag. Do not equate a $5 alert with a $5 hard cap. [Microsoft budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets), [spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit).
