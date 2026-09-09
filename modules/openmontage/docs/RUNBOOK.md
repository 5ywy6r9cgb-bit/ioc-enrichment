# Runbook — every command, in order

Everything here has been run and verified. No step is theoretical.

Paths assume you start at the repo root.

---

## 0. Get on the right branch — do this first

All of this lives on a branch. `main` still has the old two-file engine, so if
you are on `main` you will get `unrecognized arguments: --fonts` and there will
be no `episodes/` directory at all.

```bash
cd ~/sentinel
git fetch origin
git checkout claude/video-automation-workflow-thkmim
git pull
```

Check you landed:

```bash
git branch --show-current       # claude/video-automation-workflow-thkmim
ls modules/openmontage/engine   # brand.py om_audio.py om_motifs.py openmontage.py
```

If `brand.py` is missing you are still on `main`.

---

## 1. Once per machine

**Python packages.** Recent Homebrew Python refuses system-wide installs
(PEP 668: `error: externally-managed-environment`). Use a virtual environment:

```bash
python3 -m venv modules/openmontage/venv
source modules/openmontage/venv/bin/activate
pip install pillow numpy imagehash piexif pillow-heif
```

`pillow-heif` is the one people skip. **HEIC is the default iPhone photo
format and Pillow cannot open one without it** — every `.heic` comes back
`UnidentifiedImageError: cannot identify image file`, which reads like
corruption and is not. The files are fine; the decoder is missing.

That `source` line has to be run in **every new terminal** before rendering.
`bin/sentinel` calls plain `python3`, so it picks up the venv automatically
once activated — and silently falls back to system Python without it, which is
how you get "no module named PIL". To make it permanent:

```bash
echo 'source ~/sentinel/modules/openmontage/venv/bin/activate' >> ~/.zshrc
```

The one-line alternative is `pip3 install --break-system-packages pillow
numpy`. It works, and Homebrew warns it can break its own Python. The venv is
the safer path.

**ffmpeg:**

```bash
brew install ffmpeg       # already installed? then nothing to do
```

Confirm the machine can build — note the absolute path, so this works from
wherever you happen to be:

```bash
cd ~/sentinel/modules/openmontage/engine
python3 openmontage.py --fonts       # every type role must say "ok"
python3 openmontage.py --self-test   # 89 checks
python3 om_audio.py --self-test      # 41 checks
python3 ../visual_system/visual_manifest.py --self-test   # 60 checks
```

If `--fonts` shows MISSING, install the face it names or add a path you do
have to `_FONT_CANDIDATES` in `brand.py`. Nothing else will work until this
is clean.

**`sentinel: command not found`** — the launcher is not on your PATH. Either
call it as `bin/sentinel …` from the repo root, or add it once:

```bash
echo 'export PATH="$HOME/sentinel/bin:$PATH"' >> ~/.zshrc
```

---

## 2. Never paste code into the terminal

If a file needs to change, it gets committed and you `git pull` it. Do not
paste a Python file into zsh through a heredoc. Three things go wrong every
time, and all three did:

- **Smart quotes and non-breaking spaces.** Copying from a chat window or a
  document turns `"` into a curly quote and spaces into U+00A0. Python rejects
  the file with `invalid non-printable character U+00A0`, pointing at a line
  that looks perfect on screen.
- **`!` is history expansion in zsh.** `#!/usr/bin/env python3` becomes
  `zsh: event not found: /usr/bin/env`.
- **Indentation gets eaten**, giving `IndentationError` on a file that was
  correctly indented when you copied it.

A stray file named `#` in the repo root is the signature of a heredoc that went
wrong — that is a shell redirect into a file literally called `#`. Delete it.

```bash
git pull        # this is the transport. Always.
```

### When the pull refuses because you already wrote that file

```
error: The following untracked working tree files would be overwritten by merge:
        modules/openmontage/episodes/ep01/episode.json
```

Git is protecting you. It found a file on your machine that the incoming
commit also creates, and it will not silently replace your version. **Do not
delete it** — move it aside, pull, then decide with both in front of you:

```bash
cd ~/sentinel
mv modules/openmontage/episodes/ep01/episode.json /tmp/mine_ep01.json
git pull
diff /tmp/mine_ep01.json modules/openmontage/episodes/ep01/episode.json
```

Keep whichever you want, or lift scenes out of yours into the pulled one.
Nothing is lost, and you looked before choosing.

---

## 3. Build Episode 00 (already written)

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

## 4. Record and cut

See [`RECORDING.md`](RECORDING.md) for the cut points, the track layout, and
why the finished runtime is longer than the rendered one.

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

## 5. Music

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

## 6. A new episode

```bash
cd modules/openmontage/episodes
mkdir -p ep01/assets ep01/builds
cp ep00/episode.json ep01/episode.json
# edit ep01/episode.json: new title, new scenes, new footer
```

Then the same three commands as step 3, with `ep01`.

Photographs go in `ep01/assets/`. Read `docs/SHOTLIST.md` before you shoot —
it covers framing for the 9:16 crop, the standing kit worth capturing once,
naming, and what not to photograph.

A photo scene:

```jsonc
{
  "type": "photo",
  "dur": 4.0,
  "image": "assets/2026-09-08_fcmc-exterior_wide.jpg",
  "origin": "camera",                 // camera | licensed | generated
  "kick": "FRANKLIN COUNTY",
  "caption": "Where the docket is filed.",
  "source": "Photo: M. Rosenburg, 2026-09-08"
}
```

`source` and `origin` are both required and the build refuses without them.
`"origin": "generated"` draws an unremovable band across the top of the frame
reading ILLUSTRATION · GENERATED IMAGE · NOT A PHOTOGRAPH. See
[`VISUAL_POLICY.md`](VISUAL_POLICY.md).

---

## 7. The photo library

First, find where your photographs actually are:

```bash
cd ~/sentinel
python3 modules/openmontage/visual_system/visual_manifest.py --find
```

It searches `~/Pictures`, `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Movies`
and `/Volumes` (plug an external drive in first if that is where they live) and
lists every folder holding photographs, biggest first. It reads nothing and
writes nothing.

**An Apple Photos library is flagged, never descended into automatically** —
`--find` reports it and moves on. But you do not have to export 2GB to use it.

A `.photoslibrary` has two halves, and only one is a trap:

| inside the package | what it is |
|---|---|
| `originals/` | **your actual files**, EXIF intact, sharded into hex subfolders |
| `resources/derivatives/` | re-encoded thumbnails and renders — the trap |
| `database/` | Apple's SQLite. Never touch it |

So scan `originals/` directly, and keep the records outside the package so
nothing is ever written into it:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py \
  "$HOME/Pictures/Photos Library.photoslibrary/originals" \
  --manifest-dir ~/Pictures/TSR-records
```

`--manifest-dir` is what makes this safe: the source tree is read and never
written to. Filenames in there are UUIDs, which does not matter — `visual_id`
is derived from file content, not from the name.

Export instead when you want the files somewhere portable, or when your
library is in iCloud with **Optimise Mac Storage** on (then `originals/` holds
placeholders, not full images):

> Photos → select → File → Export → **Export Unmodified Original**

"Export Movie" and plain "Export" re-encode and strip metadata. Always
Unmodified Original for anything evidentiary.

**Export destination.** Make the library outside the repo and point Photos at
it:

```bash
mkdir -p ~/Pictures/TSR/2026-exports
```

Never export into `episodes/*/assets/`. That folder is for the handful of
cleared images one episode uses, and `.gitignore` refuses raw media there —
gigabytes in git history can never be removed, and a phone photo carries the
GPS coordinates it was taken at.

**Video.** This tool inventories stills only. Clips in the folder are counted
and reported — `N video file(s) SEEN BUT NOT INVENTORIED` — so you know they
are there, but they are not duplicate-checked, not origin-classified, and not
approvable. Keep them; they are b-roll. They just are not covered yet.

Then inventory the folder it names:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py "/path/it/printed"
```

It writes two files next to your photos:

| file | who owns it |
|---|---|
| `visual_manifest.json` | the machine. Rewritten every run. Never hand-edit it. |
| `visual_editorial_overrides.json` | **you.** Merged forward every run, never clobbered. |

It reports exact duplicates (same SHA-256), near-duplicates (perceptual hash —
burst shots, re-crops, re-exports), and hard links. Images too flat to compare
are excluded and counted separately, because a blank wall and an overexposed
sky hash alike and would otherwise group with everything.

**Nothing is approved by default.** Every image lands `unreviewed` and
`approved_for_documentary: false`. To clear a shot, edit the overrides file:

```jsonc
"vis_a1b2c3…": {
  "review_status": "reviewed",
  "approved_for_documentary": true,
  "credit": "Photo: M. Rosenburg, 2026-09-08",
  "description": "the counter at the clerk's office",
  "location_label": "Franklin County Municipal Court"
}
```

Then:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py ~/Pictures/TSR --approved
```

lists what has cleared. Copy those into `episodes/epNN/assets/` and use the
`credit` string as the photo scene's `source`.

### The library on a drive, and who owns it

If the photographs live on a flash drive — which keeps them off the laptop and
lets a second machine carry the package — register it as a shelf first, so an
unplugged drive refuses by name instead of scanning as an empty library. Same
place you declare authorship and export the schedule of works for a copyright
registration. See [`LIBRARY_ON_A_DRIVE.md`](LIBRARY_ON_A_DRIVE.md).

### Which photographs can hold type

An archive of two thousand frames has maybe forty that work behind words, and
finding them by eye is the whole evening. This measures it:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py \
  "/your/library" --manifest-dir ~/Pictures/TSR-records --backgrounds
```

```
  BACKGROUND FITNESS · /your/library
  38 of 1,974 can hold type at 1080x1920

  score   busy  luma  origin          verdict / file
  100.0    0.4    74  own_camera      good background
         2026-06-12/IMG_4411.jpeg
   35.0   65.1    91  own_camera      too busy where the type sits
         2026-04-03/IMG_2087.jpeg
```

| column | what it measures |
|---|---|
| `score` | 0–100. 65% how calm the band is where type sits, 35% how well it takes a scrim |
| `busy` | edge energy in that band. Over ~28, no scrim rescues it |
| `luma` | brightness of that band, 0–255. Over ~190 expect a heavy scrim |
| `!` | origin not declared — cannot be approved whatever it scores |

It measures the **lower-middle band** specifically, because that is where the
engine puts caption and credit. A gorgeous frame with a busy lower third is
the most common unusable photograph, and it looks fine until the words go on.

This narrows the pile. It does not pick. A score says a photograph *can* hold
words — never that it means anything, or belongs in a particular episode.

Note EXIF GPS: a phone photo usually carries the exact coordinates it was taken
at. Those are recorded in the manifest and never rendered into a frame.

---

## 8. Scene types

| type | required fields | what it does |
|---|---|---|
| `title` | `dur`, `title` | a claim, stated flatly |
| `question` | `dur`, `question` | **you, on camera.** Near-black chapter break |
| `quote` | `dur`, `label`, `quote`, `source` | a document exhibit |
| `photo` | `dur`, `image`, `caption`, `source`, `origin` | a photograph, full bleed |
| `bignum` | `dur`, `value`, `caption` | a figure the document produces |
| `vchart` | `dur`, `data`, `caption` | a line over time |
| `chart` | `dur`, `image`, `caption` | a chart image |
| `hash` | `dur`, `title`, `hash`, `cta` | the receipt |

Optional on any scene: `kick` (eyebrow), `sub`, `vo` (narration), `delivery`
(a note to yourself), `source_note`, `xfade` (`0` for a hard cut), `sfx`.

Durations that work: `title` 5–8s · `question` 5–7s · `photo` 3.5–5s ·
`quote` 8–10s · `bignum` 6–7s · `hash` 8–9s.

### Aspect ratio

`"preset"` takes one of three:

| preset | frame | safe box | for |
|---|---|---|---|
| `vertical` | 1080×1920 | top 300, bottom 1560 | TikTok, Reels, Shorts — **the default** |
| `square` | 1080×1080 | top 120, bottom 960 | feed posts |
| `landscape` | 1920×1080 | top 80, bottom 1000 | YouTube proper |

The type is sized against a 1920px-tall frame, so `landscape` renders every
line at 56% — correct proportionally, small on a phone. Cut vertical first and
re-render landscape from the same spec by changing one word.

---

## 8b. Checking a build after the fact

The manifest is the answer to "how do you know?". Checking it by eye means
comparing 64-character hex strings, which is a check people skip. Don't:

```bash
python3 ../../engine/openmontage.py --verify builds/ep01.manifest.json
```

It re-hashes the video and every input the build read, and says whether the
manifest still describes what is on disk:

```
VERIFY · builds/ep01.manifest.json
  built     2026-09-09T18:12:04Z · openmontage 0.3.0
  ok      output                 builds/ep01.mp4
  ok      hash_verified_source   data/graph_counts.json
  ok      spec                   episode.json

  every file matches. This manifest describes what is on disk.
```

Exit `0` clean, `4` if anything changed or went missing. Run it before you
publish and again before you hand the file to anyone. A `CHANGED` line on the
output means the mp4 was re-encoded or edited after the build — which is
exactly what happens when you export from a phone editor, so the published cut
needs its own manifest rather than borrowing this one.

---

## 9. Exit codes

`0` fine · `2` spec error · `3` a scene breaks the safe zone · `4` a manifest
no longer matches its files.

---

## 9b. Cutting your own footage in

```bash
python3 ../../engine/openmontage.py --spec episode.json --takes
```

Put clips in `takes/`, name them with `take` (question scenes) and `vo_audio`
(any scene), and `--out` produces the finished film with no editor involved.
See [`RECORDING.md`](RECORDING.md).

A safe-zone failure means content sits where the platform draws captions and
buttons. Fix the spec, don't ignore it — it looks right in a contact sheet and
wrong in the feed.

---

## 10. If something breaks

| symptom | cause | fix |
|---|---|---|
| `font missing` | fonts not resolving | `python3 openmontage.py --fonts` |
| `ffmpeg not found on PATH` | ffmpeg missing | `brew install ffmpeg` |
| `HASH MISMATCH` | a file changed after you wrote its hash | re-hash, or fix the file |
| `unknown audio_style '…'` | `audio_style` is one of three names, not a description | use `drone`, `groove` or `cipher` — see §5 |
| `untracked working tree files would be overwritten` | you wrote a file the pull also creates | move yours aside, pull, diff — see §2 |
| `photo not found` | path is relative to the spec file | check `assets/` |
| `a photo carries its credit` | `source` empty on a photo | add who shot it and when |
| `cannot be empty` on a quote | `source` empty | name the document |
| silent video | numpy missing | `pip3 install numpy` |
| renders but looks wrong | run the contact sheet first | `--contact-sheet` |

---

## 11. Before every publish

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
