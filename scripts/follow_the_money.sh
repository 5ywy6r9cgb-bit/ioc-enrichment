#!/usr/bin/env bash
#
# follow_the_money.sh — foreign lobbying, politics, and the money, in phases.
#
# ─────────────────────────────────────────────────────────────────────────
# WHY THIS IS A SCRIPT AND NOT A LIST
#
# A list of sixty commands pasted into a terminal is a rate-limit violation
# with extra steps. CourtListener allows FIFTY CALLS AN HOUR. A sweep is
# eight calls per subject. Three sweeps back to back is 400+ calls and the
# second one starts answering 429, which this desk has learned to read as
# UNKNOWN and not as zero — but a run full of UNKNOWN teaches you nothing.
#
# So this runs in PHASES. Each one announces what it will cost, stops, and
# waits for you. You can run one phase a day and lose nothing.
#
#   ./scripts/follow_the_money.sh            what every phase costs, runs nothing
#   ./scripts/follow_the_money.sh 1          run phase 1
#   ./scripts/follow_the_money.sh 1 2 3      run several, in order
#   ./scripts/follow_the_money.sh all        everything, with pauses between
#
# ─────────────────────────────────────────────────────────────────────────
# WHAT IT DELIBERATELY DOES NOT DO
#
# It does not make a claim, write a script, or decide what anything means.
# Every phase ends by telling you which command reads the result back and
# which `sdesk claim add` you would have to own. A script that concludes for
# you is a script that launders authorship.
#
# NO ANGLE BRACKETS ANYWHERE. zsh reads `<` as input redirection and a
# pasted block containing one takes the real commands above it down with it.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
S="bin/sentinel"

b()    { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

run() {
  printf '\n\033[2m  $ %s\033[0m\n' "$*"
  "$@"
}

pause() {
  echo ""
  warn "  ── PHASE $1 DONE ─────────────────────────────────────────────"
  dim  "  $2"
  if [ "${RUN_ALL:-0}" = "1" ]; then
    dim "  pausing 60s before the next phase, so the rate limits recover"
    sleep 60
  fi
}

# ═════════════════════════════════════════════════════════════════════════
phase_0() {
b "PHASE 0 — is the desk healthy, and what is already held"
dim "  cost: ZERO live calls. Nothing here touches the network."
run $S connect test
run $S connect list
run $S connect nexus --gaps
run $S connect crosslink
pause 0 "Read the gaps list. Six joins no command here can reach, each with the office that holds it."
}

# ═════════════════════════════════════════════════════════════════════════
phase_1() {
b "PHASE 1 — FOREIGN LOBBYING: the register boundary, established first"
warn "  READ THIS BEFORE THE RESULTS."
dim  "  FARA covers agents of a FOREIGN PRINCIPAL. A domestic advocacy group —"
dim  "  including one whose entire subject is another country's affairs —"
dim  "  registers under the LDA and appears NOWHERE in FARA. AIPAC is not a"
dim  "  FARA registrant. That nothing is a fact about the register, not a"
dim  "  failed search, and whether it OUGHT to be one is an argument no"
dim  "  database settles. There is also no FARA connector in this toolkit."
dim  "  cost: about 96 live calls. This is the longest phase."

run $S connect sweep foreign_lobby --go
pause 1 "Next: phase 2 asks each direction separately, which is where the answer is."
}

# ═════════════════════════════════════════════════════════════════════════
phase_2() {
b "PHASE 2 — THE TWO DIRECTIONS, WHICH ARE DIFFERENT QUESTIONS"
dim "  --client      who lobbies FOR this name"
dim "  --registrant  who this FIRM files for"
dim "  They are one word apart and they produce opposite answers. Every run"
dim "  below now prints which one it asked, on an 'asking' line."
dim "  cost: 14 calls."

run $S connect senatelda --client "AMERICAN ISRAEL PUBLIC AFFAIRS COMMITTEE"
run $S connect senatelda --registrant "AMERICAN ISRAEL PUBLIC AFFAIRS COMMITTEE"

# The firms that DO carry foreign principals. Search strings, not allegations.
for f in "MERCURY PUBLIC AFFAIRS" "QORVIS" "BGR GOVERNMENT AFFAIRS" \
         "BALLARD PARTNERS" "SQUIRE PATTON BOGGS" "AKIN GUMP STRAUSS HAUER & FELD"; do
  run $S connect senatelda --registrant "$f"
done

# The strongest single lead out of the Blackstone run: a small registrant
# with a very large client. --registrant asks who ELSE they file for, which
# the client-side search cannot reach.
run $S connect senatelda --registrant "MINDSET ADVOCACY"
run $S connect opencorporates "Mindset Advocacy"

pause 2 "A registrant list says who a firm files for. It does NOT say what the firm argued or which side its client took — the LDA has no such field."
}

# ═════════════════════════════════════════════════════════════════════════
phase_3() {
b "PHASE 3 — THE MONEY, BY CATEGORY, NEVER SUMMED"
warn "  FOUR NUMBERS, NOT ONE."
dim  "    a committee's OWN contributions"
dim  "    money it FORWARDED for donors who earmarked it — NOT its money"
dim  "    independent expenditures FOR a candidate"
dim  "    independent expenditures AGAINST one"
dim  "  Adding them produces a figure that describes nothing that happened."
dim  "  cost: heavy on FEC pagination. Run this one alone."

run $S connect fecpac --committee C00799031 --cycle 2026   # United Democracy Project
run $S connect donors "UNITED DEMOCRACY PROJECT"
run $S connect asymmetry --committee C00799031 --dimension vendor --cycle 2026
run $S connect filings "UNITED DEMOCRACY PROJECT"

pause 3 "A page cap makes a FLOOR, not a total. If the run says it hit the cap, the real number is larger by an unknown amount and the word FLOOR goes beside it on screen."
}

# ═════════════════════════════════════════════════════════════════════════
phase_4() {
b "PHASE 4 — THE CONTROL, AND YOU MUST BE WILLING TO LOSE IT"
warn "  THIS IS THE MOST IMPORTANT PHASE IN THE SCRIPT."
dim  "  `connect control` asks what several committees SHARE: treasurer,"
dim  "  custodian of records, address, email, website, connected organisation."
dim  "  A treasurer is a named legal officer personally responsible for a"
dim  "  committee's filings."
dim  ""
dim  "  IF IT COMES BACK WITH NOTHING SHARED, THAT IS A FINDING AND YOU"
dim  "  PUBLISH IT. It is the answer to the accusation you will otherwise be"
dim  "  accused of implying. A negative control you report is worth more than"
dim  "  a positive one you assert."
dim  ""
dim  "  And it is ROUTINELY INNOCENT even when positive — compliance firms"
dim  "  supply treasurers to dozens of committees as a service. Control is"
dim  "  not motive."
dim  "  cost: 2-6 calls."

run $S connect control C00797670 C00799031
pause 4 "Write the result down either way, before you look at anything else. A control you only report when it agrees with you is not a control."
}

# ═════════════════════════════════════════════════════════════════════════
phase_5() {
b "PHASE 5 — THE VENDOR LAYER, WITH ITS OWN CONTROLS"
dim "  A vendor paid almost entirely by one committee and a vendor paid by"
dim "  three hundred are different analytical objects. NEITHER is evidence of"
dim "  coordination — concentration is computed, coordination is a legal"
dim "  question about conduct that a payment record cannot answer."
dim "  The two controls are the point of this phase, not an afterthought."
dim "  cost: vendor searches page deeply. 4 runs, each up to 25 pages."

run $S connect vendor "OVERTON STRATEGIES LLC" --pages 25
run $S connect vendor "C2G STRATEGIES LLC" --pages 25
run $S connect vendor "SWITCHBOARD PUBLIC BENEFIT CORP." --pages 25
run $S connect vendor "MINDSET ADVOCACY" --pages 10

pause 5 "Report the CONTROLS beside the concentrated one, in the same breath. A concentration figure with no comparison is a number wearing a finding's clothes."
}

# ═════════════════════════════════════════════════════════════════════════
phase_6() {
b "PHASE 6 — POLITICS: money to NAMED OFFICEHOLDERS"
warn "  THE DENOMINATOR IS ON THE TABLE ITSELF. READ IT."
dim  "  The default delegation table is INCUMBENTS ONLY. The last run said so:"
dim  "  16 of 16 with totals filed, and 100 non-incumbent candidates on the"
dim  "  116-name cycle roster left out. --all includes everyone."
dim  "  Also: election_year is who is ON THE BALLOT, so a senator mid-term is"
dim  "  missing from the table entirely. Check the other class separately."
dim  "  cost: moderate. Writes a CSV you can sort."

run $S connect delegation OH --cycle 2026 --all --csv oh_delegation_2026.csv

# The corporate PACs behind the Ohio energy and data-centre story. `fecpac`
# resolves a name to a committee and PRINTS THE MATCHES rather than choosing
# between a connected PAC and a super PAC for you.
run $S connect fecpac --committee C00096842 --cycle 2026   # AEP Cmte for Responsible Govt
run $S connect fecpac --committee C00140855 --cycle 2026   # FirstEnergy Corp PAC
run $S connect control C00096842 C00140855

pause 6 "PAC% is a share of CONTRIBUTIONS, not receipts — so it cannot be flattered by a candidate lending their own campaign money. Last run it spanned 13.9% to 74.2% across ONE delegation."
}

# ═════════════════════════════════════════════════════════════════════════
phase_7() {
b "PHASE 7 — REAL-ESTATE CAPITAL, AND THE CONFLATION THAT KILLS IT"
warn "  BLACKROCK AND BLACKSTONE ARE DIFFERENT COMPANIES."
dim  "  BlackRock is an ASSET MANAGER. Its index funds hold shares as"
dim  "  fiduciary for other people's retirement money, so 'BlackRock owns X'"
dim  "  nearly always means 'funds BlackRock manages hold X on behalf of"
dim  "  pension holders' — a different sentence, and a 13F states it plainly."
dim  "  Blackstone takes DIRECT ownership. Run them apart, report them apart."
dim  "  cost: about 112 calls for the sweep. Consider running phase 7b alone."

run $S connect sweep real_estate_capital --go
pause 7 "Now 7b, which is the part that connects to Ohio."
}

phase_7b() {
b "PHASE 7b — THE BRIDGE YOU ALREADY OWN"
dim "  QTS Data Centers is Blackstone-owned and is already in your"
dim "  datacenters set. Direct PE ownership of a data-centre operator,"
dim "  inside an investigation already running. cost: about 12 calls."

run $S connect opencorporates "QTS Realty Trust"
run $S connect senatelda --client "QTS DATA CENTERS"
run $S connect awards "QTS" --all
run $S connect all "Blackstone Inc"

pause 7b "Re-read the Blackstone CourtListener rows with the new fourth verdict. A 1980 hotel and a Massachusetts town's Conservation Commission were being counted as a 2026 investment firm. CHECK THE DATE — a record older than the entity is not that entity."
}

# ═════════════════════════════════════════════════════════════════════════
phase_8() {
b "PHASE 8 — THE BRIDGE, GRADED, WITH A DENOMINATOR ON EVERY ROW"
dim "  cost: ZERO live calls. Everything here is already on disk."
dim "  Run this after ANY phase above and it gets better each time."

run $S connect nexus
run $S connect nexus --asserted
run $S connect nexus --side datacenters --side lobbying
run $S connect nexus --ohio --asserted
run $S connect nexus --out nexus.csv --dot nexus.dot
run $S connect matrix
run $S connect crosslink

pause 8 "ASSERTED means somebody swore to it — an LDA filing, a federal award, a court docket. CO-OCCURRENCE means two names were in one document, which is never a finding on its own. Every row carries how many entities cross the same pair."
}

# ═════════════════════════════════════════════════════════════════════════
phase_9() {
b "PHASE 9 — WHAT BLOCKS PUBLICATION. Run this BEFORE you record."
dim "  cost: ZERO live calls."
run $S sdesk doctor
run ./scripts/desk_bootstrap.sh
run $S sdesk claim list
run $S sdesk ready minnesota-fraud
run $S shots --spec modules/openmontage/episodes/ep02/episode.json --check

echo ""
warn "  AND THE ONE THING NO COMMAND HERE WILL DO FOR YOU"
dim  "  The FEC API key is still in cleartext in the provenance ledger."
dim  "  ROTATE IT, then:"
dim  "      bin/sentinel prov verify evidence/manifests/provenance.jsonl"
pause 9 "An uncited GREEN claim is BLOCKED on purpose. `sdesk claim list` tells you what blocks each one."
}

# ═════════════════════════════════════════════════════════════════════════
plan() {
  b "FOLLOW THE MONEY — the phases"
  cat <<'PLAN'

   0   health, and what is already held        ZERO calls
   1   foreign lobbying sweep                  ~96 calls   the long one
   2   the two directions, asked separately    ~14 calls
   3   the money, by category, never summed    heavy FEC pagination
   4   THE CONTROL — be willing to lose it     2-6 calls   the important one
   5   the vendor layer, with its controls     4 deep runs
   6   politics: money to named officeholders  moderate, writes a CSV
   7   real-estate capital                     ~112 calls
   7b  the bridge you already own (QTS)        ~12 calls
   8   the bridge, graded                      ZERO calls
   9   what blocks publication                 ZERO calls

  RATE LIMITS THAT ACTUALLY BITE
    CourtListener   50 calls an hour. A sweep is 8 per subject.
    FEC             pages deeply; a page cap makes a FLOOR, not a total.
    Anything 429    is UNKNOWN. It is NOT zero, and this desk will not
                    record it as zero.

  RUN ONE PHASE, READ IT, THEN RUN THE NEXT. A run you did not read is a
  rate limit you spent on nothing.

    ./scripts/follow_the_money.sh 0
    ./scripts/follow_the_money.sh 1
    ./scripts/follow_the_money.sh 8      (free — run it after every phase)

  IF YOU ONLY DO THREE THINGS:  phase 4, phase 8, phase 9.
  The control, the graded bridge, and finding out what blocks publication
  before you record rather than after.

PLAN
}

# ═════════════════════════════════════════════════════════════════════════
if [ "$#" -eq 0 ]; then plan; exit 0; fi

if [ "$1" = "all" ]; then
  RUN_ALL=1
  set -- 0 1 2 3 4 5 6 7 7b 8 9
fi

for p in "$@"; do
  case "$p" in
    0) phase_0 ;;  1) phase_1 ;;  2) phase_2 ;;  3) phase_3 ;;
    4) phase_4 ;;  5) phase_5 ;;  6) phase_6 ;;  7) phase_7 ;;
    7b) phase_7b ;; 8) phase_8 ;; 9) phase_9 ;;
    *) warn "  no phase '$p'. Run with no arguments to see the list."; exit 2 ;;
  esac
done

echo ""
ok "  Done. Fold it in:  bin/sentinel connect nexus --asserted"
dim "  Then own the sentences:  bin/sentinel sdesk claim add CASE \"text\" --tier GREEN"
echo ""
