import { addIcon, Icon } from "@iconify/react";
import type { LucideIcon } from "lucide-react";
import { ICONES_MENU } from "../iconesMenu.data";
import { COLORIDO_DE, DADOS_COLORIDOS } from "./iconesColoridos.data";

// Ícones coloridos (Iconify, embutidos: a CSP não deixa buscar na API). Gerados por `npm run icones:setor`.
// Só os ilustrativos e o menu viram coloridos; botões de ação continuam com o ícone de linha (decisão 16/10/2026).

for (const [nome, data] of Object.entries(DADOS_COLORIDOS)) addIcon(nome, data);
for (const i of Object.values(ICONES_MENU)) addIcon(i.nome, i.data);

/** Ícone ilustrativo de tela: o colorido equivalente ao Lucide; sem equivalente, o próprio Lucide. */
export function IconeIlustrativo({ icon: Linha, size, className }: { icon: LucideIcon; size: number; className?: string }) {
  const nome = COLORIDO_DE.get(Linha);
  if (!nome) return <Linha size={size} className={className} aria-hidden="true" />;
  return <Icon icon={nome} width={size + 2} height={size + 2} className={className} aria-hidden="true" />;
}

/** Ícone do item do menu (Sidebar, atalhos da Página Inicial), pelo id do menuRegistry. */
export function IconeDoMenu({ id, icon: Linha, tamanho = 20 }: { id: string; icon: LucideIcon; tamanho?: number }) {
  const colorido = ICONES_MENU[id];
  return colorido ? <Icon icon={colorido.nome} width={tamanho} height={tamanho} aria-hidden="true" /> : <Linha size={tamanho - 2} aria-hidden="true" />;
}
