import { Sparkles } from "lucide-react";
import { resumoParaIa } from "../calculos";
import { ServiceError } from "../../configuracoes/services/types";
import { KpiGer, Secao, Semaforo } from "../componentes";
import { fmtNum } from "../graficos";
import { useRecomendacoesIa, useVisao } from "../hooks";

const PRIORIDADE = { alta: { tom: "vermelho", classe: "risco" }, media: { tom: "amarelo", classe: "tendencia" }, baixa: { tom: "verde", classe: "oportunidade" } } as const;

/** Recomendações por IA: orientar ações (causas prováveis, previsão e recomendação de decisão). */
export function RecomendacoesIa() {
  const v = useVisao();
  const ia = useRecomendacoesIa();
  const resumo = () => resumoParaIa({ periodo: v.filtros, atual: v.kpis, anterior: v.kpisAnterior, porEquipe: v.grupos.equipe, porServico: v.grupos.servico, porOrigem: v.grupos.origem, mensal: v.mensal, alertas: v.alertas, insights: v.insights });
  const alertasAtivos = v.alertas.filter((a) => a.nivel !== "ok").length;

  return (
    <>
      <div className="ds-kpis">
        <KpiGer label="Alertas enviados à IA" valor={fmtNum(alertasAtivos)} hint="Só os fora do limite" />
        <KpiGer label="Insights enviados à IA" valor={fmtNum(v.insights.length)} hint="Anomalias, tendências, riscos e oportunidades" />
        <KpiGer label="Meses de histórico" valor={fmtNum(v.mensal.length)} hint="Entradas, resolvidos, backlog e SLA por mês" />
        <KpiGer label="Recomendações" valor={ia.data ? fmtNum(ia.data.recomendacoes.length) : "—"} hint={ia.data ? `Modelo: ${ia.data.modelo}` : "Ainda não geradas"} />
      </div>

      <Secao titulo="Recomendações por IA" subtitulo="A IA recebe só os números agregados deste recorte (sem nomes de solicitantes nem textos de tickets) e devolve causas prováveis, previsão e a decisão sugerida.">
        <div className="ger-ia">
          <div className="ger-acoes">
            <button type="button" className="btn btn--primary" disabled={ia.isPending} onClick={() => ia.mutate(resumo())}>
              <Sparkles size={16} aria-hidden="true" /> {ia.isPending ? "Analisando…" : ia.data ? "Gerar de novo" : "Gerar recomendações"}
            </button>
            {ia.data && <span className="ds-muted" style={{ fontSize: 12 }}>Modelo: {ia.data.modelo}</span>}
          </div>
          {ia.isError && (
            <p className="ger-nota" role="alert">
              {ia.error instanceof ServiceError ? ia.error.message : "Não foi possível falar com a IA. Tente de novo."}
            </p>
          )}
          {ia.data && (
            <div style={{ marginTop: 12 }}>
              <h3>Resumo executivo</h3>
              <p style={{ margin: "0 0 12px", fontSize: 14 }}>{ia.data.resumoExecutivo}</p>
              <div className="ger-lista">
                {ia.data.recomendacoes.map((r) => (
                  <div key={r.titulo} className={`ger-item ger-item--${PRIORIDADE[r.prioridade].classe}`}>
                    <span className="ger-item__icone">
                      <Sparkles size={16} aria-hidden="true" />
                    </span>
                    <div>
                      <b>{r.titulo}</b>
                      <p>
                        <b>Causa provável:</b> {r.causaProvavel}
                      </p>
                      <p>
                        <b>Previsão:</b> {r.previsao}
                      </p>
                      <p>
                        <b>Recomendação:</b> {r.recomendacao}
                      </p>
                    </div>
                    <Semaforo tom={PRIORIDADE[r.prioridade].tom}>Prioridade {r.prioridade}</Semaforo>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!ia.data && !ia.isPending && !ia.isError && <p className="ger-nota">Clique em "Gerar recomendações". Mudou o período ou os filtros? Gere de novo para a análise acompanhar o recorte.</p>}
        </div>
      </Secao>

      <Secao titulo="O que a IA recebe" subtitulo="Transparência sobre os dados enviados.">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
          <li><b>Período e filtros:</b> datas, setor, equipe e canal escolhidos.</li>
          <li><b>KPIs:</b> do período atual e do anterior (entradas, resolvidos, backlog, SLA, tempos, reabertura, triagem automática).</li>
          <li><b>Agregados:</b> até 8 equipes, 8 serviços e os canais, com entradas, resolvidos, backlog, vencidos, SLA e TMR.</li>
          <li><b>Histórico:</b> 13 meses de entradas, resolvidos, backlog e SLA.</li>
          <li><b>Alertas e insights:</b> títulos e evidências, sem o texto dos tickets.</li>
          <li><b>Nunca:</b> nomes de solicitantes, assuntos, descrições ou anexos.</li>
        </ul>
      </Secao>
    </>
  );
}
