import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';

/* ---------- Colores y avatares de miembros ---------- */

export const MEMBER_COLORS: Record<string, { bg: string; soft: string; fg: string }> = {
  tangerine: { bg: '#F26B1D', soft: '#FFE3D1', fg: '#7A3108' },
  leaf: { bg: '#1E9E6A', soft: '#D4F2E3', fg: '#0B5235' },
  sky: { bg: '#4F8DF7', soft: '#DCE8FF', fg: '#163D85' },
  indigo: { bg: '#5B5BD6', soft: '#E3E3FB', fg: '#2A2A85' },
  berry: { bg: '#D6336C', soft: '#FBDDE7', fg: '#7A1238' },
  sun: { bg: '#E0A10E', soft: '#FFF0C7', fg: '#6B4A00' },
  teal: { bg: '#138A8A', soft: '#D2F0F0', fg: '#064848' },
  slate: { bg: '#52607D', soft: '#E1E6EF', fg: '#1F2A44' },
};

export const AVATARS: Record<string, string> = {
  fox: '🦊', cat: '🐱', owl: '🦉', bear: '🐻', panda: '🐼', tiger: '🐯', frog: '🐸', octopus: '🐙',
  rocket: '🚀', bolt: '⚡', star: '⭐', planet: '🪐', guitar: '🎸', ball: '⚽', controller: '🎮', palette: '🎨',
};

export function color(c?: string | null) {
  return MEMBER_COLORS[c ?? ''] ?? MEMBER_COLORS.slate;
}

export function Avatar({ name, avatar, colorKey, size = 40, ring = false }: { name: string; avatar?: string | null; colorKey?: string | null; size?: number; ring?: boolean }) {
  const c = color(colorKey);
  const emoji = avatar ? AVATARS[avatar] : undefined;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold select-none"
      style={{
        width: size,
        height: size,
        background: c.soft,
        color: c.fg,
        fontSize: emoji ? size * 0.52 : size * 0.42,
        boxShadow: ring ? `0 0 0 2.5px var(--card), 0 0 0 5px ${c.bg}` : undefined,
      }}
    >
      {emoji ?? name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ---------- Botones ---------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sun text-ink hover:bg-sun-deep shadow-[0_6px_16px_-8px_rgb(227_162_0/0.9)]',
  secondary: 'bg-[var(--chip)] text-[var(--fg)] hover:brightness-95 dark:hover:brightness-125',
  ghost: 'text-[var(--fg-2)] hover:bg-[var(--chip)]',
  danger: 'bg-berry-soft text-berry-deep hover:brightness-95 dark:bg-berry/20 dark:text-[#ff9dbf]',
  success: 'bg-leaf-deep text-white hover:bg-[#0f6341]',
};

/** Clases de botón para enlaces (<Link>) con el mismo aspecto que <Button>. */
export const buttonClass = (variant: Variant = 'primary', size: 'sm' | 'md' | 'lg' = 'md') =>
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-bold transition active:scale-[0.97] ${({ sm: 'h-11 px-4 text-sm', md: 'h-11 px-5', lg: 'h-13 px-6 text-lg' })[size]} ${VARIANTS[variant]}`;

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sizes = { sm: 'h-11 px-4 text-sm', md: 'h-11 px-5', lg: 'h-13 px-6 text-lg' };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-bold transition active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none ${sizes[size]} ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--fg-2)] transition hover:bg-[var(--chip)] active:scale-95 ${className}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} role="status" aria-label="Cargando" />;
}

/* ---------- Píldoras y etiquetas ---------- */

export function PointsPill({ points, tone = 'tangerine', sign = true, star = false }: { points: number; tone?: 'tangerine' | 'leaf' | 'muted'; sign?: boolean; star?: boolean }) {
  const tones = {
    tangerine: 'bg-sun-soft text-sun-ink dark:bg-sun/20 dark:text-[#ffd979]',
    leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
    muted: 'bg-[var(--chip)] text-[var(--fg-3)]',
  };
  return <span className={`num inline-flex h-7 items-center rounded-full px-2.5 text-sm font-bold ${tones[tone]}`}>{sign && points > 0 ? '+' : ''}{points}{star ? <span aria-hidden className="ml-0.5">★</span> : null}</span>;
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'sky' | 'sun' | 'berry' | 'leaf' | 'tangerine' }) {
  const tones = {
    muted: 'bg-[var(--chip)] text-[var(--fg-2)]',
    sky: 'bg-sky-soft text-[#1d4fb0] dark:bg-sky/20 dark:text-[#a9c7ff]',
    sun: 'bg-sun-soft text-[#7a5600] dark:bg-sun/20 dark:text-[#ffd979]',
    berry: 'bg-berry-soft text-berry-deep dark:bg-berry/20 dark:text-[#ff9dbf]',
    leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
    tangerine: 'bg-tangerine-soft text-tangerine-deep dark:bg-tangerine/20',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

/* ---------- Formularios ---------- */

/**
 * Campo con etiqueta, pista y error. La pista y el error se enlazan con el control mediante `aria-describedby`
 * (y `aria-invalid` si hay error) para que los lectores de pantalla los lean junto al campo. Se hace sobre el control
 * que recibe el `id`, así vale para cualquier `input`, `select` o `textarea` sin tocar cada formulario.
 */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  const noteId = `${id}-note`;
  const box = useRef<HTMLDivElement>(null);
  const hasNote = !!(error || hint);
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (!el) return;
    if (hasNote) el.setAttribute('aria-describedby', noteId); else el.removeAttribute('aria-describedby');
    if (error) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  });
  return (
    <div ref={box} className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-bold text-[var(--fg-2)]">{label}</label>
      {children(id)}
      {error ? <p id={noteId} role="alert" className="text-sm font-bold text-berry-deep dark:text-[#ff9dbf]">{error}</p> : hint ? <p id={noteId} className="text-sm muted">{hint}</p> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-[var(--chip)] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-11 rounded-full px-4 text-sm font-bold transition ${value === o.value ? 'bg-[var(--card)] text-[var(--fg)] shadow-[var(--shadow-press)]' : 'text-[var(--fg-3)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block font-bold">{label}</span>
        {description ? <span className="block text-sm muted">{description}</span> : null}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-7 w-12 rounded-full bg-[var(--line)] transition peer-checked:bg-leaf peer-focus-visible:outline-3 peer-focus-visible:outline-sky" />
        <span className="absolute top-1 left-1 size-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** Bloque plegable (nativo, accesible) para agrupar opciones avanzadas sin recargar el formulario. */
export function Disclosure({ title, summary, defaultOpen = false, children }: { title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-2xl border border-[var(--line)]">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-2.5 font-bold [&::-webkit-details-marker]:hidden">
        <span>{title}{summary ? <span className="block text-sm font-normal muted">{summary}</span> : null}</span>
        <ChevronDown size={20} aria-hidden className="shrink-0 text-[var(--fg-3)] transition group-open:rotate-180" />
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-4">{children}</div>
    </details>
  );
}

/* ---------- Hoja modal (abajo en móvil, centrada en escritorio) ---------- */

export function Sheet({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none bg-transparent p-0 backdrop:bg-[#0c1428]/55 backdrop:backdrop-blur-[2px] sm:m-auto sm:max-w-lg"
    >
      {open ? (
        <div className="anim-sheet flex max-h-[92dvh] flex-col rounded-t-[var(--radius-panel)] bg-[var(--card)] text-[var(--fg)] sm:rounded-[var(--radius-panel)]">
          <div aria-hidden className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-full bg-[var(--line)] sm:hidden" />
          <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-3 sm:pt-5">
            <div className="min-w-0">
              <h2 className="text-xl font-bold">{title}</h2>
              {subtitle ? <p className="text-sm text-[var(--fg-2)]">{subtitle}</p> : null}
            </div>
            <IconButton label="Cerrar" onClick={onClose} className="bg-[var(--chip)]"><X size={20} /></IconButton>
          </div>
          <div className={`overflow-y-auto overscroll-contain px-5 ${footer ? 'pb-5' : 'pb-[max(1.25rem,env(safe-area-inset-bottom))]'}`}>{children}</div>
          {footer ? <div className="safe-bottom border-t border-[var(--line)] px-5 py-4">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/* ---------- Avisos (toasts) ---------- */

/** Un aviso puede llevar una acción (p. ej. «Deshacer») y durar más de lo normal. */
export type ToastOpts = { action?: { label: string; onClick: () => void }; ms?: number };
type Toast = { id: number; text: string; tone: 'ok' | 'error'; action?: ToastOpts['action'] };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error', opts?: ToastOpts) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok', opts: ToastOpts = {}) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone, action: opts.action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms ?? 3800);
  }, []);
  const close = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`anim-sheet pointer-events-auto flex max-w-md items-center gap-2 rounded-2xl py-2 pr-2 pl-4 font-bold shadow-[var(--shadow-lift)] ${t.action ? '' : 'py-3 pr-4'} ${t.tone === 'ok' ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-berry text-white'}`}
          >
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => { t.action!.onClick(); close(t.id); }}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-white/15 px-4 underline underline-offset-4 hover:bg-white/25 dark:bg-ink/10 dark:hover:bg-ink/20"
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Estados ---------- */

/** Estado vacío. Con `mascot`, aparece el osito de DiploP en lugar del icono (momentos de «todo hecho» o bienvenida). */
export function Empty({ icon, title, children, mascot }: { icon: ReactNode; title: string; children?: ReactNode; mascot?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {mascot ? (
        <img src="/brand/mascot.png" alt="" width={88} height={88} className="mb-1 size-22 -rotate-3 drop-shadow-[0_10px_18px_rgb(20_42_92/0.25)]" />
      ) : (
        <div className="mb-1 flex size-14 items-center justify-center rounded-2xl bg-[var(--chip)] text-2xl text-[var(--fg-3)]">{icon}</div>
      )}
      <p className="font-display text-lg font-bold">{title}</p>
      {children ? <div className="max-w-sm muted">{children}</div> : null}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex justify-center py-16 text-[var(--fg-3)]">
      <Spinner className="size-6" />
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div>
        <h1 className="text-[1.75rem] font-extrabold sm:text-[2rem]">{title}</h1>
        {subtitle ? <p className="mt-1 muted">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-bold">{children}</h2>
      {action}
    </div>
  );
}
