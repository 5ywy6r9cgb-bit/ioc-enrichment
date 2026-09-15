#!/usr/bin/env bash
#
# deep_dive.sh — Ohio, data centres, surveillance, AI, gambling, HB6.
#
# ─────────────────────────────────────────────────────────────────────────
# READ THIS BEFORE PHASE 1
#
# Six of the things on this list are FEDERAL and reachable. Three are STATE
# and reachable by nobody here:
#
#   PUCO                 the Public Utilities Commission of Ohio docketing
#                        system (DIS). Where the data-centre tariff fight
#                        actually happened. NOT IN THIS TOOLKIT.
#   HB6 itself           an Ohio statute, debated in the Ohio General
#                        Assembly, lobbied through the Joint Legislative
#                        Ethics Committee. NOT IN THIS TOOLKIT.
#   parcels / abatements county auditor and township council. NOT HERE.
#
# BUT HB6 HAS A LARGE FEDERAL SHADOW and that part IS reachable: the
# prosecution was federal, the corporate resolution was federal, and the
# securities case was federal. Phase 4 goes after exactly that, and it is
# the strongest Ohio material available from this desk.
#
#   ./scripts/deep_dive.sh            what every phase costs, runs nothing
#   ./scripts/deep_dive.sh 1          run phase 1
#   ./scripts/deep_dive.sh 1 2 3      several, in order
#
# RATE LIMIT THAT ACTUALLY BITES: CourtListener is FIFTY CALLS AN HOUR and a
# sweep is eight per subject. Phase 3 alone is 128 calls. RUN ONE PHASE,
# READ IT, STOP. A 429 is UNKNOWN, not zero, and a run full of UNKNOWN
# teaches you nothing.
#
# NO ANGLE BRACKETS ANYWHERE — zsh reads `<` as redirection and a pasted
# block containing one takes the real commands above it down with it.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
S="bin/sentinel"

b()    { printf '\n\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
run()  { printf '\n\033[2m  $ %s\033[0m\n' "$*"; "$@"; }
pause(){ echo ""; warn "  ── PHASE $1 DONE ───────────────────────────────"; dim "  $2"; }

# ════════════════════════════════════════════════════════════════════════
phase_0() {
b "PHASE 0 — where you are. ZERO calls."
run $S today
run $S connect coverage
run $S connect nexus --gaps
pause 0 "Read the gaps list first. Three of the things you asked about live in offices no command here can reach, and knowing which is the difference between a gap and a finding."
}

# ════════════════════════════════════════════════════════════════════════
phase_1() {
b "PHASE 1 — THE OHIO SPINE: data centres, land, power, ratepayers"
dim "  cost: about 328 calls across five sets. THIS IS THE BIGGEST PHASE."
dim "  Consider running one sweep a day. Each is useful alone."
run $S connect sweep datacenters --go
run $S connect sweep intel_newalbany --go
run $S connect sweep newalbany --go
run $S connect sweep energy --go
run $S connect sweep ratepayers --go
pause 1 "Every one of these is a FEDERAL answer about a LOCAL story. The parcels, the abatements and the tariff are county and state records. An empty federal answer about a land deal is a fact about the register."
}

# ════════════════════════════════════════════════════════════════════════
phase_2() {
b "PHASE 2 — NEW ALBANY, ENTITY BY ENTITY"
dim "  The sweep asks eight registers per subject. These ask ONE register a"
dim "  specific question, which is how you get past a page cap."
dim "  cost: about 20 calls."
run $S connect opencorporates "New Albany Company"
run $S connect opencorporates "The Georgetown Company"
run $S connect opencorporates "Licking County Port Authority"
run $S connect senatelda --client "JOBSOHIO"
run $S connect senatelda --client "COLUMBUS REGIONAL AIRPORT AUTHORITY"
run $S connect awards "Licking County Port Authority" --all
run $S connect awards "Columbus Regional Airport Authority" --all
run $S connect awards "New Albany" --all --pages 3
pause 2 "JobsOhio is a PRIVATE non-profit and R.C. 187.04 puts it OUTSIDE the Ohio Public Records Act. That exemption is itself publishable and needs no request to establish - it is in the statute."
}

# ════════════════════════════════════════════════════════════════════════
phase_3() {
b "PHASE 3 — SURVEILLANCE AND AI, AND THE DOD OVERLAP YOU ASKED ABOUT"
warn "  --all IS NOT OPTIONAL HERE."
dim  "  Other Transaction Agreements under 10 U.S.C. 4022 sit OUTSIDE the FAR"
dim  "  and file as instrument type 11. A contracts-only run reported Intel's"
dim  "  DoD footprint as \$2,877,287 when the 09/11 family held \$220,948,789."
dim  "  That is 77x, and it is the single most expensive default in this desk."
dim  "  cost: about 216 calls. Run the sweeps on separate days."
run $S connect sweep surveillance --go
run $S connect sweep ai_defense --go
run $S connect sweep surveillance_money --go
pause 3 "Then phase 3b, which is where the DoD overlap actually appears."
}

phase_3b() {
b "PHASE 3b — THE DESCRIPTION FIELD IS THE FINDING"
dim "  'connect awards' searches by RECIPIENT, never by subject matter. You"
dim "  cannot ask it for 'every AI contract'. You ask about a NAMED company"
dim "  and READ THE DESCRIPTIONS it returns. That is where NSA's one-word"
dim "  \$34,811,793 RESEARCH came from, and DARPA's CHIPS trap."
dim "  cost: about 14 runs, each paged."
for n in "Palantir Technologies" "Anduril Industries" "Booz Allen Hamilton" \
         "Leidos" "CACI International" "Scale AI" "CoreWeave" \
         "Microsoft Corporation" "Amazon Web Services" "Oracle America"; do
  run $S connect awards "$n" --all --pages 5
done
run $S connect awards "Intel" --all --pages 8
run $S connect awards "Intel Federal" --all
pause 3b "READ THE DESCRIPTIONS, not the totals. A total under a stem name is a CEILING until the namesakes come out - 'awards \"Intel\"' returned 796 namesakes against 4 real contracts."
}

# ════════════════════════════════════════════════════════════════════════
phase_4() {
b "PHASE 4 — HB6: THE FEDERAL SHADOW OF A STATE STATUTE"
warn "  THIS IS THE STRONGEST OHIO MATERIAL THIS DESK CAN REACH."
dim  "  HB6 is an Ohio statute and the Ohio lobbying record is not here. But"
dim  "  the PROSECUTION was federal, the CORPORATE RESOLUTION was federal, and"
dim  "  the SECURITIES case was federal. Those are records you can hold."
dim  ""
dim  "  ADJUDICATED, not alleged. A conviction survived discovery and"
dim  "  cross-examination, which is evidence of a completely different kind"
dim  "  from a news report, and it is the reason this thread is safe to run."
dim  "  cost: rate-limited. CourtListener is 50/hour. GO SLOWLY."
run $S connect courtlistener "Householder" --dockets
run $S connect courtlistener "Generation Now" --dockets
run $S connect courtlistener "FirstEnergy" --dockets
run $S connect courtlistener "Energy Harbor" --dockets
pause 4 "Take the docket number each one returns and read the party table BY ROLE. Defendant means charged. No search result in this toolkit carries that distinction - only 'connect docket' does."
}

phase_4b() {
b "PHASE 4b — THE PARTY TABLE, AS THE COURT KEEPS IT"
warn "  DO NOT SKIP THIS AND DO NOT USE THE SEARCH RESULT'S PARTY FIELD."
dim  "  That field is TRUNCATED and has been caught CROSS-CONTAMINATED: a"
dim  "  Colorado docket carried Wisconsin's governor and election"
dim  "  commissioners. Thirteen names were published off it once, and one of"
dim  "  them was a court-appointed DEFENCE attorney."
dim  ""
dim  "  Substitute the docket numbers phase 4 returned. Example shape only:"
dim  "    bin/sentinel connect docket \"1:20-cr-00077\" --court ohsd"
echo ""
dim  "  Nothing runs in this phase. It is yours to type, with real numbers,"
dim  "  because a script that guesses a docket number is a script that"
dim  "  publishes the wrong case."
pause 4b "Then bring the money side: FirstEnergy and AEP corporate PACs."
}

# ════════════════════════════════════════════════════════════════════════
phase_5() {
b "PHASE 5 — THE MONEY AT THE OHIO SEATS"
dim "  cost: moderate FEC pagination. Writes a CSV."
run $S connect fecpac --committee C00140855 --cycle 2026   # FirstEnergy Corp PAC
run $S connect fecpac --committee C00096842 --cycle 2026   # AEP Cmte for Responsible Govt
run $S connect control C00140855 C00096842
run $S connect delegation OH --cycle 2026 --all --csv oh_delegation_2026.csv
pause 5 "The delegation table is INCUMBENTS ONLY unless you pass --all - the last run was 16 of a 116-name roster, and the tool says so on its own output. PAC% is a share of CONTRIBUTIONS, not receipts."
}

# ════════════════════════════════════════════════════════════════════════
phase_6() {
b "PHASE 6 — GAMBLING AND PREDICTION MARKETS"
dim "  cost: about 160 calls for the two sweeps."
run $S connect sweep gambling --go
run $S connect sweep prediction_markets --go
pause 6 "Then 6b - the court record, which is where this argument was actually settled."
}

phase_6b() {
b "PHASE 6b — THE ARGUMENT IS ALREADY IN A FEDERAL RECORD"
dim "  Kalshi litigated the CFTC over whether an event contract is a"
dim "  derivative or a bet. A JUDGE DECIDED IT on a record you can read."
dim "  That is worth ten times any speculation about why an app is addictive."
run $S connect courtlistener "Kalshi" --dockets
run $S connect regulationsgov "event contracts"
run $S connect federalregister "event contracts"
run $S connect senatelda --client "AMERICAN GAMING ASSOCIATION"
run $S connect senatelda --registrant "AMERICAN GAMING ASSOCIATION"
pause 6b "STATE lobbying is not in the Senate LDA. Legalisation happened state by state, fifty separate registers, none of them here. A federal-only search UNDERCOUNTS the effort systematically, and that has to be said on screen."
}

# ════════════════════════════════════════════════════════════════════════
phase_7() {
b "PHASE 7 — INFRASTRUCTURE AND TRANSPORT"
warn "  READ THE LIMIT FIRST."
dim  "  'connect awards' searches by RECIPIENT NAME, never by subject. You"
dim  "  CANNOT ask it for 'every tunnel contract'. You ask about a named firm"
dim  "  and read what comes back. Right-of-way, conduit permits and easements"
dim  "  are COUNTY ENGINEER records and appear nowhere here."
dim  "  cost: about 96 calls."
run $S connect sweep infrastructure --go
pause 7 "A data centre's fibre route is usually a LOCAL permit. A federal-only answer about physical infrastructure is a fact about the register, not about the ground."
}

# ════════════════════════════════════════════════════════════════════════
phase_8() {
b "PHASE 8 — FOLD IT ALL IN. ZERO CALLS."
dim "  Run this after ANY phase above. It gets better every time."
run $S connect coverage
run $S connect edges --out edges.csv
run $S connect nexus --asserted
run $S connect nexus --ohio --asserted
run $S connect nexus --side datacenters --side surveillance
run $S connect nexus --side datacenters --side ai_defense
run $S connect nexus --out nexus.csv --dot nexus.dot
run $S connect crosslink
run $S connect matrix
run $S connect box
pause 8 "Open evidence/box.html. Then pick the entity with the most ASSERTED edges and run 'connect explain' and 'connect challenge' on it."
}

# ════════════════════════════════════════════════════════════════════════
plan() {
  b "DEEP DIVE — the phases"
  cat <<'PLAN'

   0   where you are                          ZERO calls
   1   the Ohio spine: data centres, land,    ~328   THE BIGGEST
       power, ratepayers
   2   New Albany, entity by entity           ~20
   3   surveillance + AI sweeps               ~216   run on separate days
   3b  the DESCRIPTION field, company by      ~14 paged runs
       company — where the DoD overlap is
   4   HB6's federal shadow                   rate-limited, GO SLOW
   4b  the party table, BY ROLE               you type it, with real numbers
   5   the money at the Ohio seats            moderate, writes a CSV
   6   gambling + prediction markets          ~160
   6b  the CFTC court record                  ~5
   7   infrastructure and transport           ~96
   8   fold it all in                         ZERO calls

  WHAT NO PHASE HERE CAN REACH, AND WHO HOLDS IT
    PUCO docketing system (DIS)      the data-centre tariff fight
    Ohio General Assembly / JLEC     HB6 itself, and state lobbying
    Licking + Franklin auditors      parcels, prices, dates — FREE and ONLINE
    Ohio Dept of Development         tax abatements and TIF
    JobsOhio                         R.C. 187.04 — OUTSIDE the records act
    DOL OLMS                         unions. Nothing here touches labour.

  START HERE
    ./scripts/deep_dive.sh 0
    ./scripts/deep_dive.sh 8      (free — run after every phase)

  IF YOU ONLY DO THREE: phase 0, phase 4, phase 8.
  Where you are, the adjudicated federal record, and the fold-in.

PLAN
}

if [ "$#" -eq 0 ]; then plan; exit 0; fi
for p in "$@"; do
  case "$p" in
    0) phase_0 ;;  1) phase_1 ;;  2) phase_2 ;;  3) phase_3 ;;
    3b) phase_3b ;; 4) phase_4 ;; 4b) phase_4b ;; 5) phase_5 ;;
    6) phase_6 ;;  6b) phase_6b ;; 7) phase_7 ;; 8) phase_8 ;;
    *) warn "  no phase '$p'. Run with no arguments for the list."; exit 2 ;;
  esac
done
echo ""
ok  "  Done. Fold it in:  ./scripts/deep_dive.sh 8"
dim "  Then argue against yourself:  bin/sentinel connect challenge \"AN ENTITY\""
echo ""
