import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Ban, Copy, KeyRound, Lock, LogOut, ShieldCheck, UserX } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { relative } from '../lib/format';
import { Badge, Button, Field, Loading, PageHeader, Segmented, Sheet, Toggle, useToast } from '../components/ui';

/*
 * Administración de la instalación. Solo cuentas, bloqueos, ajustes y estado:
 * nunca puntos ni dinero de las familias. Exige verificación en dos pasos en cada sesión.
 */

type Status = { eligible: boolean; totpEnabled: boolean; verified: boolean };

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
const fmtUptime = (s: number) => (s > 86400 ? `${Math.floor(s / 86400)} d` : s > 3600 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 60)} min`);
const ACTIONS: Record<string, string> = {
  'admin.2fa_enabled': 'Activó la verificación en dos pasos',
  'admin.verified': 'Entró en la administración',
  'admin.verify_failed': 'Falló un código de verificación',
  'admin.recovery_codes_regenerated': 'Generó códigos de recuperación nuevos',
  'family.block': 'Bloqueó una familia',
  'family.unblock': 'Desbloqueó una familia',
  'user.temp_password': 'Puso una clave temporal',
  'user.deactivate': 'Desactivó una cuenta',
  'user.activate': 'Activó una cuenta',
  'user.logout_all': 'Cerró las sesiones de una cuenta',
  'settings.registration': 'Cambió el registro de familias',
  'settings.notify': 'Cambió la pausa de envíos',
  'admin.2fa_reset_ssh': 'Se quitó la verificación en dos pasos desde el servidor',
};

function CodeInput({ value, onChange, label = 'Código de 6 cifras' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <Field label={label}>
      {(id) => <input id={id} className="field num text-center text-2xl tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={11} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = codes.join('\n');
  return (
    <div className="space-y-4">
      <p>Guarda estos códigos en un lugar seguro, fuera del móvil. Cada uno sirve <strong>una sola vez</strong> si pierdes la aplicación de autenticación.</p>
      <ol className="num grid grid-cols-2 gap-2 rounded-2xl bg-[var(--chip)] p-4 font-bold">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Códigos copiados'))}><Copy size={18} /> Copiar</Button>
        <Button variant="secondary" onClick={() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([`Códigos de recuperación de DiploP\n\n${text}\n`], { type: 'text/plain' }));
          a.download = 'diplop-codigos-recuperacion.txt';
          a.click();
        }}>Descargar</Button>
      </div>
      <Button className="w-full" onClick={onDone}>Ya los he guardado</Button>
    </div>
  );
}

function Enroll({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (setup) QRCode.toDataURL(setup.uri, { margin: 1, width: 220 }).then(setQr); }, [setup]);
  const start = useMutation({ mutationFn: () => post('/admin/2fa/setup', { password }), onSuccess: (r) => { setSetup(r); setError(''); }, onError: (e: Error) => setError(e.message) });
  const enable = useMutation({ mutationFn: () => post('/admin/2fa/enable', { code }), onSuccess: (r) => setCodes(r.recoveryCodes), onError: (e: Error) => setError(e.message) });

  if (codes) return <section className="panel max-w-lg p-5"><h2 className="mb-3 text-lg font-bold">Códigos de recuperación</h2><RecoveryCodes codes={codes} onDone={onDone} /></section>;
  return (
    <section className="panel max-w-lg space-y-4 p-5">
      <h2 className="text-lg font-bold">Activa la verificación en dos pasos</h2>
      {!setup ? (
        <>
          <p className="muted">Para entrar en la administración necesitas tu contraseña y un código de una aplicación como Google Authenticator, Microsoft Authenticator o 1Password.</p>
          <Field label="Tu contraseña">{(id) => <input id={id} className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button loading={start.isPending} onClick={() => start.mutate()}>Continuar</Button>
        </>
      ) : (
        <>
          <p>1. Abre la aplicación de autenticación y escanea este código.</p>
          {qr ? <img src={qr} alt="Código QR para la aplicación de autenticación" width={220} height={220} className="rounded-xl bg-white p-2" /> : null}
          <p className="text-sm muted">¿No puedes escanearlo? Escribe esta clave:</p>
          <p data-testid="totp-secret" className="num select-all break-all rounded-xl bg-[var(--chip)] px-3 py-2 font-bold tracking-wider">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
          <p>2. Escribe el código que muestra la aplicación.</p>
          <CodeInput value={code} onChange={setCode} />
          <Button loading={enable.isPending} onClick={() => enable.mutate()}>Activar</Button>
        </>
      )}
      {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
    </section>
  );
}

function Verify({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const verify = useMutation({
    mutationFn: () => post('/admin/verify', { code }),
    onSuccess: (r) => { if (r.recoveryCodesLeft < 3) toast(`Te quedan ${r.recoveryCodesLeft} códigos de recuperación. Genera nuevos en Ajustes.`); onDone(); },
    onError: (e: Error) => { setError(e.message); setCode(''); },
  });
  return (
    <form className="panel max-w-md space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
      <h2 className="text-lg font-bold">Confirma que eres tú</h2>
      <p className="muted">Escribe el código de tu aplicación de autenticación. Si la perdiste, usa uno de tus códigos de recuperación.</p>
      <CodeInput value={code} onChange={setCode} label="Código" />
      <Button type="submit" loading={verify.isPending}>Entrar</Button>
      {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
    </form>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'berry' | 'leaf' }) {
  return (
    <div className="card p-4">
      <p className="text-sm font-bold text-[var(--fg-2)]">{label}</p>
      <p className={`num mt-1 text-2xl font-extrabold ${tone === 'berry' ? 'text-berry' : tone === 'leaf' ? 'text-leaf' : ''}`}>{value}</p>
    </div>
  );
}

function Overview() {
  const { data } = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api('/admin/overview'), refetchInterval: 60_000 });
  if (!data) return <Loading />;
  const { counts, notify, health } = data;
  const line = notify.whatsappLine;
  const lineText = !line.configured ? 'Sin configurar' : line.state === 'open' ? 'Vinculada' : line.state === 'connecting' ? 'Conectando' : line.error ?? 'Sin vincular';
  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Familias" value={counts.families} />
        <Stat label="Adultos" value={counts.adults} />
        <Stat label="Hijos" value={counts.children} />
        <Stat label="Activas en 7 días" value={counts.active7} />
      </section>
      {counts.blocked || counts.adults_without_email ? (
        <p className="text-sm muted">{counts.blocked ? `${counts.blocked} familia(s) bloqueada(s). ` : ''}{counts.adults_without_email ? `${counts.adults_without_email} adulto(s) sin correo: no podrán recuperar la contraseña.` : ''}</p>
      ) : null}

      <section className="panel space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Envíos</h2>
          {notify.paused ? <Badge tone="berry">En pausa</Badge> : <Badge tone="leaf">Funcionando</Badge>}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2"><dt className="muted">Correo</dt><dd className="font-bold">{notify.channels.email.real ? notify.channels.email.provider : 'Simulado'} · {notify.usage.email.sent}/{notify.usage.email.cap} este mes</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">WhatsApp</dt><dd className="font-bold">{notify.channels.whatsapp.real ? notify.channels.whatsapp.provider : 'Simulado'} · {notify.usage.whatsapp.sent}/{notify.usage.whatsapp.cap} hoy</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Línea de WhatsApp</dt><dd className={`font-bold ${line.state === 'open' ? 'text-leaf' : 'text-berry'}`}>{lineText}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">En cola</dt><dd className="num font-bold">{notify.outbox.pending}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Enviados (24 h)</dt><dd className="num font-bold">{notify.outbox.sent24}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Fallidos (24 h)</dt><dd className={`num font-bold ${notify.outbox.failed24 ? 'text-berry' : ''}`}>{notify.outbox.failed24}</dd></div>
        </dl>
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="text-lg font-bold">Servidor</h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2"><dt className="muted">Encendido desde hace</dt><dd className="font-bold">{fmtUptime(health.uptimeSeconds)}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Base de datos</dt><dd className="font-bold">{fmtBytes(health.dbBytes)}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Copias de seguridad</dt><dd className={`font-bold ${health.backups?.last ? '' : 'text-berry'}`}>{health.backups?.last ? `${health.backups.count} · última ${relative(health.backups.last)}` : 'No se encuentran'}</dd></div>
          <div className="flex justify-between gap-2"><dt className="muted">Node</dt><dd className="font-bold">{health.node}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function FamilyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin', 'family', id], queryFn: () => api(`/admin/families/${id}`) });
  const [reason, setReason] = useState('');
  const [temp, setTemp] = useState<{ who: string; secret: string; kind: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const act = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: () => refresh(),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (!data) return <Sheet open onClose={onClose} title="Familia"><Loading /></Sheet>;
  const f = data.family;
  return (
    <Sheet open onClose={onClose} title={f.name}>
      <div className="space-y-5">
        <p className="text-sm muted">Creada {relative(f.created_at)}. {f.blocked_at ? `Bloqueada ${relative(f.blocked_at)}${f.blocked_reason ? `: ${f.blocked_reason}` : ''}.` : ''}</p>
        {temp ? (
          <div role="status" className="rounded-2xl border-2 border-sun bg-sun-soft p-4 dark:bg-sun/10">
            <p className="text-sm">{temp.kind === 'pin' ? 'PIN' : 'Contraseña'} temporal de <strong>{temp.who}</strong>. Dásela en persona; no se volverá a mostrar.</p>
            <p data-testid="temp-secret" className="num mt-2 select-all text-2xl font-extrabold tracking-wider">{temp.secret}</p>
          </div>
        ) : null}
        <ul className="space-y-2.5">
          {data.members.map((m: any) => (
            <li key={m.id} className={`card space-y-2 p-3.5 ${m.active ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <strong>{m.display_name}</strong>
                <span className="text-sm muted">@{m.username}</span>
                <Badge>{m.role === 'adult' ? 'Adulto' : 'Hijo/a'}</Badge>
                {m.is_superadmin ? <Badge tone="sky">Administración</Badge> : null}
                {m.two_factor ? <Badge tone="leaf">2 pasos</Badge> : null}
                {!m.active ? <Badge tone="berry">Desactivada</Badge> : null}
              </div>
              <p className="text-sm muted">{m.email ?? (m.role === 'adult' ? 'Sin correo' : '')}{m.email || m.role === 'adult' ? ' · ' : ''}{m.last_login_at ? `entró ${relative(m.last_login_at)}` : 'nunca ha entrado'} · {m.sessions} sesión(es)</p>
              {!m.is_superadmin ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => act.mutate(async () => { const r = await post(`/admin/users/${m.id}/temp-password`); setTemp({ who: m.display_name, ...r }); })}><KeyRound size={16} /> {m.role === 'child' ? 'PIN temporal' : 'Contraseña temporal'}</Button>
                  {m.sessions ? <Button variant="secondary" onClick={() => act.mutate(async () => { await post(`/admin/users/${m.id}/logout`); toast('Sesiones cerradas'); })}><LogOut size={16} /> Cerrar sesiones</Button> : null}
                  <Button variant="secondary" onClick={() => act.mutate(() => post(`/admin/users/${m.id}/active`, { active: !m.active }))}><UserX size={16} /> {m.active ? 'Desactivar' : 'Activar'}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {!data.members.some((m: any) => m.is_superadmin) ? (
          <section className="space-y-3 border-t border-[var(--line)] pt-4">
            {f.blocked_at ? (
              <Button variant="secondary" onClick={() => act.mutate(() => post(`/admin/families/${id}/block`, { blocked: false }))}>Desbloquear familia</Button>
            ) : (
              <>
                <Field label="Motivo del bloqueo (opcional)">{(fid) => <input id={fid} className="field" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />}</Field>
                <Button variant="danger" onClick={() => { if (confirm(`¿Bloquear «${f.name}»? Nadie de esa familia podrá entrar.`)) act.mutate(() => post(`/admin/families/${id}/block`, { blocked: true, reason: reason || undefined })); }}><Ban size={16} /> Bloquear familia</Button>
              </>
            )}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}

function Families() {
  const { data } = useQuery({ queryKey: ['admin', 'families'], queryFn: () => api('/admin/families') });
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  if (!data) return <Loading />;
  const list = data.families.filter((f: any) => f.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="space-y-4">
      {data.families.length > 6 ? <Field label="Buscar familia">{(id) => <input id={id} className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field> : null}
      <ul className="space-y-2.5">
        {list.map((f: any) => (
          <li key={f.id}>
            <button type="button" onClick={() => setOpen(f.id)} className={`card flex w-full items-center gap-3 p-3.5 text-left ${f.blocked_at ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{f.name} {f.is_admin_family ? <Badge tone="sky">La tuya</Badge> : null} {f.blocked_at ? <Badge tone="berry">Bloqueada</Badge> : null}</p>
                <p className="text-sm muted">{f.adults} adulto(s) · {f.children} hijo(s) · {f.last_login_at ? `última entrada ${relative(f.last_login_at)}` : 'sin entradas'}</p>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open ? <FamilyDetail id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function AdminSettings({ onLock }: { onLock: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api('/admin/overview') });
  const [codes, setCodes] = useState<string[] | null>(null);
  const save = useMutation({
    mutationFn: (b: { registrationOpen?: boolean; notifyPaused?: boolean }) => put('/admin/settings', b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin'] }); toast('Ajuste guardado'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const regen = useMutation({ mutationFn: () => post('/admin/2fa/recovery-codes'), onSuccess: (r) => setCodes(r.recoveryCodes) });
  if (!data) return <Loading />;
  return (
    <div className="max-w-xl space-y-6">
      <section className="panel p-5">
        <Toggle checked={data.settings.registrationOpen} onChange={(v) => save.mutate({ registrationOpen: v })} label="Permitir que se registren familias nuevas" description="Si está apagado, solo entran las familias que ya existen." />
        <Toggle checked={data.notify.paused} onChange={(v) => save.mutate({ notifyPaused: v })} label="Pausar todos los envíos" description="Los correos y WhatsApp se guardan en cola y salen al quitar la pausa." />
      </section>
      <section className="panel space-y-3 p-5">
        <h2 className="text-lg font-bold">Códigos de recuperación</h2>
        {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : (
          <>
            <p className="muted">Generar códigos nuevos anula los anteriores.</p>
            <Button variant="secondary" loading={regen.isPending} onClick={() => regen.mutate()}>Generar códigos nuevos</Button>
          </>
        )}
      </section>
      <Button variant="secondary" onClick={onLock}><Lock size={18} /> Salir de la administración</Button>
    </div>
  );
}

function Audit() {
  const { data } = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api('/admin/audit') });
  if (!data) return <Loading />;
  if (!data.entries.length) return <p className="muted">Aún no hay acciones registradas.</p>;
  return (
    <ul className="panel divide-y divide-[var(--line)]">
      {data.entries.map((e: any) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <span><strong>{e.actor ?? 'Alguien'}</strong> · {ACTIONS[e.action] ?? e.action}{e.family ? ` · ${e.family}` : ''}{e.target ? ` · @${e.target}` : ''}</span>
          <time className="muted" dateTime={e.created_at}>{relative(e.created_at)}</time>
        </li>
      ))}
    </ul>
  );
}

type Tab = 'resumen' | 'familias' | 'ajustes' | 'registro';

export default function Admin() {
  const qc = useQueryClient();
  const status = useQuery<Status>({ queryKey: ['admin', 'status'], queryFn: () => api('/admin/status') });
  const [tab, setTab] = useState<Tab>('resumen');
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const lock = useMutation({ mutationFn: () => post('/admin/lock'), onSuccess: () => { qc.removeQueries({ queryKey: ['admin'] }); refresh(); } });
  if (!status.data) return <Loading />;
  const s = status.data;
  const header = <PageHeader title="Administración" subtitle="Cuentas, envíos y estado del servidor. Sin datos de puntos ni dinero." />;
  if (!s.eligible) return <div>{header}<p className="muted">Tu cuenta no tiene acceso a la administración.</p></div>;
  if (!s.totpEnabled) return <div>{header}<Enroll onDone={refresh} /></div>;
  if (!s.verified) return <div>{header}<Verify onDone={refresh} /></div>;
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Administración"
        subtitle={<span className="inline-flex items-center gap-1.5"><ShieldCheck size={16} className="text-leaf" aria-hidden /> Verificada. Se vuelve a pedir el código a las 12 horas.</span>}
      />
      <div className="mb-5">
        <Segmented label="Sección" value={tab} onChange={setTab} options={[
          { value: 'resumen', label: 'Resumen' },
          { value: 'familias', label: 'Familias' },
          { value: 'ajustes', label: 'Ajustes' },
          { value: 'registro', label: 'Registro' },
        ]} />
      </div>
      {tab === 'resumen' ? <Overview /> : tab === 'familias' ? <Families /> : tab === 'ajustes' ? <AdminSettings onLock={() => lock.mutate()} /> : <Audit />}
    </div>
  );
}
