# THE PIPELINE — WHAT EXISTS, WHAT DOES NOT, AND WHAT EACH VERB WOULD COST
**2026-09-15. Mapped against the repository, not against the plan.**

The proposal is a seven-verb newsroom:

```
sentinel case → research → verify → story → produce → review → publish
```

Six of those seven describe work this repository already does, under other
names. One of them does not exist in any form. **Naming them is most of the
job, because a verb that wraps nothing is worse than no verb** — it reports
success for a stage that never ran.

Here is the honest map.

---

## 0. FIRST, A CORRECTION, BECAUSE IT CHANGES WHAT CAN BE SAID ON SCREEN

**There is no FARA connector in this repository.**

`bin/sentinel connect test` lists thirteen: `opensanctions`, `courtlistener`,
`federalregister`, `fec`, `senatelda`, `regulationsgov`, `bls`,
`opencorporates`, `fedregdoc`, `fedregtext`, `cldocket`, `clparties`,
`usaspending`. **None of them reads FARA.**

So the figures in the draft report — a 3,912-record FARA corpus across four
registrations, a 536-registrant sweep with 448 UNKNOWN, 1,508 informational
materials, 387 Exhibit AB records — **did not come from this desk.** They may
be entirely correct and from a tool that is not in this repo. But a number
whose register cannot be named is the precise thing this programme exists to
refuse, and putting one on screen would undo the episode's own thesis in front
of the audience.

The same applies to the lobbying matrix counts (7,130 client-registrant
relationships, 239 registrants, 11,787 entities, 2,527 anomalies). Those *can*
come from this desk — `connect matrix` writes them as CSVs — but they have to
be read back out of the CSVs, not quoted from a terminal line. **`docs/` has
no captured copy of them, and `evidence/` is gitignored, so I cannot verify a
single one of those figures from here.**

**`modules/openmontage/episodes/ep02/episode.json` is therefore built without
them.** Every scene in it is one the repository itself supports: how the
registers differ, what a filing asserts and does not, why four FEC categories
must never be summed, why a page cap makes a FLOOR and not a total, why
UNKNOWN is not ZERO. That is the strongest half of the episode anyway, and it
is the half that cannot be taken apart.

The `_production` block in that spec lists the exact commands that put the
numbers in, once each one has a register, a denominator and a claim.

---

## 1. THE MAP

| proposed verb | what it would call | status |
|---|---|---|
| `sentinel case` | `sdesk case new` · `sdesk case list` | **EXISTS**, different name |
| `sentinel research` | `connect sweep SET --go` · `connect all` · `connect expand` | **EXISTS** |
| `sentinel verify` | `sdesk ready` · `sdesk trace` · `prov verify` · `connect nexus` | **EXISTS, NEVER RUN** |
| `sentinel story` | — | **DOES NOT EXIST** |
| `sentinel produce` | `shots` → `montage --out` | **HALF** — `shots` is new today |
| `sentinel review` | `sdesk submit` · `sdesk decide` | **EXISTS, NEVER RUN** |
| `sentinel publish` | `sdesk export` · `montage` per-format | **HALF** |

**Four of the seven already work and have never been run once.** That is the
finding. Before a wrapper is written around them, they should be run, because
a wrapper over an unrun stage inherits every bug in it and hides the error
message.

---

## 2. THE EVIDENCE GATE ALREADY EXISTS AND HAS NEVER BEEN OPENED

The proposed gate:

```
Claims: 27 · Primary: 19 · Unsupported: 0 · Contradictions: 2
STATUS: HUMAN REVIEW
```

`sdesk` is that gate. It has claims with tiers, citations with locators and
quotes, `trace` for end-to-end provenance on one claim, `ready` for
"how far from publishable", `gate run`, and `correct` for when you get it
wrong. **It is the half of this toolkit that has been idle since the
investigation began.**

```bash
bin/sentinel sdesk doctor
./scripts/desk_bootstrap.sh
bin/sentinel sdesk claim list      # every claim AND WHAT BLOCKS IT
bin/sentinel sdesk ready minnesota-fraud
bin/sentinel sdesk trace 1         # the command that answers a lawyer
```

**Run `ready` before you record, not before you publish** — so you find out
what is missing while it is still cheap to fix.

The one thing the proposed gate has that `sdesk` does not is the **contradiction
count**. That is a real gap and a small one: it is a query over claims that
cite the same document to incompatible effect.

---

## 3. THE "WHY?" BUTTON IS `sdesk trace`

```bash
bin/sentinel sdesk trace 14
```

One claim, every document behind it, every locator, every hash, in one screen.
It is already the thing described — it renders in a terminal rather than in a
browser, which is a presentation question and not an architecture one.

---

## 4. WHAT IS GENUINELY NEW TODAY: `sentinel shots`

This is the piece that did not exist in any form, and it is the one the
proposal asked for most specifically — *hand me the commands to build the
photos, I will build them elsewhere to save tokens, and drop them in the
folder.*

```bash
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json
bin/sentinel shots --spec .../episode.json --check          # what is missing
bin/sentinel shots --spec .../episode.json --out sheet.md
bin/sentinel shots --spec .../episode.json --variants 3
bin/sentinel shots --spec .../episode.json --json           # machine-readable
```

It reads the episode spec and returns **every picture the build will demand**,
sorted into four kinds:

| `SCREENSHOT` | there is a primary record behind this scene. **Documentary, free, and the bytes are already yours.** Comes back with the command that produces it. |
| `CAMERA` | a still you have to go and shoot |
| `HOST` | you, on camera. **No asset at all** — a `question` scene has no image key on the schema |
| `ILLUSTRATION` | nothing documentary exists. Generated elsewhere, labelled on the frame, **never a record** |

### The part that matters more than the prompts

**Most of what this episode needs is not a generated image.** It is a
screenshot of the filing, or of the terminal that pulled the filing. Those are
documentary under `VISUAL_POLICY.md`, they cost nothing, and the bytes are
already in `evidence/captures/`, hashed, in the ledger.

`ep02` bears this out: **eight screenshots, zero illustrations.** The episode
that explains how to read public records is illustrated by public records.

So the tool classifies before it prompts. A scene citing `2026-00512` gets

```
RUN   bin/sentinel connect fedreg 2026-00512 --text     # then screenshot the passage
```

not an art prompt.

### The prompts, when a prompt is right

Three variants per scene — **wide establishing, close detail, abstract
texture** — written to the `sentinel_light` palette so a generated still does
not arrive looking like a different programme. Every one carries a negative
prompt, and the negative prompt **is the editorial policy, written where it
binds**:

> no recognisable real people, no real faces, no politicians; no government
> seals, crests, flags or letterhead; no readable or plausible official
> document; no fabricated records, receipts or screenshots; no identifiable
> real building presented as itself; no hooded figures, no red-string boards,
> no surveillance-thriller imagery; no text of any kind

The renderer labels a generated image on the frame — that is the last line of
defence. This is the first: **an image that never contained a face or a seal
cannot be mistaken for a record later, however it gets reused.**

### Source beats

It counts the scenes that assert something against the scenes that **name a
source on screen**, and drafts the difference from the spec's own
`source_note` fields.

The distinction it enforces: **`source_note` is a production note and does not
render.** A spec can be scrupulously annotated and still put five
unattributed numbers in front of a viewer. That is the failure it counts.

### It writes nothing

Every block is printed to paste. A script that edits your episode takes
authorship of it — the same reason `desk_bootstrap.sh` prints `claim add`
lines instead of running them.

**And no angle brackets anywhere in its output.** Placeholders are SHOUTED
WORDS. zsh reads `<` as input redirection, and a pasted block containing one
takes the real commands above it down with it — which has happened twice in
this project, the second time inside the file written to warn about the first.

---

## 5. THE ONE VERB THAT SHOULD NOT BE BUILT YET: `sentinel story`

The proposal is for the system to construct a fact-based story structure —
Act I through Act V — from the claims.

**Do not build this next, and the reason is the whole project.**

A story generator's entire job is to impose a shape on evidence. Every defect
in this repository has been the same error: **the shape of the question
mistaken for a fact about the world.** A DNS failure read as absence. A
contracts-only filter read as no CHIPS money. A truncated party field read as
a caption, which published thirteen names including a defence attorney's.

A machine that arranges claims into acts will produce a causal narrative,
because that is what an act structure *is*, and the missing link in this
investigation is precisely causation — the last two steps of the chain
(`documented action → public outcome`) are **not established and this is
stated on screen in `ep02`**.

What *is* safe, and what would help immediately, is a **fact table** —
claim, evidence, tier, blocking reason — sorted and rendered. That is
`sdesk claim list` plus a formatter, it imposes no shape, and it is the input
a human needs to build the acts themselves.

**The computer does the labour. The records provide the evidence. The
investigator makes the judgement.** A story verb crosses that line; a fact
table does not.

---

## 6. MUSIC — ALREADY A SEPARATE LAYER

`modules/openmontage/engine/om_audio.py` is 1,088 lines and the spec already
carries `audio_style`, `audio_seed` and `audio_gain`. `ep00` built three
variants — `cipher`, `groove`, and the default — as separate beds and mixes.
This is done.

---

## 7. THE ORDER, IF ONLY SIX THINGS HAPPEN

```bash
# 1 — run the half of the toolkit that has never run
bin/sentinel sdesk doctor
./scripts/desk_bootstrap.sh
bin/sentinel sdesk claim list

# 2 — rotate the FEC key, THEN verify the chain
#     (it is still cleartext in evidence/manifests/provenance.jsonl)
bin/sentinel prov verify evidence/manifests/provenance.jsonl

# 3 — the assignment sheet for the episode
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json --out sheet.md

# 4 — the screenshots, which are free and documentary
bin/sentinel connect fedreg 2026-00512 --text
bin/sentinel connect nexus --asserted

# 5 — the numbers, each with a register and a denominator
bin/sentinel connect matrix
bin/sentinel connect asymmetry --committee C00799031 --dimension vendor --cycle 2026

# 6 — find out what blocks publication BEFORE recording
bin/sentinel sdesk ready minnesota-fraud
```

---

## THE STANDARD THE EPISODE IS ABOUT

**Documents first. Connections second. Conclusions last.**

And the sentence that carries the whole thing:

> **We have established a network of documented relationships. We have not
> established the meaning or consequence of every relationship.**

That is true, it is defensible, and it is a stronger opening than any
conclusion available from the current evidence.
