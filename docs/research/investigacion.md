# Investigación de aplicaciones de referencia

Fecha: 20/11/2026. Herramienta: `agent-browser` 0.43 (Chromium headless) desde el entorno en la nube.

## 0. Acceso a las webs: diagnóstico

| Comprobación | Resultado |
|---|---|
| `getent hosts nipto.app` dentro del contenedor | Falla. Es normal: en este entorno la resolución DNS la hace el proxy de salida, no el contenedor. `github.com` sí resolvía porque estaba permitido. |
| `curl -v https://nipto.app/es` | El proxy responde `403 Forbidden (agent proxy: no rule or network setting allows this host)` |
| Conclusión | **No era DNS ni conectividad**: la política de red del entorno (modo *Limited*) no permitía esos hosts. Un navegador no lo habría resuelto. |
| Solución aplicada | Con aprobación del usuario se añadieron al entorno «CNE» los hosts permitidos `nipto.app`, `www.nipto.app`, `play.nipto.app`, `kidtask.app`, `www.kidtask.app`, `growtide.app`, `www.growtide.app`, `homeyapp.net` y `www.homeyapp.net`. Después, agent-browser abrió las cuatro webs. |

Límites que siguen existiendo:
- **play.nipto.app** carga, pero tras la presentación pide cuenta («Continue with Google / Email / invite code»). **No se ha creado ninguna cuenta** porque no hay una autorizada. Las pantallas internas de la app (panel, creación de tareas, ajustes) **no se han inspeccionado**.
- **KidTask** ofrece «Empieza gratis en el navegador», que también requiere registro. Tampoco se ha probado por dentro.
- **GrowTide** y **Homey** solo tienen app móvil. Lo analizado es su web pública y las maquetas de pantallas que muestran.

Capturas guardadas en `docs/research/capturas/`.

## 1. Fuentes y nivel de verificación

- **[V] Verificado**: observado directamente en la web pública o en la parte pública de la app con agent-browser (texto extraído y capturas).
- **[S] Secundario**: afirmado por el propio fabricante en su web de marketing o mostrado en maquetas. No se ha probado en la app.
- **[P] Propuesta**: decisión propia para Mesada.

## 2. Nipto (referencia principal)

**Posicionamiento [V]:** tareas del hogar como juego para familias, parejas y pisos compartidos. Disponible en iOS, Android y la web `play.nipto.app`, en 10 idiomas.

| Área | Lo observado |
|---|---|
| Unidad de puntos | «Huevos» por tarea, de 5 a 100 según el esfuerzo [S]. Las tarjetas de tarea muestran icono emoji, título, recurrencia y la píldora «+20» [V, captura]. |
| Perfiles | «¿Quién juega?»: varios miembros en un mismo dispositivo. Los niños sin móvil son «miembros gestionados» y el perfil adulto tiene PIN [V]. |
| Roles | Admins que invitan, gestionan a los miembros y validan peticiones. Invitaciones por QR, código o enlace [S]. |
| Calendario y recurrencia | Días fijos cada 1 a 4 semanas, días del mes o «repetición inteligente» (unos días después de la última vez), con aviso a una hora elegida. Vista semanal LU–DO [V, texto]. 5 planificaciones gratis [S]. |
| Rotación | «Por turnos»: rota según quién la hizo la última vez [S]. Ejemplo: «Cada Lu, Ju · 20:00 · Turno de Marta» [V]. |
| Aprobación | Control parental (Premium): lo que marcan los niños espera el visto bueno antes de sumar [S]. |
| Gamificación | «Carrera de la semana» con tres niveles (Nipti, Niptodon a partir del 50 % de la mejor puntuación, Niptorex a partir del 90 %). Los niños compiten contra su propio objetivo y cada semana empieza de cero [V]. Rachas con bonus a los 3, 7 y 30 días y una «pausa» que conserva la racha [V]. «Gracias con corazones»: hasta 5 puntos extra [S]. |
| Recompensas | Al cierre semanal, los huevos se convierten en gemas (100 huevos = 1 gema, más bonus por nivel y racha). Las gemas se canjean por recompensas que decide la familia, con aprobación parental opcional [V]. |
| Dinero | **No hay conversión a euros ni gestión de paga**. La moneda final son gemas para recompensas. |
| Resumen semanal | Pantalla de resumen: huevos ganados, nivel, racha y gemas obtenidas [V]. |
| Estadísticas | Semanas pasadas y estadísticas mensuales (Premium) [S]. |
| Notificaciones | Avisos a la hora elegida, widgets «Tareas de hoy» y «Mi nivel», Siri y Home Assistant [S]. |
| Estilo visual | Fondo claro, morado como color de acción (botones en píldora), verde menta en los acentos de puntos, tipografía redondeada muy gruesa en los titulares, tarjetas blancas con sombra suave y esquinas muy redondeadas, y una mascota dinosaurio ilustrada. Tiene modo oscuro (botón luna) [V, captura]. |

## 3. KidTask

[S] salvo indicación. Web en español verificada [V].
- Acceso infantil con un **código, sin email**. Los padres aprueban con un toque, de forma automática o manual.
- Tareas únicas o recurrentes (diaria, semanal, mensual), para un niño o para todos.
- **Puntos y «dinero virtual» en carteras separadas** que nunca se convierten entre sí para inflar récords. Conversión a dinero real **bajo petición** del niño, con aprobación parental.
- **Presupuesto mensual**: cuánto vale el mes si se hace todo, cuánto se ha ganado y cuánto se ha dejado escapar. La maqueta muestra «Ganado / Perdido / Máximo» y barras diarias [V, captura].
- Insignias **sin ranking entre hermanos**: récords personales, primeras veces y hábitos. Diploma imprimible.
- **Rachas que perdonan**: un día sin tareas asignadas no cuenta ni rompe la racha.
- Copadres con permisos a medida.
- Navegación inferior en la maqueta: Mis tareas · Mi cartera · Recompensas · Insignias [V, captura].

## 4. GrowTide

[S] salvo indicación.
- Monedas, mesada y tiempo de pantalla como recompensas. Aprobación con foto (Pro) desde la notificación y aprobación en bloque.
- 12 rangos, 31 avatares, insignias y clasificación semanal entre hermanos.
- Apartados **Ahorrar, Gastar y Donar**. Mesada automática por tarea o por calendario. Intereses del ahorro configurables. «GrowTide nunca mueve dinero».
- Vinculación del dispositivo del niño con un código de un solo uso y una vista infantil separada.
- Panel parental (maqueta [V]): una tarjeta por hijo con progreso de hoy (7/11), rango, racha 🔥, monedas, saldo y minutos, insignia «1 pendiente» y botón flotante. Barra inferior: Inicio · Tareas · Aprobar (con contador) · Premios · Tienda.
- Más de 40 plantillas de tareas.

## 5. Homey

[S] Web en inglés de 2017 [V]. Enfoque de educación financiera: tareas recurrentes diarias, semanales o mensuales, tareas pagadas frente a responsabilidades, metas de ahorro a largo plazo y «cuenta de ahorro». Pagos tras confirmación visual (foto).

## 6. Comparación funcional

| Función | Nipto | KidTask | GrowTide | Homey | **Mesada [P]** |
|---|---|---|---|---|---|
| Panel parental por hijo | ? (no visto) | sí [S] | sí [V maqueta] | sí [S] | **Sí**: tarjetas por hijo, por validar, € de la semana y saldo |
| Acceso infantil sin email | PIN/gestionado | código | código único | ? | **Usuario + PIN** creado por un adulto |
| Recurrencia diaria, semanal o mensual | sí + inteligente | sí | sí | sí | **Sí**, con días concretos y día del mes |
| Rotación entre hermanos | sí (según la última vez) | ? | ? | ? | **Sí**: rotación secuencial determinista |
| Compartida (la primera persona en hacerla) | sí | «para todos» | ? | ? | **Sí** |
| Aprobación parental | Premium | sí | sí | sí | **Sí**, configurable por tarea |
| Foto de evidencia | no visto | ? | Pro | sí | **Sí**, privada y solo visible para la familia |
| Puntos → dinero | **no** (gemas) | bajo petición | mesada | sí | **Cierre semanal o mensual con tasa y límite configurables** |
| Registro de pagos reales | no | entrega real | registro | sí | **Sí**, con método, idempotencia y auditoría |
| Recompensas no monetarias | sí | sí | sí | sí | **Sí**, con aprobación |
| Ahorro / metas | no | récords | Ahorrar, Gastar y Donar | metas | **Hucha + metas de ahorro** |
| Rachas | 3/7/30 + pausa | perdonan días sin tareas | sí | ? | **Perdonan días sin tareas asignadas** (idea de KidTask) |
| Ranking | carrera semanal | **no** (a propósito) | sí | ? | **Desactivable por familia**; por defecto, progreso contra el objetivo propio |
| Niveles | 3 semanales | insignias | 12 rangos | ? | **Niveles por puntos de por vida + insignias** |
| Potencial del periodo | no | presupuesto mensual | ? | ? | **Sí**: «si lo haces todo, esta semana ganas X €» |
| Auditoría | ? | ? | ? | ? | **Registro completo de puntos, dinero y acciones de adultos** |
| Autoalojable | no | no | no | no | **Sí** (Docker) |

## 7. Decisiones que salen de la investigación

1. **Puntos y euros siempre separados en la interfaz**, con tres cifras distintas: puntos disponibles, saldo convertido pendiente de pago e importe ya pagado (alineado con KidTask y con el encargo).
2. **Rachas que perdonan** los días sin tareas asignadas.
3. **El ranking entre hermanos es opcional.** Por defecto se muestra el progreso contra el objetivo semanal propio (la idea de Nipto de «los niños compiten contra su propio objetivo»).
4. **Resumen del periodo** al hacer el cierre: puntos, € convertidos y si se aplicó el límite.
5. **Bonus de agradecimiento** (como los corazones de Nipto) mediante ajustes positivos con motivo, auditados.
6. **Estética propia**: nada de mascotas ni de huevos/gemas. Para no infantilizar a chicos de 11 y 14 años, interfaz tipo «app financiera juvenil»: tipografía geométrica, acento verde azulado y ámbar, iconos lineales y emoji solo como icono de tarea elegido por la familia.
7. **Propuestas para más adelante**: rotación según quién la hizo la última vez, repetición «X días después de la última vez», plantillas de tareas, notificaciones push (Web Push con VAPID, sin servicios de pago) e intereses del ahorro.
