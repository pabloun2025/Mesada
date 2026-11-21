#!/usr/bin/env bash
# Alta ÚNICA de la instancia de WhatsApp de Mesada en la Evolution API de consulares. Ejecutar a mano en el servidor:
#   cd /home/ubuntu/mesada && ./deploy/setup-whatsapp.sh
# - Usa la clave global de Evolution solo aquí, leyéndola del .env de consulares sin copiarla ni mostrarla.
# - Crea la instancia «mesada» con un token aleatorio propio y lo guarda en .env.production de Mesada (600).
#   Mesada usará solo ese token: no podrá operar las líneas de la Embajada ni de los consulados.
# - Sin webhook: Mesada solo envía. Sin historial ni lectura de mensajes.
# - Muestra el QR (base64) para vincular el TELÉFONO DE LA FAMILIA (no uno institucional).
set -euo pipefail
cd /home/ubuntu/mesada
GLOBAL_KEY=$(sed -nE "s/^EVOLUTION_API_KEY=['\"]?([^'\"]*)['\"]?$/\1/p" /home/ubuntu/consulares/.env.production | head -1)
[ -n "$GLOBAL_KEY" ] || { echo "No se encontró EVOLUTION_API_KEY en consulares."; exit 1; }
INSTANCE=mesada
TOKEN=$(grep -E '^EVOLUTION_INSTANCE_TOKEN=' .env.production | sed -E "s/^[^=]+=['\"]?([^'\"]*)['\"]?$/\1/")
[ -n "$TOKEN" ] || TOKEN=$(openssl rand -hex 24)
# La clave se pasa por herencia de entorno (-e K sin valor): no aparece en la lista de procesos.
export K="$GLOBAL_KEY"
call() { docker run --rm --network citas-prod_interna -e K postgres:16.9-alpine sh -c "wget -qO- --header \"apikey: \$K\" --header 'content-type: application/json' $*"; }
if call "'http://evolution-api:8080/instance/fetchInstances?instanceName=$INSTANCE'" 2>/dev/null | grep -q "\"$INSTANCE\""; then
  echo "La instancia $INSTANCE ya existe; no se modifica."
else
  call "--post-data '{\"instanceName\":\"$INSTANCE\",\"token\":\"$TOKEN\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":false,\"groupsIgnore\":true,\"alwaysOnline\":false,\"readMessages\":false,\"readStatus\":false,\"syncFullHistory\":false}' http://evolution-api:8080/instance/create" >/dev/null
  echo "Instancia $INSTANCE creada."
fi
# Guarda el token (sin mostrarlo).
python3 - "$TOKEN" <<'PY'
import sys; from pathlib import Path
p = Path('.env.production'); lines = [l for l in p.read_text().splitlines() if not l.startswith('EVOLUTION_INSTANCE_TOKEN=')]
lines.append(f"EVOLUTION_INSTANCE_TOKEN='{sys.argv[1]}'"); p.write_text('\n'.join(lines) + '\n'); p.chmod(0o600)
PY
echo "QR para vincular el teléfono de la familia (WhatsApp → Dispositivos vinculados):"
call "'http://evolution-api:8080/instance/connect/$INSTANCE'" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("base64") or d.get("pairingCode") or d)'
echo "Después: prueba controlada con NOTIFY_REAL_SEND=false → true en .env.production y docker compose ... up -d app"
