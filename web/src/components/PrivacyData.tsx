import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { post } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import { Button, Field, Sheet, buttonClass } from './ui';

/** Frase que hay que escribir para borrar la familia (el servidor la comprueba igual, sin importar mayúsculas). */
export const ERASE_PHRASE = 'BORRAR MI FAMILIA';
const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toUpperCase() === b;

/** Ajustes › Privacidad y datos: lo aceptado, descargar todo y borrar la familia. Solo adultos. */
export function PrivacySettings() {
  const { user } = useSession();
  const [erasing, setErasing] = useState(false);
  return (
    <section className="panel space-y-4 p-5" aria-labelledby="privacy-settings">
      <div>
        <h2 id="privacy-settings" className="text-lg font-bold">Privacidad y datos</h2>
        <p className="text-sm muted">
          {user.terms_accepted_at
            ? `Aceptaste la política de privacidad y las condiciones el ${fmtDate(user.terms_accepted_at.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' })} (versión ${user.terms_version}).`
            : 'Tu cuenta es anterior a la casilla de aceptación.'}{' '}
          Léelas cuando quieras: <Link to="/privacidad" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Privacidad</Link>,{' '}
          <Link to="/condiciones" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Condiciones</Link> y{' '}
          <Link to="/aviso-legal" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Aviso legal</Link>.
        </p>
      </div>
      <div className="rounded-2xl border border-[var(--line)] p-4">
        <h3 className="font-bold">Descargar todos los datos</h3>
        <p className="mt-1 mb-3 text-sm muted">Un ZIP con todo lo de la familia en ficheros legibles (miembros, tareas, puntos, dinero, pantalla, historial) y las fotos de evidencia. Sin contraseñas.</p>
        <a href="/api/privacy/export" download className={buttonClass('secondary')}><Download size={18} aria-hidden /> Descargar los datos de la familia</a>
      </div>
      <div className="rounded-2xl border border-berry/40 p-4">
        <h3 className="font-bold text-berry-deep dark:text-[#ff9dbf]">Borrar la familia</h3>
        <p className="mt-1 mb-3 text-sm muted">Se borran de inmediato las cuentas de todos, las tareas, los puntos, el dinero y las fotos. No se puede deshacer. Antes, descarga los datos si quieres guardarlos. Para borrar solo a un hijo, ve a <strong>Familia</strong> y edita su perfil.</p>
        <Button variant="danger" onClick={() => setErasing(true)}><Trash2 size={18} aria-hidden /> Borrar la familia entera…</Button>
      </div>
      {erasing ? <EraseFamilySheet onClose={() => setErasing(false)} /> : null}
    </section>
  );
}

function EraseFamilySheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState('');
  const erase = useMutation({
    mutationFn: () => post('/privacy/delete-family', { password, phrase }),
    onSuccess: () => {
      try { localStorage.removeItem('mesada:returning'); } catch { /* da igual */ }
      qc.clear();
      // Recarga limpia: ya no hay sesión ni familia.
      window.location.assign('/');
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title="Borrar la familia entera"
      footer={<Button variant="danger" className="w-full" loading={erase.isPending} disabled={!password || !same(phrase, ERASE_PHRASE)} onClick={() => erase.mutate()}>Borrar para siempre</Button>}
    >
      <div className="space-y-4">
        <p className="rounded-2xl bg-berry-soft p-3 text-sm font-bold text-berry-deep dark:bg-berry/20 dark:text-[#ff9dbf]">Se borrará todo ahora mismo: adultos, hijos, tareas, puntos, dinero, pantalla, historial, fotos y sesiones. No hay vuelta atrás.</p>
        <Field label="Tu contraseña">{(id) => <input id={id} className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Field label={`Escribe ${ERASE_PHRASE}`} hint="Así sabemos que no ha sido un toque sin querer.">{(id) => <input id={id} className="field" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/** Borrar a un hijo: su cuenta, movimientos, avisos y fotos. Pide la contraseña del adulto. */
export function EraseChildSheet({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const erase = useMutation({
    mutationFn: () => post(`/members/${id}/delete`, { password }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Borrar los datos de ${name}`}
      footer={<Button variant="danger" className="w-full" loading={erase.isPending} disabled={!password} onClick={() => erase.mutate()}>Borrar a {name} para siempre</Button>}
    >
      <div className="space-y-4">
        <p className="rounded-2xl bg-berry-soft p-3 text-sm font-bold text-berry-deep dark:bg-berry/20 dark:text-[#ff9dbf]">Se borran su cuenta, sus tareas, puntos, dinero, minutos de pantalla, avisos, fotos y su rastro en el historial. No se puede deshacer. Si solo quieres que no entre, mejor desactiva su cuenta.</p>
        <Field label="Tu contraseña">{(fid) => <input id={fid} className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}
