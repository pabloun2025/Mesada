import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Al cambiar (p. ej. la ruta) el aviso se quita y se vuelve a intentar dibujar. */
  resetKey?: string;
}

/**
 * Si una pantalla falla al dibujarse, en vez de dejar la página en blanco se avisa con calma
 * y se ofrece volver a intentarlo. La cabecera y el menú, que van fuera, siguen funcionando.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Fallo al dibujar la pantalla', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-berry-soft text-berry-deep dark:bg-berry/20"><TriangleAlert size={26} aria-hidden /></span>
        <h2 className="font-display text-xl font-bold">Algo no ha salido bien</h2>
        <p className="muted">Esta pantalla no se ha podido mostrar. Tus datos están a salvo. Prueba otra vez y, si sigue igual, recarga la página.</p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="inline-flex h-11 items-center justify-center rounded-full bg-sun px-5 font-bold text-ink transition hover:bg-sun-deep active:scale-[0.97]"
        >
          Volver a intentar
        </button>
      </div>
    );
  }
}
