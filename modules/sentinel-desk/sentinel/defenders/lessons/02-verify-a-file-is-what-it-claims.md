---
id: verify-a-file-is-what-it-claims
level: 1
minutes: 60
prerequisites: []
tools: [shasum, python3, file]
nist_csf: [PR.DS-01, DE.CM-09, ID.AM-08]
attack_context: [T1036.008, T1565.001]
teaches_offense: false
scope: files the student created or already holds
---

# Lesson 2 — Verify a file is what it claims

## Why this matters

A filename is a claim made by whoever sent you the file. It is not evidence.

This is not usually malice. Agencies producing public records routinely hand
out files named `.pdf` that are ZIP archives of scanned page images. A pipeline
that trusts the extension runs `pdftotext`, gets nothing, and records
*"document contains no text"* — which is false, and which quietly removes a
real document from an investigation.

The same habit that catches that catches a `.pdf.exe`. One lesson, two payoffs.

## What you need

Files you already have. No downloads.

## Workflow

**1. Make a file that lies, so you can see it lie.**

```bash
mkdir -p ~/lesson2 && cd ~/lesson2
printf 'hello' > page1.jpeg && printf 'hello' > page2.jpeg
zip -q pages.zip page1.jpeg page2.jpeg
cp pages.zip evidence_production.pdf     # a ZIP wearing a PDF name
```

**2. Ask the file itself.**

```bash
file evidence_production.pdf
head -c 4 evidence_production.pdf | xxd
```

`PK..` is the ZIP signature. A real PDF starts `%PDF-`. The first four bytes
outrank the last four characters of the name, always.

**3. Read the signature yourself.**

```python
python3 - <<'PY'
from pathlib import Path
SIGS = {b'%PDF-': 'PDF', b'PK\x03\x04': 'ZIP or OpenXML',
        b'\xff\xd8\xff': 'JPEG', b'\x89PNG': 'PNG', b'MZ': 'Windows executable'}
for p in Path('.').iterdir():
    if p.is_file():
        head = p.open('rb').read(8)
        kind = next((v for k, v in SIGS.items() if head.startswith(k)), 'unknown')
        print(f'{p.name:34} claims {p.suffix or "(none)":8} actually {kind}')
PY
```

**4. Look inside the container before concluding.**

`PK` alone is ambiguous — a `.docx` is also a ZIP. Open it:

```bash
unzip -l evidence_production.pdf
```

All images → a scanned production needing OCR. `[Content_Types].xml` → an
Office document. That distinction changes what you do next.

**5. Pin it with a hash.**

```bash
shasum -a 256 evidence_production.pdf
```

The hash is the file's identity from that moment. Record it when the file
arrives, not when you get around to it. Re-run it later to prove nothing
changed — including that *you* didn't change it, which is the version of this
that matters when someone challenges your work.

**6. Prove the hash detects a change.**

```bash
shasum -a 256 evidence_production.pdf > before.txt
printf 'x' >> evidence_production.pdf
shasum -a 256 -c before.txt        # FAILED
```

Do this once, by hand. Students who have watched a hash fail trust hashes.
Students who have only read about them do not.

## Verification

1. Name three files on your machine whose real type you confirmed by signature.
2. Show a hash you recorded and re-verified.
3. Explain why `PK` is not a complete answer.

## Where students get it wrong

- **Trusting `file` and stopping.** It reads signatures, so it is right far
  more often than the extension — but it guesses on ambiguous input. Look inside.
- **Hashing after working on it.** A hash taken after you have opened, moved,
  renamed and converted a file proves only that it hasn't changed since you
  finished changing it.
- **MD5 out of habit.** Use SHA-256. MD5 collisions are trivially producible.
- **Assuming a mismatch means attack.** Almost always it is a bad export or a
  lazy converter. Report what you observed, not what you suspect.

## Write it up

Standard template. The **evidence** row must contain the actual commands and
the actual output — not "I verified the file type."

## Instructor notes

- The forged-file exercise takes four minutes and is the one students remember.
  Make everyone build it themselves; watching does not land.
- Real material is better if you have it. A genuine agency production that is
  secretly a ZIP of images makes the point instantly and shows this is a real
  workflow problem, not a contrived puzzle.
- Discussion: *why* does an agency produce records this way? Usually a scanner
  and no intent at all. Distinguishing "obstruction" from "an old scanner" is
  a judgement students will need constantly.

## Framework mapping

| Framework | ID | Relationship |
|---|---|---|
| NIST CSF 2.0 | `PR.DS-01` | Confidentiality, integrity and availability of data-at-rest are protected |
| NIST CSF 2.0 | `DE.CM-09` | Computing hardware, software and files are monitored for adverse events |
| NIST CSF 2.0 | `ID.AM-08` | Systems, hardware, software and data are managed through their lifecycle |
| MITRE ATT&CK | `T1036.008` | Masquerade File Type |
| MITRE ATT&CK | `T1565.001` | Stored Data Manipulation |

> Verify IDs against the current framework release before using them in
> assessed work.
