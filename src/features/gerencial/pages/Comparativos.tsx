import { variacaoPct, type Indicador } from "../calculos";
import { KpiGer, Secao, Semaforo, Tabela, Variacao, type Coluna } from "../componentes";
import { fmtHoras, fmtNum, fmtPct, GraficoColunas, Medidor } from "../graficos";
import { useVisao } from "../hooks";
import { tabelaComparativa } from "../tabelas";
import type { PontoMensal } from "../types";

type LinhaMes = PontoMensal & { varEntradas: number | null; varResolvidos: number | null; varBacklog: number | null; varSla: number | null; varTmr: number | null };
type LinhaPeriodo = { indicador: string; atual: number | null; anterior: number | null; diferenca: number | null; variacao: number | null; maiorMelhor: boolean };

const PIOR_SE_SOBE = /TMR|TPR|Backlog|Vencidos|Sem responsável|Reabertura|Cancelados/;
const sufixo = (unidade: string) => (unidade === "%" ? "%" : unidade === "h" ? " h" : "");
const fmtValor = (valor: number | null, unidade: string) => (valor === null ? "—" : `${fmtNum(valor, unidade === "h" ? 1 : 0)}${sufixo(unidade)}`);

/** Comparativos: identificar variações (mês × mês, ano × ano, período × anterior e realizado × meta). */
export function Comparativos() {
  const v = useVisao();
  const m = v.mensal;
  const atual = m[m.length - 1];
  const anoPassado = m[m.length - 13];

  const meses: LinhaMes[] = m.map((p, i) => {
    const ant = i > 0 ? m[i - 1] : null;
    return { ...p, varEntradas: variacaoPct(p.entradas, ant?.entradas ?? null), varResolvidos: variacaoPct(p.resolvidos, ant?.resolvidos ?? null), varBacklog: variacaoPct(p.backlogFim, ant?.backlogFim ?? null), varSla: variacaoPct(p.slaSolucaoPct, ant?.slaSolucaoPct ?? null), varTmr: variacaoPct(p.tmrHoras, ant?.tmrHoras ?? null) };
  });
  const colunasMes: Coluna<LinhaMes>[] = [
    { chave: "mes", label: "Mês", valor: (l) => l.mes, render: (l) => l.rotulo },
    { chave: "entradas", label: "Entradas", num: true, valor: (l) => l.entradas },
    { chave: "varEntradas", label: "Δ mês ant.", num: true, valor: (l) => l.varEntradas, render: (l) => <Variacao pct={l.varEntradas} maiorMelhor={false} sufixo="" /> },
    { chave: "resolvidos", label: "Resolvidos", num: true, valor: (l) => l.resolvidos },
    { chave: "varResolvidos", label: "Δ mês ant.", num: true, valor: (l) => l.varResolvidos, render: (l) => <Variacao pct={l.varResolvidos} maiorMelhor sufixo="" /> },
    { chave: "backlogFim", label: "Backlog no fim", num: true, valor: (l) => l.backlogFim },
    { chave: "varBacklog", label: "Δ mês ant.", num: true, valor: (l) => l.varBacklog, render: (l) => <Variacao pct={l.varBacklog} maiorMelhor={false} sufixo="" /> },
    { chave: "sla", label: "SLA solução", num: true, valor: (l) => l.slaSolucaoPct, render: (l) => fmtPct(l.slaSolucaoPct) },
    { chave: "varSla", label: "Δ mês ant.", num: true, valor: (l) => l.varSla, render: (l) => <Variacao pct={l.varSla} maiorMelhor sufixo="" /> },
    { chave: "tmr", label: "TMR", num: true, valor: (l) => l.tmrHoras, render: (l) => fmtHoras(l.tmrHoras) },
    { chave: "varTmr", label: "Δ mês ant.", num: true, valor: (l) => l.varTmr, render: (l) => <Variacao pct={l.varTmr} maiorMelhor={false} sufixo="" /> },
  ];

  const comp = tabelaComparativa(v);
  const periodo: LinhaPeriodo[] = comp.linhas.map((l) => ({ indicador: String(l[0]), atual: l[1] as number | null, anterior: l[2] as number | null, diferenca: l[3] as number | null, variacao: l[4] as number | null, maiorMelhor: !PIOR_SE_SOBE.test(String(l[0])) }));
  const colunasPeriodo: Coluna<LinhaPeriodo>[] = [
    { chave: "indicador", label: "Indicador", valor: (l) => l.indicador },
    { chave: "atual", label: `Atual (${v.filtros.de.split("-").reverse().join("/")} a ${v.filtros.ate.split("-").reverse().join("/")})`, num: true, valor: (l) => l.atual },
    { chave: "anterior", label: `Anterior (${v.anterior.de.split("-").reverse().join("/")} a ${v.anterior.ate.split("-").reverse().join("/")})`, num: true, valor: (l) => l.anterior },
    { chave: "diferenca", label: "Diferença", num: true, valor: (l) => l.diferenca },
    { chave: "variacao", label: "Variação", num: true, valor: (l) => l.variacao, render: (l) => <Variacao pct={l.variacao} maiorMelhor={l.maiorMelhor} sufixo="" /> },
  ];

  const colunasMeta: Coluna<Indicador>[] = [
    { chave: "label", label: "Indicador", valor: (i) => i.label },
    { chave: "valor", label: "Realizado", num: true, valor: (i) => i.valor, render: (i) => fmtValor(i.valor, i.unidade) },
    { chave: "meta", label: "Meta", num: true, valor: (i) => i.meta, render: (i) => `${i.maiorMelhor ? "≥" : "≤"} ${fmtValor(i.meta, i.unidade)}` },
    { chave: "desvio", label: "Desvio", num: true, valor: (i) => (i.valor === null ? null : Math.round((i.valor - i.meta) * 10) / 10), render: (i) => (i.valor === null ? "—" : `${i.valor - i.meta > 0 ? "+" : ""}${fmtValor(Math.round((i.valor - i.meta) * 10) / 10, i.unidade)}`) },
    { chave: "atingimento", label: "Atingimento", num: true, valor: (i) => i.atingimentoPct, render: (i) => <div style={{ minWidth: 140 }}><Medidor pct={i.atingimentoPct} tom={i.semaforo} /><small>{i.atingimentoPct === null ? "—" : `${i.atingimentoPct}%`}</small></div> },
    { chave: "semaforo", label: "Situação", valor: (i) => i.semaforo, render: (i) => <Semaforo tom={i.semaforo} /> },
  ];

  return (
    <>
      <Secao titulo="Mês × mês" subtitulo="Treze meses, cada um comparado com o anterior.">
        <GraficoColunas titulo="Entradas e resolvidos por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Entradas", valores: m.map((p) => p.entradas) }, { nome: "Resolvidos", valores: m.map((p) => p.resolvidos) }]} altura={180} />
        <Tabela colunas={colunasMes} linhas={meses} chave={(l) => l.mes} ordemInicial={{ chave: "mes", desc: true }} />
      </Secao>

      <Secao titulo="Ano × ano" subtitulo={anoPassado ? `${atual.rotulo} comparado com ${anoPassado.rotulo}.` : "Com 13 meses carregados, a comparação cobre o mês atual contra o mesmo mês do ano anterior; ainda não há esse mês no histórico."}>
        {anoPassado ? (
          <div className="ds-kpis">
            <KpiGer label="Entradas" valor={fmtNum(atual.entradas)} hint={`${anoPassado.rotulo}: ${fmtNum(anoPassado.entradas)}`} variacao={variacaoPct(atual.entradas, anoPassado.entradas)} maiorMelhor={false} />
            <KpiGer label="Resolvidos" valor={fmtNum(atual.resolvidos)} variacao={variacaoPct(atual.resolvidos, anoPassado.resolvidos)} maiorMelhor />
            <KpiGer label="Backlog no fim" valor={fmtNum(atual.backlogFim)} variacao={variacaoPct(atual.backlogFim, anoPassado.backlogFim)} maiorMelhor={false} />
            <KpiGer label="SLA de solução" valor={fmtPct(atual.slaSolucaoPct)} variacao={variacaoPct(atual.slaSolucaoPct, anoPassado.slaSolucaoPct)} maiorMelhor />
            <KpiGer label="TMR" valor={fmtHoras(atual.tmrHoras)} variacao={variacaoPct(atual.tmrHoras, anoPassado.tmrHoras)} maiorMelhor={false} />
          </div>
        ) : (
          <p className="gr-vazio">Sem dados do mesmo mês do ano anterior.</p>
        )}
        <p className="ger-nota">O mês atual ainda está em andamento: compare com cautela até ele fechar.</p>
      </Secao>

      <Secao titulo="Período × período anterior" subtitulo="O período filtrado contra o período imediatamente anterior, de mesma duração.">
        <Tabela colunas={colunasPeriodo} linhas={periodo} chave={(l) => l.indicador} />
      </Secao>

      <Secao titulo="Realizado × meta" subtitulo="Cada indicador do período contra a meta cadastrada em Indicadores.">
        <Tabela colunas={colunasMeta} linhas={v.indicadores} chave={(i) => i.chave} />
      </Secao>
    </>
  );
}
