import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { useMe } from './lib/session';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { Login } from './pages/Login';
import { Welcome } from './pages/Welcome';
import { Setup } from './pages/Setup';
import { AcceptInvitation, Forgot, Reset } from './pages/AccountRecovery';

// Carga diferida por pantalla: el código de adultos no se descarga en el móvil de los hijos y viceversa.
const ParentDashboard = lazy(() => import('./pages/ParentDashboard'));
const Approvals = lazy(() => import('./pages/Approvals'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Allowance = lazy(() => import('./pages/Allowance'));
const Rewards = lazy(() => import('./pages/Rewards'));
const Family = lazy(() => import('./pages/Family'));
const Stats = lazy(() => import('./pages/Stats'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const ChildToday = lazy(() => import('./pages/ChildToday'));
const ChildProgress = lazy(() => import('./pages/ChildProgress'));
const ChildMoney = lazy(() => import('./pages/ChildMoney'));
const Profile = lazy(() => import('./pages/Profile'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Extras = lazy(() => import('./pages/Extras'));
const Admin = lazy(() => import('./pages/Admin'));
const Legal = lazy(() => import('./pages/Legal'));

const KNOWN = 'mesada:returning';
const knownDevice = () => {
  try { return localStorage.getItem(KNOWN) === '1'; } catch { return false; }
};

/** Los textos legales se pueden leer con y sin sesión; el resto de rutas depende de si hay sesión. */
export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/privacidad" element={<Legal doc="privacidad" />} />
        <Route path="/aviso-legal" element={<Legal doc="aviso-legal" />} />
        <Route path="/condiciones" element={<Legal doc="condiciones" />} />
        <Route path="*" element={<AppRoutes />} />
      </Routes>
    </Suspense>
  );
}

function AppRoutes() {
  const me = useMe();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api('/setup/status'), enabled: me.data === null });

  if (me.isLoading) return <Loading />;
  if (me.isError) {
    return <p className="p-8 text-center">No se puede conectar con el servidor. Comprueba tu conexión y recarga la página.</p>;
  }
  if (!me.data) {
    if (setup.isLoading) return <Loading />;
    return (
      <Routes>
        <Route path="/recuperar" element={<Forgot />} />
        <Route path="/restablecer" element={<Reset />} />
        <Route path="/invitacion" element={<AcceptInvitation />} />
        <Route path="/configurar" element={setup.data?.registrationOpen ? <Setup /> : <Navigate to="/" replace />} />
        <Route path="/bienvenida" element={<Welcome canRegister={!!setup.data?.registrationOpen} />} />
        <Route path="/entrar" element={<Login canRegister={!!setup.data?.registrationOpen} />} />
        {/* Quien nunca ha entrado en este dispositivo ve la bienvenida; quien ya lo hizo, directo el acceso. */}
        <Route path="*" element={setup.data?.needsSetup ? <Navigate to="/configurar" replace /> : knownDevice() ? <Login canRegister={!!setup.data?.registrationOpen} /> : <Welcome canRegister={!!setup.data?.registrationOpen} />} />
      </Routes>
    );
  }

  try { localStorage.setItem(KNOWN, '1'); } catch { /* sin almacenamiento: se verá la bienvenida */ }
  const adult = me.data.user.role === 'adult';
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Layout />}>
          {adult ? (
            <>
              <Route index element={<ParentDashboard />} />
              <Route path="validar" element={<Approvals />} />
              <Route path="tareas" element={<Tasks />} />
              <Route path="extras" element={<Extras />} />
              <Route path="mesada" element={<Allowance />} />
              <Route path="premios" element={<Rewards />} />
              <Route path="familia" element={<Family />} />
              <Route path="estadisticas" element={<Stats />} />
              <Route path="actividad" element={<Activity />} />
              <Route path="ajustes" element={<Settings />} />
              <Route path="avisos" element={<Notifications />} />
              <Route path="perfil" element={<Profile />} />
              {me.data.user.is_superadmin ? <Route path="administracion" element={<Admin />} /> : null}
            </>
          ) : (
            <>
              <Route index element={<ChildToday />} />
              <Route path="hoy" element={<Navigate to="/" replace />} />
              <Route path="progreso" element={<ChildProgress />} />
              <Route path="extras" element={<Extras />} />
              <Route path="premios" element={<Rewards />} />
              <Route path="mesada" element={<ChildMoney />} />
              <Route path="avisos" element={<Notifications />} />
              <Route path="perfil" element={<Profile />} />
            </>
          )}
          {/* Recién creada la familia, la sesión puede llegar antes que la navegación: se va a Familia, no al inicio. */}
          {adult ? <Route path="configurar" element={<Navigate to="/familia" replace />} /> : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
