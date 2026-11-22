import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Crown, Mail, Pencil, Trash2, UserPlus, X } from 'lucide-react';
import { api, patch, post, put } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Relationship, User } from '../lib/types';
import { KINSHIPS, kinshipText } from '../lib/kinship';
import { EraseChildSheet } from '../components/PrivacyData';
import { AVATARS, Avatar, Badge, Button, Field, IconButton, Loading, MEMBER_COLORS, PageHeader, Sheet, Toggle, useToast } from '../components/ui';

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
    relationship: (member?.relationship ?? '') as Relationship | '',
    relationshipLabel: member?.relationship_label ?? '',
    displayName: member?.display_name ?? '',
    username: member?.username ?? '',
    password: '',
    avatar: member?.avatar ?? 'fox',
    color: member?.color ?? 'tangerine',
    birthYear: member?.birth_year ?? null as number | null,
    weeklyGoalPoints: member?.weekly_goal_points ?? 150,
    active: member?.active ?? true,
    email: member?.email ?? '',
    phone: member?.phone ?? '',
    whatsapp: !!member?.whatsapp_consent_at,
  });
  const [error, setError] = useState('');
  const [erasing, setErasing] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const { user: me } = useSession();
  const save = useMutation({
    mutationFn: async () => {
      let id = member?.id;
      if (isNew) {
        const { phone: _p, email: _e, whatsapp: _w, relationship: _r, relationshipLabel: _l, ...rest } = m;
        id = (await post<{ member: User }>('/members', rest)).member.id;
      } else {
        const body: any = { displayName: m.displayName, avatar: m.avatar, color: m.color, birthYear: m.birthYear, weeklyGoalPoints: m.weeklyGoalPoints, active: m.active };
        if (m.password) body.password = m.password;
        // El parentesco de un adulto lo cambia solo la cuenta principal.
        if (m.role === 'adult' && me.is_principal && m.relationship) { body.relationship = m.relationship; if (m.relationship === 'other') body.relationshipLabel = m.relationshipLabel; }
        if (m.role === 'adult' && !me.is_principal) delete body.active;
        await patch(`/members/${id}`, body);
      }
      // Correo y teléfono (WhatsApp) de cualquier miembro: los pone la cuenta principal; cada uno los cambia luego en Mi perfil.
      const phone = m.phone.trim();
      const email = m.email.trim();
      const changed = isNew ? !!(phone || email) : phone !== (member?.phone ?? '') || email !== (member?.email ?? '') || (m.role === 'child' && m.whatsapp !== !!member?.whatsapp_consent_at);
      if (me.is_principal && id && changed) {
        await put(`/notify/contact/${id}`, { email: email || null, phone: phone || null, whatsappConsent: m.whatsapp && !!phone });
      }
    },
    onSuccess: () => { toast(isNew ? `${m.displayName} se ha unido a la familia` : 'Perfil guardado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const child = m.role === 'child';
  const childAge = m.birthYear ? new Date().getFullYear() - m.birthYear : null;
  return (
    <Sheet open onClose={onClose} title={isNew ? 'Añadir un hijo o hija' : `Editar a ${member.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Añadir' : 'Guardar'}</Button>}>
      <div className="space-y-4">
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
        {me.is_principal && !(member && member.id === me.id) ? (
          <div className="space-y-3 rounded-2xl border border-[var(--line)] p-3.5" role="group" aria-label="Correo y teléfono">
            <Field label={child ? 'Correo (opcional)' : 'Correo'}>
              {(id) => <input id={id} className="field" type="email" spellCheck={false} autoComplete="off" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />}
            </Field>
            <Field label="Teléfono de WhatsApp (opcional)" hint={child ? (childAge !== null && childAge < 13 ? 'Con menos de 13 años no se le envía WhatsApp; los avisos le llegan dentro de la app.' : 'Le avisaremos de tareas nuevas, rechazos y premios.') : 'Con prefijo si no es de España. El permiso de WhatsApp lo da la propia persona en Mi perfil.'}>
              {(id) => <input id={id} className="field" type="tel" inputMode="tel" autoComplete="off" placeholder="600 11 22 33" value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} />}
            </Field>
            {child ? <Toggle checked={m.whatsapp} onChange={(v) => setM({ ...m, whatsapp: v })} label="Recibir avisos por WhatsApp" description="Como madre, padre o tutor das tu permiso." /> : null}
            {!isNew && !child ? <p className="text-sm muted">{member.display_name} lo verá y podrá cambiarlo en su Mi perfil. Si cambias su correo o su teléfono, se lo avisamos en la app.</p> : null}
          </div>
        ) : !isNew && member.id === me.id ? (
          <p className="text-sm muted">Tu correo y tu WhatsApp se cambian en Mi perfil.</p>
        ) : !isNew && !child ? (
          <p className="text-sm muted">{member.display_name} cambia su correo y su teléfono en su propio perfil.</p>
        ) : null}
        {!isNew && member.role === 'adult' && me.is_principal && !member.is_principal ? (
          <div className="space-y-3 rounded-2xl border border-[var(--line)] p-3.5">
            <Field label="Parentesco">
              {(id) => (
                <select id={id} className="field" value={m.relationship} onChange={(e) => setM({ ...m, relationship: e.target.value as Relationship })}>
                  <option value="">Sin indicar</option>
                  {KINSHIPS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              )}
            </Field>
            {m.relationship === 'other' ? <Field label="¿Qué parentesco?">{(id) => <input id={id} className="field" maxLength={40} value={m.relationshipLabel} onChange={(e) => setM({ ...m, relationshipLabel: e.target.value })} />}</Field> : null}
            <p className="text-sm muted">{KINSHIPS.find((k) => k.value === m.relationship)?.relative ? 'Pariente: puede ver el progreso de los niños y animarles, nada más.' : 'Adulto completo: puede hacer lo mismo que tú, salvo añadir o quitar adultos.'}</p>
          </div>
        ) : null}
        {!isNew && (member.role === 'child' || (me.is_principal && !member.is_principal)) ? <Toggle checked={m.active} onChange={(v) => setM({ ...m, active: v })} label={member.role === 'adult' ? 'Con acceso' : 'Cuenta activa'} description={member.role === 'adult' ? 'Si se lo quitas, no podrá entrar. Puedes devolvérselo cuando quieras.' : 'Si la desactivas, no podrá entrar y se quitará de las tareas.'} /> : null}
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
  const [f, setF] = useState({ displayName: '', relationship: '' as Relationship | '', relationshipLabel: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => {
      if (!f.relationship) throw new Error('Elige el parentesco');
      return post('/invitations', { displayName: f.displayName, relationship: f.relationship, relationshipLabel: f.relationship === 'other' ? f.relationshipLabel : undefined, email: f.email, phone: f.phone.trim() || undefined });
    },
    onSuccess: () => { toast(`Invitación enviada a ${f.email}`); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const kin = KINSHIPS.find((k) => k.value === f.relationship);
  return (
    <Sheet open onClose={onClose} title="Invitar a un adulto o pariente" footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Enviar invitación</Button>}>
      <p className="mb-4 muted">Recibirá un correo con un enlace para crear su usuario y su contraseña. Caduca en 7 días. Avísale antes: das su correo y su teléfono con su permiso.</p>
      <div className="space-y-4">
        <Field label="Nombre">{(id) => <input id={id} className="field" maxLength={60} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}</Field>
        <Field label="Parentesco">
          {(id) => (
            <select id={id} className="field" value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value as Relationship })}>
              <option value="">Elige uno…</option>
              {KINSHIPS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          )}
        </Field>
        {f.relationship === 'other' ? <Field label="¿Qué parentesco?" hint="Por ejemplo: vecina, padrino…">{(id) => <input id={id} className="field" maxLength={40} value={f.relationshipLabel} onChange={(e) => setF({ ...f, relationshipLabel: e.target.value })} />}</Field> : null}
        {kin ? <p role="note" className="rounded-xl bg-[var(--chip)] px-3 py-2 text-sm">{kin.relative ? 'Será pariente: ve el progreso de los niños, les felicita y hace aportes a sus metas. No valida, no paga ni toca ajustes.' : 'Será adulto completo: puede validar, pagar y cambiar ajustes, igual que tú. Solo tú puedes añadir o quitar adultos.'}</p> : null}
        <Field label="Correo">{(id) => <input id={id} className="field" type="email" spellCheck={false} autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="Teléfono (opcional)" hint="Con prefijo si no es de España. No se usa para WhatsApp si la persona no lo activa.">{(id) => <input id={id} className="field" type="tel" inputMode="tel" autoComplete="off" placeholder="600 11 22 33" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/** La cuenta principal cede el papel a otro adulto completo (pide su contraseña). */
function TransferSheet({ adults, onClose }: { adults: User[]; onClose: () => void }) {
  const [to, setTo] = useState(adults[0]?.id ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const go = useMutation({
    mutationFn: () => post('/family/principal', { userId: to, password }),
    onSuccess: () => { toast('Has cedido la cuenta principal'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title="Ceder la cuenta principal" footer={<Button className="w-full" variant="danger" loading={go.isPending} disabled={!to || !password} onClick={() => go.mutate()}>Ceder el papel</Button>}>
      <p className="mb-4 muted">La cuenta principal es la única que añade o quita adultos y parientes. Después de cederla, ya no podrás hacerlo tú.</p>
      <div className="space-y-4">
        <Field label="Nueva cuenta principal">
          {(id) => <select id={id} className="field" value={to} onChange={(e) => setTo(e.target.value)}>{adults.map((a) => <option key={a.id} value={a.id}>{a.display_name}{kinshipText(a) ? ` (${kinshipText(a)})` : ''}</option>)}</select>}
        </Field>
        <Field label="Tu contraseña">{(id) => <input id={id} className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}

interface Invitation { id: string; email: string; display_name: string; relationship: Relationship | null; relationship_label: string | null; expires_at: string; accepted_at: string | null }

export default function Family() {
  const { user } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const invs = useQuery({ queryKey: ['invitations'], queryFn: () => api<{ invitations: Invitation[] }>('/invitations'), enabled: !!user.is_principal });
  const [editing, setEditing] = useState<{ m: User | null } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/invitations/${id}/cancel`),
    onSuccess: () => { toast('Invitación anulada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (isLoading || !data) return <Loading />;
  const groups = [
    { title: 'Hijos', list: data.members.filter((m) => m.role === 'child') },
    { title: 'Adultos', list: data.members.filter((m) => m.role === 'adult' && !m.is_relative) },
    { title: 'Parientes', list: data.members.filter((m) => m.role === 'adult' && m.is_relative) },
  ].filter((g) => g.list.length || g.title !== 'Parientes');
  const open = (invs.data?.invitations ?? []).filter((i) => !i.accepted_at && new Date(i.expires_at) > new Date());
  const otherAdults = data.members.filter((m) => m.role === 'adult' && !m.is_relative && m.active && m.id !== user.id);
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Familia" subtitle="Perfiles, accesos y objetivos."
        action={<div className="flex flex-wrap gap-2">{user.is_principal ? <Button variant="secondary" onClick={() => setInviting(true)}><Mail size={18} /> Invitar</Button> : null}<Button onClick={() => setEditing({ m: null })}><UserPlus size={18} /> Añadir</Button></div>}
      />
      {groups.map((g) => (
        <section key={g.title} className="mb-6" aria-label={g.title}>
          <h2 className="mb-3 text-lg font-bold">{g.title}</h2>
          <ul className="space-y-2.5">
            {g.list.map((m) => {
              const kin = kinshipText(m);
              const canEdit = m.role === 'child' || m.id === user.id || !!user.is_principal;
              return (
                <li key={m.id} className={`card flex items-center gap-3 p-3.5 ${m.active ? '' : 'opacity-55'}`}>
                  <Avatar name={m.display_name} avatar={m.avatar} colorKey={m.color} size={46} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-bold">{m.display_name} {m.id === user.id ? <Badge>Tú</Badge> : null} {kin ? <Badge tone="sky">{kin}</Badge> : null} {m.is_principal ? <Badge tone="sun"><Crown size={12} aria-hidden /> Cuenta principal</Badge> : null} {!m.active ? <Badge tone="berry">{m.role === 'adult' ? 'Sin acceso' : 'Desactivada'}</Badge> : null}</p>
                    <p className="text-sm muted">@{m.username}{m.role === 'child' && m.birth_year ? ` · ${new Date().getFullYear() - m.birth_year} años` : ''}{m.role === 'child' ? ` · objetivo ${m.weekly_goal_points} pts/semana` : ''}{m.phone && m.whatsapp_consent_at ? ' · WhatsApp' : ''}</p>
                  </div>
                  {canEdit ? <IconButton label={`Editar a ${m.display_name}`} onClick={() => setEditing({ m })}><Pencil size={18} /></IconButton> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {user.is_principal && open.length ? (
        <section className="mb-6" aria-label="Invitaciones pendientes">
          <h2 className="mb-3 text-lg font-bold">Invitaciones pendientes</h2>
          <ul className="space-y-2.5">
            {open.map((i) => (
              <li key={i.id} className="card flex items-center gap-3 p-3.5">
                <Mail size={20} className="shrink-0 text-tangerine" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{i.display_name} <Badge tone="sky">{kinshipText({ relationship: i.relationship, relationship_label: i.relationship_label })}</Badge></p>
                  <p className="truncate text-sm muted">{i.email}</p>
                </div>
                <IconButton label={`Anular la invitación a ${i.display_name}`} onClick={() => cancel.mutate(i.id)}><X size={18} /></IconButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {user.is_principal ? (
        <section className="panel mb-6 p-4" aria-label="Cuenta principal">
          <h2 className="font-bold">Eres la cuenta principal</h2>
          <p className="mb-3 text-sm muted">Solo tú añades o quitas adultos y parientes. Si lo prefieres, puedes ceder el papel a otro adulto completo.</p>
          <Button variant="secondary" size="sm" disabled={!otherAdults.length} onClick={() => setTransferring(true)}>Ceder la cuenta principal</Button>
        </section>
      ) : null}
      {inviting ? <InviteSheet onClose={() => setInviting(false)} /> : null}
      {transferring ? <TransferSheet adults={otherAdults} onClose={() => setTransferring(false)} /> : null}
      {editing ? <MemberEditor member={editing.m} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
