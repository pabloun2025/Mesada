import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Markdown } from '../legal/Markdown';
import { LEGAL_TEXTS, type LegalDoc } from '../legal/content';
import { LEGAL_LINKS, LegalLinks } from '../components/LegalLinks';

/** Páginas públicas (sin sesión): política de privacidad, aviso legal y condiciones. */
export default function Legal({ doc }: { doc: LegalDoc }) {
  const meta = LEGAL_LINKS.find((l) => l.doc === doc)!;
  useEffect(() => {
    const prev = document.title;
    document.title = `${meta.title} · DiploP`;
    window.scrollTo(0, 0);
    return () => { document.title = prev; };
  }, [meta.title]);
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <Link to="/" aria-label="DiploP, ir al inicio">
          <img src="/brand/logo.png" alt="" width={120} height={48} className="h-9 w-auto dark:hidden" />
          <img src="/brand/logo-white.png" alt="" width={120} height={48} className="hidden h-9 w-auto dark:block" />
        </Link>
        <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 font-bold text-[var(--fg-2)] hover:bg-[var(--chip)]"><ArrowLeft size={18} aria-hidden /> Volver</Link>
      </header>
      <main id="contenido" className="mx-auto max-w-3xl px-[max(1rem,env(safe-area-inset-left))] pt-4 pb-16">
        <article className="panel p-5 sm:p-8"><Markdown source={LEGAL_TEXTS[doc]} /></article>
        <LegalLinks className="mt-6 justify-center" />
      </main>
    </div>
  );
}
