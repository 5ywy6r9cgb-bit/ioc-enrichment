#!/usr/bin/env bash
# Every local env file must be mode 600 and ignored by git. Never prints contents.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
bad=0; found=0
while IFS= read -r f; do
  found=1
  mode=$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f")
  if git check-ignore -q "$f"; then ign="ignored"; else ign="NOT-IGNORED"; fi
  echo "$mode  $ign  $f"
  { [ "$mode" != "600" ] || [ "$ign" != "ignored" ]; } && bad=1
done < <(find . \( -name node_modules -o -name .git \) -prune -o -type f \( -name '.env' -o -name 'local.env' \) -print)
[ "$found" = 0 ] && echo "no local env files found"
[ "$bad" = 0 ] && echo "env check OK" || { echo "env check FAILED: chmod 600 the file and add it to .gitignore"; exit 1; }
