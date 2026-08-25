# Adding API keys

## Never paste a key into a chat, an issue, or a commit

Anything typed into a conversation may be retained or logged, and anything
committed is in git history until the key is rotated — which is the only real
remedy, because `git rm` does not remove it from history.

The repo defends this in three places, none of which help if you paste a key
into a chat window:

- `.gitignore` excludes `.env` and everything under `evidence/`
- CI fails on any tracked `.env` or credential-shaped string in any tracked file
- `guard.py` refuses to store credential-shaped text in the desk's audit chain,
  because that chain is append-only and cannot be edited afterwards

## Where keys go

One file, on your Mac, never committed:

```bash
cd ~/sentinel
touch modules/pra/.env
chmod 600 modules/pra/.env
```

`chmod 600` means your account only. On a shared machine the default would let
every other user read it.

## The format

One `NAME=value` per line. No quotes, no spaces around `=`, no trailing comment
on the same line:

```
OPENSANCTIONS_API_KEY=...
DATA_GOV_API_KEY=...
FEC_API_KEY=...
OPENCORPORATES_API_KEY=...
COURTLISTENER_API_TOKEN=...
BLS_API_KEY=...
LDA_API_KEY=...
```

## Paste the key, not the sentence around it

The single most common failure, and it looks like a rejected key rather than a
paste mistake:

```
FEC_API_KEY       you…0N (63 chars)   → KEY REJECTED (HTTP 403)
DATA_GOV_API_KEY  you…01 (54 chars)   → KEY REJECTED (HTTP 403)
```

An api.data.gov key is **exactly 40 characters**. Both of those were far too
long and both began `you` — the "Your API key is: …" line from the signup email
had been pasted along with the key.

`connect test` now checks the shape before it makes any network call, so this
reports as `KEY MALFORMED — 63 chars` with the expected length, instead of
sending you hunting for a stray quote in a value that is twenty characters too
long. Expected shapes:

| Variable | Shape |
|---|---|
| `DATA_GOV_API_KEY` | exactly 40 letters and digits |
| `FEC_API_KEY` | same — it is an api.data.gov key |
| `OPENSANCTIONS_API_KEY` | 24–64 letters and digits |
| `OPENCORPORATES_API_KEY` | 20–64 letters, digits, underscores |
| `COURTLISTENER_API_TOKEN` | 20–64 letters and digits |
| `BLS_API_KEY` | 32 hex characters |

`DATA_GOV_API_KEY` is worth knowing about: **one api.data.gov key serves several
connectors at once** — Regulations.gov, BLS, and others on that platform. If you
have one of those, you already have all of them.

## Check them

```bash
bin/sentinel connect test
```

Prints which keys are set and which hosts answer. It does not print the keys.
Two failures that look similar and are not:

- **key not set** — the variable is missing from `.env`, or `.env` is not where
  the module looks for it
- **host unreachable** — the key may be perfectly good and the network is
  refusing. This is what happened in the build sandbox: six connector hosts were
  rejected at CONNECT by an egress proxy. Network policy, not the connectors.

Then run one for real:

```bash
bin/sentinel connect opensanctions "Householder"
```

A hit files into the evidence inbox as a **lead**, never a fact. A connector
matched a string. It has not established that the string is the same person, and
nothing in the system can promote it to a finding on its own.

## When a key leaks

Rotate it. Do not try to scrub it.

Deleting the file, amending the commit, or force-pushing does not undo the
exposure — the key may already sit in a log, a fork, a cache, or someone's
clone. Rotating is the only step that actually revokes access, and every
provider above supports it from a dashboard in under a minute.
