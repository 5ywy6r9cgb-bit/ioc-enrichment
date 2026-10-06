#!/usr/bin/env bash
# scan-git-history.sh: one-time gitleaks scan of full history.
# Reports rule, file, commit and line only. Never prints matched text.
# Exit: 0 clean | 1 leaks found | 2 missing tool | 3 other error
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$ROOT/.gitleaks-report.json"

for tool in gitleaks jq git; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool (brew install $tool)"; exit 2; }
done

cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a git repo"; exit 3; }

# The report must be ignored before it is ever written
if ! git check-ignore -q "$REPORT"; then
  echo ".gitleaks-report.json is not gitignored. Add it to .gitignore first."
  exit 3
fi

echo "Checking whether .env was ever committed..."
if [ -n "$(git log --all --full-history --oneline -- .env '*.env' 2>/dev/null)" ]; then
  echo "WARNING: an .env file appears in git history. Treat every key in it as exposed."
fi

echo "Scanning full history (redacted)..."
rc=0
gitleaks detect --source="$ROOT" --redact --no-banner \
  --report-format json --report-path "$REPORT" --exit-code 42 >/dev/null 2>&1 || rc=$?

case "$rc" in
  0)  echo "No secrets detected."; rm -f "$REPORT"; exit 0 ;;
  42) ;;  # leaks found, handled below
  *)  echo "gitleaks failed (exit $rc). This is a tool error, not a finding."; exit 3 ;;
esac

n=$(jq 'length' "$REPORT")
echo "$n potential secret(s) found. Values are never shown."
echo
echo "By type:"
jq -r '.[].RuleID' "$REPORT" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo
echo "Where (file : line : commit : date):"
jq -r '.[] | "  \(.File):\(.StartLine)  \(.Commit[0:10])  \(.Date[0:10])"' "$REPORT" | sort -u
echo
cat <<'MSG'
Next steps:
1. Triage each finding. Gitleaks flags high-entropy strings, so some may be false positives.
2. For every real key: REVOKE it at the provider and issue a new one. Updating .env alone leaves the
   old key live. Then put the new key in .env only.
3. If the repo was never public and never pushed to a shared remote, revoking is enough.
   If it was, also check forks and clones, and consider git filter-repo.
4. Re-run this script after rotating. Keep the report local; delete it when done.
MSG
exit 1
