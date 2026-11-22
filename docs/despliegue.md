# Despliegue en tu servidor

Hay dos formas de desplegar:
- **A. Infraestructura compartida con TEINVITO** (VM de Oracle, túnel de Cloudflare y Evolution), con correo por Resend como firmador: es la elegida. Ver el apartado 0 y el análisis en `infraestructura-compartida.md`.
- **B. Servidor propio e independiente** (apartados 1 a 6), con `docker-compose.yml`.

## 0. Infraestructura compartida (mesada.veryfacil.org)

Orden recomendado. Los pasos marcados con 👤 los hace el usuario, porque necesitan cuentas o secretos:

1. 👤 Confirmar las decisiones de `infraestructura-compartida.md` §4.
2. 👤 Secretos del repositorio Mesada (GitHub → Settings → Secrets → Actions):
   - `ORACLE_SSH_KEY`: la misma clave de despliegue de la VM, que tú conoces. GitHub no permite copiarla desde TEINVITO.
   - `CLOUDFLARE_API_TOKEN`: token con *Zone DNS: Edit* sobre veryfacil.org y *Cloudflare Tunnel: Edit* en la cuenta del túnel.
   - `RESEND_API_KEY`: en Resend → API Keys → *Create API key*, con el nombre «Mesada», permiso **Sending access** y dominio **veryfacil.org**. No reutilices la de firmador.
3. El dominio veryfacil.org ya está verificado en Resend (lo usa firmador): no hace falta tocar el DNS. Remitente: `mesada@veryfacil.org`.
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

## 0.b. Copia de seguridad fuera del servidor, cifrada, en Cloudflare R2

El servicio `backup` ya guarda cada día un volcado y las fotos en `~/mesada/backups` (14 días) **dentro del mismo servidor**: si la VM se pierde, se pierden también las copias. Con las variables de abajo, cada copia se **cifra** (GnuPG simétrico, AES-256, antes de salir) y se sube a un bucket privado de Cloudflare R2, donde se conservan `R2_RETENTION_DAYS` días (30 por defecto). Si falta alguna de las cinco variables obligatorias, el servicio sigue exactamente como antes y no sube nada (el registro dice cuáles faltan, solo sus nombres). Nunca se imprimen claves.

**Lo que haces tú a mano (👤):**

1. 👤 En Cloudflare → **R2 Object Storage** → *Create bucket*. Nombre, por ejemplo, `diplop-copias`. Déjalo **privado** (sin dominio público ni acceso público). Región: la más cercana (automática vale).
2. 👤 R2 → *Manage R2 API Tokens* → *Create API token*: permiso **Object Read & Write**, limitado **solo a ese bucket**. Guarda el *Access Key ID* y el *Secret Access Key* (solo se ven una vez). El *endpoint* es `https://<ID-DE-CUENTA>.r2.cloudflarestorage.com` (aparece en la misma pantalla).
3. 👤 Inventa la contraseña de cifrado: `openssl rand -base64 33`. **Guárdala también fuera del servidor** (gestor de contraseñas): sin ella no se puede descifrar ninguna copia, y si se pierde el servidor se pierde con él.
4. 👤 En el servidor, añade al final de `/home/ubuntu/mesada/.env.production` (permisos 600, valores entre comillas simples y sin comillas dentro; los despliegues **conservan** estas claves):
   ```bash
   R2_ENDPOINT='https://<ID-DE-CUENTA>.r2.cloudflarestorage.com'
   R2_BUCKET='diplop-copias'
   R2_ACCESS_KEY_ID='…'
   R2_SECRET_ACCESS_KEY='…'
   BACKUP_PASSPHRASE='…'
   # opcional: R2_RETENTION_DAYS='30'  R2_PREFIX='mesada'  R2_INCLUDE_PHOTOS='true'
   ```
5. 👤 Recrea el servicio para que las lea: `cd /home/ubuntu/mesada && docker compose --env-file .env.production -f docker-compose.oracle.yml up -d --force-recreate --no-deps backup`. La primera vez instala `gnupg` y `rclone` dentro del contenedor (necesita salida a Internet) y sube la primera copia en el momento.
6. 👤 **Prueba**: Actions → **Operar** → `copia-r2-probar`. Sube un fichero de prueba cifrado, lo baja, lo descifra y lo borra, y dice «PRUEBA CORRECTA». `estado` muestra solo sí/no de cada variable y las últimas líneas `R2 OK` o `R2 ERROR` del registro.
7. 👤 Mira de vez en cuando que haya copias recientes: `./deploy/operar.sh copia-r2 listar` (nombre, tamaño y fecha; nunca claves).

En R2 quedan `mesada-AAAAMMDD-HHMMSS.dump.gpg` (volcado de PostgreSQL) y `fotos-AAAAMMDD-HHMMSS.tar.gz.gpg` (fotos de evidencia). Cloudflare cobra por almacenamiento por encima de 10 GB gratis; una familia ocupa muy poco. La retención borra en R2 solo tras una subida correcta, así que un fallo de red no vacía el bucket.

**Restaurar desde R2** (sustituye todos los datos actuales; hazlo con calma y, si puedes, antes guarda una copia del estado actual):

```bash
cd /home/ubuntu/mesada
C="docker compose --env-file .env.production -f docker-compose.oracle.yml"
# 1. Mira qué hay y descarga+descifra la que quieras (o «ultima»). Queda en backups/restaurar/ (permisos 600).
$C exec -T backup sh /r2.sh listar
$C exec -T backup sh /r2.sh ultima                       # o: descargar mesada-20261122-030000.dump.gpg
# 2. Restaura la base: para la app, vuelca, vuelve a arrancar.
$C stop app
$C exec -T db pg_restore --clean --if-exists -U mesada -d mesada < backups/restaurar/mesada-20261122-030000.dump
$C start app
# 3. Fotos (opcional): descarga fotos-….tar.gz.gpg con el mismo comando y descomprímelo en el volumen de subidas.
$C exec -T backup sh /r2.sh descargar fotos-20261122-030000.tar.gz.gpg
$C cp backups/restaurar/fotos-20261122-030000.tar.gz app:/tmp/f.tgz && $C exec app tar -xzf /tmp/f.tgz -C /data
# 4. Borra lo descifrado.
rm -rf backups/restaurar
```

**Si has perdido el servidor entero:** crea otro, despliega, y desde cualquier sitio con `rclone` y `gpg` (con tus claves de R2): `rclone copyto :s3:diplop-copias/mesada/mesada-….dump.gpg ./x.gpg --s3-provider Cloudflare --s3-endpoint … --s3-access-key-id … --s3-secret-access-key …` y `gpg --decrypt -o mesada.dump x.gpg` (te pide la contraseña de cifrado). Después, `pg_restore` como arriba.

**Prueba local (sin red):** `sh deploy/test-backup.sh` cifra, «sube» a un bucket simulado, comprueba que lo subido no contiene datos en claro, que descifra con la clave buena y no con otra, la retención y que ninguna clave sale en el registro.

## 0.c. Vigilancia y privacidad (lo que queda de tu parte)

- 👤 **Avisos de caída:** `.github/workflows/uptime.yml` llama cada 15 minutos a `https://mesada.veryfacil.org/api/health` y falla si no da 200 en tres intentos. GitHub te avisa por correo si tienes activadas las notificaciones de Actions: GitHub → Settings → Notifications → *Actions* → *Send notifications for failed workflows only* (y correo marcado). Las programaciones se desactivan tras 60 días sin actividad en el repositorio: si pasa, se reactiva en la pestaña Actions.
- **Errores del servidor:** cada 5xx devuelve a la persona un código de 8 letras («indica este código: K7M2QX9R») y queda en el registro del contenedor y en la tabla `server_errors` (30 días, sin datos personales). Para buscarlo: `docker compose … logs app | grep K7M2QX9R`, o la administración verificada con `GET /api/admin/errors?id=K7M2QX9R`.
- 👤 **Correo de privacidad:** `privacidad@veryfacil.org` aparece en los textos legales. Tiene que existir y llegarte (por ejemplo, Cloudflare → Email Routing → reenviar a tu correo). Plazo legal de respuesta a los derechos: un mes.
- 👤 **Antes de abrir el registro** (`ALLOW_REGISTRATION=true` o el interruptor de Administración): relee los textos de `docs/legal/` y confirma que lo que dicen sigue siendo verdad (proveedores, región del servidor de Oracle, retención). Si cambias algo de fondo, sube `LEGAL_VERSION` en `server/src/lib/legal.ts` y la versión de los tres `.md`, y ejecuta `cd web && npm run legal`.

## 0.d. Mantenimiento

- **Limpieza nocturna** (03:00–05:00, hora de Madrid) y botón **Limpiar basura** en *Administración › Sistema*: fotos caducadas (7 días tras validar) y huérfanas, sesiones, avisos y envíos antiguos, enlaces e invitaciones caducados. Queda en el registro de administración con las cifras.
- *Administración › Sistema* muestra disco, fotos, base de datos, copias (con aviso si la última pasa de 26 h) y familias inactivas, que se pueden borrar con confirmación fuerte.
- Las fotos se reducen a 1280 px y pierden EXIF y GPS al subirse (`sharp`, incluido en la imagen de Docker).

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

Conserva `BACKUP_KEEP_DAYS` días (14 por defecto). **Copia la carpeta `backups/` fuera del servidor**: lo más cómodo es activar la copia cifrada en Cloudflare R2 (apartado 0.b); o rsync, Syncthing, un disco externo…

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
| `TRUST_CLOUDFLARE_IP` | true | Usa `CF-Connecting-IP` (la pone Cloudflare y el cliente no puede falsearla) para contar los límites por IP. Ponlo en `false` si no hay Cloudflare delante |
| `RATE_SETUP_PER_HOUR` | 5 | Altas de familia por IP y hora |
| `RATE_INVITE_PER_HOUR` | 20 | Invitaciones enviadas por IP y hora |
| `RATE_INVITE_ACCEPT_PER_HOUR` | 20 | Invitaciones aceptadas por IP y hora (consultar el enlace admite el doble) |
| `RATE_RECOVERY_PER_HOUR` | 6 | Peticiones de «he olvidado la contraseña» por IP y hora |
| `RATE_RESET_PER_HOUR` | 20 | Cambios de contraseña con enlace por IP y hora |
| `RATE_UPLOAD_PER_HOUR` | 60 | Fotos de evidencia subidas por IP y hora |
| `RATE_EXPORT_PER_HOUR` | 6 | Descargas de «todos los datos» por IP y hora |
| `MAX_MEMBERS_PER_FAMILY` | 20 | Personas (adultos e hijos) por familia |
| `MAX_PENDING_INVITATIONS` | 10 | Invitaciones sin usar ni caducar por familia |
| `MAX_PHOTOS_PER_FAMILY` | 500 | Fotos de evidencia guardadas por familia |
| `MAX_UPLOAD_MB` | 5 | Tamaño máximo de una foto subida (después se reduce a 1280 px) |
| `PHOTO_RETENTION_DAYS` | 7 | Días que se conserva una foto tras validar la tarea |
| `CLEAN_NOTIFICATIONS_DAYS` / `CLEAN_OUTBOX_DAYS` | 90 / 90 | Antigüedad a partir de la cual la limpieza nocturna borra avisos y envíos ya resueltos |
| `INACTIVE_FAMILY_MONTHS` | 6 | Meses sin uso para listar una familia como inactiva en Administración › Sistema |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BACKUP_PASSPHRASE` | — | Copia externa cifrada en R2 (apartado 0.b). Las cinco a la vez, o ninguna |
| `R2_RETENTION_DAYS` | 30 | Días que se conservan las copias en R2 |
| `R2_PREFIX` / `R2_INCLUDE_PHOTOS` | mesada / true | Carpeta dentro del bucket y si también se suben las fotos |

Los límites de IP son por hora y por instancia (se cuentan en memoria; con un valor `0` se desactiva ese límite). Pasado el límite la respuesta es 429 «Demasiados intentos desde tu conexión». Las respuestas de «he olvidado la contraseña» son siempre iguales, exista o no la cuenta.

## 6. Problemas frecuentes

- **No aparece «Instalar app» en el móvil:** necesitas HTTPS.
- **Te has quedado sin acceso de adulto:** con `docker compose exec db psql -U mesada mesada` puedes consultar la tabla `users`. Para restablecer una contraseña, crea otro adulto desde la cuenta del segundo adulto o restaura una copia.
- **Alguien pide borrar o descargar sus datos:** puede hacerlo solo, en *Ajustes › Privacidad y datos* (adultos) o *Familia › Editar › Borrar los datos* (un hijo). Si escribe a `privacidad@veryfacil.org` y no puede entrar, pídele que use *¿Has olvidado la contraseña?*; si no hay otra vía, la administración puede ayudarle (nunca se leen sus datos).
- **Un hijo ha olvidado el PIN o se ha bloqueado tras 5 intentos:** un adulto entra en *Familia → Editar → Nuevo PIN*. Así también se desbloquea.

## 7. Espacio en disco

**Ver qué ocupa:** Actions › **Operar** › `disco`. Muestra el disco total, usado y libre, el reparto de Docker (imágenes, volúmenes, caché), las carpetas de cada proyecto, las copias y los registros. Solo tamaños, ningún dato de usuarios.

**Limpiar sin riesgo:** Actions › **Operar** › `limpiar-docker`. Borra la caché de construcción (deja 3 GB) y las imágenes sin usar de todos los proyectos. No toca contenedores, volúmenes ni datos. Cada despliegue de Mesada lo hace ya solo.

**Copias locales:** con R2 activo, el servidor guarda solo `BACKUP_KEEP_DAYS_WITH_R2` días (3 por defecto) y el resto queda en R2 (`R2_RETENTION_DAYS`, 30). Si la última subida a R2 falló, se conservan los `BACKUP_KEEP_DAYS` (14) locales.

**Base de datos:** no se puede llevar a R2. R2 guarda archivos, no ejecuta PostgreSQL. La base de Mesada ocupa pocos megas.

### Agrandar el disco de la VM de Oracle (gratis hasta 200 GB en Always Free)

El plan gratuito incluye 200 GB de almacenamiento en bloque en total (disco de arranque más volúmenes). Muchas VM se crean con unos 47 GB.

1. Haz una copia antes: Actions › **Operar** › `estado` debe mostrar una copia reciente. Mejor aún, crea en la consola un *backup* del volumen de arranque: Storage › Boot volumes › tu volumen › *Create manual backup*.
2. Consola de Oracle › **Compute › Instances** › tu instancia › **Boot volume** › el volumen › **Edit**. Pon el tamaño nuevo, por ejemplo 100 GB, y guarda. No hace falta parar la VM.
3. Oracle muestra unos comandos de *rescan*. Ejecútalos por SSH en la VM. Suelen ser estos:
   ```bash
   sudo dd iflag=direct if=/dev/oracleoci/oraclevda of=/dev/null count=1
   echo "1" | sudo tee /sys/class/block/$(readlink /dev/oracleoci/oraclevda | cut -d/ -f2)/device/rescan
   ```
4. Agranda la partición y el sistema de archivos (Ubuntu):
   ```bash
   lsblk                      # mira el disco y la partición de / (p. ej. sda y sda1)
   sudo growpart /dev/sda 1
   sudo resize2fs /dev/sda1   # si / es ext4; con xfs: sudo xfs_growfs /
   df -h /
   ```
5. Comprueba con Actions › **Operar** › `disco`.

Pasarse de 200 GB entre todos los volúmenes de la cuenta tiene coste. Revisa en Storage › Block volumes que no haya otros volúmenes.
