import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../lib/api';
import { Button, Field, Segmented } from '../components/ui';
import { AuthShell } from './AuthShell';

export function Login({ canRegister }: { canRegister: boolean }) {
  const qc = useQueryClient();
  const [who, setWho] = useState<'child' | 'adult'>('adult');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await post('/auth/login', { username, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Entrar" subtitle="Usa el usuario que te dieron en casa.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Segmented label="Tipo de cuenta" value={who} onChange={setWho} options={[{ value: 'adult', label: 'Soy adulto' }, { value: 'child', label: 'Soy hijo/a' }]} />
        <Field label="Usuario">
          {(id) => <input id={id} className="field" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />}
        </Field>
        <Field label={who === 'child' ? 'PIN' : 'Contraseña'}>
          {(id) => (
            <input
              id={id}
              className="field"
              type="password"
              inputMode={who === 'child' ? 'numeric' : undefined}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        {error ? <p role="alert" className="rounded-xl bg-berry-soft px-3 py-2 text-sm font-bold text-berry dark:bg-berry/20">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Entrar</Button>
      </form>
      {canRegister ? (
        <p className="mt-6 text-center text-sm muted">
          ¿Primera vez? <Link to="/configurar" className="font-bold text-sky underline-offset-2 hover:underline">Crea tu familia</Link>
        </p>
      ) : null}
    </AuthShell>
  );
}
