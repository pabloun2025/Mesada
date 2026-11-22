# Mesada — notas para agentes

PWA familiar de tareas, puntos y mesada. Monorepo: `server/` (Fastify + PostgreSQL), `web/` (React + Vite + Tailwind), `e2e/` (Playwright), `deploy/` (Docker), `docs/` (especificación, decisiones, pendientes, investigación).

## Skills del proyecto (`.claude/skills/`)
Instaladas a mano (copia de la carpeta oficial), solo las necesarias:
- `agent-browser` (vercel-labs/agent-browser): stub; requiere el CLI global `npm i -g agent-browser`. Ejecuta `agent-browser skills get core` antes de usarlo.
- `replica` (albertirgi/replica): `npm install --prefix .claude/skills/replica/scripts` y luego `node .claude/skills/replica/scripts/replica.mjs doctor`.
- `frontend-design` (anthropics/skills), `react-best-practices` y `web-design-guidelines` (vercel-labs/agent-skills).
- `ui-ux-pro-max` (nextlevelbuilder/ui-ux-pro-max-skill): reglas de UI/UX y buscador de estilos; `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<consulta>" --design-system`. Solo Python, sin red.
- `playwright-cli` (microsoft/playwright-cli): requiere `npm i -g @playwright/cli`.
- superpowers (obra/superpowers) ya viene como plugin del entorno.

## Entorno en la nube
- Chromium preinstalado en `/opt/pw-browsers/chromium`. Para agent-browser:
  `export AGENT_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium AGENT_BROWSER_ARGS=--no-sandbox`
- La red sale por un proxy con lista de hosts permitidos. Si un host devuelve `403 agent proxy`, no es un problema de DNS: hay que permitirlo en el entorno.
- PostgreSQL 16 local para desarrollo y pruebas: `postgres://postgres:postgres@127.0.0.1:5432/mesada` (y `mesada_test`).

## Privacidad, abusos y copias (D48–D55)
- Textos legales: la fuente es `docs/legal/*.md`; `cd web && npm run legal` los vuelca a `web/src/legal/content.ts` (versionado; CI lo comprueba). Al cambiarlos de fondo, sube `LEGAL_VERSION` (`server/src/lib/legal.ts`) y la «Versión» de los `.md`.
- Borrar familia o hijo (`server/src/lib/privacy.ts`) usa `set_config('mesada.erasure','on',true)`: es lo único que permite borrar libros e historial (disparadores de la migración 013). No lo uses para nada más.
- Límites por IP (`lib/limits.ts`, variables `RATE_*`) y topes (`MAX_*`) están documentados en `docs/despliegue.md`. Datos y secretos: nunca en registros ni en el repositorio (es público).
- Copias externas cifradas en R2: `deploy/backup.sh`, `deploy/r2.sh`; prueba local sin red con `sh deploy/test-backup.sh`.
- Vídeos y manual: scripts en `e2e/media/` (ver `docs/video/guion.md`); tras cambiar la interfaz hay que regenerar capturas, vídeos y PDF.

## Comandos
- API: `cd server && npm run dev` · pruebas `npm test` · tipos `npm run typecheck`
- Web: `cd web && npm run dev` (proxy de /api a :3000) · `npm run build`
- E2E: `cd e2e && npx playwright test --trace off`
