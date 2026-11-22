import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { ConsentBox } from '../components/Consent';
import { Button, Field, Loading } from '../components/ui';
import { AuthShell } from './AuthShell';

export function Forgot() {
  const [login, setLogin] = useState('');
  const [sent, setSent] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      setSent((await post('/auth/forgot', { login })).message);
    } catch (err: any) {
      setSent(err.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell title="Recuperar la contraseña" subtitle="Te enviamos un enlace si tu cuenta de adulto tiene un correo guardado en «Mi perfil». Si eres hijo o hija, pide a un adulto que cambie tu PIN.">
      {sent ? (
        <p role="status" className="rounded-2xl bg-leaf-soft p-4 font-bold text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]">{sent}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Usuario o correo">{(id) => <input id={id} className="field" autoComplete="username" spellCheck={false} autoCapitalize="none" value={login} onChange={(e) => setLogin(e.target.value)} required />}</Field>
          <Button type="submit" size="lg" className="w-full" loading={loading}>Enviar enlace</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Volver a entrar</Link></p>
    </AuthShell>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/auth/reset', { token: params.get('token') ?? '', password });
      setDone(true);
      setTimeout(() => navigate('/'), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell title="Nueva contraseña" subtitle="Elige una contraseña de 8 caracteres como mínimo.">
      {done ? <p role="status" className="font-bold text-leaf-text">Contraseña cambiada. Ya puedes entrar.</p> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Contraseña nueva">{(id) => <input id={id} className="field" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
          {error ? <p role="alert" className="rounded-xl bg-berry-soft px-3 py-2 text-sm font-bold text-berry-deep">{error} <Link to="/recuperar" className="underline">Pedir otro enlace</Link></p> : null}
          <Button type="submit" size="lg" className="w-full" loading={loading}>Cambiar contraseña</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function AcceptInvitation() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inv = useQuery({ queryKey: ['invitation', token], queryFn: () => post('/invitations/lookup', { token }), retry: false });
  const [f, setF] = useState({ username: '', password: '' });
  const [accept, setAccept] = useState(false);
  const status = useQuery({ queryKey: ['setup'], queryFn: () => api<{ legalVersion: string }>('/setup/status') });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/invitations/accept', { token, ...f, acceptTerms: accept, termsVersion: status.data?.legalVersion ?? '' });
      await qc.invalidateQueries();
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  if (inv.isLoading) return <Loading />;
  if (inv.isError) {
    return (
      <AuthShell title="Invitación no válida" subtitle="El enlace ha caducado o ya se ha usado. Pide una nueva invitación.">
        <Link to="/" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Ir a entrar</Link>
      </AuthShell>
    );
  }
  const i = inv.data.invitation;
  return (
    <AuthShell title={`Únete a ${i.family_name}`} subtitle={`Hola, ${i.display_name}. Crea tu usuario de adulto (${i.email}).`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Usuario" hint="Letras, números, punto o guion. Sin espacios.">{(id) => <input id={id} name="username" className="field" autoComplete="username" spellCheck={false} autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required minLength={3} />}</Field>
        <Field label="Contraseña" hint="Mínimo 8 caracteres.">{(id) => <input id={id} className="field" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} />}</Field>
        <ConsentBox checked={accept} onChange={setAccept} adult={false} />
        {error ? <p role="alert" className="rounded-xl bg-berry-soft px-3 py-2 text-sm font-bold text-berry-deep">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Crear mi cuenta</Button>
      </form>
    </AuthShell>
  );
}
