import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

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
  danger: 'bg-berry-soft text-berry hover:brightness-95 dark:bg-berry/20',
  success: 'bg-leaf text-white hover:bg-leaf-deep',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sizes = { sm: 'h-9 px-3.5 text-sm', md: 'h-11 px-5', lg: 'h-13 px-6 text-lg' };
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
      className={`inline-flex size-10 items-center justify-center rounded-full text-[var(--fg-2)] transition hover:bg-[var(--chip)] active:scale-95 ${className}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} role="status" aria-label="Cargando" />;
}

/* ---------- Píldoras y etiquetas ---------- */

export function PointsPill({ points, tone = 'tangerine', sign = true }: { points: number; tone?: 'tangerine' | 'leaf' | 'muted'; sign?: boolean }) {
  const tones = {
    tangerine: 'bg-sun-soft text-sun-ink dark:bg-sun/20 dark:text-[#ffd979]',
    leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
    muted: 'bg-[var(--chip)] text-[var(--fg-3)]',
  };
  return <span className={`num inline-flex h-7 items-center rounded-full px-2.5 text-sm font-bold ${tones[tone]}`}>{sign && points > 0 ? '+' : ''}{points}</span>;
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'sky' | 'sun' | 'berry' | 'leaf' | 'tangerine' }) {
  const tones = {
    muted: 'bg-[var(--chip)] text-[var(--fg-2)]',
    sky: 'bg-sky-soft text-[#1d4fb0] dark:bg-sky/20 dark:text-[#a9c7ff]',
    sun: 'bg-sun-soft text-[#7a5600] dark:bg-sun/20 dark:text-[#ffd979]',
    berry: 'bg-berry-soft text-berry dark:bg-berry/20 dark:text-[#ff9dbf]',
    leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
    tangerine: 'bg-tangerine-soft text-tangerine-deep dark:bg-tangerine/20',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

/* ---------- Formularios ---------- */

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-bold text-[var(--fg-2)]">{label}</label>
      {children(id)}
      {error ? <p className="text-sm text-berry">{error}</p> : hint ? <p className="text-sm muted">{hint}</p> : null}
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
          className={`h-9 rounded-full px-4 text-sm font-bold transition ${value === o.value ? 'bg-[var(--card)] text-[var(--fg)] shadow-[var(--shadow-press)]' : 'text-[var(--fg-3)]'}`}
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
        <span aria-hidden className="text-[var(--fg-3)] transition group-open:rotate-180">⌄</span>
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-4">{children}</div>
    </details>
  );
}

/* ---------- Hoja modal (abajo en móvil, centrada en escritorio) ---------- */

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
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
          <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
            <h2 className="text-xl font-bold">{title}</h2>
            <IconButton label="Cerrar" onClick={onClose}><X size={20} /></IconButton>
          </div>
          <div className="overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
          {footer ? <div className="safe-bottom border-t border-[var(--line)] px-5 py-4">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/* ---------- Avisos (toasts) ---------- */

type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`anim-sheet pointer-events-auto max-w-md rounded-2xl px-4 py-3 font-bold shadow-[var(--shadow-lift)] ${t.tone === 'ok' ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-berry text-white'}`}
          >
            {t.text}
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
