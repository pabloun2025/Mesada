import { Link } from 'react-router-dom';
import { Check, ClipboardList, Coins, Flame, Gift, Landmark, PiggyBank, ShieldCheck, Star, Target, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonClass } from '../components/ui';
import { HeroImage } from './AuthShell';

const STEPS = [
  { icon: ClipboardList, title: 'Tareas', text: 'Los padres reparten las tareas de casa y cada hijo ve las suyas.' },
  { icon: Star, title: 'Puntos', text: 'Al hacerlas y validarlas, los hijos ganan puntos.' },
  { icon: Wallet, title: 'Dinero o premios', text: 'Los puntos se cambian por euros de mesada o por recompensas.' },
];

const PARENTS = [
  { icon: ShieldCheck, title: 'Validar tareas', text: 'Aprueban con un toque, dan solo una parte del premio o piden que la arreglen.' },
  { icon: Coins, title: 'Mesada con tope', text: 'Fijan cuánto vale cada punto y un máximo semanal o mensual.' },
  { icon: Landmark, title: 'Banco familiar', text: 'Saldo de cada hijo, retiros, adelantos, préstamos y ahorro con interés.' },
];

const KIDS = [
  { icon: Star, title: 'Puntos', text: 'Cada tarea suma y se ve cuánto vale en euros.' },
  { icon: Flame, title: 'Rachas', text: 'Los días seguidos haciendo tareas dan insignias.' },
  { icon: PiggyBank, title: 'Metas de ahorro', text: 'Ahorran para algo que quieren y ganan interés.' },
  { icon: Gift, title: 'Recompensas', text: 'Cambian puntos por premios que eligen los padres.' },
];

function Cta({ canRegister, where }: { canRegister: boolean; where: 'top' | 'bottom' }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5" data-cta={where}>
      <Link to="/entrar" className={buttonClass('primary')}>Entrar</Link>
      {canRegister ? <Link to="/configurar" className={buttonClass('secondary')}>Crear familia</Link> : null}
    </div>
  );
}

function Card({ icon: Icon, title, children }: { icon: typeof Check; title: string; children: ReactNode }) {
  return (
    <li className="card flex gap-3.5 p-4">
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-sun-soft text-sun-ink"><Icon size={22} /></span>
      <div className="min-w-0">
        <h3 className="text-lg font-extrabold">{title}</h3>
        <p className="mt-0.5 muted">{children}</p>
      </div>
    </li>
  );
}

/** Página pública de bienvenida: qué es DiploP, antes de entrar o crear la familia. */
export function Welcome({ canRegister }: { canRegister: boolean }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <img src="/brand/logo.png" alt="DiploP" width={120} height={48} className="h-9 w-auto" />
        <Cta canRegister={canRegister} where="top" />
      </header>

      <HeroImage className="md:rounded-[var(--radius-panel)] md:max-w-5xl md:mx-auto" />

      <main className="mx-auto max-w-5xl px-4 pb-12">
        <section className="py-8 text-center md:py-12">
          <h1 className="mx-auto max-w-2xl text-3xl font-extrabold sm:text-4xl">Tareas de casa, puntos y mesada para toda la familia</h1>
          <p className="mx-auto mt-3 max-w-xl text-lg muted">Los hijos ganan puntos haciendo tareas, los padres las validan y los puntos se convierten en dinero o en premios.</p>
        </section>

        <section aria-labelledby="como" className="mb-10">
          <h2 id="como" className="mb-4 text-2xl font-extrabold">Cómo funciona</h2>
          <ol className="grid gap-3 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card relative p-4">
                <span className="num absolute top-3 right-4 text-3xl font-extrabold text-[var(--fg-3)]/40" aria-hidden>{i + 1}</span>
                <span aria-hidden className="mb-3 flex size-11 items-center justify-center rounded-[var(--radius-tile)] bg-leaf-soft text-leaf-deep dark:bg-leaf/20"><s.icon size={22} /></span>
                <h3 className="text-lg font-extrabold"><span className="sr-only">Paso {i + 1}: </span>{s.title}</h3>
                <p className="mt-1 muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-10 md:grid-cols-2">
          <section aria-labelledby="padres">
            <h2 id="padres" className="mb-4 text-2xl font-extrabold">Para padres</h2>
            <ul className="space-y-3">{PARENTS.map((c) => <Card key={c.title} icon={c.icon} title={c.title}>{c.text}</Card>)}</ul>
          </section>
          <section aria-labelledby="hijos">
            <h2 id="hijos" className="mb-4 text-2xl font-extrabold">Para hijos</h2>
            <ul className="space-y-3">{KIDS.map((c) => <Card key={c.title} icon={c.icon} title={c.title}>{c.text}</Card>)}</ul>
          </section>
        </div>

        <section className="mt-12 rounded-[var(--radius-panel)] bg-[#0b5a97] p-6 text-center text-white">
          <Target size={28} className="mx-auto mb-2 text-sun" aria-hidden />
          <h2 className="text-2xl font-extrabold">Empieza hoy con tu familia</h2>
          <p className="mx-auto mt-1.5 mb-5 max-w-md text-white/85">En unos minutos tienes las primeras tareas repartidas.</p>
          <div className="flex justify-center"><Cta canRegister={canRegister} where="bottom" /></div>
        </section>
      </main>
    </div>
  );
}
