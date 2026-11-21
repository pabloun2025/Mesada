import crypto from 'node:crypto';
import { test, expect, devices, type Browser, type Page } from '@playwright/test';

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
    await expect(kid.getByText('Puntos por convertir').locator('..')).toContainText('20');
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
    await expect(card.getByText('Por pagar').locator('..')).toContainText('0,50 €');
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
    await expect(card.getByText('Por pagar').locator('..')).toContainText('0,30 €');
    await card.getByRole('button', { name: 'Registrar pago' }).click();
    const d = adult.getByRole('dialog');
    await expect(d.getByLabel('Importe (€)')).toHaveValue('0,30');
    await d.getByRole('radio', { name: 'Bizum' }).click();
    await d.getByRole('button', { name: 'Registrar pago' }).click();
    await expect(adult.getByText('Pago de 0,30 € registrado')).toBeVisible();
    await expect(card.getByText('Por pagar').locator('..')).toContainText('0,00 €');
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

  test('la app es instalable (manifest y service worker)', async () => {
    const res = await adult.request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m).toMatchObject({ name: expect.stringContaining('DiploP'), display: 'standalone', lang: 'es-ES' });
    expect(m.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
    expect((await adult.request.get('/sw.js')).ok()).toBe(true);
  });
});
