import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { getPool, many, migrate } from './lib/db.js';
import { ensureInstances } from './lib/instances.js';

const app = await buildApp();
const applied = await migrate();
if (applied.length) app.log.info({ applied }, 'Migraciones aplicadas');

// Tarea periódica: genera ocurrencias, marca vencidas y crea recordatorios para todas las familias.
async function tick() {
  try {
    const fams = await many(getPool(), 'SELECT id FROM families');
    for (const f of fams) await ensureInstances(getPool(), f.id);
  } catch (e) {
    app.log.error(e, 'Fallo en la tarea periódica');
  }
}
await tick();
const timer = setInterval(tick, 15 * 60 * 1000);

await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    await getPool().end();
    process.exit(0);
  });
}
