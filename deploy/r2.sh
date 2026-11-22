#!/bin/sh
# Herramienta de copias en R2, para usar DENTRO del contenedor «backup» (ya trae las variables y las funciones):
#   docker compose --env-file .env.production -f docker-compose.oracle.yml exec backup sh /r2.sh listar
#   ... exec backup sh /r2.sh descargar mesada-20261122-030000.dump.gpg   → deja el volcado descifrado en /backups/restaurar/
#   ... exec backup sh /r2.sh ultima                                       → descarga y descifra la copia más reciente
#   ... exec backup sh /r2.sh probar                                       → sube un fichero de prueba, lo baja, lo descifra y lo borra
# Después se restaura con pg_restore (ver docs/despliegue.md, «Restaurar desde R2»). No imprime nunca claves.
set -eu
BACKUP_SOURCE_ONLY=1 . "${BACKUP_LIB:-/backup.sh}"

r2_enabled || { err "Faltan variables de R2: $(r2_missing)"; exit 1; }
r2_tools || exit 1
OUT="$BACKUP_DIR/restaurar"
mkdir -p "$OUT"

get() {
  name="$1"
  case "$name" in *.gpg) ;; *) err "El nombre debe acabar en .gpg"; exit 1 ;; esac
  case "$name" in */*|*..*) err "Nombre no válido"; exit 1 ;; esac
  r2_rclone copyto "$(r2_remote)/$name" "$OUT/$name" --quiet 2>/dev/null || { err "No se pudo descargar $name"; exit 1; }
  plain="${name%.gpg}"
  decrypt_file "$OUT/$name" "$OUT/$plain" || { rm -f "$OUT/$plain"; err "No se pudo descifrar: ¿la BACKUP_PASSPHRASE es la misma con la que se cifró?"; exit 1; }
  rm -f "$OUT/$name"
  chmod 600 "$OUT/$plain"
  log "Listo: $OUT/$plain"
}

case "${1:-listar}" in
  listar) r2_rclone lsf --format "tsp" "$(r2_remote)" 2>/dev/null | sort -r ;;
  descargar) [ $# -ge 2 ] || { err "Uso: r2.sh descargar NOMBRE.gpg"; exit 1; }; get "$2" ;;
  ultima)
    n="$(r2_rclone lsf "$(r2_remote)" --include 'mesada-*.dump.gpg' 2>/dev/null | sort | tail -1)"
    [ -n "$n" ] || { err "No hay copias en R2"; exit 1; }
    get "$n" ;;
  probar)
    t="$(mktemp "$BACKUP_DIR/.r2tmp-test-XXXXXX")"; echo "prueba $(date +%s)" > "$t"
    r2_upload "$t" || { rm -f "$t"; exit 1; }
    n="$(basename "$t").gpg"
    get "$n" && cmp "$t" "$OUT/${n%.gpg}" && log "PRUEBA CORRECTA: subir, bajar y descifrar funciona"
    r2_rclone deletefile "$(r2_remote)/$n" --quiet 2>/dev/null || true
    rm -f "$t" "$OUT/${n%.gpg}" ;;
  *) err "Uso: r2.sh listar | descargar NOMBRE.gpg | ultima | probar"; exit 1 ;;
esac
