import type { ReactNode } from 'react';

/**
 * Marco de las pantallas de acceso con la ilustración de la familia DiploP.
 * Móvil: ilustración apaisada arriba (ya trae el logotipo) y formulario debajo.
 * Escritorio: ilustración vertical a la izquierda (también con logotipo) y formulario a la derecha.
 */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(22rem,30rem)_1fr]">
      <section className="brand-field relative overflow-hidden lg:sticky lg:top-0 lg:h-dvh">
        <img
          src="/brand/hero-wide.webp"
          alt="DiploP: una familia con su osito, lista para repartir las tareas de casa"
          width={1046}
          height={508}
          className="block aspect-[1046/508] w-full object-cover lg:hidden"
          fetchPriority="high"
        />
        <img
          src="/brand/hero-tall.webp"
          alt="DiploP: una familia con su osito, lista para repartir las tareas de casa"
          width={446}
          height={948}
          className="hidden h-full w-full object-cover object-top lg:block"
        />
      </section>
      <section className="relative -mt-5 flex justify-center rounded-t-[1.75rem] bg-[var(--bg)] px-5 pt-8 pb-10 lg:mt-0 lg:items-center lg:rounded-none lg:px-10">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-extrabold">{title}</h1>
          <p className="mt-1.5 mb-7 muted">{subtitle}</p>
          {children}
          <p className="mt-10 text-sm muted">Tareas de casa, puntos y mesada para toda la familia.</p>
        </div>
      </section>
    </div>
  );
}
