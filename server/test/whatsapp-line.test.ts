import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/lib/db.js';
import { lineConnect, lineStatus } from '../src/lib/notify/whatsapp-line.js';
import { config } from '../src/lib/config.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fake = (r: Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
};
const saved = { ...process.env };

describe('línea de WhatsApp (token de instancia)', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'http://evolution-api:8080';
    process.env.EVOLUTION_INSTANCE = 'mesada';
    process.env.EVOLUTION_INSTANCE_TOKEN = 'tok-instancia';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('consulta el estado con el token de la instancia, nunca con otra clave', async () => {
    const f = fake(json(200, { instance: { instanceName: 'mesada', state: 'open' } }));
    expect(await lineStatus(f.fn)).toEqual({ configured: true, state: 'open', error: null });
    expect(f.calls[0].url).toBe('http://evolution-api:8080/instance/connectionState/mesada');
    expect((f.calls[0].init.headers as Record<string, string>).apikey).toBe('tok-instancia');
  });
  it('devuelve el QR para vincular', async () => {
    const r = await lineConnect(undefined, fake(json(200, { base64: 'data:image/png;base64,AAA', code: 'x' })).fn);
    expect(r).toMatchObject({ ok: true, state: 'connecting', qr: 'data:image/png;base64,AAA' });
  });
  it('pide código de 8 caracteres con el número', async () => {
    const f = fake(json(200, { pairingCode: 'ABCD1234' }));
    const r = await lineConnect('+34600112233', f.fn);
    expect(r).toMatchObject({ ok: true, pairingCode: 'ABCD1234' });
    expect(f.calls[0].url).toBe('http://evolution-api:8080/instance/connect/mesada?number=34600112233');
  });
  it('explica si Evolution rechaza el token', async () => {
    expect(await lineStatus(fake(json(401, {})).fn)).toMatchObject({ error: 'Evolution no acepta el token de la instancia' });
    expect(await lineConnect(undefined, fake(json(403, {})).fn)).toMatchObject({ ok: false });
  });
  it('sin token configurado no llama a nadie', async () => {
    delete process.env.EVOLUTION_INSTANCE_TOKEN;
    const f = fake(json(200, {}));
    expect(await lineStatus(f.fn)).toMatchObject({ configured: false });
    expect(f.calls).toHaveLength(0);
  });
});

describe('permisos de la línea', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app.close();
    await closePool();
  });
  beforeEach(async () => {
    resetLoginFailures();
    await resetDb();
  });
  it('solo los adultos de la familia administradora', async () => {
    const F = await createFamily(app);
    config.allowRegistration = true;
    const G = await createFamily(app, 'g');
    config.allowRegistration = false;
    expect((await F.mama.get('/api/notify/whatsapp')).body.line).toMatchObject({ configured: false });
    expect((await F.luciaC.get('/api/notify/whatsapp')).status).toBe(403);
    expect((await G.mama.get('/api/notify/whatsapp')).status).toBe(403);
    expect((await G.mama.post('/api/notify/whatsapp/link', {})).status).toBe(403);
    const r = await F.mama.post('/api/notify/whatsapp/link', {});
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/aún no está preparada/);
  });
});
