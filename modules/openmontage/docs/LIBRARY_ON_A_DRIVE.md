# The library on a drive, and the copyright behind it

Two things that belong together: the photographs live on removable media, and
the record of who made them travels with the photographs.

**Not legal advice.** This produces the schedule of works a registration
application asks for. The filing is yours, and the Copyright Office states its
own procedure, group limits and fees — check copyright.gov, or ask a lawyer.

---

## Why a drive changes the failure mode

An unplugged drive scans as an empty library. Zero images prints calmly, exits
clean, and reads as *there are no photographs* when the fact is *nobody
looked*. macOS makes it worse: eject uncleanly and `/Volumes/NAME` survives as
an empty folder, so every path under it still resolves.

`modules/corpus/shelf.py` already solved this for the document corpus, down to
the four distinct ways `/Volumes` lies. The photo library borrows it rather
than learning it twice.

### Register the drive once

```bash
python3 modules/corpus/shelf_cli.py init /Volumes/TSR1 --label TSR1 \
  --note "photo library, 2026"
```

That writes a marker file carrying the volume's own id, so the drive is
identified by what it *is* rather than by where it happened to mount. Then:

```bash
python3 modules/openmontage/visual_system/visual_manifest.py TSR1
```

A shelf name instead of a path. If the drive is out, you get a refusal naming
it — never an empty result.

### Keep the records on the drive

```bash
python3 modules/openmontage/visual_system/visual_manifest.py TSR1 \
  --manifest-dir /Volumes/TSR1/records
```

The manifest, the overrides and the policy travel with the photographs. Plug
the drive into a different machine and the whole library — including every
editorial decision and the authorship block — is there. Nothing lives only on
the laptop.

---

## Declaring authorship, once

First scan writes `visual_policy.json`. Fill in the copyright block:

```jsonc
{
  "own_devices": ["Apple iPhone 15 Pro"],
  "copyright": {
    "author": "Mark W. Rosenburg",
    "claimant": "Mark W. Rosenburg",
    "work_type": "photograph",
    "default_publication_status": "unpublished",
    "notice_year": "2026"
  }
}
```

`claimant` differs from `author` only if you have assigned the copyright to a
business entity. Everything else inherits from here; an individual image can
override it in `visual_editorial_overrides.json`.

The © line is then generated for you and stored in the manifest:

> © 2026 Mark W. Rosenburg. All rights reserved.

**Copyright exists the moment the shutter closes.** None of this creates it.
What it does is record — once, while you still remember — the facts nobody can
reconstruct from a folder of JPEGs two years later.

---

## The field people get wrong

`publication_status`. Posting a photograph publicly is generally publication;
keeping it in a private archive is not. It matters because published and
unpublished works are filed under different procedures and **a group cannot
mix them**.

So the export writes two separate files and never one. Per image, when it goes
out:

```jsonc
"vis_a1b2c3…": {
  "publication_status": "published",
  "date_published": "2026-07-01",
  "description": "Substation at dusk, Pataskala"
}
```

`description` becomes the work's title in the schedule. Without one, the
filename is used — which is fine for a group and poor for anything you would
name individually.

---

## The schedule of works

```bash
python3 modules/openmontage/visual_system/visual_manifest.py TSR1 \
  --manifest-dir /Volumes/TSR1/records --registration
```

```
  SCHEDULE OF WORKS · /Volumes/TSR1
  author     Mark W. Rosenburg
  claimant   Mark W. Rosenburg
  notice     © 2026 Mark W. Rosenburg. All rights reserved.

  unpublished    612
  published       38
  EXCLUDED         7  (listed in the summary, with reasons)

  -> registration_unpublished.csv  (612 work(s))
  -> registration_published.csv    (38 work(s))
```

Each row carries title, author, claimant, capture date, publication date,
dimensions, the file, and its SHA-256.

### What is excluded, and why that is the point

| reason | why |
|---|---|
| no author declared | a registration naming an author the library cannot evidence is worse than a smaller registration |
| generated | a model made it. Whatever the law settles on, this library will not claim human authorship of one |

Both are listed by name in `registration_summary.json`. Nothing is dropped
silently.

**The schedule lists works, not files.** Two byte-identical copies are one
work — deduplicated by content hash, which is the same `visual_id` that makes
an image citable in an episode spec.

---

## What the hashes are actually worth

A SHA-256 recorded on a given date does not prove authorship and no honest
system should claim it does. What it proves is that *this exact file* is the
one the record describes — so a later copy, crop or re-export can be shown to
be derived from it rather than the other way round.

That is an evidentiary aid, not a registration. Registration is what gives you
statutory damages and attorney's fees, and it is a filing, not a file.

---

## Before you unplug

```bash
python3 modules/openmontage/visual_system/visual_manifest.py TSR1 --check-only
```

Reports, writes nothing. Confirms the drive is really there and the manifest
still describes what is on it.

One drive is one drive. A library that exists in exactly one place is one
dropped bag from gone — and the schedule of works is the part that cannot be
re-derived, because it carries decisions rather than files.
