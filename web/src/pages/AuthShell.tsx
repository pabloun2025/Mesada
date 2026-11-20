import type { ReactNode } from 'react';
import { WeekRing } from '../components/Ring';

/** Marco de las pantallas de acceso: bloque de marca en marino + formulario. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative flex flex-col justify-between overflow-hidden bg-ink px-6 pt-8 pb-10 text-white lg:px-14 lg:py-14">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" width={40} height={40} className="size-10 rounded-xl ring-1 ring-white/15" />
          <span className="font-display text-2xl font-extrabold">Mesada</span>
        </div>
        <div className="mt-8 hidden lg:block">
          <p className="font-display max-w-md text-[2.75rem] leading-[1.02] font-extrabold tracking-tight">
            Las tareas de casa suman. La paga, también.
          </p>
          <p className="mt-4 max-w-sm text-lg text-white/70">Cada tarea hecha da puntos; cada semana, los puntos se convierten en euros.</p>
        </div>
        <div className="pointer-events-none absolute -right-16 -bottom-16 hidden opacity-95 lg:block [--card:#172A54] [--chip:#22386b] [--line:#2b4378] [--fg-3:#a9b6d6]">
          <WeekRing points={135} goal={180} cents={675} size={360} />
        </div>
        <p className="mt-2 text-white/70 lg:hidden">Tareas, puntos y paga en familia.</p>
      </section>
      <section className="flex items-start justify-center px-5 py-10 lg:items-center">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-extrabold">{title}</h1>
          <p className="mt-1.5 mb-7 muted">{subtitle}</p>
          {children}
        </div>
      </section>
    </div>
  );
}
