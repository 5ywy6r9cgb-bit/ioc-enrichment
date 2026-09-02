#!/usr/bin/env bash
#
# install-mac.sh — put the Sentinel Desk on this Mac.
#
# What it does:  creates ~/Sentinel, generates an operator token, writes a
#                launcher onto your PATH, runs the tests, opens the dashboard.
# What it needs: python3. That is the entire dependency list.
# What it downloads: nothing. There is no network step, by design.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SENTINEL_ROOT:-$HOME/Sentinel}"
BIN="$HOME/.local/bin"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

printf '\n  THE SENTINEL DESK — install\n\n'

# ── 1. python ─────────────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || die "python3 not found. On macOS: xcode-select --install"
PYV="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
python3 -c 'import sys;raise SystemExit(0 if sys.version_info>=(3,9) else 1)' \
  || die "Python $PYV is too old. This needs 3.9 or newer."
say "python3        $PYV"

python3 -c 'import sqlite3,http.server,hashlib,zipfile,json,decimal' \
  || die "Your python3 is missing standard modules. Reinstall it from python.org."
say "stdlib         complete (no pip install is required, now or ever)"

# ── 2. tests, before anything is installed ────────────────────────────────
say "running tests…"
if python3 "$HERE/test_sentinel.py" >/tmp/sentinel-test.log 2>&1; then
  say "tests          $(tail -2 /tmp/sentinel-test.log | head -1 | xargs)"
else
  tail -30 /tmp/sentinel-test.log
  die "Tests failed. Nothing was installed. The log is at /tmp/sentinel-test.log"
fi

# ── 3. the desk directory ─────────────────────────────────────────────────
mkdir -p "$ROOT"
say "desk           $ROOT"

# ── 4. operator token ─────────────────────────────────────────────────────
ENVFILE="$ROOT/env.sh"
if [ -f "$ENVFILE" ]; then
  say "token          already set (kept)"
else
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  cat > "$ENVFILE" <<EOF
# Sourced by the sentinel launcher. Keep this file private; do not commit it.
export SENTINEL_ROOT="$ROOT"
export SENTINEL_TOKEN="$TOKEN"
EOF
  chmod 600 "$ENVFILE"
  say "token          generated → $ENVFILE (chmod 600)"
fi

# ── 5. launcher ───────────────────────────────────────────────────────────
mkdir -p "$BIN"
cat > "$BIN/sentinel" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ -f "$ENVFILE" ] && . "$ENVFILE"
cd "$HERE"
exec python3 -m sentinel "\$@"
EOF
chmod +x "$BIN/sentinel"
say "launcher       $BIN/sentinel"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say ""
     say "NOTE: $BIN is not on your PATH. Add this to ~/.zshrc:"
     say "        export PATH=\"\$HOME/.local/bin:\$PATH\""
     say "      then open a new Terminal tab." ;;
esac

# ── 6. initialise ─────────────────────────────────────────────────────────
. "$ENVFILE"
python3 -m sentinel init >/dev/null
say "store          $ROOT/sentinel.db"

cat <<EOF

  Installed.

    sentinel doctor                       check everything
    sentinel case new my-case "My Case"   start an investigation
    sentinel serve                        dashboard at http://127.0.0.1:8787

  Back up by copying $ROOT — that is the whole procedure.

EOF

if command -v open >/dev/null 2>&1; then
  printf '  Start the dashboard now? [y/N] '
  read -r ans
  if [ "${ans:-n}" = "y" ] || [ "${ans:-n}" = "Y" ]; then
    ( sleep 2; open "http://127.0.0.1:8787" ) &
    exec python3 -m sentinel serve
  fi
fi
