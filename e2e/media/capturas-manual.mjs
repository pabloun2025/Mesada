// Genera las capturas del manual (375 px de ancho, datos inventados) en docs/manual/img/.
// Uso: cd e2e && node media/capturas-manual.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BASE, startServer, stopServer, launch, phone, api, login, createFamily, addMember, today, sleep, ADULT, ADULT2, KID, KID2 } from './lib.mjs';

const OUT = path.join(ROOT, 'docs/manual/img');
fs.mkdirSync(OUT, { recursive: true });
const view = { ...phone, viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 };
const fails = [];

async function settle(page, ms = 700) { await page.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); }
async function shot(page, name, opts = {}) {
  await settle(page, opts.wait ?? 500);
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), fullPage: !!opts.full, type: 'jpeg', quality: 88 });
  console.log('ok', name);
}
async function step(name, fn) { try { await fn(); } catch (e) { fails.push(name); console.log('FALLO', name, String(e).split('\n')[0]); } }
async function toTop(page, loc, offset = 90) { await loc.first().scrollIntoViewIfNeeded(); await page.evaluate((o) => window.scrollBy(0, -o), offset); await sleep(300); }
const closeDialog = async (page) => { await page.keyboard.press('Escape'); await sleep(300); if (await page.getByRole('dialog').count()) { await page.getByRole('dialog').getByRole('button', { name: /Cerrar|Cancelar/ }).first().click().catch(() => {}); await sleep(300); } };

function totp(secret, ms = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret.replace(/\s/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const off = h[h.length - 1] & 15;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const server = await startServer();
const browser = await launch();
try {
  const ctxA = await browser.newContext(view); const A = await ctxA.newPage();
  const ctxK = await browser.newContext(view); const K = await ctxK.newPage();

  // 1. Bienvenida y creación de la familia
  await step('bienvenida', async () => { await A.goto(BASE + '/bienvenida'); await shot(A, '01-bienvenida'); });
  await step('crear-familia', async () => {
    await A.goto(BASE + '/configurar');
    await A.getByRole('heading', { name: 'Crea tu familia' }).scrollIntoViewIfNeeded();
    await A.getByLabel('Nombre de la familia').fill('Familia Soler');
    await A.getByLabel('Tu nombre').fill(ADULT.name);
    await A.getByLabel('Usuario').fill(ADULT.user);
    await A.getByLabel('Correo').fill('marta@example.com');
    await A.getByLabel('Contraseña').fill(ADULT.pass);
    await A.getByRole('checkbox', { name: /acepto/i }).check();
    await A.getByLabel('Nombre de la familia').scrollIntoViewIfNeeded();
    await A.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await shot(A, '02-crear-familia');
    await A.getByRole('button', { name: 'Crear familia' }).click();
    await A.getByRole('heading', { name: 'Familia', exact: true }).waitFor();
  });

  // 2. Familia: hijos y adultos
  await step('anadir-hijo', async () => {
    await A.getByRole('button', { name: 'Añadir' }).first().click();
    const d = A.getByRole('dialog');
    await d.getByLabel('Nombre', { exact: true }).fill(KID.name);
    await d.getByLabel('Usuario para entrar').fill(KID.user);
    await d.getByLabel('PIN').fill(KID.pin);
    await shot(A, '03-anadir-hijo');
    await d.getByRole('button', { name: 'Añadir' }).click();
    await A.getByText(`${KID.name} se ha unido a la familia`).waitFor();
  });
  await step('anadir-resto', async () => {
    await addMember(A, 'child', KID2.name, KID2.user, KID2.pin);
    await A.getByRole('button', { name: 'Añadir' }).first().click();
    const d = A.getByRole('dialog');
    await d.getByRole('radio', { name: 'Adulto' }).click();
    await d.getByLabel('Nombre', { exact: true }).fill(ADULT2.name);
    await d.getByLabel('Usuario para entrar').fill(ADULT2.user);
    await d.getByLabel('Contraseña').fill(ADULT2.pass);
    await shot(A, '04-anadir-adulto');
    await d.getByRole('button', { name: 'Añadir' }).click();
    await A.getByText(`${ADULT2.name} se ha unido a la familia`).waitFor();
    await sleep(4500); await shot(A, '05-familia');
  });
  // año de nacimiento para que Nora (12) y Leo (9) tengan edad
  const fam = (await api(A, 'get', '/family')).body;
  const nora = fam.members.find((m) => m.username === KID.user), leo = fam.members.find((m) => m.username === KID2.user);
  await api(A, 'patch', `/members/${nora.id}`, { birthYear: 2014 }).catch(() => {});

  // 3. Tareas
  const T = today();
  const mk = (b) => api(A, 'post', '/tasks', { points: 20, recurrence: 'daily', startDate: T, assignees: [nora.id], ...b });
  await step('nueva-tarea', async () => {
    await A.goto(BASE + '/tareas');
    await A.getByRole('button', { name: 'Nueva' }).click();
    const d = A.getByRole('dialog');
    await d.getByRole('radio', { name: '🍽️' }).click();
    await d.getByLabel('Nombre de la tarea').fill('Poner el lavavajillas');
    await d.getByRole('button', { name: KID.name }).click();
    await d.evaluate((el) => { el.scrollTop = 0; el.querySelectorAll('*').forEach((n) => { if (n.scrollTop) n.scrollTop = 0; }); });
    await shot(A, '06-nueva-tarea');
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await A.getByText('Tarea creada').waitFor();
  });
  await mk({ title: 'Hacer la cama', icon: '🛏️', points: 10, requiresApproval: false });
  await mk({ title: 'Recoger la mesa', icon: '🍴', points: 10, assignees: [nora.id, leo.id], assignmentMode: 'individual' });
  await mk({ title: 'Sacar al perro', icon: '🐕', points: 15, recurrence: 'weekly', weekdays: [1, 3, 5], repeatable: true, maxPerDay: 2 });
  await mk({ title: 'Sacar la basura', icon: '🗑️', points: 10, recurrence: 'as_needed', assignees: [nora.id, leo.id], cooldownDays: 2 });
  await mk({ title: 'Leer 20 minutos', icon: '📖', points: 15, assignees: [leo.id] });

  const opener = async (title) => {
    await A.goto(BASE + '/tareas');
    await A.getByRole('button', { name: 'Nueva' }).click();
    const d = A.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill(title);
    await d.getByRole('button', { name: KID.name }).click();
    return d;
  };
  const scrollTo = async (loc) => { await loc.scrollIntoViewIfNeeded(); await sleep(250); };
  await step('cuando-haga-falta', async () => {
    const d = await opener('Sacar la basura (ejemplo)');
    await d.getByRole('radio', { name: 'Cuando haga falta' }).click();
    await scrollTo(d.getByText('Siempre disponible'));
    await shot(A, '07-cuando-haga-falta');
    await scrollTo(d.getByLabel('Después de hacerla, vuelve en (días)')); await d.getByLabel('Después de hacerla, vuelve en (días)').fill('2');
    await shot(A, '08-espera-dias');
  });
  await step('repetir-y-dias', async () => {
    const d = await opener('Sacar al perro (ejemplo)');
    await d.getByRole('radio', { name: 'Semanal' }).click();
    for (const w of ['Lunes', 'Miércoles', 'Viernes']) await d.getByRole('button', { name: w }).click();
    await scrollTo(d.getByRole('button', { name: 'Lunes' }));
    await shot(A, '09-dias-semana');
    await d.getByRole('checkbox', { name: /Se puede repetir en el día/ }).check({ force: true });
    await scrollTo(d.getByLabel('Máximo de veces al día'));
    await shot(A, '10-repetir-en-el-dia');
  });
  await step('hora-y-bono', async () => {
    const d = await opener('Hacer la cama (ejemplo)');
    await d.locator('summary', { hasText: 'Hora límite' }).click();
    await d.getByLabel('Lunes a viernes').fill('09:00');
    await d.getByLabel('Fin de semana y festivos').fill('12:00');
    await d.getByLabel('Valor si llega tarde (%)').fill('50');
    await scrollTo(d.getByLabel('Lunes a viernes'));
    await shot(A, '11-hora-limite');
    await d.locator('summary', { hasText: 'Bono extra' }).click();
    await d.getByLabel('Tipo de bono').selectOption('screen');
    await d.getByLabel('Minutos de pantalla').fill('30');
    await scrollTo(d.getByLabel('Minutos de pantalla'));
    await shot(A, '12-bono-extra');
  });
  await step('festivos', async () => {
    await api(A, 'post', '/holidays', { day: new Date(Date.now() + 5 * 86400000).toLocaleDateString('sv-SE'), label: 'Puente de ejemplo' });
    await A.goto(BASE + '/ajustes');
    const h = A.getByText(/festivos|vacaciones/i).first();
    await scrollTo(h);
    await shot(A, '13-festivos');
  });
  await step('lista-tareas', async () => { await A.goto(BASE + '/tareas'); await shot(A, '14-lista-tareas'); });
  await step('extras', async () => {
    await api(A, 'post', '/extras', { title: 'Quitar hierbajos del patio', icon: '🌿', points: 30, requiresApproval: true });
    await api(A, 'post', '/extras', { title: 'Ordenar el trastero', icon: '🧰', points: 25, requiresApproval: true });
    await A.goto(BASE + '/extras');
    await A.getByRole('button', { name: 'Activar' }).first().click();
    await A.getByRole('dialog').getByRole('button', { name: /Activar|Guardar|Poner/ }).last().click();
    await sleep(600);
    await sleep(4000); await shot(A, '15-extras-adulto');
  });

  // 4. El hijo
  await login(K, KID.user, KID.pin, true);
  await step('hijo-hoy', async () => { await K.goto(BASE + '/'); await shot(K, '16-hijo-hoy'); });
  await step('hijo-marca', async () => {
    await K.getByRole('button', { name: 'Marcar «Hacer la cama» como hecha' }).click();
    await K.locator('[aria-live=polite]').filter({ hasText: 'Hecha' }).waitFor();
    await shot(K, '17-hijo-hecha-deshacer', { wait: 150 });
    await K.locator('[aria-live=polite]').getByRole('button', { name: 'Deshacer' }).click();
    await sleep(500);
  });
  await step('hijo-marca-todas', async () => {
    for (const t of ['Poner el lavavajillas', 'Recoger la mesa']) await K.getByRole('button', { name: `Marcar «${t}» como hecha` }).click().catch(() => {});
    await sleep(600);
    await K.getByRole('button', { name: 'Marcar «Hacer la cama» como hecha' }).click().catch(() => {});
    await K.getByRole('button', { name: 'Marcar «Sacar la basura» como hecha' }).click().catch(() => {});
    await sleep(900);
    await K.goto(BASE + '/');
    await toTop(K, K.getByRole('heading', { name: /Para hoy/ })); await shot(K, '18-hijo-esperando-validacion');
  });

  // 5. Validar
  await step('validar', async () => {
    await api(A, 'post', '/tasks', { title: 'Regar las plantas', icon: '🪴', points: 20, recurrence: 'daily', startDate: T, assignees: [nora.id] });
    await api(A, 'post', '/tasks', { title: 'Ordenar los zapatos', icon: '👟', points: 20, recurrence: 'daily', startDate: T, assignees: [nora.id] });
    await api(A, 'post', '/tasks', { title: 'Limpiar el baño', icon: '🧼', points: 20, recurrence: 'daily', startDate: T, assignees: [nora.id] });
    await K.goto(BASE + '/');
    for (const t of ['Regar las plantas', 'Ordenar los zapatos', 'Limpiar el baño']) { await K.getByRole('button', { name: `Marcar «${t}» como hecha` }).click(); await sleep(500); }
    await A.goto(BASE + '/validar');
    await shot(A, '19-validar');
    const review = async (t) => { await A.getByRole('button', { name: `Revisar «${t}» de ${KID.name}` }).click(); return A.getByRole('dialog'); };
    let d = await review('Limpiar el baño');
    await shot(A, '20-revisar-opciones');
    await d.getByRole('radio', { name: /Premio parcial/ }).click();
    await d.getByRole('button', { name: '75 %' }).click();
    await d.getByRole('button', { name: 'Falta un poco' }).click();
    await scrollTo(d.getByRole('button', { name: /Dar \d+ puntos/ }));
    await shot(A, '21-premio-parcial');
    await d.getByRole('button', { name: /Dar \d+ puntos/ }).click();
    await sleep(700);
    d = await review('Regar las plantas');
    await d.getByRole('radio', { name: /Devolver para que la arregle/ }).click();
    await d.getByRole('button', { name: 'No está hecha' }).click();
    await shot(A, '22-devolver');
    await d.getByRole('button', { name: 'Devolver para que la arregle' }).last().click();
    await sleep(700);
    d = await review('Ordenar los zapatos');
    await d.getByRole('radio', { name: /Rechazar con penalidad/ }).click();
    await d.getByLabel('Puntos a restar').fill('5');
    await d.getByRole('button', { name: 'Mal hecha' }).click();
    await shot(A, '23-rechazar-penalidad');
    await d.getByRole('button', { name: 'Rechazar y restar' }).click();
    await sleep(700);
    // Aprobar las demás (por la API, para dejar datos de ejemplo)
    const pend = (await api(A, 'get', '/dashboard')).body.pendingApprovals ?? [];
    for (const p of pend) await api(A, 'post', `/instances/${p.id}/review`, { action: 'approve' });
    await sleep(500);
  });
  await step('hijo-resultado', async () => { await K.goto(BASE + '/'); await toTop(K, K.getByRole('heading', { name: /Para hoy/ })); await shot(K, '24-hijo-resultado-revision'); });

  // 6. Puntos, niveles, rachas, premios
  await api(A, 'post', '/adjustments/points', { userId: nora.id, delta: 120, note: 'Gracias por ayudar con la mudanza' });
  await step('premios', async () => {
    for (const r of [['Elegir la peli', '🎬', 40], ['Helado en la heladería', '🍦', 60], ['Noche de pizza', '🍕', 150]]) await api(A, 'post', '/rewards', { title: r[0], icon: r[1], costPoints: r[2] });
    await A.goto(BASE + '/premios'); await shot(A, '25-premios-adulto');
    await K.goto(BASE + '/premios'); await shot(K, '26-premios-hijo');
    await K.getByRole('button', { name: 'Canjear' }).first().click();
    await shot(K, '27-canjear');
    await K.getByRole('button', { name: /Sí, canjear/ }).click();
    await sleep(700);
    await A.goto(BASE + '/validar'); await shot(A, '28-validar-premio');
    await A.getByRole('listitem').filter({ hasText: 'Elegir la peli' }).getByRole('button', { name: 'Aprobar' }).click();
    await sleep(600);
  });
  await step('progreso', async () => { await K.goto(BASE + '/progreso'); await shot(K, '29-hijo-progreso'); });
  await step('panel', async () => { await A.goto(BASE + '/'); await shot(A, '30-panel'); });
  await step('estadisticas', async () => { await A.goto(BASE + '/estadisticas'); await shot(A, '31-estadisticas'); });

  // 7. Mesada y banco
  await step('mesada-ajustes', async () => {
    await A.goto(BASE + '/ajustes'); await shot(A, '32-ajustes');
  });
  await step('mesada', async () => {
    await A.goto(BASE + '/mesada'); await shot(A, '33-mesada-adulto');
    await A.getByRole('button', { name: 'Cerrar semana' }).click();
    await shot(A, '34-cerrar-semana');
    await A.getByRole('button', { name: 'Convertir puntos en euros' }).click();
    await sleep(900);
    await shot(A, '35-mesada-convertida');
    await A.getByRole('article').filter({ hasText: KID.name }).getByRole('button', { name: 'Pagar', exact: true }).click();
    await shot(A, '36-pagar');
    await A.getByRole('dialog').getByRole('radio', { name: 'Bizum' }).click();
    await A.getByRole('dialog').getByRole('button', { name: /^Pagar / }).click();
    await sleep(700);
    await shot(A, '37-recibo-pago');
    await A.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
  });
  await step('banco-hijo', async () => {
    await api(A, 'post', '/adjustments/points', { userId: nora.id, delta: 100, note: 'Premio extra' });
    await K.goto(BASE + '/mesada'); await shot(K, '38-hijo-mi-banco');
    await K.getByRole('button', { name: 'Canjear puntos' }).click().catch(() => K.getByRole('button', { name: /Canjear/ }).first().click());
    await sleep(500); await shot(K, '39-hijo-canjear-puntos');
    await closeDialog(K);
  });
  await step('banco-padres', async () => { await A.goto(BASE + '/mesada'); await toTop(A, A.getByRole('article', { name: `Cuenta de ${KID.name}` })); await shot(A, '40-banca-padres'); });

  // 8. Pantalla
  await step('pantalla-plan', async () => {
    await A.goto(BASE + '/ajustes');
    const plan = A.getByRole('region', { name: 'Plan semanal de pantalla' });
    const row = plan.getByRole('listitem').filter({ hasText: KID.name });
    await row.getByLabel('Minutos por semana').fill('300');
    await row.getByText('Plan semanal activo').click();
    await row.getByRole('button', { name: `Guardar el plan de ${KID.name}` }).click();
    await sleep(700);
    await sleep(4000); await plan.scrollIntoViewIfNeeded(); await shot(A, '41-plan-pantalla');
  });
  await api(A, 'post', '/screen/adjust', { userId: nora.id, delta: 45, note: 'Gracias por ayudar' });
  await step('pantalla-hijo', async () => {
    // I21: «Mi pantalla» con las dos baterías (Semana y Ganado).
    await K.goto(BASE + '/pantalla');
    await K.getByTestId('battery-earned').waitFor();
    await sleep(600); await shot(K, '42-hijo-pantalla');
  });
  await step('ajuste-pantalla', async () => {
    await A.goto(BASE + '/mesada');
    const panel = A.getByRole('article', { name: `Cuenta de ${KID.name}` });
    await panel.getByRole('button', { name: 'Ajuste de pantalla' }).click();
    const d = A.getByRole('dialog');
    await d.getByRole('radio', { name: /Habitación en orden/ }).click();
    await d.getByLabel('Nota amable (opcional)').fill('Mañana lo recogemos juntos');
    await shot(A, '43-ajuste-pantalla');
    await d.getByRole('button', { name: 'Aplicar ajuste' }).click();
    await sleep(700);
    await panel.getByRole('button', { name: 'Ajuste de pantalla' }).click();
    const d2 = A.getByRole('dialog');
    await d2.getByRole('radio', { name: /Respeto en familia/ }).click();
    await d2.getByLabel('Días de pausa').fill('1');
    await shot(A, '44-pausa-pantalla');
    await d2.getByRole('button', { name: 'Aplicar ajuste' }).click();
    await sleep(900);
    await K.goto(BASE + '/'); await sleep(1200); await shot(K, '45-hijo-pausa');
    await A.getByRole('article', { name: `Cuenta de ${KID.name}` }).getByRole('button', { name: 'Terminar pausa' }).click().catch(() => {});
    await sleep(600);
  });

  // 9. Avisos, dispositivo de confianza
  await step('avisos', async () => { await A.goto(BASE + '/avisos'); await shot(A, '46-avisos'); });
  await step('campana', async () => { await K.goto(BASE + '/'); await K.getByRole('button', { name: /avisos|notificaciones/i }).first().click().catch(() => {}); await sleep(600); await shot(K, '47-hijo-campana'); });
  await step('administracion', async () => {
    await A.goto(BASE + '/');
    await A.getByRole('link', { name: 'Administración' }).first().click().catch(async () => { await A.goto(BASE + '/administracion'); });
    await A.getByLabel('Tu contraseña').fill(ADULT.pass);
    await A.getByRole('button', { name: 'Continuar' }).click();
    await A.getByAltText('Código QR para la aplicación de autenticación').waitFor();
    const secret = (await A.getByTestId('totp-secret').textContent());
    await shot(A, '48-admin-2pasos');
    await A.getByLabel('Código de 6 cifras').fill(totp(secret));
    await A.getByRole('button', { name: 'Activar' }).click();
    await A.getByText('Códigos de recuperación', { exact: true }).waitFor();
    await A.getByRole('button', { name: 'Ya los he guardado' }).click();
    await sleep(800);
    await shot(A, '49-admin-dispositivo');
  });
  await step('modo-oscuro', async () => { await A.goto(BASE + '/'); await A.getByRole('button', { name: 'Modo oscuro' }).click(); await shot(A, '50-modo-oscuro'); await A.getByRole('button', { name: /Modo claro/ }).click().catch(() => {}); });

  // Privacidad, descarga y borrado de datos (apartado 13 del manual)
  await step('privacidad-ajustes', async () => {
    await A.goto(BASE + '/ajustes');
    await toTop(A, A.getByRole('region', { name: 'Privacidad y datos' }), 24);
    await shot(A, '51-ajustes-privacidad');
  });
  await step('borrar-hijo', async () => {
    await A.goto(BASE + '/familia');
    await A.getByRole('button', { name: `Editar a ${KID2.name}` }).click();
    await A.getByRole('dialog').getByRole('button', { name: /Borrar los datos de/ }).scrollIntoViewIfNeeded();
    await shot(A, '52-borrar-hijo');
    await closeDialog(A);
  });
  await step('borrar-familia', async () => {
    await A.goto(BASE + '/ajustes');
    await A.getByRole('button', { name: /Borrar la familia entera/ }).click();
    await A.getByRole('dialog').getByLabel(/Escribe BORRAR MI FAMILIA/).fill('borrar mi');
    await shot(A, '53-borrar-familia');
    await closeDialog(A);
  });
  await step('politica', async () => { await A.goto(BASE + '/privacidad'); await shot(A, '54-politica-privacidad'); });
} finally {
  await browser.close();
  stopServer(server);
}
console.log('Fallos:', fails.length ? fails.join(', ') : 'ninguno');
process.exit(0);
