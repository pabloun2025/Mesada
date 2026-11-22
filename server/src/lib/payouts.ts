import { many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { lockUser, moneyBalance } from './ledger.js';
import { addScreen, CATEGORY_PHRASE, screenBalance, type ScreenCategory } from './screen.js';
import { recordPaymentTx } from './money.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { familyToday, getFamily } from './family.js';
import { assertNotPaused } from './screen-adjust.js';
import { assertCanWithdraw } from './bank.js';

import { fmtMoney } from './currency.js';
const METHOD_PHRASE: Record<string, string> = { cash: ' en efectivo', transfer: ' por transferencia', bizum: ' por Bizum', other: '' };

type NewRequest = { kind: 'money' | 'screen'; amountCents?: number; minutes?: number; category?: ScreenCategory; note?: string; idempotencyKey?: string };

/** El hijo retira su dinero (como en un cajero) o pide minutos de pantalla, hasta su saldo. Una sola petición abierta por tipo. */
export async function createPayoutRequest(child: AuthUser, p: NewRequest) {
  if (child.role !== 'child') throw forbidden('Solo los hijos hacen peticiones');
  const isMoney = p.kind === 'money';
  if (isMoney && (!Number.isInteger(p.amountCents) || p.amountCents! <= 0)) throw badRequest('Importe no válido');
  if (!isMoney && (!Number.isInteger(p.minutes) || p.minutes! <= 0 || p.minutes! > 1440)) throw badRequest('Minutos no válidos');
  if (!isMoney && !p.category) throw badRequest('Elige en qué quieres usar la pantalla');
  return tx(async (db) => {
    const currency = (await getFamily(db, child.familyId)).currency;
    const fmtEur = (c: number) => fmtMoney(c, currency);
    await lockUser(db, child.id);
    const idem = p.idempotencyKey ? `${child.id}:${p.idempotencyKey}` : null;
    if (idem) {
      const dup = await one(db, 'SELECT * FROM payout_requests WHERE idempotency_key = $1', [idem]);
      if (dup) return { request: dup, duplicate: true };
    }
    if (await one(db, `SELECT 1 FROM payout_requests WHERE user_id = $1 AND kind = $2 AND status = 'pending'`, [child.id, p.kind])) {
      throw conflict('Ya tienes una petición abierta. Espera a que la resuelvan o cancélala.', 'already_pending');
    }
    if (isMoney) {
      // Retiro: límite por semana (lunes a domingo) y no se puede con la cuenta en negativo.
      await assertCanWithdraw(db, await getFamily(db, child.familyId), child.id);
      const bal = await moneyBalance(db, child.id);
      if (p.amountCents! > bal) throw conflict(`Solo tienes ${fmtEur(bal)} por cobrar`, 'insufficient_balance');
    } else {
      // En pausa de pantalla no se pueden pedir minutos (I16).
      await assertNotPaused(db, child.id, familyToday(await getFamily(db, child.familyId)));
      const bal = await screenBalance(db, child.id);
      if (p.minutes! > bal) throw conflict(`Solo te quedan ${bal} min de pantalla`, 'insufficient_balance');
    }
    const req = await one(
      db,
      `INSERT INTO payout_requests(family_id, user_id, kind, amount_cents, minutes, category, note, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [child.familyId, child.id, p.kind, isMoney ? p.amountCents : null, isMoney ? null : p.minutes, isMoney ? null : p.category, p.note?.trim() ?? '', idem],
    );
    await audit(db, child.familyId, child.id, 'payout.request', 'payout_request', req.id, { kind: p.kind, cents: p.amountCents, minutes: p.minutes, category: p.category });
    await notifyAdults(db, child.familyId, {
      event: 'payout_requested',
      title: isMoney ? `${child.displayName} quiere retirar ${fmtEur(p.amountCents!)}` : `${child.displayName} pide ${p.minutes} min ${CATEGORY_PHRASE[p.category!]}`,
      body: isMoney ? `Tienes que pagárselo (en efectivo o en su cuenta).${p.note?.trim() ? ` ${p.note.trim()}` : ''}` : p.note?.trim() ?? '', link: '/validar', dedupeKey: `payout-req:${req.id}`,
    });
    return { request: req, duplicate: false };
  });
}

async function loadRequest(db: Db, familyId: string, id: string) {
  const r = await one(db, 'SELECT * FROM payout_requests WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, familyId]);
  if (!r) throw notFound('Petición no encontrada');
  return r;
}

export async function cancelPayoutRequest(child: AuthUser, id: string) {
  return tx(async (db) => {
    const r = await loadRequest(db, child.familyId, id);
    if (r.user_id !== child.id) throw forbidden();
    if (r.status === 'cancelled') return { request: r, duplicate: true };
    if (r.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    const upd = await one(db, `UPDATE payout_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 RETURNING *`, [id]);
    await audit(db, child.familyId, child.id, 'payout.cancel', 'payout_request', id, { kind: r.kind });
    return { request: upd, duplicate: false };
  });
}

/**
 * Aprueba una petición. Si el saldo bajó desde que se pidió, se concede lo que haya (y se avisa);
 * si ya no queda nada, 409 y la petición sigue abierta para poder rechazarla.
 */
export async function approvePayoutRequest(adult: AuthUser, id: string, o: { method?: string; note?: string }) {
  return tx(async (db) => {
    const currency = (await getFamily(db, adult.familyId)).currency;
    const r = await loadRequest(db, adult.familyId, id);
    const fmtEur = (c: number) => fmtMoney(c, currency);
    if (r.status === 'approved') return { request: r, duplicate: true, reduced: (r.granted_cents ?? r.amount_cents) < (r.amount_cents ?? 0) || (r.granted_minutes ?? r.minutes) < (r.minutes ?? 0) };
    if (r.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    await lockUser(db, r.user_id);
    const note = o.note?.trim() ?? '';
    if (r.kind === 'money') {
      const method = o.method ?? 'cash';
      const bal = await moneyBalance(db, r.user_id);
      const grant = Math.min(r.amount_cents, bal);
      if (grant <= 0) throw conflict('Ya no tiene saldo por cobrar', 'insufficient_balance');
      const pay = await recordPaymentTx(db, adult, { userId: r.user_id, amountCents: grant, method, note: note || undefined, idempotencyKey: `payout:${id}`, notifyChild: false });
      const upd = await one(
        db,
        `UPDATE payout_requests SET status = 'approved', granted_cents = $2, method = $3, payment_id = $4, decision_note = $5, decided_by = $6, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, grant, method, pay.id, note, adult.id],
      );
      const reduced = grant < r.amount_cents;
      await audit(db, adult.familyId, adult.id, 'payout.approve', 'payout_request', id, { kind: 'money', cents: grant, requested: r.amount_cents, method, for: r.user_id });
      await notify(db, {
        userId: r.user_id, event: 'payout_decided',
        title: `${adult.displayName} te ha pagado ${fmtEur(grant)}${METHOD_PHRASE[method] ?? ''}.`,
        body: `${reduced ? `Pediste ${fmtEur(r.amount_cents)}, pero ese era todo tu saldo. ` : ''}Te quedan ${fmtEur(bal - grant)}.${note ? ` ${note}` : ''}`,
        link: '/mesada', dedupeKey: `payout-approved:${id}`,
      });
      return { request: upd, duplicate: false, reduced, granted: grant };
    }
    await assertNotPaused(db, r.user_id, familyToday(await getFamily(db, adult.familyId)));
    const bal = await screenBalance(db, r.user_id);
    const grant = Math.min(r.minutes, bal);
    if (grant <= 0) throw conflict('Ya no le quedan minutos de pantalla', 'insufficient_balance');
    const s = await addScreen(db, { familyId: adult.familyId, userId: r.user_id, delta: -grant, kind: 'spend', refId: id, note: r.note || 'Petición aprobada', createdBy: adult.id, category: r.category, idempotencyKey: `payout:${id}` });
    const upd = await one(
      db,
      `UPDATE payout_requests SET status = 'approved', granted_minutes = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, -s.applied, note, adult.id],
    );
    const reduced = -s.applied < r.minutes;
    await audit(db, adult.familyId, adult.id, 'payout.approve', 'payout_request', id, { kind: 'screen', minutes: -s.applied, requested: r.minutes, category: r.category, for: r.user_id });
    await notify(db, {
      userId: r.user_id, event: 'payout_decided',
      title: `${adult.displayName} te ha dado ${-s.applied} min ${CATEGORY_PHRASE[r.category as ScreenCategory]}.`,
      body: `${reduced ? `Pediste ${r.minutes} min, pero ese era todo tu saldo. ` : ''}Te quedan ${s.balance} min.${note ? ` ${note}` : ''}`,
      link: '/mesada', dedupeKey: `payout-approved:${id}`,
    });
    return { request: upd, duplicate: false, reduced, granted: -s.applied };
  });
}

export async function rejectPayoutRequest(adult: AuthUser, id: string, note = '') {
  return tx(async (db) => {
    const currency = (await getFamily(db, adult.familyId)).currency;
    const r = await loadRequest(db, adult.familyId, id);
    const fmtEur = (c: number) => fmtMoney(c, currency);
    if (r.status === 'rejected') return { request: r, duplicate: true };
    if (r.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    const upd = await one(db, `UPDATE payout_requests SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, note.trim(), adult.id]);
    await audit(db, adult.familyId, adult.id, 'payout.reject', 'payout_request', id, { kind: r.kind, note, for: r.user_id });
    const what = r.kind === 'money' ? fmtEur(r.amount_cents) : `${r.minutes} min ${CATEGORY_PHRASE[r.category as ScreenCategory]}`;
    await notify(db, { userId: r.user_id, event: 'payout_decided', title: `${adult.displayName} no ha aceptado tu petición de ${what}`, body: note.trim(), link: '/mesada', dedupeKey: `payout-rejected:${id}` });
    return { request: upd, duplicate: false };
  });
}

export async function listPayoutRequests(db: Db, familyId: string, opts: { userId?: string; status?: string }) {
  return many(
    db,
    `SELECT r.*, u.display_name, u.avatar, u.color FROM payout_requests r JOIN users u ON u.id = r.user_id
      WHERE r.family_id = $1 AND ($2::uuid IS NULL OR r.user_id = $2) AND ($3::text IS NULL OR r.status = $3)
      ORDER BY r.created_at DESC LIMIT 100`,
    [familyId, opts.userId ?? null, opts.status ?? null],
  );
}
