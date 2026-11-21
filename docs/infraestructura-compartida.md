# Reutilización de la infraestructura de TEINVITO

Fecha: 21/11/2026. Revisión **solo de lectura** de los repositorios `pabloun2025/teinvito` (commit `9d4d2b3`) y `pabloun2025/consulares` (commit `634cbe6`), y de la cuenta de Brevo (consultas de lectura). No se ha accedido al servidor de producción ni se ha cambiado nada en TEINVITO, en consulares ni en Brevo.

Dominio de publicación decidido por el usuario: **veryfacil.org**. Propuesta: `mesada.veryfacil.org`, con el mismo esquema que `firma.` y `admin.veryfacil.org`.

También se ha revisado en solo lectura `pabloun2025/firmador` (commit `b971e93`, LeapSign), que ya usa ese dominio:
- Interfaz en **Cloudflare Workers** (activos estáticos): la zona `veryfacil.org` **está en Cloudflare**.
- Backend en Supabase gestionado (funciones Edge), con secretos en Supabase.
- Correo por **Resend** (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`): veryfacil.org ya está verificado en Resend, no en Brevo.

## 1. Lo que hay hoy

```
VM Oracle Cloud (ubuntu@51.170.51.109, 24 GB de RAM, Docker Compose, ningún puerto abierto a Internet)
├─ proyecto citas-prod  (repo consulares)  → recordatorio.consulado.app
│   ├─ postgres (citas_consulares, RLS, datos de ciudadanos)
│   ├─ app, worker, backup, offsite (R2 sin configurar)
│   ├─ cloudflared  ← TÚNEL ÚNICO de Cloudflare (gestionado en remoto, por API)
│   └─ evolution-api v2.3.7 + evolution-postgres + evolution-redis  ← WhatsApp compartido
│        red «citas-prod_interna»
└─ proyecto teinvito-prod (repo teinvito)   → invitaciones.embajada.app
    ├─ postgres propio (teinvito)
    ├─ app (alias teinvito-app en la red de consulares), worker, migrate, backup, ollama
    └─ se une a «citas-prod_interna» para llegar a Evolution y para que el túnel le llegue
```

- **Publicación:** el túnel de `consulares` sirve todos los hostnames. Se añade un hostname con la API de Cloudflare (`scripts/cloudflare-dominio.py` de TEINVITO, en modo «comprobar» o «crear»).
- **Despliegue de TEINVITO:** el workflow `oracle-deploy.yml` (manual) pasa CI, empaqueta el código y lo copia por SSH. Después, `scripts/deploy-oracle.sh` regenera `.env.production` **en el servidor**, tomando `EVOLUTION_API_KEY` y `BREVO_API_KEY` de `/home/ubuntu/consulares/.env.production`. Las claves no pasan por Git.
- **Secretos:** secretos de GitHub (`ORACLE_SSH_KEY`, `CLOUDFLARE_API_TOKEN`, claves de proveedores), un paquete cifrado (`oracle-bootstrap.json.enc`) y `.env.production` en el servidor con permisos 600.
- **Copias:** cada proyecto tiene su contenedor `backup` (`pg_dump -Fc`, 14 días en `./backups`). R2 tiene un freno de cupo propio de TEINVITO.

## 2. Qué se reutiliza y cómo

| Componente | ¿Se reutiliza? | Cómo, en Mesada | Por qué / riesgos |
|---|---|---|---|
| **VM de Oracle y Docker** | ✅ Sí | Proyecto Compose nuevo `mesada-prod` en `/home/ubuntu/mesada`, con nombres de contenedor propios | Hay memoria de sobra; Mesada ocupa unos 150 MB. Nunca se usa `--remove-orphans` ni se tocan otros proyectos |
| **Cloudflare Tunnel** | ✅ Sí | Hostname `mesada.veryfacil.org` en el **mismo túnel** de consulares, apuntando a `http://mesada-app:3000` | Sin certificados ni puertos nuevos. La zona está en Cloudflare (la usa firmador). **Por verificar:** que esté en la misma cuenta que el túnel y que haya un token con permiso de túnel y DNS sobre ella. Solo se añade un registro: los de `firma.` y `admin.` no se tocan |
| **Red Docker** | ✅ Sí | `mesada-app` se une a `citas-prod_interna` con alias propio, igual que TEINVITO | Necesario para el túnel y para Evolution. Su PostgreSQL queda en una red interna propia |
| **Servidor PostgreSQL** | ⚖️ Decisión (ver §4) | Recomendado: contenedor propio ligero, que es el patrón del servidor (TEINVITO tampoco comparte el de consulares). Alternativa admitida: base y rol propios dentro de `teinvito-postgres` | Compartir implica ejecutar `CREATE ROLE/DATABASE` en el servidor de producción de TEINVITO y acoplar reinicios y versiones. Mesada solo necesita `DATABASE_URL`: ambas opciones funcionan sin cambiar código |
| **Gestión de secretos** | ✅ Mecanismo | El mismo patrón: script de despliegue en el servidor que genera `.env.production` (600) y lee las claves compartidas del `.env.production` de consulares. Secreto `ORACLE_SSH_KEY` en el repositorio de Mesada | Nada en Git. Las claves compartidas no se copian a otro repositorio ni a un registro |
| **WhatsApp (Evolution API)** | ✅ El servidor, **no la línea** | Instancia nueva `mesada`, vinculada a un **teléfono de la familia**, con su propio token de instancia | Ver §3. No se debe escribir a la familia desde la línea institucional de la Embajada ni de los consulados |
| **Correo** | ✅ **Resend, como firmador** (decisión del usuario del 21/11) | La misma cuenta de Resend y el dominio `veryfacil.org` ya verificado, con una **clave propia de Mesada** de «Sending access» limitada a veryfacil.org. Remitente `mesada@veryfacil.org`. Tope mensual propio | Sin cambios de DNS ni en Brevo. Ver §3 |
| **Autenticación** | ❌ Usuarios y sesiones separados | Mesada mantiene su sistema (cookies propias en su dominio). Se reutilizan **patrones**: bloqueo por intentos, `COOKIE_SECURE`, `.env` en el servidor | Requisito de aislamiento. Turnstile y TOTP de TEINVITO están ligados a su dominio y a su clave |
| **Copias de seguridad** | ✅ Patrón | Contenedor `backup` propio (como TEINVITO), 14 días en `./backups` | **No usar R2 de TEINVITO:** su documentación prohíbe otros cubos o herramientas en esa cuenta porque rompen su freno de cupo |
| **Despliegue** | ✅ Patrón | Workflow manual `oracle-deploy.yml` en Mesada, copia del de TEINVITO, con comprobación de salud y verificación desde la red de consulares | Mismo flujo conocido; ninguna máquina nueva |
| **Monitorización** | 🟡 Parcial | `HEALTHCHECK` propio y verificación en el despliegue. La consola de estado de TEINVITO es suya y no se toca | Pendiente: un aviso conjunto si se quiere |
| **IA local (Ollama)** | ❌ No hace falta | — | Mesada no la necesita |

## 3. Comprobaciones de las integraciones

### WhatsApp: cómo funciona realmente

- **Proveedor:** Evolution API v2.3.7 (`evoapicloud/evolution-api`, imagen fijada por huella), integración `WHATSAPP-BAILEYS`. Es el **protocolo no oficial de WhatsApp Web**: una instancia equivale a un teléfono vinculado con QR. **No es la API oficial de WhatsApp Business** (Meta Cloud API).
- **Qué permite:** texto libre (`/message/sendText/{instancia}`) y documentos (`sendMedia`). No hay plantillas aprobadas ni ventana de 24 horas, como en la API oficial.
- **Restricciones reales:**
  - Riesgo de **bloqueo del número** por WhatsApp si se envía mucho o a quien no ha escrito antes. consulares lo marca como «experimental» y limita a 150 al día por sede, con pausas de 8 a 150 segundos.
  - El teléfono debe seguir vinculado; si se desvincula, no hay envío.
  - No hay garantía de entrega: Evolution devuelve un id, pero no confirma que el mensaje llegue.
  - Las condiciones de WhatsApp exigen **13 años como mínimo** en la UE. Hugo (11 años) no puede ser destinatario por WhatsApp.
  - Evolution no guarda mensajes ni contactos (`DATABASE_SAVE_DATA_*=false`), y así debe seguir.
- **Permisos:** la clave global (`AUTHENTICATION_API_KEY`) controla **todas** las instancias, incluidas las líneas de la Embajada y los consulados, que tienen datos de ciudadanos. Por mínimo privilegio, **Mesada no recibe la clave global**: un operador crea una vez la instancia `mesada` (con la clave global, en el servidor) y Mesada guarda solo el **token de esa instancia**, con el que Evolution v2 autentica las llamadas a esa instancia. *Hay que confirmarlo en la prueba controlada antes de activar el envío real.*
- **Encaje con lo que necesitamos:** los recordatorios, aprobaciones y avisos de recompensa son mensajes de texto cortos, a pocos destinatarios conocidos y con consentimiento. Encaja, con un **tope diario** y una pausa entre envíos.

### Brevo

- **Cuenta:** plan **Starter de pago** a nombre de «Embajada Ecuador», con **2.314 créditos hasta el 26/11/2026**, compartidos por consulares y TEINVITO.
- **Dominios autenticados:** `consulado.app` y `embajada.app`. **veryfacil.org no está autenticado.**
- **Remitentes:** `avisos@consulado.app`, `invitaciones@embajada.app` y una dirección personal. Mesada **no debe** usar ninguno: los correos familiares no pueden salir con la identidad de la Embajada.
- **Cupo:** TEINVITO lleva la cuenta en su propia base (`provider_usage`, 300 al día), así que **no vería lo que envíe Mesada**. Mesada tendrá su propio tope mensual (100 por defecto) y usará el correo solo para lo importante.
- **veryfacil.org en dos proveedores:** el dominio ya envía con Resend (firmador). Autenticarlo también en Brevo es compatible si se hace **solo añadiendo** registros: el código `brevo-code` y los CNAME de DKIM `brevo1/brevo2._domainkey`. No se cambian los de Resend (`resend._domainkey` y el subdominio `send.`) ni el DMARC existente. Si hubiera un SPF en la raíz, se le añade `include:spf.brevo.com` y no se sustituye.
- **Alternativa sin tocar DNS:** el módulo de notificaciones envía por **SMTP genérico**, así que también puede usar el relé SMTP de Resend (`smtp.resend.com`) con el dominio ya verificado. Cambiar de proveedor es cambiar variables de entorno.
- **Permisos:** la clave API de Brevo da acceso a **toda la cuenta**, incluidos los contactos de las campañas de la Embajada. Por mínimo privilegio, Mesada usará una **clave SMTP** propia del relé (`smtp-relay.brevo.com:587`), que solo envía, se puede revocar por separado y no lee datos.

### Resend (elegido para el correo)

- **Cómo lo usa firmador:** API HTTP `POST https://api.resend.com/emails` con `RESEND_API_KEY` y `RESEND_FROM_EMAIL`, guardadas como secretos de Supabase. Tiene un freno propio en su base (`budgetedFetch`: 500 correos al día y 5.000 cada 30 días) que **no ve los envíos de Mesada**, igual que Mesada no ve los suyos.
- **Mesada:** el mismo API, con `Idempotency-Key` (la clave única del outbox). Si se corta la conexión, el reintento no duplica el correo, porque Resend recuerda la clave 24 horas. Tope propio de 100 correos al mes y el correo solo para lo importante, para no consumir el cupo común.
- **Permisos:** una clave de API **propia** con «Sending access» limitada al dominio veryfacil.org. Solo puede enviar, no lee nada de la cuenta y se revoca sin afectar a firmador. No se reutiliza la de firmador, que además vive en Supabase y no es accesible desde aquí.
- **Plan de la cuenta:** no lo he podido comprobar. El conector de Resend de esta sesión no conecta y el proxy no permite `api.resend.com`. Con el plan gratuito (100 al día y 3.000 al mes) el uso conjunto previsto sigue muy por debajo, pero conviene mirarlo en el panel de Resend.
- **Nota:** TEINVITO también tiene una clave de Resend para su rotación de correo. Si fuera la misma cuenta, el cupo se reparte entre los tres proyectos.

## 4. Decisiones que tiene que tomar el usuario

1. **Uso de recursos institucionales.** El servidor, la cuenta de Brevo y el túnel están asociados a la Embajada y a los consulados, y el servidor guarda datos personales de ciudadanos. Mesada guardará datos de menores. Técnicamente están aislados (redes, bases, claves y usuarios separados), pero conviene confirmar que este uso compartido es aceptable para la institución.
2. **PostgreSQL:** contenedor propio (recomendado) o base y rol propios dentro de `teinvito-postgres`.
3. **Teléfono de WhatsApp** para la instancia `mesada`: tiene que ser uno familiar, no uno institucional.
4. ~~Correo~~ **Decidido: Resend**, como en firmador. Falta crear en Resend una clave de API propia de Mesada («Sending access», dominio veryfacil.org) y guardarla como secreto `RESEND_API_KEY` del repositorio Mesada.
5. **Cloudflare:** confirmar que la zona veryfacil.org está en la misma cuenta que el túnel de consulares y que hay un token con permiso sobre la zona y el túnel. Ver con el script en modo «comprobar», que no cambia nada.
6. Añadir el secreto `ORACLE_SSH_KEY` al repositorio de Mesada. GitHub no permite copiar valores entre repositorios y yo no tengo acceso a ellos.

## 5. Garantías de compatibilidad con TEINVITO

- Nombres propios para todo: proyecto `mesada-prod`, contenedores `mesada-*`, volúmenes `mesada_*`, alias `mesada-app` y ruta `/home/ubuntu/mesada`.
- El despliegue de Mesada **solo lee** `/home/ubuntu/consulares/.env.production`, nunca escribe en él, y no ejecuta comandos sobre otros proyectos. Sin `--remove-orphans`, sin `docker system prune` y con `docker image prune` limitado a imágenes sin etiqueta, como ya hace TEINVITO.
- Evolution: se crea solo una instancia nueva y no se cambian ni el webhook global ni las instancias existentes.
- Brevo: se añaden un dominio, un remitente y una clave SMTP. No se tocan los existentes.
- Cloudflare: se añade una regla de ingress antes de la regla final, con el mismo método que `cloudflare-dominio.py`, sin modificar las demás.
