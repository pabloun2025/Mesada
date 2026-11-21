#!/usr/bin/env python3
"""Comprueba o añade mesada.veryfacil.org al túnel de Cloudflare que ya sirve consulares y TEINVITO.
Mismo método que scripts/cloudflare-dominio.py de TEINVITO: solo AÑADE una regla de ingress (antes de la final)
y un CNAME; no modifica ni borra las existentes. Uso: comprobar|crear HOST ZONA ORIGEN_EXISTENTE SERVICIO
"""
import json, os, sys, urllib.request, urllib.error

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
ACCION, HOST, ZONA, ORIGEN, SERVICIO = sys.argv[1:6]
if not TOKEN:
    raise SystemExit("Falta el secreto CLOUDFLARE_API_TOKEN en el repositorio de Mesada.")

def api(m, ruta, cuerpo=None):
    req = urllib.request.Request("https://api.cloudflare.com/client/v4" + ruta, method=m,
                                 data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
                                 headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}") | {"http": e.code}

zonas = api("GET", f"/zones?name={ZONA}").get("result") or []
if not zonas:
    raise SystemExit(f"El token no ve la zona {ZONA}.")
zona, cuenta = zonas[0]["id"], zonas[0]["account"]["id"]
print("Zona:", ZONA, "cuenta:", cuenta)
tuneles = api("GET", f"/accounts/{cuenta}/cfd_tunnel?is_deleted=false").get("result") or []
elegido = None
for t in tuneles:
    cfg = (api("GET", f"/accounts/{cuenta}/cfd_tunnel/{t['id']}/configurations").get("result") or {}).get("config") or {}
    if any(r.get("hostname") == ORIGEN for r in cfg.get("ingress") or []):
        elegido = (t, cfg)
if not elegido:
    raise SystemExit(f"En la cuenta de {ZONA} no hay ningún túnel que sirva {ORIGEN}: la zona está en otra cuenta. No se cambia nada.")
t, cfg = elegido
print("Túnel:", t["name"], t["status"], "· reglas:", [r.get("hostname", "(final)") for r in cfg["ingress"]])
dns = [x for x in (api("GET", f"/zones/{zona}/dns_records?name={HOST}").get("result") or [])]
print("DNS de", HOST, ":", [(x["type"], x["content"]) for x in dns] or "no existe")
if ACCION == "comprobar":
    raise SystemExit(0)

if not any(r.get("hostname") == HOST for r in cfg["ingress"]):
    con = [r for r in cfg["ingress"] if r.get("hostname")]
    sin = [r for r in cfg["ingress"] if not r.get("hostname")]
    cfg["ingress"] = con + [{"hostname": HOST, "service": SERVICIO}] + sin
    r = api("PUT", f"/accounts/{cuenta}/cfd_tunnel/{t['id']}/configurations", {"config": cfg})
    print("Ingress:", "añadido" if r.get("success") else r.get("errors"))
    if not r.get("success"):
        raise SystemExit(1)
else:
    print("Ingress: ya existía.")
if dns:
    print("DNS: ya existe un registro; no se toca.")
else:
    r = api("POST", f"/zones/{zona}/dns_records", {"type": "CNAME", "name": HOST, "content": f"{t['id']}.cfargotunnel.com", "proxied": True})
    print("DNS:", "creado" if r.get("success") else r.get("errors"))
