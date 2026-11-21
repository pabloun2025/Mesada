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
**Estado: maqueta primero; se programa cuando el usuario la apruebe.**
- Hijo, estilo banco digital:
  - tarjetas que se deslizan (cuenta de dinero y cuenta de puntos);
  - botones redondos con icono debajo (Retirar, Canjear, Adelanto, Préstamo, Ahorrar);
  - extracto con un icono por tipo de movimiento (tarea, canje, retiro, préstamo, interés, compra de meta);
  - recibo de banco al operar (fecha, importe, saldo nuevo);
  - teclado numérico grande para el importe, con botones rápidos (5 €, 10 €, todo);
  - pequeña gráfica del saldo de las últimas semanas.
- Padres, banca para padres: una cuenta por hijo, «Pendiente de pagar» destacado, operaciones por aprobar, préstamos y ahorros como productos.
