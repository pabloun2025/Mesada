import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
let adminSecret = '';

async function login(page: Page, user: string, pass: string, child = false) {
  await page.goto('/entrar');
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

/**
 * Auditoría de contraste de las tarjetas con degradado (el banco del carrusel), que las herramientas de selectores no miden:
 * cada tarjeta se desplaza a la vista, se leen el color y la caja de cada texto, se repinta la tarjeta SIN texto
 * y se mide, píxel a píxel, el contraste del texto contra lo que de verdad hay detrás (degradado, rayos y monedas incluidos).
 * Devuelve los textos que no llegan a 4,5:1 (3:1 si son grandes).
 */
async function contrastFailures(p: Page, cardSelector: string, variant?: (card: Element) => void): Promise<string[]> {
  const failures: string[] = [];
  const cards = p.locator(cardSelector);
  const n = await cards.count();
  expect(n, `no hay tarjetas ${cardSelector}`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    await card.evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' as ScrollBehavior }));
    await p.waitForTimeout(120);
    expect(await card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }), 'la tarjeta no ha quedado a la vista').toBe(true);
    const items = await card.evaluate((el, v) => {
      if (v) new Function('card', `(${v})(card)`)(el);
      const box = el.getBoundingClientRect();
      const out: { text: string; x: number; y: number; w: number; h: number; rgb: number[]; alpha: number; large: boolean }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const parent = node.parentElement;
        if (!text || !parent || parent.closest('.sr-only, svg')) continue; // las ilustraciones (monedas con «€» dibujado) no son texto de la interfaz
        const range = document.createRange();
        range.selectNodeContents(node);
        const cs = getComputedStyle(parent);
        const m = cs.color.match(/[\d.]+/g)!.map(Number);
        let opacity = 1;
        for (let e: Element | null = parent; e; e = e.parentElement) { opacity *= Number(getComputedStyle(e).opacity); if (e === el) break; }
        const size = parseFloat(cs.fontSize);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.height < 2) continue;
          out.push({ text, x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height, rgb: m.slice(0, 3), alpha: (m[3] ?? 1) * opacity, large: size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) });
        }
      }
      const st = document.createElement('style');
      st.id = '__contrast';
      st.textContent = '[data-contrast] * { color: transparent !important; text-shadow: none !important; }';
      document.head.append(st);
      el.setAttribute('data-contrast', '');
      return out;
    }, variant ? variant.toString() : null);
    const png = await card.screenshot({ scale: 'css' });
    await card.evaluate((el) => { el.removeAttribute('data-contrast'); document.getElementById('__contrast')?.remove(); });
    const bad = await p.evaluate(async ({ b64, items }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const lum = (r: number, gg: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
      const res: string[] = [];
      for (const it of items) {
        const x = Math.max(0, Math.floor(it.x)), y = Math.max(0, Math.floor(it.y));
        const w = Math.max(1, Math.min(img.width - x, Math.ceil(it.w))), h = Math.max(1, Math.min(img.height - y, Math.ceil(it.h)));
        const d = g.getImageData(x, y, w, h).data;
        let worst = Infinity;
        for (let k = 0; k < d.length; k += 4) {
          const bg = [d[k], d[k + 1], d[k + 2]];
          const fg = it.rgb.map((v, j) => v * it.alpha + bg[j] * (1 - it.alpha));
          const l1 = lum(fg[0], fg[1], fg[2]), l2 = lum(bg[0], bg[1], bg[2]);
          worst = Math.min(worst, (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
        }
        if (worst < (it.large ? 3 : 4.5)) res.push(`«${it.text}» ${worst.toFixed(2)}:1`);
      }
      return res;
    }, { b64: png.toString('base64'), items });
    const title = (await card.getAttribute('aria-label')) ?? `tarjeta ${i + 1}`;
    for (const b of bad) failures.push(`${title}: ${b}`);
  }
  return failures;
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

  test('primer arranque: un adulto crea la familia (casilla de aceptación obligatoria y campo trampa invisible)', async ({ browser }) => {
    await adult.goto('/');
    await expect(adult).toHaveURL(/configurar/);
    // En el móvil (375 px): la casilla enlaza con los textos legales y el campo trampa queda fuera de pantalla y sin foco.
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
    const m = await ctx.newPage();
    await m.goto('/configurar');
    const box = m.getByRole('checkbox', { name: /acepto/i });
    await expect(box).toBeVisible();
    expect(await box.evaluate((e) => e.getBoundingClientRect().width), 'casilla ≥ 24 px').toBeGreaterThanOrEqual(24);
    const label = m.locator('label[for]').filter({ hasText: 'política de privacidad' });
    expect((await label.boundingBox())!.height, 'zona de toque de la casilla').toBeGreaterThanOrEqual(44);
    await expect(label.getByRole('link', { name: 'política de privacidad' })).toHaveAttribute('href', '/privacidad');
    await expect(label.getByRole('link', { name: 'condiciones de uso' })).toHaveAttribute('href', '/condiciones');
    const trap = m.locator('input[name=website]');
    expect((await trap.boundingBox())!.x).toBeLessThan(0);
    await expect(trap).toHaveJSProperty('tabIndex', -1);
    expect(await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await m.getByLabel('Nombre de la familia').fill('Familia Prueba');
    await m.getByLabel('Tu nombre').fill(ADULT.name);
    await m.screenshot({ path: `${SHOTS}/82-alta-con-casilla-375.png`, fullPage: true });
    // Sin la casilla el navegador no deja enviar: sigue en /configurar y no se ha creado nada.
    await m.getByLabel('Usuario').fill(ADULT.user);
    await m.getByLabel('Correo').fill('ana@example.com');
    await m.getByLabel('Contraseña').fill(ADULT.pass);
    await m.getByRole('button', { name: 'Crear familia' }).click();
    await expect(m).toHaveURL(/configurar/);
    expect(await box.evaluate((e: HTMLInputElement) => e.validity.valueMissing)).toBe(true);
    expect((await api(m, 'get', '/setup/status')).body.needsSetup).toBe(true);
    // Y por la API tampoco, ni con otra versión de los textos.
    const payload = { familyName: 'X', displayName: 'X', username: 'robotx', password: 'contrasena-larga', email: 'x@example.com' };
    expect((await api(m, 'post', '/setup', payload)).status).toBe(400);
    expect((await api(m, 'post', '/setup', { ...payload, acceptTerms: true, termsVersion: '1999-01-01' })).body.error).toBe('terms_outdated');
    expect((await api(m, 'get', '/setup/status')).body.needsSetup).toBe(true);
    await ctx.close();

    await adult.getByLabel('Nombre de la familia').fill('Familia Prueba');
    await adult.getByLabel('Tu nombre').fill(ADULT.name);
    await adult.getByLabel('Usuario').fill(ADULT.user);
    await adult.getByLabel('Correo').fill('ana@example.com');
    await adult.getByLabel('Contraseña').fill(ADULT.pass);
    await adult.getByRole('checkbox', { name: /acepto/i }).check();
    await adult.getByRole('button', { name: 'Crear familia' }).click();
    await expect(adult.getByRole('heading', { name: 'Familia', exact: true })).toBeVisible();
    // Quedan guardadas la versión y la fecha de la aceptación.
    const me = (await api(adult, 'get', '/me')).body.user;
    expect(me.terms_version).toBe((await api(adult, 'get', '/setup/status')).body.legalVersion);
    expect(Date.now() - new Date(me.terms_accepted_at).getTime()).toBeLessThan(120_000);
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
    await p.goto('/entrar');
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
    adminSecret = secret;
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

  test('administración recuerda el dispositivo 90 días y se puede olvidar', async ({ browser }) => {
    const code = () => totp(adminSecret, Date.now() + 30_000); // un código posterior al ya usado
    await adult.goto('/administracion');
    await expect(adult.getByText('Confirma que eres tú')).toBeVisible();
    await expect(adult.getByText('se recordará 90 días')).toBeVisible();
    await adult.screenshot({ path: `${SHOTS}/36-admin-recordar-dispositivo.png` });
    await adult.getByLabel('Código').first().fill(code());
    await adult.getByRole('button', { name: 'Entrar' }).click();
    await expect(adult.getByRole('radio', { name: 'Resumen' })).toBeVisible();
    // La verificación de la sesión caduca (12 h), pero este dispositivo sigue recordado: sin código.
    execFileSync('psql', ['postgres://postgres:postgres@127.0.0.1:5432/mesada_e2e', '-qc', 'UPDATE sessions SET admin_verified_at = NULL']);
    await adult.goto('/administracion');
    await expect(adult.getByRole('radio', { name: 'Resumen' })).toBeVisible();
    await expect(adult.getByText('Dispositivo recordado')).toBeVisible();
    // Un dispositivo nuevo (otra sesión y sin cookie) sí pide el código.
    const other = await newAdultPage(browser);
    await login(other, ADULT.user, ADULT.pass);
    await expect(other.getByRole('link', { name: 'Administración' }).first()).toBeVisible();
    await other.goto('/administracion');
    await expect(other.getByText('Confirma que eres tú')).toBeVisible();
    await other.context().close();
    // Olvidar este dispositivo.
    await adult.getByRole('radio', { name: 'Ajustes' }).click();
    adult.once('dialog', (d) => d.accept());
    await adult.getByRole('button', { name: 'Olvidar este dispositivo' }).click();
    await expect(adult.getByText('Confirma que eres tú')).toBeVisible();
    await adult.goto('/administracion');
    await expect(adult.getByText('Confirma que eres tú')).toBeVisible();
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
    await rc.locator('svg').first().waitFor();
    await kid.waitForTimeout(400); // deja terminar la animación de las monedas
    await kid.screenshot({ path: `${SHOTS}/81-recibo-canje-monedas-375.png` });
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
    await expect(hugo.getByRole('heading', { name: /Hoy tienes el día libre|Sin tareas fijas hoy|Te queda|Todo hecho/ })).toBeVisible();
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

  test('revisar una tarea: premio parcial, devolver y reenviar, rechazar con penalidad', async ({ browser }) => {
    const me = await api(kid, 'get', '/me');
    const lucia = me.body.user.id;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    for (const title of ['Limpiar el baño', 'Regar las plantas', 'Ordenar los zapatos']) {
      expect((await api(adult, 'post', '/tasks', { title, points: 20, recurrence: 'daily', startDate: today, assignees: [lucia] })).status).toBe(200);
    }
    await kid.goto('/');
    for (const title of ['Limpiar el baño', 'Regar las plantas', 'Ordenar los zapatos']) {
      await kid.getByRole('button', { name: `Marcar «${title}» como hecha` }).click();
      await expect(kid.getByText(`«${title}» enviada`)).toBeVisible();
    }
    const phone = await newPhonePage(browser);
    await login(phone, ADULT.user, ADULT.pass);
    await expect(phone.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await phone.goto('/validar');
    const review = async (title: string) => {
      await phone.getByRole('button', { name: `Revisar «${title}» de ${KID.name}` }).click();
      return phone.getByRole('dialog');
    };

    // 1) Premio parcial del 50 %, con motivo obligatorio.
    let d = await review('Limpiar el baño');
    await d.getByRole('radio', { name: /Premio parcial/ }).click();
    await d.getByRole('button', { name: '50 %' }).click();
    await expect(d.getByRole('button', { name: 'Dar 10 puntos' })).toBeDisabled(); // sin motivo
    await phone.screenshot({ path: `${SHOTS}/37-revisar-tarea-375.png` });
    await d.getByRole('button', { name: 'Falta un poco' }).click();
    await d.getByRole('button', { name: 'Dar 10 puntos' }).click();
    await expect(phone.getByText('Premio parcial dado')).toBeVisible();

    // 2) Devolver para que la arregle.
    d = await review('Regar las plantas');
    await d.getByRole('radio', { name: /Devolver para que la arregle/ }).click();
    await d.getByRole('button', { name: 'No está hecha' }).click();
    await d.getByRole('button', { name: 'Devolver para que la arregle' }).last().click();
    await expect(phone.getByText('Tarea devuelta para que la arregle')).toBeVisible();

    // 3) Rechazar con penalidad: puntos por defecto = los de la tarea, más minutos.
    d = await review('Ordenar los zapatos');
    await d.getByRole('radio', { name: /Rechazar con penalidad/ }).click();
    await expect(d.getByLabel('Puntos a restar')).toHaveValue('20');
    await d.getByLabel('Puntos a restar').fill('5');
    await d.getByLabel('Minutos de pantalla').fill('10');
    await d.getByRole('button', { name: 'Mal hecha' }).click();
    await d.getByRole('button', { name: 'Rechazar y restar' }).click();
    await expect(phone.getByText('Tarea rechazada con penalidad')).toBeVisible();
    await phone.screenshot({ path: `${SHOTS}/38-validar-tras-revisar-375.png`, fullPage: true });
    await phone.context().close();

    // El hijo ve el resultado y el motivo en su lista.
    await kid.goto('/');
    const row = (t: string) => kid.getByRole('listitem').filter({ hasText: t }).first();
    await expect(row('Limpiar el baño')).toContainText('Premio parcial: +10 de 20');
    await expect(row('Limpiar el baño')).toContainText('Falta un poco');
    await expect(row('Regar las plantas')).toContainText('No está hecha');
    await expect(row('Ordenar los zapatos')).toContainText('Rechazada');
    await expect(row('Ordenar los zapatos')).toContainText('Mal hecha');
    await expect(row('Ordenar los zapatos')).toContainText('Se te ha restado 5 puntos');
    await kid.screenshot({ path: `${SHOTS}/39-hijo-resultado-revision-375.png`, fullPage: true });
    // La devuelta se puede volver a enviar; la rechazada, no.
    await expect(row('Ordenar los zapatos').getByRole('button')).toHaveCount(0);
    await kid.getByRole('button', { name: 'Marcar «Regar las plantas» como hecha' }).click();
    await expect(kid.getByText('«Regar las plantas» enviada')).toBeVisible();
    // Ambos libros: puntos y minutos.
    const w = await api(kid, 'get', `/wallet/${lucia}`);
    expect(w.body.wallet.screen_minutes).toBeGreaterThanOrEqual(0);
  });

  test('página de bienvenida y entrada con la imagen «cielo», sin desbordar a 375 y 320 px', async ({ browser }) => {
    for (const [w, tag] of [[375, '375'], [320, '320']] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, deviceScaleFactor: 2, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
      const p = await ctx.newPage();
      await p.goto('/'); // dispositivo nuevo: se ve la bienvenida
      await expect(p.getByRole('heading', { level: 1, name: /Tareas de casa, puntos y mesada/ })).toBeVisible();
      await expect(p.getByRole('heading', { name: 'Cómo funciona' })).toBeVisible();
      await expect(p.getByRole('heading', { name: 'Para padres' })).toBeVisible();
      await expect(p.getByRole('heading', { name: 'Para hijos' })).toBeVisible();
      for (const step of ['Tareas', 'Puntos', 'Dinero o premios']) await expect(p.getByRole('heading', { name: new RegExp(step) }).first()).toBeVisible();
      await expect(p.getByRole('link', { name: 'Entrar' })).toHaveCount(2); // arriba y al final
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await p.screenshot({ path: `${SHOTS}/${tag === '375' ? '40' : '41'}-bienvenida-${tag}.png`, fullPage: true });
      // «Entrar» lleva al acceso, que tampoco desborda.
      await p.getByRole('link', { name: 'Entrar' }).first().click();
      await expect(p.getByLabel('Usuario')).toBeVisible();
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await p.screenshot({ path: `${SHOTS}/${tag === '375' ? '42' : '43'}-entrar-${tag}.png`, fullPage: true });
      await ctx.close();
    }
    // Escritorio, imagen apaisada y vista previa al compartir con ruta absoluta.
    const d = await newAdultPage(browser);
    await d.goto('/bienvenida');
    await expect(d.getByRole('heading', { name: 'Cómo funciona' })).toBeVisible();
    await expect(d.locator('picture source')).toHaveAttribute('srcset', '/brand/hero-sky-wide.webp');
    await expect(d.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://mesada.veryfacil.org/brand/og-image.jpg');
    await expect(d.locator('meta[property="og:title"]')).toHaveAttribute('content', 'DiploP');
    await expect(d.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    await d.screenshot({ path: `${SHOTS}/46-bienvenida-escritorio.png`, fullPage: true });
    await d.context().close();
    expect((await adult.request.get('/brand/og-image.jpg')).headers()['content-type']).toContain('image/jpeg');
  });

  test('textos legales: públicos, sin banner ni cookies, enlazados desde bienvenida, acceso y «Más», sin desbordar', async ({ browser }) => {
    const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const DOCS = [
      { path: '/privacidad', link: 'Privacidad', h1: 'Política de privacidad', shot: '83-privacidad-375', has: ['privacidad@veryfacil.org', 'Agencia Española de Protección de Datos', 'solo cookies técnicas', 'Oracle Cloud', 'Cloudflare', 'Resend', 'patria potestad', 'portabilidad'] },
      { path: '/aviso-legal', link: 'Aviso legal', h1: 'Aviso legal', shot: '84-aviso-legal-375', has: ['el responsable de DiploP', 'privacidad@veryfacil.org'] },
      { path: '/condiciones', link: 'Condiciones', h1: 'Condiciones de uso', shot: '85-condiciones-375', has: ['mayores de 18 años', 'de juguete'] },
    ];
    for (const [w, theme] of [[375, 'light'], [320, 'dark']] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, hasTouch: true, colorScheme: theme, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
      await ctx.addInitScript((t) => localStorage.setItem('mesada:theme', t), theme);
      const p = await ctx.newPage();
      // Desde la bienvenida: pie con los tres enlaces.
      await p.goto('/bienvenida');
      const foot = p.getByRole('navigation', { name: 'Información legal' });
      for (const d of DOCS) await expect(foot.getByRole('link', { name: d.link })).toBeVisible();
      for (const d of DOCS) {
        await p.goto('/bienvenida');
        await p.getByRole('navigation', { name: 'Información legal' }).getByRole('link', { name: d.link }).click();
        await expect(p).toHaveURL(new RegExp(d.path));
        await expect(p.getByRole('heading', { level: 1, name: d.h1 })).toBeVisible();
        const text = await p.locator('main').innerText();
        for (const t of d.has) expect(text, `${d.path} debe decir «${t}»`).toContain(t);
        expect(text).toMatch(/Versión \d{4}-\d{2}-\d{2}/);
        expect(await noOverflow(p), `${d.path} ${w} ${theme} desborda`).toBeLessThanOrEqual(0);
        // Sin banner de cookies y, de hecho, sin ninguna cookie en un dispositivo sin sesión.
        await expect(p.getByText(/aceptar (todas )?las cookies|rechazar cookies/i)).toHaveCount(0);
        await expect(p.getByRole('dialog')).toHaveCount(0);
        expect(await ctx.cookies(), 'una visita anónima no debe fijar cookies').toEqual([]);
        if (theme === 'light') { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/${d.shot}.png`, fullPage: true }); }
      }
      // Los enlaces cruzados del propio texto funcionan (de privacidad a condiciones y aviso legal).
      await p.goto('/privacidad');
      await p.locator('main').getByRole('link', { name: 'Condiciones de uso' }).click();
      await expect(p.getByRole('heading', { level: 1, name: 'Condiciones de uso' })).toBeVisible();
      // Desde el acceso.
      await p.goto('/entrar');
      for (const d of DOCS) await expect(p.getByRole('navigation', { name: 'Información legal' }).getByRole('link', { name: d.link })).toBeVisible();
      await ctx.close();
    }
    // Con sesión también se leen, y están en «Más» (móvil) y al pie de la página (escritorio).
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
    const p = await ctx.newPage();
    await login(p, ADULT.user, ADULT.pass);
    await expect(p.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await p.getByRole('button', { name: 'Más' }).click();
    const sheet = p.getByRole('dialog');
    await expect(sheet.getByRole('navigation', { name: 'Información legal' }).getByRole('link')).toHaveCount(3);
    for (const l of await sheet.getByRole('navigation', { name: 'Información legal' }).getByRole('link').all()) expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${SHOTS}/86-mas-enlaces-legales-375.png` });
    await sheet.getByRole('link', { name: 'Privacidad' }).click();
    await expect(p.getByRole('heading', { level: 1, name: 'Política de privacidad' })).toBeVisible();
    expect(await ctx.cookies().then((c) => c.map((x) => x.name))).toEqual(['mesada_session']); // la única cookie: la de sesión
    await p.getByRole('link', { name: 'Volver' }).click();
    await expect(p.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await ctx.close();
    const d = await newAdultPage(browser);
    await login(d, ADULT.user, ADULT.pass);
    await expect(d.getByRole('main').getByRole('navigation', { name: 'Información legal' })).toBeVisible();
    await d.context().close();
  });

  test('inicio del hijo: tarjeta «Mi mesada», tres accesos y valor en euros de cada tarea', async () => {
    await kid.goto('/');
    const card = kid.getByRole('region', { name: 'Mi mesada' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('→');
    await expect(card).toContainText('€');
    for (const l of ['Mis tareas', 'Mis puntos', 'Mis recompensas']) await expect(card.getByRole('link', { name: l })).toBeVisible();
    await expect(kid.getByRole('listitem').filter({ hasText: 'Poner el lavavajillas' }).first()).toContainText(/\+\d+\s*★.*\d+,\d\d\s*€/);
    await card.getByRole('link', { name: 'Mis recompensas' }).click();
    await expect(kid).toHaveURL(/\/premios/);
    await kid.goto('/');
    await expect(card).toBeVisible();
    for (const [w, n] of [[375, '44'], [320, '45']] as const) {
      await kid.setViewportSize({ width: w, height: 780 });
      await expect(card).toBeVisible();
      await expect(kid.getByRole('listitem').filter({ hasText: 'Poner el lavavajillas' }).first()).toBeVisible();
      expect(await kid.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await kid.screenshot({ path: `${SHOTS}/${n}-hijo-inicio-${w}.png`, fullPage: true });
    }
    await kid.setViewportSize({ width: 390, height: 844 });
    // Monedas doradas en la cuenta de dinero.
    await kid.goto('/mesada');
    await expect(kid.getByRole('region', { name: 'Cuenta de dinero' }).locator('svg').last()).toBeVisible();
    await kid.screenshot({ path: `${SHOTS}/47-hijo-banco-monedas-375.png` });
  });

  test('calidad de interfaz: claro y oscuro a 375 y 320 px, sin desbordar, con objetivos táctiles de 44 px y contraste de las tarjetas del banco', async ({ browser }) => {
    let n = 48;
    const overflow = (p: Page) => p.evaluate(() => {
      let o = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !e.closest('.rail,[role=tablist],.sr-only,.confetti,dialog:not([open])')) o = Math.max(o, Math.round(r.right - document.documentElement.clientWidth));
      }
      return o;
    });
    // Botones e iconos de la cabecera y de la barra inferior: mínimo 44 px.
    const small = (p: Page) => p.evaluate(() =>
      [...document.querySelectorAll('header button, nav[aria-label=Principal] a, nav[aria-label=Principal] button')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44); })
        .map((e) => e.getAttribute('aria-label') ?? e.textContent));
    for (const theme of ['light', 'dark'] as const) {
      for (const w of [375, 320]) {
        const mk = async () => {
          const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, hasTouch: true, colorScheme: theme, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
          await ctx.addInitScript((t) => localStorage.setItem('mesada:theme', t), theme);
          return ctx.newPage();
        };
        const shot = async (p: Page, name: string, full = true) => {
          expect(await overflow(p), `${name} ${w} ${theme} desborda`).toBeLessThanOrEqual(0);
          await p.waitForTimeout(250);
          await p.screenshot({ path: `${SHOTS}/${n++}-${name}-${w}-${theme}.png`, fullPage: full });
        };
        // Públicas.
        let p = await mk();
        await p.goto('/bienvenida');
        await expect(p.getByRole('heading', { name: 'Cómo funciona' })).toBeVisible();
        await shot(p, 'bienvenida');
        await p.goto('/entrar');
        await expect(p.getByLabel('Usuario')).toBeVisible();
        await shot(p, 'entrar');
        await p.context().close();
        // Hijo: el nombre de la cabecera cabe entero y los objetivos miden 44 px.
        p = await mk();
        await login(p, KID.user, KID.pin, true);
        await expect(p.getByRole('region', { name: 'Mi mesada' })).toBeVisible();
        const nameBox = p.locator('header p.truncate').first();
        expect(await nameBox.evaluate((e) => e.scrollWidth <= e.clientWidth), 'nombre truncado en la cabecera').toBe(true);
        expect(await small(p)).toEqual([]);
        await shot(p, 'hijo-inicio');
        await p.goto('/extras');
        await expect(p.getByRole('heading', { name: 'Trabajos extra' })).toBeVisible();
        await shot(p, 'hijo-extras');
        await p.goto('/mesada');
        await expect(p.getByRole('region', { name: 'Cuenta de dinero' })).toBeVisible();
        // Contraste de las dos tarjetas del carrusel (cada una se desplaza a la vista antes de medirla), también en saldo negativo.
        expect(await contrastFailures(p, '.acct'), `contraste de las tarjetas del banco a ${w} px (${theme})`).toEqual([]);
        const negative = (card: Element) => { card.querySelector('p.num > span')?.classList.add(card.classList.contains('acct-money') ? 'text-[#ffb3c7]' : 'text-[#9b1241]'); };
        expect(await contrastFailures(p, '.acct', negative), `contraste con saldo negativo a ${w} px (${theme})`).toEqual([]);
        await p.evaluate(() => document.querySelectorAll('.acct p.num > span').forEach((e) => e.classList.remove('text-[#ffb3c7]', 'text-[#9b1241]')));
        if (w === 375 && theme === 'light') {
          await p.locator('.acct').last().evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' as ScrollBehavior }));
          await p.waitForTimeout(200);
          await p.screenshot({ path: `${SHOTS}/91-banco-tarjeta-puntos-contraste-375.png` });
        }
        await p.locator('.rail').evaluate((e) => e.scrollTo(0, 0));
        await p.waitForTimeout(150);
        await shot(p, 'hijo-banco');
        await p.context().close();
        // Adulto: Validar y la hoja de revisión.
        p = await mk();
        await login(p, ADULT.user, ADULT.pass);
        await expect(p.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
        await p.goto('/validar');
        await expect(p.getByRole('button', { name: /^Revisar/ }).first()).toBeVisible();
        expect(await small(p)).toEqual([]);
        await shot(p, 'validar');
        await p.getByRole('button', { name: /^Revisar/ }).first().click();
        await p.getByRole('dialog').getByRole('radio', { name: /Rechazar con penalidad/ }).click();
        await shot(p, 'validar-hoja', false);
        await p.context().close();
      }
    }
  });

  test('desmarcar (I17): «Hecha · Deshacer», desmarcar desde la fila y no se puede tras validar', async ({ browser }) => {
    const me = (await api(kid, 'get', '/me')).body.user;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const mk = (title: string, extra: Record<string, unknown> = {}) => api(adult, 'post', '/tasks', { title, points: 15, recurrence: 'daily', startDate: today, assignees: [me.id], ...extra });
    expect((await mk('Tender la ropa', { requiresApproval: false })).status).toBe(200);
    expect((await mk('Barrer la terraza')).status).toBe(200);
    expect((await mk('Fregar los cacharros')).status).toBe(200);
    const points = async () => (await api(kid, 'get', `/wallet/${me.id}`)).body.wallet.points_available;
    const p0 = await points();

    await kid.setViewportSize({ width: 375, height: 812 });
    await kid.goto('/');
    // 1) Toast «Hecha · Deshacer» al marcar; deshacer devuelve los puntos y la tarea.
    await kid.getByRole('button', { name: 'Marcar «Tender la ropa» como hecha' }).click();
    const toast = kid.locator('[aria-live=polite]').filter({ hasText: 'Hecha' });
    await expect(toast).toContainText('+15 puntos');
    await expect(toast.getByRole('button', { name: 'Deshacer' })).toBeVisible();
    expect(await points()).toBe(p0 + 15);
    await kid.screenshot({ path: `${SHOTS}/76-hijo-deshacer-toast-375.png` });
    await toast.getByRole('button', { name: 'Deshacer' }).click();
    await expect(kid.getByText('Desmarcada: vuelve a estar por hacer')).toBeVisible();
    await expect(kid.getByRole('button', { name: 'Marcar «Tender la ropa» como hecha' })).toBeVisible();
    expect(await points()).toBe(p0);

    // 2) Una tarea que pide validación: se puede desmarcar desde la fila mientras nadie la valide.
    await kid.getByRole('button', { name: 'Marcar «Barrer la terraza» como hecha' }).click();
    const row = kid.getByRole('listitem').filter({ hasText: 'Barrer la terraza' });
    await expect(row.getByRole('button', { name: 'Desmarcar «Barrer la terraza»' })).toBeVisible();
    const pending = async () => (await api(adult, 'get', '/dashboard')).body.pendingApprovals.map((x: any) => x.title);
    expect(await pending()).toContain('Barrer la terraza');
    await kid.screenshot({ path: `${SHOTS}/77-hijo-desmarcar-fila-375.png`, fullPage: true });
    await row.getByRole('button', { name: 'Desmarcar «Barrer la terraza»' }).click();
    await expect(row.getByRole('button', { name: 'Marcar «Barrer la terraza» como hecha' })).toBeVisible();
    expect(await pending()).not.toContain('Barrer la terraza');
    // Sin aviso a los adultos por desmarcar: solo el de haberla enviado antes.
    const notes = (await api(adult, 'get', '/notifications')).body.notifications.filter((n: any) => /desmarc/i.test(n.title));
    expect(notes).toHaveLength(0);

    // 3) Si un adulto la valida, el hijo ya no puede desmarcarla.
    await kid.getByRole('button', { name: 'Marcar «Fregar los cacharros» como hecha' }).click();
    const inst = (await api(kid, 'get', '/instances')).body.instances.find((i: any) => i.title === 'Fregar los cacharros');
    expect((await api(adult, 'post', `/instances/${inst.id}/review`, { action: 'approve' })).status).toBe(200);
    expect((await api(kid, 'post', `/instances/${inst.id}/unmark`, {})).status).toBe(409);
    await kid.reload();
    await expect(kid.getByRole('listitem').filter({ hasText: 'Fregar los cacharros' }).getByRole('button', { name: /Desmarcar/ })).toHaveCount(0);
  });

  test('pantalla (I16): plan semanal, desglose del saldo, ajuste, pausa y recuperación', async ({ browser }) => {
    const me = (await api(kid, 'get', '/me')).body.user;
    // El plan se pone desde Ajustes (escritorio); activarlo carga ya esa semana.
    await adult.goto('/ajustes');
    const plan = adult.getByRole('region', { name: 'Plan semanal de pantalla' });
    const lucia = plan.getByRole('listitem').filter({ hasText: KID.name });
    await lucia.getByLabel('Minutos por semana').fill('130');
    await expect(lucia.getByLabel('Minutos por semana')).toHaveAttribute('aria-describedby', /.+/); // la pista va enlazada al campo
    await lucia.getByText('Plan semanal activo').click();
    await expect(lucia.getByText('= 2 h 10 min cada semana')).toBeVisible();
    await lucia.getByRole('button', { name: `Guardar el plan de ${KID.name}` }).click();
    await expect(adult.getByText(`Plan de ${KID.name} guardado`)).toBeVisible();
    // Minutos ganados aparte (como los de un bono), para ver los dos grupos.
    expect((await api(adult, 'post', '/screen/adjust', { userId: me.id, delta: 45, note: 'Gracias por ayudar' })).status).toBe(200);
    // Un hermano no ve nada de esto.
    const hugo = await newPhonePage(browser);
    await login(hugo, 'hugo', '1111', true);
    await expect(hugo.getByRole('region', { name: 'Mi mesada' })).toBeVisible();
    expect((await api(hugo, 'get', `/screen/${me.id}`)).status).toBe(403);
    await hugo.context().close();

    await kid.setViewportSize({ width: 375, height: 812 });
    await kid.goto('/mesada');
    const bal = kid.getByRole('list', { name: 'Desglose del saldo de pantalla' });
    await expect(bal).toContainText('Plan de la semana: 2 h 10 min');
    await expect(bal).toContainText(/caduca el lunes/);
    await expect(bal).toContainText(/Ganados: .*los primeros caducan el lunes \d+ \w+/);
    await bal.scrollIntoViewIfNeeded();
    await kid.screenshot({ path: `${SHOTS}/78-hijo-pantalla-desglose-375.png` });

    // Un trabajo extra para recuperar, y el ajuste desde la banca familiar en el móvil del adulto.
    const extra = (await api(adult, 'post', '/extras', { title: 'Ordenar el trastero', points: 10, requiresApproval: true })).body.id;
    const phone = await newPhonePage(browser);
    await login(phone, ADULT.user, ADULT.pass);
    await expect(phone.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await phone.setViewportSize({ width: 375, height: 812 });
    await phone.goto('/mesada');
    const panel = phone.getByRole('article', { name: `Cuenta de ${KID.name}` });
    await panel.getByRole('button', { name: 'Ajuste de pantalla' }).click();
    const d = phone.getByRole('dialog');
    await d.getByRole('radio', { name: /Habitación en orden/ }).click();
    await expect(d.getByLabel('Minutos que se quitan')).toHaveValue('15');
    await d.getByLabel('Nota amable (opcional)').fill('Mañana lo recogemos juntos');
    await d.getByLabel('Forma de recuperar (opcional)').selectOption({ label: '🧰 Ordenar el trastero' });
    await phone.screenshot({ path: `${SHOTS}/79-adulto-ajuste-pantalla-375.png` });
    await d.getByRole('button', { name: 'Aplicar ajuste' }).click();
    await expect(phone.getByText('Ajuste aplicado: −15 min')).toBeVisible();

    // El hijo lo ve con palabras amables y puede recuperarlo.
    const before = (await api(kid, 'get', `/screen/${me.id}`)).body;
    await kid.goto('/mesada');
    const hist = kid.getByRole('listitem').filter({ hasText: 'Ajuste de pantalla · Habitación en orden' });
    await expect(hist).toContainText('Mañana lo recogemos juntos');
    await expect(hist).toContainText('Los puedes recuperar con «Ordenar el trastero»');
    expect(JSON.stringify(before)).not.toMatch(/castigo|penalizaci|multa/i);
    const board = (await api(kid, 'get', '/extras')).body.board.find((b: any) => b.task_id === extra);
    expect(board.assignee_id).toBe(me.id);
    expect((await api(kid, 'post', `/instances/${board.id}/complete`, {})).status).toBe(200);
    expect((await api(adult, 'post', `/instances/${board.id}/review`, { action: 'approve' })).status).toBe(200);
    const after = (await api(kid, 'get', `/screen/${me.id}`)).body;
    expect(after.balance).toBe(before.balance + 15);

    // Pausa de 2 días: no puede pedir; las demás pantallas dicen «Pausa hasta …».
    await panel.getByRole('button', { name: 'Ajuste de pantalla' }).click();
    const d2 = phone.getByRole('dialog');
    await d2.getByRole('radio', { name: /Respeto en familia/ }).click();
    await d2.getByLabel('Días de pausa').fill('2');
    await d2.getByRole('button', { name: 'Aplicar ajuste' }).click();
    await expect(phone.getByText(/Pausa puesta hasta/)).toBeVisible();
    await expect(panel.getByText(/^Pausa hasta /)).toBeVisible();
    await kid.goto('/');
    await expect(kid.getByText('Pausa hasta').first()).toBeVisible({ timeout: 15_000 });
    await kid.screenshot({ path: `${SHOTS}/80-hijo-pausa-375.png` });
    await kid.goto('/mesada');
    await expect(kid.getByRole('button', { name: 'Pedir pantalla' })).toBeDisabled();
    await expect(kid.getByRole('list', { name: 'Desglose del saldo de pantalla' })).toContainText('Tus minutos no caducan mientras tanto');
    expect((await api(kid, 'post', '/payout-requests', { kind: 'screen', minutes: 5, category: 'tele' })).body.error).toBe('paused');
    // Un adulto la termina antes.
    await panel.getByRole('button', { name: 'Terminar pausa' }).click();
    await expect(phone.getByText('Pausa terminada')).toBeVisible();
    await kid.reload();
    await expect(kid.getByRole('button', { name: 'Pedir pantalla' })).toBeEnabled();
    await phone.context().close();
  });

  test('privacidad y datos: descargar el ZIP, borrar un hijo y borrar la familia entera (contraseña y frase)', async ({ browser }) => {
    const DB = 'postgres://postgres:postgres@127.0.0.1:5432/mesada_e2e';
    const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
    const phone = async () => {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
      return ctx.newPage();
    };
    /** Lee el ZIP que descarga la app (nombre → contenido). */
    const unzip = (buf: Buffer) => {
      const out = new Map<string, Buffer>();
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      let q = buf.readUInt32LE(eocd + 16);
      for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
        const method = buf.readUInt16LE(q + 10), csize = buf.readUInt32LE(q + 20), nl = buf.readUInt16LE(q + 28), off = buf.readUInt32LE(q + 42);
        const name = buf.subarray(q + 46, q + 46 + nl).toString('utf8');
        const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
        const raw = buf.subarray(start, start + csize);
        out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
        q += 46 + nl + buf.readUInt16LE(q + 30) + buf.readUInt16LE(q + 32);
      }
      return out;
    };

    // 1) Descargar todos los datos de la familia desde Ajustes (móvil).
    const a = await phone();
    await login(a, ADULT.user, ADULT.pass);
    await expect(a.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await a.goto('/ajustes');
    const section = a.getByRole('region', { name: 'Privacidad y datos' });
    await expect(section).toBeVisible();
    await expect(section).toContainText(/Aceptaste la política de privacidad y las condiciones el .* \(versión \d{4}-\d{2}-\d{2}\)/);
    await section.scrollIntoViewIfNeeded();
    expect(await a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await a.screenshot({ path: `${SHOTS}/87-ajustes-privacidad-375.png` });
    const [dl] = await Promise.all([a.waitForEvent('download'), section.getByRole('link', { name: /Descargar los datos de la familia/ }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^diplop-familia-\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = unzip(fs.readFileSync((await dl.path())!));
    expect([...zip.keys()]).toEqual(expect.arrayContaining(['LEEME.txt', 'miembros.json', 'tareas-hechas.json', 'puntos.json', 'dinero.json', 'historial.json']));
    const miembros = JSON.parse(zip.get('miembros.json')!.toString()).miembros.map((m: any) => m.display_name);
    expect(miembros).toEqual(expect.arrayContaining([ADULT.name, KID.name, 'Hugo', 'Carlos']));
    expect([...zip.values()].map((b) => b.toString()).join('\n')).not.toMatch(/password_hash|scrypt\$|totp_secret/);
    // Un hijo no puede descargarlo.
    expect((await api(kid, 'get', '/privacy/export')).status).toBe(403);
    await a.context().close();

    // 2) Una familia de usar y tirar (con el registro abierto un momento) para borrar sin tocar la principal.
    sql(`INSERT INTO install_settings(key, value) VALUES ('registration_open', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    try {
      const p = await phone();
      await p.goto('/configurar');
      await p.getByLabel('Nombre de la familia').fill('Familia Efímera');
      await p.getByLabel('Tu nombre').fill('Eva');
      await p.getByLabel('Usuario').fill('eva.efimera');
      await p.getByLabel('Correo').fill('eva@example.com');
      await p.getByLabel('Contraseña').fill('contrasena-eva-1');
      await p.getByRole('checkbox', { name: /acepto/i }).check();
      await p.getByRole('button', { name: 'Crear familia' }).click();
      await expect(p.getByRole('heading', { name: 'Familia', exact: true })).toBeVisible();
      const famId = sql(`SELECT family_id FROM users WHERE username = 'eva.efimera'`);
      const peque = (await api(p, 'post', '/members', { role: 'child', displayName: 'Peque', username: 'peque.efimero', password: '4321', weeklyGoalPoints: 50 })).body.member;
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      expect((await api(p, 'post', '/tasks', { title: 'Foto del cuarto', points: 10, recurrence: 'daily', startDate: today, assignees: [peque.id], requiresPhoto: true })).status).toBe(200);
      // El hijo sube una foto de evidencia.
      const kctx = await browser.newContext({ locale: 'es-ES' });
      expect((await kctx.request.post('/api/auth/login', { data: { username: 'peque.efimero', password: '4321' }, headers: { 'X-Mesada': '1' } })).status()).toBe(200);
      const inst = (await (await kctx.request.get('/api/instances')).json()).instances[0];
      const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');
      const up = await kctx.request.post(`/api/instances/${inst.id}/complete`, { multipart: { photo: { name: 'cuarto.jpg', mimeType: 'image/jpeg', buffer: jpeg }, note: 'ya está' }, headers: { 'X-Mesada': '1' } });
      expect(up.status(), await up.text()).toBe(200);
      const dir = path.join(process.cwd(), '.data/uploads', famId);
      expect(fs.readdirSync(dir)).toHaveLength(1);
      // Y una sesión abierta del hijo, que dejará de valer.
      expect(sql(`SELECT count(*) FROM sessions WHERE user_id = '${peque.id}'`)).toBe('1');

      // 2a) Borrar al hijo: pide contraseña (con una mala, no borra) y se lleva la foto.
      await p.goto('/familia');
      await p.getByRole('button', { name: 'Editar a Peque' }).click();
      await p.getByRole('button', { name: /Borrar los datos de Peque/ }).click();
      const sheet = p.getByRole('dialog').last();
      const confirm = sheet.getByRole('button', { name: /Borrar a Peque para siempre/ });
      await expect(confirm).toBeDisabled();
      await sheet.getByLabel('Tu contraseña').fill('mala-contrasena-9');
      await p.screenshot({ path: `${SHOTS}/88-borrar-hijo-375.png` });
      await confirm.click();
      await expect(sheet.getByRole('alert')).toHaveText('La contraseña no es correcta');
      expect(sql(`SELECT count(*) FROM users WHERE id = '${peque.id}'`)).toBe('1');
      await sheet.getByLabel('Tu contraseña').fill('contrasena-eva-1');
      await confirm.click();
      await expect(p.getByText('Se han borrado los datos de Peque')).toBeVisible();
      await expect(p.getByText('@peque.efimero')).toHaveCount(0);
      expect(sql(`SELECT count(*) FROM users WHERE id = '${peque.id}'`)).toBe('0');
      expect(sql(`SELECT count(*) FROM task_instances WHERE family_id = '${famId}' AND assignee_id IS NOT NULL`)).toBe('0');
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toHaveLength(0);
      expect((await kctx.request.get('/api/me')).status()).toBe(401);
      await kctx.close();

      // 2b) Borrar la familia entera: botón bloqueado hasta escribir la frase; contraseña mala no borra.
      await p.goto('/ajustes');
      await p.getByRole('button', { name: /Borrar la familia entera/ }).click();
      const dlg = p.getByRole('dialog').last();
      const go = dlg.getByRole('button', { name: 'Borrar para siempre' });
      await expect(go).toBeDisabled();
      await dlg.getByLabel('Tu contraseña').fill('mala-contrasena-9');
      await dlg.getByLabel(/Escribe BORRAR MI FAMILIA/).fill('borrar mi');
      await expect(go).toBeDisabled();
      await dlg.getByLabel(/Escribe BORRAR MI FAMILIA/).fill('borrar mi familia');
      await expect(go).toBeEnabled();
      await p.screenshot({ path: `${SHOTS}/89-borrar-familia-375.png` });
      await go.click();
      await expect(dlg.getByRole('alert')).toHaveText('La contraseña no es correcta');
      expect(sql(`SELECT count(*) FROM families WHERE id = '${famId}'`)).toBe('1');
      await dlg.getByLabel('Tu contraseña').fill('contrasena-eva-1');
      await go.click();
      // Vuelve a la bienvenida, sin sesión, y no queda nada.
      await expect(p.getByRole('heading', { level: 1, name: /Tareas de casa, puntos y mesada/ })).toBeVisible();
      expect(sql(`SELECT count(*) FROM families WHERE id = '${famId}'`)).toBe('0');
      for (const t of ['users', 'tasks', 'task_instances', 'points_ledger', 'audit_log', 'notification_outbox', 'sessions']) {
        const col = t === 'sessions' ? `user_id IN (SELECT id FROM users WHERE family_id = '${famId}')` : `family_id = '${famId}'`;
        expect(sql(`SELECT count(*) FROM ${t} WHERE ${col}`), t).toBe('0');
      }
      expect(fs.existsSync(dir)).toBe(false);
      expect((await api(p, 'get', '/me')).status).toBe(401);
      await login(p, 'eva.efimera', 'contrasena-eva-1');
      await expect(p.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos');
      await p.context().close();
    } finally {
      sql(`DELETE FROM install_settings WHERE key = 'registration_open'`);
    }
    // La familia principal sigue entera.
    expect((await api(adult, 'get', '/me')).status).toBe(200);
    expect(sql(`SELECT count(*) FROM families`)).toBe('1');
  });

  test('administración › Sistema: disco, copias con aviso, limpieza y familias inactivas, a 375 px', async ({ browser }) => {
    const DB = 'postgres://postgres:postgres@127.0.0.1:5432/mesada_e2e';
    const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
    // Carpeta de copias de prueba que lee la API (BACKUP_DIR): una copia local y una subida a R2, ambas de hace más de 26 h.
    const dir = path.join(process.cwd(), '.data/backups');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 30 * 3600_000);
    for (const [n, b] of [['mesada-20261121-030000.dump', 5_000_000], ['fotos-20261121-030000.tar.gz', 800_000]] as const) {
      fs.writeFileSync(path.join(dir, n), Buffer.alloc(b));
      fs.utimesSync(path.join(dir, n), old, old);
    }
    fs.writeFileSync(path.join(dir, '.r2-list.txt'), `5000100;${old.toISOString()};mesada-20261121-030000.dump.gpg\n`);
    fs.writeFileSync(path.join(dir, '.r2-ok'), '');
    fs.utimesSync(path.join(dir, '.r2-ok'), old, old);
    // Una familia dormida (8 meses sin uso), inventada, con una sola persona.
    const fam = sql(`INSERT INTO families(name, created_at) VALUES ('Familia Dormida', now() - interval '8 months') RETURNING id`).split('\n')[0];
    sql(`INSERT INTO users(family_id, role, display_name, username, password_hash, last_login_at, created_at) VALUES ('${fam}', 'adult', 'Adulto Dormido', 'dormido', 'x', now() - interval '8 months', now() - interval '8 months')`);

    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
    const p = await ctx.newPage();
    await login(p, ADULT.user, ADULT.pass);
    await expect(p.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    sql(`UPDATE sessions SET admin_verified_at = now() WHERE user_id = (SELECT id FROM users WHERE username = '${ADULT.user}')`);
    await p.goto('/administracion');
    await p.getByRole('radio', { name: 'Sistema' }).click();
    const noOverflow = () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // (a) Disco y datos.
    const disk = p.getByRole('region', { name: /Disco y datos/ });
    await expect(disk).toContainText('Volumen de datos');
    await expect(disk).toContainText(/Fotos de evidencia\s*\d+ ·/);
    await expect(disk).toContainText('Base de datos');
    // (b) Copias: lista local y R2, y aviso visible porque la última pasa de 26 h.
    const copias = p.getByRole('region', { name: 'Copias de seguridad' });
    await expect(copias.getByRole('alert')).toContainText('más de 26 horas');
    await expect(copias).toContainText('mesada-20261121-030000.dump');
    await expect(copias).toContainText('mesada-20261121-030000.dump.gpg');
    await expect(copias).toContainText('Última subida correcta');
    expect(await noOverflow()).toBeLessThanOrEqual(0);
    await p.screenshot({ path: `${SHOTS}/92-admin-sistema-disco-copias-375.png`, fullPage: true });
    // Limpieza manual: informa de lo borrado y queda en el registro.
    await p.getByRole('button', { name: 'Limpiar basura' }).click();
    await expect(p.getByRole('status').filter({ hasText: /Borrado:/ })).toContainText('Liberado');
    expect(sql(`SELECT count(*) FROM admin_audit WHERE action = 'maintenance.cleanup'`)).toBe('1');
    await p.getByRole('region', { name: 'Limpieza' }).scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/93-admin-limpieza-375.png` });
    // (c) Familias inactivas: solo nombre, personas y fechas.
    const inact = p.getByRole('region', { name: 'Familias inactivas' });
    await expect(inact).toContainText('Familia Dormida');
    await expect(inact).toContainText('1 persona');
    await expect(inact).not.toContainText(/Adulto Dormido|@dormido/);
    await inact.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/94-admin-familias-inactivas-375.png` });
    await inact.getByRole('button', { name: /Borrar la familia Familia Dormida/ }).click();
    const dlg = p.getByRole('dialog').last();
    const go = dlg.getByRole('button', { name: 'Borrar para siempre' });
    await expect(go).toBeDisabled();
    await dlg.getByLabel(/nombre exacto/).fill('Familia Dormida');
    await expect(go).toBeDisabled();
    await dlg.getByLabel(/Escribe BORRAR FAMILIA INACTIVA/).fill('borrar familia inactiva');
    await expect(go).toBeEnabled();
    await p.screenshot({ path: `${SHOTS}/95-admin-borrar-inactiva-375.png` });
    await go.click();
    await expect(p.getByText('Familia borrada')).toBeVisible();
    expect(sql(`SELECT count(*) FROM families WHERE id = '${fam}'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM admin_audit WHERE action = 'family.erase_inactive' AND family_id IS NULL`)).toBe('1');
    await expect(p.getByRole('region', { name: 'Familias inactivas' })).toContainText('Ninguna familia inactiva');
    fs.rmSync(dir, { recursive: true, force: true });
    await ctx.close();
  });

  test('vigilancia: /api/health comprueba la base y un fallo del servidor enseña su código', async ({ browser }) => {
    const h = await api(adult, 'get', '/health');
    expect(h).toMatchObject({ status: 200, body: { ok: true, db: 'up' } });
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 375, height: 812 }, hasTouch: true, locale: 'es-ES', timezoneId: 'Europe/Madrid' });
    const p = await ctx.newPage();
    await login(p, ADULT.user, ADULT.pass);
    await expect(p.getByRole('link', { name: /Validar/ }).first()).toBeVisible();
    await p.route('**/api/dashboard', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', errorId: 'K7M2QX9R', message: 'Algo ha fallado por nuestra parte. Indica este código: K7M2QX9R' }) }));
    await p.goto('/');
    const banner = p.getByRole('alert').filter({ hasText: 'K7M2QX9R' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Algo ha fallado en el servidor');
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await p.screenshot({ path: `${SHOTS}/90-error-con-codigo-375.png` });
    await ctx.close();
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
