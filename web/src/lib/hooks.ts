import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from './api';
import { useToast } from '../components/ui';

/** Invalida todo lo que depende de puntos/saldos tras una operación. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export type ReviewAction = 'approve' | 'partial' | 'return' | 'reject' | 'reject_penalty';

export function useReview() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { id: string; action: ReviewAction; points?: number; note?: string; penaltyPoints?: number; penaltyMinutes?: number }) =>
      post(`/instances/${v.id}/review`, { action: v.action, points: v.points, note: v.note, penaltyPoints: v.penaltyPoints, penaltyMinutes: v.penaltyMinutes }),
    onSuccess: (_d, v) => {
      toast({ approve: 'Tarea aprobada', partial: 'Premio parcial dado', return: 'Tarea devuelta para que la arregle', reject: 'Tarea rechazada', reject_penalty: 'Tarea rechazada con penalidad' }[v.action]);
      invalidate();
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      invalidate();
    },
  });
}

export function useDecideRedemption() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' | 'delivered'; note?: string }) => post(`/redemptions/${v.id}/decide`, v),
    onSuccess: (_d, v) => {
      toast({ approved: 'Recompensa aprobada', rejected: 'Recompensa rechazada; puntos devueltos', delivered: 'Marcada como entregada' }[v.decision]);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
}

/** Muestra «Hecha · Deshacer» durante unos segundos tras marcar una tarea; «Deshacer» la deja como si no se hubiera marcado. */
export function useUndoToast() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return (instanceId: string, text: string) =>
    toast(text, 'ok', {
      ms: 6000,
      action: {
        label: 'Deshacer',
        onClick: () => {
          post(`/instances/${instanceId}/unmark`).then(
            () => { toast('Desmarcada: vuelve a estar por hacer'); invalidate(); },
            (e: Error) => { toast(e.message, 'error'); invalidate(); },
          );
        },
      },
    });
}

/** Desmarcar desde la fila de la tarea. */
export function useUnmark() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (id: string) => post(`/instances/${id}/unmark`),
    onSuccess: () => { toast('Desmarcada: vuelve a estar por hacer'); invalidate(); },
    onError: (e: Error) => { toast(e.message, 'error'); invalidate(); },
  });
}
