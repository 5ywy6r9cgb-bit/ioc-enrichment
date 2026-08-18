#!/bin/bash
# =====================================================================
# Sentinel PRA v0.7 — one-command local setup for macOS.
#
#   ./scripts/setup_macos.sh
#
# What it does, in order:
#   1. Checks that psql is on your PATH (tells you exactly how to fix it)
#   2. Checks that Postgres is actually running
#   3. Creates the database and a least-privilege application role
#   4. Applies both migrations inside transactions
#   5. Applies least-privilege grants
#   6. Loads the seed data
#   7. Verifies the result and prints a summary
#
# Safe to re-run. It will not overwrite an existing database unless you
# say so; migrations that were already applied are detected and skipped.
#
# Nothing here reaches the network. Nothing binds to anything but
# localhost. Nothing leaves this machine.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

DB_NAME="${PGDATABASE:-sentinel_pra}"
APP_ROLE="${PGUSER:-sentinel_app}"
ADMIN_USER="${PRA_ADMIN_USER:-$(whoami)}"
HOST="127.0.0.1"
PORT="${PGPORT:-5432}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mNOTE\033[0m %s\n' "$1"; }
die()  { printf '\n  \033[31mSTOP\033[0m %s\n\n' "$1"; exit 1; }

echo ""
bold "Sentinel Public Records Atlas v0.7 — local setup"
echo "  database : $DB_NAME"
echo "  app role : $APP_ROLE"
echo "  admin    : $ADMIN_USER"
echo "  host     : $HOST:$PORT"
echo ""

# ---------------------------------------------------------------- 1. psql
bold "1. Checking for psql"
if ! command -v psql >/dev/null 2>&1; then
  cat <<'MSG'

  psql is not on your PATH.

  If you installed Postgres.app, run this once to fix it permanently:

    sudo mkdir -p /etc/paths.d && \
    echo /Applications/Postgres.app/Contents/Versions/latest/bin \
      | sudo tee /etc/paths.d/postgresapp

  Then close and reopen Terminal and run this script again.

  If you have not installed Postgres yet:
    1. Go to https://postgresapp.com
    2. Download it, drag it to Applications, open it
    3. Click "Initialize"
    4. Run the PATH command above

MSG
  die "psql not found."
fi
ok "$(psql --version)"

# ------------------------------------------------------------- 2. running
bold "2. Checking that Postgres is running"
if ! psql -h "$HOST" -p "$PORT" -U "$ADMIN_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  cat <<MSG

  Cannot connect to Postgres at $HOST:$PORT as "$ADMIN_USER".

  Check:
    * Is Postgres.app open, with a green "Running" indicator?
    * Did you click "Initialize" the first time you opened it?
    * If your Mac username is not "$ADMIN_USER", run:
        PRA_ADMIN_USER=yourname ./scripts/setup_macos.sh

MSG
  die "Postgres is not reachable."
fi
ok "connected as $ADMIN_USER"

# ------------------------------------------------------------ 3. database
bold "3. Database and application role"
DB_EXISTS=$(psql -h "$HOST" -p "$PORT" -U "$ADMIN_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" || true)

if [ "$DB_EXISTS" = "1" ]; then
  warn "database \"$DB_NAME\" already exists — leaving it alone"
else
  createdb -h "$HOST" -p "$PORT" -U "$ADMIN_USER" "$DB_NAME"
  ok "created database \"$DB_NAME\""
fi

if [ -z "${PRA_APP_PASSWORD:-}" ]; then
  echo ""
  echo "  Set a password for the application role \"$APP_ROLE\"."
  echo "  This never leaves your Mac. Write it down; you will put it in .env."
  read -r -s -p "  password: " PRA_APP_PASSWORD; echo ""
  [ -n "$PRA_APP_PASSWORD" ] || die "empty password"
fi

psql -h "$HOST" -p "$PORT" -U "$ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$PRA_APP_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE $APP_ROLE WITH PASSWORD '$PRA_APP_PASSWORD'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL
ok "application role \"$APP_ROLE\" ready (no superuser, no createdb, no createrole)"

PSQL_DB="psql -h $HOST -p $PORT -U $ADMIN_USER -d $DB_NAME -v ON_ERROR_STOP=1"

# ----------------------------------------------------------- 4. migrations
bold "4. Applying migrations"
HAS_SV=$($PSQL_DB -tAc "SELECT to_regclass('public.schema_version') IS NOT NULL" 2>/dev/null || echo f)

applied() {
  [ "$HAS_SV" = "t" ] || return 1
  local v="$1"
  local n
  n=$($PSQL_DB -tAc "SELECT count(*) FROM schema_version WHERE version='$v'" 2>/dev/null || echo 0)
  [ "$n" != "0" ]
}

if applied "0.6.1"; then
  warn "0001 (v0.6.1 metadata schema) already applied — skipping"
else
  $PSQL_DB -q -f migrations/0001_v0_6_1_metadata_schema.sql
  ok "0001 v0.6.1 metadata schema applied"
  HAS_SV=t
fi

if applied "0.7.0"; then
  warn "0002 (v0.7 master schema) already applied — skipping"
else
  $PSQL_DB -q -f migrations/0002_v0_7_master_schema.sql
  ok "0002 v0.7 master schema applied"
fi

# --------------------------------------------------------------- 5. grants
bold "5. Least-privilege grants"
$PSQL_DB -q -v app_role="$APP_ROLE" -v db_name="$DB_NAME" -f scripts/grants.sql
ok "grants applied (ledgers are INSERT-only for the app role)"

# ----------------------------------------------------------------- 6. seed
bold "6. Seed data"
TPL_COUNT=$($PSQL_DB -tAc "SELECT count(*) FROM request_templates" || echo 0)
if [ "$TPL_COUNT" -gt 0 ]; then
  warn "templates already loaded ($TPL_COUNT) — skipping template seed"
else
  $PSQL_DB -q -f seed/seed_templates_and_rules.sql
  ok "letter templates and deadline rules loaded"
fi

if [ ! -f .env ]; then
  sed -e "s/^PGDATABASE=.*/PGDATABASE=$DB_NAME/" \
      -e "s/^PGUSER=.*/PGUSER=$APP_ROLE/" \
      -e "s/^PGPASSWORD=.*/PGPASSWORD=$PRA_APP_PASSWORD/" \
      -e "s/^PGPORT=.*/PGPORT=$PORT/" \
      config/local.example.env > .env
  chmod 600 .env
  ok "wrote .env (permissions 600 — readable only by you)"
else
  warn ".env already exists — not overwriting it"
fi

if [ -d node_modules/pg ]; then
  # Seeding writes to the REFERENCE tables (jurisdictions, agencies, portals,
  # record_types), which the app role can only read — by design, so the running
  # app can never rewrite your agency directory. Seeding is an owner operation,
  # so the loader runs as the database owner, not as sentinel_app.
  set -a; . ./.env; set +a
  PGUSER="$ADMIN_USER" PGPASSWORD="" node scripts/load_seeds.js && ok "CSV seed data loaded"
else
  warn "pg driver not installed yet — run: npm install && npm run seed"
fi

# ----------------------------------------------------------------- 7. check
bold "7. Verifying"
$PSQL_DB -q <<'SQL'
\pset format aligned
\echo ''
SELECT version, migration_id, applied_at::date AS applied FROM schema_version ORDER BY version;
\echo ''
SELECT 'jurisdictions' AS table, count(*) FROM jurisdictions
UNION ALL SELECT 'agencies',         count(*) FROM agencies
UNION ALL SELECT 'portals',          count(*) FROM portals
UNION ALL SELECT 'record_types',     count(*) FROM record_types
UNION ALL SELECT 'request_templates',count(*) FROM request_templates
UNION ALL SELECT 'deadline_rules',   count(*) FROM deadline_rules
UNION ALL SELECT 'requests',         count(*) FROM requests
ORDER BY 1;
SQL

cat <<MSG

$(bold "Setup complete.")

  Next:
    npm install                    # once, installs the pg driver
    npm test                       # 11 suites, should be 11/11
    npm run seed                   # if the seed load was skipped above
    node scripts/daily_brief.js    # your morning check
    npm run service                # localhost-only bridge on 127.0.0.1:4317
    open app/public_records_atlas_demo.html

  Back up before you do anything you might regret:
    ./scripts/backup.sh

MSG
