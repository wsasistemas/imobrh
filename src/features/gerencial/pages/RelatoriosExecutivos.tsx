import { Printer } from "lucide-react";
import { variacaoPct } from "../calculos";
import { KpiGer, Secao, Semaforo, Variacao } from "../componentes";
import { imprimir } from "../exportar";
import { fmtHoras, fmtNum, fmtPct, GraficoLinha, Medidor } from "../graficos";
import { useVisao } from "../hooks";

const fmtData = (d: string) => d.split("-").reverse().join("/");

/** Relatórios Executivos: suportar a diretoria (resumo executivo, principais desvios e decisões necessárias). */
export function RelatoriosExecutivos() {
  const v = useVisao();
  const m = v.mensal;
  const atual = m[m.length - 1];
  const anterior = m[m.length - 2];
  const anoPassado = m[m.length - 13];
  const criticos = v.alertas.filter((a) => a.nivel === "critico");
  const atencao = v.alertas.filter((a) => a.nivel === "atencao");
  const decisoes = v.insights.filter((i) => i.tipo === "risco" || i.tipo === "oportunidade").slice(0, 5);
  const tendencias = v.insights.filter((i) => i.tipo === "tendencia" || i.tipo === "anomalia").slice(0, 3);
  const foraDaMeta = v.indicadores.filter((i) => i.semaforo === "vermelho");
  const naMeta = v.indicadores.filter((i) => i.semaforo === "verde");
  const recorte = `${fmtData(v.filtros.de)} a ${fmtData(v.filtros.ate)}${v.filtros.setor ? ` · ${v.filtros.setor}` : ""}${v.filtros.equipe ? ` · ${v.filtros.equipe}` : ""}${v.filtros.origem ? ` · ${v.filtros.origem}` : ""}`;

  return (
    <>
      <div className="ger-acoes ger-nao-imprime" style={{ justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" className="btn btn--primary" onClick={imprimir}>
          <Printer size={16} aria-hidden="true" /> Relatório executivo (PDF)
        </button>
      </div>

      <div className="ds-kpis">
        <KpiGer label="Entradas" valor={fmtNum(v.kpis.entradas)} variacao={variacaoPct(v.kpis.entradas, v.kpisAnterior.entradas)} maiorMelhor={false} />
        <KpiGer label="Resolvidos" valor={fmtNum(v.kpis.resolvidos)} variacao={variacaoPct(v.kpis.resolvidos, v.kpisAnterior.resolvidos)} maiorMelhor />
        <KpiGer label="Backlog" valor={fmtNum(v.kpis.backlog)} unidade="abertos" variacao={variacaoPct(v.kpis.backlog, v.kpisAnterior.backlog)} maiorMelhor={false} />
        <KpiGer label="SLA de solução" valor={fmtPct(v.kpis.slaSolucaoPct)} tom={v.indicadores.find((i) => i.chave === "sla_solucao")?.semaforo} variacao={variacaoPct(v.kpis.slaSolucaoPct, v.kpisAnterior.slaSolucaoPct)} maiorMelhor />
        <KpiGer label="Tempo médio de resolução" valor={fmtHoras(v.kpis.tmrHoras)} tom={v.indicadores.find((i) => i.chave === "tmr")?.semaforo} variacao={variacaoPct(v.kpis.tmrHoras, v.kpisAnterior.tmrHoras)} maiorMelhor={false} />
        <KpiGer label="Metas" valor={`${naMeta.length}/${v.indicadores.length}`} unidade="na meta" tom={foraDaMeta.length === 0 ? "verde" : foraDaMeta.length <= 2 ? "amarelo" : "vermelho"} hint={foraDaMeta.length ? `${foraDaMeta.length} fora da meta` : "Nenhuma fora da meta"} />
      </div>

      <Secao titulo="Resumo executivo" subtitulo={`Período ${recorte}.`}>
        <div className="ger-exec">
          <div className="ger-exec__bloco">
            <h4>Números do período</h4>
            <ul>
              <li>{fmtNum(v.kpis.entradas)} entradas (<Variacao pct={variacaoPct(v.kpis.entradas, v.kpisAnterior.entradas)} maiorMelhor={false} sufixo="" />)</li>
              <li>{fmtNum(v.kpis.resolvidos)} resolvidos, {fmtPct(v.kpis.taxaResolucaoPct)} das entradas</li>
              <li>Backlog de {fmtNum(v.kpis.backlog)}, {fmtNum(v.kpis.vencidos)} com SLA vencido e {fmtNum(v.kpis.semResponsavel)} sem responsável</li>
              <li>SLA de solução em {fmtPct(v.kpis.slaSolucaoPct)} (meta {v.metas.sla_solucao_pct}%)</li>
              <li>TMR de {fmtHoras(v.kpis.tmrHoras)} (meta {v.metas.tmr_horas} h)</li>
              <li>Reabertura de {fmtPct(v.kpis.reaberturaPct)}; triagem automática em {fmtPct(v.kpis.iaAutomaticaPct)} das entradas</li>
            </ul>
          </div>
          <div className="ger-exec__bloco">
            <h4>Principais desvios</h4>
            <ul>
              {criticos.length === 0 && atencao.length === 0 && <li>Nenhum limite ultrapassado.</li>}
              {[...criticos, ...atencao].slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Semaforo tom={a.nivel === "critico" ? "vermelho" : "amarelo"} /> {a.titulo}: {a.texto}
                </li>
              ))}
            </ul>
          </div>
          <div className="ger-exec__bloco">
            <h4>Decisões necessárias</h4>
            <ul>
              {decisoes.length === 0 && <li>Sem riscos ou oportunidades relevantes neste recorte.</li>}
              {decisoes.map((d) => (
                <li key={d.titulo}>
                  <b>{d.titulo}.</b> {d.texto}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Secao>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Tendência de 13 meses" subtitulo="Entradas e resolvidos por mês.">
          <GraficoLinha titulo="Entradas e resolvidos por mês" rotulos={m.map((p) => p.rotulo)} series={[{ nome: "Entradas", valores: m.map((p) => p.entradas) }, { nome: "Resolvidos", valores: m.map((p) => p.resolvidos) }]} formato={(x) => fmtNum(x)} altura={200} />
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
            <li>
              <b>{atual?.rotulo}:</b> {fmtNum(atual?.entradas ?? 0)} entradas, <Variacao pct={variacaoPct(atual?.entradas ?? null, anterior?.entradas ?? null)} maiorMelhor={false} sufixo="vs. mês anterior" />
              {anoPassado && (
                <>
                  {" · "}
                  <Variacao pct={variacaoPct(atual?.entradas ?? null, anoPassado.entradas)} maiorMelhor={false} sufixo={`vs. ${anoPassado.rotulo}`} />
                </>
              )}
            </li>
            {tendencias.map((t) => (
              <li key={t.titulo}>
                <b>{t.titulo}.</b> {t.texto}
              </li>
            ))}
          </ul>
        </Secao>
        <Secao titulo="Atingimento das metas" subtitulo="100% = na meta. Metas cadastradas em Indicadores.">
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

      <p className="ger-nota">Gerado em {new Date(v.payload.generated_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} com os tickets que você pode ver. Para enviar, use "Relatório executivo (PDF)" acima; para a análise com IA, veja Recomendações por IA.</p>
    </>
  );
}
