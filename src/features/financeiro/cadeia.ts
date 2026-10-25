import type { ConfigSetorFinanceiro, NivelAdiantamento } from "./service";

// Quem aprova uma solicitação (CONTEXTO.md, seção 4). Usado na prévia da aba do setor e no painel "Quem vai aprovar"
// dos formulários; o envio (sf_enviar, Fase 2) aplica a mesma regra no banco e congela o resultado em sf_aprovacao.

export interface EtapaCadeia {
  nivel: number;
  papel: string;
  aprovadorId: string | null;
  substitutoId: string | null;
  /** false = aparece na timeline como "não exigido para este valor". */
  exigido: boolean;
  motivo: string;
}

const NOME: Record<NivelAdiantamento["papel"], string> = { planejamento: "Planejamento", gerente: "Gerente", diretor: "Diretor", presidente: "Presidente" };

/** Reembolso e fundo fixo: entra quem tem alçada mínima <= total. */
export function cadeiaReembolso(c: Pick<ConfigSetorFinanceiro, "reembolso">, total: number): EtapaCadeia[] {
  return c.reembolso.map((n, i) => {
    const exigido = total >= n.alcadaMinima;
    return {
      nivel: i + 1, papel: n.papel, aprovadorId: n.aprovadorId, substitutoId: n.substitutoId, exigido,
      motivo: exigido ? (n.alcadaMinima > 0 ? `a partir de ${moeda(n.alcadaMinima)}` : "sempre") : "não exigido para este valor",
    };
  });
}

/** Adiantamento: Planejamento (só obra) → Gerente (sempre) → Diretor e Presidente (valor acima da alçada). Sempre sequencial. */
export function cadeiaAdiantamento(c: Pick<ConfigSetorFinanceiro, "adiantamento" | "obra">, valor: number): EtapaCadeia[] {
  return c.adiantamento.map((n, i) => {
    let exigido: boolean;
    let motivo: string;
    if (!n.aprovadorId) {
      exigido = false;
      motivo = "não configurado";
    } else if (n.papel === "planejamento") {
      exigido = c.obra;
      motivo = c.obra ? "despesa de obra" : "só para setor de obra";
    } else if (n.papel === "gerente") {
      exigido = true;
      motivo = "sempre";
    } else {
      exigido = n.alcadaMinima != null && valor > n.alcadaMinima;
      motivo = exigido ? `acima de ${moeda(n.alcadaMinima ?? 0)}` : "não exigido para este valor";
    }
    return { nivel: i + 1, papel: NOME[n.papel], aprovadorId: n.aprovadorId, substitutoId: n.substitutoId, exigido, motivo };
  });
}

export function moeda(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
