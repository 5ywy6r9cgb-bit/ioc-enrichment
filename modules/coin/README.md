# modules/coin: chain data as evidence

The coin module is standard-library Python and runs offline except when you ask it to fetch. `bin/sentinel-coin selftest` proves it on your machine; it runs 61 checks with no network.

## What it does that an explorer does not

- **It verifies from bytes.** For a Bitcoin transaction it re-derives the txid from the raw bytes (V1). It then checks the merkle proof against a block header whose proof of work it verifies (V2). Finally it can ask a second, independent index for the block at that height (V3). A source that serves the wrong transaction, or whose JSON contradicts its own bytes, is caught and never promoted.
- **It keeps every token separate.** A token is (chain, network, contract). USDC on Ethereum and USDC on Base are two assets, and a calculation that mixes them is refused.
- **It keeps lineage.** Every number is a calculation with a calc id. Each calculation lists its exact input rows, each row points at the SHA-256 of the response it came from, and each response has an envelope recording provider, endpoint (redacted), retrieval time, chain and verification. `provenance F-ID` re-proves the whole chain: it recomputes the number, re-hashes the raw files, and confirms each row is actually in the bytes it cites. Editing a raw file after intake is detected.
- **It separates the chain from the claim.** The report's sections are OBSERVED, DERIVED, ATTRIBUTION, SOURCE and VERIFICATION. Chain data can be VERIFIED while address attribution stays UNVERIFIED.
- **It prints token units, never dollars.** Amounts appear as "4,728,122.00 USDC", not "$4,728,122". A stablecoin unit is a claim on its issuer, and the ledger's number gate only treats `$` amounts as dollars.

## Setup

These are environment variables. Keep them in your shell or `.env`, never in the repo:

```
SENTINEL_BTC_RPC_URL=http://127.0.0.1:8332      # your own node (plain http allowed only for localhost)
SENTINEL_BTC_RPC_COOKIE=~/.bitcoin/.cookie      # or SENTINEL_BTC_RPC_USER / SENTINEL_BTC_RPC_PASS
SENTINEL_BTC_REST_URL=https://…                 # a REST index with the /tx/<txid> paths (needed for address history)
SENTINEL_BTC_REST2_URL=https://…                # optional second index: corroborates block hashes (V3)
BITCOIN_API_KEY=…                               # sent as a header only if set
SENTINEL_EVM_RPC_ETHEREUM=https://…             # any Ethereum JSON-RPC endpoint; _BASE, _POLYGON … likewise
SENTINEL_EVM_RPC2_ETHEREUM=https://…            # optional second endpoint: every log range is compared (V3 or MISMATCH)
SENTINEL_EVM_RPC_ETHEREUM_OWN=1                 # say so if the endpoint is your own node
STABLECOIN_API_KEY=…                            # registered from your design; no provider is wired yet
```

`bin/sentinel-coin sources` shows which variables are set and never prints their values. Credentials are sent in requests and redacted from everything stored: URLs, queries and error text. The self-test plants fake keys in the URL path, the query and the userinfo, then scans every stored file for them.

## The workflow for a case

1. `sentinel-coin addr check ADDRESS`: run this on every address you are handed. The checksum catches most typos before you query the wrong wallet.
2. `sentinel-coin connect stablecoin USDC address 0x… --chain ethereum --from-block N --to-block M`: this fetches, seals and normalizes the transfers. With the RPC2 variable set, every range is corroborated.
3. `sentinel-coin report address 0x… --symbol USDC --chain ethereum`: prints the OBSERVED / DERIVED / ATTRIBUTION / SOURCE / VERIFICATION block, with a calc id on every figure.
4. `sentinel-coin graph address 0x… --hops 2 --dot case.dot`: shows who the address touched. An edge is a movement, not a relationship.
5. `sentinel-coin signals`: looks for rug-pull and cash-out shapes: FRESH_MINT_FANOUT, LATE_MINT, POOL_DRAIN, RAPID_EXIT, CONCENTRATION, FAN_IN_FORWARD, ROUND_TRIP, PEEL_CHAIN and FLAGGED_COUNTERPARTY. These are leads with their ordinary explanations, never findings.
6. `sentinel-coin connect bitcoin tx TXID`: proves any Bitcoin transaction that matters. `verify rawtx HEX --txid … --header … --proof …` does the same offline for a transaction someone hands you.
7. `sentinel-coin attribute add ADDRESS --class OFFICIAL_ATTRIBUTION --source S-xx --locator "p. 4" --quote "…the line naming the address…"`: records who controls an address. Attribution comes from documents only. A provider label stays UNVERIFIED however many providers repeat it, and a private person is never named in any output.
8. `sentinel-coin link F-ID calc:… --statement "…"`, then `sentinel-coin provenance F-ID`: ties the published sentence to its calculations and re-proves the chain behind it.
9. `sentinel-coin export-ledger --out onchain.json`: exports linked calculations as ON_CHAIN_TRANSFER rows for the master ledger. They are marked as floors: the sum of the rows fetched, never a balance.

## Verification levels

| Level | Meaning |
|---|---|
| V0_REPORTED | One source said so. |
| V1_HASH_BOUND | The raw bytes hash to the transaction id. |
| V2_INCLUDED | The transaction is committed in a block header with valid proof of work at its stated difficulty; the work actually done is printed. |
| V3_CORROBORATED | A second, independent source returned the same data. |
| MISMATCH | Two sources disagree. Do not use the data until the disagreement is resolved. |

For EVM chains, logs are execution results. They cannot be re-derived from bytes alone, so they reach V3 by corroboration. A transaction itself can be hash-bound (V1).

## Limits

- Solana intake is file-based in this version: an explorer export goes through `bin/sentinel-ledger onchain`.
- Bitcoin address history needs an index, because a node has none. Rows from an index are REPORTED until `connect bitcoin tx` proves them.
- Which Bitcoin output is change is never assumed. "Sent" is gross inputs spent.
- The shipped USDC and USDT contracts come from model knowledge and are marked UNVERIFIED. They pass their EIP-55 checksums, which rules out a mistyped address but does not prove the issuer uses them. Confirm each one on the issuer's own list, then run `sentinel-coin token verify KEY --by NAME --where URL`.
