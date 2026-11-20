import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Family, User } from './types';

export interface Me {
  user: User;
  family: Family;
}

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** Sesión garantizada (solo dentro de rutas protegidas). */
export function useSession(): Me {
  const { data } = useMe();
  if (!data) throw new Error('Sin sesión');
  return data;
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    qc.clear();
    qc.setQueryData(['me'], null);
  };
}
