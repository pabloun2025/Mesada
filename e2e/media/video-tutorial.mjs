// Vídeo tutorial (~2 min, 9:16, sin voz): crear familia, añadir hijo, crear tarea, el hijo la marca,
// validar, mesada y pantalla. Todo se graba en la app real con datos inventados.
// Uso: cd e2e && MEDIA_PORT=3201 MEDIA_DB=mesada_video node media/video-tutorial.mjs
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, startServer, stopServer, launch, login, ADULT, KID } from './lib.mjs';
import { saveState, recordClip, assemble, OUT_DIR } from './video-lib.mjs';

const OUT = process.env.MEDIA_OUTPUT_DIR
  ? path.resolve(process.env.MEDIA_OUTPUT_DIR, 'tutorial.mp4')
  : path.join(ROOT, 'docs/video/tutorial.mp4');
mkdirSync(path.dirname(OUT), { recursive: true });
const TASK = 'Poner el lavavajillas';
const N = 7;
const step = (n) => `Paso ${n} de ${N}`;
const server = await startServer();
const browser = await launch();
try {
  const clips = [];
  clips.push(await recordClip(browser, 't0', null, { card: { kind: 'intro', seconds: 3.0 } }));

  // 1-3. Crear la familia, añadir al hijo y crear una tarea
  clips.push(await recordClip(browser, 't1', async ({ app, cap, type, pause, pulse }) => {
    await cap(step(1), 'Crea tu familia');
    await pause(3200);
    await type(app.getByLabel('Nombre de la familia'), 'Familia Soler', 60);
    await type(app.getByLabel('Tu nombre'), ADULT.name, 80);
    await type(app.getByLabel('Usuario'), ADULT.user, 80);
    await type(app.getByLabel('Correo'), 'marta@example.com', 40);
    await type(app.getByLabel('Contraseña'), ADULT.pass, 40);
    await pause(700);
    const crear = app.getByRole('button', { name: 'Crear familia' });
    await pulse(crear); await pause(500);
    await crear.click();
    await app.getByRole('heading', { name: 'Familia', exact: true }).waitFor();
    await pause(1500);

    await cap(step(2), 'Añade a tu hijo');
    await pause(1500);
    await app.getByRole('button', { name: 'Añadir' }).first().click();
    const d = app.getByRole('dialog');
    await pause(900);
    await type(d.getByLabel('Nombre', { exact: true }), KID.name, 110);
    await type(d.getByLabel('Usuario para entrar'), KID.user, 110);
    await type(d.getByLabel('PIN'), KID.pin, 160);
    await pause(900);
    await d.getByRole('button', { name: 'Añadir' }).click();
    await app.getByText(`${KID.name} se ha unido a la familia`).waitFor();
    await pause(2200);

    await cap(step(3), 'Crea una tarea');
    await app.getByRole('navigation', { name: 'Principal' }).last().getByRole('link', { name: 'Tareas' }).click();
    await pause(1500);
    await app.getByRole('button', { name: 'Nueva' }).click();
    const t = app.getByRole('dialog');
    await pause(900);
    await t.getByRole('radio', { name: '🍽️' }).click();
    await pause(500);
    await type(t.getByLabel('Nombre de la tarea'), TASK, 70);
    await t.getByRole('button', { name: KID.name }).click();
    await pause(1600);
    await t.getByLabel('Puntos', { exact: true }).scrollIntoViewIfNeeded();
    await pulse(t.getByLabel('Puntos', { exact: true }));
    await cap(step(3), 'Elige cuántos puntos vale');
    await pause(2200);
    const crearT = t.getByRole('button', { name: 'Crear tarea' });
    await crearT.click();
    await app.getByText('Tarea creada').waitFor();
    await cap(step(3), '¡Tarea creada!');
    await pause(2600);
  }, { start: '/' }));
  const adultState = path.join(OUT_DIR, 'adulto.json'), kidState = path.join(OUT_DIR, 'hijo.json');
  await saveState(browser, adultState, (p) => login(p, ADULT.user, ADULT.pass));

  // 4. El hijo entra y marca la tarea
  clips.push(await recordClip(browser, 't2', async ({ app, cap, type, pause, pulse }) => {
    await cap(step(4), 'Tu hijo entra con su PIN');
    await pause(1800);
    await app.getByRole('radio', { name: 'Soy hijo/a' }).click();
    await type(app.getByLabel('Usuario'), KID.user, 120);
    await type(app.getByLabel('PIN'), KID.pin, 200);
    await pause(700);
    await app.getByRole('button', { name: 'Entrar' }).click();
    await app.getByRole('heading', { name: /Te queda 1 tarea/ }).waitFor();
    await cap(step(4), 'Y marca la tarea como hecha');
    await pause(2200);
    const b = app.getByRole('button', { name: `Marcar «${TASK}» como hecha` });
    await b.scrollIntoViewIfNeeded();
    await pulse(b); await pause(900);
    await b.click();
    await pause(3200);
  }, { start: '/entrar' }));
  await saveState(browser, kidState, (p) => login(p, KID.user, KID.pin, true));

  // 5. El adulto valida
  clips.push(await recordClip(browser, 't3', async ({ app, page, cap, pause, pulse }) => {
    await cap(step(5), 'Tú validas la tarea');
    await pause(2200);
    await app.getByRole('button', { name: /Revisar «/ }).click();
    await cap(step(5), 'Puedes dar solo una parte, devolverla o rechazarla');
    await pause(4200);
    await page.keyboard.press('Escape');
    await pause(900);
    await cap(step(5), 'O aprobarla con un toque');
    const ok = app.getByRole('button', { name: /Aprobar «/ });
    await pulse(ok); await pause(900);
    await ok.click();
    await pause(3200);
  }, { state: adultState, start: '/validar' }));

  // 6. Puntos del hijo y mesada
  clips.push(await recordClip(browser, 't3b', async ({ cap, pause }) => {
    await cap(step(6), 'Tu hijo ve sus puntos y su nivel');
    await pause(4000);
    await cap(step(6), 'Cada tarea validada le acerca al siguiente');
    await pause(3600);
  }, { state: kidState, start: '/progreso' }));

  clips.push(await recordClip(browser, 't4', async ({ app, cap, pause, pulse }) => {
    await cap(step(6), 'Mira la mesada de tu hijo');
    await pause(2600);
    const cerrar = app.getByRole('button', { name: 'Cerrar semana' });
    await pulse(cerrar); await pause(600);
    await cerrar.click();
    await cap(step(6), 'Cierra la semana: los puntos pasan a euros');
    await pause(2600);
    await app.getByRole('button', { name: 'Convertir puntos en euros' }).click();
    await pause(2600);
    await cap(step(6), 'Anota el pago cuando se lo entregues');
    const pagar = app.getByRole('article').filter({ hasText: KID.name }).getByRole('button', { name: 'Pagar', exact: true });
    await pagar.scrollIntoViewIfNeeded();
    await pulse(pagar); await pause(900);
    await pagar.click();
    await pause(1700);
    await app.getByRole('dialog').getByRole('radio', { name: 'Bizum' }).click();
    await pause(1200);
    await app.getByRole('dialog').getByRole('button', { name: /^Pagar / }).click();
    await pause(4000);
    await app.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await pause(1500);
  }, { state: adultState, start: '/mesada' }));

  // 7. Pantalla
  clips.push(await recordClip(browser, 't5', async ({ app, page, cap, type, pause, pulse, go }) => {
    await cap(step(7), 'Pon un plan de tiempo de pantalla');
    await app.getByRole('region', { name: 'Plan semanal de pantalla' }).scrollIntoViewIfNeeded();
    await pause(2200);
    const plan = app.getByRole('region', { name: 'Plan semanal de pantalla' }).getByRole('listitem').filter({ hasText: KID.name });
    await plan.scrollIntoViewIfNeeded();
    await plan.getByLabel('Minutos por semana').fill('');
    await type(plan.getByLabel('Minutos por semana'), '300', 220);
    await plan.getByText('Plan semanal activo').click();
    await pause(1200);
    await cap(step(7), '5 horas a la semana');
    const g = plan.getByRole('button', { name: `Guardar el plan de ${KID.name}` });
    await pulse(g); await pause(700);
    await g.click();
    await pause(2800);
    await cap(step(7), 'Si hace falta, ajusta con motivos en positivo');
    await go('/mesada');
    const panel = app.getByRole('article', { name: `Cuenta de ${KID.name}` });
    await panel.scrollIntoViewIfNeeded();
    const aj = panel.getByRole('button', { name: 'Ajuste de pantalla' });
    await pulse(aj); await pause(900);
    await aj.click();
    await pause(1500);
    await app.getByRole('dialog').getByRole('radio', { name: /Habitación en orden/ }).click();
    await pause(3600);
    await page.keyboard.press('Escape');
    await pause(1200);
  }, { state: adultState, start: '/ajustes' }));
  clips.push(await recordClip(browser, 't6', async ({ app, cap, pause }) => {
    await cap(step(7), 'Tu hijo ve cuánto le queda');
    await app.getByText('Mi tiempo de pantalla').first().scrollIntoViewIfNeeded();
    await pause(2200);
    await cap(step(7), 'Se recarga cada lunes');
    await pause(3800);
  }, { state: kidState, start: '/mesada' }));

  clips.push(await recordClip(browser, 't7', null, { card: { kind: 'outro', seconds: 4.2 } }));
  execFileSync('node', [path.join(ROOT, 'e2e/media/musica.mjs'), '150', path.join(OUT_DIR, 'fondo-largo.m4a')], { stdio: 'inherit' });
  const total = assemble(clips, OUT, path.join(OUT_DIR, 'fondo-largo.m4a'));
  console.log('Tutorial', total.toFixed(1), 's');
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(0);
