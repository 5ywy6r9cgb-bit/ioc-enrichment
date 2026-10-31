# One database on Azure

Azure Database for PostgreSQL Flexible Server (v16), holding the Sentinel PRA
schema: 9 migrations + seed = 40 tables (plus `_applied_migrations`, the record
of what ran). Nothing else is created: no web app, no storage, no Key Vault.

Verified here: all 9 migrations and the seed apply cleanly, in order, to a
real Postgres 16; re-running changes nothing; a changed migration is refused;
`main.bicep` compiles with the Bicep compiler. NOT yet verified: a live deploy
to your subscription (it needs your login).

## Read this first: this database is metadata about investigations

The repo was designed local-only on purpose (`modules/pra/server/db_policy.js`
refuses any non-loopback host, and says there is no "allow remote" flag). The
tables hold request threads, entities (people and organizations), sources and
claims. Raw files stay outside the database, but a hosted copy of that
metadata is a different risk than a laptop. So:

- The firewall allows ONE address (yours). No "allow Azure services" rule.
- TLS is required (1.2 minimum). Azure encrypts storage and backups at rest by default.
- The app's `db_policy` will STILL refuse to connect to this server. That is
  deliberate and unchanged. Changing it is a decision to make on purpose,
  with its own commit and review. Until then, use the database for the
  schema, staging and review, and keep unpublished material local.
- Put no real case data in it until you have decided that.

## Steps (Mac)

```bash
brew install azure-cli postgresql@16        # postgresql gives you psql
az login
az group create -n sentinel-rg -l eastus    # pick your region
MYIP=$(curl -s https://api.ipify.org)
read -rs -p "Choose a DB admin password: " DBPW; echo
az deployment group create -g sentinel-rg -f deploy/azure/main.bicep \
  -p serverName=sentinel-pra-$RANDOM clientIp=$MYIP administratorPassword="$DBPW"
```
The output prints `host`. Preview first with `az deployment group what-if` using the same arguments.

```bash
cd ~/sentinel
export PGHOST=<host from the output> PGUSER=sentineladmin PGDATABASE=sentinel_pra PGPASSWORD="$DBPW"
bash deploy/azure/migrate.sh --plan      # shows what would run
bash deploy/azure/migrate.sh             # applies it
psql -c '\dt' | head -50
```
Your IP changes: update the rule with
`az postgres flexible-server firewall-rule update -g sentinel-rg -n <server> --rule-name operator-only --start-ip-address <ip> --end-ip-address <ip>`.

## Rules

- Never commit a password. `.env` is already gitignored.
- A migration that has run is never edited. `migrate.sh` stops if its hash changed. Add `0010_...sql` instead.
- Backups: 7 days by default (`backupRetentionDays`, up to 35).
- Teardown (deletes the database and its backups): `az group delete -n sentinel-rg`.
- Cost: Burstable B1ms is the smallest supported tier. Check the Azure pricing calculator for your region.

## GitHub

`.github/workflows/azure-db.yml` deploys the INFRASTRUCTURE only, by manual
trigger, using OIDC (no stored Azure password). Migrations are run by you with
`migrate.sh`, so the database firewall never has to open to GitHub's runners.
Set the repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `DB_ADMIN_PASSWORD` and create the federated
credential for the repo in Entra ID first.
