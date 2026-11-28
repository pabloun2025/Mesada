import { one, type Db } from './db.js';
import { addPoints } from './ledger.js';
import { addScreen } from './screen.js';
import { notify } from './notify/dispatch.js';

export interface BonusTask {
  id: string;
  title: string;
  bonus_kind: 'points' | 'screen' | 'text' | 'reward' | null;
  bonus_points: number | null;
  bonus_minutes: number | null;
  bonus_text: string | null;
  bonus_reward_id: string | null;
  bonus_reward_title?: string | null;
  bonus_reward_cost?: number | null;
  bonus_surprise: boolean;
  bonus_on_time_only: boolean;
  bonus_allow_swap?: boolean;
}

/** Texto legible del bono de una tarea (para la etiqueta y para el adulto). */
export function bonusLabel(t: Pick<BonusTask, 'bonus_kind' | 'bonus_points' | 'bonus_minutes' | 'bonus_text' | 'bonus_reward_title'>): string | null {
  switch (t.bonus_kind) {
    case 'points': return `+${t.bonus_points} puntos extra`;
    case 'screen': return `+${t.bonus_minutes} min de pantalla`;
    case 'text': return t.bonus_text ?? null;
    case 'reward': return t.bonus_reward_title ? `Premio: ${t.bonus_reward_title}` : 'Premio del catálogo';
    default: return null;
  }
}

/**
 * Bono visible de cara a quien mira. A un hijo nunca se le manda el contenido de una sorpresa que aún no ha ganado.
 * `claimed` = el hijo ya ganó esa sorpresa (después la tarea es normal y no hay bono).
 */
export function bonusView(t: BonusTask, viewer: 'adult' | 'child', claimed: boolean) {
  if (!t.bonus_kind) return null;
  if (t.bonus_surprise) {
    if (claimed && viewer === 'child') return null;
    if (viewer === 'child') return { surprise: true as const, onTimeOnly: t.bonus_on_time_only };
    return { surprise: true as const, onTimeOnly: t.bonus_on_time_only, kind: t.bonus_kind, label: bonusLabel(t), claimed, allowSwap: !!t.bonus_allow_swap };
  }
  return { surprise: false as const, onTimeOnly: t.bonus_on_time_only, kind: t.bonus_kind, label: bonusLabel(t) };
}

export const BONUS_COLUMNS = ['bonus_kind', 'bonus_points', 'bonus_minutes', 'bonus_text', 'bonus_reward_id', 'bonus_surprise', 'bonus_allow_swap'] as const;

const key = (base: string, seq: number) => (seq <= 1 ? base : `${base}:${seq}`);

interface GrantCtx {
  instanceId: string;
  userId: string;
  familyId: string;
  actorId: string | null;
  /** false solo si se completó tarde (null/true cuentan como a tiempo). */
  onTime: boolean | null;
  /** Número de decisión (solo tareas de comprobación): permite volver a conceder tras una corrección. */
  seq?: number;
}

async function applyGrantEffects(db: Db, g: { id: string; points: number; minutes: number; task_title: string }, c: GrantCtx) {
  const seq = c.seq ?? 1;
  if (g.points) {
    await addPoints(db, { familyId: c.familyId, userId: c.userId, delta: g.points, kind: 'bonus', refId: c.instanceId, note: `Bono: ${g.task_title}`, createdBy: c.actorId, idempotencyKey: key(`bonus:${c.instanceId}`, seq) });
  }
  if (g.minutes) {
    await addScreen(db, { familyId: c.familyId, userId: c.userId, delta: g.minutes, kind: 'bonus', refId: c.instanceId, note: `Bono: ${g.task_title}`, createdBy: c.actorId, idempotencyKey: key(`bonus-min:${c.instanceId}`, seq) });
  }
}

/**
 * Concede el bono de la tarea al aprobarla. Devuelve la concesión o null si no procede.
 * - Visible: cada vez. - Sorpresa: una sola vez por (tarea, hijo), la primera vez que cumple las condiciones.
 * - `bonus_on_time_only`: si se completó tarde no se concede (y una sorpresa no se «gasta»).
 */
export async function grantBonus(db: Db, c: GrantCtx) {
  const t = await one<BonusTask & { task_id: string }>(
    db,
    `SELECT t.id AS task_id, t.id, t.title, t.bonus_kind, t.bonus_points, t.bonus_minutes, t.bonus_text, t.bonus_reward_id, t.bonus_surprise,
            t.bonus_on_time_only, t.bonus_allow_swap, r.title AS bonus_reward_title, r.cost_points AS bonus_reward_cost
       FROM task_instances i JOIN tasks t ON t.id = i.task_id LEFT JOIN rewards r ON r.id = t.bonus_reward_id
      WHERE i.id = $1`,
    [c.instanceId],
  );
  if (!t?.bonus_kind) return null;
  if (t.bonus_on_time_only && c.onTime === false) return null;
  const catalogSurprise = t.bonus_kind === 'reward' && t.bonus_surprise;
  const snapshot = [
    catalogSurprise && !!t.bonus_allow_swap && !!t.bonus_reward_cost,
    catalogSurprise ? t.bonus_reward_id : null,
    catalogSurprise ? t.bonus_reward_title ?? null : null,
    catalogSurprise ? t.bonus_reward_cost ?? null : null,
  ];

  // ¿Ya se concedió a esta ocurrencia (corrección de una tarea de comprobación)? Se reactiva, no se duplica.
  const existing = await one<any>(db, 'SELECT * FROM bonus_grants WHERE instance_id = $1 AND user_id = $2 FOR UPDATE', [c.instanceId, c.userId]);
  if (existing) {
    if (!existing.voided_at) return existing;
    if (existing.surprise) {
      // Tras desmarcar se soltó la sorpresa: al reactivar hay que volver a ganarla (si otra repetición ya la ganó, no se repite).
      const claim = await db.query('INSERT INTO bonus_claims(task_id, user_id, instance_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id', [existing.task_id, c.userId, c.instanceId]);
      if (claim.rowCount === 0 && !(await one(db, 'SELECT 1 FROM bonus_claims WHERE task_id = $1 AND user_id = $2 AND instance_id = $3', [existing.task_id, c.userId, c.instanceId]))) return null;
    }
    const grant = await one(db, 'UPDATE bonus_grants SET voided_at = NULL WHERE id = $1 RETURNING *', [existing.id]);
    await applyGrantEffects(db, grant, c);
    return grant;
  }

  if (t.bonus_surprise) {
    const claim = await db.query(
      'INSERT INTO bonus_claims(task_id, user_id, instance_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id',
      [t.task_id, c.userId, c.instanceId],
    );
    if (claim.rowCount === 0) return null; // ya ganada: la tarea sigue normal
  }
  const label = bonusLabel(t)!;
  const grant = await one<any>(
    db,
    `INSERT INTO bonus_grants(family_id, user_id, task_id, instance_id, task_title, kind, points, minutes, label, reward_id, surprise,
                             swap_allowed, original_reward_id, original_reward_title, original_reward_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [c.familyId, c.userId, t.task_id, c.instanceId, t.title, t.bonus_kind, t.bonus_kind === 'points' ? t.bonus_points : 0, t.bonus_kind === 'screen' ? t.bonus_minutes : 0, label, t.bonus_kind === 'reward' ? t.bonus_reward_id : null, t.bonus_surprise, ...snapshot],
  );
  await applyGrantEffects(db, grant, c);
  if (t.bonus_surprise) {
    // Sin contenido: el aviso no puede desvelar la sorpresa (también sale por WhatsApp).
    await notify(db, { userId: c.userId, event: 'bonus_won', title: '🎁 ¡Has ganado una sorpresa!', body: '¡Ábrela en DiploP y descubre qué es! 🤩', link: '/', dedupeKey: `bonus:${grant.id}` });
  }
  return grant;
}

/** Anula el bono de una ocurrencia (corrección «Cumplida» → «No cumplida»): compensa puntos y minutos y retira lo pendiente. */
export async function voidBonus(db: Db, c: GrantCtx & { seq: number; releaseClaim?: boolean; reason?: string }) {
  const g = await one<any>(db, 'SELECT * FROM bonus_grants WHERE instance_id = $1 AND user_id = $2 AND voided_at IS NULL FOR UPDATE', [c.instanceId, c.userId]);
  if (!g) return;
  await db.query('UPDATE bonus_grants SET voided_at = now() WHERE id = $1', [g.id]);
  // Desmarcar una tarea con sorpresa: la sorpresa vuelve a estar disponible (se gana la próxima vez).
  if (c.releaseClaim && g.surprise) await db.query('DELETE FROM bonus_claims WHERE task_id = $1 AND user_id = $2 AND instance_id = $3', [g.task_id, c.userId, c.instanceId]);
  if (g.points) {
    await addPoints(db, { familyId: c.familyId, userId: c.userId, delta: -g.points, kind: 'adjustment', refId: c.instanceId, note: `Corrección: bono de «${g.task_title}» anulado${c.reason ? ` (${c.reason})` : ''}`, createdBy: c.actorId, idempotencyKey: `bonus-rev:${c.instanceId}:${c.seq}`, reversesEarning: true });
  }
  if (g.minutes) {
    await addScreen(db, { familyId: c.familyId, userId: c.userId, delta: -g.minutes, kind: 'adjustment', refId: c.instanceId, note: `Corrección: bono de «${g.task_title}» anulado${c.reason ? ` (${c.reason})` : ''}`, createdBy: c.actorId, idempotencyKey: `bonus-min-rev:${c.instanceId}:${c.seq}` });
  }
}
