import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, UserPlus } from 'lucide-react';
import { api, patch, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { User } from '../lib/types';
import { AVATARS, Avatar, Badge, Button, Field, IconButton, Loading, MEMBER_COLORS, PageHeader, Segmented, Sheet, Toggle, useToast } from '../components/ui';

export function AvatarPicker({ avatar, colorKey, onChange, name }: { avatar: string; colorKey: string; onChange: (a: string, c: string) => void; name: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar">
        <button type="button" role="radio" aria-checked={avatar === 'initial'} onClick={() => onChange('initial', colorKey)} className={`rounded-full p-0.5 ${avatar === 'initial' ? 'ring-2 ring-tangerine' : ''}`}>
          <Avatar name={name || '?'} colorKey={colorKey} size={40} />
        </button>
        {Object.keys(AVATARS).map((a) => (
          <button key={a} type="button" role="radio" aria-checked={avatar === a} aria-label={a} onClick={() => onChange(a, colorKey)} className={`rounded-full p-0.5 ${avatar === a ? 'ring-2 ring-tangerine' : ''}`}>
            <Avatar name={name} avatar={a} colorKey={colorKey} size={40} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
        {Object.entries(MEMBER_COLORS).map(([k, c]) => (
          <button key={k} type="button" role="radio" aria-checked={colorKey === k} aria-label={k} onClick={() => onChange(avatar, k)}
            className={`size-8 rounded-full ${colorKey === k ? 'ring-2 ring-offset-2 ring-offset-[var(--card)]' : ''}`} style={{ background: c.bg, ['--tw-ring-color' as any]: c.bg }} />
        ))}
      </div>
    </div>
  );
}

function MemberEditor({ member, onClose }: { member: User | null; onClose: () => void }) {
  const isNew = !member;
  const [m, setM] = useState({
    role: member?.role ?? 'child',
    displayName: member?.display_name ?? '',
    username: member?.username ?? '',
    password: '',
    avatar: member?.avatar ?? 'fox',
    color: member?.color ?? 'tangerine',
    birthYear: member?.birth_year ?? null as number | null,
    weeklyGoalPoints: member?.weekly_goal_points ?? 150,
    active: member?.active ?? true,
  });
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => {
      if (isNew) return post('/members', m);
      const body: any = { displayName: m.displayName, avatar: m.avatar, color: m.color, birthYear: m.birthYear, weeklyGoalPoints: m.weeklyGoalPoints, active: m.active };
      if (m.password) body.password = m.password;
      return patch(`/members/${member!.id}`, body);
    },
    onSuccess: () => { toast(isNew ? `${m.displayName} se ha unido a la familia` : 'Perfil guardado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const child = m.role === 'child';
  return (
    <Sheet open onClose={onClose} title={isNew ? 'Añadir a la familia' : `Editar a ${member.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Añadir' : 'Guardar'}</Button>}>
      <div className="space-y-4">
        {isNew ? <Segmented label="Tipo" value={m.role} onChange={(v) => setM({ ...m, role: v })} options={[{ value: 'child', label: 'Hijo/a' }, { value: 'adult', label: 'Adulto' }]} /> : null}
        <Field label="Nombre">{(id) => <input id={id} className="field" value={m.displayName} onChange={(e) => setM({ ...m, displayName: e.target.value })} maxLength={60} />}</Field>
        <AvatarPicker name={m.displayName} avatar={m.avatar} colorKey={m.color} onChange={(a, c) => setM({ ...m, avatar: a, color: c })} />
        {isNew ? (
          <Field label="Usuario para entrar" hint="Sin espacios. Debe ser único.">{(id) => <input id={id} className="field" autoCapitalize="none" value={m.username} onChange={(e) => setM({ ...m, username: e.target.value })} />}</Field>
        ) : <p className="text-sm muted">Usuario: <strong>{member.username}</strong></p>}
        <Field label={isNew ? (child ? 'PIN' : 'Contraseña') : child ? 'Nuevo PIN (opcional)' : 'Nueva contraseña (opcional)'} hint={child ? 'Mínimo 4 caracteres. Cambiarlo cierra sus sesiones abiertas.' : 'Mínimo 8 caracteres.'}>
          {(id) => <input id={id} className="field" type="password" autoComplete="new-password" inputMode={child ? 'numeric' : undefined} value={m.password} onChange={(e) => setM({ ...m, password: e.target.value })} />}
        </Field>
        {child ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Año de nacimiento">{(id) => <input id={id} className="field" type="number" value={m.birthYear ?? ''} onChange={(e) => setM({ ...m, birthYear: e.target.value ? Number(e.target.value) : null })} />}</Field>
            <Field label="Objetivo semanal (pts)">{(id) => <input id={id} className="field" type="number" min={0} value={m.weeklyGoalPoints} onChange={(e) => setM({ ...m, weeklyGoalPoints: Number(e.target.value) })} />}</Field>
          </div>
        ) : null}
        {!isNew ? <Toggle checked={m.active} onChange={(v) => setM({ ...m, active: v })} label="Cuenta activa" description="Si la desactivas, no podrá entrar y se quitará de las tareas." /> : null}
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function Family() {
  const { user } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const [editing, setEditing] = useState<{ m: User | null } | null>(null);
  if (isLoading || !data) return <Loading />;
  const groups = [
    { title: 'Hijos', list: data.members.filter((m) => m.role === 'child') },
    { title: 'Adultos', list: data.members.filter((m) => m.role === 'adult') },
  ];
  return (
    <div className="max-w-3xl">
      <PageHeader title="Familia" subtitle="Perfiles, accesos y objetivos." action={<Button onClick={() => setEditing({ m: null })}><UserPlus size={18} /> Añadir</Button>} />
      {groups.map((g) => (
        <section key={g.title} className="mb-6">
          <h2 className="mb-3 text-lg font-bold">{g.title}</h2>
          <ul className="space-y-2.5">
            {g.list.map((m) => (
              <li key={m.id} className={`card flex items-center gap-3 p-3.5 ${m.active ? '' : 'opacity-55'}`}>
                <Avatar name={m.display_name} avatar={m.avatar} colorKey={m.color} size={46} />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{m.display_name} {m.id === user.id ? <Badge>Tú</Badge> : null} {!m.active ? <Badge tone="berry">Desactivada</Badge> : null}</p>
                  <p className="text-sm muted">@{m.username}{m.role === 'child' && m.birth_year ? ` · ${new Date().getFullYear() - m.birth_year} años` : ''}{m.role === 'child' ? ` · objetivo ${m.weekly_goal_points} pts/semana` : ''}</p>
                </div>
                <IconButton label={`Editar a ${m.display_name}`} onClick={() => setEditing({ m })}><Pencil size={18} /></IconButton>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing ? <MemberEditor member={editing.m} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
