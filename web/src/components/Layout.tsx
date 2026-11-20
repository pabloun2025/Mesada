import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, CalendarCheck, ChartColumn, CircleCheckBig, Gift, House, ListChecks, LogOut, Menu, Moon, PiggyBank, Settings, Sun, Trophy, User, Users, History,
} from 'lucide-react';
import { api, post } from '../lib/api';
import { useLogout, useSession } from '../lib/session';
import { relative } from '../lib/format';
import { Avatar, Empty, IconButton, Sheet } from './ui';

type NavItem = { to: string; label: string; icon: ReactNode; badge?: number; end?: boolean };

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('mesada:theme', next ? 'dark' : 'light');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', next ? '#0C1428' : '#172A54');
  };
  return { dark, toggle };
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
        {unread ? <span className="num absolute top-1 right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-tangerine px-1 text-[11px] font-bold text-white">{unread > 9 ? '9+' : unread}</span> : null}
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
                  <span className={`mt-2 size-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : 'bg-tangerine'}`} aria-hidden />
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
    </Sheet>
  );
}

export function Layout() {
  const { user, family } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const theme = useTheme();
  const [more, setMore] = useState(false);
  const isAdult = user.role === 'adult';

  const { data: dash } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard'), enabled: isAdult, refetchInterval: 60_000 });
  const pendingCount = (dash?.pendingApprovals?.length ?? 0) + (dash?.pendingRedemptions ?? 0);

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
        { to: '/mesada', label: 'Mi dinero', icon: <PiggyBank size={22} /> },
      ];
  const secondary: NavItem[] = isAdult
    ? [
        { to: '/premios', label: 'Recompensas', icon: <Gift size={20} /> },
        { to: '/familia', label: 'Familia', icon: <Users size={20} /> },
        { to: '/estadisticas', label: 'Estadísticas', icon: <ChartColumn size={20} /> },
        { to: '/actividad', label: 'Historial', icon: <History size={20} /> },
        { to: '/ajustes', label: 'Ajustes', icon: <Settings size={20} /> },
      ]
    : [{ to: '/perfil', label: 'Mi perfil', icon: <User size={20} /> }];

  const doLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <a href="#contenido" className="sr-only z-50 rounded-full bg-ink px-4 py-2 font-bold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Saltar al contenido</a>
      {/* Raíl lateral (escritorio) */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-[var(--line)] bg-[var(--card)] px-4 py-6 lg:flex">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <img src="/favicon.svg" alt="" width={36} height={36} className="size-9" />
          <div>
            <p className="font-display text-xl leading-none font-extrabold">Mesada</p>
            <p className="text-sm muted">{family.name}</p>
          </div>
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
              {i.badge ? <span className="num rounded-full bg-tangerine px-2 text-sm text-white">{i.badge}</span> : null}
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
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-[var(--line)] bg-[var(--bg)]/85 px-4 py-2.5 backdrop-blur-md lg:justify-end lg:px-8">
          <div className="flex flex-1 items-center gap-2.5 lg:hidden">
            <Avatar name={user.display_name} avatar={user.avatar} colorKey={user.color} size={34} />
            <div className="leading-tight">
              <p className="font-display font-extrabold">Hola, {user.display_name}</p>
              <p className="text-xs muted">{family.name}</p>
            </div>
          </div>
          <IconButton label={theme.dark ? 'Modo claro' : 'Modo oscuro'} onClick={theme.toggle}>{theme.dark ? <Sun size={20} /> : <Moon size={20} />}</IconButton>
          <Notifications />
          <IconButton label="Cerrar sesión" onClick={doLogout} className="lg:hidden"><LogOut size={19} /></IconButton>
        </header>

        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 lg:px-8 lg:pb-12">
          <Outlet />
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
                    {i.badge ? <span className="num absolute top-1.5 left-1/2 ml-3 rounded-full bg-tangerine px-1.5 text-[11px] text-white">{i.badge}</span> : null}
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
        <MoreSheet open={more} onClose={() => setMore(false)} items={secondary} />
      </div>
    </div>
  );
}
