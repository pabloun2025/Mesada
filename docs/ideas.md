# Ideas del usuario (en recogida, sin construir)

Estado: I1–I3 construidas; las nuevas ideas se recogen aquí antes de programarlas.

**Cómo se construirá:** cuando el usuario lo pida, el código lo escribe un agente con el modelo Sonnet. Claude lo supervisa: le da el plan, revisa lo que hace, ejecuta las pruebas y corrige antes de publicar.

## I1. Hora límite con valor según la hora (21/11)
**Estado: construida (ver D25).**
- Algunas tareas tienen una hora límite para hacerlas y reportarlas.
  - Ejemplo, tender la cama: antes de las 9:00 de lunes a viernes, o de las 12:00 el fin de semana.
- **Decidido:**
  - Dos horas por tarea: una para los días laborables (L–V) y otra para el fin de semana (S–D).
  - Pasada la hora, la tarea vale un % de los puntos que elige el padre en cada tarea (50 %, 25 %, 0 %…).
  - Cuenta la hora en que el hijo pulsa «Hecha», aunque el adulto valide después.
  - Hay plazo hasta las 23:59 con el % de tarde; después la tarea caduca sin puntos.
  - Los festivos y las vacaciones que el padre marque en un calendario usan la hora del fin de semana.
  - El hijo ve la hora y una cuenta atrás («Antes de las 9:00 · quedan 25 min»). Cuando pasa la hora, ve bajar los puntos.
  - Aviso al hijo un rato antes (p. ej., 15 min):
    - en la app;
    - por WhatsApp si tiene 13 años o más.
- Se configura en Tareas.

## I2. Bonos extra en tareas (21/11)
**Estado: construida (ver D26).**
- Algunas tareas dan un bono además de los puntos.
  - El bono puede verse desde el principio o quedar oculto como sorpresa.
- **Decidido:**
  - Tiempo de pantalla:
    - lleva su propio saldo de minutos, aparte de los puntos;
    - el hijo lo gasta y el padre lo descuenta.
  - El bono puede ser:
    - puntos extra;
    - minutos de pantalla;
    - un texto libre (p. ej., «helado el sábado»), que el padre cumple a mano;
    - una recompensa del catálogo, gratis.
  - Sorpresa:
    - el hijo ve «🎁 Sorpresa» en la tarea;
    - se revela con una animación cuando el adulto la aprueba.
  - En cada tarea, el padre elige si el bono se gana solo a tiempo o siempre.
  - El bono visible se gana cada vez que completa la tarea, como los puntos.
  - La sorpresa se gana una sola vez, la primera vez que completa la tarea; después la tarea sigue normal.

## I3. Penalización de minutos de pantalla (21/11)
**Estado: construida (ver D27).**
- Algunas tareas no cumplidas a tiempo restan minutos del saldo de pantalla.
  - Ejemplo: «Estar en el coche a la hora de salida».
- Se configura en cada tarea.
- **Decidido:**
  - El padre marca si se cumplió o no («Cumplida» / «No cumplida»): el hijo no la reporta.
  - Solo resta minutos de pantalla. Los puntos y el dinero no se tocan.
  - La cantidad es fija y la pone el padre en cada tarea (p. ej., −15 min).
  - El saldo no baja de 0: si no quedan minutos, la penalización se pierde.
  - Si el padre marca «Cumplida», en cada tarea elige si gana puntos, minutos o nada. La penalización va aparte.

## I4. Anotar pagos de dinero y de pantalla desde el Panel (21/11)
**Estado: construida (ver D28).**
- Hoy ya existen:
  - «Registrar pago» en Mesada, que descuenta el saldo, guarda la forma de pago y avisa con «Has recibido tu paga»;
  - «Gastar minutos» en Mesada.
- **Decidido:**
  - En el Panel, la tarjeta de cada hijo tiene los botones «Pagar» y «Dar pantalla». Mesada sigue igual.
  - Aviso al hijo con el importe, la forma de pago y el saldo restante, p. ej.: «Mamá te ha pagado 20,00 € en efectivo. Te quedan 0,00 €». También para transferencia y Bizum.
  - Videojuegos y otras pantallas comparten el mismo saldo de minutos. Al gastar se elige en qué (tele, tablet, videojuegos…) y queda en el historial.
  - El hijo puede pedir que le paguen («Pedir mi dinero», «Pedir 30 min de videojuegos»):
    - al adulto le llega para aprobar;
    - al aprobar, se descuenta.
  - El hijo pide el importe que quiera, hasta su saldo.
  - Los minutos de pantalla se descuentan al aprobar (sin temporizador).

## I5. El hijo anota su propio uso de pantalla y gana puntos por ser honesto (21/11)
**Estado: construida (ver D29).**
- **Decidido:**
  - El hijo anota los minutos que usó y en qué: videojuegos, tele, tablet…
  - Gana 5 puntos por registrar honestamente lo jugado ese día: una vez al día, aunque anote varias veces.
  - Los minutos se restan del saldo al momento.
  - Los puntos llegan cuando el padre lo confirma. El padre también puede anularlo.
  - Si anota más de lo que tiene en el saldo:
    - el exceso queda registrado y el saldo se queda en 0;
    - ese día no gana puntos;
    - el padre recibe un aviso.

## I6. Sistema de dinero: canje, retiros, adelantos y préstamos (21/11)
**Estado: construida (21/11), ver D30 y D31.**
- El hijo tiene dos saldos: puntos y dinero.
- **Canje:** el hijo cambia puntos por dinero cuando quiere, él solo.
  - Cuenta para el tope de euros del periodo de la familia.
  - Hay un mínimo de puntos por canje, que pone el padre.
  - El cierre de periodo sigue igual: convierte los puntos que queden.
- **Retiro** (como un cajero): el hijo saca dinero de su saldo.
  - Se avisa al padre, que tiene que pagarlo (efectivo o en su cuenta).
  - Hasta 2 retiros por semana; cada uno puede ser de todo su saldo.
- «Importe semanal» = el tope semanal de euros de la familia.
- **Adelanto:** cambia puntos ya ganados por encima del tope de esta semana, hasta el 50 % del tope de la siguiente.
  - Ejemplo con tope de 10 €: ya cambió 10 €; adelanta 5 € más y la semana siguiente su tope es de 5 €.
  - Es automático, sin aprobación (se avisa al padre).
- **Préstamo:** hasta el 300 % del tope semanal. Lo aprueba el padre.
  - El hijo elige en cuántas semanas lo devuelve.
  - Cada semana se descuenta de su saldo de dinero la cuota (importe ÷ semanas) y 10 puntos de interés.
  - Si no tiene saldo, el saldo queda en negativo: no puede retirar ni pedir otro préstamo hasta volver a positivo.
  - Solo un préstamo a la vez.
- Se relaciona con I4 («Pedir mi dinero» pasaría a ser el retiro).

## I7. Ahorro programado con interés (21/11)
**Estado: construida (21/11), ver D32.**
- La hucha pasa a dar interés: cada meta (algo concreto con un valor) es un ahorro programado.
- El hijo va metiendo dinero de su saldo en la meta.
- Interés semanal: 1 % de lo ahorrado, redondeado al euro de arriba, como mínimo 1 €.
- Puede sacar el dinero antes de la meta: recupera lo que puso, pero pierde el interés ganado.
- Al llegar a la meta, el dinero no pasa a efectivo: se usa para lo de la meta (p. ej., un vinilo).
  - El hijo pulsa «Canjear meta»; el padre paga en la tienda, con el hijo, con ese dinero, y marca «Comprado».
  - Si sobra, vuelve a su cuenta de dinero. Si falta, el padre lo anota y se descuenta del saldo.
  - Sigue ganando interés hasta que se canjea.
  - Pasarlo a su saldo en efectivo solo con permiso de un adulto, y pierde el interés.

### Respuestas extra I6–I7 (21/11)
- Interés del préstamo sin puntos: los puntos quedan en negativo y lo próximo que gane paga primero esa deuda.
- Interés del ahorro: lo pagan los padres, automático cada semana (se suma a la meta y cuenta como dinero que deben).
- Los 2 retiros cuentan de lunes a domingo (el contador vuelve a 0 cada lunes).
- En Ajustes el padre cambia todos los números (2 retiros, 50 %, 300 %, 10 puntos, 1 %) o apaga cada opción.
- **Aspecto:** la pantalla de dinero del hijo tiene que parecer una cuenta de banco.
  - Hijo: tarjeta de cuenta (nombre, número de cuenta de juguete, saldo grande); botones de cajero (Retirar, Canjear puntos, Adelanto, Préstamo, Ahorrar); extracto (fecha, concepto, importe en verde/rojo, saldo tras cada movimiento); productos aparte («Mi préstamo» con cuotas que quedan, «Mis ahorros» con barra hacia la meta e interés ganado).
  - Dos cuentas del mismo banco: «Cuenta de puntos» y «Cuenta de dinero».
  - Los padres también lo ven como un banco: cuentas de cada hijo, retiros, préstamos y lo que deben pagar.

## I8. Aspecto de app de banco moderna (21/11)
**Estado: construida (21/11), ver D33. Maquetas aprobadas en `docs/maquetas/banco/`.**
- Hijo, estilo banco digital:
  - tarjetas que se deslizan (cuenta de dinero y cuenta de puntos);
  - botones redondos con icono debajo (Retirar, Canjear, Adelanto, Préstamo, Ahorrar);
  - extracto con un icono por tipo de movimiento (tarea, canje, retiro, préstamo, interés, compra de meta);
  - recibo de banco al operar (fecha, importe, saldo nuevo);
  - teclado numérico grande para el importe, con botones rápidos (5 €, 10 €, todo);
  - pequeña gráfica del saldo de las últimas semanas.
- Padres, banca para padres: una cuenta por hijo, «Pendiente de pagar» destacado, operaciones por aprobar, préstamos y ahorros como productos.

## I9. Administración sin pedir el código cada vez (21/11)
**Estado: construida (21/11), ver D38.**
- El código de la app de autenticación se pide una sola vez en cada dispositivo (móvil u ordenador).
- Ese dispositivo queda recordado 90 días: en el día a día se entra en Administración sin código.
- En un dispositivo nuevo, o pasados los 90 días, se vuelve a pedir el código.

## I10. Periodicidad «Cuando haga falta» (21/11)
**Estado: construida (21/11), ver D34.**
- Para tareas sin día ni hora fijos, como sacar la basura o descargar el lavaplatos.
- Siempre disponible; se puede hacer una vez al día.
- Si nadie la hace ese día, no pasa nada: no cuenta como fallo, ni en la racha ni en el % cumplido.
- Con varios hijos es compartida: la marca el primero que la hace y se lleva los puntos.

## I11. Tareas extra sin fecha (21/11)
**Estado: construida (21/11), ver D35.**
- Para trabajos ocasionales sin fecha: sacar los hierbajos, limpiar el patio, doblar la ropa…
- Catálogo guardado de tareas extra; el padre activa una cuando hace falta y sale en el tablón «Trabajos extra».
  - Al hacerla y validarla, sale del tablón y vuelve al catálogo para la próxima vez.
- Plazo opcional (p. ej., «antes del domingo»); si no, está disponible hasta que alguien la haga.
- Con varios hijos: el primero que pulsa «Me la pido» se la queda reservada.
- Valen como cualquier tarea (puntos y bonos).

## I12. Imagen nueva en alta y estilo cielo claro (21/11)
**Estado: construida (22/11), ver D40.** Imagen original en `docs/marca/diplop-cielo-2000.webp` (2000×1125).
- La imagen nueva (familia con cielo claro, logo DiploP y tarjeta «Mi mesada») se usa en:
  - la pantalla de entrada (en el móvil, un recorte vertical: familia arriba, logo y tarjeta debajo);
  - la vista previa al compartir el enlace (WhatsApp, redes);
  - una página de bienvenida pública, antes de registrarse.
- Página de bienvenida: cómo funciona (tareas → puntos → dinero o premios), qué hacen los padres, qué hacen los hijos, y botones «Entrar» y «Crear familia» arriba y al final.
- Ideas de la imagen para la app:
  - tarjeta «Mi mesada» en el inicio del hijo: «★ 120 → 6 €»;
  - tres accesos grandes con ✓: Mis tareas, Mis puntos, Mis recompensas;
  - estilo claro de cielo en toda la app (hijos y padres), con el modo oscuro aparte;
  - monedas doradas como adorno al canjear, en el recibo y en la cuenta de dinero.
- El hijo ve cuánto valen sus puntos en euros: en el inicio («120 ★ = 6 €») y en cada tarea («+10 ★ · 0,50 €»).
- Sin maqueta: se programa directo.

## I13. Repetir una tarea en el mismo día (21/11)
**Estado: construida (21/11), ver D36.**
- Opción en cada tarea: «Se puede repetir en el día». Por defecto, no: la mayoría solo se hacen una vez al día.
- Si se puede repetir, el padre pone el máximo de veces (2, 3, 5…) o «sin límite».
- Cada vez da los puntos completos (dos paseos del perro de 10 = 20 puntos).
- Vale para todos los tipos: diarias, de días fijos y «Cuando haga falta».
- Si la tarea es compartida, cualquier hijo puede hacerla hasta llegar al máximo entre todos (máximo 3: Ana 2 veces y Leo 1).

## I14. Días de espera tras hacer una tarea (21/11)
**Estado: construida (21/11), ver D37.**
- Para tareas como sacar la basura: sin fecha fija, pero no se repiten al día siguiente.
- Solo en tareas «Cuando haga falta». El padre pone en cada tarea «Después de hacerla, vuelve en N días» (1, 2, 3, 7…). Sin espera, sigue como hasta ahora.
- Mientras espera, el hijo la ve en gris con «Vuelve el jueves» y no la puede marcar.
- Cuando vuelve y nadie la hace, no pasa nada: no cuenta como fallo.

## I15. Revisar una tarea: parcial, devolver o rechazar (22/11)
**Estado: construida (22/11), ver D39.**
- Al validar una tarea, además de «Aprobar», el adulto puede:
  - **Dar parte del premio:** botones 75 / 50 / 25 % o escribir otra cifra de puntos.
  - **Devolver para que la arregle:** vuelve al hijo; cuenta la hora original (si la marcó a tiempo, sigue a tiempo).
  - **Rechazar sin penalidad:** no gana nada.
  - **Rechazar con penalidad:** resta puntos (por defecto, los de la tarea) y/o minutos de pantalla; la cantidad se pone al rechazar.
- El motivo es obligatorio, con frases rápidas («Falta un poco», «No está hecha», «Mal hecha»…) o texto libre. El hijo lo ve.

## I16. Plan semanal de pantalla, caducidad y «Ajustes de pantalla» (22/11)
**Estado: construida (22/11), ver D43 y D44.**
- **Plan semanal (recarga):** cada hijo tiene su cantidad (p. ej., Ana 5 h, Leo 3 h); se puede apagar para un hijo.
  - Se carga solo cada lunes a las 00:00. Lo que no se usa se pierde el lunes siguiente (vale todo el fin de semana).
- **Minutos ganados en tareas:** caducan el primer lunes después de 30 días (entre 30 y 36 días; siempre pasa un fin de semana).
  - Los minutos que ya hay hoy en el saldo cuentan como ganados el día que se publique.
- **Al gastar:** se descuenta primero lo que caduca antes (normalmente el plan de la semana, luego los ganados más antiguos).
- **«Ajustes de pantalla»** (en vez de penalizaciones, sin sonar a castigo):
  - Motivos escritos en positivo, lo que se busca: «Llegar a tiempo al cole», «Habitación en orden», «Esfuerzo en los estudios», «Respeto en familia». El padre puede crear más.
  - Catálogo con la cantidad típica de cada motivo (−15 min, −30 min, 1 día de pausa), que se puede cambiar al aplicarlo.
  - Puede quitar minutos o poner una **pausa** de uno o varios días:
    - durante la pausa no puede gastar ni pedir minutos (ve «Pausa hasta el jueves»);
    - los minutos no caducan durante la pausa (se alarga su caducidad esos días);
    - sigue ganando minutos con las tareas.
  - Nota opcional y amable para el hijo.
  - **Forma de recuperar:** el padre puede ofrecer una tarea extra; al hacerla y validarla, vuelven los minutos (o se acorta la pausa).
  - Solo lo ven el hijo y los adultos, no los hermanos.
- Las pérdidas de minutos que ya existen («No cumplida −15 min» y «Rechazar con penalidad») pasan a llamarse «Ajuste de pantalla», con motivo en positivo y en el mismo historial.

## I17. Desmarcar una tarea marcada por error (22/11)
**Estado: construida (22/11), ver D42.**
- Al marcar «Hecha» sale unos segundos «Hecha · Deshacer».
- Además, el hijo puede desmarcarla mientras ningún adulto la haya validado; si la tarea no requiere validación, hasta el final del día.
- Al desmarcar es como si no la hubiera marcado: se quitan los puntos si ya se sumaron, y si la vuelve a marcar cuenta la hora nueva (a tiempo o tarde).
- En tareas compartidas, «Cuando haga falta», repetibles y trabajos extra, desmarcar la deja libre otra vez para los demás.
- No se avisa al adulto: sale de «Por validar» y queda en el historial.

## I18 · Configuración inicial guiada y tareas sugeridas (22/11) — pendiente

Cuando una familia nueva entra por primera vez, un asistente paso a paso le ayuda a dejarlo funcionando. Se puede saltar en cualquier momento y retomar desde Ajustes.

- **Cuándo:** sale sola al crear la familia; si se salta, queda «Configuración guiada» en Ajustes.
- **Pasos:**
  1. Hijos y edades.
  2. Tareas sugeridas según la edad de cada hijo.
  3. Puntos y mesada (valor del punto, meta semanal).
  4. Pantalla y premios (plan semanal de minutos y premios de partida).
  5. Invitar a otro adulto (opcional, último paso).
- **Tareas sugeridas:** lista por edad, ya marcada; el adulto desmarca lo que no sirva.
- Cada paso explica en una frase qué es y para qué sirve (modo tutorial).

## I19 · Meta de ahorro visible (22/11)

**Estado: construida (23/11), ver D59 y D60.**

Hoy la meta está escondida en «Mi banco › Mis productos». Pasa a ser una «meta de ahorro» con presencia propia.

- **Dónde:** en Hoy, bajo «Mi mesada», hay una tarjeta grande «¿Para qué ahorras?» con el botón «Crear meta de ahorro». Si ya hay meta, la tarjeta muestra su barra de progreso.
- **Quién:** el hijo la propone y el adulto la aprueba (puede ajustar el precio o el nombre).
- **Extras:**
  - Foto o emoji del objetivo.
  - «Te faltan X semanas», calculado con lo que suele ganar por semana.
  - Ahorro automático: un % de cada cierre de semana va solo a la meta.
  - Aporte de los padres: el adulto suma un empujón (p. ej. 1 € por cada 4 € ahorrados).

## I20 · Otros adultos, parientes y moneda (22/11)

**Estado: construida (23/11), ver D61, D62 y D63.** Aclaración del dueño: madre, padre, pareja y tutor/a legal son adultos completos con los mismos permisos; la única diferencia es la **cuenta principal** (la que creó la familia), que es quien invita y quita adultos y parientes y puede ceder el papel. En la interfaz se llama «cuenta principal», no «organizador».

- **Quién añade:** la cuenta principal (la que creó la familia) puede invitar a otro adulto (madre, padre, pareja, tutor/a legal) y a parientes (abuelos, tíos…).
- **Parentesco:** se elige de una lista: Madre, Padre, Pareja, Tutor/a legal, Abuelo/a, Tío/a u Otro (texto libre). Se ve en Familia y en los avisos.
- **Permisos:**
  - Madre, padre, pareja y tutor/a legal: adulto completo, como hoy.
  - Pariente: **ver y animar**. Ve el progreso de los niños, puede felicitar y dar premios o aportes. No valida tareas, no toca el dinero, los ajustes ni los miembros, y no borra datos.
- **Datos de contacto:** el organizador pone el correo y el teléfono del otro adulto. A esa persona le llega una invitación por correo con un enlace para crear su contraseña. Después puede cambiar sus datos en Mi perfil.
- **Moneda:** por familia, € o $. Se elige al crear la familia y se puede cambiar en Ajustes. Cambia el símbolo y el formato (6,00 € / $6.00); no convierte importes. Afecta a la app, los avisos, el ZIP de datos y los textos.
- **Ficha del miembro (aclaración posterior):** la cuenta principal puede poner y cambiar el correo y el teléfono de WhatsApp de cualquier miembro (adultos, parientes e hijos); cada uno los cambia luego en Mi perfil. Solo la principal o la propia persona (403 para el resto); se avisa en la app al adulto o pariente afectado y queda en el historial.

## I21 · Tiempo de pantalla más claro (22/11)

**Estado: construida (23/11), ver D65 a D71.** Dos baterías (Semana y Ganado), temporizador en el servidor con «Usar pantalla», días y topes, alarma y cierre automático, exceso a la semana siguiente, castigos con retos, «Dar minutos» y «Pedir tiempo extra» con puntos o dinero, «+N min» en las tareas y minutos que vuelan.

Hoy el hijo ve un total con dos líneas debajo y dos botones parecidos («Pedir pantalla» y «Anotar pantalla»). Se rehace para que se entienda de un vistazo, tanto el tiempo libre de cada semana como el extra que se gana.

- **Vista del hijo: dos baterías.**
  - «Semana» (azul): el plan gratuito; se recarga cada lunes.
  - «Ganado» (dorado): minutos ganados con tareas, cada lote con su fecha de caducidad.
  - Se gasta primero lo que caduca antes, y se ve cómo baja cada batería.
- **Gastar: un solo botón «Usar pantalla».** Elige 15, 30 o 60 min, arranca una cuenta atrás y se descuenta solo. Si la familia lo exige, antes lo aprueba un adulto. Sustituye a «Pedir» y «Anotar».
- **Ganar:**
  - «+15 min» (o lo que toque) visible en cada tarea, igual que puntos y euros.
  - Animación al validarse: los minutos «vuelan» a la batería Ganado.
  - Aviso 3 días antes de caducar: «El lunes caducan 20 min: úsalos».
- **Padres: una sola pantalla «Pantalla»** por hijo: plan semanal, saldo de cada batería, peticiones, ajustes manuales y pausa, todo junto.
- **Ampliación del dueño (22/11): sistema completo de gestión del tiempo.**
  - **Días de uso:** el plan semanal gratuito indica también qué días se puede usar (p. ej. solo fin de semana, o L–V máximo 30 min y S–D libre). Fuera de esos días el botón no arranca.
  - **Espacio propio del hijo:** una sección «Mi pantalla» clara y separada. Al empezar el videojuego, iPad u ordenador, enciende el temporizador, que va descontando de su tiempo disponible en cuenta atrás.
  - **El padre se entera y puede actuar:** al encender o apagar el temporizador le llega una notificación. El padre también puede encenderlo o pararlo desde su app si el hijo no lo hizo.
  - **Fin del tiempo:** cuando se acaba salta una alarma (sonido y vibración en el móvil del hijo) y una notificación al hijo y a los padres. Aviso previo a los 5 min.
  - **Castigos:** bloquear días u horas concretas (p. ej. «sin pantalla hasta el jueves» o «nada de 20 a 22 h»). Se ve en ambas apps con su motivo y cuándo termina.
  - **Retos para desbloquear:** el padre puede asociar un reto al bloqueo (p. ej. «lee 20 min» u «ordena tu cuarto»); al validarlo, el bloqueo se levanta o se acorta.
  - **Historial:** registro de sesiones (inicio, fin, quién lo encendió) para padres e hijo.
- **Respuestas del dueño (22/11):**
  - Sin bloqueo real del aparato (una web no puede): alarma con sonido y vibración en el móvil del hijo y notificación a los padres. El tiempo usado de más se descuenta de la semana siguiente.
  - Días de uso: días permitidos (L M X J V S D) y, opcional, un máximo por día (p. ej. L–V 30 min, S–D 2 h).
  - Retos: el hijo lo cumple (con foto si se pide) y un adulto lo valida; entonces el bloqueo se levanta o se acorta.
  - Programar ya.
