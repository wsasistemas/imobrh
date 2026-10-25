import { APP_NAME } from "../config/app";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadForNewBuild } from "../lib/staleBuild";
import "./AppErrorBoundary.css";

interface State {
  error: Error | null;
}

/**
 * Última proteção da interface: um erro de renderização mostra esta tela em vez da página em branco.
 * Se o erro for de arquivo do build antigo (deploy novo com a aba aberta), recarrega sozinho uma vez.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${APP_NAME}] Erro na interface:`, error, info.componentStack);
    if (isChunkLoadError(error)) reloadForNewBuild();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isChunkLoadError(error);
    return (
      <main className="app-crash" role="alert">
        <div className="app-crash__card">
          <img src="/wsa-logo.png" alt="" className="app-crash__logo" />
          <h1>{stale ? "O sistema foi atualizado" : "Não foi possível abrir esta tela"}</h1>
          <p>
            {stale
              ? "Uma nova versão foi publicada enquanto a página estava aberta. Recarregue para usar a versão atual."
              : "Ocorreu um erro inesperado. Recarregue a página; se continuar, envie o detalhe abaixo para o suporte."}
          </p>
          <div className="app-crash__actions">
            <button type="button" className="app-crash__btn" onClick={() => window.location.reload()}>
              Recarregar
            </button>
            <a className="app-crash__link" href="/home">
              Ir para o início
            </a>
          </div>
          <details className="app-crash__details">
            <summary>Detalhe técnico</summary>
            <code>{error.message || String(error)}</code>
          </details>
        </div>
      </main>
    );
  }
}
