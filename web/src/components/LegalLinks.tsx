import { Link } from 'react-router-dom';
import type { LegalDoc } from '../legal/content';

export const LEGAL_LINKS: { doc: LegalDoc; to: string; label: string; title: string }[] = [
  { doc: 'privacidad', to: '/privacidad', label: 'Privacidad', title: 'Política de privacidad' },
  { doc: 'aviso-legal', to: '/aviso-legal', label: 'Aviso legal', title: 'Aviso legal' },
  { doc: 'condiciones', to: '/condiciones', label: 'Condiciones', title: 'Condiciones de uso' },
];

/** Enlaces a los tres textos legales (pie de la bienvenida, del acceso y de «Más»). */
export function LegalLinks({ className = '', onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Información legal" className={`flex flex-wrap items-center gap-x-1 ${className}`}>
      {LEGAL_LINKS.map((l) => (
        <Link key={l.doc} to={l.to} onClick={onNavigate} className="inline-flex min-h-11 items-center px-2 text-sm font-bold text-[var(--fg-2)] underline underline-offset-2 hover:text-[var(--fg)]">{l.label}</Link>
      ))}
    </nav>
  );
}

