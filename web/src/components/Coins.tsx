import { useId } from 'react';

/** Monedas doradas de adorno (recibo del canje, cuenta de dinero…). Puramente decorativas. */
export function GoldCoins({ className = '', size = 64 }: { className?: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  const g = `gold-${id}`;
  const e = `edge-${id}`;
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 72 64" width={size} height={(size * 64) / 72} className={className}>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe27a" />
          <stop offset="0.55" stopColor="#ffbf1f" />
          <stop offset="1" stopColor="#e39a00" />
        </linearGradient>
        <linearGradient id={e} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d98e00" />
          <stop offset="1" stopColor="#a86a00" />
        </linearGradient>
      </defs>
      {/* Dos monedas tumbadas */}
      <g>
        <path d="M4 44v6c0 4 11 7 24 7s24-3 24-7v-6z" fill={`url(#${e})`} />
        <ellipse cx="28" cy="44" rx="24" ry="8" fill={`url(#${g})`} stroke="#b97800" strokeWidth="1.2" />
        <ellipse cx="28" cy="44" rx="17" ry="5" fill="none" stroke="#fff2b0" strokeOpacity=".7" strokeWidth="1.2" />
      </g>
      <g>
        <path d="M8 34v6c0 4 10 6 22 6s22-2 22-6v-6z" fill={`url(#${e})`} />
        <ellipse cx="30" cy="34" rx="22" ry="7" fill={`url(#${g})`} stroke="#b97800" strokeWidth="1.2" />
      </g>
      {/* Moneda de pie con el euro */}
      <g>
        <circle cx="50" cy="28" r="20" fill={`url(#${e})`} />
        <circle cx="49" cy="26" r="19" fill={`url(#${g})`} stroke="#b97800" strokeWidth="1.2" />
        <circle cx="49" cy="26" r="14.5" fill="none" stroke="#fff2b0" strokeOpacity=".75" strokeWidth="1.4" />
        <text x="49" y="33" textAnchor="middle" fontSize="20" fontWeight="800" fill="#b97800" fontFamily="system-ui, sans-serif">€</text>
      </g>
    </svg>
  );
}
