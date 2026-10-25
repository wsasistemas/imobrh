import type { TipoSolicitacao } from "../solicitacoes";

export const NOME_TIPO: Record<TipoSolicitacao, string> = { reembolso: "Reembolso", fundo_fixo: "Fundo fixo", adiantamento: "Adiantamento" };

/** "2026-10-31" → "31/10/2026" (sem fuso: data pura). */
export function dataBR(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

/** "2026-10-01" → "OUTUBRO - 2026" (como no formulário padrão 2026). */
export function mesBR(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m] = iso.split("-").map(Number);
  return `${new Date(a, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" }).toUpperCase()} - ${a}`;
}

/** CPF ou CNPJ (só dígitos) com máscara; outro texto volta como está. */
export function docBR(doc: string | null | undefined): string {
  const d = (doc ?? "").replace(/\D/g, "");
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return doc ?? "";
}
