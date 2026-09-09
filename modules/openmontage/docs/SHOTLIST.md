# Shot list — what to photograph, and why

You are going to shoot a lot of frames. This is the list that makes them
usable, so a shoot in September still cuts into an episode in December.

The engine takes a photograph through one scene type:

```jsonc
{
  "type": "photo",
  "dur": 4.0,
  "image": "assets/gahanna_clerk_counter.jpg",
  "kick": "GAHANNA",                                  // optional eyebrow
  "caption": "The counter where records requests are filed.",
  "source": "Photo: M. Rosenburg, 2026-09-08",        // REQUIRED
  "scrim_from": 0.45,                                 // optional
  "motion": true                                      // optional slow push-in
}
```

**`source` is required and the build refuses without it.** Who shot it and
when. A photograph is evidence, and evidence carries provenance — same rule as
a document, rendered in the same cyan, in the same place on the frame.

---

## How to shoot so it always works

**Shoot horizontal or vertical, it does not matter.** The engine scales to fill
a 9:16 frame and centre-crops. No black bars, ever. But it *crops*, so:

- **Leave air around the subject.** Anything within ~15% of a horizontal frame's
  left and right edges will be cut. Centre what matters.
- **Keep the bottom third quiet.** The caption and credit sit there over a
  gradient scrim. A busy bottom third fights the type.
- **Shoot the same thing three ways** — wide, medium, tight. A wide establishes,
  a tight cuts to rhythm. You will want the tight one more often than you think.

**Technical:**
- Highest resolution the phone offers. You can always crop down, never up.
- **HEIC → JPEG before it enters the repo.** On iPhone: Settings → Camera →
  Formats → Most Compatible. Or export as JPEG. HEIC is not read by the engine.
- Lock exposure (tap and hold) on anything with sky in it, or the building goes
  black.
- Never shoot a screen. Photograph the paper, or export the PDF page — a photo
  of a monitor reads as a derivative and looks like one.

**Legal and safety, plainly:**
- Public buildings, streets and exteriors: photograph freely from public space.
- Inside a courthouse or a police lobby: rules vary and are posted. Ask, or
  don't. A refused shot is not worth a confiscated phone.
- **No faces of private individuals.** Not the complainant, not a bystander,
  not a name badge. Shoot the building, the counter, the door, the sign, the
  form. Institutions, not people.
- Officers acting in an official public capacity are a different question and
  the answer depends on the state and the situation. Route that through counsel
  before it appears in a published frame, not after.

---

## The standing kit — shoot these once, use them forever

These are the frames every episode reaches for. Shoot them properly one
Saturday and you will stop needing B-roll for a year.

### Institutions (wide, medium, tight — each)
| Shot | Why you will need it |
|---|---|
| Franklin County Municipal Court, exterior, street level | Any docket, any disposition, any hearing |
| The clerk's counter / records window | Every records-request story opens here |
| Gahanna Division of Police, exterior | Any story naming the department |
| Gahanna city building / council chambers | Policy, budget, legislative approval |
| A generic public-records request form on a desk | The universal "we asked" frame |
| A mailbox / the mail going out | The clock starting |
| An empty chair at a public meeting | The absence shot. Enormously useful |

### The surveillance beat
| Shot | Why |
|---|---|
| An ALPR camera on a pole, tight, against sky | The Flock story's defining image |
| The same camera, wide, showing what it watches | Context — the intersection it covers |
| A drone docking station, if you can see one publicly | The DFR program |
| A ceiling dome camera in a public lobby | Generic surveillance texture |
| A pole-mounted camera cluster at an intersection | Density, without naming anyone |
| Street-level view *from* roughly where a camera sits | The POV shot. Unsettling and honest |

### The paper (shoot flat, or export the page)
| Shot | Why |
|---|---|
| A warrant page, cropped to ONE line | `quote` scene document plate |
| A docket printout, cropped to the disposition row | Same |
| A policy page, cropped to the section header | Same |
| A records-request response letter, letterhead only | Proves the agency answered |
| A stack of printed responses, from above | The volume shot |
| A redaction — a real black bar on a real page | The most honest image in this beat |

**Crop before it enters `assets/`.** Full pages carry names, dates of birth and
addresses. Crop to the line that matters, save the crop, leave the original in
the evidence store where it is never rendered.

### Texture and rhythm (the connective tissue)
| Shot | Why |
|---|---|
| A hallway, empty, receding | Transition between chapters |
| A door with an office name plate | "Who is responsible" |
| A clock in a public building | The clock, literally |
| Hands on a keyboard, over the shoulder, no face | Work being done |
| A window at dusk from inside an office | End-of-episode breathing room |
| Rain / weather on a public building | Mood without a claim |
| A parking lot at night, lit | Tension without asserting anything |

---

## Naming, so it stays findable

```
assets/YYYY-MM-DD_subject_variant.jpg

2026-09-08_fcmc-exterior_wide.jpg
2026-09-08_fcmc-exterior_tight.jpg
2026-09-08_clerk-counter_medium.jpg
2026-09-08_alpr-pole_tight.jpg
2026-09-08_warrant-p1_crop-cautions.jpg
```

Date first so the folder sorts chronologically. Subject second so you can grep
it. Variant last. The date in the filename should match the date in the
`source` credit — if they disagree, one of them is wrong and you want to find
that now.

---

## Where files live

```
episodes/epNN/
  episode.json      the spec
  assets/           crops and photographs that GO ON SCREEN
  builds/           mp4, manifest, script.md, srt
```

Everything in `assets/` is public the moment you publish. Nothing from the
evidence store is copied there whole — only deliberate crops.

---

## Building an episode from photographs

The rhythm that works for this format, and the reason it works:

1. **`title`** — the claim of the episode, stated flatly
2. **`question`** — you, on camera, asking the thing the viewer is thinking
3. **`photo`** — the world. Where this happened
4. **`quote`** — the document. What it says, and which document it is
5. **`bignum`** — the number the document produces
6. **`question`** — you again, on the turn
7. **`photo`** — the consequence, or the absence
8. **`title`** — the standard, or what remains unanswered
9. **`hash`** — the receipt

Alternate light and dark. The `question` scenes are near-black, so they read as
chapter breaks and give the eye somewhere to rest — and they are where *you*
are, which is what makes it a programme rather than a slideshow.

**Durations that work:** `title` 5–8s · `question` 5–7s · `photo` 3.5–5s ·
`quote` 8–10s · `bignum` 6–7s · `hash` 8–9s. A photo held longer than 5s starts
to feel like a screensaver unless something in it moves.

---

## The loop, end to end

```bash
cd episodes/ep01

python3 ../../engine/openmontage.py --spec episode.json --check-safe
python3 ../../engine/openmontage.py --spec episode.json --contact-sheet builds/sheet.png
python3 ../../engine/openmontage.py --spec episode.json --out builds/ep01.mp4
```

That writes the video, the manifest, `ep01.script.md` and `ep01.srt`.

Then: open `ep01.script.md`, record to its timecodes, and cut yourself into the
`question` scenes in Detail or Captions on the phone. The script tells you, per
scene, how many words you have and whether the line can be said in the time
available. Where it says **YOU ARE ON CAMERA HERE**, do not read — answer.

If a take needs a second thought, the scene is too short. Change `dur` in the
spec and re-render. The bones are cheap to move; the take is not.
