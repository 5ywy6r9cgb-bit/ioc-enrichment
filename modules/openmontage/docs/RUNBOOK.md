# Runbook — every command, in order

Everything here has been run and verified. No step is theoretical.

Paths assume you start at the repo root.

---

## 0. Once per machine

```bash
pip3 install pillow numpy

# ffmpeg — macOS
brew install ffmpeg
```

Confirm the machine can build:

```bash
cd modules/openmontage/engine
python3 openmontage.py --fonts       # every type role must say "ok"
python3 openmontage.py --self-test   # 56 checks
python3 om_audio.py --self-test      # 41 checks
```

If `--fonts` shows MISSING, install the face it names or add a path you do
have to `_FONT_CANDIDATES` in `brand.py`. Nothing else will work until this
is clean.

---

## 1. Build Episode 00 (already written)

```bash
cd modules/openmontage/episodes/ep00

python3 ../../engine/openmontage.py --spec episode.json --check-safe
python3 ../../engine/openmontage.py --spec episode.json --contact-sheet builds/sheet.png
python3 ../../engine/openmontage.py --spec episode.json --out builds/ep00.mp4
```

That last command writes four files into `builds/`:

| file | what it is |
|---|---|
| `ep00.mp4` | the video, 1080×1920, with the generated bed |
| `ep00.script.md` | **what you read.** Timecoded, paced, with your on-camera cues |
| `ep00.srt` | captions, for the edit app |
| `ep00.manifest.json` | the receipt — every input hashed |

**Before you publish, re-check the one field that rots:**

```bash
python3 ../../engine/openmontage.py --self-test | tail -1
```

Scene 6 says "56 checks run before a frame is drawn." If that number has
moved, change `value` in `episode.json` and re-render. It is the only claim
in the episode that goes stale on its own.

---

## 2. Record and cut

1. Open `builds/ep00.script.md` on the phone.
2. Record narration to the timecodes. One scene per take. Leave half a second
   of silence either side of each line so you can nudge sync.
3. Where the script says **YOU ARE ON CAMERA HERE** — do not read. Answer the
   question on screen. Four of those in Episode 00.
4. Drop `ep00.mp4` into Detail or Captions, lay your voice over it, cut yourself
   into the four black question scenes.
5. Import `ep00.srt` for captions rather than auto-generating — the wording is
   already what you wrote.

If a take needs a second thought, the scene is too short. Change `dur` in
`episode.json`, re-render, do it again. The bones are cheap to move; the take
is not.

---

## 3. Music

Three styles. Set per episode in the spec:

```jsonc
"audio_style": "cipher",     // drone | groove | cipher
"audio_seed": 3,             // changes the variation, not the palette
"audio_notch_db": -14.0,     // more negative = more room for your voice
"audio_gain": 0.9
```

| style | tempo | use it for |
|---|---|---|
| `drone` | — | sparse, one voice, heavy material |
| `groove` | 124 | momentum, process, data, long-form |
| `cipher` | 122 | investigation, money, networks — the signature sound |

Export a standalone loop to drop into the phone edit:

```bash
cd modules/openmontage/engine
python3 om_audio.py --cipher ~/Desktop/TSR_ep01.wav --minutes 4 --seed 3
python3 om_audio.py --groove ~/Desktop/TSR_alt.wav  --minutes 4 --seed 7
```

Every loop is seam-exact — the end joins the beginning with no click, so it
repeats under a long video without a join you can hear.

If your voice feels crowded in the mix, push `--notch` to `-16`. Nothing else
needs to change.

---

## 4. A new episode

```bash
cd modules/openmontage/episodes
mkdir -p ep01/assets ep01/builds
cp ep00/episode.json ep01/episode.json
# edit ep01/episode.json: new title, new scenes, new footer
```

Then the same three commands as step 1, with `ep01`.

Photographs go in `ep01/assets/`. Read `docs/SHOTLIST.md` before you shoot —
it covers framing for the 9:16 crop, the standing kit worth capturing once,
naming, and what not to photograph.

A photo scene:

```jsonc
{
  "type": "photo",
  "dur": 4.0,
  "image": "assets/2026-09-08_fcmc-exterior_wide.jpg",
  "kick": "FRANKLIN COUNTY",
  "caption": "Where the docket is filed.",
  "source": "Photo: M. Rosenburg, 2026-09-08"
}
```

`source` is required and the build refuses without it.

---

## 5. Scene types

| type | required fields | what it does |
|---|---|---|
| `title` | `dur`, `title` | a claim, stated flatly |
| `question` | `dur`, `question` | **you, on camera.** Near-black chapter break |
| `quote` | `dur`, `label`, `quote`, `source` | a document exhibit |
| `photo` | `dur`, `image`, `caption`, `source` | a photograph, full bleed |
| `bignum` | `dur`, `value`, `caption` | a figure the document produces |
| `vchart` | `dur`, `data`, `caption` | a line over time |
| `chart` | `dur`, `image`, `caption` | a chart image |
| `hash` | `dur`, `title`, `hash`, `cta` | the receipt |

Optional on any scene: `kick` (eyebrow), `sub`, `vo` (narration), `delivery`
(a note to yourself), `source_note`, `xfade` (`0` for a hard cut), `sfx`.

Durations that work: `title` 5–8s · `question` 5–7s · `photo` 3.5–5s ·
`quote` 8–10s · `bignum` 6–7s · `hash` 8–9s.

---

## 6. Exit codes

`0` fine · `2` spec error · `3` a scene breaks the safe zone.

A safe-zone failure means content sits where the platform draws captions and
buttons. Fix the spec, don't ignore it — it looks right in a contact sheet and
wrong in the feed.

---

## 7. If something breaks

| symptom | cause | fix |
|---|---|---|
| `font missing` | fonts not resolving | `python3 openmontage.py --fonts` |
| `ffmpeg not found on PATH` | ffmpeg missing | `brew install ffmpeg` |
| `HASH MISMATCH` | a file changed after you wrote its hash | re-hash, or fix the file |
| `photo not found` | path is relative to the spec file | check `assets/` |
| `a photo carries its credit` | `source` empty on a photo | add who shot it and when |
| `cannot be empty` on a quote | `source` empty | name the document |
| silent video | numpy missing | `pip3 install numpy` |
| renders but looks wrong | run the contact sheet first | `--contact-sheet` |

---

## 8. Before every publish

```bash
python3 ../../engine/openmontage.py --spec episode.json --check-safe
```

Then read this list:

- [ ] every number on screen re-verified against its source today
- [ ] every `quote` and `photo` names its document or its photographer
- [ ] no private individual's face, name, or address anywhere in `assets/`
- [ ] nothing in the episode characterizes a person — documents and dates only
- [ ] the manifest is beside the video, and you kept it

The last one matters more than it looks. The manifest is what lets you answer
"how do you know?" with a command instead of an argument.
