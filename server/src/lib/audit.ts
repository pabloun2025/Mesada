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

export async function notify(
  db: Db,
  userId: string,
  kind: string,
  title: string,
  body = '',
  link: string | null = null,
  dedupeKey: string | null = null,
) {
  await db.query(
    `INSERT INTO notifications(user_id, kind, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, kind, title, body, link, dedupeKey],
  );
}

export async function notifyAdults(db: Db, familyId: string, kind: string, title: string, body = '', link: string | null = null) {
  await db.query(
    `INSERT INTO notifications(user_id, kind, title, body, link)
     SELECT id, $2, $3, $4, $5 FROM users WHERE family_id = $1 AND role = 'adult' AND active`,
    [familyId, kind, title, body, link],
  );
}
