# Pendientes y mejoras

Estado: ✅ hecho y probado · 🟡 parcial · ⬜ pendiente

## Hecho en la versión 0.1

- ✅ Investigación de referencias con capturas (Nipto, KidTask, GrowTide y Homey), distinguiendo lo verificado de lo secundario
- ✅ Autenticación con roles, sesiones revocables, CSRF, límite por IP y bloqueo por cuenta
- ✅ Familias, miembros (adultos e hijos), avatares, objetivos semanales y desactivación
- ✅ Tareas puntuales, diarias, semanales y mensuales con días concretos; reparto individual, compartido o por turnos
- ✅ Aprobación parental, rechazo con nota, ajuste de puntos al aprobar y foto de evidencia privada
- ✅ Vencimientos y control de pendientes de validar
- ✅ Puntos, cierres con tasa y límite, pagos reales, ajustes, hucha y metas
- ✅ Recompensas no monetarias con reserva y devolución de puntos
- ✅ Gamificación: niveles, insignias, rachas, objetivo semanal y clasificación opcional
- ✅ Panel parental, estadísticas semanales y mensuales, e historial inmutable
- ✅ Avisos dentro de la app (recordatorio diario y eventos)
- ✅ PWA instalable, modo oscuro, móvil y escritorio
- ✅ Docker Compose con copias diarias y restauración verificada
- ✅ Notificaciones multicanal (aplicación, correo y WhatsApp) con preferencias, horario de silencio, recordatorios, topes, reintentos y deduplicación; recuperación de contraseña e invitaciones por correo (en simulado)
- ✅ Análisis de reutilización de la infraestructura de TEINVITO y artefactos de despliegue en la VM compartida
- ✅ Pruebas: 61 unitarias y de integración (API + PostgreSQL) y 15 E2E (Playwright)

## Pendiente (por prioridad)

| # | Tarea | Motivo |
|---|---|---|
| P1 | 🟡 **Activar correo y WhatsApp reales**: hecho y probado en simulado. Faltan las acciones del usuario en `infraestructura-compartida.md` §4 (clave de Resend propia, teléfono familiar, token de Cloudflare, secreto SSH) y la prueba controlada | Requiere secretos y decisiones del usuario |
| P2 | ⬜ Web Push (VAPID) como canal adicional del módulo de notificaciones | Avisos del sistema sin WhatsApp |
| P2b | ⬜ Ampliaciones de la especificación v1.0 del usuario: categorías, estado «cancelada», mesada fija o mixta (modalidades B y C), cierre quincenal, tasa por hijo, calendario mensual con reasignación | Especificación recibida el 21/11 (su apartado 11.4 llegó cortado) |
| P3 | ⬜ **Confirmación propia** en lugar de `confirm()` del navegador al archivar tareas y recompensas, con opción de deshacer | Auditoría de interfaz (estética y coherencia) |
| P4 | ⬜ Rotación «según quién la hizo la última vez» y repetición «cada X días tras completarla» | Funciones vistas en Nipto; la rotación actual es secuencial |
| P5 | ⬜ Plantillas de tareas comunes al crear la familia | Arranque más rápido (como GrowTide) |
| P6 | ⬜ Opción por familia de **no convertir automáticamente** los puntos (permitir ahorrar puntos para recompensas grandes) | Ver decisión D9 |
| P7 | ⬜ Cierre automático programado (p. ej. lunes 08:00) con aviso a los adultos | Hoy el cierre es manual, con un botón |
| P8 | ⬜ Exportación CSV de movimientos y pagos | Transparencia y archivo |
| P9 | ⬜ Revisar los avisos de `npm audit` de `workbox-build` cuando haya versión corregida | Decisión D14 |
| P10 | ⬜ Bloqueo de cuenta persistente (en la base de datos) si se despliegan varias instancias | Decisión D15 |
| P12 | ⬜ Inspeccionar por dentro play.nipto.app y la app web de KidTask con una cuenta autorizada | No había cuenta autorizada; ver `research/investigacion.md` |
| P13 | ⬜ Pruebas E2E en Firefox/WebKit y de accesibilidad automatizada (axe) | Hoy solo Chromium |
| P14 | ⬜ Traducciones (la base ya usa `Intl`) | Fuera del alcance inicial |
