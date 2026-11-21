import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { getPool, many, migrate } from './lib/db.js';
import { ensureInstances } from './lib/instances.js';
import { processOutbox } from './lib/notify/worker.js';
import { runWeeklyBank } from './lib/savings.js';

const app = await buildApp();
const applied = await migrate();
if (applied.length) app.log.info({ applied }, 'Migraciones aplicadas');

// Tarea periódica: genera ocurrencias, marca vencidas y crea recordatorios para todas las familias.
async function tick() {
  try {
    const fams = await many(getPool(), 'SELECT id FROM families');
    for (const f of fams) {
      await ensureInstances(getPool(), f.id);
      // Trabajo del lunes: interés del ahorro y cuotas de préstamos (idempotente, se repite sin riesgo).
      await runWeeklyBank(getPool(), f.id);
    }
  } catch (e) {
    app.log.error(e, 'Fallo en la tarea periódica');
  }
}
await tick();
// Recordatorios cada 5 minutos (la generación es idempotente) y cola de avisos cada 30 segundos.
const timer = setInterval(tick, 5 * 60 * 1000);
let sending = false;
const outboxTimer = setInterval(async () => {
  if (sending) return;
  sending = true;
  try {
    await processOutbox();
  } catch (e) {
    app.log.error(e, 'Fallo al procesar la cola de avisos');
  } finally {
    sending = false;
  }
}, 30 * 1000);

await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    clearInterval(outboxTimer);
    await app.close();
    await getPool().end();
    process.exit(0);
  });
}
