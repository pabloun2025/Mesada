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
- **Decidido:**
  - El hijo anota los minutos que usó y en qué: videojuegos, tele, tablet…
  - Gana 5 puntos por registrar honestamente lo jugado ese día: una vez al día, aunque anote varias veces.
  - Los minutos se restan del saldo al momento.
  - Los puntos llegan cuando el padre lo confirma. El padre también puede anularlo.
  - Si anota más de lo que tiene en el saldo:
    - el exceso queda registrado y el saldo se queda en 0;
    - ese día no gana puntos;
    - el padre recibe un aviso.
