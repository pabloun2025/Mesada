import { useQuery } from '@tanstack/react-query';
import { CalendarClock, PauseCircle, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { dayKey, fmtDate } from '../lib/format';
import { minutesHM } from '../lib/deadline';
import { useSession } from '../lib/session';
import type { ScreenView } from '../lib/types';

/** «el lunes» si caduca esta semana, «el lunes 15 dic» si queda más lejos. */
export function expiryPhrase(iso: string, tz: string, full = false) {
  const day = dayKey(iso, tz);
  const left = (new Date(`${day}T12:00:00`).getTime() - Date.now()) / 86_400_000;
  const long = fmtDate(day, { weekday: 'long', day: 'numeric', month: 'short' }).replace(',', '');
  return !full && left < 7 ? `el ${long.split(' ')[0]}` : `el ${long}`;
}

/** Saldo de pantalla del hijo con su desglose: plan de la semana y ganados, y la pausa si la hay. */
export function ScreenBalance({ userId, view }: { userId: string; view?: ScreenView }) {
  const { family } = useSession();
  const q = useQuery({ queryKey: ['screen', userId], queryFn: () => api<ScreenView>(`/screen/${userId}`), enabled: !view });
  const v = view ?? q.data;
  if (!v) return null;
  const { plan, earned } = v.buckets;
  return (
    <div>
      <p className="mb-1 text-sm font-bold muted">Te quedan</p>
      <p className="num text-3xl font-extrabold" data-testid="screen-total">{minutesHM(v.balance)}</p>
      <ul className="mt-3 space-y-2" aria-label="Desglose del saldo de pantalla">
        {plan.minutes > 0 || v.plan.enabled ? (
          <li className="flex items-start gap-2.5 rounded-2xl bg-[var(--chip)] px-3 py-2.5 text-sm">
            <CalendarClock size={18} className="mt-0.5 shrink-0 text-tangerine" aria-hidden />
            <span>
              <b>Plan de la semana: <span className="num">{minutesHM(plan.minutes)}</span></b>
              <span className="muted"> · {plan.minutes > 0 && plan.expires_at ? `caduca ${expiryPhrase(plan.expires_at, family.timezone)}` : 'se recarga el lunes'}</span>
            </span>
          </li>
        ) : null}
        {earned.minutes > 0 && earned.first_expires_at ? (
          <li className="flex items-start gap-2.5 rounded-2xl bg-[var(--chip)] px-3 py-2.5 text-sm">
            <Sparkles size={18} className="mt-0.5 shrink-0 text-sun-ink dark:text-sun" aria-hidden />
            <span>
              <b>Ganados: <span className="num">{minutesHM(earned.minutes)}</span></b>
              <span className="muted"> · los primeros caducan {expiryPhrase(earned.first_expires_at, family.timezone, true)}</span>
            </span>
          </li>
        ) : null}
        {v.pause ? (
          <li className="flex items-start gap-2.5 rounded-2xl bg-sun-soft px-3 py-2.5 text-sm text-sun-ink dark:bg-sun/15 dark:text-[#ffd979]">
            <PauseCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
            <span><b>{v.pause.label}</b> · {v.pause.reason}. Tus minutos no caducan mientras tanto.</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
