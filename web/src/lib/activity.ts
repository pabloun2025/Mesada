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
    case 'task.check_met': return 'marcó una tarea como cumplida';
    case 'task.check_not_met': return `marcó una tarea como no cumplida${d.penaltyApplied ? ` (−${d.penaltyApplied} min de pantalla)` : ''}`;
    case 'bonus.fulfill': return `cumplió un premio: ${d.label}`;
    case 'screen.spend': return `gastó ${-d.minutes} min de pantalla`;
    case 'screen.adjust': return `ajustó ${d.delta > 0 ? '+' : ''}${d.delta} min de pantalla: ${d.note}`;
    case 'screen.usage': return `anotó ${d.applied} min de pantalla${d.overflow ? ` (se pasó ${d.overflow} min)` : ''}`;
    case 'screen.usage_confirm': return 'confirmó una anotación de pantalla';
    case 'screen.usage_void': return `anuló una anotación de pantalla${d.refunded ? ` (devuelve ${d.refunded} min)` : ''}`;
    case 'payout.request': return d.kind === 'money' ? `pidió ${eur(d.cents)}` : `pidió ${d.minutes} min de pantalla`;
    case 'payout.approve': return d.kind === 'money' ? `aprobó una petición de ${eur(d.cents)}` : `aprobó una petición de ${d.minutes} min de pantalla`;
    case 'payout.reject': return 'rechazó una petición';
    case 'payout.cancel': return 'canceló su petición';
    case 'holiday.add': return `marcó el festivo ${d.day}`;
    case 'holiday.remove': return `quitó el festivo ${d.day}`;
    case 'user.password_change': return 'cambió su contraseña';
    default: return a.action;
  }
}
