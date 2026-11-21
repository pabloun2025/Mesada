import type { Db } from './db.js';

export async function audit(
  db: Db,
  familyId: string,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
) {
  await db.query(
    'INSERT INTO audit_log(family_id, actor_id, action, entity, entity_id, data) VALUES ($1,$2,$3,$4,$5,$6)',
    [familyId, actorId, action, entity, entityId, JSON.stringify(data)],
  );
}
