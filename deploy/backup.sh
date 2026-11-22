#!/bin/sh
# Copia diaria: volcado comprimido de PostgreSQL + fotos de evidencia. Conserva BACKUP_KEEP_DAYS días en /backups.
#
# Copia FUERA del servidor (opcional, D52): si existen R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
# y BACKUP_PASSPHRASE, cada copia se cifra (GnuPG simétrico, AES-256) ANTES de salir y se sube a Cloudflare R2.
# Solo se conservan R2_RETENTION_DAYS días (30 por defecto). Si falta alguna variable, todo sigue como siempre.
# Nunca se imprimen claves: el registro solo dice «R2 OK nombre» o «R2 ERROR» (el motivo, sin credenciales).
#
# Variables de apoyo: BACKUP_ONCE=1 (una sola pasada y salir), BACKUP_SOURCE_ONLY=1 (solo definir funciones; lo usa r2.sh).
set -eu

: "${BACKUP_KEEP_DAYS:=14}" "${BACKUP_INTERVAL_SECONDS:=86400}" "${R2_RETENTION_DAYS:=30}"
# Con R2 activo y la última subida correcta, el servidor guarda menos días (el resto queda en R2) para ahorrar disco.
: "${BACKUP_KEEP_DAYS_WITH_R2:=3}"
: "${R2_PREFIX:=mesada}" "${BACKUP_DIR:=/backups}" "${UPLOADS_DIR:=/data}"
: "${R2_INCLUDE_PHOTOS:=true}"

log() { echo "[backup] $*"; }
err() { echo "[backup] $*" >&2; }

# ¿Están todas las variables de la copia externa?
r2_enabled() {
  [ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] \
    && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]
}

# Solo sale el nombre de las variables que faltan (nunca valores).
r2_missing() {
  for v in R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_PASSPHRASE; do
    eval "[ -n \"\${$v:-}\" ]" || printf '%s ' "$v"
  done
}

# Herramientas de la copia externa (solo si está activada): se instalan una vez al arrancar el servicio.
r2_tools() {
  if command -v gpg >/dev/null 2>&1 && command -v rclone >/dev/null 2>&1; then return 0; fi
  log "instalando gnupg y rclone para la copia externa…"
  apk add --no-cache gnupg rclone >/dev/null 2>&1 || { err "ERROR no se pudieron instalar gnupg y rclone; la copia externa se salta"; return 1; }
}

# rclone sin fichero de configuración: todo por variables de entorno (no salen en `ps` ni en el registro).
r2_rclone() {
  RCLONE_S3_PROVIDER=Cloudflare RCLONE_S3_ENDPOINT="$R2_ENDPOINT" RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" RCLONE_S3_ENV_AUTH=false RCLONE_S3_REGION=auto \
  RCLONE_S3_NO_CHECK_BUCKET=true rclone "$@"
}
r2_remote() { printf ':s3:%s/%s' "$R2_BUCKET" "$R2_PREFIX"; }

# Cifrado simétrico con contraseña: cifrar IN OUT / descifrar IN OUT. La contraseña entra por la entrada estándar.
encrypt_file() {
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 --compress-algo none -o "$2" "$1"
}
decrypt_file() {
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 0 -o "$2" --decrypt "$1"
}

# Cifra un fichero y lo sube. No deja nada cifrado en disco. Devuelve 1 si algo falla.
r2_upload() {
  src="$1"; name="$(basename "$src").gpg"
  tmp="$(mktemp "$BACKUP_DIR/.r2tmp-XXXXXX")"
  if ! encrypt_file "$src" "$tmp"; then rm -f "$tmp"; err "R2 ERROR no se pudo cifrar $(basename "$src")"; return 1; fi
  if ! r2_rclone copyto "$tmp" "$(r2_remote)/$name" --quiet --s3-no-head 2>/dev/null; then
    rm -f "$tmp"; err "R2 ERROR no se pudo subir $name (revisa endpoint, bucket y claves)"; return 1
  fi
  size="$(wc -c < "$tmp" | tr -d ' ')"
  rm -f "$tmp"
  # Comprobación: el objeto existe y pesa lo mismo.
  if [ "$(r2_rclone lsf --format s "$(r2_remote)/$name" 2>/dev/null | head -1)" != "$size" ]; then
    err "R2 ERROR $name no aparece completo en el bucket"; return 1
  fi
  log "R2 OK $name ($size bytes, cifrado)"
}

# Borra de R2 lo más antiguo que R2_RETENTION_DAYS. Solo se llama tras una subida correcta.
r2_prune() {
  r2_rclone delete "$(r2_remote)" --quiet --min-age "${R2_RETENTION_DAYS}d" --include 'mesada-*.dump.gpg' --include 'fotos-*.tar.gz.gpg' 2>/dev/null \
    || err "R2 aviso: no se pudo aplicar la retención"
}

# Para la pantalla de Administración (la app no tiene las claves de R2): lista de lo que hay en el bucket y marca de la última subida buena.
r2_status() {
  l="$(mktemp "$BACKUP_DIR/.r2tmp-XXXXXX")"
  if r2_rclone lsf --format stp --time-format '2006-01-02T15:04:05Z07:00' "$(r2_remote)" > "$l" 2>/dev/null; then
    chmod 644 "$l"; mv "$l" "$BACKUP_DIR/.r2-list.txt"
  else
    rm -f "$l"
  fi
}

backup_once() {
  ts=$(date +%Y%m%d-%H%M%S)
  if pg_dump --format=custom --file="$BACKUP_DIR/mesada-$ts.dump"; then
    tar -czf "$BACKUP_DIR/fotos-$ts.tar.gz" -C "$UPLOADS_DIR" uploads 2>/dev/null || true
    log "OK $ts"
    if r2_enabled; then
      if r2_tools; then
        ok=1
        r2_upload "$BACKUP_DIR/mesada-$ts.dump" || ok=0
        if [ "$R2_INCLUDE_PHOTOS" = "true" ] && [ -s "$BACKUP_DIR/fotos-$ts.tar.gz" ]; then r2_upload "$BACKUP_DIR/fotos-$ts.tar.gz" || ok=0; fi
        if [ "$ok" = 1 ]; then r2_prune; : > "$BACKUP_DIR/.r2-ok"; chmod 644 "$BACKUP_DIR/.r2-ok"; fi
        r2_status
      fi
    fi
  else
    err "ERROR $ts"
    rm -f "$BACKUP_DIR/mesada-$ts.dump"
  fi
  keep="$BACKUP_KEEP_DAYS"
  # Solo se recorta si la subida a R2 de las últimas 26 h salió bien: si R2 falla, se conservan los 14 días locales.
  if r2_enabled && [ -n "$(find "$BACKUP_DIR" -maxdepth 1 -name '.r2-ok' -mmin -1560 2>/dev/null)" ]; then keep="$BACKUP_KEEP_DAYS_WITH_R2"; fi
  find "$BACKUP_DIR" -name 'mesada-*.dump' -mtime +"$keep" -delete
  find "$BACKUP_DIR" -name 'fotos-*.tar.gz' -mtime +"$keep" -delete
  find "$BACKUP_DIR" -name '.r2tmp-*' -mmin +60 -delete
}

main() {
  mkdir -p "$BACKUP_DIR"
  if r2_enabled; then
    log "copia externa en R2 ACTIVADA (retención ${R2_RETENTION_DAYS} días, cifrada)"
    r2_tools || true
  elif [ -n "${R2_ENDPOINT:-}${R2_BUCKET:-}${R2_ACCESS_KEY_ID:-}${R2_SECRET_ACCESS_KEY:-}${BACKUP_PASSPHRASE:-}" ]; then
    err "copia externa en R2 incompleta: faltan $(r2_missing)"
  fi
  while true; do
    backup_once
    [ "${BACKUP_ONCE:-}" = "1" ] && break
    sleep "$BACKUP_INTERVAL_SECONDS"
  done
}

[ "${BACKUP_SOURCE_ONLY:-}" = "1" ] || main
