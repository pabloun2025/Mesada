import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Button, Field, PageHeader, useToast } from '../components/ui';
import { AvatarPicker } from './Family';

export default function Profile() {
  const { user } = useSession();
  const [look, setLook] = useState({ avatar: user.avatar, color: user.color });
  const [pw, setPw] = useState({ current: '', next: '' });
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const saveLook = useMutation({ mutationFn: () => patch('/me', look), onSuccess: () => { toast('Perfil guardado'); invalidate(); } });
  const savePw = useMutation({
    mutationFn: () => post('/me/password', pw),
    onSuccess: () => { toast('Contraseña cambiada'); setPw({ current: '', next: '' }); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const child = user.role === 'child';
  return (
    <div className="max-w-xl">
      <PageHeader title="Mi perfil" subtitle={`@${user.username}`} />
      <section className="panel mb-6 space-y-4 p-5">
        <h2 className="text-lg font-bold">Tu avatar</h2>
        <AvatarPicker name={user.display_name} avatar={look.avatar} colorKey={look.color} onChange={(a, c) => setLook({ avatar: a, color: c })} />
        <Button loading={saveLook.isPending} onClick={() => saveLook.mutate()}>Guardar</Button>
      </section>
      <section className="panel space-y-4 p-5">
        <h2 className="text-lg font-bold">{child ? 'Cambiar PIN' : 'Cambiar contraseña'}</h2>
        <Field label={child ? 'PIN actual' : 'Contraseña actual'}>{(id) => <input id={id} className="field" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
        <Field label={child ? 'PIN nuevo' : 'Contraseña nueva'} hint={child ? 'Mínimo 4 caracteres.' : 'Mínimo 8 caracteres.'}>{(id) => <input id={id} className="field" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
        <Button variant="secondary" loading={savePw.isPending} onClick={() => savePw.mutate()}>Cambiar</Button>
      </section>
    </div>
  );
}
