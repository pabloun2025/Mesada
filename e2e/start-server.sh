#!/usr/bin/env bash
# Arranca la API con una base de datos E2E vacía y la PWA compilada.
set -euo pipefail
cd "$(dirname "$0")"
DB_URL="${E2E_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/mesada_e2e}"
ADMIN_URL="${DB_URL%/*}/postgres"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS mesada_e2e WITH (FORCE)" -c "CREATE DATABASE mesada_e2e"
rm -rf ./.data
cd ../server
exec env DATABASE_URL="$DB_URL" PORT=3100 STATIC_DIR=../web/dist UPLOAD_DIR=../e2e/.data/uploads \
  AUTH_RATE_LIMIT=1000 LOG_LEVEL=warn npx tsx src/index.ts
