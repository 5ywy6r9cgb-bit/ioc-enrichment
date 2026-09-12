# SENTINEL — COMPLETE COMMAND INVENTORY
**Every exposed verb. Verified by running it. 2026-09-12.**

Each entry is marked:

| ✅ | **VERIFIED** — run on this date, output seen |
| ⚠️ | **EXISTS, UNVERIFIED** — dispatches to a real file, not exercised |
| ❌ | **NOT BUILT** — advertised somewhere, no code behind it |
| 🚫 | **BLOCKED** — built and working, host unreachable |

**Nothing in this file is a placeholder.** No angle brackets — zsh reads `<`
as redirection and it has killed a paste twice.

---

## 1. `connect` — the register layer · 24 verbs

### Meta
| ✅ | `connect test` | every connector, key shape, live probe |
| ✅ | `connect list` | subject sets |
| ✅ | `connect brief` | the day's digest |
| ✅ | `connect crosslink` | entities in more than one source |
| ⚠️ | `connect graph --push` | Neo4j — **password still a placeholder** |

### Search
| ✅ | `connect all "NAME"` | 8 connectors, one subject |
| ✅ | `connect sweep bot_economy --go` | a whole set · omit `--go` for the plan |
| ✅ | `connect expand --limit 181` · `--status` · `--again` | walk outward, resumable |
| ✅ | `connect opensanctions "NAME"` | sanctions / PEP |
| ✅ | `connect courtlistener "NAME"` | **published opinions by default** |
| ✅ | `connect courtlistener "NAME" --dockets` | **RECAP — what you actually want** |
| ✅ | `connect federalregister "NAME"` | full-text search, phrase-quoted |
| ✅ | `connect regulationsgov "NAME"` | rulemaking dockets and comments |
| ✅ | `connect senatelda --client "NAME"` | who lobbies FOR them |
| ✅ | `connect senatelda --registrant "FIRM"` | who they lobby for — **a different question** |
| ✅ | `connect opencorporates "NAME"` | company registries, 140+ jurisdictions |
| 🚫 | `connect usaspending "NAME"` | works for you, blocked from my environment |
| ⚠️ | `connect bls` | takes an identifier, not a name — skipped by sweeps |

### Read a document — built this session
| ✅ | `connect fedreg 2026-00596` | metadata + the agency's abstract |
| ✅ | `connect fedreg 2025-19928 --text --limit 200` | **full text — Presidential documents carry NO abstract** |
| ✅ | `connect fedreg 2026-00596 --grep "Minnesota"` | **WHY did a search match** — occurrences with context, or NOT PRESENT |
| ✅ | `connect docket "0:20-cv-02312"` | caption as the **court** keeps it |
| ✅ | `connect docket "0:22-cr-00223" --court mnd --limit 8` | **party table BY ROLE** |

**`--grep` is the only command here that can KILL a lead.** It is what
resolved §83 and it is worth more than most of what finds things.

### Money
| ✅ | `connect awards "NAME" --all --pages 15` | 5 instrument families |
| ✅ | `--contracts --grants --direct --loans --other` | one family at a time |
| ✅ | `connect vendor "FIRM" --pages 25` | which committees PAID this name |
| ✅ | `connect fecpac "COMMITTEE"` | one committee's money |
| ✅ | `connect donors` · `connect filings "NAME" --form F1` | |
| ✅ | `connect member "NAME"` · `connect delegation` | |
| ✅ | `connect asymmetry --dimension vendor` | concentration, HHI |
| ✅ | `connect control` | shared officers across committees |
| ✅ | `connect matrix` | 8 CSVs + a ranked worklist |

---

## 2. `sdesk` — the claim layer · 16 verbs

**This decides whether you may publish a sentence.**

| ✅ | `sdesk doctor` | is the desk healthy |
| ✅ | `sdesk init` | create it · lives in `~/SentinelDesk` |
| ✅ | `sdesk case new SLUG "Title" --jurisdiction US` | |
| ✅ | `sdesk case list` | |
| ✅ | `sdesk ingest CASE FILE --title T --custodian C --shelf PRIMARY` | hash, classify, vault |
| ✅ | `sdesk claim add CASE "text" --tier GREEN --origin human --by "Name"` | |
| ✅ | `sdesk claim list` | every claim **and what blocks it** |
| ✅ | `sdesk cite 1 1 --locator "line 741" --quote "..."` | attach document to sentence |
| ✅ | `sdesk trace 1` | **everything behind one claim — this answers a lawyer** |
| ✅ | `sdesk ready CASE` | how far from publishable |
| ⚠️ | `sdesk gate run --case CASE` | run the gates explicitly |
| ⚠️ | `sdesk export CASE` | the dossier |
| ⚠️ | `sdesk correct 1 --retire --severity S --date D` | issue a correction |
| ⚠️ | `sdesk dispose 1` | own a machine-drafted claim |
| ⚠️ | `sdesk request add REF "Title" --office O --statute S` | records requests inside the case |
| ⚠️ | `sdesk submit CASE "Title"` · `sdesk decide 1 --approve` | editorial review queue |
| ⚠️ | `sdesk serve --port 8000` | browser view |
| ⚠️ | `sdesk verify` | audit-chain integrity |

**Shelves:** `PRIMARY` the document · `SECONDARY` a copy or mirror ·
`DERIVED` metadata, extracts, anything computed.

**Tiers:** `GREEN` you hold it · `ARITH` arithmetic on figures you hold ·
`REPORTED` someone else reported it, **including good outlets** · `VERIFY`
you believe it and cannot show it · `RED` contested · `DEAD` disproven —
**keep it, a killed claim is a finding.**

---

## 3. `pra` — records law

| ✅ | `pra foia` | the records desk — what needs you today |
| ✅ | `pra foia --all` · `pra foia add REF ...` | |
| ⚠️ | `pra brief` | **needs `cd modules/pra && npm install`** — pg driver missing |
| ⚠️ | `pra mail` · `pra seed` · `pra setup` · `pra test` | |
| ❌ | `pra portals` · `pra backup` · `pra verify` | **no script exists** — now says so instead of throwing |

---

## 4. Evidence handling

| ✅ | `prov verify evidence/manifests/provenance.jsonl` | **tamper-check the whole ledger** |
| ⚠️ | `prov ingest LEDGER --dry-run` | push ledger into the PRA database |
| ⚠️ | `corpus inventory PATH --out DIR --resume` | what is actually in a folder of records |
| ⚠️ | `corpus ocr` | OCR the bundles that only look like PDFs |
| ⚠️ | `shelf list` · `add` · `init` · `check` · `where` | external drives by **volume identity**, not path |
| ⚠️ | `doc get URL --case ID --as EX-01` | fetch a primary source, hash it, test readability |
| ⚠️ | `doc bills` | |
| ✅ | `draft` | captures → open questions · **RED only, by design** |

**`prov verify` is the one to run before you show anyone the ledger.** It
walks the hash chain and names any tampered line.

---

## 5. Watch, render, the rest

| ⚠️ | `watch run --all` · `--dry-run` · `--id=ID` | re-run saved searches |
| ⚠️ | `watch status` · `install HOUR` · `uninstall` | launchd schedule · **needs `watchlist.json`** |
| ⚠️ | `montage --spec S --out O --script --srt --contact-sheet --verify M` | the video renderer |
| ⚠️ | `vuln --input I --output O --policy P` | CVE enrichment — unrelated to this investigation |
| ⚠️ | `case` | research-desk gate (python) |
| ⚠️ | `dash` | dashboard, opens in browser |
| ⚠️ | `desk` | research desk UI |
| ✅ | `status` · `test` · `help` | |

---

## 6. ⚠️ THREE DOCUMENTS IN YOUR VAULT ARE MISLABELLED

The first bootstrap run ingested **metadata stubs as PRIMARY documents**:

| doc 2 | `FR 2026-00512 — CMS hearing` | **1,828 bytes** — metadata JSON, not the 4-page notice |
| doc 4 | `FR 2026-03968 — CRUSH RFI` | **1,966 bytes** — same |
| doc 6 | `FR 2026-10817 — OMB rule` | **21,942 bytes** — metadata for a **108-page** rule |

**A four-page Federal Register notice is not 1,828 bytes.** Cite "line 200"
against those and there is no line 200.

**The vault addresses by hash and will not re-title existing bytes**, so the
fix is to bring in the real documents:

```bash
bin/sentinel connect fedreg 2026-00512 --text
bin/sentinel connect fedreg 2026-03968 --text
bin/sentinel connect fedreg 2026-10817 --text
./scripts/desk_bootstrap.sh
```

The script now shelves full text as **PRIMARY (full text)** and metadata as
**DERIVED (METADATA ONLY, not the document)**. The three old entries stay —
**they are a true record of a mistake**, which is what an audit chain is for.

**Correctly held already:** doc 1 (2026-00596, 57,673 bytes), doc 3
(2026-05497, 19,760), doc 5 (2025-19928, 6,553). Those are real full texts.

---

## 7. STILL MISSING — stated plainly

| **Meta Ad Library** | ❌ | the only register that answers *"who paid for the post you saw"* |
| **FCC Public Inspection File** | ❌ | broadcast political buys by station |
| **`reconcile.js`** | ❌ CLI | built, 36 tests passing, **no verb wired** — the $91,631 gap |
| **USDA FNS SNAP error rates** | ❌ | not a connector · **one manual lookup, highest value left** |
| Ohio SoS 1191466 / 1604865 | 🚫 | by hand |
| docquery FEC PDFs | 🚫 | by hand |
| any name containing `cgi` | 🚫 | **WAF rule — CGI FEDERAL permanently invisible** |
| **FEC key in `provenance.jsonl`** | ⚠️ | **cleartext. Rotate before showing the ledger.** |

---

## THE RULE

**Eleven defects, one shape: the question's shape mistaken for a fact about
the world.** A DNS failure read as absence. A contracts-only filter read as
no CHIPS money. A page cap read as four awards when there were forty-six. An
opinions index read as "the courts." A truncated party sample read as a
caption. **Metadata shelved as a document.**

**Before any command here produces a sentence you say out loud: ask what that
command could not have seen.**
