# Flujos familiares de Mesada

Diseño de producto · 28 de noviembre de 2026. Este documento describe el comportamiento previsto de siete cambios. El plan asociado define las pruebas de aceptación y el orden de trabajo.

## Decisión de arquitectura

Cada acción familiar se confirma en su pantalla habitual. El panel permite registrar quién hizo una tarea. Validar concentra decisiones del adulto. Banco conserva los recibos y Pantalla conserva las sesiones. Las tres fuentes de verdad siguen siendo las ocurrencias, los libros de movimientos y las concesiones de bonos. Un panel adicional de operaciones habría obligado a mantener una segunda representación de los mismos estados. El enfoque elegido amplía las acciones existentes y añade registros específicos allí donde hay una decisión nueva que recordar.

El punto de partida incluye la migración local `017_child_expenses.sql`, el cálculo de gastos y su recibo, además de cambios locales en la pantalla del adulto. La previsualización de gastos ya resuelve céntimos, límites de conversión y reintentos tras perder la conexión. Las ampliaciones deben admitir sus solicitudes y recibos actuales.

## 1. Registrar una tarea que hizo un hijo

Desde el panel, el adulto elige día, tarea y quién la hizo. Una tarea individual o por rotación lleva al hijo de esa ocurrencia. En una compartida se elige entre sus participantes activos. Si Ana hizo una tarea compartida, al volver a abrirla debe leerse «La hizo Ana · registrada por Luis». La pantalla inicial usa hoy en la zona de la familia y permite seleccionar una fecha pasada. Solo se ofrecen ocurrencias que correspondan a la fecha y que admitan registro. Para fechas pasadas se consultan las ocurrencias que ya constan en el día solicitado, incluso fuera de la ventana precargada. El reparto actual de una tarea no permite reconstruir un turno histórico perdido. Si ese día carece de ocurrencia, el panel lo indica.

La acción se aplica a tareas ordinarias pendientes o vencidas. Una entrega previa identifica a su autor y dirige al adulto a su revisión. Una tarea de comprobación conserva «Cumplida / No cumplida», sus correcciones y sus efectos en minutos. Los extras siguen su flujo de reserva. Se respetan el turno, la participación, la espera y el máximo de repeticiones. El adulto atestigua que vio el trabajo y queda identificado en la actividad. Cuando hay una hora límite, se solicita la hora efectiva para distinguir una tarea a tiempo de una tardía. La fecha de registro y la de realización pueden ser distintas. Los puntos entran en el libro en el momento de la validación. Un registro de ayer no reabre un cierre de mesada.

El servidor bloquea la ocurrencia antes de decidir. Una aprobación completa concede los puntos, los bonos que correspondan y el progreso una vez. Ante dos adultos eligiendo distintos hijos para la misma compartida, gana la primera confirmación y el segundo ve quién quedó registrado.

## 2. Elegir el destino de un préstamo al aprobarlo

En Validar o Banco, el adulto ve el principal, las cuotas y el primer lunes de cobro. «Saldo» es el destino inicial, compatible con aprobaciones anteriores. La elección y la persona que la confirmó se conservan junto al préstamo. Una entrega externa es el apunte de un pago que el adulto realizó.

| Destino | Movimientos al confirmar | Qué ve la familia |
| --- | --- | --- |
| Saldo | Abono del principal a disponible | Importe prestado, saldo resultante y calendario |
| Efectivo, Bizum o transferencia | Abono del principal y salida por la misma cantidad vinculada a la entrega | Medio, importe, adulto y fecha. El disponible acaba como empezó |
| Meta | Abono y transferencia por ese importe de disponible al ahorro de una meta activa del mismo hijo, sin petición de liquidación pendiente | Nombre de la meta en ese momento, principal aportado y cuotas. El capital prestado queda excluido del «empujón» por ahorro propio |
| Compra | Abono y registro de un único gasto por el precio de la compra | Artículo, precio, principal aplicado, saldo previo utilizado, puntos convertidos, céntimos que cubren, diferencia y saldo final |

**Ejemplo.** Robux cuesta 9 €. La familia aprueba un préstamo de 6 €. Con saldo anterior de 1 €, faltan 2 € tras aplicar el principal y el saldo. Si los puntos y el tope cubren 1,20 €, la cuenta queda en −0,80 €. El principal pendiente sigue siendo 6 € y se devuelve mediante las cuotas previstas. Con saldo anterior cero y sin conversión disponible, el resultado sería −3 €. Si el precio es menor que el principal, el resto queda en disponible y se muestra antes de confirmar.

En una compra con préstamo la aportación familiar es cero. El recibo guarda su propia moneda. Las reglas de aportación familiar se aplican al registrar un gasto compartido independiente. El gasto descuenta una sola vez el precio completo. La conversión usa los puntos enteros mínimos, el cambio permitido por la familia y el margen de sus topes semanal y de periodo. Un exceso de céntimos al convertir un punto queda en la cuenta. La aprobación mantiene las comprobaciones actuales de préstamo, incluida la cuenta negativa antes de prestar. El saldo puede volverse negativo al registrar la compra. Al confirmar se vuelven a comprobar moneda, cálculo, estado y destino. Si algo relevante cambia se presenta un desglose nuevo. Un cambio de destino de una aprobación ya resuelta no puede crear una segunda entrega. El pago de cuotas en efectivo o por Bizum queda pendiente de decisión de producto. Sigue vigente el cobro semanal existente.

## 3. Reglas visibles para gastos compartidos

Un adulto puede guardar «Salidas con amigos · la familia aporta el 50 %» o «Libros · la familia aporta 5 €». La familia puede crear, editar o archivar sus reglas. El 50 % para amigos es un ejemplo que se puede adoptar explícitamente. Al registrar un gasto se elige una regla guardada o se introduce la aportación de ese gasto. Las reglas activas se ven también desde el banco del hijo.

La regla expresa lo que paga la familia. El porcentaje se guarda en puntos básicos de 0 a 10 000 y la aportación fija en céntimos de la moneda familiar. La aportación aplicable nunca supera el precio. Si una regla fija supera el precio, la vista previa propone cubrir el total y muestra el ajuste. Los importes fijos se vinculan a su moneda. Tras un cambio de moneda se pide actualizar la regla antes de aplicarla.

Cambiar la aportación propuesta exige explicar la excepción. El recibo guarda el nombre y valor de la regla al aplicarla, la aportación efectiva, la moneda, el motivo y el reparto. Si se edita o archiva la regla, el recibo conserva estas cifras. La confirmación vincula el identificador de operación al contenido exacto de la vista previa. Reintentar una operación ya registrada devuelve su recibo original, incluso cuando entretanto cambió la regla. Los gastos históricos anteriores siguen mostrando su desglose. Si carecen de moneda guardada se usa la moneda disponible de la familia como referencia, sin atribuirles una moneda histórica que se desconoce.

## 4. Entender el uso real de pantalla

El adulto y el hijo ven por separado el uso registrado hoy, el tope diario del plan y el saldo disponible en sus baterías. Junto al tope se indica cuánto se ha consumido del plan o «Sin tope diario». Por ejemplo, 20 minutos con temporizador ordinario y 15 anotados por el adulto como extra autorizado suman 35 de uso registrado. Con un tope de 30 y 20 consumidos del plan, quedan 10 del tope. El saldo disponible puede ser otro número.

El día de una sesión es el del inicio efectivo o cargo aprobado en la zona familiar, aunque la petición se hiciera antes. Una sesión que cruza medianoche se imputa completa al día de inicio. El total suma los minutos utilizados de las sesiones finalizadas, incluidas las de cargo manual y extra, sus excesos una vez y las anotaciones antiguas confirmadas. Las pendientes se muestran por separado y las anuladas se excluyen. El recorrido antiguo de gasto directo dejó movimientos de tipo spend sin referencia a una sesión ni a una petición. Se incorpora su cantidad efectiva una sola vez. Una sesión en marcha presenta su contador aparte hasta liquidarse. Un regalo, caducidad, ajuste de saldo o devolución cambia las baterías, sin sumar uso. El temporizador ordinario sigue consumiendo tope de plan. Al registrar un nuevo uso manual se indica si es ordinario o extra autorizado. El ordinario consume el tope que quede y el extra solo cuenta en el total real. Las reglas de aprobación y de deuda de minutos siguen aplicándose.

El adulto puede registrar minutos ya usados, categoría y nota opcional, o iniciar el temporizador con su categoría. El cobro directo se registra en el mismo historial de sesiones. Un cargo antiguo sin categoría se muestra como «Sin categoría». El hijo conserva sus peticiones y el adulto sus acciones para aprobar, parar o ampliar. Las anotaciones de uso existentes mantienen su propio estado y autoría.

## 5. Proponer tareas y premios

En Hoy y en Premios, el hijo puede enviar una idea con título, descripción opcional y puntos sugeridos. Ve su texto y el estado de cada propuesta. Validar muestra al adulto la idea original y le permite aprobarla tal cual, corregirla y aprobarla o rechazarla. El hijo ve el resultado y la nota. Para una corrección o un rechazo se exige un motivo.

La aprobación crea exactamente una tarea o recompensa normal. Por defecto, una tarea propuesta es puntual para el proponente a partir del día local de aprobación y requiere validación. El adulto confirma los puntos y puede completar los campos necesarios. Para un premio confirma el coste en puntos y se publica en el catálogo familiar. Los valores válidos respetan los límites del formulario de destino. Antes de aprobar se conserva la propuesta como borrador familiar privado entre el menor y los adultos gestores. Se guardan el texto original, la decisión, el resultado y la referencia al nuevo elemento.

## 6. Promoción puntual para tareas que llevan tiempo sin hacerse

En Hoy, el hijo ve sugerencias de «Cuando haga falta» que puede hacer en ese momento, con sus puntos normales. El adulto puede activar un aumento del 30 % o del 50 % para una tarea sugerida. La tarjeta pasa, por ejemplo, de «10 puntos» a «10 + 3 = 13 puntos · solo hoy · un uso». La activación es discrecional. No se promete un aumento por esperar ni se publican cuentas atrás hasta que una tarea vaya a tener premio.

Como valor inicial de diseño, la tarea debe llevar siete días civiles disponible sin una realización por ningún participante. Se toma la fecha más reciente entre el inicio de la disponibilidad y la última realización vigente. Se excluyen tareas fuera de fechas, en espera por intervalo o ya enviadas. Las tareas obligatorias que alguien dejó vencer quedan fuera de la selección. El extra usa `round(puntos_base × porcentaje / 100)` con enteros positivos. Se ofrece el porcentaje cuando produce al menos un punto adicional.

Una activación se aplica a una sola ocurrencia del día entre todos sus participantes elegibles. Se reserva para la primera entrega válida posterior a la activación de ese día. Registrar después una realización anterior no concede el aumento. Si se valida después de medianoche, conserva el importe ofrecido. La aprobación completa concede el incremento una vez. La revisión parcial, el rechazo y el desmarcado mantienen la semántica de puntos de la aplicación. Un desmarcado que revierta puntos compensa también el incremento. Solo una entrega aún elegible durante la promoción puede volver a reservarlo. Se conservan por separado la base, el porcentaje, el incremento, la fecha, el adulto y la concesión. La caducidad se calcula por zona familiar y no depende de que haya un proceso nocturno en marcha.

## 7. Cambiar una sorpresa de catálogo

El adulto activa «Permitir un cambio» en un bono de tipo premio de catálogo marcado como sorpresa. Marca también qué premios del catálogo están disponibles como alternativas. Las configuraciones actuales empiezan desactivadas. Al ganar la sorpresa se guardan su premio, título, valor en puntos y permiso de cambio en la concesión. Una edición posterior de la tarea, del catálogo o del precio original no cambia lo ganado. Una concesión histórica sin valor fiable mantiene su entrega habitual.

Al abrir el regalo se presenta el original. El hijo puede quedárselo o seleccionar una alternativa activa de la misma familia con el mismo coste que el valor guardado. También puede volver al premio ganado y cambiarlo antes de la entrega. El primer cambio confirmado agota la opción y se conserva el original para el historial. Si desaparecen todas las alternativas sigue pudiendo recibir el premio original. Las alternativas y el valor quedan ocultos en las tarjetas y avisos anteriores a la concesión.

Validar muestra al adulto qué premio tiene que entregar. Cambiar y entregar bloquean la misma concesión. En un premio intercambiable, la confirmación de entrega incluye el identificador del premio o la versión que vio el adulto. Si el hijo lo cambió mientras la pantalla estaba abierta, se vuelve a mostrar el premio elegido y se pide confirmar la entrega actual. Una entrega, anulación o cambio previo impide un segundo cambio. Se actualiza la concesión ganada, sin abrir un canje de catálogo ni cobrar puntos al hijo. El selector al revelar cubre la elección opcional de catálogo con el mismo presupuesto y los mismos controles.

## Garantías comunes

Cada escritura comprueba el rol, la familia, el beneficiario y el estado en el servidor. Solo los adultos gestores toman decisiones. Cada hijo accede a su historial y a las propuestas, ofertas o sorpresas que le correspondan. El filtro de parientes sigue siendo una lista cerrada.

Las decisiones, los movimientos, los cambios de estado y su auditoría se confirman en una transacción PostgreSQL. Cada operación que modifica saldo usa la cuenta del hijo como bloqueo común. Para un préstamo destinado a una meta se bloquean préstamo, meta y después cuenta, de forma compatible con el ingreso ordinario en metas. En el historial se pueden distinguir titular, adulto que actúa y referencia a la operación. Las comunicaciones y los libros llevan claves que evitan duplicados.

La exportación familiar incluye las nuevas decisiones, reglas, recibos, propuestas, promociones y elecciones de premio. Las referencias a un menor y el texto de sus propuestas se eliminan según el flujo de privacidad existente. Las reglas de familia permanecen hasta la eliminación familiar. El plan especifica las pruebas de reintentos, concurrencia y migración de historiales anteriores.
