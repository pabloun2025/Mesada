import { closePool, migrate } from './lib/db.js';

const applied = await migrate();
console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Base de datos al día');
await closePool();
