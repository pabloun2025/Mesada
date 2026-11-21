import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail, MessageCircle, MoonStar, Send } from 'lucide-react';
import { api, put } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Avatar, Badge, Button, Field, Loading, PageHeader, SectionTitle, Sheet, Toggle, useToast } from '../components/ui';

type Channel = 'email' | 'whatsapp';
interface Member {
  id: string; role: 'adult' | 'child'; display_name: string; avatar: string; color: string;
  email: string | null; phone: string | null; whatsapp_consent_at: string | null;
  editable: boolean; blocked: Record<Channel, string | null>; prefs: Record<string, Record<Channel, boolean>>;
}
interface Settings {
  family: { quiet_start: string; quiet_end: string; reminder_time: string; due_soon_minutes: number };
  channels: Record<Channel, { provider: string; real: boolean }>;
  usage?: Record<Channel, { sent: number; cap: number; period: string }>;
  events: { key: string; label: string; audience: string }[];
  members: Member[];
}

const STATUS: Record<string, { label: string; tone: 'muted' | 'leaf' | 'sun' | 'berry' }> = {
  pending: { label: 'En cola', tone: 'muted' }, sending: { label: 'Enviando', tone: 'sun' }, sent: { label: 'Enviado', tone: 'leaf' },
  failed: { label: 'Falló', tone: 'berry' }, skipped: { label: 'Omitido', tone: 'muted' }, uncertain: { label: 'Incierto', tone: 'sun' },
};

function ContactSheet({ m, onClose }: { m: Member; onClose: () => void }) {
  const [email, setEmail] = useState(m.email ?? '');
  const [phone, setPhone] = useState(m.phone ?? '');
  const [consent, setConsent] = useState(!!m.whatsapp_consent_at);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => put(`/notify/contact/${m.id}`, { email: email || null, phone: phone || null, whatsappConsent: consent }),
    onSuccess: () => { toast('Datos de contacto guardados'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={`Contacto de ${m.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button>}>
      <div className="space-y-4">
        {m.role === 'adult' ? (
          <Field label="Correo" hint="Para avisos importantes y para recuperar la contraseña.">
            {(id) => <input id={id} className="field" type="email" autoComplete="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Teléfono de WhatsApp" hint="Con prefijo, por ejemplo +34 600 000 000.">
          {(id) => <input id={id} className="field" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Toggle
          checked={consent}
          onChange={setConsent}
          label="Consentimiento para WhatsApp"
          description={m.role === 'child' ? 'Confirmas, como adulto responsable, que este número es del menor y que puede recibir avisos. WhatsApp exige 13 años como mínimo.' : 'Aceptas recibir avisos de Mesada en este número.'}
        />
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

function MemberPrefs({ m, events }: { m: Member; events: Settings['events'] }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  // Cambio optimista: la casilla responde al instante y se revierte si el servidor lo rechaza.
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const toggle = useMutation({
    mutationFn: (v: { event: string; channel: Channel; enabled: boolean }) => put(`/notify/prefs/${m.id}`, { prefs: [v] }),
    onMutate: (v) => setLocal((l) => ({ ...l, [`${v.event}:${v.channel}`]: v.enabled })),
    onSuccess: () => invalidate(),
    onError: (e: Error, v) => {
      setLocal((l) => {
        const { [`${v.event}:${v.channel}`]: _drop, ...rest } = l;
        return rest;
      });
      toast(e.message, 'error');
    },
  });
  const [contact, setContact] = useState(false);
  const rows = events.filter((e) => m.prefs[e.key]);
  // Los hijos no tienen correo: solo se muestra WhatsApp.
  const channels: Channel[] = m.role === 'adult' ? ['email', 'whatsapp'] : ['whatsapp'];
  return (
    <article className="panel overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <Avatar name={m.display_name} avatar={m.avatar} colorKey={m.color} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-bold">{m.display_name}</h3>
          <p className="truncate text-sm muted">{[m.email, m.phone].filter(Boolean).join(' · ') || 'Sin datos de contacto'}</p>
        </div>
        {m.editable ? <Button size="sm" variant="secondary" onClick={() => setContact(true)}>Contacto</Button> : null}
      </div>
      <div className="overflow-x-auto border-t border-[var(--line)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--fg-3)]">
            <tr>
              <th className="px-4 py-2 font-bold">Aviso</th>
              {m.role === 'adult' ? <th className="w-24 px-2 py-2 text-center font-bold"><Mail size={16} className="inline" aria-hidden /> Correo</th> : null}
              <th className="w-28 px-2 py-2 text-center font-bold"><MessageCircle size={16} className="inline" aria-hidden /> WhatsApp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {rows.map((e) => (
              <tr key={e.key}>
                <td className="px-4 py-2.5">{e.label}</td>
                {channels.map((c) => {
                  const blocked = m.blocked[c];
                  const on = local[`${e.key}:${c}`] ?? m.prefs[e.key][c];
                  return (
                    <td key={c} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        className="size-5 accent-[#1E9E6A] disabled:opacity-40"
                        checked={on && !blocked}
                        disabled={!m.editable || !!blocked}
                        title={blocked ?? undefined}
                        aria-label={`${e.label} por ${c === 'email' ? 'correo' : 'WhatsApp'} para ${m.display_name}`}
                        onChange={(ev) => toggle.mutate({ event: e.key, channel: c, enabled: ev.target.checked })}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!m.editable && m.role === 'adult' ? <p className="border-t border-[var(--line)] px-4 py-2.5 text-xs muted">Cada adulto configura sus propios avisos desde su cuenta.</p> : null}
      {(m.blocked.email && m.role === 'adult') || m.blocked.whatsapp ? (
        <p className="border-t border-[var(--line)] px-4 py-2.5 text-xs muted">
          {m.blocked.email && m.role === 'adult' ? `Correo: ${m.blocked.email}. ` : ''}
          {m.blocked.whatsapp ? `WhatsApp: ${m.blocked.whatsapp}.` : ''}
        </p>
      ) : null}
      {contact ? <ContactSheet m={m} onClose={() => setContact(false)} /> : null}
    </article>
  );
}

export default function Notifications() {
  const { user } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['notify-settings'], queryFn: () => api<Settings>('/notify/settings') });
  const log = useQuery({ queryKey: ['notify-outbox'], queryFn: () => api('/notify/outbox'), enabled: user.role === 'adult' });
  const [f, setF] = useState<Settings['family'] | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const saveFamily = useMutation({
    mutationFn: (v: Settings['family']) => put('/notify/family', { quietStart: v.quiet_start, quietEnd: v.quiet_end, reminderTime: v.reminder_time, dueSoonMinutes: Number(v.due_soon_minutes) }),
    onSuccess: () => { toast('Horarios guardados'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (isLoading || !data) return <Loading />;
  const fam = f ?? data.family;
  const simulated = !data.channels.email.real || !data.channels.whatsapp.real;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Avisos" subtitle="Qué avisos recibe cada uno y por dónde. En la aplicación llegan siempre." />

      {simulated ? (
        <p className="mb-5 rounded-2xl bg-sun-soft px-4 py-3 text-sm font-bold text-[#7a5600] dark:bg-sun/15 dark:text-[#ffd979]">
          {!data.channels.whatsapp.real && !data.channels.email.real ? 'Correo y WhatsApp están en modo simulado' : !data.channels.whatsapp.real ? 'WhatsApp está en modo simulado' : 'El correo está en modo simulado'}: los avisos se registran pero no salen hasta que se activen en el servidor.
        </p>
      ) : null}

      {user.role === 'adult' ? (
        <section className="panel mb-6 p-5">
          <SectionTitle>Horarios de la familia</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Silencio desde">{(id) => <input id={id} type="time" className="field" value={fam.quiet_start} onChange={(e) => setF({ ...fam, quiet_start: e.target.value })} />}</Field>
            <Field label="Silencio hasta">{(id) => <input id={id} type="time" className="field" value={fam.quiet_end} onChange={(e) => setF({ ...fam, quiet_end: e.target.value })} />}</Field>
            <Field label="Recordatorio diario">{(id) => <input id={id} type="time" className="field" value={fam.reminder_time} onChange={(e) => setF({ ...fam, reminder_time: e.target.value })} />}</Field>
            <Field label="Aviso antes de vencer (min)">{(id) => <input id={id} type="number" min={0} max={720} className="field" value={fam.due_soon_minutes} onChange={(e) => setF({ ...fam, due_soon_minutes: Number(e.target.value) })} />}</Field>
          </div>
          <p className="mt-3 flex items-center gap-2 text-sm muted"><MoonStar size={16} aria-hidden /> Durante el silencio no sale nada; los avisos esperan a que termine.</p>
          <Button className="mt-4" loading={saveFamily.isPending} onClick={() => saveFamily.mutate(fam)}>Guardar horarios</Button>
        </section>
      ) : null}

      <section className="mb-8">
        <SectionTitle>{user.role === 'adult' ? 'Por persona' : 'Tus avisos'}</SectionTitle>
        <div className="space-y-4">{data.members.map((m) => <MemberPrefs key={m.id} m={m} events={data.events} />)}</div>
        {user.role === 'child' ? <p className="mt-3 text-sm muted">Tus avisos los configuran tus padres.</p> : null}
      </section>

      {user.role === 'adult' ? (
        <section>
          <SectionTitle>Últimos envíos</SectionTitle>
          {data.usage ? (
            <p className="mb-3 text-sm muted">
              Este mes: {data.usage.email.sent} de {data.usage.email.cap} correos. Hoy: {data.usage.whatsapp.sent} de {data.usage.whatsapp.cap} WhatsApp.
            </p>
          ) : null}
          <ul className="card divide-y divide-[var(--line)]">
            {(log.data?.entries ?? []).map((o: any) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                {o.channel === 'email' ? <Mail size={16} aria-label="Correo" /> : <MessageCircle size={16} aria-label="WhatsApp" />}
                <span className="min-w-0 flex-1 truncate"><strong>{o.display_name ?? 'Invitación'}</strong> · {o.subject}</span>
                <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                <span className="w-28 text-right text-xs muted">{fmtDateTime(o.sent_at ?? o.created_at)}</span>
                {o.last_error ? <span className="w-full text-xs text-berry">{o.last_error}</span> : null}
              </li>
            ))}
            {!log.data?.entries?.length ? <li className="flex items-center gap-2 p-4 text-sm muted"><Send size={16} aria-hidden /> Todavía no ha salido ningún aviso por correo ni WhatsApp.</li> : null}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
