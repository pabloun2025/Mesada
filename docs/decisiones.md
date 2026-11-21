# Registro de decisiones

Formato: contexto → decisión → consecuencias. Las más recientes van al final.

### D1. Monorepo con API propia y PWA separadas
**Contexto:** el encargo pide React + TypeScript + Tailwind, una API propia, PostgreSQL, autoalojamiento y nada de servicios de pago.
**Decisión:** `server/` (Node 22 + Fastify 5 + `pg` + zod), `web/` (React 19 + Vite + Tailwind 4) y `e2e/` (Playwright). En producción, una sola imagen sirve la API y la PWA compilada.
**Consecuencias:** un solo contenedor de aplicación y sin CORS (mismo origen). No se ha elegido Next.js porque no hace falta SSR en una app privada tras login.

### D2. SQL directo con migraciones numeradas, sin ORM
**Decisión:** archivos `migrations/NNN_*.sql` aplicados en transacción al arrancar (tabla `schema_migrations`). Consultas parametrizadas con `pg`.
**Consecuencias:** control total de bloqueos (`FOR UPDATE`), índices únicos e idempotencia, con menos dependencias. El tipado de las filas es manual.

### D3. Sesiones opacas en cookie httpOnly en lugar de JWT
**Decisión:** token aleatorio guardado como hash en `sessions`, en una cookie `httpOnly` `SameSite=Lax`.
**Consecuencias:** las sesiones se pueden revocar (cambio de PIN, desactivación) y el token nunca es accesible desde JavaScript. Cuesta una consulta por petición, irrelevante para una familia.

### D4. CSRF mediante cabecera personalizada
**Decisión:** las mutaciones requieren `X-Mesada: 1`. No se habilita CORS.
**Consecuencias:** sin tokens CSRF que gestionar. Cualquier cliente propio (scripts, Home Assistant…) debe enviar esa cabecera.

### D5. scrypt de Node en lugar de argon2 o bcrypt
**Decisión:** `crypto.scrypt` nativo (N=16384, r=8, p=1).
**Consecuencias:** cero dependencias nativas que compilar en Alpine o ARM (Raspberry Pi). El formato `scrypt$N$sal$hash` permite subir N en el futuro.

### D6. Libros contables de solo inserción e inmutables
**Contexto:** el encargo exige diferenciar puntos, saldo convertido e importe pagado, con ajustes auditables.
**Decisión:** `points_ledger`, `money_ledger` (cuentas `available` y `savings`) y `payments`. Los saldos son siempre `SUM()`. Unos triggers (migración 002) impiden borrar movimientos o cambiar importes, y el `audit_log` tampoco se puede modificar.
**Consecuencias:** cualquier saldo se puede reconstruir y explicar. Las correcciones son movimientos nuevos con motivo.

### D7. Idempotencia por claves únicas
**Decisión:** columna `idempotency_key UNIQUE` con claves deterministas (`task:<instancia>`, `refund:<canje>`, `settle-pts:<cierre>`) o enviadas por el cliente (`Idempotency-Key` en pagos, ajustes y hucha). Restricción única `(user_id, period_start)` en los cierres.
**Consecuencias:** los reintentos y los dobles toques no duplican dinero ni puntos. Está probado con peticiones concurrentes.

### D8. Ocurrencias materializadas de forma perezosa
**Decisión:** las ocurrencias se generan en una ventana de −7 a +14 días con `INSERT … ON CONFLICT DO NOTHING`, al consultar (con un límite de 1 por minuto y familia) y en un temporizador de 15 minutos. Se usa un índice único con `COALESCE(assignee_id, 0…)`.
**Consecuencias:** sin servicio de cron aparte, y el historial queda fijado aunque se edite la tarea, porque solo se regeneran las futuras pendientes.

### D9. El cierre convierte todo el saldo de puntos, con límite
**Contexto:** había que elegir entre convertir solo lo ganado en el periodo o el saldo disponible.
**Decisión:** se convierte el saldo de puntos disponible (ya descontados los canjes reservados), hasta el límite del periodo. Lo que sobra se queda en puntos.
**Consecuencias:** es sencillo de explicar («tus puntos se convierten el lunes») y los canjes compiten con la paga, lo que es educativo. Limitación: no se pueden «guardar puntos» indefinidamente para una recompensa grande. Esa necesidad la cubre la hucha en euros. Ver pendiente P6.

### D10. Diseño propio, sin copiar referencias
**Contexto:** la investigación (`research/investigacion.md`) muestra que Nipto usa morado y menta, una mascota dinosaurio y moneda «huevos/gemas».
**Decisión:** paleta marino/mandarina/hoja, Bricolage Grotesque + Atkinson Hyperlegible autoalojadas, sin mascota, con el «anillo de la semana» con canto de moneda como elemento propio. Las cifras de Bricolage sustituyen al cero con barra de Atkinson mediante `unicode-range`.
**Consecuencias:** una estética que no resulta infantil para 11 y 14 años y que se diferencia de las referencias. Replica se ha usado solo como herramienta de captura y análisis, no para reconstruir interfaces ajenas.

### D11. Racha que perdona los días sin tareas
**Decisión:** idea tomada de KidTask. Un día sin tareas asignadas no rompe la racha.
**Consecuencias:** un fin de semana fuera no penaliza.

### D12. La clasificación entre hermanos es opcional
**Decisión:** viene activada, pero se puede desactivar por familia. El progreso principal se mide contra el objetivo semanal propio.
**Consecuencias:** cada familia decide si quiere competición.

### D13. El service worker nunca cachea la API
**Decisión:** `NetworkOnly` para `/api/*` y precacheo de la interfaz.
**Consecuencias:** la app se instala y abre sin red, pero los saldos y las acciones requieren conexión: nunca se muestra un saldo obsoleto como si fuera actual.

### D14. Avisos de `npm audit` en dependencias de compilación
**Contexto:** `vite-plugin-pwa → workbox-build → glob/minimatch` tiene 4 avisos moderados.
**Decisión:** se aceptan, porque solo se usan al compilar en la máquina de build y no se incluyen en el bundle ni en la imagen final.
**Consecuencias:** revisarlo cuando salga una versión corregida (P9).

### D15. Bloqueo por cuenta además del límite por IP
**Contexto:** un PIN de 4 dígitos tiene 10 000 combinaciones, y el límite por IP no frena un ataque distribuido.
**Decisión:** 5 fallos en 15 minutos bloquean esa cuenta 15 minutos. Se desbloquea al cambiar el PIN.
**Consecuencias:** el estado vive en memoria (se pierde al reiniciar, lo que es aceptable con una sola instancia).

### D17. Reutilizar la infraestructura de TEINVITO con aislamiento
**Contexto:** el usuario pide no duplicar servicios. El análisis está en `infraestructura-compartida.md`.
**Decisión:** misma VM de Oracle, mismo túnel de Cloudflare (`mesada.veryfacil.org`), mismo servidor de Evolution API y misma cuenta de Brevo. El proyecto Compose (`mesada-prod`), la base, los usuarios, las sesiones y el repositorio son propios. La app se une a la red de consulares solo con un alias propio.
**Consecuencias:** ninguna máquina, túnel ni certificado nuevos. El despliegue no lee ni escribe la configuración de otros proyectos, salvo el alta única de la instancia de WhatsApp, que es manual.

### D18. PostgreSQL en contenedor propio, no dentro de `teinvito-postgres`
**Contexto:** se pidió reutilizar el servidor de base de datos «cuando resulte adecuado».
**Decisión:** contenedor propio ligero (512 MB como máximo).
**Consecuencias:** es el patrón del servidor (TEINVITO tampoco comparte el de consulares). Compartirlo exigiría crear roles en la base de producción de TEINVITO **y** unir Mesada a la red interna de TEINVITO, que expone su app. Se acoplarían reinicios, versiones y restauraciones. El coste de tenerlo aparte es mínimo y sin gasto. Cambiarlo es solo cambiar `DATABASE_URL`.

### D19. WhatsApp: instancia propia con token de instancia
**Contexto:** Evolution API (Baileys) es no oficial, y la clave global controla todas las líneas, incluidas las institucionales.
**Decisión:** instancia `mesada` vinculada a un teléfono de la familia. Mesada solo guarda el **token de su instancia**; la clave global se usa una vez en el servidor (`deploy/setup-whatsapp.sh`) y no se copia. No hay webhook (solo envío) y se aplican el tope diario y la pausa entre mensajes.
**Consecuencias:** mínimo privilegio. Que Evolution v2.3.7 acepte el token de instancia en `sendText` **se verifica en la prueba controlada** antes de activar el envío real.

### D20. Correo por Resend, como firmador (actualizada el 21/11 por decisión del usuario)
**Contexto:** veryfacil.org ya envía con Resend desde firmador. La clave API de Brevo da acceso a toda la cuenta institucional.
**Decisión:** `ResendEmailProvider` (API HTTP, sin dependencias) con `Idempotency-Key`, una clave propia de Mesada limitada a envío en veryfacil.org y el remitente `mesada@veryfacil.org`. Se conserva un `SmtpEmailProvider` genérico (`nodemailer`) para cambiar de proveedor (Brevo u otro) con `EMAIL_PROVIDER=smtp`.
**Consecuencias:** sin cambios de DNS ni en Brevo. Los cortes de red se pueden reintentar sin duplicar correos. Tope mensual propio, porque el freno de firmador no ve estos envíos.

### D21. Outbox transaccional y deduplicación en la base de datos
**Decisión:** los avisos externos se escriben en `notification_outbox` dentro de la transacción de la acción, con `dedupe_key UNIQUE`. Un worker los envía después. Los resultados inciertos no se reintentan.
**Consecuencias:** ningún aviso por acciones que fallan, ningún duplicado por reintentos o carreras, y trazabilidad de cada envío.

### D16. Imagen Docker multi-etapa, sin root
**Decisión:** compilar la web y la API en etapas separadas y dejar una imagen final `node:22-alpine` con el usuario `node`, `HEALTHCHECK`, volúmenes para la base de datos y las fotos, y un servicio de copias con `pg_dump` más las fotos.
**Consecuencias:** basta con `docker compose up -d --build` en un VPS o en un servidor doméstico. El HTTPS lo pone un proxy inverso delante (guía en `despliegue.md`).

### D22. Marca DiploP (21/11, ilustraciones aportadas por el usuario)
**Decisión:** la app se presenta como **DiploP** (logotipo marino y amarillo, campo azul, osito con gorra). El repositorio, el dominio `mesada.veryfacil.org`, la cabecera `X-Mesada` y el remitente `mesada@veryfacil.org` no cambian. Recursos en `web/public/brand/` (logotipo transparente y su versión blanca, ilustraciones apaisada y vertical, osito, osito asomado) e iconos PWA nuevos, recortados del diseño entregado.
**Sistema:** Sol `#FFB800` con texto marino para la acción principal, los puntos y los contadores (contraste ≈ 9:1); Azul DiploP `#1D5FAE` como acento e interacción (el token `tangerine` se conserva por compatibilidad); Marino `#142A5C` para estructura; Hoja para euros. En móvil la cabecera es la franja azul de la marca; en el «Hoy» de los hijos el osito se asoma por el borde, como en el banner; el osito aparece en los estados vacíos de «todo hecho».
**Pendiente:** las ilustraciones vienen de una lámina de 1536×1024 px; con originales a mayor resolución se verían más nítidas en pantallas grandes.

### D23. Administración de la instalación con verificación en dos pasos (21/11)
**Decisión:** una pantalla «Administración» (`/administracion`) solo para adultos con `is_superadmin` (el que creó la primera familia; se puede dar a otro con `deploy/operar.sh admin-dar`). Entrar exige contraseña y, en cada sesión, un código TOTP de una app de autenticación (o un código de recuperación de un solo uso). La verificación caduca a las 12 h; tras 5 códigos fallidos se bloquea 15 min; un código no vale dos veces. El secreto TOTP se guarda cifrado (AES-256-GCM con `SECRET_KEY`) y los códigos de recuperación como hash.
**Qué permite:** ver familias y cuentas (correo enmascarado, última entrada, sesiones), bloquear o desbloquear una familia, poner una contraseña o PIN temporal, desactivar cuentas, cerrar sesiones, abrir o cerrar el registro de familias, pausar todos los envíos (se guardan en cola), estado de envíos, línea de WhatsApp, base de datos y copias. Cada acción queda en `admin_audit`.
**Qué no permite:** ver puntos, dinero, tareas ni pagos de las familias. No se puede bloquear la propia familia ni tocar la propia cuenta.
**Recuperación:** si se pierden el móvil y los códigos, `deploy/operar.sh admin-quitar-2fa USUARIO` por SSH (con terminal, nunca desde Actions).

### D24. WhatsApp en los perfiles (21/11)
**Decisión:** cada adulto pone su número en «Mi perfil» (con consentimiento); los padres ponen el de los hijos al editarlos en «Familia». Los avisos para validar tareas y premios salen por WhatsApp a todos los adultos con número. Los hijos no ven los números de los adultos. A los menores de 13 años nunca se les envía WhatsApp.

### D25. Hora límite con valor según la hora (21/11, idea I1)
**Decisión:** cada tarea tiene `due_time` (L–V) y `due_time_weekend` (S–D y festivos; vacío = la de L–V) y `late_percent` (100 = sin rebaja). Cuenta el instante en que el hijo pulsa «Hecha»: se guardan `deadline_at` y `on_time` en la ocurrencia y los puntos se rebajan en ese momento (`round(puntos·%/100)`), así que el adulto aprueba ya el valor reducido (aún puede editarlo). Hasta las 00:00 locales del día siguiente se puede hacer con el % de tarde; después, caduca como siempre. Los festivos van en `family_holidays` (Ajustes). La hora se convierte con la zona de la familia, también en los cambios de hora. El aviso previo reutiliza `due_soon_minutes` y la hora del día (fin de semana o festivo), con clave de deduplicación por ocurrencia.
**Consecuencias:** si el adulto añade un festivo después, la hora mostrada se recalcula al vuelo; la ya completada conserva la de entonces. Tras un «repasar», quien ya llegó a tiempo no pierde valor.

### D26. Bonos y minutos de pantalla (21/11, idea I2)
**Decisión:** bono por tarea (puntos, minutos, texto o recompensa) en columnas `bonus_*`; se concede al aprobar (también en autoaprobación) y se guarda una copia en `bonus_grants` (una por ocurrencia). Visible: cada vez. Sorpresa: una sola vez por (tarea, hijo) con `bonus_claims`; la API de hijos nunca envía su contenido antes de ganarla, y el aviso tampoco lo desvela. «Solo a tiempo» por tarea: si llega tarde no hay bono ni se gasta la sorpresa. Los minutos tienen su libro `screen_ledger`, separado de puntos y euros; un disparador de la base impide saldos negativos y los movimientos negativos se recortan al saldo con el hijo bloqueado.
**Recompensa del catálogo:** se representa como concesión pendiente (`bonus_grants`, botón «Cumplido»), igual que el texto, y no como un canje a 0 puntos: así no ensucia los canjes, las insignias ni la pantalla de premios del hijo, y los adultos tienen una sola lista de «pendiente de cumplir».

### D27. Tareas que marca un adulto con penalización de pantalla (21/11, idea I3)
**Decisión:** `check_mode` (no compartidas). El adulto marca con `POST /api/instances/:id/check`; el hijo recibe 403 y tampoco puede completarla. «Cumplida» = `approved` (puntos, `success_minutes` y bono); «No cumplida» = `expired` con nota y resta `penalty_minutes` recortados al saldo, sin tocar puntos ni dinero. Es idempotente y corregible: la instancia guarda `check_met`, el nº de decisiones y los minutos realmente restados; pasar a «Cumplida» devuelve exactamente esos minutos (`refund`) y concede; pasar a «No cumplida» compensa con ajustes (`adjustment`), anula el bono y aplica la penalización. Las no cumplidas no cuentan como «vencidas» por revisar, ni entran en los recordatorios.
**Consecuencias:** si los puntos ya se habían convertido en euros, la corrección puede dejar el saldo de puntos por debajo de 0 (el cierre usa max(0)).
