#!/bin/sh
# Restaura una copia: ./deploy/restore.sh backups/mesada-AAAAMMDD-HHMMSS.dump
# ATENCIÓN: sustituye por completo los datos actuales.
set -eu
[ $# -eq 1 ] || { echo "Uso: $0 backups/mesada-....dump"; exit 1; }
docker compose stop app
docker compose exec -T db pg_restore --clean --if-exists -U mesada -d mesada < "$1"
docker compose start app
echo "Restaurado desde $1"
