import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { del, post, put } from '../lib/api';
import { currencySymbol, getCurrency, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import type { ExpenseContribution, ExpenseRule } from '../lib/types';
import { parseBasisPoints, ruleContribution, useExpenseRules } from './ExpenseSheet';
import { Button, Field, SectionTitle, Segmented, Sheet, useToast } from './ui';

function RuleEditor({ rule, onClose }: { rule?: ExpenseRule; onClose: () => void }) {
  const [title, setTitle] = useState(rule?.title ?? '');
  const [type, setType] = useState<ExpenseContribution['type']>(rule?.type ?? 'percent');
  const [percent, setPercent] = useState(rule?.type === 'percent' ? String(rule.basis_points / 100) : '');
  const [amount, setAmount] = useState(rule?.type === 'amount' ? String(rule.cents / 100) : '');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: (contribution: ExpenseContribution) => rule
      ? put(`/expense-rules/${rule.id}`, { title, contribution })
      : post('/expense-rules', { title, contribution }),
    onSuccess: () => { toast('Regla guardada'); invalidate(); onClose(); },
  });
  const value = type === 'percent' ? parseBasisPoints(percent) : parseEuros(amount);
  return (
    <Sheet open onClose={onClose} title={rule ? 'Editar regla de gasto' : 'Nueva regla de gasto'} footer={
      <Button className="w-full" loading={save.isPending} disabled={!title.trim() || value == null || value > 10_000_000} onClick={() => {
        if (value != null) save.mutate(type === 'percent' ? { type, basisPoints: value } : { type, cents: value });
      }}>Guardar regla</Button>
    }>
      <fieldset className="space-y-4" disabled={save.isPending}>
        {!rule ? <Button size="sm" variant="secondary" onClick={() => { setTitle('Salidas con amigos'); setType('percent'); setPercent('50'); }}>Usar 50 % para salidas</Button> : null}
        <Field label="Nombre de la regla">{(id) => <input id={id} className="field" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Segmented label="Aportación de la familia" value={type} onChange={setType} options={[{ value: 'percent', label: 'Porcentaje' }, { value: 'amount', label: 'Importe fijo' }]} />
        {type === 'percent' ? <Field label="Porcentaje que aporta la familia">{(id) => <input id={id} className="field" inputMode="decimal" maxLength={6} value={percent} onChange={(e) => setPercent(e.target.value)} />}</Field> : (
          <Field label={`Aportación familiar (${currencySymbol()})`} hint={rule?.currency && rule.currency !== getCurrency() ? 'La moneda familiar cambió. Revisa el importe antes de guardarlo.' : undefined}>
            {(id) => <input id={id} className="field" inputMode="decimal" maxLength={12} value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
        )}
        {save.error ? <p role="alert" className="text-sm font-bold text-berry-deep">{save.error.message}</p> : null}
      </fieldset>
    </Sheet>
  );
}

export function ExpenseRules({ manage = false }: { manage?: boolean }) {
  const q = useExpenseRules();
  const [editor, setEditor] = useState<{ rule?: ExpenseRule } | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const archive = useMutation({
    mutationFn: (id: string) => del(`/expense-rules/${id}`),
    onSuccess: () => { toast('Regla archivada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const rules = q.data?.rules ?? [];
  if (!manage && !rules.length) return null;
  return (
    <section className="my-7" aria-label="Reglas de gastos">
      <SectionTitle action={manage ? <Button size="sm" variant="secondary" onClick={() => setEditor({})}>Nueva regla</Button> : undefined}>Reglas de gastos</SectionTitle>
      {q.error ? <p role="alert" className="text-sm text-berry-deep">{q.error.message}</p> : null}
      {rules.length ? <ul className="card divide-y divide-[var(--line)]">
        {rules.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3.5">
            <div className="min-w-0 flex-1">
              <p className="font-bold wrap-anywhere">{rule.title}</p>
              <p className="text-sm muted">La familia aporta {ruleContribution(rule)}</p>
            </div>
            {manage ? <div className="flex gap-1">
              <Button size="sm" variant="secondary" aria-label={`Editar ${rule.title}`} onClick={() => setEditor({ rule })}>Editar</Button>
              <Button size="sm" variant="ghost" aria-label={`Archivar ${rule.title}`} disabled={archive.isPending} onClick={() => archive.mutate(rule.id)}>Archivar</Button>
            </div> : null}
          </li>
        ))}
      </ul> : !q.isLoading && !q.error ? <p className="text-sm muted">Todavía no hay reglas de gastos.</p> : null}
      {editor ? <RuleEditor rule={editor.rule} onClose={() => setEditor(null)} /> : null}
    </section>
  );
}
