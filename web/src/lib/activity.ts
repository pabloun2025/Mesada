const eur = (c: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(c / 100);

export function describeAction(a: { action: string; data: any }): string {
  const d = a.data ?? {};
  switch (a.action) {
    case 'task.complete': return d.status === 'approved' ? 'completó una tarea' : 'marcó una tarea como hecha';
    case 'task.approve': return `aprobó una tarea (${d.points} pts)`;
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
    case 'savings.deposit': return `metió ${eur(d.cents)} en «${d.title}»`;
    case 'savings.withdraw': return `sacó el ahorro de «${d.title}» (${eur(d.principal)}; perdió ${eur(d.forfeited)} de interés)`;
    case 'bank.exchange': return `cambió ${d.points} puntos por ${eur(d.cents)}`;
    case 'bank.advance': return `adelantó ${eur(d.cents)} de la semana que viene`;
    case 'loan.request': return `pidió un préstamo de ${eur(d.cents)} en ${d.weeks} semanas`;
    case 'loan.approve': return `aprobó un préstamo de ${eur(d.cents)}`;
    case 'loan.reject': return 'rechazó un préstamo';
    case 'loan.cancel': return 'canceló su petición de préstamo';
    case 'goal.request': return d.kind === 'redeem' ? `pidió canjear la meta «${d.title}»` : `pidió pasar a efectivo la meta «${d.title}»`;
    case 'goal.redeem': return `compró «${d.title}» por ${eur(d.price)} (${d.settle >= 0 ? 'sobran' : 'faltan'} ${eur(Math.abs(d.settle))})`;
    case 'goal.cashout': return `pasó a efectivo «${d.title}» (${eur(d.principal)}; interés perdido ${eur(d.forfeited)})`;
    case 'goal.reject': return 'rechazó la petición de una meta';
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
    case 'payout.request': return d.kind === 'money' ? `quiere retirar ${eur(d.cents)}` : `pidió ${d.minutes} min de pantalla`;
    case 'payout.approve': return d.kind === 'money' ? `aprobó una petición de ${eur(d.cents)}` : `aprobó una petición de ${d.minutes} min de pantalla`;
    case 'payout.reject': return 'rechazó una petición';
    case 'payout.cancel': return 'canceló su petición';
    case 'task.unmark': return `desmarcó «${d.title}»${d.pointsBack ? ` (se devuelven ${d.pointsBack} puntos)` : ''}`;
    case 'task.partial': return `dio un premio parcial: ${d.points} de ${d.of} puntos`;
    case 'task.return': return 'devolvió una tarea para que la arregle';
    case 'task.reject': return 'rechazó una tarea';
    case 'task.reject_penalty': return `rechazó una tarea${d.penaltyPoints ? ` (−${d.penaltyPoints} puntos` : ''}${d.penaltyMinutes ? `${d.penaltyPoints ? ' y ' : ' (−'}${d.penaltyMinutes} min de pantalla` : ''}${d.penaltyPoints || d.penaltyMinutes ? ')' : ''}`;
    case 'screen_plan.update': return d.enabled ? `puso un plan de pantalla de ${d.minutes} min por semana` : 'apagó el plan de pantalla';
    case 'screen_adjust.minutes': return `hizo un ajuste de pantalla «${d.reason}»: −${d.minutes} min`;
    case 'screen_adjust.pause': return `puso una pausa de pantalla «${d.reason}» de ${d.days} ${d.days === 1 ? 'día' : 'días'}`;
    case 'screen_adjust.end_pause': return 'terminó una pausa de pantalla';
    case 'screen_adjust.recovered': return 'recuperó un ajuste de pantalla con un trabajo extra';
    case 'screen_reason.create': return `creó el motivo de ajuste «${d.title}»`;
    case 'screen_reason.update': return `editó el motivo de ajuste «${d.title}»`;
    case 'screen_reason.archive': return 'archivó un motivo de ajuste';
    case 'holiday.add': return `marcó el festivo ${d.day}`;
    case 'holiday.remove': return `quitó el festivo ${d.day}`;
    case 'user.password_change': return 'cambió su contraseña';
    default: return a.action;
  }
}

/** Frase completa del historial; si la acción recae sobre otra persona (p. ej. un adulto aprueba el préstamo de un hijo), la nombra. */
export function describeEntry(a: { action: string; data: any; actor_name?: string | null; for_name?: string | null }): string {
  const text = describeAction(a);
  return a.for_name && a.for_name !== a.actor_name ? `${text} · ${a.for_name}` : text;
}
