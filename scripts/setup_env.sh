#!/usr/bin/env bash
set -euo pipefail

# Step 0.5: optional local config bootstrap for Sentinel OS.
# This does not write secrets and refuses to run if .env is insecure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "Missing .env.example in repo root." >&2
  exit 3
fi

if [ -f "$ENV_FILE" ]; then
  mode=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)
  if [ "$mode" != "600" ] && [ "$mode" != "600 " ]; then
    echo ".env exists but is not mode 600. Fix it with: chmod 600 .env" >&2
    exit 1
  fi
  echo "Using existing .env"
else
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created .env from .env.example. Edit it with real values, then rerun." >&2
  exit 0
fi

# Minimal validation: require example exists and env is secure.
# This is intentionally lightweight and local-only.
printf 'Config OK. .env permissions are secure.\n'
