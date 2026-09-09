# Visual policy — whose pictures, and what they may claim

Two rules, both enforced in code rather than remembered.

1. **Only your own images enter the library.** Anything unattributed cannot be
   approved for use.
2. **A generated image is never documentary.** It can appear, always labelled
   on the frame, and it may never stand as a record of a real place or event.

---

## On the repo being private

Private is the right setting and it is not the thing protecting you. Two
separate protections, worth keeping straight:

- **`.gitignore`** keeps `evidence/`, build outputs, ledgers and `.env` out of
  the repository entirely. This is what actually matters, because it holds
  whether the repo is private today, public later, forked, or cloned onto a
  machine you do not control.
- **Private visibility** limits who can read what *is* committed.

If the repo ever goes public, the exposure is whatever is already in git
history — and history is forever. So the working assumption stays: nothing
sensitive is ever committed, private or not. Check before you push:

```bash
git status --short          # what is about to go in
git log --stat -3           # what already did
```

---

## Origin — the field that decides everything

Every image in the library carries an origin. It is the only field that
determines what the image may be used for.

| origin | what it means | documentary? |
|---|---|---|
| `own_camera` | shot by you, on a device the policy recognises | **yes** |
| `own_screenshot` | your capture of your own screen | **yes** |
| `licensed` | someone else's, licence recorded in `license_ref` | **yes** |
| `generated` | a model made it | **never** — illustration only |
| `third_party` | someone else's, no licence recorded | no |
| `unknown` | no attribution at all | no |

`own_camera` is assigned automatically when EXIF Make/Model matches your
device list. Everything else you declare.

### Telling it which cameras are yours

First scan writes `visual_policy.json` beside your photos. Add your devices:

```jsonc
{
  "version": 1,
  "own_devices": ["Apple iPhone 15 Pro", "Apple iPhone SE"]
}
```

Find the exact strings from a photo you took:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py ~/path/to/photos
```

then read `make` and `model` in `visual_manifest.json`. Matching is
case-insensitive and substring-based, so `"iPhone 15 Pro"` is enough.

**Anything from another camera, a download, a screenshot of someone else's
work, or a message thread lands as `unknown` and cannot be approved.** That is
the "only this account's photos" rule, enforced. It is not a warning — the
approval is refused and the refusal is reported with its reason.

---

## The generated-image rule, and why it is absolute

Your whole position is that every frame traces to a record. A generated
photograph of a real building, presented as a photograph of that building,
retires that position permanently. It would also be found: generated images are
detectable, and on an accountability channel somebody always checks.

So the rule is enforced twice, in two different places, because one place is
not enough:

**In the library.** Ticking `approved_for_documentary` on a generated image is
*refused*, not honoured. It appears under `illustration_only` instead, and the
refusal is printed with its reason.

**In the renderer.** A `photo` scene must declare `origin`. Without it the
build fails. With `"origin": "generated"` the engine draws a band across the
top of the frame reading:

> **ILLUSTRATION · GENERATED IMAGE · NOT A PHOTOGRAPH**

That band is not a spec option. There is no flag to disable it. A careless edit
cannot remove it, because the spec has no way to ask.

```jsonc
{
  "type": "photo",
  "dur": 4.0,
  "image": "assets/motif_network.jpg",
  "origin": "generated",
  "caption": "Illustration of the contract structure.",
  "source": "Generated: gemini-2.5-flash-image, 2026-09-09"
}
```

### What generated imagery is genuinely good for

- title-card backgrounds and section dividers
- abstract motifs — networks, ledgers, flows of money
- textures behind type
- diagrams of a structure you are describing, clearly drawn as a diagram

### What it must never be used for

- any real building, street, office, vehicle, or document
- any person, living or dead, real or implied
- anything a viewer could mistake for something you photographed
- anything standing in for evidence you do not have

If you find yourself generating an image *because you could not get the real
shot*, that is the moment to stop. The absence is the story — your own
methodology already says a documented dead end is honest journalism. An
illustration papering over a missing photograph is the opposite of that.

---

## Generation — the bones

**Nothing is wired to a generator yet, deliberately.** Here is the honest state
of it:

| surface | status |
|---|---|
| Gamma | live in the Claude session, can generate images including `gemini-2.5-flash-image` |
| Adobe | image *editing* tools available; not generation |
| Figma | design tooling, not photographic generation |
| Canva | needs authorising before anything can be called |

Important limitation: those are connectors in a Claude session, **not** things
your Mac's CLI can call. For local generation you would add a provider API key
to `.env` — the same pattern `sentinel connect` already uses — and the run
should follow the procedure `docs/RATIFICATION.md` already ratified:

1. **Announce** exactly what will be requested, before requesting it
2. **Capture** the response bytes
3. **Hash** the capture before deriving anything from it
4. **Record** one provenance line
5. **Lead, not fact** — here, *illustration, not photograph*

### Rate limits belong in the design, not in your head

Whichever provider you use, cap it locally rather than discovering the ceiling
by hitting it:

- a per-day and per-month image budget, checked before the call
- one request per image, with the purpose written down first
- the prompt, model, provider and date recorded next to the result
- the file ingested with `origin: generated` and its `generation` block filled

That last point is what makes the whole thing safe: a generated image that
enters the library carries its own prompt and model forever, so nobody — you
included, in a year — can mistake it for a photograph.

### Before you ask for an image, write down why

The discipline that makes generated imagery useful rather than decorative:

> **Purpose.** What is this doing in the episode that type alone cannot?
> **Scene.** Which scene, at what duration?
> **Claim.** What does it assert? (If the answer is anything factual, do not
> generate it — photograph it or drop it.)

Three sentences. If you cannot write them, you do not need the image.

---

## The workflow, end to end

```bash
# 1. find and inventory
python3 modules/openmontage/visual_system/visual_manifest.py --find
python3 modules/openmontage/visual_system/visual_manifest.py "/your/photos"

# 2. declare your devices in visual_policy.json, then rescan
#    everything from your phone becomes own_camera automatically

# 3. review. Set review_status and approved_for_documentary in
#    visual_editorial_overrides.json, and add a credit.

# 4. what cleared?
python3 modules/openmontage/visual_system/visual_manifest.py "/your/photos" --approved

# 5. copy those into episodes/epNN/assets/ and cite the credit as `source`
```

Anything the inventory refused will say so, with the reason, every run — until
you either declare its origin or leave it out.
