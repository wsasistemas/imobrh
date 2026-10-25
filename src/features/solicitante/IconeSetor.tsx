import { addIcon, Icon } from "@iconify/react";
import { ICONES_SETOR } from "./iconesSetor.data";

// Ícone do departamento no App do solicitante. O campo do setor guarda um nome do Iconify ("flat-color-icons:folder") ou um
// emoji (cadastros antigos). Os ícones vêm embutidos (iconesSetor.data.ts): a CSP não deixa buscar na API do Iconify.

for (const i of ICONES_SETOR) addIcon(i.nome, i.data);

export const ICONE_PADRAO = "flat-color-icons:folder";
const NOMES = new Set(ICONES_SETOR.map((i) => i.nome));

/** Sem ícone (ou o 🎫 que o banco devolve no lugar do vazio): a pasta. Nome desconhecido também cai na pasta. */
export function IconeSetor({ valor, tamanho = 28 }: { valor: string | null | undefined; tamanho?: number }) {
  const v = valor?.trim() ?? "";
  if (v && v !== "🎫" && !v.includes(":")) return <>{v}</>;
  return <Icon icon={NOMES.has(v) ? v : ICONE_PADRAO} width={tamanho} height={tamanho} aria-hidden="true" />;
}
