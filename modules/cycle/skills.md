SENTINEL DESK - COMMAND CARD                                        cycle/1.0.1
  Run everything from the repo:   cd ~/sentinel
  zsh: never paste a trailing "# comment". zsh hands it to the command as arguments.
  Filter this card:  bin/sentinel-cycle skills WORD

EVERY MORNING (the schedule does this for you)
  bin/sentinel-cycle run --go            integrity, due searches, fold-in, records desk, chain anchor
  bin/sentinel-cycle digest              one page: what ran, what failed, what needs you
  bin/sentinel-cycle verify              re-hash the last record and walk the record chain
  bin/sentinel pra foia                  records requests that need you, most urgent first
  bin/sentinel dash                      the dashboard over every case

KNOW WHAT YOU HAVE
  bin/sentinel-cycle plan                what runs today, and why
  bin/sentinel-cycle doctor              keys, seal, never-print list, gitignore, schedule, disk
  bin/sentinel-cycle status              schedule, lock, recent runs and their record hashes
  bin/sentinel connect test              which connector keys are set and reachable
  bin/sentinel watch status              saved searches, and when each last ran
  bin/sentinel-ledger summary            the ledger in one screen

LIBRARY - SOURCES AND APIS
  bin/sentinel-cycle library list        every source: active, proposed, approved, rejected
  bin/sentinel-cycle library list --topic ohio
  bin/sentinel-cycle library show ID     what it holds, what it cannot show, how to start
  bin/sentinel-cycle library check       dry run: the exact calls a check would make
  bin/sentinel-cycle library check --go  does each source page still answer
  bin/sentinel-cycle library approve ID --by NAME     adopt a proposed source (append-only record)
  bin/sentinel-cycle library reject ID --by NAME --note WHY
  bin/sentinel doc get "URL"             capture a primary source, hashed and text-extracted

RESEARCH - EVERY HIT IS A LEAD UNTIL A PRIMARY RECORD SAYS IT
  bin/sentinel connect all "SUBJECT"     search every source at once
  bin/sentinel connect sweep SET --go --only CONNECTOR --new-only
  bin/sentinel connect crosslink         what appears under more than one subject (no network)
  bin/sentinel connect brief "NAME"      everything the library holds on one name
  bin/sentinel connect vendor "FIRM"     the reverse lookup: who pays this firm
  bin/sentinel connect awards "NAME"     federal contracts, with what they bought
  bin/sentinel connect matrix            the library as CSVs, plus a ranked worklist
  bin/sentinel doc bills                 bills that appear in more than one lobbying filing
  sentinel-hunt why                      where a collision came from, and what it is NOT
  sentinel-hunt falsify "CLAIM"          try to break your own claim before anyone else does

LEDGER - WHAT CAN BE SAID, AND HOW
  bin/sentinel-ledger check              every number, quote and hash re-verified
  bin/sentinel-ledger why F-ID           the investigation screen for one finding
  bin/sentinel-ledger trace ENTITY       money hop by hop; kinds are never added together
  bin/sentinel-ledger gate DRAFT.md      numbers and verbs checked before anything ships
  bin/sentinel-ledger card F-ID          one finding as a card
  bin/sentinel-ledger verify-sources --go    every cited URL re-fetched and compared

ROUTES - EVERY NUMBER TO ITS FINDINGS, MARKED IS / WAS / OPEN
  bin/sentinel-routes build              routes.json and routes.csv in evidence/ledger/
  bin/sentinel-routes ladder             where every finding stands, and its first blocker
  bin/sentinel-routes finding F-ID       every route into one finding
  bin/sentinel-routes row ID             every finding one number feeds, and its divisions
  bin/sentinel-routes denominators --flagged
  bin/sentinel-routes open --p1          what is not concrete, and the record that settles it
  bin/sentinel-routes pass SP-04         one strength-pass item in full
  bin/sentinel-routes ie-audit --notices FILE    IE rows against the FEC notice file

COIN
  bin/sentinel-coin sources              which chain endpoints are configured
  bin/sentinel-coin token list           token identities: UNVERIFIED until you check the issuer
  bin/sentinel-coin connect bitcoin tx TXID
  bin/sentinel-coin provenance ID        re-prove a number back to the response bytes
  bin/sentinel-coin signals              patterns worth a look, each with its ordinary explanation

INTEGRITY - BY HAND, BECAUSE IT IS YOUR ATTESTATION
  bin/sentinel-ledger chain verify       then: bin/sentinel-ledger chain anchor
  bin/sentinel-ledger seal sign          then: bin/sentinel-ledger seal verify
  bin/sentinel-station build --approve NAME --sign     only after you have read every page
  bin/sentinel-station verify site

SCHEDULE
  bin/sentinel-cycle schedule show       the launchd job, before it is installed
  bin/sentinel-cycle schedule install    every morning; a sleeping Mac runs it on wake
  bin/sentinel-cycle schedule status
  bin/sentinel-cycle schedule uninstall

NEVER AUTOMATIC
  Sending (pra mail send), approving, signing, publishing, committing, pushing,
  generating keys and changing ledger data. The cycle refuses every one of them.

THE RULE UNDER ALL OF IT
  sequence is not causation . co-occurrence is not a relationship
  a relationship is not coordination . a payment is not direction
  access is not influence . an incentive is not a motive . secrecy is not wrongdoing
  absence from a search is not nonexistence . an allegation is not a fact
  an address is not a person . a label from an index is not an identity
