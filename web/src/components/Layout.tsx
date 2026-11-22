import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BellRing, CalendarCheck, ChartColumn, CircleCheckBig, Gift, Hammer, House, ListChecks, LogOut, Menu, Moon, PiggyBank, Settings, ShieldCheck, Sun, Trophy, User, Users, History,
} from 'lucide-react';
import { api, ApiError, post } from '../lib/api';
import { useLogout, useSession } from '../lib/session';
import { relative } from '../lib/format';
import { Avatar, Empty, IconButton, Sheet } from './ui';
import { RevealModal } from './RevealModal';
import { ErrorBoundary } from './ErrorBoundary';
import { LegalLinks } from './LegalLinks';

type NavItem = { to: string; label: string; icon: ReactNode; badge?: number; end?: boolean };

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('mesada:theme', next ? 'dark' : 'light');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', next ? '#15213d' : '#cde5f8');
  };
  return { dark, toggle };
}

/** Aviso fijo si alguna consulta falla (sin conexión o error del servidor), con reintento. */
function ConnectionBanner() {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const failed = useSyncExternalStore(
    (cb) => cache.subscribe(cb),
    () => cache.findAll({ predicate: (q) => q.state.status === 'error' && q.state.fetchStatus === 'idle' }).length,
  );
  if (!failed) return null;
  // Si el servidor dio un código de error, se enseña para poder dictarlo.
  const errorId = cache.findAll({ predicate: (q) => q.state.status === 'error' && q.state.error instanceof ApiError && !!q.state.error.errorId })
    .map((q) => (q.state.error as ApiError).errorId)[0];
  return (
    <div role="alert" className="mx-auto mb-4 flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-berry-soft px-4 py-2 text-sm font-bold text-berry-deep dark:bg-berry/20">
      <span className="min-w-0 flex-1">
        {errorId ? <>Algo ha fallado en el servidor. Si sigue pasando, indica este código: <span className="num select-all">{errorId}</span>.</> : 'No se han podido cargar algunos datos. Revisa la conexión.'}
      </span>
      <button type="button" className="min-h-11 rounded-full px-3 underline underline-offset-2" onClick={() => qc.refetchQueries({ predicate: (q) => q.state.status === 'error' })}>Reintentar</button>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications'), refetchInterval: 60_000 });
  const markRead = useMutation({ mutationFn: () => post('/notifications/read'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread: number = data?.unread ?? 0;
  return (
    <>
      <IconButton label={unread ? `Avisos (${unread} sin leer)` : 'Avisos'} onClick={() => setOpen(true)} className="relative">
        <Bell size={20} />
        {unread ? <span className="num absolute top-1 right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-sun px-1 text-[11px] font-bold text-ink ring-2 ring-[var(--bg)]">{unread > 9 ? '9+' : unread}</span> : null}
      </IconButton>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          if (unread) markRead.mutate();
        }}
        title="Avisos"
      >
        {data?.notifications?.length ? (
          <ul className="divide-y divide-[var(--line)]">
            {data.notifications.map((n: any) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 py-3 text-left"
                  onClick={() => {
                    setOpen(false);
                    if (unread) markRead.mutate();
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className={`mt-2 size-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : 'bg-sun'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">{n.title}</span>
                    {n.body ? <span className="block text-sm muted">{n.body}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs muted">{relative(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<Bell />} title="Sin avisos">Aquí verás recordatorios, aprobaciones y pagos.</Empty>
        )}
      </Sheet>
    </>
  );
}

function MoreSheet({ open, onClose, items }: { open: boolean; onClose: () => void; items: NavItem[] }) {
  return (
    <Sheet open={open} onClose={onClose} title="Más opciones">
      <nav className="grid grid-cols-2 gap-2.5">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} onClick={onClose} className="card flex items-center gap-3 p-4 font-bold">
            <span className="text-tangerine">{i.icon}</span>
            {i.label}
          </NavLink>
        ))}
      </nav>
      <LegalLinks className="mt-3 justify-center" onNavigate={onClose} />
    </Sheet>
  );
}

export function Layout() {
  const { user, family } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const [more, setMore] = useState(false);
  const isAdult = user.role === 'adult';

  const { data: dash } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard'), enabled: isAdult, refetchInterval: 60_000 });
  const pendingCount = (dash?.pendingApprovals?.length ?? 0) + (dash?.pendingRedemptions ?? 0) + (dash?.pendingChecks ?? 0) + (dash?.pendingGrants ?? 0) + (dash?.pendingRequests ?? 0) + (dash?.pendingUsage ?? 0) + (dash?.pendingBank ?? 0);

  const primary: NavItem[] = isAdult
    ? [
        { to: '/', label: 'Panel', icon: <House size={22} />, end: true },
        { to: '/validar', label: 'Validar', icon: <CircleCheckBig size={22} />, badge: pendingCount },
        { to: '/tareas', label: 'Tareas', icon: <ListChecks size={22} /> },
        { to: '/mesada', label: 'Mesada', icon: <PiggyBank size={22} /> },
      ]
    : [
        { to: '/', label: 'Hoy', icon: <CalendarCheck size={22} />, end: true },
        { to: '/progreso', label: 'Progreso', icon: <Trophy size={22} /> },
        { to: '/premios', label: 'Premios', icon: <Gift size={22} /> },
        { to: '/mesada', label: 'Mi banco', icon: <PiggyBank size={22} /> },
      ];
  const secondary: NavItem[] = isAdult
    ? [
        { to: '/extras', label: 'Trabajos extra', icon: <Hammer size={20} /> },
        { to: '/premios', label: 'Recompensas', icon: <Gift size={20} /> },
        { to: '/familia', label: 'Familia', icon: <Users size={20} /> },
        { to: '/estadisticas', label: 'Estadísticas', icon: <ChartColumn size={20} /> },
        { to: '/actividad', label: 'Historial', icon: <History size={20} /> },
        { to: '/avisos', label: 'Avisos', icon: <BellRing size={20} /> },
        { to: '/ajustes', label: 'Ajustes', icon: <Settings size={20} /> },
        { to: '/perfil', label: 'Mi perfil', icon: <User size={20} /> },
        ...(user.is_superadmin ? [{ to: '/administracion', label: 'Administración', icon: <ShieldCheck size={20} /> }] : []),
      ]
    : [
        { to: '/extras', label: 'Trabajos extra', icon: <Hammer size={20} /> },
        { to: '/perfil', label: 'Mi perfil', icon: <User size={20} /> },
        { to: '/avisos', label: 'Mis avisos', icon: <BellRing size={20} /> },
      ];

  const doLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <a href="#contenido" className="sr-only z-50 rounded-full bg-ink px-4 py-2 font-bold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Saltar al contenido</a>
      {/* Raíl lateral (escritorio) */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-[var(--line)] bg-[var(--card)] px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:flex">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <img src="/brand/logo.png" alt="DiploP" width={120} height={58} className="h-12 w-auto dark:hidden" />
          <img src="/brand/logo-white.png" alt="DiploP" width={120} height={58} className="hidden h-12 w-auto dark:block" />
          <p className="mt-3 self-end text-sm muted">{family.name}</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Principal">
          {[...primary, ...secondary].map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              className={({ isActive }) =>
                `flex h-11 items-center gap-3 rounded-full px-4 font-bold transition ${isActive ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'text-[var(--fg-2)] hover:bg-[var(--chip)]'}`
              }
            >
              {i.icon}
              <span className="flex-1">{i.label}</span>
              {i.badge ? <span className="num rounded-full bg-sun px-2 text-sm text-ink">{i.badge}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3 rounded-2xl bg-[var(--chip)] p-3">
          <Avatar name={user.display_name} avatar={user.avatar} colorKey={user.color} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{user.display_name}</p>
            <p className="text-xs muted">{isAdult ? 'Adulto' : 'Hijo/a'}</p>
          </div>
          <IconButton label="Cerrar sesión" onClick={doLogout}><LogOut size={18} /></IconButton>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        {/* Cabecera */}
        {/* En móvil, la cabecera es la franja azul de la marca; en escritorio, una barra neutra. */}
        <header className="brand-header sticky top-0 z-30 flex items-center gap-0.5 px-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.25rem,env(safe-area-inset-top))] pb-1 min-[360px]:gap-1.5 min-[360px]:px-4 lg:justify-end lg:border-b lg:border-[var(--line)] lg:bg-[var(--bg)]/85 lg:px-8 lg:pt-[max(0.625rem,env(safe-area-inset-top))] lg:pb-2.5 lg:backdrop-blur-md">
          <div className="flex min-w-0 flex-1 items-center gap-2 min-[360px]:gap-3 lg:hidden">
            <img src="/brand/logo.png" alt="DiploP" width={84} height={40} className="h-8 w-auto shrink-0 min-[360px]:h-9 dark:hidden" />
            <img src="/brand/logo-white.png" alt="DiploP" width={84} height={40} className="hidden h-8 w-auto shrink-0 min-[360px]:h-9 dark:block" />
            <div className="min-w-0 border-[var(--line)] leading-tight min-[360px]:border-l min-[360px]:pl-3">
              <p className="truncate font-display font-extrabold"><span className="max-[359px]:hidden">Hola, </span>{user.display_name}</p>
              <p className="truncate text-xs text-[var(--fg-3)] max-[399px]:hidden">{family.name}</p>
            </div>
          </div>
          <IconButton label={theme.dark ? 'Modo claro' : 'Modo oscuro'} onClick={theme.toggle}>{theme.dark ? <Sun size={20} /> : <Moon size={20} />}</IconButton>
          <Notifications />
          <IconButton label="Cerrar sesión" onClick={doLogout} className="lg:hidden"><LogOut size={19} /></IconButton>
        </header>

        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-[max(1rem,env(safe-area-inset-left))] pt-5 pb-[calc(7rem+env(safe-area-inset-bottom))] lg:px-8 lg:pb-12">
          <ConnectionBanner />
          <ErrorBoundary resetKey={location.pathname}><Outlet /></ErrorBoundary>
          {/* En escritorio, los textos legales van al pie (en el móvil están en «Más»). */}
          <LegalLinks className="mt-10 hidden justify-center lg:flex" />
        </main>

        {/* Barra inferior (móvil) */}
        <nav aria-label="Principal" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-[var(--card)]/95 backdrop-blur-md lg:hidden">
          <div className="mx-auto grid max-w-lg grid-cols-5">
            {primary.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.end}
                className={({ isActive }) => `relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-bold ${isActive ? 'text-tangerine' : 'text-[var(--fg-3)]'}`}
              >
                {({ isActive }) => (
                  <>
                    <span className={`flex h-8 w-14 items-center justify-center rounded-full transition ${isActive ? 'bg-tangerine-soft dark:bg-tangerine/20' : ''}`}>{i.icon}</span>
                    {i.label}
                    {i.badge ? <span className="num absolute top-1.5 left-1/2 ml-3 rounded-full bg-sun px-1.5 text-[11px] text-ink">{i.badge}</span> : null}
                  </>
                )}
              </NavLink>
            ))}
            <button type="button" onClick={() => setMore(true)} className="flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-bold text-[var(--fg-3)]">
              <span className="flex h-8 w-14 items-center justify-center"><Menu size={22} /></span>
              Más
            </button>
          </div>
        </nav>
        {!isAdult ? <RevealModal /> : null}
        <MoreSheet open={more} onClose={() => setMore(false)} items={secondary} />
      </div>
    </div>
  );
}
