import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect, devices, type Browser, type Locator, type Page } from '@playwright/test';

/** Código TOTP (RFC 6238) a partir de la clave que muestra la pantalla, como haría la app de autenticación. */
function totp(secret: string, ms = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secret.replace(/\s/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/**
 * Recorrido completo de una familia real: dos adultos y dos hijos.
 * Las pruebas son secuenciales y comparten estado (misma base de datos E2E).
 */
const SHOTS = '../docs/capturas/e2e';
const ADULT = { user: 'ana', pass: 'contrasena-ana', name: 'Ana' };
const KID = { user: 'lucia', pin: '1414', name: 'Lucía' };
const TASK = 'Poner el lavavajillas';
const REWARD = 'Elegir la peli';

let adult: Page;
let kid: Page;

async function login(page: Page, user: string, pass: string, child = false) {
  await page.goto('/');
  if (child) await page.getByRole('radio', { name: 'Soy hijo/a' }).click();
  await page.getByLabel('Usuario').fill(user);
  await page.getByLabel(child ? 'PIN' : 'Contraseña').fill(pass);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function api(page: Page, method: 'get' | 'post', path: string, data?: unknown, headers: Record<string, string> = {}) {
  const res = await page.request[method](`/api${path}`, { data, headers: { 'X-Mesada': '1', ...headers } });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** Escribe un importe con el teclado numérico de la hoja («4,00»); `fresh` borra antes lo que hubiera. */
async function keypad(scope: Locator, text: string, fresh = false) {
  if (fresh) for (let i = 0; i < 8; i++) await scope.getByRole('button', { name: 'Borrar' }).click();
  for (const ch of text) await scope.getByRole('button', { name: ch === ',' ? 'Coma' : ch, exact: true }).click();
}

async function newAdultPage(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
  return ctx.newPage();
}

async function newPhonePage(browser: Browser) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-ES', timezoneId: 'Europe/Madrid' });
  return ctx.newPage();
}

test.describe.serial('Familia completa', () => {
  test.beforeAll(async ({ browser }) => {
    adult = await newAdultPage(browser);
    kid = await newPhonePage(browser);
  });

  test('primer arranque: un adulto crea la familia', async () => {
    await adult.goto('/');
    await expect(adult).toHaveURL(/configurar/);
    await adult.getByLabel('Nombre de la familia').fill('Familia Prueba');
    await adult.getByLabel('Tu nombre').fill(ADULT.name);
    await adult.getByLabel('Usuario').fill(ADULT.user);
    await adult.getByLabel('Correo').fill('ana@example.com');
    await adult.getByLabel('Contraseña').fill(ADULT.pass);
    await adult.getByRole('button', { name: 'Crear familia' }).click();
    await expect(adult.getByRole('heading', { name: 'Familia', exact: true })).toBeVisible();
  });

  test('añade al otro adulto y a los dos hijos', async () => {
    const add = async (role: 'adult' | 'child', name: string, user: string, pass: string) => {
      await adult.getByRole('button', { name: 'Añadir' }).first().click();
      const d = adult.getByRole('dialog');
      if (role === 'adult') await d.getByRole('radio', { name: 'Adulto' }).click();
      await d.getByLabel('Nombre', { exact: true }).fill(name);
      await d.getByLabel('Usuario para entrar').fill(user);
      await d.getByLabel(role === 'child' ? 'PIN' : 'Contraseña').fill(pass);
      await d.getByRole('button', { name: 'Añadir' }).click();
      await expect(adult.getByText(`${name} se ha unido a la familia`)).toBeVisible();
    };
    await add('adult', 'Carlos', 'carlos', 'contrasena-carlos');
    await add('child', KID.name, KID.user, KID.pin);
    await add('child', 'Hugo', 'hugo', '1111');
    await expect(adult.getByText('@lucia')).toBeVisible();
    await expect(adult.getByText('@hugo')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/01-familia.png`, fullPage: true });
  });

  test('inicio de sesión incorrecto muestra un error claro', async ({ browser }) => {
    const p = await newPhonePage(browser);
    await login(p, KID.user, '0000', true);
    await expect(p.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos');
    await p.context().close();
  });

  test('el adulto crea una tarea diaria y la asigna a un hijo', async () => {
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByRole('radio', { name: '🍽️' }).click();
    await d.getByLabel('Nombre de la tarea').fill(TASK);
    await d.getByRole('button', { name: KID.name }).click();
    await expect(d.getByLabel('Puntos', { exact: true })).toHaveValue('20');
    await adult.screenshot({ path: `${SHOTS}/02-nueva-tarea.png` });
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByText('Tarea creada')).toBeVisible();
    await expect(adult.getByRole('listitem').filter({ hasText: TASK })).toContainText('Cada día');
  });

  test('el hijo entra desde el móvil y marca la tarea como hecha', async () => {
    await login(kid, KID.user, KID.pin, true);
    await expect(kid.getByRole('heading', { name: 'Te queda 1 tarea' })).toBeVisible();
    // Sin desbordamiento horizontal en móvil
    const overflow = await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await kid.screenshot({ path: `${SHOTS}/03-hijo-hoy.png` });
    await kid.getByRole('button', { name: `Marcar «${TASK}» como hecha` }).click();
    await expect(kid.getByText(`«${TASK}» enviada. Falta que la validen.`)).toBeVisible();
    await expect(kid.getByText('Esperando validación')).toBeVisible();
    // Aún sin puntos
    const me = await api(kid, 'get', '/me');
    const w = await api(kid, 'get', `/wallet/${me.body.user.id}`);
    expect(w.body.wallet.points_available).toBe(0);
  });

  test('un hijo no puede aprobarse su propia tarea ni tocar puntos o pagos', async () => {
    const inst = (await api(kid, 'get', '/instances')).body.instances[0];
    expect((await api(kid, 'post', `/instances/${inst.id}/review`, { approve: true })).status).toBe(403);
    const me = (await api(kid, 'get', '/me')).body.user;
    expect((await api(kid, 'post', '/adjustments/points', { userId: me.id, delta: 500, note: 'yo' })).status).toBe(403);
    expect((await api(kid, 'post', '/payments', { userId: me.id, amountCents: 100 })).status).toBe(403);
    expect((await api(kid, 'post', '/allowance/settle', {})).status).toBe(403);
    // Sin cabecera anti-CSRF, ni siquiera un adulto puede mutar
    const raw = await adult.request.post(`/api/instances/${inst.id}/review`, { data: { approve: true } });
    expect(raw.status()).toBe(403);
    // Las pantallas de adulto no existen para el hijo
    await kid.goto('/validar');
    await expect(kid).toHaveURL(/\/$/);
  });

  test('el adulto aprueba y los puntos se acreditan una sola vez', async () => {
    await adult.goto('/validar');
    await adult.screenshot({ path: `${SHOTS}/04-validar.png`, fullPage: true });
    await adult.getByRole('button', { name: `Aprobar «${TASK}» de ${KID.name}` }).click();
    await expect(adult.getByText('Tarea aprobada')).toBeVisible();
    await expect(adult.getByText('Nada por validar')).toBeVisible();
    // Reintento duplicado (p. ej. doble toque u otro adulto)
    const inst = (await api(kid, 'get', '/instances')).body.instances[0];
    expect((await api(adult, 'post', `/instances/${inst.id}/review`, { approve: true })).status).toBe(409);
    await kid.goto('/mesada');
    await expect(kid.getByRole('region', { name: 'Cuenta de puntos' })).toContainText('20');
    await kid.goto('/');
    await expect(kid.getByText('Todo hecho por hoy')).toBeVisible();
  });

  test('el hijo canjea una recompensa y el adulto la aprueba', async () => {
    await adult.goto('/premios');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Recompensa').fill(REWARD);
    await d.getByLabel('Cuesta (puntos)').fill('10');
    await d.getByRole('button', { name: 'Guardar' }).click();
    await expect(adult.getByText(REWARD)).toBeVisible();

    await kid.goto('/premios');
    await expect(kid.getByText('Tienes 20 puntos para canjear.')).toBeVisible();
    await kid.getByRole('button', { name: 'Canjear' }).click();
    await kid.getByRole('button', { name: 'Sí, canjear 10 puntos' }).click();
    await expect(kid.getByText('¡Pedida! Un adulto tiene que aprobarla.')).toBeVisible();
    await expect(kid.getByText('Tienes 10 puntos para canjear.')).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/05-hijo-premios.png`, fullPage: true });

    await adult.goto('/validar');
    await adult.getByRole('listitem').filter({ hasText: REWARD }).getByRole('button', { name: 'Aprobar' }).click();
    await expect(adult.getByText('Recompensa aprobada')).toBeVisible();
  });

  test('cierre semanal: los puntos se convierten en euros', async () => {
    await adult.goto('/mesada');
    await adult.getByRole('button', { name: 'Cerrar semana' }).click();
    await adult.getByRole('button', { name: 'Convertir puntos en euros' }).click();
    // 10 puntos restantes × (5 € / 100 pts) = 0,50 €
    await expect(adult.getByText('Periodo cerrado: 0,50 € convertidos')).toBeVisible();
    const card = adult.getByRole('article').filter({ hasText: KID.name });
    await expect(card.getByText('Dinero · por pagar').locator('..')).toContainText('0,50 €');
    // Repetir el cierre no duplica
    const again = await api(adult, 'post', '/allowance/settle', {});
    expect(again.body.results.every((r: any) => r.ok === false)).toBe(true);
    await adult.screenshot({ path: `${SHOTS}/06-mesada.png`, fullPage: true });
  });

  test('registro de pago real sin duplicados', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    // Dos envíos con la misma clave de idempotencia = un solo pago
    const key = { 'Idempotency-Key': 'e2e-pago-duplicado-1' };
    const a = await api(adult, 'post', '/payments', { userId: me.id, amountCents: 20, method: 'cash' }, key);
    const b = await api(adult, 'post', '/payments', { userId: me.id, amountCents: 20, method: 'cash' }, key);
    expect(a.status).toBe(200);
    expect(b.body.payment.duplicate).toBe(true);
    // Pagar más de lo debido se rechaza
    expect((await api(adult, 'post', '/payments', { userId: me.id, amountCents: 5000 })).status).toBe(409);

    await adult.goto('/mesada');
    const card = adult.getByRole('article').filter({ hasText: KID.name });
    await expect(card.getByText('Dinero · por pagar').locator('..')).toContainText('0,30 €');
    await card.getByRole('button', { name: 'Pagar', exact: true }).click();
    const d = adult.getByRole('dialog');
    // El importe viene ya puesto con lo que debe, y el botón dice la acción y la cantidad
    await d.getByRole('radio', { name: 'Bizum' }).click();
    await d.getByRole('button', { name: 'Pagar 0,30 €' }).click();
    const receipt = adult.getByRole('dialog', { name: 'Recibo: Pago registrado' });
    await expect(receipt).toContainText('0,30 €');
    await expect(receipt).toContainText('Bizum');
    await receipt.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(card.getByText('Dinero · por pagar').locator('..')).toContainText('0,00 €');
    await expect(card).toContainText('pagado 0,50 €');

    const w = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet;
    expect(w).toMatchObject({ points_available: 0, cents_pending: 0, cents_converted_total: 50, cents_paid_total: 50 });
    await kid.goto('/mesada');
    await expect(kid.getByText('Ya cobrado en total: 0,50 €')).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/07-hijo-dinero.png`, fullPage: true });
  });

  test('el historial registra las operaciones económicas', async () => {
    await adult.goto('/actividad');
    await expect(adult.getByText(/registró un pago de 0,30/)).toBeVisible();
    await expect(adult.getByText(/cerró el periodo: 10 pts → 0,50/)).toBeVisible();
    await expect(adult.getByText(/aprobó una tarea \(20 pts\)/)).toBeVisible();
  });

  test('navegación móvil del adulto y modo oscuro', async ({ browser }) => {
    const p = await newPhonePage(browser);
    await login(p, ADULT.user, ADULT.pass);
    await expect(p.getByRole('heading', { name: 'Panel familiar' })).toBeVisible();
    const nav = p.getByRole('navigation', { name: 'Principal' }).last();
    await nav.getByRole('link', { name: 'Tareas' }).click();
    await expect(p.getByRole('heading', { name: 'Tareas' })).toBeVisible();
    await nav.getByRole('button', { name: 'Más' }).click();
    await p.getByRole('dialog').getByRole('link', { name: 'Estadísticas' }).click();
    await expect(p.getByRole('heading', { name: 'Estadísticas' })).toBeVisible();
    await p.getByRole('button', { name: 'Modo oscuro' }).click();
    await expect(p.locator('html')).toHaveClass(/dark/);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await p.goto('/');
    await p.screenshot({ path: `${SHOTS}/08-adulto-movil-oscuro.png`, fullPage: true });
    await p.context().close();
  });

  test('los padres configuran los avisos y WhatsApp queda bloqueado para menores de 13', async () => {
    await adult.goto('/avisos');
    await expect(adult.getByText(/modo simulado/)).toBeVisible();
    const lucia = adult.getByRole('article').filter({ hasText: KID.name });
    await lucia.getByRole('button', { name: 'Contacto' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Teléfono de WhatsApp').fill('600 11 22 33');
    await d.getByText('Consentimiento para WhatsApp').click();
    await d.getByRole('button', { name: 'Guardar' }).click();
    await expect(adult.getByText('Datos de contacto guardados')).toBeVisible();
    // Lucía no tiene año de nacimiento: WhatsApp sigue bloqueado y se explica por qué
    await expect(lucia).toContainText('WhatsApp: Falta el año de nacimiento');
    const box = lucia.getByLabel(`Recordatorio de tareas del día por WhatsApp para ${KID.name}`);
    await expect(box).toBeDisabled();
    // Con el año (14 años) se habilita
    await adult.goto('/familia');
    await adult.getByRole('button', { name: `Editar a ${KID.name}` }).click();
    await adult.getByRole('dialog').getByLabel('Año de nacimiento').fill('2012');
    await adult.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await adult.goto('/avisos');
    await expect(box).toBeEnabled();
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await adult.screenshot({ path: `${SHOTS}/09-avisos.png`, fullPage: true });
    // El hijo ve sus avisos, pero no puede cambiarlos
    await kid.goto('/avisos');
    await expect(kid.getByText('Tus avisos los configuran tus padres.')).toBeVisible();
    await expect(kid.getByRole('checkbox').first()).toBeDisabled();
  });

  test('enlace de recuperación de contraseña sin revelar cuentas', async ({ browser }) => {
    const p = await newPhonePage(browser);
    await p.goto('/');
    await p.getByRole('link', { name: '¿Has olvidado la contraseña?' }).click();
    await p.getByLabel('Usuario o correo').fill('no-existe');
    await p.getByRole('button', { name: 'Enviar enlace' }).click();
    await expect(p.getByRole('status')).toHaveText('Si la cuenta existe y tiene correo, te hemos enviado un enlace.');
    await p.context().close();
  });

  test('el adulto pone su WhatsApp en el perfil para recibir lo que hay que validar', async () => {
    await adult.goto('/');
    await adult.getByRole('link', { name: /Recibe por WhatsApp/ }).click();
    await adult.getByLabel('Teléfono móvil').fill('600 11 22 33');
    await adult.getByText('Recibir avisos por WhatsApp').click();
    await expect(adult.getByRole('checkbox', { name: /Recibir avisos por WhatsApp/ })).toBeChecked();
    await adult.getByRole('button', { name: 'Guardar WhatsApp' }).click();
    await expect(adult.getByText('WhatsApp guardado')).toBeVisible();
    const me = await api(adult, 'get', '/me');
    expect(me.body.user.phone).toBe('+34600112233');
    await adult.goto('/');
    await expect(adult.getByRole('link', { name: /Recibe por WhatsApp/ })).toHaveCount(0);
  });

  test('administración con verificación en dos pasos', async () => {
    await adult.goto('/');
    await adult.getByRole('link', { name: 'Administración' }).first().click();
    await adult.getByLabel('Tu contraseña').fill(ADULT.pass);
    await adult.getByRole('button', { name: 'Continuar' }).click();
    await expect(adult.getByAltText('Código QR para la aplicación de autenticación')).toBeVisible();
    const secret = (await adult.getByTestId('totp-secret').textContent())!;
    await adult.getByLabel('Código de 6 cifras').fill(totp(secret));
    await adult.getByRole('button', { name: 'Activar' }).click();
    await expect(adult.getByText('Códigos de recuperación', { exact: true })).toBeVisible();
    await adult.getByRole('button', { name: 'Ya los he guardado' }).click();
    await expect(adult.getByText('Activas en 7 días')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/11-administracion.png`, fullPage: true });
    // Sin datos económicos de las familias
    await adult.getByRole('radio', { name: 'Familias' }).click();
    await adult.getByRole('button', { name: /La tuya/ }).click();
    await expect(adult.getByText('@lucia')).toBeVisible();
    await expect(adult.getByText(/€|pts/)).toHaveCount(0);
    await adult.keyboard.press('Escape');
    // Salir obliga a pedir el código otra vez
    await adult.getByRole('radio', { name: 'Ajustes' }).click();
    await adult.getByRole('button', { name: 'Salir de la administración' }).click();
    await expect(adult.getByText('Confirma que eres tú')).toBeVisible();
    // Un hijo no tiene acceso
    expect((await api(kid, 'get', '/admin/status')).status).toBe(403);
  });

  test('hora límite y bono visible: el hijo gana minutos de pantalla', async () => {
    const CAMA = 'Tender la cama';
    const weekend = ['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Madrid' }).format(new Date()));
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill(CAMA);
    await d.getByRole('button', { name: KID.name }).click();
    await d.locator('summary', { hasText: 'Hora límite' }).click();
    await d.getByLabel('Lunes a viernes').fill('23:59');
    await d.getByLabel('Fin de semana y festivos').fill('23:58');
    await d.getByLabel('Valor si llega tarde (%)').fill('50');
    await d.locator('summary', { hasText: 'Bono extra' }).click();
    await d.getByLabel('Tipo de bono').selectOption('screen');
    await d.getByLabel('Minutos de pantalla').fill('30');
    await adult.screenshot({ path: `${SHOTS}/12-tarea-hora-bono.png` });
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByText('Tarea creada')).toBeVisible();
    await expect(adult.getByRole('listitem').filter({ hasText: CAMA })).toContainText('+30 min de pantalla');

    // El hijo ve la hora límite vigente (L–V o fin de semana), la cuenta atrás y el bono
    await kid.setViewportSize({ width: 375, height: 812 });
    await kid.goto('/');
    const row = kid.getByRole('listitem').filter({ hasText: CAMA }).first();
    await expect(row).toContainText(`Antes de las ${weekend ? '23:58' : '23:59'}`);
    await expect(row).toContainText('quedan');
    await expect(row).toContainText('+30 min de pantalla');
    expect(await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await kid.screenshot({ path: `${SHOTS}/13-hijo-hora-limite-375.png`, fullPage: true });
    await kid.getByRole('button', { name: `Marcar «${CAMA}» como hecha` }).click();
    await expect(kid.getByText(`«${CAMA}» enviada. Falta que la validen.`)).toBeVisible();

    await adult.goto('/validar');
    await adult.getByRole('button', { name: `Aprobar «${CAMA}» de ${KID.name}` }).click();
    await expect(adult.getByText('Tarea aprobada')).toBeVisible();

    await kid.goto('/mesada');
    const screen = kid.getByText('Mi tiempo de pantalla').locator('xpath=ancestor::section');
    await expect(screen).toContainText('30 min');
    await kid.screenshot({ path: `${SHOTS}/14-hijo-pantalla-375.png`, fullPage: true });
    // El adulto ve el saldo en la mesada
    await adult.goto('/mesada');
    await expect(adult.getByText('Pantalla:').first()).toContainText('30 min');
  });

  test('tarea que marca un adulto: «No cumplida» resta minutos y el hijo no puede reportarla', async () => {
    const COCHE = 'Estar en el coche a la hora';
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill(COCHE);
    await d.getByRole('button', { name: KID.name }).click();
    await d.getByLabel('Puntos', { exact: true }).fill('0');
    await d.getByLabel('La marca un adulto').check({ force: true });
    await d.getByLabel('Si no se cumple (min)').fill('15');
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByText('Tarea creada')).toBeVisible();

    // El hijo la ve, pero no hay botón de «hecha» y la API se lo impide
    await kid.goto('/');
    const row = kid.getByRole('listitem').filter({ hasText: COCHE }).first();
    await expect(row).toContainText('La marca un adulto');
    await expect(kid.getByRole('button', { name: `Marcar «${COCHE}» como hecha` })).toHaveCount(0);
    const inst = (await api(kid, 'get', '/instances')).body.instances.find((i: any) => i.title === COCHE);
    expect((await api(kid, 'post', `/instances/${inst.id}/complete`, {})).status).toBe(403);
    expect((await api(kid, 'post', `/instances/${inst.id}/check`, { met: true })).status).toBe(403);

    const me0 = (await api(kid, 'get', '/me')).body.user;
    const pointsBefore = (await api(kid, 'get', `/wallet/${me0.id}`)).body.wallet.points_available;
    await adult.goto('/validar');
    await adult.screenshot({ path: `${SHOTS}/15-validar-comprobar.png`, fullPage: true });
    await adult.getByRole('button', { name: `No cumplida: «${COCHE}» de ${KID.name}` }).click();
    await expect(adult.getByText('No cumplida: −15 min de pantalla')).toBeVisible();

    await kid.goto('/mesada');
    await expect(kid.getByText('Mi tiempo de pantalla').locator('xpath=ancestor::section')).toContainText('15 min');
    // Corregir: pasa a cumplida y se devuelven exactamente los 15 minutos
    await adult.getByRole("button", { name: `Cumplida: «${COCHE}» de ${KID.name}`, exact: true }).click();
    await expect(adult.getByText('Marcada como cumplida')).toBeVisible();
    const me = (await api(kid, 'get', '/me')).body.user;
    expect((await api(kid, 'get', `/screen/${me.id}`)).body.balance).toBe(30);
    // Los puntos no se han tocado por la penalización
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.points_available).toBe(pointsBefore);
  });

  test('sorpresa: el hijo no ve su contenido y se revela con animación al abrir la app', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const me = (await api(kid, 'get', '/me')).body.user;
    const created = await api(adult, 'post', '/tasks', {
      title: 'Ordenar el cuarto', points: 10, recurrence: 'once', startDate: today, assignees: [me.id],
      bonus: { kind: 'text', text: 'Helado el sábado', surprise: true },
    });
    expect(created.status).toBe(200);
    await kid.goto('/');
    const row = kid.getByRole('listitem').filter({ hasText: 'Ordenar el cuarto' });
    await expect(row).toContainText('Sorpresa');
    await expect(kid.getByText('Helado el sábado')).toHaveCount(0);
    const inst = (await api(kid, 'get', '/instances')).body.instances.find((i: any) => i.title === 'Ordenar el cuarto');
    expect(JSON.stringify(inst)).not.toContain('Helado');
    expect((await api(kid, 'post', `/instances/${inst.id}/complete`, {})).status).toBe(200);
    expect((await api(adult, 'post', `/instances/${inst.id}/review`, { approve: true })).status).toBe(200);
    await kid.goto('/');
    const modal = kid.getByRole('dialog', { name: 'Sorpresa' });
    await expect(modal).toContainText('Helado el sábado');
    await kid.screenshot({ path: `${SHOTS}/16-sorpresa-375.png` });
    await modal.getByRole('button', { name: '¡Genial!' }).click();
    await expect(modal).toBeHidden();
    // El adulto lo ve como pendiente de cumplir y lo marca
    await adult.goto('/validar');
    await adult.getByRole('button', { name: 'Cumplido' }).click();
    await expect(adult.getByText('Marcado como cumplido')).toBeVisible();
  });

  test('el adulto paga desde el Panel y el hijo ve el aviso con la forma de pago', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    expect((await api(adult, 'post', '/adjustments/money', { userId: me.id, deltaCents: 2000, note: 'Regalo de la abuela' })).status).toBe(200);
    const before = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending;

    await adult.goto('/');
    const card = adult.getByRole('article').filter({ hasText: KID.name });
    await card.getByRole('button', { name: 'Pagar', exact: true }).click();
    const d = adult.getByRole('dialog');
    await expect(d.getByRole('button', { name: `Pagar ${(before / 100).toFixed(2).replace('.', ',')}`, exact: false })).toBeVisible();
    await keypad(d, '5,00', true);
    await d.getByRole('radio', { name: 'Transferencia' }).click();
    await d.getByRole('button', { name: 'Pagar 5,00 €' }).click();
    await expect(adult.getByRole('dialog', { name: 'Recibo: Pago registrado' })).toContainText('Transferencia');
    await adult.getByRole('dialog', { name: 'Recibo: Pago registrado' }).getByRole('button', { name: 'Cerrar', exact: true }).click();
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending).toBe(before - 500);

    // El aviso del hijo (campana) dice quién, cuánto, cómo y cuánto le queda
    const n = (await api(kid, 'get', '/notifications')).body.notifications.find((x: any) => x.kind === 'payment');
    expect(n.title).toBe(`${ADULT.name} te ha pagado 5,00 € por transferencia.`);
    expect(n.body).toBe(`Te quedan ${((before - 500) / 100).toFixed(2).replace('.', ',')} €.`);
    await adult.screenshot({ path: `${SHOTS}/16-panel-pagar.png`, fullPage: true });
  });

  test('el hijo pide minutos de pantalla y el adulto los aprueba', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    await api(adult, 'post', '/screen/adjust', { userId: me.id, delta: 60, note: 'Fin de semana' });
    const before = (await api(kid, 'get', `/screen/${me.id}`)).body.balance;

    await kid.setViewportSize({ width: 375, height: 812 });
    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Pedir pantalla' }).click();
    const kd = kid.getByRole('dialog');
    await kd.getByLabel('Minutos').fill('10');
    await kd.getByRole('radio', { name: 'Tele' }).click();
    await kd.getByRole('button', { name: 'Enviar petición' }).click();
    await expect(kid.getByText('Petición enviada. Un adulto la verá')).toBeVisible();
    await expect(kid.getByText('10 min de tele')).toBeVisible();
    // Solo una abierta por tipo
    await expect(kid.getByRole('button', { name: 'Pedir pantalla' })).toBeDisabled();
    expect(await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await kid.screenshot({ path: `${SHOTS}/17-hijo-pedir-pantalla-375.png`, fullPage: true });

    await adult.goto('/validar');
    await expect(adult.getByText('Pide 10 min de tele')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/18-validar-peticiones.png`, fullPage: true });
    await adult.getByRole('button', { name: `Aprobar la petición de ${KID.name}` }).click();
    await adult.getByRole('dialog').getByRole('button', { name: 'Dar minutos y aprobar' }).click();
    await expect(adult.getByText('Petición aprobada')).toBeVisible();
    expect((await api(kid, 'get', `/screen/${me.id}`)).body.balance).toBe(before - 10);

    const n = (await api(kid, 'get', '/notifications')).body.notifications.find((x: any) => x.kind === 'payout_decided');
    expect(n.title).toBe(`${ADULT.name} te ha dado 10 min de tele.`);
    expect(n.body).toBe(`Te quedan ${before - 10} min.`);
    await kid.goto('/mesada');
    await expect(kid.getByText('Aprobada', { exact: true }).first()).toBeVisible();
  });

  test('el hijo anota su pantalla, el adulto la confirma y gana 5 puntos por honesto', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    const bal = (await api(kid, 'get', `/screen/${me.id}`)).body.balance;
    const pts = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.points_available;

    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Anotar pantalla' }).click();
    const kd = kid.getByRole('dialog');
    await kd.getByLabel('Minutos').fill('20');
    await kd.getByRole('radio', { name: 'Videojuegos' }).click();
    await kd.getByRole('button', { name: 'Anotar', exact: true }).click();
    await expect(kid.getByText('Anotado: 20 min de videojuegos. Falta que lo confirme un adulto')).toBeVisible();
    // Se resta al momento y aún no hay puntos
    expect((await api(kid, 'get', `/screen/${me.id}`)).body.balance).toBe(bal - 20);
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.points_available).toBe(pts);
    await expect(kid.getByText('Por confirmar')).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/19-hijo-anotar-pantalla-375.png`, fullPage: true });

    await adult.goto('/validar');
    await expect(adult.getByText(`${KID.name} anotó 20 min de videojuegos`)).toBeVisible();
    await adult.getByRole('button', { name: `Confirmar la pantalla de ${KID.name}` }).click();
    await expect(adult.getByText('Confirmada: +5 puntos por ser honesto')).toBeVisible();
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.points_available).toBe(pts + 5);

    await kid.goto('/mesada');
    await expect(kid.getByText('Confirmado')).toBeVisible();
    const notes = (await api(kid, 'get', '/notifications')).body.notifications;
    expect(notes.some((x: any) => x.title === '+5 puntos por ser honesto')).toBe(true);
  });

  test('banco: el hijo canjea puntos por dinero al momento y los adultos lo ven', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    await api(adult, 'post', '/adjustments/points', { userId: me.id, delta: 100, note: 'Para el banco' });
    const before = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet;

    await kid.setViewportSize({ width: 375, height: 812 });
    await kid.goto('/mesada');
    // Dos cuentas con número de cuenta de juguete
    await expect(kid.getByRole('region', { name: 'Cuenta de dinero' })).toContainText(/ES00 DIPL \d{4} \d{4}/);
    await expect(kid.getByRole('region', { name: 'Cuenta de puntos' })).toContainText(String(before.points_available));
    await kid.getByRole('button', { name: 'Canjear', exact: true }).click();
    const d = kid.getByRole('dialog');
    await keypad(d, '50');
    await expect(d.getByText('Recibes 2,50 €')).toBeVisible();
    await d.getByRole('button', { name: 'Canjear 50 pts' }).click();
    const rc = kid.getByRole('dialog', { name: 'Recibo: Canje hecho' });
    await expect(rc).toContainText('+2,50 €');
    await expect(rc).toContainText(/CJ-[0-9A-Z]{5}/);
    await rc.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const after = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet;
    expect(after.points_available).toBe(before.points_available - 50);
    expect(after.cents_pending).toBe(before.cents_pending + 250);
    // El extracto lo muestra con el saldo tras el movimiento
    await expect(kid.getByText('Canje de 50 puntos')).toBeVisible();
    await expect(kid.getByRole('tab', { name: 'Todo' })).toHaveAttribute('aria-selected', 'true');
    expect(await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await kid.screenshot({ path: `${SHOTS}/20-hijo-banco-375.png`, fullPage: true });

    const n = (await api(adult, 'get', '/notifications')).body.notifications.find((x: any) => x.kind === 'points_exchanged');
    expect(n.title).toBe(`${KID.name} ha cambiado 50 puntos por 2,50 €`);
  });

  test('banco: el hijo retira dinero y el adulto lo paga', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    await api(adult, 'post', '/adjustments/money', { userId: me.id, deltaCents: 1000, note: 'Para el banco' });
    const before = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending;

    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Retirar', exact: true }).click();
    const kd = kid.getByRole('dialog');
    // Teclado numérico: el importe se escribe con los botones grandes y el botón principal lo repite
    await keypad(kd, '4,00');
    await expect(kd.getByText('Retiros esta semana: 0 de 2')).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/26-teclado-retirar-375.png` });
    await kd.getByRole('button', { name: 'Retirar 4,00 €' }).click();
    // Recibo en lugar del aviso emergente
    const rc = kid.getByRole('dialog', { name: 'Recibo: Retiro solicitado' });
    await expect(rc).toContainText('−4,00 €');
    await expect(rc).toContainText('Pendiente de pago');
    await expect(rc).toContainText(/RT-[0-9A-Z]{5}/);
    await expect(rc).toContainText('Cuenta de dinero');
    await expect(rc.getByRole('button', { name: 'Compartir' })).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/25-recibo-retiro-375.png` });
    await rc.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(rc).toBeHidden();
    await expect(kid.getByText('Retiro de 4,00 €')).toBeVisible();

    await adult.goto('/validar');
    await expect(adult.getByText('Retiro de 4,00 €')).toBeVisible();
    await adult.getByRole('button', { name: `Aprobar la petición de ${KID.name}` }).click();
    await adult.getByRole('dialog').getByRole('button', { name: 'Pagar 4,00 €' }).click();
    const pr = adult.getByRole('dialog', { name: 'Recibo: Pago registrado' });
    await expect(pr).toContainText('Efectivo');
    await pr.getByRole('button', { name: 'Cerrar', exact: true }).click();
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending).toBe(before - 400);
    const n = (await api(kid, 'get', '/notifications')).body.notifications.find((x: any) => x.kind === 'payout_decided' && x.title.includes('4,00'));
    expect(n.title).toBe(`${ADULT.name} te ha pagado 4,00 € en efectivo.`);
  });

  test('banca familiar: el adulto aprueba un retiro desde «Por aprobar» eligiendo la forma de pago', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    const before = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending;
    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Retirar', exact: true }).click();
    const kd = kid.getByRole('dialog');
    await keypad(kd, '1,50');
    await kd.getByRole('button', { name: 'Retirar 1,50 €' }).click();
    await kid.getByRole('dialog', { name: 'Recibo: Retiro solicitado' }).getByRole('button', { name: 'Cerrar', exact: true }).click();
    // Ya hay un retiro esperando: el botón lo dice y no se puede pedir otro
    await expect(kid.getByRole('button', { name: /^Retirar/ })).toHaveAttribute('aria-disabled', 'true');

    await adult.goto('/mesada');
    const list = adult.getByRole('region', { name: 'Por aprobar' });
    await expect(list).toContainText('Retiro de 1,50 €');
    await expect(adult.getByRole('heading', { name: /Por aprobar/ })).toContainText('1');
    await adult.screenshot({ path: `${SHOTS}/27-banca-por-aprobar.png`, fullPage: true });
    const phone = await newPhonePage(adult.context().browser()!);
    await login(phone, ADULT.user, ADULT.pass);
    await expect(phone.getByText(`Hola, ${ADULT.name}`)).toBeVisible();
    await phone.goto('/mesada');
    await expect(phone.getByRole('region', { name: 'Por aprobar' })).toContainText('Retiro de 1,50 €');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await phone.screenshot({ path: `${SHOTS}/27-banca-por-aprobar-375.png`, fullPage: true });
    await phone.context().close();
    await adult.getByRole('button', { name: `Aprobar la petición de ${KID.name}` }).click();
    const pd = adult.getByRole('dialog');
    await pd.getByRole('radio', { name: 'Bizum' }).click();
    await pd.getByRole('button', { name: 'Pagar 1,50 €' }).click();
    const rc = adult.getByRole('dialog', { name: 'Recibo: Pago registrado' });
    await expect(rc).toContainText('Bizum');
    await rc.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(adult.getByText('Nada por aprobar. Todo al día.')).toBeVisible();
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending).toBe(before - 150);
    const n = (await api(kid, 'get', '/notifications')).body.notifications.find((x: any) => x.kind === 'payout_decided' && x.title.includes('1,50'));
    expect(n.title).toBe(`${ADULT.name} te ha pagado 1,50 € por Bizum.`);
    // El extracto del hijo lo muestra como retiro pagado
    await kid.goto('/mesada');
    await expect(kid.getByText('Retiro', { exact: true }).first()).toBeVisible();
  });

  test('banco: el hijo pide un préstamo y el adulto lo aprueba', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    // Sin tope semanal no hay préstamo y la pantalla lo explica
    await kid.goto('/mesada');
    const loanBtn = kid.getByRole('button', { name: /^Préstamo/ });
    await expect(loanBtn).toHaveAttribute('aria-disabled', 'true');
    await expect(loanBtn).toContainText('Pon un tope semanal en Ajustes');
    const patch = await adult.request.patch('/api/family', { data: { capCents: 1000 }, headers: { 'X-Mesada': '1' } });
    expect(patch.ok()).toBe(true);
    const before = (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending;

    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Préstamo', exact: true }).click();
    const kd = kid.getByRole('dialog');
    await keypad(kd, '6,00');
    await kd.getByRole('button', { name: 'Una semana menos' }).click(); // 4 → 3 semanas
    await expect(kd.getByText('3 semanas')).toBeVisible();
    await expect(kd.getByText(/Pagarás\s*2,00\s€/)).toBeVisible();
    await kd.getByRole('button', { name: 'Pedir 6,00 €' }).click();
    const lr = kid.getByRole('dialog', { name: 'Recibo: Préstamo pedido' });
    await expect(lr).toContainText('Esperando respuesta');
    await lr.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(kid.getByText('Esperando respuesta').first()).toBeVisible();

    await adult.goto('/validar');
    await expect(adult.getByText('Préstamo en 3 semanas')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/21-validar-prestamo.png`, fullPage: true });
    await adult.getByRole('button', { name: `Aprobar el préstamo de ${KID.name}` }).click();
    await expect(adult.getByText('Préstamo aprobado: el dinero ya está en su cuenta')).toBeVisible();
    expect((await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.cents_pending).toBe(before + 600);

    await kid.goto('/mesada');
    const prod = kid.getByRole('article', { name: 'Mi préstamo' });
    await expect(prod).toContainText('Quedan 3 cuotas');
    await expect(prod).toContainText('Próximo cobro');
    // La próxima cuota aparece como movimiento programado en el extracto
    await expect(kid.getByRole('region', { name: 'Próximo' })).toContainText('Cuota 1 de 3');
    // Un solo préstamo a la vez
    expect((await api(kid, 'post', '/loans', { amountCents: 100, weeks: 1 })).status).toBe(409);
  });

  test('banco: el hijo ahorra en una meta con interés y los padres ven el banco', async () => {
    const me = (await api(kid, 'get', '/me')).body.user;
    await kid.goto('/mesada');
    await kid.getByRole('button', { name: 'Nueva meta' }).click();
    const gd = kid.getByRole('dialog');
    await gd.getByLabel('¿Para qué ahorras?').fill('Vinilo');
    await gd.getByLabel('¿Cuánto cuesta? (€)').fill('20');
    await gd.getByRole('button', { name: 'Crear meta' }).click();
    await expect(kid.getByRole('listitem', { name: 'Meta Vinilo' })).toBeVisible();

    await kid.getByRole('button', { name: 'Ahorrar', exact: true }).click();
    const sd = kid.getByRole('dialog');
    await keypad(sd, '2,50');
    await sd.getByRole('button', { name: 'Ahorrar 2,50 €' }).click();
    const ar = kid.getByRole('dialog', { name: 'Recibo: Ahorro hecho' });
    await expect(ar).toContainText('Meta Vinilo');
    await ar.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(kid.getByRole('listitem', { name: 'Meta Vinilo' })).toContainText(/2,50\s€\s*de 20,00\s€/);
    await expect(kid.getByText(/Interés ganado/)).toBeVisible();
    await expect(kid.getByRole('img', { name: /Saldo de las últimas 8 semanas/ })).toBeVisible();
    expect((await api(kid, 'get', `/bank/${me.id}`)).body.bank.savings_cents).toBe(250);
    expect(await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await kid.screenshot({ path: `${SHOTS}/22-hijo-ahorros-prestamo-375.png`, fullPage: true });

    // Vista de banco de los padres
    await adult.goto('/mesada');
    const card = adult.getByRole('article').filter({ hasText: KID.name });
    await expect(adult.getByRole('heading', { name: 'Banca familiar' })).toBeVisible();
    await expect(adult.getByText('Pendiente de pagar')).toBeVisible();
    await expect(card).toContainText('Vinilo');
    await expect(card).toContainText('Préstamo');
    await expect(card).toContainText('Quedan 3 cuotas');
    await expect(card).toContainText('Al día');
    await adult.screenshot({ path: `${SHOTS}/23-mesada-banco-padres.png`, fullPage: true });
    // Y a 375 px de ancho
    const phone = await newPhonePage(adult.context().browser()!);
    await login(phone, ADULT.user, ADULT.pass);
    await expect(phone.getByText(`Hola, ${ADULT.name}`)).toBeVisible();
    await phone.goto('/mesada');
    await expect(phone.getByRole('heading', { name: 'Banca familiar' })).toBeVisible();
    await expect(phone.getByText('Pendiente de pagar')).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await phone.screenshot({ path: `${SHOTS}/23-mesada-banco-padres-375.png`, fullPage: true });
    await phone.context().close();
    // Ajustes del banco
    await adult.goto('/ajustes');
    await expect(adult.getByRole('heading', { name: 'Banco de los hijos' })).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/24-ajustes-banco.png`, fullPage: true });
  });

  test('«Cuando haga falta»: la hace el primero y no cuenta como fallo si nadie la hace', async ({ browser }) => {
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill('Sacar la basura');
    await d.getByRole('radio', { name: 'Cuando haga falta' }).click();
    await d.getByRole('button', { name: KID.name }).click();
    await d.getByRole('button', { name: 'Hugo' }).click();
    await expect(d.getByText('si nadie la hace, no pasa nada')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/28-tarea-cuando-haga-falta.png` });
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByRole('listitem').filter({ hasText: 'Sacar la basura' })).toContainText('Cuando haga falta');

    await kid.goto('/');
    const sec = kid.getByRole('heading', { name: 'Cuando haga falta' });
    await expect(sec).toBeVisible();
    // Es opcional: no cuenta en «Te quedan…».
    await expect(kid.getByRole('heading', { name: 'Todo hecho por hoy' })).toBeVisible();
    await kid.getByRole('button', { name: 'Marcar «Sacar la basura» como hecha' }).click();
    await expect(kid.getByText('«Sacar la basura» enviada')).toBeVisible();

    const hugo = await newPhonePage(browser);
    await login(hugo, 'hugo', '1111', true);
    await expect(hugo.getByText('Hecha por Lucía')).toBeVisible();
    await expect(hugo.getByRole('button', { name: 'Marcar «Sacar la basura» como hecha' })).toHaveCount(0);
    await hugo.screenshot({ path: `${SHOTS}/29-hijo-cuando-haga-falta-375.png`, fullPage: true });
    // Nadie ha fallado: ni vencidas ni puntos perdidos.
    const me = await api(hugo, 'get', '/me');
    const prog = await api(hugo, 'get', `/progress/${me.body.user.id}`);
    expect(prog.body.period.missedPoints).toBe(0);
    await hugo.context().close();
    await adult.goto('/validar');
    await adult.getByRole('button', { name: `Aprobar «Sacar la basura» de ${KID.name}` }).click();
    await expect(adult.getByText('Tarea aprobada')).toBeVisible();
  });

  test('Trabajos extra: se activa, el primero se la pide, se valida y vuelve al catálogo', async ({ browser }) => {
    await adult.goto('/extras');
    await expect(adult.getByRole('heading', { name: 'Trabajos extra' })).toBeVisible();
    await adult.getByRole('button', { name: 'Nuevo' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre del trabajo').fill('Quitar hierbajos');
    await d.getByLabel('Puntos', { exact: true }).fill('30');
    await d.getByRole('button', { name: 'Crear trabajo' }).click();
    await expect(adult.getByText('Trabajo creado')).toBeVisible();
    await adult.getByRole('button', { name: 'Activar' }).click();
    const a = adult.getByRole('dialog');
    const week = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await a.getByLabel('Plazo (opcional)').fill(week);
    await a.getByRole('button', { name: 'Poner en el tablón' }).click();
    await expect(adult.getByText('Puesto en el tablón')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/30-extras-adulto.png`, fullPage: true });

    await kid.goto('/extras');
    await expect(kid.getByTestId('extra-card')).toContainText('Quitar hierbajos');
    const hugo = await newPhonePage(browser);
    await login(hugo, 'hugo', '1111', true);
    await expect(hugo.getByRole('heading', { name: /Hoy tienes el día libre|Te queda|Todo hecho/ })).toBeVisible();
    await hugo.goto('/extras');
    await expect(hugo.getByTestId('extra-card')).toContainText('Quitar hierbajos');
    await kid.getByRole('button', { name: 'Me la pido' }).click();
    await expect(kid.getByText('¡Es tuya!')).toBeVisible();
    // Hugo llega tarde: aún ve el botón, pero al pulsarlo le dice quién la tiene.
    await hugo.getByRole('button', { name: 'Me la pido' }).click();
    await expect(hugo.getByText('La tiene Lucía').first()).toBeVisible();
    await hugo.screenshot({ path: `${SHOTS}/31-extras-hijo-375.png`, fullPage: true });
    await hugo.context().close();

    await kid.getByRole('button', { name: 'Ya la hice' }).click();
    await expect(kid.getByText('Enviada. Falta que la validen.')).toBeVisible();
    await adult.goto('/validar');
    await adult.getByRole('button', { name: `Aprobar «Quitar hierbajos» de ${KID.name}` }).click();
    await expect(adult.getByText('Tarea aprobada')).toBeVisible();
    await adult.goto('/extras');
    await expect(adult.getByText('Ahora no hay trabajos extra')).toBeVisible();
    await expect(adult.getByTestId('extra-catalog-item')).toContainText('Quitar hierbajos');
    await expect(adult.getByRole('button', { name: 'Activar' })).toBeEnabled();
  });

  test('repetir en el día: «Hecha 1 de 2 hoy» y, al llegar al máximo, ya no se puede', async () => {
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill('Pasear al perro');
    await d.getByRole('button', { name: KID.name }).click();
    await d.getByRole('checkbox', { name: /Necesita validación/ }).check({ force: true });
    await d.getByRole('checkbox', { name: /Se puede repetir en el día/ }).check({ force: true });
    await expect(d.getByLabel('Máximo de veces al día')).toHaveValue('2');
    await adult.screenshot({ path: `${SHOTS}/32-tarea-repetir-en-el-dia.png` });
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByText('Tarea creada')).toBeVisible();

    await kid.goto('/');
    const mark = kid.getByRole('button', { name: 'Marcar «Pasear al perro» como hecha' });
    await mark.click();
    await expect(kid.getByText('Hecha 1 de 2 hoy')).toBeVisible();
    await expect(mark).toBeVisible(); // sigue disponible
    await mark.click();
    await expect(kid.getByText('Hecha 2 de 2 hoy')).toBeVisible();
    await expect(mark).toHaveCount(0);
    await kid.screenshot({ path: `${SHOTS}/33-hijo-repetir-375.png`, fullPage: true });
    const me = await api(kid, 'get', '/me');
    const raw = await api(kid, 'get', `/wallet/${me.body.user.id}`);
    expect(raw.status).toBe(200);
  });

  test('«Cuando haga falta» con espera: sale en gris con «Vuelve mañana» y no se puede marcar', async () => {
    await adult.goto('/tareas');
    await adult.getByRole('button', { name: 'Nueva' }).click();
    const d = adult.getByRole('dialog');
    await d.getByLabel('Nombre de la tarea').fill('Descargar el lavavajillas');
    await d.getByRole('radio', { name: 'Cuando haga falta' }).click();
    await d.getByRole('button', { name: KID.name }).click();
    await d.getByLabel('Después de hacerla, vuelve en (días)').fill('2');
    await adult.screenshot({ path: `${SHOTS}/34-tarea-espera.png` });
    await d.getByRole('button', { name: 'Crear tarea' }).click();
    await expect(adult.getByText('Tarea creada')).toBeVisible();

    await kid.goto('/');
    await kid.getByRole('button', { name: 'Marcar «Descargar el lavavajillas» como hecha' }).click();
    await expect(kid.getByText('«Descargar el lavavajillas» enviada')).toBeVisible();
    // Como si la hubiera hecho ayer: se mueve esa hecha un día atrás y vuelve a aparecer la de hoy.
    const sql = `UPDATE task_instances SET due_date = due_date - 1, completed_at = completed_at - interval '1 day' WHERE task_id = (SELECT id FROM tasks WHERE title = 'Descargar el lavavajillas');
      INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points) SELECT task_id, family_id, NULL, (now() AT TIME ZONE 'Europe/Madrid')::date, points FROM task_instances WHERE task_id = (SELECT id FROM tasks WHERE title = 'Descargar el lavavajillas');`;
    execFileSync('psql', ['postgres://postgres:postgres@127.0.0.1:5432/mesada_e2e', '-qc', sql]);
    await kid.goto('/');
    const row = kid.getByRole('listitem').filter({ hasText: 'Descargar el lavavajillas' });
    await expect(row).toContainText('Vuelve mañana');
    await expect(row.getByRole('button')).toHaveCount(0);
    await kid.screenshot({ path: `${SHOTS}/35-hijo-espera-375.png`, fullPage: true });
    // Aunque lo intente por la API, el servidor lo rechaza.
    const inst = (await api(kid, 'get', '/instances')).body.instances.find((i: any) => i.title === 'Descargar el lavavajillas' && i.status === 'pending');
    expect((await api(kid, 'post', `/instances/${inst.id}/complete`, {})).status).toBe(409);
  });

  test('la app es instalable (manifest y service worker)', async () => {
    const res = await adult.request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m).toMatchObject({ name: expect.stringContaining('DiploP'), display: 'standalone', lang: 'es-ES' });
    expect(m.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
    expect((await adult.request.get('/sw.js')).ok()).toBe(true);
  });
});
