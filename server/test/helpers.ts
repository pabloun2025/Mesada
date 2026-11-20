import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { getPool, migrate } from '../src/lib/db.js';

export async function resetDb() {
  const pool = getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
}

export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as any,
      url,
      payload: body as any,
      headers: { 'x-mesada': '1', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find((x) => x.startsWith('mesada_session='));
      if (c) this.cookie = c.split(';')[0];
    }
    let json: any;
    try {
      json = res.json();
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json, raw: res };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown, h?: Record<string, string>) => this.req('POST', u, b ?? {}, h);
  put = (u: string, b?: unknown) => this.req('PUT', u, b);
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b);
  del = (u: string) => this.req('DELETE', u);
}

/** Crea una familia con 2 adultos y 2 hijos y devuelve clientes autenticados. */
export async function createFamily(app: FastifyInstance, prefix = 'f') {
  const mama = new Client(app);
  const s = await mama.post('/api/setup', { familyName: `Familia ${prefix}`, displayName: 'Mamá', username: `${prefix}mama`, password: 'contrasena-segura' });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  const mk = async (role: string, name: string, user: string, password: string) =>
    (await mama.post('/api/members', { role, displayName: name, username: user, password, birthYear: 2012, weeklyGoalPoints: 100 })).body.member;
  const papa = await mk('adult', 'Papá', `${prefix}papa`, 'otra-contrasena');
  const lucia = await mk('child', 'Lucía', `${prefix}lucia`, '1234');
  const hugo = await mk('child', 'Hugo', `${prefix}hugo`, '5678');
  const login = async (u: string, p: string) => {
    const c = new Client(app);
    const r = await c.post('/api/auth/login', { username: u, password: p });
    if (r.status !== 200) throw new Error('login failed');
    return c;
  };
  return {
    mama,
    papaC: await login(`${prefix}papa`, 'otra-contrasena'),
    luciaC: await login(`${prefix}lucia`, '1234'),
    hugoC: await login(`${prefix}hugo`, '5678'),
    ids: { lucia: lucia.id, hugo: hugo.id, papa: papa.id, mama: s.body.user.id, family: s.body.user.family_id },
  };
}
