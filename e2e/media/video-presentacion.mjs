// Vídeo de presentación (~30 s, 9:16, sin voz): el hijo marca, el padre valida y salen puntos, euros y pantalla.
// Uso: cd e2e && MEDIA_PORT=3201 MEDIA_DB=mesada_video node media/video-presentacion.mjs
import path from 'node:path';
import { ROOT, BASE, startServer, stopServer, launch, api, login, createFamily, addMember, today, sleep, ADULT, KID, KID2 } from './lib.mjs';
import { saveState, recordClip, assemble, OUT_DIR } from './video-lib.mjs';
import { execFileSync } from 'node:child_process';

const OUT = path.join(ROOT, 'docs/video/presentacion.mp4');
const server = await startServer();
const browser = await launch();
try {
  // Datos de ejemplo (sin grabar): familia, hijos y tareas
  const setup = await (await browser.newContext({ viewport: { width: 390, height: 800 }, locale: 'es-ES' })).newPage();
  await createFamily(setup);
  await addMember(setup, 'child', KID.name, KID.user, KID.pin);
  await addMember(setup, 'child', KID2.name, KID2.user, KID2.pin);
  const fam = (await api(setup, 'get', '/family')).body;
  const nora = fam.members.find((m) => m.username === KID.user);
  const T = today();
  for (const [title, icon, points] of [['Poner el lavavajillas', '🍽️', 20], ['Hacer la cama', '🛏️', 10], ['Regar las plantas', '🪴', 15]]) {
    await api(setup, 'post', '/tasks', { title, icon, points, recurrence: 'daily', startDate: T, assignees: [nora.id] });
  }
  await api(setup, 'post', '/adjustments/points', { userId: nora.id, delta: 100, note: 'Puntos de ejemplo' });
  await api(setup, 'post', '/allowance/settle', {}); // 100 puntos pasan a 5 € de mesada
  await api(setup, 'post', '/adjustments/points', { userId: nora.id, delta: 100, note: 'Puntos de ejemplo' });
  await api(setup, 'put', `/screen/plans/${nora.id}`, { minutesPerWeek: 300, enabled: true });
  await api(setup, 'post', '/screen/adjust', { userId: nora.id, delta: 45, note: 'Gracias por ayudar' });
  const adultState = path.join(OUT_DIR, 'adulto.json'), kidState = path.join(OUT_DIR, 'hijo.json');
  await saveState(browser, adultState, (p) => login(p, ADULT.user, ADULT.pass));
  await saveState(browser, kidState, (p) => login(p, KID.user, KID.pin, true));
  await setup.context().close();

  const clips = [];
  clips.push(await recordClip(browser, 'p0', null, { card: { kind: 'intro', seconds: 3.0 } }));

  clips.push(await recordClip(browser, 'p1', async ({ app, cap, pause, pulse }) => {
    await cap('Paso 1', 'Tu hijo marca la tarea como hecha');
    await pause(1500);
    const b = app.getByRole('button', { name: 'Marcar «Poner el lavavajillas» como hecha' });
    await pulse(b); await pause(700);
    await b.click();
    await pause(2600);
  }, { state: kidState }));

  clips.push(await recordClip(browser, 'p2', async ({ app, cap, pause, pulse }) => {
    await cap('Paso 2', 'Tú la validas con un toque');
    await pause(1500);
    const b = app.getByRole('button', { name: /Aprobar «Poner el lavavajillas»/ });
    await pulse(b); await pause(700);
    await b.click();
    await pause(2600);
  }, { state: adultState, start: '/validar' }));

  clips.push(await recordClip(browser, 'p3', async ({ app, cap, pause, go }) => {
    await app.getByText('Mi mesada').first().scrollIntoViewIfNeeded({ timeout: 5000 });
    await cap('Y entonces…', 'Gana puntos ⭐ que valen euros');
    await pause(3300);
    await go('/mesada');
    await cap('Y entonces…', 'Mesada en euros, sin líos');
    await pause(3300);
    await app.getByText('Mi tiempo de pantalla').first().scrollIntoViewIfNeeded({ timeout: 5000 });
    await cap('Y además…', 'Minutos de pantalla 🎮 que se ganan');
    await pause(3400);
  }, { state: kidState }));

  clips.push(await recordClip(browser, 'p4', null, { card: { kind: 'outro', seconds: 3.8 } }));
  execFileSync('node', [path.join(ROOT, 'e2e/media/musica.mjs'), '40', path.join(OUT_DIR, 'fondo-corto.m4a')], { stdio: 'inherit' });
  const total = assemble(clips, OUT, path.join(OUT_DIR, 'fondo-corto.m4a'));
  console.log('Presentación', total.toFixed(1), 's');
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(0);
