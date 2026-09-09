# openmontage — the montage engine

Code-driven video. The engine knows **how** to render; the spec knows **the
story**. Scenes in, MP4 out, plus a build manifest proving exactly which files
produced which video.

```
engine/openmontage.py     the renderer — never edited per episode
engine/brand.py           colour, type, presets, safe zones. One definition.
engine/om_motifs.py       drawn iconography. No stock art, no licensing question.
example/demo.json         a working spec that exercises every scene type
```

## Check it runs here first

```bash
cd modules/openmontage/engine
python3 openmontage.py --fonts        # which font file each type role resolves to
python3 openmontage.py --self-test    # 36 checks
```

Then render the example, which is 28 seconds and needs nothing but ffmpeg:

```bash
cd ../example
python3 ../engine/openmontage.py --spec demo.json --check-safe
python3 ../engine/openmontage.py --spec demo.json --contact-sheet builds/sheet.png
python3 ../engine/openmontage.py --spec demo.json --out builds/demo.mp4
```

Every claim in `demo.json` is a checkable fact about this repository — including
a `hash` scene whose displayed SHA-256 is verified against `data/checks.json` at
build time. Change one byte of that file and the build refuses to render rather
than display a hash the file does not have.

## Commands

```bash
openmontage.py --spec S --dry-run              # validate, render nothing
openmontage.py --spec S --check-safe           # validate + exit 3 on a safe-zone break
openmontage.py --spec S --contact-sheet P.png  # every scene on one sheet
openmontage.py --spec S --poster P.png         # scene 1 only
openmontage.py --spec S --out builds/v.mp4     # render + manifest
openmontage.py --fonts                         # type resolution on this machine
openmontage.py --self-test
```

Exit codes: `0` ok · `2` spec error · `3` safe-zone violation.

## What v0.3 changed

**The engine now runs on a Mac.** Font paths were hardcoded to
`/usr/share/fonts/...`, which exists on Linux and not on macOS — the platform
`Install-Sentinel.command` targets. The engine failed in preflight with "font
missing" before drawing a frame. `brand.py` gives every type role a candidate
list and takes the first file that exists, so one project folder builds on a
laptop, a Linux box, and in CI. `--fonts` shows what resolved and what was
tried.

**The palette has a home.** Colour, type, presets and safe zones moved into
`brand.py`. It was previously defined inside the renderer, so any second
surface wanting to look like The Sentinel Report had to copy it — and a copied
palette is not a brand, it is two brands that look alike until one drifts.
Legacy names still resolve: `sentinel_light`, `broadsheet`, `"color": "red"`
and `"grey"` all keep working, so specs written for v0.2 still build.

**Safe zones are enforced, not merely drawable.** A vertical video loses its
top ~300px to the platform header and its bottom ~360px to captions, the handle
and the like button. The engine could draw those guides but never checked
against them, so content could sit perfectly in a contact sheet and be covered
in the feed. `--check-safe` renders each scene, measures the ink, and fails the
build. Turning it on found three real bugs immediately:

- the `vchart` x-axis labels hung 5px below the safe floor
- the `hash` CTA sat 77px into the caption zone
- a long `sub` line silently overprinted the closing line

All three are fixed by anchoring layout to the safe box instead of to a fixed
offset from frame height.

**Kickers fit the frame.** The eyebrow was set at one size with wide tracking,
so anything longer than a couple of words ran clean off both edges —
"VALIDATED BEFORE FFMPEG STARTS" rendered as "TED BEFORE FFMPEG". It now
tightens tracking, then shrinks type, and stops at the first fit.

**Per-scene crossfade.** A scene may set `"xfade"` to override the global
value, including `0` for a hard cut.

## Writing a spec

`example/demo.json` is the reference. The shape:

```jsonc
{
  "preset": "vertical",           // vertical | square | landscape
  "theme": "sentinel_light",      // sentinel_light | sentinel_dark
  "fps": 24,
  "footer": "SHOWN ON EVERY FRAME",
  "crossfade": 0.45,              // seconds; a scene may override with "xfade"
  "scenes": [ /* … */ ]
}
```

| scene | required fields |
|---|---|
| `title` | `dur`, `title` |
| `bignum` | `dur`, `value`, `caption` |
| `vchart` | `dur`, `data`, `caption` |
| `chart` | `dur`, `image`, `caption` |
| `hash` | `dur`, `title`, `hash`, `cta` |

Paths in a spec resolve relative to the spec file, so a project folder is
portable. Colours are names (`"accent"`, `"cyan"`, `"gold"`, `"green"`,
`"muted"`, `"ink"`), never literals.

Everything is validated before ffmpeg is launched — unknown scene type, missing
field, zero or non-numeric duration, missing asset, unknown colour, marker month
absent from the data, malformed, duplicate or out-of-order months, non-hex hash.
Nothing renders 400 frames and then dies.

## The manifest

Every render writes `<name>.manifest.json`: the SHA-256 of the spec, of every
data file and image it read, and of the output MP4, plus renderer version,
ffmpeg version, frame count, and the claim text of each scene. The video
becomes auditable — anyone can re-run the hashes and confirm which files
produced which file.
