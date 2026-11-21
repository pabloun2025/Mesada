# Mesada

PWA familiar para organizar las **tareas de casa**, ganar **puntos**, canjear **recompensas** y gestionar la **mesada** (paga) en euros. Es autoalojada, sin servicios de pago y pensada para España.

Pensada para una familia con 2 adultos y 2 hijos (11 y 14 años), aunque admite más miembros.

| Panel familiar (móvil) | Hoy (hijo) | Mesada |
|---|---|---|
| ![Panel](docs/capturas/movil-adulto-panel.png) | ![Hoy](docs/capturas/movil-hijo-hoy.png) | ![Mesada](docs/capturas/movil-adulto-mesada.png) |

## Qué hace

- **Tareas** puntuales, diarias, semanales o mensuales, en días concretos; individuales, compartidas o **por turnos** entre hermanos; con plazo, foto de evidencia opcional y **validación parental**.
- **Puntos → euros:** equivalencia configurable (p. ej. 100 pts = 5 €), cierre semanal o mensual con **límite**, y registro de **pagos reales** (efectivo, Bizum…). Puntos, saldo convertido e importe pagado se muestran siempre por separado.
- **Recompensas** no monetarias con petición y aprobación, **hucha** y **metas de ahorro**.
- **Gamificación** sobria: anillo semanal, niveles, insignias, rachas que perdonan los días libres y clasificación familiar desactivable.
- **Panel parental:** qué toca hoy, qué validar, € de la semana, saldo pendiente, evolución y actividad.
- **Historial inmutable** de todas las operaciones con puntos y dinero.
- Instalable como app (PWA), con modo claro y oscuro, en español, con € y formatos de España.

## Puesta en marcha rápida (Docker)

```bash
cp .env.example .env   # cambia POSTGRES_PASSWORD
docker compose up -d --build
# abre http://localhost:8080 y crea tu familia
```

Guía completa (HTTPS, copias, actualización): [docs/despliegue.md](docs/despliegue.md).

## Desarrollo

Requisitos: Node 22 y PostgreSQL 16.

```bash
# API (puerto 3000)
cd server && npm install
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mesada npm run seed   # datos de demostración
npm run dev

# PWA (puerto 5173, proxy de /api al 3000)
cd web && npm install && npm run dev
```

Usuarios de demostración: `ana` / `demo-mesada` (adulta) · `lucia` / `1414` y `hugo` / `1111` (hijos).

## Pruebas

```bash
cd server && npm test                         # 41 pruebas unitarias y de integración contra PostgreSQL (mesada_test)
cd web && npm run build                       # tipos + compilación
cd e2e && npm install && npx playwright test --trace off   # 13 pruebas E2E: flujo completo de una familia
```

## Estructura

```
server/   API Fastify + PostgreSQL (migraciones SQL, lógica de puntos/mesada, pruebas)
web/      PWA React + TypeScript + Tailwind
e2e/      Pruebas Playwright de extremo a extremo
deploy/   Scripts de copia y restauración
docs/     Especificación, decisiones, pendientes, despliegue, investigación y capturas
```

## Documentación

- [Especificación funcional](docs/especificacion-funcional.md)
- [Registro de decisiones](docs/decisiones.md)
- [Pendientes](docs/pendientes.md)
- [Investigación de referencias](docs/research/investigacion.md)
- [Despliegue](docs/despliegue.md)
