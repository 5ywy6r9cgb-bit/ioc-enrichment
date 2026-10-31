#!/usr/bin/env bash
# Apply the Sentinel PRA schema to ONE Postgres database, in order, once each.
#
#   export PGHOST=<server>.postgres.database.azure.com PGUSER=sentineladmin PGDATABASE=sentinel_pra
#   export PGPASSWORD=...   (type it into the terminal; do not save it in a file)
#   bash deploy/azure/migrate.sh            apply what is pending
#   bash deploy/azure/migrate.sh --plan     show what would run; touches nothing
#
# Rules: TLS required for any non-loopback host. Each file is recorded with its
# sha256; if an already-applied file has changed, this STOPS instead of guessing.
# The only table it adds is _applied_migrations (the record of what ran).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/modules/pra/migrations"
SEED="$ROOT/modules/pra/seed/seed_templates_and_rules.sql"
MODE="${1:-apply}"
: "${PGHOST:?set PGHOST}" "${PGUSER:?set PGUSER}" "${PGDATABASE:?set PGDATABASE}"
[ -n "${PGPASSWORD:-}" ] || [ -f "$HOME/.pgpass" ] || { echo "No PGPASSWORD set." >&2; exit 2; }

case "$PGHOST" in
  localhost|127.*|::1|/*) : ;;
  *) export PGSSLMODE="${PGSSLMODE:-require}"
     case "$PGSSLMODE" in require|verify-ca|verify-full) : ;; *) echo "Refusing: PGSSLMODE=$PGSSLMODE for a remote host." >&2; exit 2;; esac ;;
esac
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
P=(psql -v ON_ERROR_STOP=1 -q -X)
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(ls "$MIG"/*.sql | grep -v rollback | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "No migrations found in $MIG" >&2; exit 2; }

if [ "$MODE" = "--plan" ]; then
  echo "DRY RUN -> host=$PGHOST db=$PGDATABASE (nothing is touched)"
  for f in "${FILES[@]}"; do echo "  would apply: $(basename "$f")  sha256=$(sha "$f" | cut -c1-12)"; done
  echo "  then seed: $(basename "$SEED")"; exit 0
fi

"${P[@]}" -c "CREATE TABLE IF NOT EXISTS _applied_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());"
applied=0
for f in "${FILES[@]}"; do
  name="$(basename "$f")"; h="$(sha "$f")"
  prev="$("${P[@]}" -tA -c "SELECT sha256 FROM _applied_migrations WHERE filename='$name'")"
  if [ -n "$prev" ]; then
    [ "$prev" = "$h" ] || { echo "STOP: $name was applied with a different hash. The file changed after it ran. Write a new migration instead." >&2; exit 3; }
    echo "  skip   $name (already applied)"; continue
  fi
  echo "  apply  $name"
  "${P[@]}" -f "$f"   # each migration file carries its own BEGIN/COMMIT
  "${P[@]}" -c "INSERT INTO _applied_migrations(filename, sha256) VALUES ('$name','$h')"
  applied=$((applied+1))
done
seed_h="$(sha "$SEED")"
if [ -z "$("${P[@]}" -tA -c "SELECT 1 FROM _applied_migrations WHERE filename='seed_templates_and_rules.sql'")" ]; then
  echo "  seed   seed_templates_and_rules.sql"
  "${P[@]}" -f "$SEED"
  "${P[@]}" -c "INSERT INTO _applied_migrations(filename, sha256) VALUES ('seed_templates_and_rules.sql','$seed_h')"
fi
echo "Done. $applied new migration(s). Tables: $("${P[@]}" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
