# The Defenders Curriculum

Defensive security taught the way the desk works: nothing asserted that isn't
demonstrated, every claim traceable, every exercise runnable on a laptop with
no lab budget and no internet.

## Who this is for

Students who can already use a terminal and want to become useful rather than
credentialed. It assumes no prior security knowledge and no purchased tooling.

## The rule that shapes every lesson

**Students only ever touch systems they own.** Every exercise here runs against
the student's own machine, their own network, or files they created. There is
no "practice target," no scanning of third parties, and no lesson that becomes
an offensive technique if pointed sideways.

This is not squeamishness. It is the same reason the desk refuses location
lookups: a curriculum that teaches a capability without teaching the boundary
has taught half a thing, and the missing half is the half that matters.

## Lesson format

Each lesson is a single Markdown file with YAML frontmatter, structured so an
instructor can teach from it directly and a student can work through it alone.

```
---
id: baseline-your-own-network
level: 1
minutes: 90
prerequisites: [...]
tools: [...]
nist_csf: [DE.CM-01]           ← what defensive function this builds
attack_context: [T1071]        ← the adversary behaviour it detects
teaches_offense: false         ← must be false for every lesson in this set
---
```

Body sections, always in this order:

| Section | Purpose |
|---|---|
| **Why this matters** | The concrete failure this prevents. No abstractions. |
| **What you need** | Tools and access, stated exactly. |
| **Workflow** | Numbered steps with real commands and expected output. |
| **Verification** | How the student proves it worked — not "you should see." |
| **Where students get it wrong** | The specific errors, from experience. |
| **Write it up** | The report template. Every lesson ends in writing. |
| **Instructor notes** | What to watch for, how to grade, discussion prompts. |
| **Framework mapping** | With honesty about what is approximate. |

## The reporting template

Every lesson ends with the same structure, because the skill being built is
not "run tcpdump" — it is **producing a finding another person can check.**

```
Summary          One paragraph. What did you find?
Scope            What you looked at, and what you did not.
Known facts      Only what you observed. Each with how you observed it.
Assumptions      Stated separately. Never mixed into facts.
Evidence         Commands run, output captured, hashes where relevant.
Confidence       High / medium / low, and why.
Open questions   What you could not determine.
Next action      One thing, specifically.
```

A student who can fill this honestly is more employable than one who has
memorised more tools. The separation of *known facts* from *assumptions* is
the entire discipline in one table row.

## Grading

Grade the write-up, not the terminal output.

- **Fails:** any assumption presented as a fact. Automatic, regardless of how
  good the rest is. This is the one thing that must never become negotiable.
- **Fails:** confidence stated as high with thin evidence.
- **Strong:** an "open questions" section that names something real.
- **Strongest:** a student who reports a dead end — chased a lead, found a
  legitimate explanation, wrote it up anyway. That instinct is rarer than
  technical skill and much harder to teach later.

## Sequence

| # | Lesson | Level | Builds |
|---|---|---|---|
| 1 | `baseline-your-own-network` | 1 | You cannot detect abnormal until you have recorded normal |
| 2 | `verify-a-file-is-what-it-claims` | 1 | Magic bytes, hashes, chain of custody |
| 3 | `evaluate-a-tool-before-you-run-it` | 2 | Supply-chain judgement — the most-needed, least-taught skill |
| 4 | `segment-a-home-network` | 2 | Containment as a design property |
| 5 | `write-a-finding-that-survives-scrutiny` | 3 | The capstone: everything above, in writing |

Do them in order. Lesson 5 grades lessons 1–4.

## What is deliberately absent

- **No exploitation.** Not because students shouldn't eventually learn it, but
  because a defender who cannot baseline a network is not ready to be handed
  an exploit, and most curricula get this order backwards.
- **No third-party skill packs.** Lesson 3 is about *evaluating* those, which
  is the useful lesson. Installing one uncritically would contradict it.
- **No "practice targets."** See the rule above.

---
*Named Sources. Public Documents. Verified Facts.*
