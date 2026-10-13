# Vetted ACS context calculations

`context_metrics.js` is a pure module: no filesystem, environment, credentials or network access. It leaves the existing bounded Census collector unchanged. Its catalog is explicitly reviewed for **ACS five-year 2020–2024 only**, with values and labels checked against official 2024 API table metadata on 2026-10-08.

## Interface

```javascript
const M = require('./context_metrics');
const requested = [...new Set([...M.baselineFields(), ...Object.keys(M.CATALOG).flatMap(M.fieldsFor)])];
// 85 fields including NAME: batch requests; do not send the full union in one API request.
const context = {
  dataset: 'acs/acs5', vintage: 2024, period_start: 2020, period_end: 2024,
  geography: 'county', summary_level: '050', geoid: '39049'
};
// row is a header-keyed Census response map, including NAME and state/county.
const baselines = M.deriveBaselines(row, context); // array: estimate + margin_of_error
const rates = M.deriveProfile(row, context);      // array: percent + margin_of_error_percentage_points
```

`fieldsFor(metricId)` supplies NAME plus required estimate, MOE, estimate-annotation and MOE-annotation variables. `requestGroups()` provides one bounded request field set per derived metric. `parseAndDerive(body, metricId, context)` supports one JSON response geography row only. For bulk collection, the caller validates requested geography coverage, duplicate rows and matching keys while combining batches, then passes individual rows to `deriveProfile`.

All helpers preserve raw components. Missing fields, annotated bounds, suppressed counts, unknown MOEs, invalid geography, incompatible periods and invalid subset counts block derived rates instead of becoming zero. A zero numerator remains valid with its uncertainty. Only the exact controlled-MOE sentinel plus its documented annotation is treated as zero sampling MOE.

The helper does not validate hashes or source-capture paths. Each output says `provenance_verified: false` and `publication_approved: false`; the collector must preserve and independently verify source receipts. Calculated data remain unreviewed.

## Defined rates

| ID | Numerator | Denominator | Meaning and limits |
|---|---|---|---|
| poverty | B17001_002 | B17001_001 | People below the official poverty threshold among people whose poverty status is determined. Not all residents. |
| renter_share | B25003_003 | B25003_001 | Renter-occupied housing units among occupied housing units. Excludes vacant units; not a share of people. |
| rent_burden | B25070_007 + 008 + 009 + 010 | B25070_001 − B25070_011 | Cash-renting units paying at least 30% of income toward gross rent, among units with a computed burden. The excluded not-computed category is returned separately. |
| internet_subscription | B28002_002 | B28002_001 | Households with an internet subscription. Includes cellular-only subscriptions; does not measure infrastructure availability or connection quality. |
| bachelors_or_higher | B15003_022 + 023 + 024 + 025 | B15003_001 | People age 25+ with bachelor’s, master’s, professional or doctorate degrees. Not school enrollment or school quality. |

Baselines remain B01003 population, B11001 households, B25001 housing units, and B19013 median household income in 2024 inflation-adjusted dollars. Medians are not additive.

## Uncertainty

Sums and differences use root-sum-of-squared component MOEs as an approximation; the minus sign used to subtract an excluded count does **not** subtract its squared MOE. A subset proportion then uses the Census subtraction formula, with the ratio addition formula if the radicand is negative. All input MOEs have the same 90% confidence level; output percentages and MOEs are both multiplied by 100. The result explicitly identifies the approximation and fallback.

These formulas omit covariance and may over- or underestimate uncertainty, especially for many combined components. Use published percentages or variance replicate estimates when an important conclusion depends on a narrow difference. The module does not rank differences as significant, compute causal effects or approve publication. No component receives a missing-value replacement of zero.

## Official references

- [B17001 poverty](https://api.census.gov/data/2024/acs/acs5/groups/B17001.html)
- [B25003 tenure](https://api.census.gov/data/2024/acs/acs5/groups/B25003.html)
- [B25070 gross rent burden](https://api.census.gov/data/2024/acs/acs5/groups/B25070.html)
- [B28002 internet subscriptions](https://api.census.gov/data/2024/acs/acs5/groups/B28002.html)
- [B15003 educational attainment](https://api.census.gov/data/2024/acs/acs5/groups/B15003.html)
- [2024 worked examples: sums, differences, proportions and ratios](https://www2.census.gov/programs-surveys/acs/tech_docs/accuracy/2024_ACS_Accuracy_Document_Worked_Examples.pdf)
- [Annotation values and controlled estimates](https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html)
- [Variance replicate tables](https://www.census.gov/programs-surveys/acs/data/variance-tables.html)

## Verification

`node --test test_context_metrics.js` passed **17 offline tests**. Fixtures cover denominator universes, fixed recipes, sum and difference MOEs, invalid/missing/annotated data, exact geography and period matching, controlled estimates, malformed response shapes, percentage-point scaling, and preserving median interpretation. No live fetch or credential use was needed for these tests.
