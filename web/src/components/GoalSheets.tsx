import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Camera, Gift, Pencil, Trash2, Undo2 } from 'lucide-react';
import { api, newKey, patch, post, put } from '../lib/api';
import { currencySymbol, euros, fmtDate, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import type { Goal } from '../lib/types';
import { Badge, Button, Field, Sheet, useToast } from './ui';

export const GOAL_EMOJIS = ['🎮', '🚲', '🛴', '🎧', '📚', '⚽', '🧸', '🎸', '🎨', '📱', '👟', '🎁'];

/**
 * «Crear meta de ahorro» (I19). Un hijo PROPONE la meta (un adulto la aprueba, ajusta o rechaza);
 * un adulto la crea ya activa. Foto o emoji opcionales.
 */
export function NewGoalSheet({ userId, adult = false, onClose }: { userId: string; adult?: boolean; onClose: () => void }) {
  const [goal, setGoal] = useState({ title: '', target: '', emoji: '' });
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const add = useMutation({
    mutationFn: async () => {
      const cents = parseEuros(goal.target);
      if (!cents || !goal.title.trim()) throw new Error('Pon un nombre y un importe');
      const r = await post<{ goal: Goal }>('/goals', { userId, title: goal.title, targetCents: cents, emoji: goal.emoji || null });
      if (file) {
        const fd = new FormData();
        fd.append('photo', file);
        await api(`/goals/${r.goal.id}/photo`, { method: 'POST', form: fd }).catch((e: Error) => toast(`La meta se ha creado, pero la foto no: ${e.message}`, 'error'));
      }
      return r.goal;
    },
    onSuccess: (g) => {
      toast(g.status === 'proposed' ? 'Meta enviada. Tus padres la tienen que aprobar.' : 'Meta creada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={adult ? 'Nueva meta de ahorro' : 'Crear meta de ahorro'} subtitle={adult ? undefined : 'Tus padres la aprueban y a veces ajustan el precio.'} footer={<Button className="w-full" loading={add.isPending} onClick={() => add.mutate()}>{adult ? 'Crear meta' : 'Proponer meta'}</Button>}>
      <div className="space-y-4">
        <Field label="¿Para qué ahorras?">{(id) => <input id={id} className="field" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} maxLength={80} />}</Field>
        <Field label={`¿Cuánto cuesta? (${currencySymbol()})`}>{(id) => <input id={id} className="field num" inputMode="decimal" value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} />}</Field>
        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Un dibujo para tu meta (opcional)</p>
          <div role="radiogroup" aria-label="Emoji de la meta" className="flex flex-wrap gap-1.5">
            {GOAL_EMOJIS.map((e) => (
              <button key={e} type="button" role="radio" aria-checked={goal.emoji === e} aria-label={`Emoji ${e}`} onClick={() => setGoal({ ...goal, emoji: goal.emoji === e ? '' : e })}
                className={`flex size-11 items-center justify-center rounded-xl border text-2xl ${goal.emoji === e ? 'border-tangerine bg-tangerine-soft dark:bg-tangerine/20' : 'border-[var(--line)] bg-[var(--chip)]'}`}>{e}</button>
            ))}
          </div>
        </div>
        <div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Foto de la meta" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button type="button" variant="secondary" className="w-full" onClick={() => fileRef.current?.click()}><Camera size={18} aria-hidden /> {file ? `Foto: ${file.name.slice(0, 24)}` : 'Poner una foto (opcional)'}</Button>
        </div>
      </div>
    </Sheet>
  );
}

const PRESETS = [0, 10, 20, 30, 50];

/** Ahorro automático: qué % de cada cierre va solo a la meta. El hijo lo pide; el adulto lo fija. */
export function AutoSaveSheet({ goal, adult = false, onClose }: { goal: Goal; adult?: boolean; onClose: () => void }) {
  const [pct, setPct] = useState(goal.auto_pending_percent ?? goal.auto_percent);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => put<{ auto_percent: number; auto_pending_percent: number | null }>(`/goals/${goal.id}/auto`, { percent: pct }),
    onSuccess: (r) => {
      toast(r.auto_pending_percent ? 'Petición enviada. Tus padres la tienen que aprobar.' : pct ? `Ahorro automático al ${pct} %` : 'Ahorro automático quitado');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Ahorro automático" subtitle={`Meta «${goal.title}»`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{adult ? 'Guardar' : pct && pct !== goal.auto_percent ? 'Pedir a mis padres' : 'Guardar'}</Button>}>
      <div className="space-y-4">
        <p className="muted">En cada cierre de {adult ? 'periodo' : 'tu mesada'}, este porcentaje de lo que cobras va solo a la meta.</p>
        <div role="radiogroup" aria-label="Porcentaje" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={pct === p} onClick={() => setPct(p)}
              className={`num h-11 min-w-16 rounded-full border-[1.5px] px-4 font-bold ${pct === p ? 'border-tangerine bg-tangerine-soft text-tangerine-deep dark:bg-tangerine/20' : 'border-transparent bg-[var(--chip)]'}`}>{p === 0 ? 'Nada' : `${p} %`}</button>
          ))}
        </div>
        <Field label="Otro porcentaje (0 a 100)">{(id) => <input id={id} className="field num w-28" type="number" min={0} max={100} value={pct} onChange={(e) => setPct(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))} />}</Field>
        {goal.auto_pending_percent ? <p role="status" className="rounded-xl bg-sun-soft px-3 py-2 text-sm font-bold text-[#7a5600] dark:bg-sun/15 dark:text-[#ffd979]">Esperando a que aprueben el {goal.auto_pending_percent} %.</p> : null}
      </div>
    </Sheet>
  );
}

/** Lo que un adulto puede hacer con una meta de un hijo: aporte puntual, regla del aporte, ahorro automático y anular aportes. */
export function ManageGoalSheet({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [gift, setGift] = useState({ amount: '', message: '' });
  const giftKey = useState(newKey)[0];
  const [rule, setRule] = useState({
    per: goal.match_per_cents ? (goal.match_per_cents / 100).toString().replace('.', ',') : '4',
    gives: goal.match_gives_cents ? (goal.match_gives_cents / 100).toString().replace('.', ',') : '1',
    cap: goal.match_cap_cents ? (goal.match_cap_cents / 100).toString().replace('.', ',') : '10',
  });
  const [auto, setAuto] = useState(goal.auto_percent);
  const [edit, setEdit] = useState({ title: goal.title, target: (goal.target_cents / 100).toString().replace('.', ','), emoji: goal.emoji ?? '' });
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const done = (msg: string) => { toast(msg); invalidate(); onClose(); };
  const saveEdit = useMutation({
    mutationFn: () => {
      const targetCents = parseEuros(edit.target);
      if (!edit.title.trim()) throw new Error('Ponle un nombre a la meta');
      if (!targetCents) throw new Error('Escribe un precio válido');
      return patch(`/goals/${goal.id}`, { title: edit.title.trim(), targetCents, emoji: edit.emoji || null });
    },
    onSuccess: (r: { changed: boolean }) => (r.changed ? done('Meta cambiada. Le hemos avisado.') : onClose()),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // El motivo va en el cuerpo de DELETE: el servidor lo acepta y se lo cuenta al niño.
  const cancel = useMutation({
    mutationFn: () => api<{ returned_cents: number }>(`/goals/${goal.id}`, { method: 'DELETE', body: { reason: reason.trim() || undefined } }),
    onSuccess: (r) => done(r.returned_cents ? `Meta cancelada. ${euros(r.returned_cents)} han vuelto a su banco.` : 'Meta cancelada'),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const sendGift = useMutation({
    mutationFn: () => {
      const cents = parseEuros(gift.amount);
      if (!cents) throw new Error('Escribe un importe válido');
      return post(`/goals/${goal.id}/gift`, { cents, message: gift.message.trim() || undefined }, giftKey);
    },
    onSuccess: () => done(`Aporte hecho a «${goal.title}»`),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const saveRule = useMutation({
    mutationFn: (remove: boolean) => {
      if (remove) return put(`/goals/${goal.id}/match`, null);
      const per = parseEuros(rule.per), gives = parseEuros(rule.gives), cap = parseEuros(rule.cap);
      if (!per || !gives || !cap) throw new Error('Rellena los tres importes');
      return put(`/goals/${goal.id}/match`, { perCents: per, givesCents: gives, capCents: cap });
    },
    onSuccess: (_r, remove) => done(remove ? 'Aporte de los padres quitado' : 'Aporte de los padres guardado'),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const saveAuto = useMutation({
    mutationFn: () => put(`/goals/${goal.id}/auto`, { percent: auto }),
    onSuccess: () => done(auto ? `Ahorro automático al ${auto} %` : 'Ahorro automático quitado'),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const reverse = useMutation({
    mutationFn: (entryId: string) => post(`/goals/${goal.id}/contributions/${entryId}/reverse`),
    onSuccess: () => done('Aporte anulado'),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={`Meta «${goal.title}»`} subtitle={`${euros(goal.balance_cents)} de ${euros(goal.target_cents)}`}>
      <div className="space-y-6">
        <section aria-label="Cambiar la meta" className="space-y-3">
          <h3 className="font-bold">Cambiar la meta</h3>
          <Field label="Nombre">{(id) => <input id={id} className="field" maxLength={80} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />}</Field>
          <Field label={`Precio (${currencySymbol()})`}>{(id) => <input id={id} className="field num" inputMode="decimal" value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} />}</Field>
          <div role="radiogroup" aria-label="Emoji de la meta" className="flex flex-wrap gap-1.5">
            {GOAL_EMOJIS.map((em) => (
              <button key={em} type="button" role="radio" aria-checked={edit.emoji === em} aria-label={em} onClick={() => setEdit({ ...edit, emoji: edit.emoji === em ? '' : em })} className={`size-11 rounded-full text-xl ${edit.emoji === em ? 'bg-tangerine-soft ring-2 ring-tangerine dark:bg-tangerine/20' : 'bg-[var(--chip)]'}`}>{em}</button>
            ))}
          </div>
          <Button variant="secondary" loading={saveEdit.isPending} onClick={() => saveEdit.mutate()}><Pencil size={16} aria-hidden /> Guardar cambios</Button>
        </section>
        <section aria-label="Aporte puntual" className="space-y-3 border-t border-[var(--line)] pt-5">
          <h3 className="font-bold">Aporte puntual</h3>
          <p className="text-sm muted">Un premio o un empujón. Se suma a la meta y se avisa al niño.</p>
          <Field label={`Importe (${currencySymbol()})`}>{(id) => <input id={id} className="field num" inputMode="decimal" value={gift.amount} onChange={(e) => setGift({ ...gift, amount: e.target.value })} />}</Field>
          <Field label="Mensaje (opcional)">{(id) => <input id={id} className="field" maxLength={140} value={gift.message} onChange={(e) => setGift({ ...gift, message: e.target.value })} />}</Field>
          <Button variant="secondary" loading={sendGift.isPending} onClick={() => sendGift.mutate()}><Gift size={16} aria-hidden /> Hacer el aporte</Button>
        </section>
        <section aria-label="Aporte de los padres" className="space-y-3 border-t border-[var(--line)] pt-5">
          <h3 className="font-bold">Aporte de los padres</h3>
          <p className="text-sm muted">Por cada cantidad que ahorra, vosotros ponéis otra, hasta un tope.</p>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Por cada">{(id) => <input id={id} className="field num" inputMode="decimal" value={rule.per} onChange={(e) => setRule({ ...rule, per: e.target.value })} />}</Field>
            <Field label="Ponéis">{(id) => <input id={id} className="field num" inputMode="decimal" value={rule.gives} onChange={(e) => setRule({ ...rule, gives: e.target.value })} />}</Field>
            <Field label="Tope total">{(id) => <input id={id} className="field num" inputMode="decimal" value={rule.cap} onChange={(e) => setRule({ ...rule, cap: e.target.value })} />}</Field>
          </div>
          {goal.match_per_cents ? <p className="text-sm">Ahora: {euros(goal.match_gives_cents!)} por cada {euros(goal.match_per_cents)}, hasta {euros(goal.match_cap_cents!)} (ya aportados {euros(goal.matched_cents)}).</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={saveRule.isPending} onClick={() => saveRule.mutate(false)}>Guardar aporte</Button>
            {goal.match_per_cents ? <Button variant="ghost" onClick={() => saveRule.mutate(true)}>Quitar</Button> : null}
          </div>
        </section>
        <section aria-label="Ahorro automático" className="space-y-3 border-t border-[var(--line)] pt-5">
          <h3 className="font-bold">Ahorro automático</h3>
          <div role="radiogroup" aria-label="Porcentaje de cada cierre" className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={auto === p} onClick={() => setAuto(p)} className={`num h-11 min-w-16 rounded-full border-[1.5px] px-4 font-bold ${auto === p ? 'border-tangerine bg-tangerine-soft text-tangerine-deep dark:bg-tangerine/20' : 'border-transparent bg-[var(--chip)]'}`}>{p === 0 ? 'Nada' : `${p} %`}</button>
            ))}
          </div>
          <Button variant="secondary" loading={saveAuto.isPending} onClick={() => saveAuto.mutate()}>Guardar ahorro automático</Button>
        </section>
        {goal.contributions.length ? (
          <section aria-label="Aportes recientes" className="space-y-2 border-t border-[var(--line)] pt-5">
            <h3 className="font-bold">Aportes recientes</h3>
            <ul className="space-y-2">
              {goal.contributions.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-2xl bg-[var(--chip)] p-3 text-sm">
                  <span className="min-w-0 flex-1"><b className="num">{euros(c.cents)}</b> · {c.note.replace(/^Aporte de /, '')} <span className="muted">· {fmtDate(c.created_at)}</span></span>
                  {c.reversed ? <Badge>Anulado</Badge> : <Button size="sm" variant="ghost" aria-label={`Anular el aporte de ${euros(c.cents)}`} disabled={reverse.isPending} onClick={() => reverse.mutate(c.id)}><Undo2 size={16} aria-hidden /> Anular</Button>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section aria-label="Cancelar la meta" className="space-y-3 border-t border-[var(--line)] pt-5">
          <h3 className="font-bold">Cancelar la meta</h3>
          {cancelling ? (
            <>
              <p className="text-sm">
                {goal.balance_cents > 0
                  ? <>Sus <b className="num">{euros(goal.principal_cents)}</b> ahorrados vuelven a su cuenta de dinero del banco.{goal.interest_cents + goal.contributions_cents > 0 ? <> Se pierden <b className="num">{euros(goal.interest_cents + goal.contributions_cents)}</b> de interés y aportes.</> : null}</>
                  : 'No tiene dinero ahorrado.'}
              </p>
              <Field label="Motivo para el niño (opcional)">{(id) => <input id={id} className="field" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Sí, cancelar la meta</Button>
                <Button variant="ghost" onClick={() => setCancelling(false)}>No</Button>
              </div>
            </>
          ) : (
            <Button variant="ghost" disabled={!!goal.pending_request} onClick={() => setCancelling(true)}><Trash2 size={16} aria-hidden /> Cancelar meta</Button>
          )}
          {goal.pending_request ? <p className="text-sm muted">Tiene una petición esperando: resuélvela en Validar antes de cancelar.</p> : null}
        </section>
      </div>
    </Sheet>
  );
}

