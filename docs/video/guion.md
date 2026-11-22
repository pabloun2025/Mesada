# Guion de los vídeos

Dos vídeos verticales (9:16, 1080 x 1920, MP4 H.264), sin voz. Se graban con la app real y datos inventados (Familia Soler: Marta, Javier, Nora y Leo). Los rótulos van en una banda grande sobre la app y cada toque muestra un círculo amarillo. La música es de fondo, suave y generada con ffmpeg (acordes sinusoidales con fundido). No se ha descargado nada.

| Vídeo | Duración | Uso |
|---|---|---|
| `presentacion.mp4` | unos 28 s | Para compartir: qué es DiploP y por qué mola |
| `tutorial.mp4` | unos 1 min 50 s | Paso a paso: de crear la familia a la mesada y la pantalla |

## Presentación (~28 s)

Hilo: el hijo marca, el padre valida y salen puntos, euros y pantalla.

| Tiempo | Imagen | Rótulo |
|---|---|---|
| 0:00 – 0:03 | Tarjeta de marca: familia, logo DiploP y «Mi mesada» | (sin rótulo) |
| 0:03 – 0:10 | Móvil de Nora: marca «Poner el lavavajillas» como hecha | Paso 1 · Tu hijo marca la tarea como hecha |
| 0:10 – 0:17 | Móvil de Marta: pulsa «Aprobar» en Validar | Paso 2 · Tú la validas con un toque |
| 0:17 – 0:21 | Inicio de Nora: tarjeta «Mi mesada» (★ 120 → 6,00 €) | Y entonces… · Gana puntos ⭐ que valen euros |
| 0:21 – 0:24 | «Mi banco» con el dinero de la mesada | Y entonces… · Mesada en euros, sin líos |
| 0:24 – 0:28 | «Mi tiempo de pantalla» con el saldo y el plan | Y además… · Minutos de pantalla 🎮 que se ganan |
| 0:28 – 0:32 | Cierre: logo, «Mi mesada» y dirección | Tareas, puntos y mesada para toda la familia · mesada.veryfacil.org |

## Tutorial (~1 min 50 s)

Siete pasos. Cada rótulo lleva arriba «Paso N de 7».

| Paso | Qué se ve | Rótulos |
|---|---|---|
| Intro (3 s) | Tarjeta de marca | — |
| 1 · Crear la familia | Pantalla «Crea tu familia». Se escribe a mano el nombre de la familia, el usuario, el correo y la contraseña, y se pulsa «Crear familia» | Crea tu familia |
| 2 · Añadir al hijo | Familia > Añadir. Nombre, usuario y PIN de Nora | Añade a tu hijo |
| 3 · Crear una tarea | Tareas > Nueva. Icono, nombre, asignada a Nora, puntos | Crea una tarea · Elige cuántos puntos vale · ¡Tarea creada! |
| 4 · El hijo la marca | Nora entra con usuario y PIN (Soy hijo/a) y marca la tarea | Tu hijo entra con su PIN · Y marca la tarea como hecha |
| 5 · Validar | Validar > «Otras opciones» (parcial, devolver, rechazar) y después «Aprobar» | Tú validas la tarea · Puedes dar solo una parte, devolverla o rechazarla · O aprobarla con un toque |
| 6 · Puntos y mesada | Progreso de Nora (puntos y nivel). Después, Mesada de los padres: Cerrar semana, convertir en euros, Pagar por Bizum y recibo | Tu hijo ve sus puntos y su nivel · Cierra la semana: los puntos pasan a euros · Anota el pago cuando se lo entregues |
| 7 · Pantalla | Ajustes > Plan semanal de pantalla (300 min). Después, «Ajuste de pantalla» con motivos en positivo y, por último, el saldo de Nora | Pon un plan de tiempo de pantalla · 5 horas a la semana · Si hace falta, ajusta con motivos en positivo · Tu hijo ve cuánto le queda · Se recarga cada lunes |
| Cierre (4 s) | Logo, «Mi mesada» y dirección | Tareas, puntos y mesada para toda la familia · mesada.veryfacil.org |

## Cómo se generan

Todo está en `e2e/media/` (fuera de `e2e/tests/`, así no entra en la suite). Cada script arranca su propia API con una base vacía y la web compilada (`web/dist`), así que primero hay que haber hecho `cd web && npm run build`. Hace falta PostgreSQL local y `ffmpeg`.

```bash
cd e2e
# Presentación y tutorial (usan otro puerto y otra base para no chocar con nada)
MEDIA_PORT=3201 MEDIA_DB=mesada_video node media/video-presentacion.mjs
MEDIA_PORT=3201 MEDIA_DB=mesada_video node media/video-tutorial.mjs
# Capturas del manual (docs/manual/img) y PDF
node media/capturas-manual.mjs
node media/pdf.mjs
```

| Archivo | Para qué sirve |
|---|---|
| `lib.mjs` | Arranca la API de pruebas, crea la familia, entra, llama a la API |
| `video-lib.mjs` | Escenario 9:16, rótulos, círculo de toque, tarjetas de marca y montaje con ffmpeg |
| `musica.mjs` | Genera la música de fondo (Do mayor 7, La menor 7, Fa mayor 7, Sol 6) |
| `video-presentacion.mjs`, `video-tutorial.mjs` | Los guiones de grabación |
| `capturas-manual.mjs`, `pdf.mjs` | Capturas a 375 px y PDF del manual y la guía |

Cómo funciona la grabación:

- La página se abre a 1080 x 1920 y la app va dentro de un iframe de 390 x 543 escalado x2,77. Así el vídeo sale nítido y la app sigue viendo un móvil de 390 px.
- El servidor no deja incrustar la app (`X-Frame-Options`). Solo al grabar, Playwright quita esa cabecera de las respuestas. No se toca el código de la app.
- Cada tramo se graba con `recordVideo`, se recorta el arranque y se une con fundidos cortos. Después se mezcla la música (con fundido de entrada y de salida) y se codifica con `libx264`.
