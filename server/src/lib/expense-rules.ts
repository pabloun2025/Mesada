import { audit } from './audit.js';
import type { AuthUser } from './auth.js';
import type { Currency } from './currency.js';
import { many, one, tx, type Db } from './db.js';
import { conflict, notFound } from './errors.js';
import { getFamily } from './family.js';

export type ExpenseContribution = { type: 'amount'; cents: number } | { type: 'percent'; basisPoints: number };

export type ExpenseRule = { id: string; title: string } & (
  | { type: 'amount'; cents: number; basis_points: null; currency: Currency }
  | { type: 'percent'; cents: null; basis_points: number; currency: null }
);

export function listExpenseRules(db: Db, familyId: string) {
  return many<ExpenseRule>(db, `SELECT id, title, type, cents, basis_points, currency FROM expense_rules WHERE family_id = $1 AND archived_at IS NULL ORDER BY title, id`, [familyId]);
}

export async function readExpenseRule(db: Db, familyId: string, id: string) {
  const rule = await one<ExpenseRule>(db, `SELECT id, title, type, cents, basis_points, currency FROM expense_rules WHERE family_id = $1 AND id = $2 AND archived_at IS NULL FOR SHARE`, [familyId, id]);
  if (!rule) throw conflict('La regla de gasto ya no está disponible', 'expense_rule_unavailable');
  return rule;
}

export function saveExpenseRule(adult: AuthUser, input: { title: string; contribution: ExpenseContribution }, id?: string) {
  return tx(async (db) => {
    const { title, contribution: c } = input;
    const currency = c.type === 'amount' ? (await getFamily(db, adult.familyId)).currency : null;
    const values = [adult.familyId, title, c.type, c.type === 'amount' ? c.cents : null, c.type === 'percent' ? c.basisPoints : null, currency];
    const rule = id
      ? await one<ExpenseRule>(db, `UPDATE expense_rules SET title = $2, type = $3, cents = $4, basis_points = $5, currency = $6 WHERE family_id = $1 AND id = $7 AND archived_at IS NULL RETURNING id, title, type, cents, basis_points, currency`, [...values, id])
      : await one<ExpenseRule>(db, `INSERT INTO expense_rules (family_id, title, type, cents, basis_points, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, type, cents, basis_points, currency`, values);
    if (!rule) throw notFound('Regla de gasto no encontrada');
    await audit(db, adult.familyId, adult.id, id ? 'expense_rule.update' : 'expense_rule.create', 'expense_rule', rule.id, { title });
    return { rule };
  });
}

export function archiveExpenseRule(adult: AuthUser, id: string) {
  return tx(async (db) => {
    const rule = await one<{ title: string }>(db, `UPDATE expense_rules SET archived_at = now() WHERE family_id = $1 AND id = $2 AND archived_at IS NULL RETURNING title`, [adult.familyId, id]);
    if (!rule) throw notFound('Regla de gasto no encontrada');
    await audit(db, adult.familyId, adult.id, 'expense_rule.archive', 'expense_rule', id, { title: rule.title });
    return { ok: true };
  });
}
