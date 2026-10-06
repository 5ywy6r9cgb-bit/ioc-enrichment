#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$ROOT/.gitleaks-report.json"
for tool in gitleaks jq git; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool"; exit 2; }
done
cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a git repo"; exit 3; }
if ! git check-ignore -q "$REPORT"; then
  echo ".gitleaks-report.json is not gitignored. Add it first."; exit 3
fi
if [ -n "$(git log --all --full-history --oneline -- .env ':(glob)**/.env' 2>/dev/null)" ]; then
  echo "WARNING: an .env file appears in git history. Treat every key in it as exposed."
fi
echo "Scanning full history (redacted)..."
rc=0
gitleaks detect --source="$ROOT" --redact --no-banner \
  --report-format json --report-path "$REPORT" --exit-code 42 >/dev/null 2>&1 || rc=$?
case "$rc" in
  0)  echo "No secrets detected."; rm -f "$REPORT"; exit 0 ;;
  42) ;;
  *)  echo "gitleaks failed (exit $rc). Tool error, not a finding."; exit 3 ;;
esac
echo "$(jq 'length' "$REPORT") potential secret(s) found. Values are never shown."
echo; echo "By type:"
jq -r '.[].RuleID' "$REPORT" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo; echo "Where (file : line : commit : date):"
jq -r '.[] | "  \(.File):\(.StartLine)  \(.Commit[0:10])  \(.Date[0:10])"' "$REPORT" | sort -u
echo; echo "Next: revoke each real key at its provider, issue a new one, put it in .env only, then re-run."
exit 1
