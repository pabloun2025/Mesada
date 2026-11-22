/** Alarma del fin de la pantalla: sonido con Web Audio y vibración si el aparato la tiene. Sin ficheros de audio. */
let ctx: AudioContext | null = null;

/** Hay que llamarla desde un toque del usuario (al empezar la sesión): los móviles no dejan sonar antes. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    void ctx.resume();
  } catch { /* sin audio: queda la pantalla y la vibración */ }
}

function tone(freq: number, at: number, dur: number, gain = 0.25) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + at);
  o.stop(ctx.currentTime + at + dur + 0.05);
}

const vibrate = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* no disponible */ } };

/** Aviso suave de «quedan 5 minutos». */
export function chime() {
  tone(660, 0, 0.25); tone(880, 0.3, 0.35);
  vibrate([120, 80, 120]);
}

/** Alarma de «se acabó el tiempo»: suena y vibra en bucle hasta que se pare (o 40 s como máximo). Devuelve la función que la para. */
export function startAlarm(): () => void {
  let stopped = false;
  const round = () => {
    if (stopped) return;
    tone(880, 0, 0.2, 0.3); tone(660, 0.25, 0.2, 0.3); tone(880, 0.5, 0.2, 0.3);
    vibrate([300, 150, 300, 150, 300]);
  };
  round();
  const id = setInterval(round, 1500);
  const cap = setTimeout(() => stop(), 40_000);
  function stop() {
    stopped = true;
    clearInterval(id);
    clearTimeout(cap);
    vibrate(0);
  }
  return stop;
}

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
