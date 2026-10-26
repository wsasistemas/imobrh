import { useRef } from "react";

/**
 * Devolve o foco a quem abriu o diálogo. O Radix só faz isso sozinho quando o diálogo tem um
 * `Trigger`; os nossos são abertos por estado (botões, menus de ação), então o foco iria para o body.
 * Espalhe o retorno no `Dialog.Content`/`AlertDialog.Content`.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);

  return {
    onOpenAutoFocus: () => {
      // Dispara antes de o foco entrar no diálogo: o elemento ativo ainda é quem o abriu.
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (opener.current?.isConnected) opener.current.focus();
      opener.current = null;
    },
  };
}
