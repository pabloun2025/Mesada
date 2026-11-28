import { createHash, randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { AuthUser } from './auth.js';
import { capStatus } from './cap.js';
import { fmtMoney, type Currency } from './currency.js';
import { one, tx, type Db } from './db.js';
import { periodBounds } from './dates.js';
import { badRequest, conflict, notFound } from './errors.js';
import { readExpenseRule, type ExpenseContribution } from './expense-rules.js';
import { familyToday, getFamily, type Family } from './family.js';
import { addMoney, addPoints, moneyBalance, pointsBalance } from './ledger.js';
import { notify } from './notify/dispatch.js';

export type ExpenseInput = {
  userId: string;
  title: string;
  totalCents: number;
  currency: Currency;
  contribution?: ExpenseContribution;
  ruleId?: string;
  overrideReason?: string;
};

const contributionCents = (p: ExpenseContribution, total: number) => p.type === 'amount' ? p.cents : Math.ceil((total * p.basisPoints) / 10_000);

function expenseInputDigest(input: ExpenseInput) {
  const c = input.contribution;
  return createHash('sha256').update(JSON.stringify([
    input.userId, input.title, input.totalCents, input.currency, input.ruleId ?? null, input.overrideReason ?? null,
    c ? [c.type, c.type === 'amount' ? c.cents : c.basisPoints] : null,
  ])).digest('hex');
}

async function lockChild(db: Db, familyId: string, userId: string) {
  const child = await one(db, "SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active FOR UPDATE", [userId, familyId]);
  if (!child) throw notFound('Hijo no encontrado');
}

/** Abona céntimos hacia arriba y usa el mínimo de puntos enteros para cubrir el gasto. */
function expenseConversion(fam: Family, availablePoints: number, short: number, capCents: number | null) {
  if (!fam.bank_exchange_enabled || fam.rate_cents === 0 || availablePoints <= 0 || short <= 0) return { points: 0, cents: 0 };
  const minPoints = (cents: number) => Math.floor(((cents - 1) * fam.rate_points) / fam.rate_cents) + 1;
  const capPoints = capCents == null ? availablePoints : Math.floor((capCents * fam.rate_points) / fam.rate_cents);
  const usable = Math.min(availablePoints, capPoints, minPoints(short));
  if (usable === 0) return { points: 0, cents: 0 };
  const cents = Math.ceil((usable * fam.rate_cents) / fam.rate_points);
  return { points: minPoints(cents), cents };
}

export async function quoteExpense(db: Db, familyId: string, input: ExpenseInput, requestId: string, funding?: { loanId: string; principalCents: number }, family?: Family) {
  const fam = family ?? await getFamily(db, familyId);
  if (input.currency !== fam.currency) throw conflict('La moneda de la familia ha cambiado. Revisa el importe y vuelve a ver el desglose.', 'expense_currency_changed');
  const rule = input.ruleId ? await readExpenseRule(db, familyId, input.ruleId) : null;
  if (rule?.currency && rule.currency !== fam.currency) throw conflict('Actualiza la moneda de esta regla antes de aplicarla', 'expense_rule_currency');
  const proposed = rule ? (rule.type === 'amount' ? Math.min(rule.cents, input.totalCents) : Math.ceil((input.totalCents * rule.basis_points) / 10_000)) : null;
  const parent = input.contribution ? contributionCents(input.contribution, input.totalCents) : proposed;
  if (parent == null) throw badRequest('Indica la aportación de la familia');
  if (parent > input.totalCents) throw badRequest('La aportación no puede superar el precio total');
  const override = rule && parent !== proposed;
  if (override && !input.overrideReason?.trim()) throw badRequest('Explica por qué cambia la aportación de la regla', 'expense_override_reason');
  const parentRate = input.contribution
    ? input.contribution.type === 'percent' ? input.contribution.basisPoints : null
    : rule?.basis_points ?? null;
  const ruleSnapshot = rule ? { ...rule, proposed_cents: proposed!, override_reason: override ? input.overrideReason! : null } : null;
  const child = input.totalCents - parent;
  const originalBalance = await moneyBalance(db, input.userId);
  const balance = originalBalance + (funding?.principalCents ?? 0);
  const cash = Math.min(Math.max(balance, 0), child);
  const short = child - cash;
  const exchangedAt = new Date();
  const today = familyToday(fam, exchangedAt);
  const cap = await capStatus(db, fam, input.userId, today);
  const conversion = expenseConversion(fam, await pointsBalance(db, input.userId), short, cap.remaining);
  const loanApplied = funding ? Math.min(funding.principalCents, child) : 0;
  const breakdown = {
    total_cents: input.totalCents,
    parent_cents: parent,
    parent_basis_points: parentRate,
    child_cents: child,
    cash_cents: cash,
    used_points: conversion.points,
    points_cents: conversion.cents,
    debt_cents: Math.max(0, short - conversion.cents),
    balance_after: balance + conversion.cents - child,
    ...(funding ? { loan_cents: funding.principalCents, loan_applied_cents: loanApplied, prior_cash_cents: Math.max(0, cash - loanApplied) } : {}),
    ...(ruleSnapshot ? { rule: ruleSnapshot } : {}),
  };
  // Las cotizaciones antiguas de aportación manual conservan la misma firma durante la actualización.
  const signed: unknown[] = [familyId, input, requestId, fam.currency, breakdown];
  if (funding || rule) signed.push({ funding, cap, period: periodBounds(fam.settlement_period, today) });
  const token = createHash('sha256').update(JSON.stringify(signed)).digest('hex');
  return { breakdown, token, weekStart: cap.weekStart, exchangedAt, ruleSnapshot };
}

export async function previewExpense(adult: AuthUser, input: ExpenseInput) {
  return tx(async (db) => {
    await lockChild(db, adult.familyId, input.userId);
    const requestId = randomUUID();
    const { breakdown, token } = await quoteExpense(db, adult.familyId, input, requestId);
    return { breakdown, token, requestId };
  });
}

export async function recordExpense(adult: AuthUser, input: ExpenseInput, requestId: string, expectedToken: string) {
  const familyId = adult.familyId;
  return tx(async (db) => {
    await lockChild(db, familyId, input.userId);
    const prior = await one<{ id: string; quote_token: string; input_digest: string | null }>(db, 'SELECT id, quote_token, input_digest FROM child_expenses WHERE user_id = $1 AND request_id = $2', [input.userId, requestId]);
    if (prior) {
      if (prior.quote_token !== expectedToken || (prior.input_digest && prior.input_digest !== expenseInputDigest(input))) {
        throw conflict('Ese gasto ya se registró con otros datos', 'expense_already_recorded');
      }
      return { id: prior.id, duplicate: true };
    }
    const quote = await quoteExpense(db, familyId, input, requestId);
    return applyExpense(db, adult, input, requestId, expectedToken, quote);
  });
}

export async function applyExpense(db: Db, adult: AuthUser, input: ExpenseInput, requestId: string, expectedToken: string, quote: Awaited<ReturnType<typeof quoteExpense>>) {
    const { userId, title } = input;
    const { familyId } = adult;
    const { breakdown: b, token, weekStart, exchangedAt, ruleSnapshot } = quote;
    if (token !== expectedToken) throw conflict('El desglose ha cambiado. Revísalo antes de registrar el gasto.', 'expense_quote_changed');
    const row = await one<{ id: string }>(db,
      `INSERT INTO child_expenses (family_id, user_id, created_by, title, total_cents, parent_cents, parent_basis_points, cash_cents,
                                   used_points, points_cents, debt_cents, balance_after, request_id, quote_token, currency, loan_cents, rule_snapshot, input_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [familyId, userId, adult.id, title, b.total_cents, b.parent_cents, b.parent_basis_points, b.cash_cents,
        b.used_points, b.points_cents, b.debt_cents, b.balance_after, requestId, token, input.currency, b.loan_cents ?? null, ruleSnapshot, expenseInputDigest(input)]);
    const id = row!.id;
    const movement = { familyId, userId, refId: id, createdBy: adult.id };
    if (b.used_points > 0) {
      await db.query(
        "INSERT INTO cap_uses (family_id, user_id, kind, cap_week, points, cents, created_at) VALUES ($1,$2,'exchange',$3,$4,$5,$6)",
        [familyId, userId, weekStart, b.used_points, b.points_cents, exchangedAt]);
      const note = `Canje para «${title}»`;
      await addPoints(db, { ...movement, delta: -b.used_points, kind: 'exchange', note });
      await addMoney(db, { ...movement, deltaCents: b.points_cents, kind: 'exchange', note });
    }
    await addMoney(db, { ...movement, deltaCents: -b.child_cents, kind: 'expense', note: title });
    await audit(db, familyId, adult.id, 'expense.record', 'child_expense', id, { for: userId, title, ...b });

    const money = (cents: number) => fmtMoney(cents, input.currency);
    const percent = b.parent_basis_points == null ? '' : ` (${(b.parent_basis_points / 100).toLocaleString('es-ES')} %)`;
    const excess = Math.max(0, b.cash_cents + b.points_cents - b.child_cents);
    const pointsDetail = excess > 0
      ? `Se convirtieron ${b.used_points} puntos en ${money(b.points_cents)}. Sobran ${money(excess)}, que se abonan a tu saldo.`
      : b.used_points > 0 ? `${b.used_points} puntos cubren ${money(b.points_cents)}.` : '';
    const body = [
      b.loan_cents ? `Costó ${money(b.total_cents)}. Se aplicaron ${money(b.loan_applied_cents!)} del préstamo y ${money(b.prior_cash_cents!)} de tu saldo.` :
        `Costó ${money(b.total_cents)}. Tu familia aportó ${money(b.parent_cents)}${percent} y tu parte fue ${money(b.child_cents)}. Del saldo se usaron ${money(b.cash_cents)}.`,
      pointsDetail,
      b.debt_cents > 0 ? `Quedan ${money(b.debt_cents)} pendientes de este gasto.` : '',
      `Tu saldo tras el gasto: ${money(b.balance_after)}.`,
    ].filter(Boolean).join(' ');
    await notify(db, { userId, event: 'expense_recorded', title: `${adult.displayName} registró «${title}»`, body, link: '/mesada', dedupeKey: `expense:${id}` });
    return { id, duplicate: false };
}
