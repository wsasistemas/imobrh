import { agrupar, horasEntre, noPrazoResposta, noPrazoSolucao, vencido } from "./calculos";
import type { Tabela } from "./exportar";
import type { Visao } from "./hooks";
import { DIMENSOES, ORIGEM_ROTULO, type Dimensao } from "./types";

// Tabelas dos relatórios e das exportações, montadas a partir da visão já calculada (uma fonte para a tela e o arquivo).

const dataHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
const h1 = (h: number | null) => (h === null ? null : Math.round(h * 10) / 10);
const simNao = (v: boolean | null) => (v === null ? "" : v ? "Sim" : "Não");

/** Analítico: um ticket por linha (entradas do período + backlog aberto, sem repetir). */
export function tabelaAnalitica(v: Visao): Tabela {
  const ids = new Set<number>();
  const linhas = [...v.entradas, ...v.resolvidos, ...v.backlog].filter((t) => (ids.has(t.id) ? false : (ids.add(t.id), true))).sort((a, b) => b.id - a.id);
  return {
    nome: "Analítico",
    colunas: ["Nº", "Assunto", "Status", "Setor", "Equipe", "Serviço", "Categoria", "Urgência", "Canal", "Responsável", "Solicitante", "Departamento", "Aberto em", "1ª resposta em", "Encerrado em", "Prazo de solução", "No prazo (solução)", "No prazo (1ª resposta)", "Vencido agora", "Horas até resolver", "Horas até 1ª resposta", "Reaberturas", "Interações públicas", "Triagem IA"],
    linhas: linhas.map((t) => [
      t.id, t.assunto, t.status, t.setor, t.equipe, t.servico, t.categoria, t.urgencia, ORIGEM_ROTULO[t.origem], t.responsavel, t.solicitante, t.departamento,
      dataHora(t.criadoEm), dataHora(t.primeiraRespostaEm), dataHora(t.encerradoEm), dataHora(t.slaSolucaoAte),
      simNao(noPrazoSolucao(t)), simNao(noPrazoResposta(t)), vencido(t, v.agora) ? "Sim" : "Não",
      h1(horasEntre(t.criadoEm, t.encerradoEm)), h1(horasEntre(t.criadoEm, t.primeiraRespostaEm)), t.reaberturas, t.acoesPublicas, t.ia ?? "",
    ]),
  };
}

/** Sintético: agrupado por uma dimensão. */
export function tabelaSintetica(v: Visao, d: Dimensao): Tabela {
  const grupos = d === "mes" ? agrupar(v.tickets, "mes", v.filtros, v.agora) : v.grupos[d];
  return {
    nome: `Sintético por ${DIMENSOES[d]}`,
    colunas: [DIMENSOES[d], "Entradas", "Resolvidos", "Backlog", "Vencidos", "Sem responsável", "SLA solução (%)", "TMR (h)"],
    linhas: grupos.map((g) => [g.chave, g.entradas, g.resolvidos, g.backlog, g.vencidos, g.semResponsavel, g.slaSolucaoPct, h1(g.tmrHoras)]),
  };
}

/** Consolidado: KPIs por setor e o total. */
export function tabelaConsolidada(v: Visao): Tabela {
  const k = v.kpis;
  return {
    nome: "Consolidado",
    colunas: ["Setor", "Entradas", "Resolvidos", "Taxa de resolução (%)", "Backlog", "Vencidos", "Sem responsável", "SLA solução (%)", "TMR (h)"],
    linhas: [
      ...v.grupos.setor.map((g) => [g.chave, g.entradas, g.resolvidos, g.entradas ? Math.round((1000 * g.resolvidos) / g.entradas) / 10 : null, g.backlog, g.vencidos, g.semResponsavel, g.slaSolucaoPct, h1(g.tmrHoras)]),
      ["Total", k.entradas, k.resolvidos, k.taxaResolucaoPct, k.backlog, k.vencidos, k.semResponsavel, k.slaSolucaoPct, h1(k.tmrHoras)],
    ],
  };
}

/** Comparativo: período atual × anterior, KPI a KPI. */
export function tabelaComparativa(v: Visao): Tabela {
  const linhas: [string, number | null, number | null][] = [
    ["Entradas", v.kpis.entradas, v.kpisAnterior.entradas],
    ["Resolvidos", v.kpis.resolvidos, v.kpisAnterior.resolvidos],
    ["Cancelados", v.kpis.cancelados, v.kpisAnterior.cancelados],
    ["Taxa de resolução (%)", v.kpis.taxaResolucaoPct, v.kpisAnterior.taxaResolucaoPct],
    ["Backlog no fim", v.kpis.backlog, v.kpisAnterior.backlog],
    ["Vencidos no fim", v.kpis.vencidos, v.kpisAnterior.vencidos],
    ["Sem responsável no fim", v.kpis.semResponsavel, v.kpisAnterior.semResponsavel],
    ["SLA solução (%)", v.kpis.slaSolucaoPct, v.kpisAnterior.slaSolucaoPct],
    ["SLA 1ª resposta (%)", v.kpis.slaRespostaPct, v.kpisAnterior.slaRespostaPct],
    ["TMR (h)", h1(v.kpis.tmrHoras), h1(v.kpisAnterior.tmrHoras)],
    ["TPR (h)", h1(v.kpis.tprHoras), h1(v.kpisAnterior.tprHoras)],
    ["Reabertura (%)", v.kpis.reaberturaPct, v.kpisAnterior.reaberturaPct],
    ["Triagem automática (%)", v.kpis.iaAutomaticaPct, v.kpisAnterior.iaAutomaticaPct],
  ];
  return {
    nome: "Comparativo",
    colunas: ["Indicador", `Atual (${v.filtros.de} a ${v.filtros.ate})`, `Anterior (${v.anterior.de} a ${v.anterior.ate})`, "Diferença", "Variação (%)"],
    linhas: linhas.map(([n, a, b]) => [n, a, b, a === null || b === null ? null : Math.round((a - b) * 10) / 10, a === null || b === null || b === 0 ? null : Math.round((1000 * (a - b)) / Math.abs(b)) / 10]),
  };
}

export function tabelaIndicadores(v: Visao): Tabela {
  return {
    nome: "Indicadores",
    colunas: ["Indicador", "Valor", "Meta", "Unidade", "Situação", "Anterior", "Variação (%)", "Atingimento (%)"],
    linhas: v.indicadores.map((i) => [i.label, i.valor === null ? null : Math.round(i.valor * 10) / 10, i.meta, i.unidade, i.semaforo, i.anterior === null ? null : Math.round(i.anterior * 10) / 10, i.variacaoPct, i.atingimentoPct]),
  };
}

export function tabelaProdutividade(v: Visao): Tabela {
  return {
    nome: "Produtividade",
    colunas: ["Responsável", "Resolvidos", "Backlog", "Vencidos", "SLA solução (%)", "TMR (h)", "Interações por ticket"],
    linhas: v.produtividade.map((p) => [p.responsavel, p.resolvidos, p.backlog, p.vencidos, p.slaSolucaoPct, h1(p.tmrHoras), h1(p.esforcoMedio)]),
  };
}

export function tabelaMensal(v: Visao): Tabela {
  return {
    nome: "Mensal",
    colunas: ["Mês", "Entradas", "Resolvidos", "Backlog no fim", "SLA solução (%)", "TMR (h)"],
    linhas: v.mensal.map((m) => [m.rotulo, m.entradas, m.resolvidos, m.backlogFim, m.slaSolucaoPct, h1(m.tmrHoras)]),
  };
}

export function tabelaAlertas(v: Visao): Tabela {
  return {
    nome: "Alertas",
    colunas: ["Nível", "Alerta", "Valor", "Limite", "Unidade", "Detalhe"],
    linhas: v.alertas.map((a) => [a.nivel, a.titulo, a.valor, a.limite, a.unidade, a.texto]),
  };
}

/** Pasta completa: todas as abas. */
export function pastaCompleta(v: Visao): Tabela[] {
  return [tabelaIndicadores(v), tabelaConsolidada(v), tabelaComparativa(v), tabelaMensal(v), tabelaSintetica(v, "equipe"), tabelaSintetica(v, "servico"), tabelaSintetica(v, "origem"), tabelaProdutividade(v), tabelaAlertas(v), tabelaAnalitica(v)];
}
