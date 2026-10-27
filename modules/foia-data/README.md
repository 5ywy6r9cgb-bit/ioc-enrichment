# foia-data

Offline FOIA annual-report numbers from the agencies' own bulk CSV files
(downloaded from FOIA.gov). Stdlib only. See `docs/OPERATOR_MANUAL.md` section 4d.

Layout expected: `missions/foia/data/y2008|y2024|y2025/` (gitignored; the repo is public).

Verified on the FY2008, FY2024 and FY2025 sets: government-wide received
560,978 / 1,501,432 / 1,707,197 across 71 / 122 / 117 agencies, "All agencies"
total row excluded. Reported figures, not audited.

Not built: the 2025 per-agency XML files (component detail such as the FBI
inside DOJ) need an extractor written against the real tag names.
