// Solicitações Financeiras, Fase 5B: regras puras do adiantamento de numerário, usadas pela tela (formulário e
// comprovação) e pelo PDF do servidor. Valor por extenso, percentual da condição de pagamento, valor calculado do
// pedido (total × percentual), soma do rateio e acerto da comprovação.

const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze",
  "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

/** 0 a 999 por extenso ("cem" quando exato). */
function ate999(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]);
  if (r) {
    if (r < 20) partes.push(UNIDADES[r]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      partes.push(u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return partes.join(" e ");
}

const GRUPOS: [string, string][] = [["", ""], ["mil", "mil"], ["milhão", "milhões"], ["bilhão", "bilhões"]];

/** Inteiro por extenso (até 999 bilhões). */
function inteiro(n: number): string {
  if (n === 0) return "zero";
  const grupos: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 1000)) grupos.push(x % 1000);
  const partes: { texto: string; valor: number; idx: number }[] = [];
  grupos.forEach((g, i) => {
    if (!g) return;
    const nome = i === 0 ? "" : g === 1 ? GRUPOS[i][0] : GRUPOS[i][1];
    const texto = i === 1 && g === 1 ? "mil" : [ate999(g), nome].filter(Boolean).join(" ");
    partes.unshift({ texto, valor: g, idx: i });
  });
  // "e" antes do último grupo quando ele é menor que 100 ou centena exata (mil e cem; mil e vinte).
  return partes
    .map((p, k) => {
      if (k === 0) return p.texto;
      const ultimo = k === partes.length - 1;
      const liga = ultimo && p.idx === 0 && (p.valor < 100 || p.valor % 100 === 0);
      return `${liga ? "e " : ""}${p.texto}`;
    })
    .join(" ");
}

/**
 * Valor em reais por extenso, em maiúsculas como no formulário padrão:
 * 658,40 → "SEISCENTOS E CINQUENTA E OITO REAIS E QUARENTA CENTAVOS".
 */
export function valorPorExtenso(valor: number): string {
  if (!Number.isFinite(valor) || valor < 0) return "";
  const centavosTotal = Math.round(valor * 100);
  const reais = Math.floor(centavosTotal / 100);
  const cent = centavosTotal % 100;
  const partes: string[] = [];
  if (reais) {
    const milhoesRedondos = reais >= 1_000_000 && reais % 1_000_000 === 0;
    partes.push(`${inteiro(reais)}${milhoesRedondos ? " de" : ""} ${reais === 1 ? "real" : "reais"}`);
  }
  if (cent) partes.push(`${inteiro(cent)} ${cent === 1 ? "centavo" : "centavos"}`);
  if (!partes.length) return "ZERO REAIS";
  return partes.join(" e ").toUpperCase();
}

/** Primeiro percentual escrito na condição de pagamento ("50% sinal - 50% na entrega" → 50). Nulo se não houver. */
export function percentualDaCondicao(condicao: string | null | undefined): number | null {
  const m = (condicao ?? "").match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return n > 0 && n <= 100 ? n : null;
}

/** Valor do adiantamento calculado pelo sistema: total do pedido × percentual (2 casas). */
export function valorDoPedido(total: number | null | undefined, percentual: number | null | undefined): number | null {
  if (total == null || percentual == null || !(total > 0) || !(percentual > 0)) return null;
  return Math.round(total * percentual) / 100;
}

/** Soma das porcentagens do rateio (2 casas) e se fecha 100% (A05). */
export function somaRateio(linhas: { porcentagem: number | null | undefined }[]): { soma: number; fecha: boolean } {
  const soma = Math.round(linhas.reduce((t, l) => t + (Number(l.porcentagem) || 0), 0) * 100) / 100;
  return { soma, fecha: linhas.length > 0 && soma === 100 };
}

/** Valor de cada tarefa do rateio (centavos arredondados por linha, como no banco). */
export function valorDaTarefa(valor: number | null | undefined, porcentagem: number | null | undefined): number {
  return Math.round((Number(valor) || 0) * (Number(porcentagem) || 0)) / 100;
}

/** Acerto da comprovação: comprovado ≥ adiantado encerra (saldo do pedido vai contra a nota); menor gera devolução. */
export function acerto(adiantado: number, comprovado: number): { resultado: "comprovado" | "devolucao"; saldoPagar: number; saldoDevolver: number } {
  const dif = Math.round((comprovado - adiantado) * 100) / 100;
  return dif >= 0 ? { resultado: "comprovado", saldoPagar: dif, saldoDevolver: 0 } : { resultado: "devolucao", saldoPagar: 0, saldoDevolver: -dif };
}

/** Prazo máximo de comprovação = vencimento + dias do setor (AAAA-MM-DD). */
export function prazoComprovacao(vencimento: string | null | undefined, dias: number): string | null {
  if (!vencimento || !/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return null;
  const d = new Date(`${vencimento}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
