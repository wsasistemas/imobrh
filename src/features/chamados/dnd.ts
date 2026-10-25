import type { KeyboardCoordinateGetter } from "@dnd-kit/core";

/**
 * Arrastar pelo teclado no Kanban: ← e → pulam para a coluna vizinha (o padrão do dnd-kit anda 25px por
 * tecla, o que não serve para colunas). O salto é a distância entre a coluna atual (`over`) e a vizinha,
 * medidas juntas, para não depender da rolagem do quadro. As demais teclas seguem o padrão
 * (espaço pega/solta, Esc cancela).
 */
export const coordenadasPorColuna: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const dir = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
  if (!dir) return undefined;
  event.preventDefault();
  const { droppableRects, over, collisionRect } = context;
  const colunas = [...droppableRects.entries()].sort(([, a], [, b]) => a.left - b.left);
  const atual = over ? colunas.findIndex(([id]) => id === over.id) : -1;
  // Ainda sobre nenhuma coluna: vai para a mais próxima na direção da tecla.
  if (atual < 0) {
    if (!collisionRect) return currentCoordinates;
    const centro = collisionRect.left + collisionRect.width / 2;
    const alvo = dir > 0 ? colunas.find(([, r]) => r.left + r.width / 2 > centro) : [...colunas].reverse().find(([, r]) => r.left + r.width / 2 < centro);
    return alvo ? { x: currentCoordinates.x + (alvo[1].left + alvo[1].width / 2 - centro), y: currentCoordinates.y } : currentCoordinates;
  }
  const vizinha = colunas[atual + dir];
  if (!vizinha) return currentCoordinates;
  return { x: currentCoordinates.x + (vizinha[1].left - colunas[atual][1].left), y: currentCoordinates.y };
};
