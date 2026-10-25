import { AlertTriangle, Lightbulb } from "lucide-react";
import { Link } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { aging, semaforo, type Produtividade } from "../calculos";
import { KpiGer, Secao, Semaforo, Tabela, type Coluna } from "../componentes";
import { CORES, fmtDia, fmtHoras, fmtNum, fmtPct, GraficoBarras, GraficoDonut, GraficoLinha } from "../graficos";
import { useVisao } from "../hooks";
import type { Grupo } from "../types";

/** Dashboard Gerencial: acompanhar a operação (volumes, status, pendências, filas, equipes e produtividade). */
export function DashboardGerencial() {
  const v = useVisao();
  const k = v.kpis;
  const a = v.kpisAnterior;
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const ind = Object.fromEntries(v.indicadores.map((i) => [i.chave, i]));
  const varPct = (atual: number, anterior: number) => (anterior ? Math.round((1000 * (atual - anterior)) / anterior) / 10 : null);
  const status = ["novo", "andamento", "pendente"].map((c) => ({ rotulo: c === "novo" ? "Novo" : c === "andamento" ? "Em andamento" : "Pendente", valor: v.backlog.filter((t) => t.categoriaStatus === c).length }));
  const porStatus = [...new Set(v.backlog.map((t) => t.status))].map((s) => ({ rotulo: s, valor: v.backlog.filter((t) => t.status === s).length })).sort((x, y) => y.valor - x.valor);
  const pendentes = v.backlog.filter((t) => t.categoriaStatus === "pendente").length;
  const idade = aging(v.backlog, v.agora);
  const criticos = v.alertas.filter((x) => x.nivel !== "ok").slice(0, 3);
  const mensalSpark = (f: (m: (typeof v.mensal)[number]) => number | null) => v.mensal.slice(-6).map((m) => f(m) ?? 0);

  const colunasEquipe: Coluna<Grupo>[] = [
    { chave: "chave", label: "Equipe", valor: (g) => g.chave },
    { chave: "entradas", label: "Entradas", num: true, valor: (g) => g.entradas },
    { chave: "resolvidos", label: "Resolvidos", num: true, valor: (g) => g.resolvidos },
    { chave: "backlog", label: "Backlog", num: true, valor: (g) => g.backlog },
    { chave: "vencidos", label: "Vencidos", num: true, valor: (g) => g.vencidos },
    { chave: "semResponsavel", label: "Sem resp.", num: true, valor: (g) => g.semResponsavel },
    { chave: "sla", label: "SLA solução", num: true, valor: (g) => g.slaSolucaoPct, render: (g) => <Semaforo tom={semaforo(g.slaSolucaoPct, v.metas.sla_solucao_pct, true)}>{fmtPct(g.slaSolucaoPct)}</Semaforo> },
    { chave: "tmr", label: "TMR", num: true, valor: (g) => g.tmrHoras, render: (g) => fmtHoras(g.tmrHoras) },
  ];
  const colunasAgente: Coluna<Produtividade>[] = [
    { chave: "responsavel", label: "Agente", valor: (p) => p.responsavel },
    { chave: "resolvidos", label: "Resolvidos", num: true, valor: (p) => p.resolvidos },
    { chave: "backlog", label: "Carga atual", num: true, valor: (p) => p.backlog },
    { chave: "vencidos", label: "Vencidos", num: true, valor: (p) => p.vencidos },
    { chave: "sla", label: "SLA solução", num: true, valor: (p) => p.slaSolucaoPct, render: (p) => <Semaforo tom={semaforo(p.slaSolucaoPct, v.metas.sla_solucao_pct, true)}>{fmtPct(p.slaSolucaoPct)}</Semaforo> },
    { chave: "tmr", label: "TMR", num: true, valor: (p) => p.tmrHoras, render: (p) => fmtHoras(p.tmrHoras) },
    { chave: "esforco", label: "Interações/ticket", num: true, valor: (p) => p.esforcoMedio, render: (p) => fmtNum(p.esforcoMedio, 1) },
  ];

  return (
    <>
      <div className="ds-kpis">
        <KpiGer label="Entradas" valor={fmtNum(k.entradas)} variacao={varPct(k.entradas, a.entradas)} maiorMelhor={false} spark={mensalSpark((m) => m.entradas)} />
        <KpiGer label="Resolvidos" valor={fmtNum(k.resolvidos)} variacao={varPct(k.resolvidos, a.resolvidos)} maiorMelhor spark={mensalSpark((m) => m.resolvidos)} />
        <KpiGer label="Taxa de resolução" valor={fmtPct(k.taxaResolucaoPct)} tom={ind.taxa_resolucao.semaforo} variacao={ind.taxa_resolucao.variacaoPct} maiorMelhor />
        <KpiGer label="Backlog" valor={fmtNum(k.backlog)} unidade="abertos" tom={ind.backlog.semaforo} variacao={ind.backlog.variacaoPct} maiorMelhor={false} spark={mensalSpark((m) => m.backlogFim)} />
        <KpiGer label="SLA vencido" valor={fmtNum(k.vencidos)} unidade="abertos" tom={ind.vencidos.semaforo} variacao={ind.vencidos.variacaoPct} maiorMelhor={false} />
        <KpiGer label="Sem responsável" valor={fmtNum(k.semResponsavel)} unidade="abertos" tom={ind.sem_responsavel.semaforo} variacao={ind.sem_responsavel.variacaoPct} maiorMelhor={false} />
      </div>
      <div className="ds-kpis">
        <KpiGer label="Pendentes" valor={fmtNum(pendentes)} unidade="abertos" hint="Aguardando solicitante ou terceiros" />
        <KpiGer label="Parados" valor={fmtNum(k.parados)} unidade="abertos" hint={`Sem ação há +${v.metas.parado_dias} dias`} tom={k.parados > 0 ? "vermelho" : "verde"} />
        <KpiGer label="Mais antigo" valor={k.maisAntigoDias === null ? "—" : String(k.maisAntigoDias)} unidade="dias" hint="Ticket aberto há mais tempo" tom={k.maisAntigoDias === null ? "cinza" : k.maisAntigoDias > v.metas.parado_dias * 2 ? "vermelho" : "verde"} />
        <KpiGer label="SLA de solução" valor={fmtPct(k.slaSolucaoPct)} tom={ind.sla_solucao.semaforo} variacao={ind.sla_solucao.variacaoPct} maiorMelhor spark={mensalSpark((m) => m.slaSolucaoPct)} />
        <KpiGer label="Tempo médio de resolução" valor={fmtHoras(k.tmrHoras)} tom={ind.tmr.semaforo} variacao={ind.tmr.variacaoPct} maiorMelhor={false} spark={mensalSpark((m) => m.tmrHoras)} />
        <KpiGer label="Esforço médio" valor={fmtNum(k.esforcoMedio, 1)} unidade="interações" hint="Por ticket resolvido" />
      </div>

      <div className="ger-grid ger-grid--21">
        <Secao titulo="Ritmo do período" subtitulo="Tickets que entraram e que foram resolvidos por dia.">
          <GraficoLinha titulo="Entradas e resolvidos por dia" rotulos={v.diaria.map((p) => fmtDia(p.dia))} series={[{ nome: "Entradas", valores: v.diaria.map((p) => p.entradas) }, { nome: "Resolvidos", valores: v.diaria.map((p) => p.resolvidos) }]} formato={(x) => fmtNum(x)} />
        </Secao>
        <Secao titulo="Backlog agora" subtitulo="Abertos por situação.">
          <GraficoDonut titulo="Backlog por situação" itens={status} centro="abertos" />
          <p className="ger-nota">
            Sem responsável: <b>{fmtNum(k.semResponsavel)}</b> · Parados há +{v.metas.parado_dias} dias: <b>{fmtNum(k.parados)}</b> · Mais antigo: <b>{k.maisAntigoDias === null ? "—" : `${k.maisAntigoDias} dias`}</b>
          </p>
        </Secao>
      </div>

      <Secao titulo="Equipes" subtitulo="Volume, fila e desempenho de cada equipe no período.">
        <Tabela colunas={colunasEquipe} linhas={v.grupos.equipe} chave={(g) => g.chave} ordemInicial={{ chave: "backlog", desc: true }} totais={{ entradas: k.entradas, resolvidos: k.resolvidos, backlog: k.backlog, vencidos: k.vencidos, semResponsavel: k.semResponsavel, sla: fmtPct(k.slaSolucaoPct), tmr: fmtHoras(k.tmrHoras) }} />
      </Secao>

      <div className="ger-grid ger-grid--21">
        <Secao titulo="Produtividade por agente" subtitulo="Resolvidos no período e a carga que cada um tem agora.">
          <Tabela colunas={colunasAgente} linhas={v.produtividade} chave={(p) => p.responsavel} ordemInicial={{ chave: "resolvidos", desc: true }} />
        </Secao>
        <Secao titulo="Backlog por equipe" subtitulo="Abertos agora, com os vencidos ao lado.">
          <GraficoBarras titulo="Backlog por equipe" itens={v.grupos.equipe.filter((g) => g.backlog > 0).sort((x, y) => y.backlog - x.backlog).map((g) => ({ rotulo: g.chave, valor: g.backlog, detalhe: g.vencidos ? `${g.vencidos} vencidos` : undefined, cor: g.vencidos > 0 ? CORES[4] : CORES[0] }))} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--3">
        <Secao titulo="Idade do backlog" subtitulo="Há quanto tempo os abertos estão esperando.">
          <GraficoBarras titulo="Backlog por idade" itens={idade.map((f) => ({ rotulo: f.faixa, valor: f.total, detalhe: f.vencidos ? `${f.vencidos} vencidos` : undefined, cor: f.vencidos > 0 ? CORES[4] : CORES[0] }))} />
        </Secao>
        <Secao titulo="Pendências por status" subtitulo="Em que situação os abertos estão.">
          <GraficoBarras titulo="Backlog por status" itens={porStatus} />
        </Secao>
        <Secao titulo="Serviços com mais fila" subtitulo="Backlog por serviço.">
          <GraficoBarras titulo="Backlog por serviço" itens={v.grupos.servico.filter((g) => g.backlog > 0).sort((x, y) => y.backlog - x.backlog).slice(0, 8).map((g) => ({ rotulo: g.chave, valor: g.backlog, detalhe: g.vencidos ? `${g.vencidos} vencidos` : undefined }))} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Alertas" subtitulo={criticos.length ? `${criticos.length} limites ultrapassados.` : "Nenhum limite ultrapassado."} aside={<Link className="ds-linkbtn" to={{ pathname: `${base}/alertas`, search: location.search }}>Ver todos →</Link>}>
          <div className="ger-lista">
            {criticos.length === 0 && <p className="gr-vazio">Tudo dentro dos limites definidos em Indicadores.</p>}
            {criticos.map((al) => (
              <div key={al.id} className={`ger-item ger-item--${al.nivel}`}>
                <span className="ger-item__icone"><AlertTriangle size={16} aria-hidden="true" /></span>
                <div>
                  <b>{al.titulo}</b>
                  <p>{al.texto}</p>
                </div>
                <Semaforo tom={al.nivel === "critico" ? "vermelho" : "amarelo"} />
              </div>
            ))}
          </div>
        </Secao>
        <Secao titulo="Insights" subtitulo="O que os dados estão dizendo." aside={<Link className="ds-linkbtn" to={{ pathname: `${base}/insights`, search: location.search }}>Ver todos →</Link>}>
          <div className="ger-lista">
            {v.insights.length === 0 && <p className="gr-vazio">Nenhum padrão fora do comum neste recorte.</p>}
            {v.insights.slice(0, 3).map((i) => (
              <div key={i.titulo} className={`ger-item ger-item--${i.tipo}`}>
                <span className="ger-item__icone"><Lightbulb size={16} aria-hidden="true" /></span>
                <div>
                  <b>{i.titulo}</b>
                  <p>{i.texto}</p>
                </div>
                <span className="ger-item__lado">{i.tipo}</span>
              </div>
            ))}
          </div>
        </Secao>
      </div>
    </>
  );
}
