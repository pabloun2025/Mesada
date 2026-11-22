import { useId } from 'react';

const link = 'font-bold text-tangerine-deep underline underline-offset-2';

/**
 * Casilla obligatoria del alta. Los enlaces abren en otra pestaña para no perder lo escrito.
 * Toda la fila es zona de toque (≥ 44 px).
 */
export function ConsentBox({ checked, onChange, adult = true }: { checked: boolean; onChange: (v: boolean) => void; adult?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-[var(--chip)] p-3">
      <input id={id} type="checkbox" name="acceptTerms" required checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-6 shrink-0 accent-[var(--color-tangerine-deep)]" />
      <label htmlFor={id} className="min-h-11 flex-1 text-sm leading-snug">
        {adult ? 'Soy mayor de edad y acepto, también en nombre de los menores a mi cargo, la ' : 'Soy mayor de edad y acepto la '}
        <a href="/privacidad" target="_blank" rel="noopener noreferrer" className={link}>política de privacidad</a> y las{' '}
        <a href="/condiciones" target="_blank" rel="noopener noreferrer" className={link}>condiciones de uso</a>.
      </label>
    </div>
  );
}

/** Campo trampa contra robots: está fuera de pantalla, no se puede enfocar y las personas no lo ven. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" inert style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
      <label>
        Deja este campo vacío
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
