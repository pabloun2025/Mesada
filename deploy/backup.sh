#!/bin/sh
# Copia diaria: volcado comprimido de PostgreSQL + fotos de evidencia. Conserva BACKUP_KEEP_DAYS días.
set -eu
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  if pg_dump --format=custom --file="/backups/mesada-$ts.dump"; then
    tar -czf "/backups/fotos-$ts.tar.gz" -C /data uploads 2>/dev/null || true
    echo "[backup] OK $ts"
  else
    echo "[backup] ERROR $ts" >&2
    rm -f "/backups/mesada-$ts.dump"
  fi
  find /backups -name 'mesada-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
  find /backups -name 'fotos-*.tar.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
