// Utilidades para grabar los vídeos verticales (9:16) de la app real con Playwright.
// La app se muestra dentro de un iframe del mismo origen, debajo de una banda con el rótulo grande.
// Así los rótulos no tapan la interfaz y cada clic muestra un círculo que indica dónde se toca.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, BASE, sleep } from './lib.mjs';

export const VW = 390, VH = 693;          // diseño en 390 x 693 (9:16); se escala x2,77 a 1080 x 1920
export const SCALE = 1080 / VW;
export const CAP_H = 150;                 // alto de la banda del rótulo
export const OUT_DIR = '/tmp/mesada-video';
fs.mkdirSync(OUT_DIR, { recursive: true });

const BRAND = path.join(ROOT, 'web/public/brand');
const fontFile = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).find((f) => /^bricolage-grotesque-latin-wght-normal-.*\.woff2$/.test(f));

const STAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@font-face{font-family:Brico;src:url(/__brico.woff2);font-weight:200 800}
html,body{margin:0;height:100%;overflow:hidden;background:#eaf3fc}
#root{position:absolute;left:0;top:0;width:${VW}px;height:${VH}px;transform:scale(${SCALE});transform-origin:0 0;overflow:hidden}
#cap{position:absolute;left:0;right:0;top:0;height:${CAP_H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:0 18px;text-align:center;background:linear-gradient(#bcdcf8,#d7e9fa);border-bottom:3px solid #ffb800;z-index:2}
#cap .t{font:800 30px/1.1 Brico,sans-serif;color:#142a5c;letter-spacing:-.01em;animation:pop .45s cubic-bezier(.2,.9,.3,1.2)}
#cap .s{font:700 15px/1.2 Brico,sans-serif;color:#1d5fae;text-transform:uppercase;letter-spacing:.06em;animation:pop .45s}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
#app{position:absolute;left:0;top:${CAP_H}px;width:${VW}px;height:${VH - CAP_H}px;border:0;background:#fff}
</style></head><body><div id="root">
<div id="cap"><div class="s"></div><div class="t"></div></div>
<iframe id="app" src="about:blank"></iframe></div>
<script>
const app = document.getElementById('app');
function attach() {
  try {
    const d = app.contentDocument; if (!d || d.__ripple) return; d.__ripple = true;
    const st = d.createElement('style');
    st.textContent = '.__rp{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(255,184,0,.55);border:3px solid #ffb800;pointer-events:none;z-index:2147483647;animation:__rp .75s ease-out forwards}@keyframes __rp{from{transform:scale(.4);opacity:1}to{transform:scale(2.6);opacity:0}}';
    d.head.appendChild(st);
    d.addEventListener('pointerdown', (e) => { const r = d.createElement('div'); r.className = '__rp'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; d.body.appendChild(r); setTimeout(() => r.remove(), 800); }, true);
  } catch (e) {}
}
app.addEventListener('load', attach);
window.__cap = (sub, text) => { const c = document.getElementById('cap'); c.innerHTML = '<div class="s"></div><div class="t"></div>'; c.firstChild.textContent = sub || ''; c.firstChild.style.display = sub ? '' : 'none'; c.lastChild.textContent = text; };
window.__go = (u) => new Promise((res) => {
  app.src = u;
  const t0 = Date.now();
  const iv = setInterval(() => {
    try {
      const d = app.contentDocument;
      if ((d && d.readyState === 'complete' && d.location.href !== 'about:blank' && d.body && d.body.children.length) || Date.now() - t0 > 15000) { clearInterval(iv); attach(); setTimeout(res, 300); }
    } catch (e) {}
  }, 100);
});
</script></body></html>`;

const CARD = (kind) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
@font-face{font-family:Brico;src:url(/__brico.woff2);font-weight:200 800}
html,body{margin:0;height:100%;overflow:hidden;background:#d9eafa}
#root{position:absolute;left:0;top:0;width:${VW}px;height:${VH}px;transform:scale(${SCALE});transform-origin:0 0;overflow:hidden}
.bg{position:absolute;inset:0;overflow:hidden}
.bg img{position:absolute;left:0;width:100%;top:0;animation:kb 6s ease-out forwards;transform-origin:50% 80%}
@keyframes kb{from{transform:scale(1)}to{transform:scale(1.07)}}
.t{position:absolute;left:0;right:0;text-align:center;font-family:Brico,sans-serif;color:#142a5c}
.fade{position:absolute;inset:0;background:#fff;animation:f 0.6s ease-out forwards;pointer-events:none}
@keyframes f{from{opacity:1}to{opacity:0}}
${kind === 'outro' ? `
.bg{background:linear-gradient(#bcdcf8,#dcecfb 30%,#eaf3fc)}
.bg img{top:auto;bottom:0;height:auto;width:100%;animation:none;-webkit-mask-image:linear-gradient(transparent 38%,#000 46%)}
.t.a{top:34px;font-weight:800;font-size:31px;line-height:1.12;animation:up .8s .2s both}
.t.u{top:122px;animation:up .8s .6s both}
.t.u span{display:inline-block;background:#142a5c;color:#fff;font-weight:800;font-size:25px;border-radius:99px;padding:12px 26px;box-shadow:0 10px 24px -10px rgba(20,42,92,.6)}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}` : ''}
</style></head><body><div id="root"><div class="bg"><img src="/__tall.webp" alt=""></div>
${kind === 'outro' ? '<div class="t a">Tareas, puntos y mesada<br>para toda la familia</div><div class="t u"><span>mesada.veryfacil.org</span></div>' : ''}
<div class="fade"></div></div></body></html>`;

/** Rutas falsas del escenario y las tarjetas (mismo origen que la app). */
async function routes(ctx) {
  await ctx.route(BASE + '/__stage', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: STAGE }));
  await ctx.route(BASE + '/__card?*', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: CARD(new URL(r.request().url()).searchParams.get('k')) }));
  await ctx.route(BASE + '/__brico.woff2', (r) => r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(ROOT, 'web/dist/assets', fontFile)) }));
  // El servidor prohíbe incrustar la app (X-Frame-Options). Solo para grabar, se quita esa cabecera de los documentos HTML.
  await ctx.route(BASE + '/**', async (r) => {
    const req = r.request();
    if (req.resourceType() !== 'document' || req.url().includes('/__')) return r.fallback();
    const res = await r.fetch();
    const headers = { ...res.headers() };
    delete headers['x-frame-options'];
    await r.fulfill({ response: res, headers });
  });
  await ctx.route(BASE + '/__tall.webp', (r) => r.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.join(BRAND, 'hero-sky-tall.webp')) }));
}

const ctxOpts = (extra = {}) => ({
  viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1,
  locale: 'es-ES', timezoneId: 'Europe/Madrid', serviceWorkers: 'block', ...extra,
});

/** Guarda la sesión (cookies) de un usuario para grabar ya con la sesión iniciada. */
export async function saveState(browser, file, doLogin) {
  const ctx = await browser.newContext(ctxOpts());
  const p = await ctx.newPage();
  await doLogin(p);
  await ctx.storageState({ path: file });
  await ctx.close();
}

/**
 * Graba un clip. `run({ page, app, cap, go, type, pause })` hace de guion.
 * Devuelve la ruta del webm ya recortado del arranque.
 */
export async function recordClip(browser, name, run, { state, card, start = '/' } = {}) {
  const dir = path.join(OUT_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext(ctxOpts({ recordVideo: { dir, size: { width: 1080, height: 1920 } }, ...(state ? { storageState: state } : {}) }));
  await routes(ctx);
  const t0 = Date.now();
  const page = await ctx.newPage();
  const app = page.frameLocator('#app');
  let trim = 0;
  if (card) {
    await page.goto(`${BASE}/__card?k=${card.kind}`);
    await page.evaluate(() => document.fonts.ready);
    trim = (Date.now() - t0) / 1000 - 0.15;
    await sleep(card.seconds * 1000);
  } else {
    await page.goto(BASE + '/__stage');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate((u) => window.__go(u), BASE + start);
    await sleep(1500);
    trim = (Date.now() - t0) / 1000 - 0.15;
    const h = {
      page, app,
      cap: async (sub, text) => { await page.evaluate(([s, t]) => window.__cap(s, t), [sub, text]); },
      go: async (p) => { await page.evaluate((u) => window.__go(u), BASE + p); await sleep(900); },
      type: async (loc, text, delay = 70) => { await loc.click(); await loc.pressSequentially(text, { delay }); },
      pause: sleep,
      pulse: async (loc) => { await loc.evaluate((el) => el.animate([{ boxShadow: '0 0 0 0 rgba(255,184,0,.95)' }, { boxShadow: '0 0 0 16px rgba(255,184,0,0)' }], { duration: 900, iterations: 2 })); },
    };
    try { await run(h); } catch (e) { await page.screenshot({ path: `/tmp/err-${name}.png` }).catch(() => {}); throw e; }
  }
  console.log('clip', name, ((Date.now() - t0) / 1000).toFixed(1), 's de guion');
  const vid = page.video();
  await ctx.close();
  const file = path.join(OUT_DIR, `${name}.webm`);
  fs.copyFileSync(await vid.path(), file);
  return { file, trim: Math.max(0, trim) };
}

export const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

/** Une los clips con fundidos cortos, añade la música de fondo y codifica en H.264 1080x1920. */
export function assemble(clips, out, music, { fade = 0.35, crf = 27 } = {}) {
  const inputs = [], filters = [], durs = [];
  clips.forEach((c, i) => {
    const d = probe(c.file) - c.trim;
    durs.push(d);
    inputs.push('-i', c.file);
    filters.push(`[${i}:v]trim=start=${c.trim.toFixed(3)},setpts=PTS-STARTPTS,fps=30,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p[v${i}]`);
  });
  let last = 'v0', acc = durs[0];
  for (let i = 1; i < clips.length; i++) {
    const off = (acc - fade).toFixed(3);
    filters.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${off}[x${i}]`);
    last = `x${i}`; acc = acc + durs[i] - fade;
  }
  const total = acc;
  inputs.push('-i', music);
  const a = clips.length;
  filters.push(`[${a}:a]atrim=0:${total.toFixed(2)},afade=t=in:st=0:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[aud]`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-map', '[aud]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(2), out], { stdio: 'inherit' });
  return total;
}
