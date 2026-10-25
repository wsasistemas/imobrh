import { CalendarRange, CircleCheckBig, CircleDot, Layers, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { ThLabel } from "../../../components/ds/ThLabel";
import { getMenuItem } from "../../../config/menuRegistry";
import { projecao, serieDiaria, somarDias, variacaoPct } from "../calculos";
import { KpiGer, Secao, Semaforo } from "../componentes";
import { fmtHoras, fmtNum, fmtPct, GraficoBarras, GraficoColunas, GraficoDonut, GraficoLinha, Medidor } from "../graficos";
import { useVisao } from "../hooks";

/** Dashboard Estratégico: apoiar decisões (metas, tendência de 13 meses, crescimento, capacidade e projeções). */
export function DashboardEstrategico() {
  const v = useVisao();
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const m = v.mensal;
  const atual = m[m.length - 1];
  const anterior = m[m.length - 2];
  const anoPassado = m[m.length - 13];
  const ult3 = m.slice(-3);
  const ant3 = m.slice(-6, -3);
  const soma = (l: typeof m, f: (p: (typeof m)[number]) => number) => l.reduce((s, p) => s + f(p), 0);
  const cresc3m = variacaoPct(soma(ult3, (p) => p.entradas), soma(ant3, (p) => p.entradas));
  const ult12 = m.slice(-12);
  const entradas12 = soma(ult12, (p) => p.entradas);
  const resolvidos12 = soma(ult12, (p) => p.resolvidos);

  // Projeção de 30/60/90 dias sobre as últimas 8 semanas (mesmo método da tela Projeções).
  const historico = useMemo(() => serieDiaria(v.tickets, { de: somarDias(v.hoje, -55), ate: v.hoje }, v.agora), [v.tickets, v.hoje, v.agora]);
  const backlogHoje = historico.length ? historico[historico.length - 1].backlog : v.kpis.backlog;
  const proj = useMemo(
    () =>
      [30, 60, 90].map((d) => {
        const p = projecao(historico, d, backlogHoje, 1);
        return { horizonte: d, ...p, entradasTotal: p.dias.reduce((s, x) => s + x.entradas, 0), resolvidosTotal: p.dias.reduce((s, x) => s + x.resolvidos, 0) };
      }),
    [historico, backlogHoje],
  );
  const p30 = proj[0];
  const faltaCapacidade = p30.entradasPorDia > p30.capacidadePorDia;

  // Capacidade e esforço: o "custo" operacional que os tickets registram é tempo e interações, não dinheiro.
  const interacoesTotais = v.resolvidos.reduce((s, t) => s + t.acoesPublicas, 0);
  const foraDaMeta = v.indicadores.filter((i) => i.semaforo === "vermelho").length;

  return (
    <>
      <div className="ds-kpis">
        <KpiGer label={`Entradas em ${atual?.rotulo ?? "—"}`} valor={fmtNum(atual?.entradas ?? 0)} variacao={variacaoPct(atual?.entradas ?? null, anterior?.entradas ?? null)} maiorMelhor={false} />
        <KpiGer label="Mês × mesmo mês do ano anterior" valor={fmtNum(atual?.entradas ?? 0)} variacao={variacaoPct(atual?.entradas ?? null, anoPassado?.entradas ?? null)} maiorMelhor={false} />
        <KpiGer label="Último trimestre × anterior" valor={fmtNum(soma(ult3, (p) => p.entradas))} variacao={cresc3m} maiorMelhor={false} />
        <KpiGer label="Últimos 12 meses" valor={fmtNum(entradas12)} unidade="entradas" hint={`${fmtNum(resolvidos12)} resolvidos (${fmtPct(entradas12 ? (100 * resolvidos12) / entradas12 : null)})`} />
        <KpiGer label="Backlog no fim do mês" valor={fmtNum(atual?.backlogFim ?? 0)} variacao={variacaoPct(atual?.backlogFim ?? null, anterior?.backlogFim ?? null)} maiorMelhor={false} />
        <KpiGer label="Metas fora" valor={fmtNum(foraDaMeta)} unidade={`de ${v.indicadores.length}`} tom={foraDaMeta === 0 ? "verde" : foraDaMeta <= 2 ? "amarelo" : "vermelho"} hint="Indicadores em vermelho no período" />
      </div>
      <div className="ds-kpis">
        <KpiGer label="SLA de solução no mês" valor={fmtPct(atual?.slaSolucaoPct)} variacao={variacaoPct(atual?.slaSolucaoPct ?? null, anterior?.slaSolucaoPct ?? null)} maiorMelhor />
        <KpiGer label="TMR no mês" valor={fmtHoras(atual?.tmrHoras)} variacao={variacaoPct(atual?.tmrHoras ?? null, anterior?.tmrHoras ?? null)} maiorMelhor={false} />
        <KpiGer label="Demanda por dia" valor={fmtNum(p30.entradasPorDia, 1)} unidade="entradas" hint={`Tendência ${p30.tendenciaPorDia >= 0 ? "+" : ""}${fmtNum(p30.tendenciaPorDia, 2)}/dia (8 semanas)`} />
        <KpiGer label="Capacidade por dia útil" valor={fmtNum(p30.capacidadePorDia, 1)} unidade="resolvidos" tom={faltaCapacidade ? "vermelho" : "verde"} hint={faltaCapacidade ? `Faltam ${fmtNum(p30.entradasPorDia - p30.capacidadePorDia, 1)}/dia` : "Dá conta da demanda"} />
        <KpiGer label="Backlog projetado (30 dias)" valor={fmtNum(p30.backlogFinal)} tom={p30.backlogFinal > v.metas.backlog_max ? "vermelho" : p30.backlogFinal > backlogHoje ? "amarelo" : "verde"} hint={`Hoje: ${fmtNum(backlogHoje)}`} />
        <KpiGer label="Esforço no período" valor={fmtNum(interacoesTotais)} unidade="interações" hint={`${fmtNum(v.kpis.esforcoMedio, 1)} por ticket resolvido`} />
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Demanda × capacidade (13 meses)" subtitulo="Entradas e resolvidos por mês. Quando as linhas se cruzam, o backlog muda de direção.">
          <GraficoLinha titulo="Entradas e resolvidos por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Entradas", valores: m.map((p) => p.entradas) }, { nome: "Resolvidos", valores: m.map((p) => p.resolvidos) }]} formato={(x) => fmtNum(x)} />
        </Secao>
        <Secao titulo="Backlog no fim de cada mês" subtitulo="O que sobrou aberto quando o mês virou.">
          <GraficoColunas titulo="Backlog no fim do mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Backlog", valores: m.map((p) => p.backlogFim) }]} rotulosDiretos />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="SLA de solução por mês" subtitulo={`Meta: ${v.metas.sla_solucao_pct}%.`}>
          <GraficoLinha titulo="SLA de solução por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "SLA solução", valores: m.map((p) => p.slaSolucaoPct ?? NaN) }, { nome: "Meta", valores: m.map(() => v.metas.sla_solucao_pct), tracejada: true }]} formato={(x) => fmtPct(x)} />
        </Secao>
        <Secao titulo="Tempo médio de resolução por mês" subtitulo={`Meta: ${v.metas.tmr_horas} h.`}>
          <GraficoLinha titulo="TMR por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "TMR (h)", valores: m.map((p) => (p.tmrHoras === null ? NaN : Math.round(p.tmrHoras * 10) / 10)) }, { nome: "Meta", valores: m.map(() => v.metas.tmr_horas), tracejada: true }]} formato={(x) => fmtHoras(x)} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--3">
        <Secao titulo="Mix por canal" subtitulo="Por onde a demanda chega no período.">
          <GraficoDonut titulo="Entradas por canal" itens={v.grupos.origem.map((g) => ({ rotulo: g.chave, valor: g.entradas }))} centro="entradas" />
        </Secao>
        <Secao titulo="Demanda por setor" subtitulo="Entradas no período.">
          <GraficoBarras titulo="Entradas por setor" itens={v.grupos.setor.map((g) => ({ rotulo: g.chave, valor: g.entradas, detalhe: `${fmtPct(g.slaSolucaoPct)} no prazo` }))} />
        </Secao>
        <Secao titulo="Atingimento das metas" subtitulo="100% = na meta." aside={<Link className="ds-linkbtn" to={{ pathname: `${base}/indicadores`, search: location.search }}>Indicadores →</Link>}>
          <div className="ger-lista">
            {v.indicadores.map((i) => (
              <div key={i.chave}>
                <div className="ds-row" style={{ fontSize: 13, marginBottom: 4 }}>
                  <span>{i.label}</span>
                  <Semaforo tom={i.semaforo}>{i.atingimentoPct === null ? "—" : `${i.atingimentoPct}%`}</Semaforo>
                </div>
                <Medidor pct={i.atingimentoPct} tom={i.semaforo} />
              </div>
            ))}
          </div>
        </Secao>
      </div>

      <div className="ger-grid ger-grid--21">
        <Secao titulo="Projeção de demanda e backlog" subtitulo="Tendência das últimas 8 semanas com a capacidade atual." aside={<Link className="ds-linkbtn" to={{ pathname: `${base}/projecoes`, search: location.search }}>Cenários →</Link>}>
          <div className="ger-tabela__rolagem">
            <table className="ger-tabela">
              <thead>
                <tr>
                  <th><ThLabel icon={CalendarRange}>Horizonte</ThLabel></th>
                  <th className="num"><ThLabel icon={TrendingUp}>Entradas previstas</ThLabel></th>
                  <th className="num"><ThLabel icon={CircleCheckBig}>Capacidade (resolvidos)</ThLabel></th>
                  <th className="num"><ThLabel icon={Layers}>Backlog projetado</ThLabel></th>
                  <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
                </tr>
              </thead>
              <tbody>
                {proj.map((p) => (
                  <tr key={p.horizonte}>
                    <td>{p.horizonte} dias</td>
                    <td className="num">{fmtNum(p.entradasTotal)}</td>
                    <td className="num">{fmtNum(p.resolvidosTotal)}</td>
                    <td className="num">{fmtNum(p.backlogFinal)}</td>
                    <td>
                      <Semaforo tom={p.backlogFinal > v.metas.backlog_max ? "vermelho" : p.backlogFinal > backlogHoje ? "amarelo" : "verde"}>{p.diasParaZerar === null ? (p.backlogFinal > backlogHoje ? "Backlog cresce" : "Backlog cai") : `Zera em ${p.diasParaZerar} dias`}</Semaforo>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ger-nota">Confiabilidade {p30.confiabilidade} ({historico.length} dias de histórico). Não considera feriados nem campanhas.</p>
        </Secao>
        <Secao titulo="Capacidade e esforço" subtitulo="O que os tickets registram de custo é tempo e trabalho; valores em dinheiro não são cadastrados.">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
            <li><b>Resolvidos por dia útil:</b> {fmtNum(p30.capacidadePorDia, 1)} (média das últimas 8 semanas).</li>
            <li><b>Entradas por dia:</b> {fmtNum(p30.entradasPorDia, 1)}, tendência {p30.tendenciaPorDia >= 0 ? "+" : ""}{fmtNum(p30.tendenciaPorDia, 2)} por dia.</li>
            <li><b>Esforço:</b> {fmtNum(interacoesTotais)} interações públicas em {fmtNum(v.kpis.resolvidos)} resolvidos ({fmtNum(v.kpis.esforcoMedio, 1)} por ticket).</li>
            <li><b>Tempo:</b> {fmtHoras(v.kpis.tmrHoras)} em média da abertura ao encerramento; {fmtHoras(v.kpis.tprHoras)} até a primeira resposta.</li>
            <li><b>Automação:</b> {fmtPct(v.kpis.iaAutomaticaPct)} das entradas triadas pela IA sem revisão.</li>
          </ul>
          {faltaCapacidade && <p className="ger-nota">Entram {fmtNum(p30.entradasPorDia, 1)} por dia e saem {fmtNum(p30.capacidadePorDia, 1)}: faltam {fmtNum(p30.entradasPorDia - p30.capacidadePorDia, 1)} resoluções por dia para o backlog parar de crescer.</p>}
        </Secao>
      </div>
    </>
  );
}
