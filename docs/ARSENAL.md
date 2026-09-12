# SENTINEL — THE ARSENAL
**Every command, mapped to every open gap. 2026-09-12.**

Verified against `bin/sentinel` and the module dispatchers on this date.
Where something is **NOT BUILT**, it says so — a command list that lies is
the same defect as a query that manufactures an absence.

---

## 0. THE ONE THAT MATTERS MOST TONIGHT

**Not a sentinel command. One lookup, free, and it decides §89.**

```
USDA FNS — SNAP Quality Control payment error rates, by state, by fiscal year
```

EO 14395 cites *"nearly 9 percent… spent in error"* in Minnesota as evidence
of theft. A payment error rate is **overpayments plus underpayments** and
measures administrative accuracy, not fraud. **Get Minnesota's rate, the
national rate, and the fifty-state table.** If Minnesota sits at or below the
national average, an Executive Order's own citation proves the opposite of
what it is offered to prove — and you will have answered it with arithmetic.

Then bring it back in:

```bash
bin/sentinel prov add --file snap_error_rates.csv --label "USDA FNS SNAP QC error rates"
```

---

## 1. `connect` — 22 verbs, the register layer

### Searching

| command | what it asks |
|---|---|
| `connect test` | every connector, key state, live probe |
| `connect list` | subject sets available |
| `connect courtlistener "X"` (any connector name) | one source, one subject |
| `connect all "X"` | all 8 connectors on one subject |
| `connect sweep minnesota_fraud --go` | a whole subject set (plan without `--go`) |
| `connect expand --limit N` | walk out from what the sweep found |
| `connect crosslink` | entities appearing in more than one source |
| `connect graph --push` | push the entity graph to Neo4j |
| `connect brief` | the day's digest |

### Reading documents — the gap-closers built tonight

```bash
bin/sentinel connect fedreg 2026-00596                # metadata + abstract
bin/sentinel connect fedreg 2025-19928 --text --limit 200   # full text (Presidential docs have NO abstract)
bin/sentinel connect fedreg 2026-00596 --grep "Minnesota"   # WHY did a search match?
bin/sentinel connect docket "0:20-cv-02312"           # caption as the COURT keeps it
bin/sentinel connect docket "0:22-cr-00223" --court mnd --limit 8   # party table, BY ROLE
bin/sentinel connect courtlistener "X" --dockets      # RECAP, not published opinions
```

**`--grep` is the only command here that can KILL a lead**, and killing bad
leads is worth more than finding new ones.

### Money

| `connect awards "NAME" --all --pages 15` | all 5 instrument families · `--grants --direct --loans --other --contracts` |
| `connect vendor "FIRM"` | reverse lookup: which committees PAID this name |
| `connect fecpac "COMMITTEE"` | one committee's money |
| `connect donors` · `connect filings` | who gave · what was filed |
| `connect member "NAME"` · `connect delegation` | one politician · a whole state |
| `connect asymmetry --dimension vendor` | concentration |
| `connect control` | shared officers across committees |
| `connect matrix` | 8 CSVs + ranked worklist |
| `connect senatelda --client "X"` / `--registrant "FIRM"` | two different questions |

**`connect awards` traps, all learned the hard way:**
- **default is contracts only** — `--all` for five families
- **never sum across families** (a loan's face value ≠ a contract)
- **run the stem AND the full name** — `"Intel"` returned $220m in 09/11 that `"Intel Corporation"` did not (§72)
- **a bare stem can drown** — `"Intel"` gave 4 contracts, 796 namesakes (§66)

---

## 2. `sdesk` — THE CLAIM LAYER. This is what has been idle.

**`connect` finds documents. `sdesk` decides whether you may publish a
sentence.** You now have documents. This is the half you need.

```bash
bin/sentinel sdesk doctor                     # is the desk healthy
bin/sentinel sdesk init                       # create it
bin/sentinel sdesk case new minnesota-fraud "Minnesota program integrity" --jurisdiction US
bin/sentinel sdesk case list
```

### Put a document in the vault — hashed, classified, shelved

```bash
# ./scripts/desk_bootstrap.sh does this for every capture already on disk.
# By hand, with a real path:
bin/sentinel sdesk ingest minnesota-fraud evidence/captures/FR_2026-00596_text.json \
  --title "FR 2026-00596 Somalia TPS termination" \
  --custodian "Federal Register / DHS-USCIS" \
  --shelf PRIMARY
```

**`--shelf PRIMARY | SECONDARY | DERIVED`** — a DOJ press release cited in a
footnote is SECONDARY. The notice itself is PRIMARY. **That distinction is
the difference between citing a document and citing a summary of it.**

### Make a claim, and let the desk tell you what blocks it

```bash
bin/sentinel sdesk claim add minnesota-fraud \
  "DHS cited the Feeding Our Future prosecutions in the Somalia TPS termination" \
  --tier GREEN --origin human --by "M. Griswold"

bin/sentinel sdesk claim add minnesota-fraud \
  "Minnesota appears 7 times and 'country conditions' 3 times across 943 lines" \
  --tier ARITH --formula "occurrence counts over line count of the hashed full text"

bin/sentinel sdesk claim list          # every claim, its id, AND WHAT BLOCKS IT
```

**Tiers: `GREEN ARITH REPORTED RED VERIFY DEAD`.** Anything sourced from a
news account is **REPORTED**, not GREEN, however confident you feel.

### Attach the document to the sentence

```bash
# ids come from `sdesk claim list` — substitute the numbers, no brackets
bin/sentinel sdesk cite 1 1 \
  --locator "line 741, capture f68e2560…" \
  --quote "under the sponsorship of Feeding Our Future"

bin/sentinel sdesk trace 1      # everything behind one claim, end to end
```

**`trace` is the command that answers a lawyer.** One claim, every document,
every locator, every hash, in one screen.

### The gate

```bash
bin/sentinel sdesk gate run --case minnesota-fraud
bin/sentinel sdesk ready minnesota-fraud     # how far from publishable
bin/sentinel sdesk export minnesota-fraud    # the dossier
```

**`ready` is the thing to run before you record Episode 01.** Not before you
publish — **before you record**, so you find out what is missing while it is
still cheap.

### When you get it wrong — and you will

```bash
bin/sentinel sdesk correct 1 --retire
bin/sentinel sdesk dispose 1    # take responsibility for a machine-drafted claim
```

**§78 and §81 are why `correct` exists.** Thirteen names, one of them a
defence attorney. **A desk without a correction verb is a desk that cannot be
trusted with the true parts.**

---

## 3. `pra` — records law. Six built, three not.

```bash
bin/sentinel pra foia            # the records desk — what needs you today
bin/sentinel pra foia --all      # every request tracked
bin/sentinel pra foia add MN-SOS-2026-01 ...
bin/sentinel pra brief           # daily digest
bin/sentinel pra mail            # correspondence
bin/sentinel pra seed · setup · test
```

**NOT BUILT:** `portals`, `backup`, `verify`. They were listed in the
dispatcher and threw stack traces at a missing file. **Fixed tonight** to say
so plainly instead.

### The five requests that would actually move something

| 1 | **Minnesota SoS** | every entity named "…Housing Stabilization Services…", with incorporation dates → **the denominator for the 19-company cluster** |
| 2 | **Minnesota DHS** | HSS provider enrolment list + dates → join to #1: *"incorporated N days before enrolling"* |
| 3 | **NIH / HHS OASH** | the SOW behind `75N98021F00001` — what "psychographic" meant to the buyer |
| 4 | **NSA/CSS** | the SOW behind `H982300820011` — $16,800,000 described as the single word `RESEARCH`. **Expect denial; the denial is publishable** |
| 5 | **Licking County Auditor** | New Albany parcel transfers, prices, dates — **free, online, nobody has to grant it** |

**Ohio: R.C. 149.43(C)(2).** Only **hand delivery, electronic submission, or
certified mail** preserves statutory damages. **Email from your own account
and keep the sent copy.**

---

## 4. Provenance, corpus, the rest

```bash
bin/sentinel prov add --file snap_error_rates.csv --label "USDA FNS SNAP QC error rates"
bin/sentinel corpus
bin/sentinel shelf
bin/sentinel draft
bin/sentinel doc
bin/sentinel case            # research-desk (python)
bin/sentinel dash                # dashboard, opens in browser
bin/sentinel desk                # research desk UI
bin/sentinel watch           # scheduled re-runs — see watchlist.json
bin/sentinel montage         # video pipeline
bin/sentinel status · test
```

---

## 5. EVERY OPEN GAP → THE COMMAND

| gap | command | status |
|---|---|---|
| **SNAP error rate vs national** | USDA FNS lookup → `prov add` | **DO THIS FIRST** |
| 21-state lawsuit in EO 14395 | `connect courtlistener "Minnesota" --dockets` | ready |
| HSS denominator | `pra foia` → MN SoS + DHS | **not sent** |
| Fors Marsh: firm or market? | `connect awards "Porter Novelli" --all` then Ogilvy, Ketchum, IQ Solutions | ready |
| Quintus FEC complaint | `connect vendor "Quintus" --pages 25` + `connect control` | **complaint-ready** |
| Meta Ad Library | none | **NOT BUILT** |
| FCC Public Inspection File | none | **NOT BUILT** |
| `reconcile.js` ($91,631 gap) | none | **built, tested, NO CLI VERB** |
| Ohio SoS 1191466 / 1604865 | by hand | blocked from tooling |
| docquery FEC PDFs | by hand | blocked |
| any name containing "cgi" | none | **permanently blocked** (WAF; CGI FEDERAL invisible) |
| **FEC key in `provenance.jsonl` cleartext** | **rotate it** | **OPEN — do before showing anyone the ledger** |
| Episodes 00/01 | `sdesk ready` then `montage` | not recorded |

---

## 5b. ⚠ COPY-PASTE WARNING — this bit me and then bit you

`<case>` and `<file>` in a command block are **placeholders, not syntax.**
zsh reads `<` as input redirection and kills the entire paste with
`parse error near '<'` — including the real commands above it.

**Never paste a block containing angle brackets.** Everything in this file
that needs a value has one filled in, or is behind `scripts/desk_bootstrap.sh`.

```bash
bin/sentinel sdesk doctor
bin/sentinel sdesk case new minnesota-fraud "Minnesota program integrity"
./scripts/desk_bootstrap.sh
```

**`desk_bootstrap.sh` does the mechanical half only** — init, case, and
ingest every capture already on disk with correct titles, custodians and
PRIMARY/SECONDARY shelving. It identifies Federal Register captures **by
content** (`FR Doc No: …` inside the bytes), because the filenames could not
tell them apart.

**It deliberately does not add claims.** A script that writes claims launders
authorship. It prints the exact `claim add` and `cite` lines with real ids
for you to read and run.

---

## 6. THE ORDER, IF YOU ONLY DO SIX THINGS

```bash
# 1 — the number that answers an Executive Order
#     USDA FNS SNAP QC error rates: Minnesota, national, all fifty states

# 2 — stand up the claim layer you have never used
bin/sentinel sdesk doctor
bin/sentinel sdesk case new minnesota-fraud "Minnesota program integrity" --jurisdiction US

# 3 — vault what you already hold, hashed
./scripts/desk_bootstrap.sh

# 4 — find out what blocks publication BEFORE you record
bin/sentinel sdesk claim list
bin/sentinel sdesk ready minnesota-fraud

# 5 — send the two requests that produce the denominator
bin/sentinel pra foia          # MN Secretary of State · MN DHS

# 6 — rotate the FEC key
```

---

## THE RULE THAT GOVERNS ALL OF IT

**Every one of the eleven defects in this toolkit was the same mistake: the
shape of the question mistaken for a fact about the world.**

A DNS failure read as an absence. A contracts-only filter read as no CHIPS
money. A page cap read as four awards when there were forty-six. An opinions
index read as "the courts." A truncated party sample read as a caption — and
a defence attorney very nearly published as a criminal defendant.

**Before any command here produces a sentence you say out loud, ask what the
command could not have seen.** That question has caught every single one.
