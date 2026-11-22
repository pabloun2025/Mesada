import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail, Pencil, Trash2, UserPlus } from 'lucide-react';
import { api, patch, post, put } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { User } from '../lib/types';
import { EraseChildSheet } from '../components/PrivacyData';
import { AVATARS, Avatar, Badge, Button, Field, IconButton, Loading, MEMBER_COLORS, PageHeader, Segmented, Sheet, Toggle, useToast } from '../components/ui';

const COLOR_NAMES: Record<string, string> = { tangerine: 'Naranja', leaf: 'Verde', sky: 'Azul claro', indigo: 'Índigo', berry: 'Frambuesa', sun: 'Amarillo', teal: 'Turquesa', slate: 'Gris' };
const AVATAR_NAMES: Record<string, string> = { fox: 'Zorro', cat: 'Gato', owl: 'Búho', bear: 'Oso', panda: 'Panda', tiger: 'Tigre', frog: 'Rana', octopus: 'Pulpo', rocket: 'Cohete', bolt: 'Rayo', star: 'Estrella', planet: 'Planeta', guitar: 'Guitarra', ball: 'Balón', controller: 'Mando', palette: 'Paleta' };

export function AvatarPicker({ avatar, colorKey, onChange, name }: { avatar: string; colorKey: string; onChange: (a: string, c: string) => void; name: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar">
        <button type="button" role="radio" aria-checked={avatar === 'initial'} aria-label="Inicial del nombre" onClick={() => onChange('initial', colorKey)} className={`rounded-full p-0.5 ${avatar === 'initial' ? 'ring-2 ring-tangerine' : ''}`}>
          <Avatar name={name || '?'} colorKey={colorKey} size={40} />
        </button>
        {Object.keys(AVATARS).map((a) => (
          <button key={a} type="button" role="radio" aria-checked={avatar === a} aria-label={AVATAR_NAMES[a] ?? a} onClick={() => onChange(a, colorKey)} className={`rounded-full p-0.5 ${avatar === a ? 'ring-2 ring-tangerine' : ''}`}>
            <Avatar name={name} avatar={a} colorKey={colorKey} size={40} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-0.5" role="radiogroup" aria-label="Color">
        {Object.entries(MEMBER_COLORS).map(([k, c]) => (
          <button key={k} type="button" role="radio" aria-checked={colorKey === k} aria-label={COLOR_NAMES[k] ?? k} onClick={() => onChange(avatar, k)}
            className="flex size-11 items-center justify-center rounded-full">
            <span className={`block size-8 rounded-full ${colorKey === k ? 'ring-2 ring-offset-2 ring-offset-[var(--card)]' : ''}`} style={{ background: c.bg, ['--tw-ring-color' as any]: c.bg }} />
          </button>
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
    phone: member?.phone ?? '',
    whatsapp: !!member?.whatsapp_consent_at,
  });
  const [error, setError] = useState('');
  const [erasing, setErasing] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: async () => {
      let id = member?.id;
      if (isNew) {
        const { phone: _p, whatsapp: _w, ...rest } = m;
        id = (await post<{ member: User }>('/members', rest)).member.id;
      } else {
        const body: any = { displayName: m.displayName, avatar: m.avatar, color: m.color, birthYear: m.birthYear, weeklyGoalPoints: m.weeklyGoalPoints, active: m.active };
        if (m.password) body.password = m.password;
        await patch(`/members/${id}`, body);
      }
      // El WhatsApp de los hijos lo ponen los padres; cada adulto pone el suyo en «Mi perfil».
      const phone = m.phone.trim();
      if (m.role === 'child' && (phone || member?.phone)) {
        await put(`/notify/contact/${id}`, { phone: phone || null, whatsappConsent: m.whatsapp && !!phone });
      }
    },
    onSuccess: () => { toast(isNew ? `${m.displayName} se ha unido a la familia` : 'Perfil guardado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const child = m.role === 'child';
  const { user: me } = useSession();
  const childAge = m.birthYear ? new Date().getFullYear() - m.birthYear : null;
  return (
    <Sheet open onClose={onClose} title={isNew ? 'Añadir a la familia' : `Editar a ${member.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Añadir' : 'Guardar'}</Button>}>
      <div className="space-y-4">
        {isNew ? <Segmented label="Tipo" value={m.role} onChange={(v) => setM({ ...m, role: v })} options={[{ value: 'child', label: 'Hijo/a' }, { value: 'adult', label: 'Adulto' }]} /> : null}
        <Field label="Nombre">{(id) => <input id={id} className="field" value={m.displayName} onChange={(e) => setM({ ...m, displayName: e.target.value })} maxLength={60} />}</Field>
        <AvatarPicker name={m.displayName} avatar={m.avatar} colorKey={m.color} onChange={(a, c) => setM({ ...m, avatar: a, color: c })} />
        {isNew ? (
          <Field label="Usuario para entrar" hint="Sin espacios. Debe ser único.">{(id) => <input id={id} className="field" spellCheck={false} name="username" autoCapitalize="none" value={m.username} onChange={(e) => setM({ ...m, username: e.target.value })} />}</Field>
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
        {child ? (
          <div className="space-y-2 rounded-2xl border border-[var(--line)] p-3.5">
            <Field label="WhatsApp (opcional)" hint={childAge !== null && childAge < 13 ? 'Con menos de 13 años no se le envía WhatsApp; los avisos le llegan dentro de la app.' : 'Le avisaremos de tareas nuevas, rechazos y premios.'}>
              {(id) => <input id={id} className="field" type="tel" inputMode="tel" autoComplete="off" placeholder="600 11 22 33" value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} />}
            </Field>
            <Toggle checked={m.whatsapp} onChange={(v) => setM({ ...m, whatsapp: v })} label="Recibir avisos por WhatsApp" description="Como madre, padre o tutor das tu permiso." />
          </div>
        ) : !isNew ? (
          <p className="text-sm muted">{member.id === me.id ? 'Tu WhatsApp se cambia en Mi perfil.' : `${member.display_name} pone su WhatsApp en su propio perfil.`}{member.phone ? ` Ahora: ${member.phone}.` : ' Aún no tiene.'}</p>
        ) : null}
        {!isNew ? <Toggle checked={m.active} onChange={(v) => setM({ ...m, active: v })} label="Cuenta activa" description="Si la desactivas, no podrá entrar y se quitará de las tareas." /> : null}
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
        {!isNew && child ? (
          <div className="rounded-2xl border border-berry/40 p-3.5">
            <p className="mb-2 text-sm muted">¿Ya no usa la app? Puedes borrar todos sus datos, fotos incluidas.</p>
            <Button variant="danger" size="sm" onClick={() => setErasing(true)}><Trash2 size={16} aria-hidden /> Borrar los datos de {member.display_name}…</Button>
          </div>
        ) : null}
      </div>
      {erasing && member ? (
        <EraseChildSheet id={member.id} name={member.display_name} onClose={() => setErasing(false)} onDone={() => { toast(`Se han borrado los datos de ${member.display_name}`); invalidate(); setErasing(false); onClose(); }} />
      ) : null}
    </Sheet>
  );
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ email: '', displayName: '' });
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => post('/invitations', f),
    onSuccess: () => { toast(`Invitación enviada a ${f.email}`); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title="Invitar a otro adulto" footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Enviar invitación</Button>}>
      <p className="mb-4 muted">Recibirá un correo con un enlace para crear su usuario. Caduca en 7 días.</p>
      <div className="space-y-4">
        <Field label="Nombre">{(id) => <input id={id} className="field" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}</Field>
        <Field label="Correo">{(id) => <input id={id} className="field" type="email" spellCheck={false} autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function Family() {
  const { user } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const [editing, setEditing] = useState<{ m: User | null } | null>(null);
  const [inviting, setInviting] = useState(false);
  if (isLoading || !data) return <Loading />;
  const groups = [
    { title: 'Hijos', list: data.members.filter((m) => m.role === 'child') },
    { title: 'Adultos', list: data.members.filter((m) => m.role === 'adult') },
  ];
  return (
    <div className="max-w-3xl">
      <PageHeader title="Familia" subtitle="Perfiles, accesos y objetivos." action={<div className="flex gap-2"><Button variant="secondary" onClick={() => setInviting(true)}><Mail size={18} /> Invitar</Button><Button onClick={() => setEditing({ m: null })}><UserPlus size={18} /> Añadir</Button></div>} />
      {groups.map((g) => (
        <section key={g.title} className="mb-6">
          <h2 className="mb-3 text-lg font-bold">{g.title}</h2>
          <ul className="space-y-2.5">
            {g.list.map((m) => (
              <li key={m.id} className={`card flex items-center gap-3 p-3.5 ${m.active ? '' : 'opacity-55'}`}>
                <Avatar name={m.display_name} avatar={m.avatar} colorKey={m.color} size={46} />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{m.display_name} {m.id === user.id ? <Badge>Tú</Badge> : null} {!m.active ? <Badge tone="berry">Desactivada</Badge> : null}</p>
                  <p className="text-sm muted">@{m.username}{m.role === 'child' && m.birth_year ? ` · ${new Date().getFullYear() - m.birth_year} años` : ''}{m.role === 'child' ? ` · objetivo ${m.weekly_goal_points} pts/semana` : ''}{m.phone && m.whatsapp_consent_at ? ' · WhatsApp' : ''}</p>
                </div>
                <IconButton label={`Editar a ${m.display_name}`} onClick={() => setEditing({ m })}><Pencil size={18} /></IconButton>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {inviting ? <InviteSheet onClose={() => setInviting(false)} /> : null}
      {editing ? <MemberEditor member={editing.m} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
