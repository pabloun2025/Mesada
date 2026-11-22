import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, post, put } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Button, Field, PageHeader, Toggle, useToast } from '../components/ui';
import { AvatarPicker } from './Family';
import { kinshipText } from '../lib/kinship';

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
  const [email, setEmail] = useState(user.email ?? '');
  const saveEmail = useMutation({
    mutationFn: () => put('/me/email', { email }),
    onSuccess: () => { toast('Correo guardado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const [wa, setWa] = useState({ phone: user.phone ?? '', consent: !!user.whatsapp_consent_at });
  const saveWa = useMutation({
    mutationFn: () => put(`/notify/contact/${user.id}`, { phone: wa.phone.trim() || null, whatsappConsent: wa.consent && !!wa.phone.trim() }),
    onSuccess: () => { toast('WhatsApp guardado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const child = user.role === 'child';
  const relative = !child && !!user.is_relative;
  const [name, setName] = useState(user.display_name);
  const saveName = useMutation({
    mutationFn: () => patch('/me', { displayName: name }),
    onSuccess: () => { toast('Nombre guardado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const [tel, setTel] = useState(user.phone ?? '');
  const saveTel = useMutation({
    mutationFn: () => patch('/me', { phone: tel.trim() || null }),
    onSuccess: () => { toast('Teléfono guardado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="max-w-xl">
      <PageHeader title="Mi perfil" subtitle={`@${user.username}`} />
      <section className="panel mb-6 space-y-4 p-5">
        <h2 className="text-lg font-bold">Tu avatar</h2>
        <AvatarPicker name={user.display_name} avatar={look.avatar} colorKey={look.color} onChange={(a, c) => setLook({ avatar: a, color: c })} />
        <Button loading={saveLook.isPending} onClick={() => saveLook.mutate()}>Guardar</Button>
      </section>
      {!child ? (
        <section className="panel mb-6 space-y-4 p-5" aria-label="Tus datos">
          <h2 className="text-lg font-bold">Tus datos</h2>
          {kinshipText(user) ? <p className="muted">{kinshipText(user)}{user.is_principal ? ' · cuenta principal de la familia' : relative ? ' · pariente: ves el progreso y animas' : ''}</p> : null}
          <Field label="Nombre">{(id) => <input id={id} className="field" maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button variant="secondary" loading={saveName.isPending} disabled={!name.trim() || name.trim() === user.display_name} onClick={() => saveName.mutate()}>Guardar nombre</Button>
        </section>
      ) : null}
      {!child ? (
        <section className="panel mb-6 space-y-4 p-5">
          <h2 className="text-lg font-bold">Tu correo</h2>
          {!user.email ? <p className="rounded-xl bg-sun-soft px-3 py-2 text-sm font-bold text-[#7a5600] dark:bg-sun/15 dark:text-[#ffd979]">Sin correo no podrás recuperar la contraseña si la olvidas.</p> : null}
          <Field label="Correo">{(id) => <input id={id} className="field" type="email" autoComplete="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button variant="secondary" loading={saveEmail.isPending} onClick={() => saveEmail.mutate()}>Guardar correo</Button>
        </section>
      ) : null}
      {relative ? (
        <section className="panel mb-6 space-y-4 p-5">
          <h2 className="text-lg font-bold">Tu teléfono</h2>
          <Field label="Teléfono móvil" hint="Con prefijo si no es de España, por ejemplo +52 55 1234 5678.">{(id) => <input id={id} className="field" type="tel" inputMode="tel" autoComplete="tel" placeholder="600 11 22 33" value={tel} onChange={(e) => setTel(e.target.value)} />}</Field>
          <Button variant="secondary" loading={saveTel.isPending} onClick={() => saveTel.mutate()}>Guardar teléfono</Button>
        </section>
      ) : null}
      {!child && !relative ? (
        <section className="panel mb-6 space-y-4 p-5">
          <h2 className="text-lg font-bold">Tu WhatsApp</h2>
          <p className="muted">Aquí te llegan las tareas para validar y las peticiones de premios.</p>
          {!user.phone ? <p className="rounded-xl bg-sun-soft px-3 py-2 text-sm font-bold text-[#7a5600] dark:bg-sun/15 dark:text-[#ffd979]">Sin teléfono no recibirás avisos por WhatsApp.</p> : null}
          <Field label="Teléfono móvil" hint="Con prefijo si no es de España, por ejemplo +52 55 1234 5678.">{(id) => <input id={id} className="field" type="tel" inputMode="tel" autoComplete="tel" placeholder="600 11 22 33" value={wa.phone} onChange={(e) => setWa({ ...wa, phone: e.target.value })} />}</Field>
          <Toggle checked={wa.consent} onChange={(v) => setWa({ ...wa, consent: v })} label="Recibir avisos por WhatsApp" description="Puedes desactivarlo cuando quieras." />
          <Button variant="secondary" loading={saveWa.isPending} onClick={() => saveWa.mutate()}>Guardar WhatsApp</Button>
        </section>
      ) : user.phone ? (
        <p className="panel mb-6 p-5 muted">Tus avisos llegan al WhatsApp que pusieron tus padres. Si cambias de número, díselo a ellos.</p>
      ) : null}
      <section className="panel space-y-4 p-5">
        <h2 className="text-lg font-bold">{child ? 'Cambiar PIN' : 'Cambiar contraseña'}</h2>
        <Field label={child ? 'PIN actual' : 'Contraseña actual'}>{(id) => <input id={id} className="field" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
        <Field label={child ? 'PIN nuevo' : 'Contraseña nueva'} hint={child ? 'Mínimo 4 caracteres.' : 'Mínimo 8 caracteres.'}>{(id) => <input id={id} className="field" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
        <Button variant="secondary" loading={savePw.isPending} onClick={() => savePw.mutate()}>Cambiar</Button>
      </section>
    </div>
  );
}
