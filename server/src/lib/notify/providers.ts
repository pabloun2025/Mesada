import nodemailer from 'nodemailer';
import type { Channel } from './events.js';

/**
 * Contrato común de los proveedores. Cambiar de proveedor = otra implementación + variables de entorno.
 * - ok: entregado al proveedor (con su identificador).
 * - retryable: fallo temporal; se reintenta con espera creciente.
 * - uncertain: no sabemos si salió (p. ej. tiempo agotado tras enviar); NO se reintenta para no duplicar.
 */
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; retryable: boolean; uncertain?: boolean; error: string };

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  link?: string | null;
  /** Clave única del envío (la del outbox). Los proveedores que la admiten evitan duplicados al reintentar. */
  idempotencyKey?: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: Channel;
  /** Real si envía de verdad; simulado en desarrollo, pruebas o hasta activarlo. */
  readonly real: boolean;
  send(msg: OutgoingMessage): Promise<SendResult>;
}

const env = (k: string) => process.env[k] ?? '';
const realSendEnabled = () => env('NOTIFY_REAL_SEND') === 'true';

/** Proveedor simulado: no sale nada; guarda lo último en memoria para las pruebas. */
export class MockProvider implements NotificationProvider {
  readonly real = false;
  readonly sent: OutgoingMessage[] = [];
  failNext: SendResult | null = null;
  constructor(readonly channel: Channel, readonly name = `simulado-${channel}`) {}
  async send(msg: OutgoingMessage): Promise<SendResult> {
    if (this.failNext) {
      const r = this.failNext;
      this.failNext = null;
      return r;
    }
    this.sent.push(msg);
    return { ok: true, externalId: `sim-${Date.now()}-${this.sent.length}` };
  }
}

/**
 * Correo por SMTP genérico. Brevo (smtp-relay.brevo.com:587, clave SMTP solo de envío)
 * o Resend (smtp.resend.com:465) sin cambiar código.
 */
export class SmtpEmailProvider implements NotificationProvider {
  readonly channel = 'email' as const;
  readonly real = true;
  private transport;
  constructor(readonly name: string, private from: string, opts: { host: string; port: number; user: string; pass: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: { user: opts.user, pass: opts.pass },
      connectionTimeout: 15_000,
      socketTimeout: 20_000,
    });
  }
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const text = msg.link ? `${msg.body}\n\n${msg.link}` : msg.body;
    try {
      const info = await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text, html: emailHtml(msg) });
      return { ok: true, externalId: info.messageId ?? `smtp-${Date.now()}` };
    } catch (e: any) {
      const code = Number(e?.responseCode);
      // 5xx: rechazo permanente (dirección o remitente). Sin código: red o tiempo agotado → incierto.
      if (code >= 500) return { ok: false, retryable: false, error: `SMTP ${code}` };
      if (code >= 400) return { ok: false, retryable: true, error: `SMTP ${code}` };
      if (e?.code === 'ECONNREFUSED' || e?.code === 'EDNS' || e?.code === 'EAUTH') return { ok: false, retryable: e.code !== 'EAUTH', error: `SMTP ${e.code}` };
      return { ok: false, retryable: false, uncertain: true, error: 'SMTP sin respuesta' };
    }
  }
}

/**
 * Correo por la API de Resend (como firmador, en el mismo dominio veryfacil.org).
 * Usa la cabecera Idempotency-Key: si se corta la conexión, reintentar no duplica el correo (Resend la recuerda 24 h).
 * Clave recomendada: una propia de Mesada con permiso «Sending access» limitado a veryfacil.org.
 */
export class ResendEmailProvider implements NotificationProvider {
  readonly channel = 'email' as const;
  readonly real = true;
  readonly name = 'resend';
  constructor(private apiKey: string, private from: string, private fetcher: typeof fetch = fetch, private timeoutMs = 15_000) {}
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(msg.idempotencyKey ? { 'idempotency-key': msg.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from: this.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.link ? `${msg.body}\n\n${msg.link}` : msg.body,
          html: emailHtml(msg),
        }),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
      if (res.ok && json?.id) return { ok: true, externalId: json.id };
      if (res.ok) return { ok: false, retryable: Boolean(msg.idempotencyKey), uncertain: !msg.idempotencyKey, error: 'Resend no devolvió identificador' };
      if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, error: `Resend ${res.status}` };
      // 401/403: clave o dominio; 422: datos (remitente no verificado, dirección); 409: misma clave con otro contenido.
      return { ok: false, retryable: false, error: `Resend ${res.status}${json?.message ? `: ${json.message.slice(0, 160)}` : ''}` };
    } catch {
      // Con clave de idempotencia, un corte de red se puede reintentar sin duplicar.
      return msg.idempotencyKey
        ? { ok: false, retryable: true, error: 'Resend no respondió a tiempo' }
        : { ok: false, retryable: false, uncertain: true, error: 'Resend no respondió a tiempo' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * WhatsApp por Evolution API v2 (servidor compartido de consulares). Usa el TOKEN DE LA INSTANCIA de Mesada,
 * no la clave global: así no puede tocar las líneas institucionales.
 */
export class EvolutionWhatsAppProvider implements NotificationProvider {
  readonly channel = 'whatsapp' as const;
  readonly real = true;
  readonly name = 'evolution';
  constructor(private baseUrl: string, private instance: string, private token: string, private timeoutMs = 15_000) {}
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const text = `*${msg.subject}*\n${msg.body}${msg.link ? `\n${msg.link}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(this.instance)}`, {
        method: 'POST',
        headers: { apikey: this.token, 'content-type': 'application/json' },
        body: JSON.stringify({ number: msg.to.replace(/^\+/, ''), text, linkPreview: false }),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as { key?: { id?: string } } | null;
      if (res.ok && json?.key?.id) return { ok: true, externalId: json.key.id };
      if (res.ok) return { ok: false, retryable: false, uncertain: true, error: 'Evolution no devolvió identificador' };
      if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, error: `Evolution rechazó el token (${res.status})` };
      if (res.status === 400 || res.status === 404) return { ok: false, retryable: false, error: `Evolution ${res.status} (número sin WhatsApp o instancia desconectada)` };
      return { ok: false, retryable: true, error: `Evolution ${res.status}` };
    } catch {
      return { ok: false, retryable: false, uncertain: true, error: 'Evolution no respondió a tiempo' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Cabecera con el logotipo de DiploP (si hay URL pública) y el nombre en texto por si el cliente bloquea imágenes. */
function brandHeader() {
  const base = (env('APP_BASE_URL') || '').replace(/\/$/, '');
  const text = '<span style="font-size:22px;font-weight:bold;color:#142A5C">Diplo<span style="color:#E3A200">P</span></span>';
  return `<p style="margin:0 0 16px">${base ? `<img src="${esc(base)}/brand/logo.png" alt="DiploP" width="110" style="display:block;height:auto;border:0">` : text}</p>`;
}

function emailHtml(msg: OutgoingMessage) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#F3F6FB;font-family:Arial,sans-serif;color:#142A5C">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
${brandHeader()}
<div style="background:#fff;border:1px solid #E3E8F2;border-radius:16px;padding:22px">
<h1 style="font-size:18px;margin:0 0 10px">${esc(msg.subject)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0;white-space:pre-line">${esc(msg.body)}</p>
${msg.link ? `<p style="margin:20px 0 0"><a href="${esc(msg.link)}" style="display:inline-block;background:#FFB800;color:#142A5C;padding:11px 18px;border-radius:999px;text-decoration:none;font-weight:bold">Abrir DiploP</a></p>` : ''}
</div>
<p style="font-size:12px;color:#6B7896;margin:16px 4px 0">Recibes este aviso porque tu familia usa DiploP. Los adultos de la familia pueden cambiar qué avisos llegan y por qué medio.</p>
</div></body></html>`;
}

export interface ProviderSet {
  email: NotificationProvider;
  whatsapp: NotificationProvider;
}

let override: ProviderSet | null = null;
let cached: ProviderSet | null = null;

/** Para pruebas: inyecta proveedores simulados. */
export function setProviders(p: ProviderSet | null) {
  override = p;
}

/** Proveedores según el entorno. Sin NOTIFY_REAL_SEND=true, todo es simulado. */
export function getProviders(): ProviderSet {
  if (override) return override;
  if (cached) return cached;
  const real = realSendEnabled();
  const from = `"${env('MAIL_FROM_NAME') || 'DiploP'}" <${env('MAIL_FROM')}>`;
  const emailKind = env('EMAIL_PROVIDER') || 'resend';
  const resendReady = env('RESEND_API_KEY') && env('MAIL_FROM');
  const smtpReady = env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS') && env('MAIL_FROM');
  const waReady = env('EVOLUTION_API_URL') && env('EVOLUTION_INSTANCE') && env('EVOLUTION_INSTANCE_TOKEN');
  cached = {
    email:
      real && emailKind === 'resend' && resendReady
        ? new ResendEmailProvider(env('RESEND_API_KEY'), from)
        : real && emailKind === 'smtp' && smtpReady
          ? new SmtpEmailProvider(env('EMAIL_PROVIDER_NAME') || 'smtp', from, {
              host: env('SMTP_HOST'),
              port: Number(env('SMTP_PORT') || 587),
              user: env('SMTP_USER'),
              pass: env('SMTP_PASS'),
            })
          : new MockProvider('email'),
    whatsapp:
      real && waReady
        ? new EvolutionWhatsAppProvider(env('EVOLUTION_API_URL'), env('EVOLUTION_INSTANCE'), env('EVOLUTION_INSTANCE_TOKEN'))
        : new MockProvider('whatsapp'),
  };
  return cached;
}

export function channelStatus() {
  const p = getProviders();
  return {
    email: { provider: p.email.name, real: p.email.real },
    whatsapp: { provider: p.whatsapp.name, real: p.whatsapp.real },
  };
}
