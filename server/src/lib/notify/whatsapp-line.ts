/**
 * Línea de WhatsApp de Mesada (instancia propia en la Evolution compartida). Todas las llamadas usan el TOKEN DE LA
 * INSTANCIA: la app no tiene la clave global y no puede ver ni tocar las líneas de la Embajada o los consulados.
 */
export type LineState = 'open' | 'connecting' | 'close' | 'unknown';

const env = (k: string) => process.env[k] ?? '';
export const lineConfigured = () => Boolean(env('EVOLUTION_API_URL') && env('EVOLUTION_INSTANCE') && env('EVOLUTION_INSTANCE_TOKEN'));

async function call(path: string, fetcher: typeof fetch = fetch): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetcher(`${env('EVOLUTION_API_URL').replace(/\/$/, '')}${path}`, {
      headers: { apikey: env('EVOLUTION_INSTANCE_TOKEN') },
      signal: ctrl.signal,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

const readState = (j: any): LineState => {
  const s = j?.instance?.state ?? j?.state;
  return s === 'open' || s === 'connecting' || s === 'close' ? s : 'unknown';
};

export async function lineStatus(fetcher?: typeof fetch) {
  if (!lineConfigured()) return { configured: false as const, state: 'unknown' as LineState, error: null as string | null };
  try {
    const r = await call(`/instance/connectionState/${encodeURIComponent(env('EVOLUTION_INSTANCE'))}`, fetcher);
    if (r.status === 401 || r.status === 403) return { configured: true as const, state: 'unknown' as LineState, error: 'Evolution no acepta el token de la instancia' };
    if (r.status >= 400) return { configured: true as const, state: 'unknown' as LineState, error: `Evolution respondió ${r.status}` };
    return { configured: true as const, state: readState(r.json), error: null };
  } catch {
    return { configured: true as const, state: 'unknown' as LineState, error: 'Evolution no responde' };
  }
}

/**
 * Pide el QR (o el código de 8 caracteres si se indica el número). Si ya está vinculada, no devuelve QR.
 */
export async function lineConnect(number?: string, fetcher?: typeof fetch) {
  if (!lineConfigured()) return { ok: false as const, error: 'La línea de WhatsApp aún no está preparada en el servidor.' };
  const q = number ? `?number=${encodeURIComponent(number.replace(/^\+/, ''))}` : '';
  try {
    const r = await call(`/instance/connect/${encodeURIComponent(env('EVOLUTION_INSTANCE'))}${q}`, fetcher);
    if (r.status === 401 || r.status === 403) return { ok: false as const, error: 'Evolution no acepta el token de la instancia.' };
    if (r.status >= 400) return { ok: false as const, error: `Evolution respondió ${r.status}.` };
    const state = readState(r.json);
    const qr = typeof r.json?.base64 === 'string' ? (r.json.base64 as string) : null;
    const pairingCode = typeof r.json?.pairingCode === 'string' ? (r.json.pairingCode as string) : null;
    return { ok: true as const, state: qr || pairingCode ? ('connecting' as LineState) : state, qr, pairingCode };
  } catch {
    return { ok: false as const, error: 'Evolution no responde. Inténtalo en un minuto.' };
  }
}
