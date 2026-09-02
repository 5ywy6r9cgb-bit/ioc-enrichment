#!/bin/bash
# =====================================================================
# Install Sentinel — double-click this file.
#
# It finds sentinel-os.bundle in your Downloads folder, unpacks it into
# ~/Sentinel, checks that the tools it needs are installed, runs the test
# suite to prove it works, and puts a "Sentinel.command" launcher on your
# Desktop that you can double-click from then on.
#
# It does not touch the network except to check tool versions.
# It does not install anything without telling you first.
# Safe to run more than once.
# =====================================================================

# No `set -e`. If a step fails, this script must STAY OPEN and explain,
# not vanish and leave a closed window with no message in it.

HOME_DIR="$HOME"
DEST="$HOME_DIR/Sentinel"
BRANCH="claude/atlasos-public-records-3yhj5h"

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; X=$'\033[0m'

say()  { printf '%s\n' "$1"; }
ok()   { printf '  %sOK%s   %s\n' "$G" "$X" "$1"; }
warn() { printf '  %sNOTE%s %s\n' "$Y" "$X" "$1"; }
bad()  { printf '  %sSTOP%s %s\n' "$R" "$X" "$1"; }

pause_and_exit() {
  printf '\n%sPress Return to close this window.%s\n' "$DIM" "$X"
  read -r _
  exit "${1:-0}"
}

clear
say ""
say "  ${B}SENTINEL — INSTALLER${X}"
say "  ${DIM}Named Sources · Public Documents · Verified Facts${X}"
say ""
say "  This will install to: ${B}$DEST${X}"
say ""

# ------------------------------------------------------- 1. find the bundle
say "  ${B}1. Finding the download${X}"

BUNDLE=""
for candidate in \
  "$HOME_DIR/Downloads/sentinel-os.bundle" \
  "$HOME_DIR/Desktop/sentinel-os.bundle" \
  "$(dirname "$0")/sentinel-os.bundle" \
  "$HOME_DIR/Downloads/sentinel-os.bundle.txt"
do
  if [ -f "$candidate" ]; then BUNDLE="$candidate"; break; fi
done

# Safari sometimes appends a number: sentinel-os-2.bundle
if [ -z "$BUNDLE" ]; then
  BUNDLE="$(ls -t "$HOME_DIR"/Downloads/sentinel-os*.bundle 2>/dev/null | head -1)"
fi

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  bad "Could not find sentinel-os.bundle."
  say ""
  say "  I looked in your Downloads folder and on your Desktop."
  say ""
  say "  Download the file from the chat first, then run this again."
  say "  If it is somewhere else, drag it into your Downloads folder."
  pause_and_exit 1
fi
ok "found $(basename "$BUNDLE")"
ok "$(du -h "$BUNDLE" | cut -f1) — in $(dirname "$BUNDLE")"
say ""

# ------------------------------------------------------------- 2. the tools
say "  ${B}2. Checking the tools it needs${X}"

MISSING=""

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  warn "git is not installed"
  MISSING="$MISSING git"
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  warn "python3 is not installed"
  MISSING="$MISSING python3"
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version 2>/dev/null)"
  NODE_MAJOR="$(printf '%s' "$NODE_V" | tr -d 'v' | cut -d. -f1)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null; then
    ok "node $NODE_V"; NODE_OK=1
  else
    warn "node $NODE_V is too old (need v18 or newer)"
  fi
else
  warn "node is not installed"
fi
say ""

# git and python3 both arrive with Apple's Command Line Tools, and macOS
# offers to install them the first time you run either. That is a real GUI
# installer, so we ask for it by name rather than trying to script it.
if [ -n "$MISSING" ]; then
  say "  ${Y}${B}One thing to install first: Apple's Command Line Tools.${X}"
  say ""
  say "  This gives you${B}$MISSING${X}. It is made by Apple, it is free,"
  say "  and it is about 1 GB."
  say ""
  say "  A window will open asking you to confirm. Click ${B}Install${X}, agree"
  say "  to the licence, and wait for it to finish (5–15 minutes)."
  say ""
  printf '  Open that installer now? [y/N] '
  read -r answer
  case "$answer" in
    [Yy]*)
      xcode-select --install 2>&1 | sed 's/^/    /'
      say ""
      say "  ${B}When the Apple installer finishes, double-click this file again.${X}"
      pause_and_exit 0
      ;;
    *)
      say ""
      say "  No problem. When you are ready, open Terminal and run:"
      say "    ${B}xcode-select --install${X}"
      say "  then double-click this file again."
      pause_and_exit 1
      ;;
  esac
fi

if [ "$NODE_OK" -eq 0 ]; then
  say "  ${Y}${B}One thing to install: Node.${X}"
  say ""
  say "  The records desk is written in JavaScript and needs it to run."
  say ""
  say "  1. Go to  ${B}https://nodejs.org${X}"
  say "  2. Click the big green ${B}LTS${X} button to download the macOS installer"
  say "  3. Open the downloaded .pkg and click through it"
  say "  4. Double-click this file again"
  say ""
  printf '  Open nodejs.org in your browser now? [y/N] '
  read -r answer
  case "$answer" in
    [Yy]*) open "https://nodejs.org" ;;
  esac
  pause_and_exit 1
fi

# ------------------------------------------------------------- 3. unpacking
say "  ${B}3. Unpacking${X}"

if [ -d "$DEST/.git" ]; then
  warn "$DEST already exists"
  say ""
  say "  I will not overwrite it — it may hold your case files and requests."
  say ""
  printf '  Update it from the bundle instead? [y/N] '
  read -r answer
  case "$answer" in
    [Yy]*)
      if git -C "$DEST" fetch "$BUNDLE" "$BRANCH" 2>&1 | sed 's/^/    /' \
         && git -C "$DEST" checkout -q FETCH_HEAD 2>&1 | sed 's/^/    /'; then
        ok "updated"
      else
        bad "could not update it."
        say "  Rename the old folder and run this again:"
        say "    ${B}mv ~/Sentinel ~/Sentinel-old${X}"
        pause_and_exit 1
      fi
      ;;
    *)
      say "  Leaving it alone. Nothing was changed."
      pause_and_exit 0
      ;;
  esac
else
  if git clone --branch "$BRANCH" "$BUNDLE" "$DEST" 2>&1 | sed 's/^/    /'; then
    ok "unpacked into $DEST"
  else
    bad "could not unpack the bundle."
    say ""
    say "  The download may be incomplete. Download it again from the chat,"
    say "  make sure it finishes, and run this once more."
    pause_and_exit 1
  fi
fi
say ""

# ----------------------------------------------------------------- 4. proof
say "  ${B}4. Checking it actually works${X}"
say "  ${DIM}Running the full test suite. This takes a few seconds.${X}"
say ""

if ( cd "$DEST" && ./bin/sentinel test >/tmp/sentinel-install-test.log 2>&1 ); then
  grep -E 'PASS (--|—)' /tmp/sentinel-install-test.log | sed 's/^/  /'
  ok "every test passed — the system works on this Mac"
else
  bad "some tests did not pass."
  say ""
  tail -25 /tmp/sentinel-install-test.log | sed 's/^/    /'
  say ""
  say "  The full log is at /tmp/sentinel-install-test.log"
  say "  Send that to Claude and it can tell you what happened."
  pause_and_exit 1
fi
say ""

# -------------------------------------------------------------- 5. launcher
say "  ${B}5. Making it easy to open${X}"

LAUNCHER="$HOME_DIR/Desktop/Sentinel.command"
cat > "$LAUNCHER" <<LAUNCH
#!/bin/bash
# Double-click to open the Sentinel desk.
cd "$DEST" || exit 1
clear
echo ""
echo "  \$(tput bold)SENTINEL\$(tput sgr0)   \$(tput dim)$DEST\$(tput sgr0)"
echo ""
./bin/sentinel pra foia
echo ""
echo "  \$(tput dim)Other things you can do:\$(tput sgr0)"
echo "    ./bin/sentinel case list        your cases"
echo "    ./bin/sentinel dash             the dashboard"
echo "    ./bin/sentinel status           what is set up"
echo "    open docs/GET_RUNNING.md        the full guide"
echo ""
exec \$SHELL
LAUNCH
chmod +x "$LAUNCHER"
ok "put Sentinel.command on your Desktop"
say ""

# --------------------------------------------------------------- 6. the end
say "  ${G}${B}Done. Sentinel is installed.${X}"
say ""
say "  ${B}From now on:${X} double-click ${B}Sentinel.command${X} on your Desktop."
say ""
say "  The first time you do, macOS may say it is from an unidentified"
say "  developer. That is normal for any script you did not download from"
say "  the App Store. To get past it: ${B}right-click the file → Open →${X}"
say "  ${B}Open${X}. You only have to do that once."
say ""
say "  ${DIM}Two desks work right now, with no database:${X}"
say "    ${B}./bin/sentinel pra foia${X}    your records requests and their clocks"
say "    ${B}./bin/sentinel case list${X}   your cases and what is blocking them"
say "    ${B}./bin/sentinel dash${X}        the dashboard over everything"
say ""
say "  ${DIM}The full guide is at:${X}"
say "    $DEST/docs/GET_RUNNING.md"
say ""

printf '  Open the Sentinel folder in Finder now? [Y/n] '
read -r answer
case "$answer" in
  [Nn]*) ;;
  *) open "$DEST" ;;
esac

pause_and_exit 0
