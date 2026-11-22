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

## Edición v2 con narración

Las tres composiciones de Remotion se definen en [src.jsx](remotion/src.jsx).
El [guion de escenas](remotion/escenas.json) conserva el texto exacto pronunciado,
el rótulo y el intervalo de grabación que usa cada escena. La promoción horizontal
presenta el problema, muestra la app y acaba con una invitación. El tutorial añade
capítulos sobre la configuración inicial, la paga y el plan semanal. La promoción
vertical reserva la zona inferior para subtítulos y controles de la plataforma.

La pantalla de la app se enmarca a la derecha en horizontal y debajo del título en
vertical. Se recorta la banda de rótulos de la grabación y se conservan los círculos
de toque que ya están en ella. Cuando termina el fragmento, su último fotograma
sirve de referencia mientras continúa la explicación.
Las tarjetas de entrada y salida animan el logotipo. Los cambios de escena son
cortes con entrada suave del rótulo. La voz es la única pista de audio de v2.

### Regenerar

Requisitos para el montaje: Node 22 o posterior compatible con los lockfiles,
Python 3.11 o posterior, FFmpeg, FFprobe, y Chromium. PostgreSQL hace falta si se
vuelven a grabar escenas. Ejecuta desde la raíz del repositorio:

```bash
npm ci --prefix web
cd docs/video/remotion
npm ci
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
./instalar-modelos.sh
npm run voz
npm run studio
```

Desde `docs/video/remotion`, y con los recursos preparados:

```bash
npm run render:presentacion
npm run render:tutorial
npm run render:vertical
```

Si ya dispones de Chromium, exporta `MESADA_CHROMIUM="$(command -v chromium)"`.
Remotion dibuja el encuadre, los rótulos y los subtítulos. FFmpeg ensambla esos
fotogramas con las grabaciones a 30 fps y monta las pistas de voz. Para un
render nativo fotograma a fotograma, ejecuta `npm run render:nativo -- Tutorial /tmp/tutorial.mp4`.
Los MP4 se escriben en `docs/video/` y los SRT en `docs/video/subtitulos/`.
La carpeta local `public/` contiene pistas y fragmentos generados, y
`tiempos.json` contiene los tiempos por escena a 30 fps.

Edita `remotion/voz.json` para cambiar la voz, el idioma, la velocidad, la pausa
y la ganancia. Por ejemplo, Kokoro v1.0 incluye las voces españolas
`ef_dora`, `em_alex` y `em_santa`. Para actualizar una escena, edita
`escenas.json` y ejecuta `npm run voz -- --video tutorial --escena 3`.
Esto regenera su pista y sus recursos y recalcula los tiempos de subtítulos
del vídeo. Después renderiza solo esa composición. El SRT se genera junto con
las pistas para que su texto y sus tiempos correspondan al audio montado.

Puedes generar capturas nuevas en una carpeta temporal sin tocar los MP4
originales. Después revisa el encuadre y actualiza los intervalos
`start` y `clip` en `escenas.json` si la posición de una acción cambió.

```bash
# Desde la raíz. PostgreSQL debe estar en marcha.
npm ci --prefix server
npm ci --prefix e2e
npm run --prefix web build
cd e2e
npx playwright install chromium
export MEDIA_OUTPUT_DIR="$(mktemp -d)"
export MEDIA_PORT=3201 MEDIA_DB=mesada_video
node media/video-presentacion.mjs
node media/video-tutorial.mjs
cd ../docs/video/remotion
MESADA_GRABACIONES="$MEDIA_OUTPUT_DIR" npm run voz
```

### Verificación técnica

Desde `docs/video`, inspecciona vídeo, audio y duración. Revisa visualmente
los subtítulos, los toques y los cambios de plano de cada escena. En vertical,
comprueba también el margen inferior del texto.

```bash
for f in *-v2.mp4; do
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration,size "$f"
  ffmpeg -hide_banner -i "$f" -af silencedetect=n=-42dB:d=1.5,volumedetect -vn -f null -
  ffmpeg -hide_banner -i "$f" -vf blackdetect=d=0.2:pix_th=0.1 -an -f null -
done
```

### Recursos y licencias

- Imagen de marca, logotipo y grabaciones procedentes del repositorio.
- Remotion 4.0.545 aplica los términos de su licencia gratuita para personas
  y organizaciones elegibles. [Licencia de Remotion](https://www.remotion.dev/docs/license)
- Kokoro v1.0 y sus voces publicados bajo Apache 2.0. El script obtiene los
  artefactos de `thewh1teagle/kokoro-onnx` y verifica sus SHA-256.
  El paquete Python `kokoro-onnx` se distribuye bajo MIT.
  [Modelo y voces](https://huggingface.co/hexgrad/Kokoro-82M) · [Artefactos ONNX](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
- Tipografía del sistema, con DejaVu Sans como alternativa disponible en Linux.
  [Licencia de DejaVu](https://dejavu-fonts.github.io/License.html)
- La edición v2 usa la voz de Kokoro sin música ni efectos sonoros. La grabación
  original solo aporta vídeo.
- Para este trabajo se usó la skill oficial `remotion-best-practices` de
  `remotion-dev/skills`, revisión `6f55706d`. Su instalación local añadió
  `.agents/skills/remotion-best-practices/` y `skills-lock.json`
  al espacio temporal de la tarea. [Remotion Skills](https://github.com/remotion-dev/skills/tree/6f55706d1069e512430582ad86e4e57dc07afe1b)
- La puesta en marcha y la revisión final usaron las skills del catálogo
  `cloud-environment-onboarding:setup`, `superpowers:brainstorming` y
  `superpowers:verification-before-completion`.

## Desglose de escenas v2

Los subtítulos reproducen la narración de cada fila. El halo de la grabación indica el toque cuando aparece. Las tarjetas usan entrada de texto y logotipo. Los clips se muestran en un marco móvil. No hay música ni efectos sonoros.

### Presentación horizontal

| Escena | Duración | Objetivo y rótulo | Pantalla y acción | Narración | Fuente |
|---|---:|---|---|---|---|
| 1. Organizarse en familia | 7.8 s | Tareas, puntos y paga en familia | Tarjeta con el problema cotidiano | ¿Qué toca hacer hoy? ¿Ya se hizo? Cuando cada tarea se apunta en un sitio distinto, es fácil perder la cuenta. | `web/public/brand/` |
| 2. Conoce Mesada | 7.7 s | Una lista clara para cada persona | Tarjeta de marca y nombre Mesada | Con Mesada, toda la familia tiene un sitio para organizar las tareas de casa y seguir la paga. | `web/public/brand/` |
| 3. Marcar una tarea | 7.7 s | Hoy · Poner el lavavajillas | Nora desplaza Hoy y toca el círculo de la tarea | Nora abre su lista de hoy. Cuando termina de poner el lavavajillas, marca la tarea desde su móvil. | `presentacion.mp4`, 3.8 s desde el inicio |
| 4. Revisar y aprobar | 7.7 s | Validar · Aprobar | Marta revisa la tarea y toca Aprobar | Marta ve la tarea pendiente en Validar. Al aprobarla, los puntos se suman al progreso de Nora. | `presentacion.mp4`, 8.7 s desde el inicio |
| 5. De puntos a euros | 8.1 s | Mesada · Conversión del periodo | Vista de los puntos de Nora | Cada familia decide cuánto valen los puntos. Al cerrar el periodo, la aplicación registra la conversión a euros. | `presentacion.mp4`, 13.6 s desde el inicio |
| 6. Empieza por una tarea | 7.7 s | mesada.veryfacil.org | Tarjeta con la dirección de Mesada | Crea tu familia, añade una primera tarea y probad juntos el recorrido completo. Empieza en Mesada. | `web/public/brand/` |

### Tutorial horizontal

| Escena | Duración | Objetivo y rótulo | Pantalla y acción | Narración | Fuente |
|---|---:|---|---|---|---|
| 1. Tu primera semana con Mesada | 12.4 s | De la primera tarea a la primera paga | Tarjeta de introducción | Vamos a configurar una familia de ejemplo. Verás cómo asignar una tarea, aprobarla y convertir sus puntos en paga. Al final veremos también dónde consultar el tiempo de pantalla. | `web/public/brand/` |
| 2. Crear la familia | 17.0 s | Nombre de la familia → cuenta adulta | Formulario inicial de Familia Soler, con la contraseña enmascarada | En el primer arranque, abre Crea tu familia. Escribe el nombre de la familia y tu nombre. Elige un usuario de adulto, añade el correo y establece una contraseña. Pulsa Crear familia para entrar en el panel. Guarda tus datos de acceso en un sitio seguro. | `tutorial.mp4`, 6 s desde el inicio |
| 3. Añadir a un hijo | 15.8 s | Familia → Añadir | Marta toca Añadir en Familia y abre el formulario | En Familia, pulsa Añadir. Elige el perfil de hijo, escribe su nombre y crea un usuario que pueda recordar. Dale un PIN de acceso y pulsa Añadir. Desde ese momento tendrá su propia vista, con las tareas que le corresponden. | `tutorial.mp4`, 14 s desde el inicio |
| 4. Crear y asignar la tarea | 16.7 s | Tareas → Nueva | Se abre Nueva tarea y se eligen datos y puntos | Abre Tareas y pulsa Nueva. Dale un nombre concreto. En el ejemplo escribimos Poner el lavavajillas. Elige cuántos puntos vale, cuándo se repite y quién se encarga. Selecciona a Nora y guarda con Crear tarea. Comprueba que aparece en el listado. | `tutorial.mp4`, 22.5 s desde el inicio |
| 5. Marcar la tarea terminada | 17.5 s | Hoy → Marcar como hecha | Nora accede a Hoy y marca el lavavajillas | En el móvil de Nora, elige Soy hijo o hija y entra con su usuario y su PIN. En Hoy aparecen las tareas asignadas. Cuando termine, pulsa el círculo al lado de la tarea. Verá que queda esperando validación. Desde el aviso puede deshacer el toque si se equivoca. | `tutorial.mp4`, 36 s desde el inicio |
| 6. Revisar lo que se ha hecho | 17.4 s | Validar → Aprobar | Marta abre las opciones de revisión de la tarea | Vuelve a la cuenta adulta y abre Validar. Busca la tarea que envió Nora. Si está bien hecha, pulsa Aprobar. En Otras opciones puedes reconocer solo una parte, devolver la tarea o rechazarla. Una vez aprobada, Nora puede ver los puntos en su progreso. | `tutorial.mp4`, 44.2 s desde el inicio |
| 7. Cerrar el periodo | 18.6 s | Mesada → Cerrar semana | La vista pasa del progreso a Banca familiar y al cierre | Abre Mesada en la cuenta adulta. Comprueba la equivalencia de puntos y euros que tiene tu familia. Pulsa Cerrar semana y revisa el resumen antes de confirmar. El importe convertido queda pendiente de pago. Así puedes distinguir los puntos ganados del dinero que queda por entregar. | `tutorial.mp4`, 64 s desde el inicio |
| 8. Registrar el pago | 15.4 s | Mesada → Registrar pago | Marta registra un pago ficticio y aparece un recibo | Cuando entregues la paga, abre el registro de pago, indica el importe y el método que usaste. Aquí se registra un pago de ejemplo. Al confirmar, Mesada guarda el movimiento y muestra un recibo que puedes volver a consultar en el historial. | `tutorial.mp4`, 73 s desde el inicio |
| 9. Planificar tiempo de pantalla | 19.1 s | Ajustes → Plan semanal | Marta activa el plan de pantalla y guarda el ejemplo | Si queréis organizar también el tiempo de pantalla, abre Ajustes y busca el plan semanal. Activa el plan para Nora, escribe los minutos y guarda. En este ejemplo, trescientos minutos son cinco horas. El plan carga sus minutos cada lunes. Nora puede consultar lo que le queda desde su cuenta. | `tutorial.mp4`, 82 s desde el inicio |
| 10. Pruébalo en familia | 14.9 s | mesada.veryfacil.org | Tarjeta con la dirección de Mesada | Para empezar, basta con una tarea y un acuerdo claro sobre cuándo se da por hecha. Probad un ciclo completo juntos. Después podréis ajustar los puntos y la frecuencia a vuestra rutina. Entra en Mesada para crear tu familia. | `web/public/brand/` |

### Presentación vertical

| Escena | Duración | Objetivo y rótulo | Pantalla y acción | Narración | Fuente |
|---|---:|---|---|---|---|
| 1. ¿Qué toca hacer hoy? | 5.3 s | Tareas · Puntos · Paga | Tarjeta de entrada adaptada a móvil | ¿Qué toca hacer hoy? Con Mesada, cada persona tiene sus tareas a mano. | `web/public/brand/` |
| 2. Marca la tarea | 5.5 s | Hoy → Marcar | Nora toca el círculo en Hoy | Nora pone el lavavajillas y marca la tarea como hecha. | `presentacion.mp4`, 3.8 s desde el inicio |
| 3. Revisa y aprueba | 5.0 s | Validar → Aprobar | Marta revisa en Validar | Marta la revisa y aprueba. Los puntos se suman al progreso. | `presentacion.mp4`, 8.7 s desde el inicio |
| 4. Organiza la paga | 4.7 s | Puntos → Euros | Nora consulta el valor de los puntos | Al cerrar la semana, los puntos se pueden convertir en euros. | `presentacion.mp4`, 13.6 s desde el inicio |
| 5. Crea tu familia | 4.5 s | mesada.veryfacil.org | Tarjeta de acción en la zona segura de móvil | Crea tu familia y apunta la primera tarea en Mesada. | `web/public/brand/` |
