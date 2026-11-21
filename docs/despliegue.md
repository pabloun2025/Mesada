# Despliegue en tu servidor

Hay dos formas de desplegar:
- **A. Infraestructura compartida con TEINVITO** (VM de Oracle, túnel de Cloudflare, Evolution y Brevo): es la elegida. Ver el apartado 0 y el análisis en `infraestructura-compartida.md`.
- **B. Servidor propio e independiente** (apartados 1 a 6), con `docker-compose.yml`.

## 0. Infraestructura compartida (mesada.veryfacil.org)

Orden recomendado. Los pasos marcados con 👤 los hace el usuario, porque necesitan cuentas o secretos:

1. 👤 Confirmar las decisiones de `infraestructura-compartida.md` §4.
2. 👤 Secretos del repositorio Mesada (GitHub → Settings → Secrets → Actions):
   - `ORACLE_SSH_KEY`: la misma clave de despliegue de la VM, que tú conoces. GitHub no permite copiarla desde TEINVITO.
   - `CLOUDFLARE_API_TOKEN`: token con *Zone DNS: Edit* sobre veryfacil.org y *Cloudflare Tunnel: Edit* en la cuenta del túnel.
   - `SMTP_USER` / `SMTP_PASS`: el usuario del relé (`…@smtp-brevo.com`) y una **clave SMTP nueva**, llamada «Mesada», creada en Brevo → SMTP y API → SMTP.
3. 👤 Brevo → Remitentes y dominios: añadir **veryfacil.org** y crear en Cloudflare **solo los registros nuevos** que pida Brevo (código `brevo-code` y DKIM `brevo1/brevo2._domainkey`), sin tocar los de Resend ni el DMARC. Remitente: `avisos@veryfacil.org`.
4. Actions → **Dominio** → `comprobar`. Debe listar el túnel que sirve `recordatorio.consulado.app`. Si dice que la zona está en otra cuenta, para aquí y avísame.
5. Actions → **Desplegar en Oracle**. Crea `mesada-prod`, genera `.env.production` en el servidor y verifica la salud desde la red compartida.
6. Actions → **Dominio** → `crear`. Añade `mesada.veryfacil.org → http://mesada-app:3000` al túnel. Abre la web y crea la familia.
7. WhatsApp: en el servidor, `cd /home/ubuntu/mesada && ./deploy/setup-whatsapp.sh`, y escanea el QR con el **teléfono de la familia**.
8. **Prueba controlada:** pon tu correo y tu teléfono en *Avisos*, deja `NOTIFY_REAL_SEND='false'` y comprueba en «Últimos envíos» que se encolan y salen en simulado. Después:
   ```bash
   cd /home/ubuntu/mesada && sed -i "s/^NOTIFY_REAL_SEND=.*/NOTIFY_REAL_SEND='true'/" .env.production
   docker compose --env-file .env.production -f docker-compose.oracle.yml up -d app
   ```
   Envía una tarea de prueba y comprueba que el correo y el WhatsApp llegan. Si WhatsApp responde 401, Evolution no acepta el token de instancia: avísame antes de usar otra clave.

Convivencia: el despliegue solo toca el proyecto `mesada-prod`. No usa `--remove-orphans`, no lee los `.env` de otros proyectos (salvo el paso 7, una vez y sin copiar la clave) y no publica puertos.

Funciona en cualquier máquina con Docker y Docker Compose: un VPS, un mini PC o una Raspberry Pi 4/5 de 64 bits. No usa servicios externos de pago.

## 1. Instalación

```bash
git clone https://github.com/pabloun2025/Mesada.git
cd Mesada
cp .env.example .env
# Edita .env: como mínimo POSTGRES_PASSWORD (por ejemplo, openssl rand -base64 32)
docker compose up -d --build
```

Abre `http://IP-DEL-SERVIDOR:8080` (puerto `MESADA_PORT`). La primera vez te pedirá **crear la familia**: esa persona será la administradora. Después, en *Familia*, añade al otro adulto y a los hijos (usuario + PIN).

Comprobaciones:

```bash
docker compose ps                     # app y db en estado "healthy"
curl http://localhost:8080/api/health # {"ok":true}
docker compose logs -f app
```

## 2. HTTPS (recomendado)

La PWA solo se puede instalar en los móviles desde HTTPS (o `localhost`). Pon un proxy inverso delante y activa `COOKIE_SECURE=true` en `.env`.

**Caddy** (certificado automático de Let's Encrypt), en `/etc/caddy/Caddyfile`:

```
mesada.tudominio.es {
    reverse_proxy 127.0.0.1:8080
}
```

En una red doméstica sin dominio público, puedes usar Tailscale (`tailscale serve 8080`) o el proxy de tu NAS con un certificado propio.

Si expones el servicio a Internet, publica solo el proxy. Para que la app escuche únicamente en local, cambia el mapeo de puertos a `"127.0.0.1:${MESADA_PORT:-8080}:3000"` en `docker-compose.yml`.

## 3. Copias de seguridad

El servicio `backup` hace cada 24 h (`BACKUP_INTERVAL_SECONDS`):

- `backups/mesada-AAAAMMDD-HHMMSS.dump`: volcado de PostgreSQL (`pg_dump -Fc`)
- `backups/fotos-AAAAMMDD-HHMMSS.tar.gz`: fotos de evidencia

Conserva `BACKUP_KEEP_DAYS` días (14 por defecto). **Copia la carpeta `backups/` fuera del servidor** (rsync, Syncthing, un disco externo…).

Restaurar (sustituye todos los datos actuales):

```bash
./deploy/restore.sh backups/mesada-20261120-224832.dump
# fotos (opcional):
docker compose cp backups/fotos-20261120-224832.tar.gz app:/tmp/f.tgz
docker compose exec app tar -xzf /tmp/f.tgz -C /data
```

Este ciclo de copia y restauración se ha probado de principio a fin con un borrado y una recuperación reales.

## 4. Actualizar

```bash
git pull
docker compose up -d --build
```

Las migraciones de la base de datos se aplican solas al arrancar. Haz una copia antes de actualizar.

## 5. Variables de entorno

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `POSTGRES_PASSWORD` | — (obligatoria) | Contraseña de la base de datos |
| `MESADA_PORT` | 8080 | Puerto publicado en el servidor |
| `COOKIE_SECURE` | false | `true` si se sirve por HTTPS |
| `ALLOW_REGISTRATION` | false | Permitir crear más familias en la misma instalación |
| `SESSION_DAYS` | 30 | Duración de la sesión |
| `AUTH_RATE_LIMIT` | 10 | Intentos de inicio de sesión por minuto e IP |
| `BACKUP_KEEP_DAYS` | 14 | Días que se conservan las copias |
| `BACKUP_INTERVAL_SECONDS` | 86400 | Frecuencia de las copias |
| `LOG_LEVEL` | info | `debug`, `info`, `warn` o `error` |

## 6. Problemas frecuentes

- **No aparece «Instalar app» en el móvil:** necesitas HTTPS.
- **Te has quedado sin acceso de adulto:** con `docker compose exec db psql -U mesada mesada` puedes consultar la tabla `users`. Para restablecer una contraseña, crea otro adulto desde la cuenta del segundo adulto o restaura una copia.
- **Un hijo ha olvidado el PIN o se ha bloqueado tras 5 intentos:** un adulto entra en *Familia → Editar → Nuevo PIN*. Así también se desbloquea.
