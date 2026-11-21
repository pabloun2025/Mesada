# Especificación funcional — Mesada

Versión 0.1 · 20/11/2026 · Estado: **implementado y probado** salvo lo marcado como *pendiente* (ver `pendientes.md`).

## 1. Objetivo

PWA familiar autoalojada para organizar las tareas de casa, motivar a los hijos con puntos y gamificación, y gestionar la mesada (paga) de forma transparente, separando siempre **puntos obtenidos**, **saldo convertido en euros** e **importe realmente pagado**.

Familia de referencia: 2 adultos administradores y 2 hijos (11 y 14 años). Se puede ampliar a más miembros y a varias familias por instalación (`ALLOW_REGISTRATION`).

## 2. Roles y permisos (siempre comprobados en el servidor)

| Acción | Adulto | Hijo |
|---|---|---|
| Crear la familia (primer arranque) | ✔ | — |
| Añadir, editar o desactivar miembros; cambiar PIN o contraseña de otros | ✔ | — |
| Crear, editar y archivar tareas | ✔ | — |
| Ver tareas | todas | solo las suyas y las compartidas en las que participa |
| Marcar una tarea como hecha | ✔ (dar por hecha) | solo si está asignada a él o ella, el día toca y no ha vencido |
| Aprobar o rechazar tareas y ajustar sus puntos | ✔ | ✘ |
| Ajustes de puntos o euros (con motivo obligatorio) | ✔ | ✘ |
| Cerrar periodo (convertir a €) y registrar pagos | ✔ | ✘ |
| Crear recompensas / aprobar canjes | ✔ | ✘ |
| Pedir recompensas | — | ✔ |
| Ver monedero, movimientos y progreso | de todos los hijos | solo los suyos |
| Pasar dinero a la hucha | ✔ | ✔ (solo meter, no sacar) |
| Ver el historial de auditoría y las estadísticas familiares | ✔ | ✘ (sus propias estadísticas sí) |
| Ver fotos de evidencia | ✔ | solo las que ha subido |

Los datos de una familia nunca son visibles ni modificables desde otra: todas las consultas filtran por `family_id` y hay pruebas automáticas de aislamiento.

## 3. Autenticación

- Adultos: usuario y contraseña (8 caracteres como mínimo). Hijos: usuario y PIN (4 como mínimo) creados por un adulto, sin email.
- Sesión con token opaco aleatorio de 256 bits, guardado como hash SHA-256 en la base de datos, en una cookie `httpOnly` `SameSite=Lax` (`Secure` con HTTPS). Caduca a los 30 días (configurable).
- Contraseñas con scrypt (N=16384, sal aleatoria) y comparación en tiempo constante, también cuando el usuario no existe.
- Límites: 10 intentos por minuto e IP, y **bloqueo de la cuenta 15 minutos tras 5 fallos** aunque cambie la IP. Si un adulto cambia el PIN, la cuenta se desbloquea.
- Cambiar la contraseña o desactivar una cuenta cierra sus sesiones.
- Protección CSRF: toda mutación exige la cabecera `X-Mesada: 1`, que un sitio ajeno no puede enviar sin CORS.

## 4. Tareas

- **Campos:** título, descripción, icono (emoji), dificultad (fácil, media o difícil, que sugiere 10/20/40 puntos editables), puntos, recurrencia, fechas de inicio y fin, hora límite opcional, asignados, modo de reparto, «necesita validación» y «pedir foto».
- **Recurrencia:**
  - *Una vez*: en la fecha indicada.
  - *Diaria*: todos los días o solo los días de la semana elegidos.
  - *Semanal*: los días de la semana elegidos (al menos uno).
  - *Mensual*: un día del mes. Si el mes es más corto, el último día (31 → 28/30).
- **Reparto:**
  - *Individual*: una ocurrencia por cada asignado.
  - *Compartida*: una sola ocurrencia, y la primera persona que la marca se lleva los puntos (protegido con bloqueo de fila).
  - *Por turnos*: rotación determinista en el orden elegido, según el número de ocurrencias previas.
- **Ocurrencias:** se materializan de forma idempotente (índice único por tarea, fecha y persona) en una ventana de −7 a +14 días, al consultar y cada 15 minutos. Las pendientes de días pasados pasan a **vencidas**. Un hijo no puede marcar una vencida, pero un adulto sí puede darla por hecha.
- **Estados:** pendiente → enviada (si necesita validación) → aprobada / necesita repaso (rechazada, con nota) → reenviada. Si no necesita validación, se aprueba al marcarla.
- **Editar una tarea** regenera solo las ocurrencias futuras pendientes y conserva el historial. Archivar elimina las futuras pendientes.
- **Foto de evidencia:** JPG, PNG o WebP de hasta 6 MB, guardada fuera de la carpeta pública con permisos 600 y servida solo a los adultos de la familia o a quien la subió.

## 5. Puntos, mesada y recompensas

Tres magnitudes separadas, cada una con su libro de movimientos de solo inserción (inmutable también en la base de datos mediante triggers):

1. **Puntos** (`points_ledger`): tareas (+), extras (+), ajustes (±), canjes (−), devoluciones (+) y conversiones (−).
2. **Euros convertidos** (`money_ledger`, cuenta `available` o `savings`): conversiones (+), pagos (−), ajustes (±) y traspasos a la hucha.
3. **Pagos reales** (`payments`): importe, forma de pago (efectivo, Bizum, transferencia u otra), quién pagó y nota. No hay pasarela: se registra lo que se entrega.

- **Equivalencia** configurable por familia: `X puntos = Y €` (por defecto 100 pts = 5 €). Siempre se redondea hacia abajo al céntimo.
- **Cierre** semanal (lunes a domingo) o mensual: convierte el saldo de puntos disponible de cada hijo en euros. Con un **límite por periodo** activado, se convierte como máximo ese importe y el resto se queda en puntos. **Un solo cierre por hijo y periodo** (restricción única). Por defecto se cierra el periodo anterior completo.
- **Canjes:** el hijo pide una recompensa, los puntos se reservan al momento (no puede gastar dos veces) y, si se rechaza, se devuelven. Estados: pedida → aprobada → entregada, o rechazada.
- **Hucha y metas:** el hijo puede mover saldo convertido a la hucha y crear metas con barra de progreso. Para sacar dinero de la hucha hace falta un adulto.
- **Idempotencia:** pagos, ajustes y traspasos aceptan la cabecera `Idempotency-Key`. La interfaz genera una por formulario, de modo que un doble toque o un reintento por red no duplica. Las aprobaciones y los canjes son idempotentes por diseño (clave `task:<id>`, `refund:<id>`).
- **Concurrencia:** las operaciones de saldo bloquean la fila del usuario (`SELECT … FOR UPDATE`). Hay pruebas de aprobaciones y canjes simultáneos.
- **Potencial del periodo:** «Si lo haces todo, esta semana puedes ganar X €», junto con lo ganado, lo que espera validación y lo perdido.

## 6. Gamificación

- **Niveles** según los puntos ganados de por vida: el nivel *n* requiere 25·(n−1)² puntos. Títulos: Novato, Aprendiz, Colaborador, Constante, Fiable, Experto, Crack, Maestro, Referente y Leyenda.
- **Racha:** días seguidos con al menos una tarea hecha. Los días sin tareas asignadas son neutros y hoy solo suma cuando ya hay algo hecho.
- **Insignias (10):** primera tarea, 10/50/100 tareas, rachas de 3/7/30 días, objetivo semanal, primera recompensa y 10 € ahorrados.
- **Objetivo semanal** por hijo, mostrado en el anillo de la semana.
- **Clasificación familiar** semanal, **desactivable** por la familia.
- **Celebración discreta** al completar (el check se rellena y los puntos suben), desactivable y respetando `prefers-reduced-motion`.

## 7. Panel parental y estadísticas

- Tres cifras: por validar, € ganados esta semana y pendiente de pagar.
- Tarjeta por hijo: anillo semanal, racha, progreso de hoy, puntos, por pagar y hucha.
- Validación rápida (aprobar o devolver con nota, ajustar puntos, ver foto) y recompensas pedidas.
- Tareas de hoy de toda la familia y actividad reciente.
- Estadísticas: barras por semana (8) o mes (6) y por hijo, más una tabla con los totales (ganado, convertido, pagado y racha).
- Historial completo e inmutable de acciones (auditoría).

## 8. Notificaciones (módulo común multicanal)

- **Canales:** en la aplicación (campana, siempre), **correo** (SMTP genérico: relé de Brevo con clave propia, o Resend) y **WhatsApp** (Evolution API, con una instancia propia de Mesada en el servidor compartido). *Pendiente:* Web Push.
- **Eventos (12):** nueva tarea asignada, recordatorio diario, tarea a punto de vencer, tarea enviada para validar (adultos), aprobada (con puntos), devuelta para repasar, ajuste de puntos, recompensa pedida (adultos), recompensa decidida, cierre de mesada, pago registrado e insignia. Cada evento tiene canales por defecto, pensados para ahorrar el cupo de correo: lo frecuente va por WhatsApp y el correo se reserva para lo importante.
- **Preferencias:** por persona, evento y canal. **Solo los adultos** las cambian: las suyas y las de los hijos, nunca las de otro adulto. Los hijos las ven en solo lectura. Datos de contacto (correo de los adultos, teléfono y consentimiento de WhatsApp) gestionados por un adulto.
- **Reglas de protección:** WhatsApp solo con teléfono, consentimiento registrado y **13 años como mínimo** (condiciones de WhatsApp en la UE). Con solo el año de nacimiento se toma la edad mínima posible, y sin año no hay WhatsApp. El correo solo se usa para adultos.
- **Recordatorios configurables por familia:** hora del recordatorio diario, aviso X minutos antes de la hora límite y **horario de silencio** (lo que se genere durante el silencio espera a que termine, salvo los correos críticos).
- **Sin duplicados:** cada aviso tiene una clave única por canal (`reminder:<hijo>:<fecha>`, `duesoon:<ocurrencia>:<hijo>`, `approved:<ocurrencia>`…). La base de datos impide repetirlo aunque el programador corra varias veces o haya varias instancias.
- **Outbox transaccional:** el aviso se encola en la misma transacción que la acción. Si la acción falla (por ejemplo, una aprobación duplicada), no sale nada.
- **Envío:** un worker procesa la cola cada 30 s con `FOR UPDATE SKIP LOCKED`. Los fallos temporales se reintentan con espera creciente (hasta 5 intentos). Un resultado **incierto** (tiempo agotado tras enviar) no se reintenta, para no duplicar; queda marcado. Topes de la instalación: 100 correos al mes y 40 WhatsApp al día (configurables), con 4 s como mínimo entre WhatsApp.
- **Modo simulado por defecto** (`NOTIFY_REAL_SEND=false`): los avisos se registran y se ven en «Últimos envíos», pero no salen. Las pruebas usan siempre proveedores simulados.
- **Recuperar la contraseña** (adultos con correo): enlace de un solo uso, válido 30 minutos. La respuesta es la misma exista o no la cuenta, y cambiarla cierra todas las sesiones. Los hijos recuperan el PIN a través de un adulto.
- **Invitar a otro adulto por correo:** enlace válido 7 días y de un solo uso, con el que crea su usuario y queda dentro de la familia.

## 9. Experiencia de usuario

- En español de España, € con `Intl.NumberFormat('es-ES')` y fechas con `Intl.DateTimeFormat`.
- Responsive y pensada primero para móvil: barra inferior en el teléfono y raíl lateral en escritorio. Modo claro y oscuro sin parpadeo.
- PWA instalable: manifest, iconos (también *maskable*) y un service worker que precachea la interfaz y **nunca cachea la API**, para que los saldos vengan siempre del servidor.
- Accesibilidad: foco visible, enlace «Saltar al contenido», etiquetas en todos los controles, `aria-live` en los avisos, objetivos táctiles de 44 px como mínimo y tipografía Atkinson Hyperlegible.

## 10. Datos de demostración

`npm run seed` (en `server/`) crea la Familia García con Ana y Carlos (`demo-mesada`), Lucía (PIN `1414`) y Hugo (PIN `1111`), 9 tareas, 5 recompensas y 3 semanas de historial.
