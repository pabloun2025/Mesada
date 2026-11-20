# Despliegue en tu servidor

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
