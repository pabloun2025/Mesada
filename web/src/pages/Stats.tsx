import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { euros } from '../lib/format';
import { Avatar, Loading, PageHeader, SectionTitle } from '../components/ui';
import { StatsChart } from '../components/StatsChart';

export default function Stats() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard') });
  if (isLoading || !data) return <Loading />;
  return (
    <div>
      <PageHeader title="Estadísticas" subtitle="Evolución de puntos por semana y por mes." />
      <div className="card mb-8 p-4 sm:p-6"><StatsChart /></div>
      <SectionTitle>Resumen por hijo</SectionTitle>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[var(--fg-3)]">
            <tr>
              <th className="p-3 font-bold">Hijo/a</th><th className="p-3 text-right font-bold">Puntos semana</th><th className="p-3 text-right font-bold">≈ €</th>
              <th className="p-3 text-right font-bold">Ganados total</th><th className="p-3 text-right font-bold">Convertido</th><th className="p-3 text-right font-bold">Pagado</th><th className="p-3 text-right font-bold">Racha</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {data.kids.map((k: any) => (
              <tr key={k.id}>
                <td className="p-3"><span className="flex items-center gap-2 font-bold"><Avatar name={k.display_name} avatar={k.avatar} colorKey={k.color} size={26} />{k.display_name}</span></td>
                <td className="num p-3 text-right">{k.weekPoints}</td>
                <td className="num p-3 text-right">{euros(k.weekCents)}</td>
                <td className="num p-3 text-right">{k.wallet.points_lifetime}</td>
                <td className="num p-3 text-right">{euros(k.wallet.cents_converted_total)}</td>
                <td className="num p-3 text-right">{euros(k.wallet.cents_paid_total)}</td>
                <td className="num p-3 text-right">{k.streak} d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
