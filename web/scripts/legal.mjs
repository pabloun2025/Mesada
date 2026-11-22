// Genera src/legal/content.ts a partir de los textos de docs/legal/*.md (la fuente de verdad).
// El fichero generado se versiona porque la imagen de Docker solo copia web/ y no ve docs/.
//   node scripts/legal.mjs            → escribe el fichero
//   node scripts/legal.mjs --if-present → igual, pero no hace nada si no existe docs/legal (compilación en Docker)
//   node scripts/legal.mjs --check    → falla si el fichero generado no coincide con los .md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../docs/legal');
const out = path.resolve(here, '../src/legal/content.ts');
const DOCS = { privacidad: 'privacidad.md', 'aviso-legal': 'aviso-legal.md', condiciones: 'condiciones.md' };

if (!fs.existsSync(src)) {
  if (process.argv.includes('--if-present')) process.exit(0);
  console.error('No existe docs/legal');
  process.exit(1);
}
const body = Object.entries(DOCS).map(([k, f]) => `  ${JSON.stringify(k)}: ${JSON.stringify(fs.readFileSync(path.join(src, f), 'utf8'))},`).join('\n');
const text = `// GENERADO por scripts/legal.mjs a partir de docs/legal/*.md. No lo edites a mano: edita los .md y ejecuta «npm run legal».\nexport const LEGAL_TEXTS = {\n${body}\n} as const;\nexport type LegalDoc = keyof typeof LEGAL_TEXTS;\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
    console.error('src/legal/content.ts no está al día con docs/legal. Ejecuta «npm run legal».');
    process.exit(1);
  }
} else {
  fs.writeFileSync(out, text);
}
