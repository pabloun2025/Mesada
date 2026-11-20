const eur = (c: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(c / 100);

export function describeAction(a: { action: string; data: any }): string {
  const d = a.data ?? {};
  switch (a.action) {
    case 'task.complete': return d.status === 'approved' ? 'completó una tarea' : 'marcó una tarea como hecha';
    case 'task.approve': return `aprobó una tarea (${d.points} pts)`;
    case 'task.reject': return 'devolvió una tarea para repasar';
    case 'task.points_changed': return `cambió los puntos de ${d.from} a ${d.to}`;
    case 'task.create': return `creó la tarea «${d.title}»`;
    case 'task.update': return `editó la tarea «${d.title}»`;
    case 'task.archive': return 'archivó una tarea';
    case 'reward.request': return `pidió «${d.reward}»`;
    case 'reward.approved': return 'aprobó una recompensa';
    case 'reward.rejected': return 'rechazó una recompensa';
    case 'reward.delivered': return 'entregó una recompensa';
    case 'reward.create': return `creó la recompensa «${d.title}»`;
    case 'reward.update': return 'editó una recompensa';
    case 'reward.archive': return 'retiró una recompensa';
    case 'allowance.settle': return `cerró el periodo: ${d.points} pts → ${eur(d.cents)}${d.capped ? ' (con límite)' : ''}`;
    case 'allowance.payment': return `registró un pago de ${eur(d.cents)}`;
    case 'points.adjust': return `ajustó ${d.delta > 0 ? '+' : ''}${d.delta} pts: ${d.note}`;
    case 'money.adjust': return `ajustó ${eur(d.cents)}: ${d.note}`;
    case 'savings.transfer': return d.direction === 'to_savings' ? `guardó ${eur(d.cents)} en la hucha` : `sacó ${eur(d.cents)} de la hucha`;
    case 'member.create': return `añadió a ${d.displayName}`;
    case 'member.update': return 'actualizó un perfil';
    case 'family.update': return 'cambió los ajustes de la familia';
    case 'family.create': return 'creó la familia';
    case 'goal.create': return `creó la meta «${d.title}»`;
    case 'user.password_change': return 'cambió su contraseña';
    default: return a.action;
  }
}
