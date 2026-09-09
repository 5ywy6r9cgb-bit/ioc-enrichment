# Recording an episode — what this pipeline expects

Assumes you can shoot and cut. This covers only what is specific to the
renderer: what the mp4 already contains, where the cut points are, and why the
finished runtime is not the rendered runtime.

---

## What the render already gives you

| in the file | do not re-do it |
|---|---|
| music bed | notched across 300–3400 Hz for your voice. Do not duck or EQ it |
| pacing | scene durations were written from word counts in the script |
| captions | `ep01.srt`, matching the on-screen wording |
| receipt | `ep01.manifest.json`, hashing every input |

**30fps.** Shoot 30, not 60, or the editor conforms your clips against the
timeline and softens them.

**Vertical framing.** Your eyeline belongs in the middle band. The top 300px
and bottom 360px go under the platform's header and buttons — the same box
`--check-safe` enforces on the type.

---

## The question scenes are placeholders, and they stretch

Each `question` scene types its question over the **first 55% of its duration**,
then holds. The typing is the part you keep; the hold is the part you replace.

Episode 01:

| scene | scene starts | typing completes | your cue | scene runs |
|---|---|---|---|---|
| 2 | 00:06.500 | 00:09.800 | ~6s | 6.0 → 9.3 |
| 6 | 00:37.500 | 00:41.075 | ~7s | 6.5 → 10.6 |
| 9 | 01:01.000 | 01:04.575 | ~8s | 6.5 → 11.6 |
| 11 | 01:15.500 | 01:18.800 | ~7s | 6.0 → 10.3 |

Cut to yourself full-frame the moment the question finishes typing. Cut back
when you are done.

**Runtime: 90.5s rendered → ~1:47 finished.** Everything downstream of each
answer shifts later. That is the format working, not drift — do not compress
your answers to preserve 90.5s.

Recompute for any episode: `scene_start + (dur × 0.55)` is the cut point.

---

## Or skip the editor entirely

Put your recordings in `takes/` beside the spec, name them in the scenes, and
the engine cuts the finished video itself.

```bash
mkdir -p takes
# copy your clips in, then in episode.json:
```

```jsonc
{ "type": "question", "dur": 6.0, "question": "What can a database prove?",
  "take": "takes/scene02.mov" },

{ "type": "title", "dur": 6.5, "title": "…",
  "vo_audio": "takes/vo_scene01.wav" }
```

| field | where it goes | what it does |
|---|---|---|
| `take` | a `question` scene | your clip runs full-frame after the question types on |
| `vo_audio` | any scene | your narration, mixed over the bed for that scene |

Then one command produces the finished film — bed, narration, your face, your
voice, captions, and a manifest hashing every file it used:

```bash
python3 ../../engine/openmontage.py --spec episode.json --out builds/ep01.mp4
```

**Where am I?**

```bash
python3 ../../engine/openmontage.py --spec episode.json --takes
```

Lists every scene, which takes have landed, which are missing, and what the
finished runtime will be. Renders nothing.

Notes that matter:

- **A take extends its scene.** The clip runs for its own full length; it is
  never trimmed to fit `dur`. The finished runtime grows, which `--takes`
  reports before you render.
- **Your clip is scaled and cropped to fill**, never letterboxed. Shoot a
  little wide.
- **A silent take is legal** — the mix just carries no voice from it.
- **A missing take stops preflight**, not minute three of a render.
- Levels do not shift as you record more. The mix uses `normalize=0`, so the
  bed stays where `audio_gain` put it whether you have supplied one clip or
  eight.

Everything below is for when you want an editor anyway — colour, b-roll,
anything the renderer does not do.

---

## Track layout

```
3   your camera        4 clips, over the question windows
2   narration          8 clips, at the script timecodes
1   ep01.mp4           the render
```

Narration should need only small nudges — the durations came from the word
counts. Import `ep01.srt` rather than auto-captioning; caption your four
answers by hand, since those words did not exist at render time.

---

## Pace

The export reports wpm. Episode 01 is **138**, at the brisk end. If a read
feels crowded, that is the spec, not you — add 0.5s to `dur` on the two
`bignum` scenes and re-render. Re-rendering costs two minutes; a re-shoot does
not.

Slate your takes with the scene number. The script numbers every scene, so a
slated take sorts itself.

---

## The manifest and the published file

```bash
python3 ../../engine/openmontage.py --verify builds/ep01.manifest.json
```

Your editor re-encodes on export, so **the published file will not match
`ep01.manifest.json`**. That manifest describes the render, which stays true
and worth keeping. Hash the published cut separately and keep both:

```bash
shasum -a 256 ~/Desktop/ep01_final.mp4 > ~/Desktop/ep01_final.sha256
```

Then [`RUNBOOK.md`](RUNBOOK.md) §11 before it goes out.
