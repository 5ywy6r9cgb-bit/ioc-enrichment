#!/usr/bin/env bash
#
# desk_bootstrap.sh — stand up the claim layer on what is already in evidence/.
#
# WHY THIS EXISTS. The sdesk instructions were handed over as a block full of
# <case> and <file> placeholders. zsh reads `<` as redirection, so the whole
# paste died on a parse error — including the two commands that were real.
# A command you cannot paste is a command that does not exist.
#
# WHAT IT DOES: the mechanical half only — init the desk, create a case,
# and ingest the captures already on disk with correct titles, custodians
# and shelving.
#
# WHAT IT DELIBERATELY DOES NOT DO: add claims. The whole point of this desk
# is that a person takes responsibility for every sentence. A script that
# writes claims for you is a script that launders authorship. It prints the
# exact `claim add` and `cite` lines instead, with real ids filled in, for
# you to read and run yourself.
#
# Safe to re-run: ingesting the same bytes twice is addressed by hash.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESK="$ROOT/modules/sentinel-desk"
CAPTURES="${SENTINEL_EVIDENCE_DIR:-$ROOT/evidence}/captures"
CASE="${1:-minnesota-fraud}"
TITLE="${2:-Minnesota program integrity}"

sdesk() { ( cd "$DESK" && python3 -m sentinel "$@" ); }

b() { printf '\033[1m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

echo ""
b "  SENTINEL DESK — bootstrap"
dim "  case      $CASE"
dim "  captures  $CAPTURES"
echo ""

if [ ! -d "$CAPTURES" ]; then
  warn "  No captures directory at $CAPTURES"
  warn "  Run some connectors first — there is nothing to vault."
  exit 2
fi

# ---- 1. the desk itself --------------------------------------------------
sdesk doctor >/dev/null 2>&1 || sdesk init
sdesk case new "$CASE" "$TITLE" --jurisdiction US 2>/dev/null \
  || dim "  case $CASE already exists — continuing"

# ---- 2. identify captures BY CONTENT, not by filename --------------------
#
# The fedregtext captures were all named `..._full_text_text_2026__<stamp>`
# because the slug is the fetched URL truncated at 60 characters, which cuts
# off the document number. Fixed going forward; for files already on disk the
# only reliable identifier is inside the bytes. `FR Doc No: 2026-00596`
# appears in every Federal Register full text.
ingest_fr() {
  num="$1"; label="$2"; custodian="$3"
  f=""
  for c in "$CAPTURES"/*fedregtext*.json "$CAPTURES"/*fedregdoc*"${num//-/_}"*.json; do
    [ -f "$c" ] || continue
    if grep -q "FR Doc No: $num" "$c" 2>/dev/null || grep -q "\"$num\"" "$c" 2>/dev/null; then
      f="$c"; break
    fi
  done
  if [ -z "$f" ]; then
    dim "  $num — no capture on disk yet"
    dim "      bin/sentinel connect fedreg $num --text"
    return
  fi
  sdesk ingest "$CASE" "$f" \
    --title "FR $num — $label" \
    --custodian "$custodian" \
    --shelf PRIMARY 2>&1 | sed 's/^/  /'
}

b "  Federal Register — PRIMARY shelf"
ingest_fr 2026-00596 "Termination of Somalia TPS designation" "Federal Register / DHS-USCIS"
ingest_fr 2026-00512 "CMS hearing, Minnesota Medicaid program integrity" "Federal Register / HHS-CMS"
ingest_fr 2026-05497 "Executive Order 14395, Task Force To Eliminate Fraud" "Federal Register / Executive Office of the President"
ingest_fr 2026-03968 "CRUSH request for information" "Federal Register / HHS-CMS"
ingest_fr 2025-19928 "Proclamation 10989, 2020 election pardons" "Federal Register / Executive Office of the President"
ingest_fr 2026-10817 "OMB Regulation for Federal Financial Assistance" "Federal Register / OMB"

echo ""
b "  Court records — PRIMARY shelf"
for c in "$CAPTURES"/*cldocket*.json "$CAPTURES"/*clparties*.json; do
  [ -f "$c" ] || continue
  sdesk ingest "$CASE" "$c" \
    --title "CourtListener docket record — $(basename "$c" | cut -c1-48)" \
    --custodian "CourtListener / RECAP (PACER)" \
    --shelf SECONDARY 2>&1 | sed 's/^/  /'
done

echo ""
b "  What is in the vault"
sdesk ready "$CASE" 2>&1 | sed 's/^/  /'

# ---- 3. hand back the claims, to be owned by a person ---------------------
cat <<'GUIDE'

  ────────────────────────────────────────────────────────────────────
  NOW THE PART NO SCRIPT SHOULD DO FOR YOU

  Run `sentinel claim list` after each one — the desk will tell you what
  blocks it. An uncited GREEN claim is BLOCKED on purpose.

  Tiers:  GREEN   you hold the document and the number has a denominator
          ARITH   it is arithmetic on figures you hold
          REPORTED someone else reported it — including good outlets
          VERIFY  you believe it and cannot yet show it
          RED     contested
          DEAD    disproven. Keep it. A killed claim is a finding.

GUIDE

cat <<GUIDE
  cd $DESK

  python3 -m sentinel claim add $CASE \\
    "DHS cited the Feeding Our Future prosecutions in the Federal Register notice terminating Somalia's TPS designation" \\
    --tier GREEN --origin human --by "M. Griswold"

  python3 -m sentinel claim add $CASE \\
    "In FR 2026-00596, 'Minnesota' appears 7 times and 'country conditions' 3 times across 943 lines" \\
    --tier ARITH --formula "occurrence counts over line count of the hashed full text" \\
    --origin human --by "M. Griswold"

  python3 -m sentinel claim add $CASE \\
    "Executive Order 14395 describes 'an organized ring of Somali immigrants and others'" \\
    --tier GREEN --origin human --by "M. Griswold"

  python3 -m sentinel claim add $CASE \\
    "EO 14395 cites a SNAP payment error rate as evidence of theft; a payment error rate is overpayments plus underpayments and measures administrative accuracy" \\
    --tier VERIFY --origin human --by "M. Griswold" \\
    --origin-note "needs the USDA FNS state and national error-rate tables"

  Then attach documents. Get ids from:  python3 -m sentinel claim list

  python3 -m sentinel cite <CLAIM_ID> <DOC_ID> \\
    --locator "line 741 of the hashed full text" \\
    --quote "under the sponsorship of Feeding Our Future"

  And before you record anything:

  python3 -m sentinel ready $CASE
  python3 -m sentinel trace <CLAIM_ID>

GUIDE
