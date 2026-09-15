# MAKE ONE VIDEO
**Six commands. In order. Nothing else. 2026-09-15.**

You have hundreds of captures and no idea where to start. That is not a
research problem — it is a *selection* problem, and this page solves it by
removing every choice except one.

**Do these six in order. Do not skip. Do not reorder.** The whole thing is
free and local: no model, no API, no per-render charge. Run it again on
Thursday and it works the same way.

---

## STEP 1 — What do I actually have?

```bash
git pull
bin/sentinel connect coverage
```

**Costs nothing. No network call.**

Read two lines only:

- **`rows FILED UNDER a subject name`** — that number, not the total, is what
  you actually found.
- **`SET(S) NEVER ASKED`** — those are unasked questions, *not* empty findings.

**If a set you care about is on the never-asked list, stop here and sweep it.**
Everything downstream inherits the gap.

---

## STEP 2 — Turn rows into relationships

```bash
bin/sentinel connect edges --out edges.csv
```

**Costs nothing.**

A row says a register matched a string. An **edge** says *something happened
between two named parties*, and names the document that says so. This is the
file everything else reads.

You will see five relationships and no more, because those are the five this
toolkit can evidence:

| `represented_by` | Senate LDA LD-2, 2 U.S.C. 1604 | **ASSERTED** |
| `received_award_from` | USAspending, with an award id | **ASSERTED** |
| `party_to` | CourtListener docket and party table | **ASSERTED** |
| `registered_in` | a companies registrar | **REGISTRY** |
| `mentioned_in` | a search index — authority: **NONE** | **CO-OCCURRENCE** |

---

## STEP 3 — Pick ONE entity. Just one.

```bash
bin/sentinel connect explain "MINDSET ADVOCACY"
```

**Costs nothing.**

This is the selection step, and it is where you have been getting stuck.
**Pick the entity with the most ASSERTED edges** — that is your story, because
those are the ones somebody swore to.

The line that decides the episode looks like this:

```
MINDSET ADVOCACY, LLC   $40,000.00
  3 entities in this library stand in the same relationship to it
```

**That second line is the story.** One small firm; three separate companies
retained it; all three filings are sworn. That is a shape you can show, and
every part of it has a document.

---

## STEP 4 — Argue against yourself, before you write a word

```bash
bin/sentinel connect challenge "MINDSET ADVOCACY"
```

**Costs nothing. THIS IS THE STEP THAT MAKES THE VIDEO SURVIVE.**

It will tell you things you do not want to hear:

- most of this is a search index
- some of these may be a different company — **check the date**
- a shared counterparty is a **service**, not a network
- the comparison universe does not exist yet
- this number is a **FLOOR**, not a total

**Whatever it says, put that in the video.** The limitation is not a weakness
in the story — it is the reason a hostile viewer cannot take the story apart.
An explainer that says "here is what this does *not* prove" is the one people
trust.

Then answer its last question: **what would change your mind?** If you cannot
name the document that would kill your theory, you do not have a finding yet.
You have a shape you noticed.

---

## STEP 5 — Draw the evidence

```bash
bin/sentinel cards --edges edges.csv \
  --entity "MINDSET ADVOCACY" \
  --limit 20 --seconds 90 \
  --out modules/openmontage/episodes/ep02/assets \
  --scenes cards.json
```

**Costs nothing. Free, local, repeatable — PIL and the fonts already on your
machine.**

Twenty PNG cards, one per relationship, timed to fill ninety seconds. Each
card is one arrow between two names, **with the register printed underneath
it**:

```
     THE BLACKSTONE GROUP INC.
              |
              |  retained this firm to lobby
              v
       MINDSET ADVOCACY, LLC
  ───────────────────────────────────────
  SOURCE: Senate LDA quarterly filing
          (LD-2), 2 U.S.C. 1604 · $40,000.00
```

**The arrows come from the edge table, not from your script.** A card
generator fed by prose draws whatever the writer typed. This one can only draw
a relationship that has a register behind it — you *cannot* draw an arrow this
tool has no source for. That is the feature.

**The grade is drawn, not footnoted:**

| solid line | **ASSERTED** — somebody swore to it |
| dashed line | **REGISTRY** — the entity exists as filed |
| dotted line | **CO-OCCURRENCE** — and the card says *"TWO NAMES IN ONE DOCUMENT. This is not a relationship."* **on its face** |

That last one is deliberate. A diagram is the easiest place in the world to
launder a co-occurrence into a relationship, so the card refuses.

Useful flags:

```bash
--grade ASSERTED        # only the sworn ones — a tight, unassailable deck
--limit 20 --seconds 90 # 20 cards ÷ 90s = 4.5s each, computed for you
--preset square         # or landscape. vertical is the default.
```

---

## STEP 6 — Build it

```bash
# paste the contents of cards.json into "scenes" in episode.json, then:
cd modules/openmontage/episodes/ep02
python3 ../../engine/openmontage.py --spec episode.json --check-safe
python3 ../../engine/openmontage.py --spec episode.json --contact-sheet builds/sheet.png
python3 ../../engine/openmontage.py --spec episode.json --out builds/ep02.mp4
```

And before you record your voice:

```bash
bin/sentinel shots --spec modules/openmontage/episodes/ep02/episode.json --check
```

That tells you every asset the build will demand and cannot find — **before**
the build fails on one at a time.

---

## THE SHAPE OF THE VIDEO ITSELF

Ninety seconds, and the order is not negotiable:

| **0–10s** | **The question.** Not the answer. "Who does this small firm work for?" |
| **10–20s** | **Why it matters to a person.** One sentence. No numbers yet. |
| **20–70s** | **The cards.** One relationship each. Read the source line out loud — *"filed with the Senate, under penalty, in the second quarter"*. |
| **70–80s** | **What this does NOT prove.** Straight from step 4. Say it plainly. |
| **80–90s** | **What you would need next, and who holds it.** `connect nexus --gaps` names the office. |

**The fourth beat is the one that works.** Everybody else in this space skips
it, and skipping it is exactly why people have stopped believing any of it.
Saying "here is where my evidence stops" is the single most persuasive thing
in the whole ninety seconds, and it costs you nothing true.

---

## WHAT TO DO EVERY FEW DAYS

```bash
bin/sentinel connect coverage      # what changed, and what is still unasked
bin/sentinel connect edges --out edges.csv
bin/sentinel connect explain "THE ENTITY WITH THE MOST ASSERTED EDGES"
bin/sentinel connect challenge "THAT SAME ENTITY"
bin/sentinel cards --edges edges.csv --entity "THAT SAME ENTITY" --grade ASSERTED
```

**One entity. One video. One question answered.** Not a survey of everything
you found — that is why the output feels unusable. The library is the
*material*; the video is one sentence from it, proved.

---

## TWO THINGS I HAVE NOT BUILT, SO YOU KNOW

**Maps and location APIs.** You asked about these. There is no map connector
here, and the Ohio parcel data that would make a map worth drawing is a county
auditor record — Licking and Franklin — which is free, online, and still not
pulled. **A map without parcels is decoration.** Get the parcels first, then a
map is worth building.

**The overlay work from your other session.** `overlay_studio.py` was built on
your Mac at `~/Documents/Codex/...`, not in this repository. I have not seen
it and it is not in this git history. `cards.py` here is a different thing
with a different input — it draws from the **edge table**, so its arrows carry
registers. If the two overlap, keep the one whose arrows can be checked.

---

## THE RULE

**Documents first. Connections second. Conclusions last.**

And the sentence that carries the whole programme:

> **We have established a network of documented relationships. We have not
> established the meaning or consequence of every relationship.**

That is true, it is defensible, and it is a stronger opening than any
conclusion currently available from the evidence.
