export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown; idempotencyKey?: string; form?: FormData };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Mesada': '1' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? 'No se ha podido completar la acción', data.error ?? 'error');
  return data as T;
}

export const post = <T = any>(path: string, body?: unknown, idempotencyKey?: string) =>
  api<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export const newKey = () => crypto.randomUUID();
