#!/usr/bin/env bash
# Despliegue de Mesada en la VM compartida. Lo ejecuta el workflow oracle-deploy.yml dentro de /home/ubuntu/mesada.
# Reglas de convivencia con TEINVITO y consulares:
#   - solo toca el proyecto «mesada-prod» (sin --remove-orphans, sin prune de volúmenes);
#   - no lee ni escribe los .env de otros proyectos (Mesada usa su propio token de instancia y su clave de Resend);
#   - comprueba que la red compartida existe en lugar de crearla.
set -euo pipefail
APP_DIR=/home/ubuntu/mesada
ENV_FILE="$APP_DIR/.env.production"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.oracle.yml")
BOOTSTRAP=/tmp/mesada-bootstrap.json

cd "$APP_DIR"
mkdir -p backups && chmod 700 backups
docker network inspect citas-prod_interna >/dev/null 2>&1 || { echo "Falta la red citas-prod_interna (consulares). No se despliega."; exit 1; }

# Genera .env.production (600) conservando lo que ya hubiera en el servidor. Los secretos llegan del paquete
# temporal del workflow (secretos de GitHub del repo Mesada) y nunca se escriben en el repositorio ni en la salida.
python3 - "$BOOTSTRAP" "$ENV_FILE" <<'PY'
import json, secrets, sys
from pathlib import Path
boot_path, out_path = map(Path, sys.argv[1:])
def dotenv(p):
    r = {}
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1); v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"": v = v[1:-1]
                r[k.strip()] = v
    return r
boot = json.loads(boot_path.read_text()) if boot_path.exists() else {}
old = dotenv(out_path)
pick = lambda k, d='': boot.get(k) or old.get(k) or d
values = {
    'POSTGRES_PASSWORD': old.get('POSTGRES_PASSWORD') or secrets.token_hex(32),
    # Cifra los secretos de la verificación en dos pasos. Si cambia, hay que volver a activarla.
    'SECRET_KEY': old.get('SECRET_KEY') or secrets.token_hex(32),
    'APP_BASE_URL': pick('APP_BASE_URL', 'https://mesada.veryfacil.org'),
    'COOKIE_SECURE': 'true',
    'ALLOW_REGISTRATION': pick('ALLOW_REGISTRATION', 'false'),
    'LOG_LEVEL': 'info',
    # Se conserva lo que haya en el servidor: se activa una vez a mano y los despliegues no lo apagan.
    'NOTIFY_REAL_SEND': old.get('NOTIFY_REAL_SEND') or 'true',
    'NOTIFY_EMAIL_MONTHLY_CAP': pick('NOTIFY_EMAIL_MONTHLY_CAP', '100'),
    'NOTIFY_WHATSAPP_DAILY_CAP': pick('NOTIFY_WHATSAPP_DAILY_CAP', '40'),
    # Correo: Resend (como firmador, dominio veryfacil.org ya verificado), con una clave propia de Mesada
    # de «Sending access» limitada a veryfacil.org.
    'EMAIL_PROVIDER': pick('EMAIL_PROVIDER', 'resend'),
    'RESEND_API_KEY': pick('RESEND_API_KEY'),
    'MAIL_FROM': pick('MAIL_FROM', 'mesada@veryfacil.org'),
    'MAIL_FROM_NAME': 'DiploP' if pick('MAIL_FROM_NAME', 'DiploP') == 'Mesada' else pick('MAIL_FROM_NAME', 'DiploP'),
    # WhatsApp: instancia propia en la Evolution de consulares, con su token (no la clave global).
    'EVOLUTION_INSTANCE': pick('EVOLUTION_INSTANCE', 'mesada'),
    'EVOLUTION_INSTANCE_TOKEN': old.get('EVOLUTION_INSTANCE_TOKEN', ''),
    'BACKUP_KEEP_DAYS': '14',
}
# Opcionales que se ponen a mano en el servidor y los despliegues NO deben borrar: copia externa cifrada en R2 (D52),
# límites y topes de abuso (D50). Solo se escriben si ya tienen valor.
for k in ('R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BACKUP_PASSPHRASE', 'R2_RETENTION_DAYS', 'R2_PREFIX',
          'R2_INCLUDE_PHOTOS', 'RATE_SETUP_PER_HOUR', 'RATE_INVITE_PER_HOUR', 'RATE_INVITE_ACCEPT_PER_HOUR', 'RATE_RECOVERY_PER_HOUR',
          'RATE_RESET_PER_HOUR', 'RATE_UPLOAD_PER_HOUR', 'RATE_EXPORT_PER_HOUR', 'MAX_MEMBERS_PER_FAMILY', 'MAX_PENDING_INVITATIONS',
          'MAX_PHOTOS_PER_FAMILY', 'MAX_UPLOAD_MB', 'PHOTO_RETENTION_DAYS', 'CLEAN_NOTIFICATIONS_DAYS', 'CLEAN_OUTBOX_DAYS', 'INACTIVE_FAMILY_MONTHS', 'TRUST_CLOUDFLARE_IP'):
    if old.get(k) and k not in values:
        values[k] = old[k]
for k, v in values.items():
    if any(c in v for c in "\r\n'"):
        raise SystemExit(f'Valor no admitido en {k}.')
out_path.write_text(''.join(f"{k}='{v}'\n" for k, v in values.items()))
out_path.chmod(0o600)
PY
rm -f "$BOOTSTRAP"

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build app
"${COMPOSE[@]}" up -d db
"${COMPOSE[@]}" up -d app backup
"${COMPOSE[@]}" up -d --force-recreate --no-deps backup

for _ in $(seq 1 30); do
  if docker exec mesada-prod-app-1 wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ "${ok:-}" = 1 ] || { "${COMPOSE[@]}" logs --tail=80 app; exit 1; }
# Lo que verá el túnel: la app por su alias en la red compartida (lectura, desde un contenedor efímero).
docker run --rm --network citas-prod_interna postgres:16.9-alpine wget -qO- http://mesada-app:3000/api/health
echo
docker image prune -f >/dev/null || true
# La caché de construcción crece con cada despliegue (de todos los proyectos): se deja en 3 GB. No toca contenedores ni datos.
docker builder prune -f --keep-storage 3gb >/dev/null || true
"${COMPOSE[@]}" ps
