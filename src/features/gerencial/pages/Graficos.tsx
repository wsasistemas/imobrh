import { DIAS_SEMANA, histogramaSolucao, mapaCalor, pareto } from "../calculos";
import { Secao } from "../componentes";
import { CORES, fmtDia, fmtHoras, fmtNum, fmtPct, GraficoBarras, GraficoColunas, GraficoDonut, GraficoLinha, GraficoMapaCalor, GraficoPareto } from "../graficos";
import { useVisao } from "../hooks";

const HORAS = Array.from({ length: 13 }, (_, i) => 7 + i);

/** Gráficos: facilitar a interpretação (linha, barras, pizza, waterfall, linha do tempo e mapa de calor). */
export function Graficos() {
  const v = useVisao();
  const m = v.mensal;
  const par = pareto(v.grupos.servico);
  const hist = histogramaSolucao(v.resolvidos);
  const calor = mapaCalor(v.entradas);
  const k = v.kpis;
  const inicio = v.diaria.length ? v.diaria[0].backlog - v.diaria[0].entradas + v.diaria[0].resolvidos : 0;
  // Waterfall (ponte do backlog): início → +entradas → −resolvidos → −cancelados → fim.
  const ponte = [
    { rotulo: "Backlog no início", valor: Math.max(0, inicio), cor: CORES[0] },
    { rotulo: "+ Entradas", valor: k.entradas, cor: CORES[2] },
    { rotulo: "− Resolvidos", valor: k.resolvidos, cor: CORES[1] },
    { rotulo: "− Cancelados", valor: k.cancelados, cor: CORES[3] },
    { rotulo: "Backlog no fim", valor: k.backlog, cor: CORES[0] },
  ];
  const semana = DIAS_SEMANA.map((d, i) => ({ rotulo: d, valor: calor[i].reduce((s, x) => s + x, 0) }));

  return (
    <>
      <div className="ger-grid ger-grid--2">
        <Secao titulo="Linha: entradas e resolvidos por dia" subtitulo="Ritmo do período. Quando resolvidos ficam abaixo das entradas, o backlog cresce.">
          <GraficoLinha titulo="Entradas e resolvidos por dia" rotulos={v.diaria.map((p) => fmtDia(p.dia))} series={[{ nome: "Entradas", valores: v.diaria.map((p) => p.entradas) }, { nome: "Resolvidos", valores: v.diaria.map((p) => p.resolvidos) }]} formato={(x) => fmtNum(x)} />
        </Secao>
        <Secao titulo="Linha: SLA e TMR por mês" subtitulo="Treze meses, com as metas tracejadas.">
          <GraficoLinha titulo="SLA de solução por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "SLA solução", valores: m.map((p) => p.slaSolucaoPct ?? NaN) }, { nome: "Meta", valores: m.map(() => v.metas.sla_solucao_pct), tracejada: true }]} formato={(x) => fmtPct(x)} altura={150} />
          <GraficoLinha titulo="TMR por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "TMR (h)", valores: m.map((p) => (p.tmrHoras === null ? NaN : Math.round(p.tmrHoras * 10) / 10)) }, { nome: "Meta", valores: m.map(() => v.metas.tmr_horas), tracejada: true }]} formato={(x) => fmtHoras(x)} altura={150} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Barras: Pareto de serviços" subtitulo="Poucos serviços concentram a maior parte da demanda: os que somam 80% vêm destacados.">
          <GraficoPareto titulo="Pareto de entradas por serviço" itens={par} />
        </Secao>
        <Secao titulo="Barras: equipes e departamentos" subtitulo="Entradas no período.">
          <GraficoBarras titulo="Entradas por equipe" itens={v.grupos.equipe.slice(0, 6).map((g) => ({ rotulo: g.chave, valor: g.entradas, detalhe: `${g.backlog} abertos` }))} />
          <GraficoBarras titulo="Entradas por departamento" itens={v.grupos.departamento.slice(0, 6).map((g) => ({ rotulo: g.chave, valor: g.entradas, detalhe: `${g.backlog} abertos` }))} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--3">
        <Secao titulo="Pizza: canal" subtitulo="Entradas por canal no período.">
          <GraficoDonut titulo="Entradas por canal" itens={v.grupos.origem.map((g) => ({ rotulo: g.chave, valor: g.entradas }))} centro="entradas" />
        </Secao>
        <Secao titulo="Pizza: categoria" subtitulo="Problema, solicitação, dúvida…">
          <GraficoDonut titulo="Entradas por categoria" itens={v.grupos.categoria.map((g) => ({ rotulo: g.chave, valor: g.entradas }))} centro="entradas" />
        </Secao>
        <Secao titulo="Pizza: urgência" subtitulo="Como a demanda se distribui em prioridade.">
          <GraficoDonut titulo="Entradas por urgência" itens={v.grupos.urgencia.map((g) => ({ rotulo: g.chave, valor: g.entradas }))} centro="entradas" />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Waterfall: ponte do backlog" subtitulo="De onde o backlog do fim do período veio.">
          <GraficoBarras titulo="Ponte do backlog" itens={ponte} />
        </Secao>
        <Secao titulo="Colunas: tempo até resolver" subtitulo="Quantos resolvidos caem em cada faixa de tempo (horas corridas).">
          <GraficoColunas titulo="Distribuição do tempo de resolução" rotulos={hist.map((x) => x.faixa)} series={[{ nome: "Resolvidos", valores: hist.map((x) => x.total) }]} rotulosDiretos />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Linha do tempo: entradas e backlog por dia" subtitulo="Entradas por dia, com o backlog no fim de cada dia.">
          <GraficoColunas titulo="Entradas por dia" rotulos={v.diaria.map((p) => fmtDia(p.dia))} series={[{ nome: "Entradas", valores: v.diaria.map((p) => p.entradas) }]} />
          <GraficoLinha titulo="Backlog no fim do dia" rotulos={v.diaria.map((p) => fmtDia(p.dia))} series={[{ nome: "Backlog", valores: v.diaria.map((p) => p.backlog) }]} altura={140} formato={(x) => fmtNum(x)} />
        </Secao>
        <Secao titulo="Linha do tempo: 13 meses" subtitulo="Entradas, resolvidos e backlog no fim de cada mês.">
          <GraficoColunas titulo="Entradas e resolvidos por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Entradas", valores: m.map((p) => p.entradas) }, { nome: "Resolvidos", valores: m.map((p) => p.resolvidos) }]} />
          <GraficoLinha titulo="Backlog no fim do mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Backlog", valores: m.map((p) => p.backlogFim) }]} altura={140} formato={(x) => fmtNum(x)} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--21">
        <Secao titulo="Mapa de calor: dia × hora" subtitulo="Entradas por dia da semana e hora (7h às 19h).">
          <GraficoMapaCalor titulo="Entradas por dia da semana e hora" matriz={calor.map((l) => HORAS.map((hh) => l[hh]))} linhas={DIAS_SEMANA} colunas={HORAS.map((hh) => `${hh}h`)} />
        </Secao>
        <Secao titulo="Barras: dia da semana" subtitulo="Soma do período.">
          <GraficoBarras titulo="Entradas por dia da semana" itens={semana} />
        </Secao>
      </div>
    </>
  );
}
