import type { ReactNode } from 'react';

const ALT = 'DiploP: una familia sonriente con su osito; el logotipo y la tarjeta «Mi mesada»';

/**
 * Marco de las pantallas de acceso con la imagen «cielo» de DiploP.
 * Móvil: imagen vertical (familia arriba, logotipo debajo) y el formulario encima de un cielo claro.
 * Tableta y escritorio: imagen apaisada a todo el ancho y el formulario centrado debajo.
 */
export function HeroImage({ className = '', priority = true }: { className?: string; priority?: boolean }) {
  return (
    <picture>
      <source media="(min-width: 768px)" srcSet="/brand/hero-sky-wide.webp" width={1600} height={900} />
      <img
        src="/brand/hero-sky-tall.webp"
        alt={ALT}
        width={900}
        height={1809}
        className={`block w-full bg-[#cde5f8] object-cover object-top aspect-[900/1180] md:aspect-[16/9] md:max-h-[34rem] md:object-[50%_22%] ${className}`}
        fetchPriority={priority ? 'high' : undefined}
      />
    </picture>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <section className="relative overflow-hidden bg-[#cde5f8]">
        <HeroImage />
      </section>
      <section className="relative -mt-8 flex justify-center rounded-t-[1.75rem] bg-[var(--bg)] px-5 pt-8 pb-10 md:-mt-10">
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
