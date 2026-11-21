import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from './api';
import { useToast } from '../components/ui';

/** Invalida todo lo que depende de puntos/saldos tras una operación. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useReview() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (v: { id: string; approve: boolean; points?: number; note?: string }) =>
      post(`/instances/${v.id}/review`, { approve: v.approve, points: v.points, note: v.note }),
    onSuccess: (_d, v) => {
      toast(v.approve ? 'Tarea aprobada' : 'Tarea devuelta para repasar');
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
