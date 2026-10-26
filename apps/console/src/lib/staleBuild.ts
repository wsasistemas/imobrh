/**
 * Depois de um deploy, uma aba aberta ainda pede os arquivos .js do build antigo, que não existem mais.
 * Nesse caso, recarregar a página busca o build novo. A trava em sessionStorage evita recarregar em laço
 * se o erro continuar (ex.: servidor fora do ar).
 */
// Mesma chave do script de boot do index.html (troque os dois juntos).
const RELOAD_KEY = "imobrh-console:stale-build-reload";
const RELOAD_WINDOW_MS = 30_000;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

/** Recarrega uma vez; devolve false se já recarregou há pouco (aí quem chamou mostra o erro). */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Sem sessionStorage (modo restrito): recarrega mesmo assim, uma vez por carregamento.
  }
  window.location.reload();
  return true;
}
