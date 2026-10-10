# Local context desk

Installed entry point: `./bin/sentinel connect census context`. Uses the existing private Census key loader; no new key or npm dependency is required. It collects official ACS five-year 2020–2024 data only. It is a local research/reporting tool, not a Microsoft Sentinel deployment.

## Three commands

```bash
cd "$HOME/sentinel"
./bin/sentinel connect census context list
./bin/sentinel connect census context plan
./bin/sentinel connect census context collect
```

`list` and `plan` are offline and write nothing. `collect` creates a new private directory under `evidence/context/` and prints its location. Open that directory's `index.html` for the interactive charts; no server or external scripts are needed. Existing output directories are never overwritten. For a custom output, its parent must already exist.

```bash
./bin/sentinel connect census context collect --counties 049,089,129 --output "$HOME/sentinel/evidence/context/my-new-run"
./bin/sentinel connect census context verify "$HOME/sentinel/evidence/context/my-new-run"
```

Default county selection: Delaware 041, Franklin 049, Licking 089, Pickaway 129, Pike 131, Scioto 145; state Ohio 39. Columbus is a city, not Franklin County. New Albany crosses Franklin and Licking counties. Piketon is in Pike County. These counties were chosen for this research desk; they are not a random sample or full Ohio coverage. Requests allow 1–20 unique exact county FIPS codes; wildcards and unreviewed vintages are refused.

## What is collected

- Baselines: population, households, housing units and median household income.
- Rates: poverty; renter share; cash-rent burden of at least 30% among computable cases; internet subscriptions; bachelor's degree or higher among adults 25+.
- Two bounded data batches and nine table-metadata responses for the default profile. Every requested county must return exactly once in each batch. Errors or missing counties block a complete report.
- Output: `context.json`, `metrics.csv`, `BRIEF.md`, `index.html`, `verification.json`, exact source responses and the existing provenance ledger format. Failure states are recorded in `failure.json`; failed queries are never represented as zero findings.

The dashboard has measure/county selectors, percentage bars with 90% MOE ranges, an exploratory scatterplot, source links, denominators and component calculations. Pearson r is descriptive, unweighted and does not propagate survey uncertainty; it is not a causal test or a population-wide estimate. Do not promote it into a headline without further analysis.

## Evidence contract

`verify` recomputes estimates and rates from the stored raw responses and checks source hashes, exact query fields, requested county set, metadata receipts, survey period and saved derived values. It reads only within the selected output directory. This supports reproducibility, not authentication of an entirely rewritten bundle or approval to publish. Metadata response presence does not prove the operator correctly interpreted every variable.

Every value retains its universe, units, vintage, raw annotation and sampling uncertainty. Suppressed or unusable values remain missing. Missing MOEs block rates. Medians are not summed. Multi-cell sum/difference MOEs use an approximation without covariance, followed by the Census subset formula or labeled ratio fallback. These do not capture nonsampling error. See the accompanying metric-method document and official Census accuracy guidance.

## What remains to collect

See `source_inventory.json` and `EVIDENCE-LIMITS.md` for the reviewed source plan. No crime incidents, school administrative outcomes, environmental measurements, parcel ownership or utility-account data are included by this command. Next integrations should validate actual downloaded schemas and coverage before adding charts:

1. Ohio school aggregate report-card/workbook data: district IRNs, school year, suppression and eligible cohorts.
2. Crime: agency ORI, offense units, reporting months and corresponding population served. Validate the current FBI API before installing a connector.
3. Land/public incentives: parcel IDs and county, executed agreements, compensation terms, annual performance and actual payments.
4. Environment/utilities: facility and permit IDs, time, watershed/service territory and measured releases/usage. Emissions are not individual exposure; households are not utility accounts.

## Security and publication

Credentials are loaded locally, never shown in planned/saved URLs. Credential echoes are refused before writing. HTTP failures are surfaced without provider error text. HTTPS hosts are fixed; redirects are refused; each response has a size/deadline bound. The output directory is private, reports contain no remote scripts or network calls, and browser content is escaped. No auto-scheduling, database writes, Azure deployment or publication happens.

Before sharing, review every claim, conflicts/counterevidence, source coverage, uncertainty and whether the selected geographic comparison answers the question. The report deliberately stays `publication_approved: false`.

## Tests

```bash
node --test modules/connectors/test_census.js modules/connectors/test_census_desk.js modules/connectors/test_census_phase3.js modules/connectors/test_context_metrics.js modules/connectors/test_context_desk.js modules/connectors/test_context_report.js
```

The prior scalar Census interface is retained, with added exact county-subdivision, block-group and typed school-district geographies and a paired `census poverty` command. Census school-district population is not student enrollment. The new multi-metric context report currently supports counties only.

## Replit integration

Use [REPLIT-HANDOFF.md](REPLIT-HANDOFF.md) for the local-to-app workflow and [REPLIT-BUILD-PROMPT.md](REPLIT-BUILD-PROMPT.md) after the app export has been reviewed. These documents do not deploy an app or transfer credentials.
