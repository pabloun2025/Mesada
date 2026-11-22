import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION } from '../src/lib/legal.js';

const root = path.resolve(__dirname, '../..');
const legal = path.join(root, 'docs/legal');

describe('Textos legales (D48)', () => {
  const files = ['privacidad.md', 'aviso-legal.md', 'condiciones.md'];

  it('cada texto lleva la versión vigente: si cambian de fondo hay que subir LEGAL_VERSION en los dos sitios', () => {
    for (const f of files) expect(fs.readFileSync(path.join(legal, f), 'utf8'), f).toContain(`Versión ${LEGAL_VERSION}`);
  });

  it('el contenido que lleva la web (web/src/legal/content.ts) coincide con docs/legal', () => {
    expect(() => execFileSync('node', [path.join(root, 'web/scripts/legal.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('cubre lo que exige la política: contacto, AEPD, menores, derechos, cookies técnicas y proveedores reales', () => {
    const p = fs.readFileSync(path.join(legal, 'privacidad.md'), 'utf8');
    for (const s of ['privacidad@veryfacil.org', 'Agencia Española de Protección de Datos', 'mayor de edad', 'patria potestad', 'portabilidad', 'solo cookies técnicas', 'no mostramos un aviso de cookies', 'Oracle Cloud', 'Cloudflare', 'R2', 'Resend', 'WhatsApp', 'mesada_session', '30 días']) {
      expect(p, s).toContain(s);
    }
  });

  it('no cita a ninguna persona concreta y usa «el responsable de DiploP»', () => {
    for (const f of files) {
      const t = fs.readFileSync(path.join(legal, f), 'utf8');
      expect(t, f).toContain('el responsable de DiploP');
    }
    // Solo cuenta el correo de privacidad como contacto.
    const all = files.map((f) => fs.readFileSync(path.join(legal, f), 'utf8')).join('\n');
    const emails = new Set(all.match(/[\w.+-]+@[\w-]+(?:\.[a-z]+)+/g));
    expect([...emails]).toEqual(['privacidad@veryfacil.org']);
  });

  it('solo hay cookies técnicas: el servidor únicamente fija las de sesión y de dispositivo de administración', () => {
    const src = ['routes/auth.ts', 'routes/admin.ts', 'routes/notifications.ts', 'lib/auth.ts'].map((f) => fs.readFileSync(path.join(root, 'server/src', f), 'utf8')).join('\n');
    const cookies = new Set([...src.matchAll(/(?:setCookie|clearCookie)\(\s*([A-Za-z_.]+)/g)].map((m) => m[1]));
    expect([...cookies].sort()).toEqual(['DEVICE_COOKIE', 'SESSION_COOKIE']);
    // Y la web no carga nada de terceros ni usa document.cookie.
    const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/googletagmanager|google-analytics|fonts\.googleapis/i);
  });
});
