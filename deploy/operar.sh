#!/usr/bin/env bash
# Operaciones de Mesada en el servidor compartido. Lo lanza .github/workflows/operar.yml (o a mano en /home/ubuntu/mesada).
#   ./deploy/operar.sh estado              → estado sin secretos (sí/no de cada clave, conexión de WhatsApp)
#   ./deploy/operar.sh preparar-whatsapp   → crea UNA VEZ la instancia «mesada» en la Evolution de consulares
#   ./deploy/operar.sh activar-envios      → NOTIFY_REAL_SEND=true (correo y WhatsApp reales)
#   ./deploy/operar.sh desactivar-envios   → vuelve al modo simulado
#   ./deploy/operar.sh enlace-recuperacion USUARIO → SOLO A MANO por SSH: imprime un enlace de un solo uso (30 min)
#       para que un adulto sin correo recupere el acceso. No está en el workflow para que el enlace no quede en registros.
# Nunca imprime claves ni el QR (el repositorio es público y los registros de Actions también).
# El QR se muestra dentro de la app, a los adultos de la familia administradora (Avisos → Línea de WhatsApp).
set -euo pipefail
cd /home/ubuntu/mesada
ENV_FILE=.env.production
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.oracle.yml)
getv() { sed -nE "s/^$1=['\"]?([^'\"]*)['\"]?$/\1/p" "$ENV_FILE" | head -1; }
setv() {
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys; from pathlib import Path
p, k, v = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = [l for l in p.read_text().splitlines() if not l.startswith(k + '=')]
lines.append(f"{k}='{v}'"); p.write_text('\n'.join(lines) + '\n'); p.chmod(0o600)
PY
}
yesno() { [ -n "$1" ] && echo sí || echo no; }
reload_app() { "${COMPOSE[@]}" up -d --no-deps --force-recreate app >/dev/null; }
# Llamada a Evolution desde un contenedor efímero en la red compartida. La clave va por entorno (-e K), no en la línea de órdenes.
evo() {
  local key="$1"; shift
  K="$key" docker run --rm --network citas-prod_interna -e K postgres:16.9-alpine \
    sh -c "wget -qO- -T 15 --header \"apikey: \$K\" --header 'content-type: application/json' $*" 2>/dev/null || true
}

case "${1:-estado}" in
  estado)
    echo "Envíos reales (NOTIFY_REAL_SEND): $(getv NOTIFY_REAL_SEND)"
    echo "Correo: proveedor=$(getv EMAIL_PROVIDER) · clave de Resend: $(yesno "$(getv RESEND_API_KEY)") · remitente=$(getv MAIL_FROM)"
    tok=$(getv EVOLUTION_INSTANCE_TOKEN)
    echo "WhatsApp: instancia=$(getv EVOLUTION_INSTANCE) · token: $(yesno "$tok")"
    if [ -n "$tok" ]; then
      st=$(evo "$tok" "http://evolution-api:8080/instance/connectionState/$(getv EVOLUTION_INSTANCE)" | sed -nE 's/.*"state":"([a-z]+)".*/\1/p')
      echo "WhatsApp conexión: ${st:-sin respuesta (¿el token de instancia no vale para esta ruta?)}"
    fi
    # Diagnóstico sin datos personales: ni direcciones ni nombres.
    echo "--- Cuentas de adulto con correo (necesario para recuperar la contraseña) ---"
    "${COMPOSE[@]}" exec -T db psql -U mesada -d mesada -tAc "SELECT 'con correo: ' || count(*) FILTER (WHERE email IS NOT NULL) || ' · sin correo: ' || count(*) FILTER (WHERE email IS NULL) FROM users WHERE role = 'adult' AND active" || true
    echo "--- Peticiones de recuperación (24 h) ---"
    "${COMPOSE[@]}" exec -T db psql -U mesada -d mesada -tAc "SELECT count(*) FROM password_resets WHERE created_at > now() - interval '24 hours'" || true
    echo "--- Últimos 10 envíos externos (evento · canal · estado · error) ---"
    "${COMPOSE[@]}" exec -T db psql -U mesada -d mesada -tAc "SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid','DD/MM HH24:MI') || ' · ' || event || ' · ' || channel || ' · ' || status || ' · ' || coalesce(provider,'-') || ' · ' || coalesce(left(last_error,120),'') FROM notification_outbox ORDER BY created_at DESC LIMIT 10" || true
    "${COMPOSE[@]}" ps --format '{{.Service}}: {{.Status}}'
    ;;
  preparar-whatsapp)
    instance=$(getv EVOLUTION_INSTANCE); instance=${instance:-mesada}
    global=$(sed -nE "s/^EVOLUTION_API_KEY=['\"]?([^'\"]*)['\"]?$/\1/p" /home/ubuntu/consulares/.env.production | head -1)
    [ -n "$global" ] || { echo "No se encontró la clave de Evolution de consulares."; exit 1; }
    tok=$(getv EVOLUTION_INSTANCE_TOKEN); [ -n "$tok" ] || tok=$(openssl rand -hex 24)
    if evo "$global" "'http://evolution-api:8080/instance/fetchInstances?instanceName=$instance'" | grep -q "\"$instance\""; then
      echo "La instancia «$instance» ya existía: no se modifica."
    else
      body="{\"instanceName\":\"$instance\",\"token\":\"$tok\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":false,\"groupsIgnore\":true,\"alwaysOnline\":false,\"readMessages\":false,\"readStatus\":false,\"syncFullHistory\":false}"
      out=$(evo "$global" "--post-data '$body' http://evolution-api:8080/instance/create")
      echo "$out" | grep -q "\"$instance\"" || { echo "Evolution no confirmó la creación."; exit 1; }
      echo "Instancia «$instance» creada (solo envío, sin webhook ni historial)."
    fi
    setv EVOLUTION_INSTANCE "$instance"
    setv EVOLUTION_INSTANCE_TOKEN "$tok"
    reload_app
    echo "Listo: vincula el móvil en la app → Avisos → Línea de WhatsApp."
    ;;
  activar-envios)
    setv NOTIFY_REAL_SEND true
    reload_app
    echo "Envíos reales ACTIVADOS."
    [ -n "$(getv RESEND_API_KEY)" ] || echo "AVISO: no hay clave de Resend; el correo seguirá simulado."
    [ -n "$(getv EVOLUTION_INSTANCE_TOKEN)" ] || echo "AVISO: falta preparar WhatsApp; seguirá simulado."
    ;;
  desactivar-envios)
    setv NOTIFY_REAL_SEND false
    reload_app
    echo "Envíos reales desactivados (modo simulado)."
    ;;
  enlace-recuperacion)
    [ -t 1 ] || { echo "Ejecútelo a mano en una terminal (no desde GitHub Actions)."; exit 1; }
    user="${2:-}"; [[ "$user" =~ ^[A-Za-z0-9._-]{3,32}$ ]] || { echo "Uso: $0 enlace-recuperacion USUARIO"; exit 1; }
    token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
    hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
    n=$("${COMPOSE[@]}" exec -T db psql -U mesada -d mesada -v ON_ERROR_STOP=1 -tAc \
      "WITH u AS (SELECT id FROM users WHERE lower(username) = lower('$user') AND role = 'adult' AND active)
       INSERT INTO password_resets(user_id, token_hash, expires_at) SELECT id, '$hash', now() + interval '30 minutes' FROM u RETURNING 1" | wc -l)
    [ "$n" -ge 1 ] || { echo "No hay ningún adulto activo con ese usuario."; exit 1; }
    echo "Abre este enlace en los próximos 30 minutos (un solo uso):"
    echo "$(getv APP_BASE_URL)/restablecer?token=$token"
    ;;
  *) echo "Acción desconocida: $1"; exit 1 ;;
esac
