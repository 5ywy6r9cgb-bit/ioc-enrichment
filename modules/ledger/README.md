# modules/ledger — the publication station

The ledger is the desk's master evidence file: findings, money flows, figures, relationships, corrections, open records and a timeline. Every number carries the exact line, cell or page it came from. This module turns that file into a set of gates and tools.

It uses the Python standard library only. It makes no network call unless you run `verify-sources --go`, and it never contacts anyone.

## Commands

| command | what it does | exit code |
|---|---|---|
| `bin/sentinel-ledger summary` | Counts, and how much of the ledger is machine-verified | 0 |
| `bin/sentinel-ledger check` | Integrity gate: structure, references, the desk's publication rules, the verification record, your private list | 1 on any error |
| `bin/sentinel-ledger gate draft.md` | Checks every $ amount, % and × in a draft (details below) | 1 unless clean |
| `bin/sentinel-ledger card F-FARA-01` | Prints the approved wording, attribution, "does not show" limits, ordinary explanation, answered objections and open records | 3 if refused |
| `bin/sentinel-ledger card --publishable` | Prints every card cleared for publication | 0 |
| `bin/sentinel-ledger chain append` | Records this ledger version, hash-linked to the previous one | 0 |
| `bin/sentinel-ledger chain verify [--anchor HASH]` | Recomputes every link | 1 if broken |
| `bin/sentinel-ledger chain anchor` | Prints the head hash to keep somewhere this machine does not control | 0 |
| `bin/sentinel-ledger seal keygen` | Creates **your** 256-bit seal key on this machine | 0 |
| `bin/sentinel-ledger seal sign` / `seal verify` | HMAC-seals the chain head / checks every seal | 1 if invalid |
| `bin/sentinel-ledger diff old.json new.json` | Shows what changed between two versions: findings, figures, flows, statuses, verification | 0 |
| `bin/sentinel-ledger verify-sources [--go]` | Re-fetches the cited URLs politely and compares hashes. Without `--go` it only prints the plan. If a host's robots.txt cannot be reached, that host's sources are skipped unless you add `--robots-unreachable-ok` | 0 |
| `bin/sentinel-ledger trace "Clock Tower X" [--up] [--kind K] [--hops N]` | Follows the money hop by hop. Each kind of money is its own edge and is never added to another. It marks where money changes kind and where the trail stops, and why | 0 |
| `bin/sentinel-ledger why F-FARA-01` | The investigation screen: what happened before and after, actors, flows by kind, typed relationships with their causal rung, competing explanations, the discriminator, what would change our mind, and what the finding does not show | 0 |
| `bin/sentinel-ledger onchain export.csv` | Turns a blockchain explorer export into rows plus signals (not findings) | 0 |
| `bin/sentinel-ledger install-data new-ledger.json` | Files a new version under `evidence/ledger/` and chains it | 0 |
| `bin/sentinel-ledger selftest` | Runs offline in a temp directory and reports passed / failed / skipped | 1 on any failure |

### What the gate checks: the verbs

Every relationship in the ledger now has a class and two grades:

- **Class:** one of REPRESENTATION, CONTRACTUAL, FINANCIAL, ORGANIZATIONAL, DIRECTION, AUTHORITY, COORDINATION, ASSOCIATION, CO_OCCURRENCE and the other classes in `vocabularies.relationship_classes`.
- **Level (B0–B6):** how strong the documented link is.
- **Rung (C0–C7):** how far the evidence goes toward causation, from OBSERVED up to DIRECT CAUSATION.

Money rows count as documented interactions (C4) of their own kind.

The gate reads each sentence of a draft for words that promote past the evidence. These are the ten promotions of the Sentinel Epistemic Rule:

- sequence to causation
- co-occurrence to relationship
- relationship to coordination
- payment to direction
- access to influence
- incentive to motive
- secrecy to wrongdoing
- absence from search to nonexistence
- rarity in the corpus to rarity in the world
- allegation to fact

For each flagged word, the gate looks up the named parties and the strongest record between them. It fails the sentence when the record does not reach the claim, and it prints what the record does support. For example, "Clock Tower X coordinated with Havas Media Germany" fails. The strongest record between them is a contract schedule at C4, so the gate suggests "scheduled payments to (per the filing; payment not shown)". `examples/draft_verbs.md` shows each rule firing. `--numbers-only` skips the verb check.

### What the gate checks: the numbers

1. The number exists in the ledger.
2. It belongs to a finding cleared for that use.
3. The sentence describes it the way its record allows. The gate flags:
   - "paid" used for a contract schedule;
   - "gave" used for forwarded earmarks;
   - "paid" used for an award value;
   - an allegation not called one;
   - a multi-cycle total labelled 2024;
   - a floor printed as a total;
   - an independent expenditure called a gift;
   - concealment words where the record only shows a gap.

It also flags any number whose nearest ledger row names none of the parties in the paragraph.

## Your key, your seal

`seal keygen` writes 32 random bytes to `~/.sentinel/keys/ledger_seal.key` with owner-only permissions. The key never leaves this machine:
- it is never printed; only its 16-character fingerprint is shown;
- it is never uploaded;
- it is never stored in the repo.

Keep an offline copy. A lost key cannot be recovered.

The seal proves that you, holding that key, stood behind a given chain head. It is an HMAC, so only you can check it. Publish the anchor hash (`chain anchor`) if you want others to be able to hold you to a version.

## Your private list

Put strings that must never appear in a ledger in `~/.sentinel/ledger/forbidden.txt`, one per line: names of private people, case numbers, personal paths. `check` reports a match by line number only. It never prints the string.

## On-chain intake

Export transfers from a block explorer as CSV, then run:

```
bin/sentinel-ledger onchain export.csv --chain ethereum --labels labels.csv --flagged flagged.csv --out evidence/ledger/onchain/
```

- `labels.csv` and `flagged.csv` are `address,label,source`. Every flag must carry its source.
- Output files:
  - `onchain_rows.csv`: every row, with its transaction hash and the file's SHA-256;
  - `money_flows_onchain.json`: rows compatible with the ledger, kind `ON_CHAIN_TRANSFER`;
  - `signals.json`.

The signals are:

| signal | pattern |
|---|---|
| CONCENTRATION | a few addresses hold most of what moved |
| FRESH_MINT_FANOUT | newly minted tokens spread to many wallets fast |
| RAPID_EXIT | an early large receiver sent most of it out within the window |
| POOL_DRAIN | an address you labelled as a pool lost ≥ 50% of its inflow in one transfer |
| FAN_IN_FORWARD | many senders into one address, then forwarded on |
| ROUND_TRIP | the same amount went out and came back |
| FLAGGED_COUNTERPARTY | a transfer touched an address on your flagged list |

**Signals are leads, never findings.** Each one carries:
- the ordinary explanations for the pattern;
- the record that would settle it.

An address is not a person. Attribution needs an off-chain document.

## Files

- `ledger.py`: the command line.
- `lib_ledger.py`: shared helpers.
- `check.py`, `gate.py`, `card.py`, `chain.py`, `diff.py`, `verify_sources.py`, `onchain.py`: one file per command group.
- `selftest.py`: the self-test.

Ledger versions, the chain, seals, anchors and fetched sources live under `evidence/ledger/`, which git ignores.
