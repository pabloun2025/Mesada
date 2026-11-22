import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, post } from '../lib/api';
import { ConsentBox, Honeypot } from '../components/Consent';
import { Button, Field } from '../components/ui';
import { AuthShell } from './AuthShell';

export function Setup() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ familyName: '', displayName: '', username: '', password: '', email: '' });
  const [accept, setAccept] = useState(false);
  const [website, setWebsite] = useState('');
  const status = useQuery({ queryKey: ['setup'], queryFn: () => api<{ legalVersion: string }>('/setup/status') });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/setup', { ...f, acceptTerms: accept, termsVersion: status.data?.legalVersion ?? '', website });
      await qc.invalidateQueries();
      navigate('/familia');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Crea tu familia" subtitle="Serás la persona administradora. Después podrás añadir al otro adulto y a los hijos.">
      <form onSubmit={submit} className="relative space-y-4">
        <Field label="Nombre de la familia">{(id) => <input id={id} className="field" placeholder="Familia García…" value={f.familyName} onChange={set('familyName')} required />}</Field>
        <Field label="Tu nombre">{(id) => <input id={id} className="field" value={f.displayName} onChange={set('displayName')} required />}</Field>
        <Field label="Usuario" hint="Letras, números, punto o guion. Sin espacios.">
          {(id) => <input id={id} className="field" spellCheck={false} name="username" autoCapitalize="none" autoComplete="username" value={f.username} onChange={set('username')} required minLength={3} />}
        </Field>
        <Field label="Correo" hint="Para recuperar la contraseña si la olvidas.">
          {(id) => <input id={id} className="field" type="email" autoComplete="email" spellCheck={false} value={f.email} onChange={set('email')} required />}
        </Field>
        <Field label="Contraseña" hint="Mínimo 8 caracteres.">
          {(id) => <input id={id} className="field" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={8} />}
        </Field>
        <ConsentBox checked={accept} onChange={setAccept} />
        <Honeypot value={website} onChange={setWebsite} />
        {error ? <p role="alert" className="rounded-xl bg-berry-soft px-3 py-2 text-sm font-bold text-berry-deep">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={!status.data}>Crear familia</Button>
      </form>
    </AuthShell>
  );
}
