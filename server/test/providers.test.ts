import { afterEach, describe, expect, it } from 'vitest';
import { getProviders, ResendEmailProvider, setProviders } from '../src/lib/notify/providers.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = { to: 'ana@example.com', subject: 'Prueba', body: 'Hola', link: 'https://mesada.veryfacil.org/', idempotencyKey: 'mesada:reset:1:email' };

describe('proveedor Resend', () => {
  it('envía con la clave de idempotencia, remitente y texto con enlace', async () => {
    const f = fakeFetch(json(200, { id: 're_123' }));
    const p = new ResendEmailProvider('re_test', '"Mesada" <avisos@veryfacil.org>', f.fn);
    expect(await p.send(msg)).toEqual({ ok: true, externalId: 're_123' });
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer re_test');
    expect(h['idempotency-key']).toBe('mesada:reset:1:email');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: '"Mesada" <avisos@veryfacil.org>', to: ['ana@example.com'], subject: 'Prueba' });
    expect(body.text).toBe('Hola\n\nhttps://mesada.veryfacil.org/');
    expect(body.html).toContain('Abrir DiploP');
  });

  it('clasifica las respuestas: 429 y 5xx se reintentan; 401 y 422 no', async () => {
    const p = (r: Response) => new ResendEmailProvider('k', 'a@b.c', fakeFetch(r).fn);
    expect(await p(json(429, { message: 'rate' })).send(msg)).toMatchObject({ ok: false, retryable: true });
    expect(await p(json(503, {})).send(msg)).toMatchObject({ ok: false, retryable: true });
    expect(await p(json(401, { message: 'API key is invalid' })).send(msg)).toMatchObject({ ok: false, retryable: false, error: 'Resend 401: API key is invalid' });
    expect(await p(json(422, { message: 'The veryfacil.org domain is not verified' })).send(msg)).toMatchObject({ ok: false, retryable: false });
  });

  it('un corte de red con clave de idempotencia se reintenta; sin clave queda incierto', async () => {
    const withKey = new ResendEmailProvider('k', 'a@b.c', fakeFetch(new Error('reset')).fn);
    expect(await withKey.send(msg)).toMatchObject({ ok: false, retryable: true });
    const noKey = new ResendEmailProvider('k', 'a@b.c', fakeFetch(new Error('reset')).fn);
    expect(await noKey.send({ ...msg, idempotencyKey: undefined })).toMatchObject({ ok: false, retryable: false, uncertain: true });
  });
});

describe('selección de proveedores por entorno', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setProviders(null);
  });
  it('sin NOTIFY_REAL_SEND todo es simulado aunque haya claves', async () => {
    const { getProviders: fresh } = await import('../src/lib/notify/providers.js?sim' as string);
    process.env.RESEND_API_KEY = 're_x';
    process.env.MAIL_FROM = 'avisos@veryfacil.org';
    expect(fresh().email.real).toBe(false);
    expect(getProviders().whatsapp.real).toBe(false);
  });
  it('con NOTIFY_REAL_SEND=true y clave de Resend usa Resend', async () => {
    process.env.NOTIFY_REAL_SEND = 'true';
    process.env.RESEND_API_KEY = 're_x';
    process.env.MAIL_FROM = 'avisos@veryfacil.org';
    const { getProviders: fresh } = await import('../src/lib/notify/providers.js?real' as string);
    expect(fresh().email.name).toBe('resend');
    expect(fresh().email.real).toBe(true);
  });
});
