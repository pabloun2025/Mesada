#!/bin/sh
# Prueba local (sin red ni Docker) del servicio de copias: cifrado, subida a un «bucket» simulado, retención,
# restauración con r2.sh y que no se imprima nunca ninguna clave. Usa gpg real y falsifica pg_dump y rclone.
#   sh deploy/test-backup.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups" "$T/data/uploads" "$T/bucket/mesada"
echo "foto de prueba" > "$T/data/uploads/a.jpg"
PASS="clave-super-secreta-$$"; AKEY="AKIA-NO-DEBE-SALIR"; SKEY="SECRETO-NO-DEBE-SALIR"

# pg_dump falso: escribe un «volcado» reconocible.
cat > "$T/bin/pg_dump" <<'SH'
#!/bin/sh
for a in "$@"; do case "$a" in --file=*) f="${a#--file=}";; esac; done
echo "PGDMP datos-privados-de-la-familia" > "$f"
SH
# rclone falso: el «bucket» es una carpeta local. Solo lo que usa backup.sh.
cat > "$T/bin/rclone" <<'SH'
#!/bin/sh
case "${RCLONE_S3_ACCESS_KEY_ID:-}${RCLONE_S3_SECRET_ACCESS_KEY:-}" in "") echo "rclone sin credenciales" >&2; exit 9;; esac
loc() { echo "$FAKE_BUCKET/${1#:s3:*/}"; }
cmd="$1"; shift
case "$cmd" in
  copyto) cp "$1" "$(loc "$2")" ;;
  lsf) fmt=""; [ "$1" = "--format" ] && { fmt="$2"; shift 2; }; [ "$1" = "--time-format" ] && shift 2
       p="$(loc "$1")"; if [ -d "$p" ]; then ls "$p"; elif [ -f "$p" ]; then [ "$fmt" = stp ] && echo "$(wc -c < "$p" | tr -d ' ');2026-11-22T03:00:00Z;$(basename "$p")" || [ "$fmt" = s ] && wc -c < "$p" | tr -d ' ' || basename "$p"; fi ;;
  delete) p="$(loc "$1")"; shift; days=0; while [ $# -gt 0 ]; do [ "$1" = --min-age ] && days="${2%d}"; shift; done
          find "$p" -type f -mtime +"$days" -delete ;;
  deletefile) rm -f "$(loc "$1")" ;;
  *) echo "rclone falso: $cmd no soportado" >&2; exit 2 ;;
esac
SH
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" FAKE_BUCKET="$T/bucket"
export BACKUP_DIR="$T/backups" UPLOADS_DIR="$T/data" BACKUP_ONCE=1 BACKUP_INTERVAL_SECONDS=1
fail() { echo "FALLA: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# 1) Sin variables de R2: igual que siempre, nada se sube y no hace falta gpg ni rclone.
out="$(sh "$HERE/backup.sh" 2>&1)"
ls "$T/backups" | grep -q '^mesada-.*\.dump$' || fail "no hay volcado local"
[ -z "$(ls "$T/bucket/mesada")" ] || fail "se subió algo sin configurar R2"
echo "$out" | grep -q "R2" && fail "habla de R2 sin estar configurado: $out"
ok "sin R2 todo sigue como hoy"

# 2) Variables incompletas: avisa de cuáles faltan (solo nombres) y no sube nada.
out="$(R2_ENDPOINT=https://x.r2.cloudflarestorage.com R2_BUCKET=b sh "$HERE/backup.sh" 2>&1)"
echo "$out" | grep -q "faltan R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_PASSPHRASE" || fail "no avisa de lo que falta: $out"
[ -z "$(ls "$T/bucket/mesada")" ] || fail "subió con variables incompletas"
ok "variables incompletas: avisa de los nombres que faltan"

# 3) Con todo: cifra y sube volcado y fotos; el contenido sube cifrado.
export R2_ENDPOINT=https://x.r2.cloudflarestorage.com R2_BUCKET=bucket R2_ACCESS_KEY_ID="$AKEY" R2_SECRET_ACCESS_KEY="$SKEY" BACKUP_PASSPHRASE="$PASS"
out="$(sh "$HERE/backup.sh" 2>&1)"
echo "$out" | grep -q "R2 OK mesada-.*\.dump\.gpg" || fail "no confirma la subida del volcado: $out"
echo "$out" | grep -q "R2 OK fotos-.*\.tar\.gz\.gpg" || fail "no confirma la subida de fotos: $out"
for k in "$PASS" "$AKEY" "$SKEY"; do echo "$out" | grep -qF -- "$k" && fail "el registro imprime una clave"; done
n="$(ls "$T/bucket/mesada" | wc -l | tr -d ' ')"; [ "$n" = 2 ] || fail "esperaba 2 objetos en el bucket y hay $n"
grep -rq "datos-privados" "$T/bucket" && fail "el volcado sube SIN cifrar"
ls "$T/backups" | grep -q '^\.r2tmp-' && fail "queda un temporal cifrado en disco"
# La app lee la lista de R2 y la marca de la última subida buena (no tiene las claves).
[ -f "$T/backups/.r2-ok" ] || fail "no deja la marca .r2-ok"
[ -f "$T/backups/.r2-list.txt" ] || fail "no deja la lista .r2-list.txt"
ok "cifra, sube y confirma; el bucket no contiene datos en claro; el registro no imprime claves"

# 4) El descifrado devuelve el original con la clave buena y falla con otra.
obj="$(ls "$T/bucket/mesada" | grep '\.dump\.gpg$')"
BACKUP_SOURCE_ONLY=1 . "$HERE/backup.sh"
decrypt_file "$T/bucket/mesada/$obj" "$T/plain.dump" || fail "no descifra con la clave buena"
grep -q "datos-privados" "$T/plain.dump" || fail "el descifrado no devuelve el original"
if BACKUP_PASSPHRASE=otra-clave decrypt_file "$T/bucket/mesada/$obj" "$T/mal.dump" 2>/dev/null; then fail "descifra con una clave equivocada"; fi
ok "descifra con la clave buena y no con otra"

# 5) Retención: lo viejo se borra solo tras una subida correcta; lo reciente se queda.
touch -d '40 days ago' "$T/bucket/mesada/mesada-20200101-000000.dump.gpg" "$T/bucket/mesada/fotos-20200101-000000.tar.gz.gpg"
touch -d '10 days ago' "$T/bucket/mesada/mesada-20200201-000000.dump.gpg"
sh "$HERE/backup.sh" >/dev/null 2>&1
[ ! -e "$T/bucket/mesada/mesada-20200101-000000.dump.gpg" ] || fail "no aplica la retención (volcado viejo)"
[ ! -e "$T/bucket/mesada/fotos-20200101-000000.tar.gz.gpg" ] || fail "no aplica la retención (fotos viejas)"
[ -e "$T/bucket/mesada/mesada-20200201-000000.dump.gpg" ] || fail "borra copias que aún entran en la retención"
ok "retención de 30 días"

# 6) Si la subida falla, la copia local se conserva, no se aplica la retención y el error no filtra claves.
cat > "$T/bin/rclone" <<'SH'
#!/bin/sh
echo "error de red con $RCLONE_S3_SECRET_ACCESS_KEY" >&2; exit 1
SH
touch -d '40 days ago' "$T/bucket/mesada/mesada-20190101-000000.dump.gpg"
sleep 1
before="$(ls "$T/backups" | grep -c '^mesada-.*\.dump$')"
out="$(sh "$HERE/backup.sh" 2>&1)"
echo "$out" | grep -q "R2 ERROR" || fail "no avisa del error de subida"
for k in "$PASS" "$AKEY" "$SKEY"; do echo "$out" | grep -qF -- "$k" && fail "el error filtra una clave"; done
after="$(ls "$T/backups" | grep -c '^mesada-.*\.dump$')"; [ "$after" -gt "$before" ] || fail "no conservó la copia local"
[ -e "$T/bucket/mesada/mesada-20190101-000000.dump.gpg" ] || fail "aplicó la retención tras una subida fallida"
ok "un fallo de subida no pierde la copia local ni borra nada de R2, y no filtra claves"
echo "TODO CORRECTO"
