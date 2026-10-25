import { entradasNoPeriodo, horasEntre, resolvidosNoPeriodo, semaforo, variacaoPct } from "../calculos";
import { KpiGer, Secao, Semaforo, Tabela, Variacao, type Coluna } from "../componentes";
import { fmtHoras, fmtNum, fmtPct } from "../graficos";
import { useVisao } from "../hooks";
import type { Semaforo as Tom, TicketGerencial } from "../types";

interface Kpi {
  chave: string;
  label: string;
  valor: number | null;
  anterior: number | null;
  fmt: (n: number | null) => string;
  /** Meta ou limite; sem meta, o KPI não tem semáforo. */
  meta?: number;
  maiorMelhor: boolean;
  hint: string;
}

interface GrupoKpi {
  titulo: string;
  descricao: string;
  itens: Kpi[];
}

const media = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const tempoAteAssumir = (entradas: TicketGerencial[]) => media(entradas.map((t) => horasEntre(t.criadoEm, t.assumidoEm)).filter((h): h is number => h !== null));
const primeiroContatoPct = (resolvidos: TicketGerencial[]) => (resolvidos.length ? Math.round((1000 * resolvidos.filter((t) => t.acoesPublicas <= 1).length) / resolvidos.length) / 10 : null);
const pct = (parte: number, total: number) => (total ? Math.round((1000 * parte) / total) / 10 : null);

/** KPIs: medir desempenho (SLA, prazo médio, custo médio em esforço, conversão e inadimplência de prazo). */
export function Kpis() {
  const v = useVisao();
  const k = v.kpis;
  const a = v.kpisAnterior;
  const entAnt = entradasNoPeriodo(v.tickets, v.anterior);
  const resAnt = resolvidosNoPeriodo(v.tickets, v.anterior);
  const h = (n: number | null) => fmtHoras(n);
  const p = (n: number | null) => fmtPct(n);
  const n1 = (n: number | null) => fmtNum(n, 1);
  const n0 = (n: number | null) => fmtNum(n);

  const grupos: GrupoKpi[] = [
    {
      titulo: "SLA",
      descricao: "Quanto do que foi entregue ficou dentro do prazo combinado.",
      itens: [
        { chave: "sla_solucao", label: "SLA de solução", valor: k.slaSolucaoPct, anterior: a.slaSolucaoPct, fmt: p, meta: v.metas.sla_solucao_pct, maiorMelhor: true, hint: "Resolvidos dentro do prazo de solução" },
        { chave: "sla_resposta", label: "SLA de 1ª resposta", valor: k.slaRespostaPct, anterior: a.slaRespostaPct, fmt: p, meta: v.metas.sla_resposta_pct, maiorMelhor: true, hint: "Primeira resposta dentro do prazo" },
        { chave: "vencidos", label: "Abertos com SLA vencido", valor: k.vencidos, anterior: a.vencidos, fmt: n0, meta: v.metas.vencidos_max, maiorMelhor: false, hint: "Backlog com prazo de solução estourado" },
      ],
    },
    {
      titulo: "Prazo médio",
      descricao: "Tempo que o solicitante espera, em horas corridas.",
      itens: [
        { chave: "tmr", label: "Tempo médio de resolução", valor: k.tmrHoras, anterior: a.tmrHoras, fmt: h, meta: v.metas.tmr_horas, maiorMelhor: false, hint: "Da abertura ao encerramento" },
        { chave: "tpr", label: "Tempo médio de 1ª resposta", valor: k.tprHoras, anterior: a.tprHoras, fmt: h, meta: v.metas.tpr_horas, maiorMelhor: false, hint: "Da abertura à primeira resposta pública" },
        { chave: "assumir", label: "Tempo até assumir", valor: tempoAteAssumir(v.entradas), anterior: tempoAteAssumir(entAnt), fmt: h, maiorMelhor: false, hint: "Da abertura até alguém ficar responsável" },
        { chave: "mais_antigo", label: "Ticket mais antigo", valor: k.maisAntigoDias, anterior: a.maisAntigoDias, fmt: (n) => (n === null ? "—" : `${fmtNum(n)} dias`), meta: v.metas.parado_dias * 2, maiorMelhor: false, hint: "Idade do aberto há mais tempo" },
      ],
    },
    {
      titulo: "Custo médio (esforço)",
      descricao: "Os tickets não registram valores em dinheiro; o custo é medido em trabalho e carga.",
      itens: [
        { chave: "esforco", label: "Interações por ticket resolvido", valor: k.esforcoMedio, anterior: a.esforcoMedio, fmt: n1, maiorMelhor: false, hint: "Idas e vindas públicas até resolver" },
        { chave: "interacoes", label: "Interações no período", valor: v.resolvidos.reduce((s, t) => s + t.acoesPublicas, 0), anterior: resAnt.reduce((s, t) => s + t.acoesPublicas, 0), fmt: n0, maiorMelhor: false, hint: "Soma das interações dos resolvidos" },
        { chave: "carga", label: "Carga média por agente", valor: v.produtividade.length ? Math.round((10 * k.backlog) / v.produtividade.length) / 10 : null, anterior: null, fmt: n1, maiorMelhor: false, hint: `${fmtNum(k.backlog)} abertos ÷ ${v.produtividade.length} agentes` },
        { chave: "por_agente", label: "Resolvidos por agente", valor: v.produtividade.length ? Math.round((10 * k.resolvidos) / v.produtividade.length) / 10 : null, anterior: null, fmt: n1, maiorMelhor: true, hint: "No período" },
      ],
    },
    {
      titulo: "Conversão",
      descricao: "Quanto do que entra vira solução, e com quanto trabalho manual.",
      itens: [
        { chave: "taxa_resolucao", label: "Taxa de resolução", valor: k.taxaResolucaoPct, anterior: a.taxaResolucaoPct, fmt: p, meta: 100, maiorMelhor: true, hint: "Resolvidos ÷ entradas" },
        { chave: "primeiro_contato", label: "Resolução no 1º contato", valor: primeiroContatoPct(v.resolvidos), anterior: primeiroContatoPct(resAnt), fmt: p, maiorMelhor: true, hint: "Resolvidos com uma única interação" },
        { chave: "ia", label: "Triagem automática (IA)", valor: k.iaAutomaticaPct, anterior: a.iaAutomaticaPct, fmt: p, maiorMelhor: true, hint: "Entradas classificadas sem revisão" },
        { chave: "cancelados", label: "Cancelados", valor: pct(k.cancelados, k.entradas), anterior: pct(a.cancelados, a.entradas), fmt: p, maiorMelhor: false, hint: "Entradas que não viraram solução" },
      ],
    },
    {
      titulo: "Inadimplência de prazo",
      descricao: "O que já estourou ou voltou: prazos vencidos, entregas fora do prazo e reaberturas.",
      itens: [
        { chave: "backlog_vencido", label: "Backlog vencido", valor: pct(k.vencidos, k.backlog), anterior: pct(a.vencidos, a.backlog), fmt: p, maiorMelhor: false, hint: "Abertos com prazo estourado ÷ abertos" },
        { chave: "fora_prazo", label: "Resolvidos fora do prazo", valor: k.slaSolucaoPct === null ? null : Math.round((100 - k.slaSolucaoPct) * 10) / 10, anterior: a.slaSolucaoPct === null ? null : Math.round((100 - a.slaSolucaoPct) * 10) / 10, fmt: p, meta: 100 - v.metas.sla_solucao_pct, maiorMelhor: false, hint: "Complemento do SLA de solução" },
        { chave: "reabertura", label: "Taxa de reabertura", valor: k.reaberturaPct, anterior: a.reaberturaPct, fmt: p, meta: v.metas.reabertura_pct_max, maiorMelhor: false, hint: "Resolvidos que voltaram a abrir" },
        { chave: "parados", label: "Tickets parados", valor: k.parados, anterior: a.parados, fmt: n0, meta: 0, maiorMelhor: false, hint: `Sem ação há mais de ${v.metas.parado_dias} dias` },
      ],
    },
  ];

  const tom = (i: Kpi): Tom | undefined => (i.meta === undefined ? undefined : i.meta === 0 ? (i.valor === null ? "cinza" : i.valor > 0 ? "vermelho" : "verde") : semaforo(i.valor, i.meta, i.maiorMelhor));
  type Linha = Kpi & { grupo: string };
  const linhas: Linha[] = grupos.flatMap((g) => g.itens.map((i) => ({ ...i, grupo: g.titulo })));
  const colunas: Coluna<Linha>[] = [
    { chave: "grupo", label: "Grupo", valor: (l) => l.grupo },
    { chave: "label", label: "KPI", valor: (l) => l.label },
    { chave: "valor", label: "Atual", num: true, valor: (l) => l.valor, render: (l) => l.fmt(l.valor) },
    { chave: "anterior", label: "Período anterior", num: true, valor: (l) => l.anterior, render: (l) => l.fmt(l.anterior) },
    { chave: "variacao", label: "Variação", num: true, valor: (l) => variacaoPct(l.valor, l.anterior), render: (l) => <Variacao pct={variacaoPct(l.valor, l.anterior)} maiorMelhor={l.maiorMelhor} sufixo="" /> },
    { chave: "meta", label: "Meta / limite", num: true, valor: (l) => l.meta ?? null, render: (l) => (l.meta === undefined ? "—" : `${l.maiorMelhor ? "≥" : "≤"} ${l.fmt(l.meta)}`) },
    { chave: "situacao", label: "Situação", valor: (l) => tom(l) ?? null, render: (l) => (tom(l) ? <Semaforo tom={tom(l)!} /> : <span className="ds-muted">sem meta</span>) },
  ];

  return (
    <>
      {grupos.map((g) => (
        <Secao key={g.titulo} titulo={g.titulo} subtitulo={g.descricao}>
          <div className="ds-kpis">
            {g.itens.map((i) => (
              <KpiGer key={i.chave} label={i.label} valor={i.fmt(i.valor)} tom={tom(i)} variacao={i.anterior === null ? undefined : variacaoPct(i.valor, i.anterior)} maiorMelhor={i.maiorMelhor} hint={i.hint} />
            ))}
          </div>
        </Secao>
      ))}

      <Secao titulo="Todos os KPIs" subtitulo="Atual, período anterior de mesma duração, variação e meta. Metas em Indicadores.">
        <Tabela colunas={colunas} linhas={linhas} chave={(l) => l.chave} />
      </Secao>
    </>
  );
}
