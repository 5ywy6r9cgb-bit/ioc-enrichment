# Sentinel Desk — import status in this repo

Brought in from a separate session's environment (`/home/claude/sentinel`,
not reachable from here) on 2026-08-20, from pasted source. **Not yet
runnable** — six of thirteen modules are present; seven exist only as call
signatures inferred from the code that imports them.

## Present, full source, as pasted

| File | Status |
|---|---|
| `sentinel/security.py` | complete |
| `sentinel/server.py` | complete |
| `sentinel/cli.py` | complete |
| `sentinel/__init__.py` | complete |
| `sentinel/__main__.py` | complete |
| `test_sentinel.py` | complete — **one real bug fixed on import**: the pasted version called `sys.exit()` partway through, after the SECURITY SELF-AUDIT section, which made the AUDIT CHAIN section beneath it dead code that would never run. Reordered so AUDIT CHAIN runs before SECURITY SELF-AUDIT, with a single exit at the true end. Also renamed a local `res` variable in the security block that was shadowing the export-section `res` a few lines above — harmless as pasted, but worth not carrying forward. |
| `sentinel/defenders/README.md` | complete |
| `sentinel/defenders/lessons/01-baseline-your-own-network.md` | complete |
| `sentinel/defenders/lessons/02-verify-a-file-is-what-it-claims.md` | complete |
| `sentinel/defenders/lessons/03-evaluate-a-tool-before-you-run-it.md` | complete |
| `sentinel/defenders/lessons/04-segment-a-home-network.md` | complete |

## Missing — referenced everywhere, source never pasted

These seven are imported by the files above but their actual implementation
was never in what you sent me. I have only their *call shape*, inferred from
how `cli.py`, `server.py`, `security.py`, and `test_sentinel.py` use them —
not their logic. I won't guess-write these: this system's whole design
principle is "a claim is checked at runtime, not asserted," and a
reconstructed `gates.py` I invented from test expectations would be exactly
the kind of untested claim it exists to rule out.

| File | Inferred responsibility (from usage, not confirmed) |
|---|---|
| `sentinel/guard.py` | `RefusedInput` exception; `assert_clean(payload, kind=None)` — the surveillance-input boundary (`advertisingId`, `hashedEmails`, `getLocationsFromAID`, `subject_location`, nested) |
| `sentinel/store.py` | `open_db(root)`, `case_by_slug`, `counts`, `default_root`, `audit_mirror`, plus the schema and constants `CASE_STATUS`, `SHELVES`, `TIERS`, `REQUEST_STATUS` |
| `sentinel/audit.py` | `record(conn, kind, actor, subject, payload, mirror=...)`, `verify(conn) -> (ok, msg)` — the append-only hash chain + `audit.jsonl` mirror |
| `sentinel/ingest.py` | `ingest(conn, root, case_slug, path, ...)`, `verify_vault(conn)` — hashing, magic-byte container classification (catches a `.pdf` that's actually a ZIP of page images), vaulting |
| `sentinel/gates.py` | `run(conn, claim_id)`, `run_case(conn, slug)`, `_norm_figure` — the six GlassMark tier checks (GREEN needs a primary citation, RED must be a question with a closing gate, ARITH needs its formula, REPORTED needs its outlet, DEAD needs its resolution, plus the RETIRED_FIGURE gate) |
| `sentinel/export.py` | `write(conn, root, case_slug)`, `submit(conn, root, case_slug, title)` — dossier.md + findings.json generation, the publication-gate submission flow |
| `sentinel/ui.py` | `e()`, `note()`, `page()`, `stat()`, `table()`, `tier_badge()` — the HTML helpers `server.py` renders every page through |

Also referenced but never pasted:
- `defenders/lessons/05-write-a-finding-that-survives-scrutiny.md` — named as
  the capstone in the curriculum README's sequence table; content not sent.
- A `sentinel security` CLI subcommand — `security.py`'s own docstring and
  `server.py`'s `/security` page both say `sentinel security --strict`, but
  `cli.py`'s `build_parser()` has no `security` subparser. Either it exists
  in a version not pasted, or it's a genuine gap in what's live elsewhere too.
- `install-mac.sh` — referenced by `security.py`'s SC-4 fix text as what
  generates `SENTINEL_TOKEN`.

## What to do next

Paste the seven files above (or point me at where they live if this session
can reach it), and I'll drop them in, run `test_sentinel.py` for real, and
report the actual pass/fail — not a predicted one.
