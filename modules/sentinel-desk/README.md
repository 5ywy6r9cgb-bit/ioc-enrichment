# The Sentinel Desk

A local, offline public-records research desk. Ingest documents, record claims,
enforce GlassMark in code, publish only through a gate you control, and export
a dossier or a findings deck for the video pipeline.

**Dependencies: none.** Python 3.9+ and its standard library. No `pip install`,
no `npm install`, no Postgres daemon, no CDN, no outbound request — ever. It
works on a plane, and it will still open in ten years.

---

## Install

```bash
bash install-mac.sh
```

That checks Python, runs the 44 tests **before** installing anything, creates
`~/Sentinel`, generates an operator token, and puts a `sentinel` command on
your PATH. If the tests fail, nothing is installed.

---

## The five-minute version

```bash
sentinel case new dublin-dfr "Dublin Drone as First Responder" \
    --jurisdiction "City of Dublin, Ohio" --status ACTIVE

sentinel ingest dublin-dfr ~/Downloads/24-295-02.pdf \
    --title "PSA 24-295-02, Paladin Drones (signed)" \
    --custodian "City of Dublin" --request PRR-2026-391

sentinel claim add dublin-dfr \
    "The agreement commits \$328,000 across program years one and two." \
    --tier GREEN
# → BLOCKED: UNCITED. A GREEN claim with no citation cannot publish.

sentinel cite 1 1 --locator "Contract checklist, Section II" \
    --quote "Original Budgeted Amount: \$328,000.00"
# → gates: clear

sentinel export dublin-dfr        # dossier.md + findings.json
sentinel submit dublin-dfr "First packet"
sentinel serve                    # http://127.0.0.1:8787
```

---

## The six tiers

The three you say on air are GREEN, RED APPLE and DEAD END. The other three
exist because they are the three ways a claim gets mistaken for documented
when it is not quite.

| Tier | Means | The gate it must clear |
|---|---|---|
| `GREEN` | Documented, primary source shown | must cite, and cite a **PRIMARY** shelf document |
| `ARITH` | Your arithmetic on documented figures | must carry `--formula` so a reader can redo it |
| `REPORTED` | Another outlet's reporting | must name `--outlet`, every use |
| `RED` | Open question | must **read** as a question and name `--gate` |
| `VERIFY` | Needs re-checking the morning of publish | excluded from every export until re-tiered |
| `DEAD` | Chased, closed by a legitimate answer | must carry `--resolution`; reported, not buried |

## The gates

`BLOCK` gates stop publication. `WARN` gates appear on the dashboard until
someone deals with them.

- **UNCITED** — GREEN/ARITH asserting something documented with nothing cited.
- **PRIMARY_ONLY** — GREEN citing derived work or your own product. A number
  that came out of your own renderer is not evidence the number is real.
- **RED_AS_FACT** — an open question written as a statement, or with no
  named record that would close it.
- **UNLABELED_ARITH** — your division presented as the document's figure.
- **REPORTED_AS_DOC** — reporting presented as a filing.
- **DEAD_UNEXPLAINED** — a dead end with no explanation is just a deletion.
- **RETIRED_FIGURE** — see below.
- **STALE_GATE** *(warn)* — a RED APPLE open more than 45 days.
- **UNSOURCED_DUP** *(warn)* — identical claim text in one case.

## The retired-figure gate

This is the one that earns its keep.

```bash
sentinel correct C-4 "Flock contract total was overstated" \
    --retire 880000 --reason "PO483191 states \$228,000 on its face"
```

From that moment the store refuses any claim containing that figure —
retroactively, across every case, in any formatting. `$880,000`,
`$880,000.00` and `880000` are all the same number to it. You cannot re-make
that mistake by forgetting you made it.

---

## What it holds, and what it refuses to hold

**Holds:** metadata. Titles, custodians, hashes, tiers, citations, locators,
quotes, request status, gate results, decisions.

**Never holds:** the documents themselves. Bytes live in `~/Sentinel/vault`,
addressed by SHA-256, referenced by path. A database that swallows the
evidence is one you can never hand to anyone.

**Refuses outright:** personal identifiers and location signals. Advertising
IDs, hashed emails, device identifiers, IP addresses, raw person-location. The
write is rejected and the rejection is logged. A tool that resolves identifiers
to locations is the same class of thing this newsroom investigates; building
one to investigate one is not a defensible place to stand.

---

## Container detection

The container is read from **magic bytes, never the extension**. This matters
concretely: agencies routinely produce files named `.pdf` that are ZIP
archives of page images. `pdftotext` returns nothing on those, and a careless
pipeline records that as *"no text found"* instead of *"this needs OCR."* The
register tells you which it is, and how many pages.

Run against your own project files, it caught exactly that — one 52-page ZIP
wearing a `.pdf` name.

---

## The audit chain

Every write is an append-only row whose SHA-256 covers the previous row's
hash. Mirrored to `audit.jsonl` so it survives losing the database. Nothing is
ever updated or deleted — a revision is a new row, and the old value stays
readable.

```bash
sentinel verify     # recompute the chain; names the exact row if it breaks
```

---

## The dashboard

```bash
sentinel serve            # http://127.0.0.1:8787
```

Bound to `127.0.0.1` only, and there is no flag in the code to change that. A
case store holding an unpublished investigation should not be one
misconfigured router away from the internet. If a second investigator ever
needs it, that is a deliberate deployment with authentication in front, not a
flag.

Read-only, with one exception: the publication-gate decision, which requires
the operator token, refuses cross-origin posts, refuses a rejection with no
reason, and can only be made once.

Pages: Dashboard · Cases · Evidence · Claims · Records Requests · Corrections
· Publication Gate · Audit Chain · Doctor.

---

## Exports

```bash
sentinel export dublin-dfr
```

- `dossier.md` — findings, evidence register with hashes, open questions with
  their gates, dead ends with their explanations, records-request table, and a
  **Withheld** section listing everything the gates kept out and why. The
  omission is visible rather than silent.
- `findings.json` — the contract the video pipeline eats. Six desk tiers
  collapse to the three that go on screen; ARITH keeps its formula in the
  narration and REPORTED keeps its outlet, so the collapse never loses the
  distinction that made the sub-tier necessary.

Then:

```bash
python3 -m sentinel_video.build \
  --input ~/Sentinel/exports/dublin-dfr/findings.json \
  --out ~/Sentinel/exports/dublin-dfr/video
```

---

## Security self-audit

```bash
sentinel security            # human-readable report
sentinel security --strict   # exit 1 on any FAIL — use as a pre-publish hook
```

Ten checks, each mapped to NIST CSF 2.0, and each *proved at runtime rather
than asserted*: the "zero dependencies" claim is checked by walking every
import; the surveillance boundary is checked by firing a canary through it;
the localhost binding is checked by reading the source that binds. A control
you have not tested since you wrote it is a control you are hoping still works.

It also fails, on purpose, when it should — the test suite tampers with a
vaulted file and an audit row and confirms both are caught. A self-audit that
only ever passes is decoration.

Also on the dashboard at `/security`.

---

## The Defenders curriculum

`defenders/` — five defensive lessons for teaching, in sequence:

1. **Baseline your own network** — you cannot detect abnormal without normal
2. **Verify a file is what it claims** — magic bytes, hashes, chain of custody
3. **Evaluate a tool before you run it** — supply-chain judgement
4. **Segment a home network** — containment as a design property
5. **Write a finding that survives scrutiny** — the capstone, and a writing lesson

Every exercise runs on the student's own machine and own network. No practice
targets, no scanning of third parties, no lesson that becomes an offensive
technique if pointed sideways. Every lesson declares `teaches_offense: false`
and a `scope`, and `check_curriculum.py` fails the build if either goes missing.

```bash
python3 defenders/check_curriculum.py
```

Lesson 3 is the one to teach first if you only teach one. Security people
install more untrusted code than almost any other profession, from more
marginal sources, with less scrutiny — because the thing being installed is
*a security tool*, and the category launders the trust.

---

## Backup

Copy `~/Sentinel`. That is the entire procedure. There is no daemon to stop
and no dump command to remember.

---

## Not built, deliberately

- **Multi-user.** One operator, one machine. Adding accounts means adding an
  auth surface, and that is a different project with a different threat model.
- **Auto-publish.** There is no `--force` on the gate and none will be added.
- **Entity resolution against people.** Matching names across datasets is one
  wrong merge away from libelling a private individual. If it ever gets built
  it lands as a *proposal* a human accepts, never an automatic merge.
- **Anything that turns an identifier into a location.** See above.

---

*Named Sources. Public Documents. Verified Facts.*
