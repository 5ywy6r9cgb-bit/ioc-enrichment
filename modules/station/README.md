# modules/station: the ledger as a public website

The station turns the ledger into a self-contained static website. It uses the standard library only; share images are optional and need Playwright. `bin/sentinel-station selftest` proves the safety rules offline, with 20 checks.

| Command | What it does |
|---|---|
| `build [--out site] [--theme T] [--approve NAME] [--sign] [--base-url URL]` | Builds the site. Without `--approve`, every page carries a "Preview" bar. |
| `verify DIR` | Re-hashes every file against `manifest.json` and checks the Ed25519 signature. Exits 1 on any change. |
| `keygen` | Creates your publishing key (`~/.sentinel/station/publisher.key`, mode 600). Prints only the public key and fingerprint. Never overwrites an existing key. |
| `viewer DIR OUT.html` | Writes the ledger signature as a standalone p5.js art viewer. Its seed is the ledger itself. |
| `images DIR` | Renders share cards (1200×630), the 10-slide carousel (1080×1350) and the social image. |
| `artifact DIR OUT` | Re-packs a site for hosts that wrap the entry page. |
| `themes` | Lists the 10 theme-factory themes with their measured contrast. |

## What reaches the site

- Findings published with attribution, in full: the approved statement, word-for-word anchors, what the finding does not show, the causal rung and competing explanations, money (one panel per kind), relationships, objections, open records and sources.
- Open questions, as the question only.
- The money, figures, relationships, dated events, corrections and sources behind those findings.

## What never does

- Findings awaiting re-pull, on hold or internal. These are counted on the front page, with the reason.
- The firewall text.
- Private people's names, and the desk's working-file names (a desk file is shown by its id and SHA-256).
- Desk notes.
- Anything on `~/.sentinel/ledger/forbidden.txt` or a `--forbidden FILE`.

## What every build checks

These checks run before anything is written:

1. Every title, headline, statement, question, limit line, dated event and correction goes through the ledger's number gate and the Sentinel Epistemic Rule. A single failure refuses the build.
2. Every output file is scanned for never-print strings, local paths, e-mail addresses and case identifiers.
3. `manifest.json` and `SHA256SUMS` list every file with its SHA-256. With `--sign`, `manifest.sig` holds an Ed25519 signature over the manifest's exact bytes, and `publisher.json` holds your public key. The verify page re-hashes every file in the visitor's browser.
4. The front-page drawing is computed from the SHA-256 of `data/public-ledger.json`, so the image itself is a checksum anyone can reproduce.
5. The full desk ledger's SHA-256 is published as a commitment. It proves later that held findings came from the ledger that existed on the build date, without revealing them now.
