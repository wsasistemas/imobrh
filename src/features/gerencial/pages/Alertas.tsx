import { AlertTriangle, Bell, CheckCircle2, Info } from "lucide-react";
import { Link } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { KpiGer, Secao, Semaforo } from "../componentes";
import { fmtNum } from "../graficos";
import { useVisao } from "../hooks";
import type { Alerta } from "../types";

const NIVEIS: Record<Alerta["nivel"], { label: string; descricao: string; tom: "vermelho" | "amarelo" | "verde"; icone: typeof Bell }> = {
  critico: { label: "Críticos", descricao: "Limite ultrapassado em mais de 10%. Precisa de ação agora.", tom: "vermelho", icone: AlertTriangle },
  atencao: { label: "Atenção", descricao: "Perto do limite (até 10% fora). Vale acompanhar.", tom: "amarelo", icone: Info },
  ok: { label: "Dentro do limite", descricao: "Regras verificadas e em dia neste recorte.", tom: "verde", icone: CheckCircle2 },
};

const sufixo = (unidade: string) => (unidade === "%" ? "%" : unidade === "h" ? " h" : ` ${unidade}`);
const fmtComUnidade = (valor: number, unidade: string) => `${fmtNum(valor, unidade === "h" ? 1 : 0)}${sufixo(unidade)}`;

/** Alertas: antecipar problemas (vencimentos, atrasos, desvios e limites ultrapassados no recorte atual). */
export function Alertas() {
  const v = useVisao();
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const porNivel = (n: Alerta["nivel"]) => v.alertas.filter((a) => a.nivel === n);
  const criticos = porNivel("critico");
  const atencao = porNivel("atencao");
  const tomDe = (id: string) => (criticos.some((a) => a.id === id) ? "vermelho" : atencao.some((a) => a.id === id) ? "amarelo" : "verde");
  const agora = v.agora.getTime();
  const vencem24h = v.backlog.filter((t) => {
    if (!t.slaSolucaoAte || t.slaPausadoDesde) return false;
    const resta = Date.parse(t.slaSolucaoAte) - agora;
    return resta > 0 && resta < 24 * 3_600_000;
  }).length;

  return (
    <>
      <div className="ds-kpis">
        <KpiGer label="Alertas críticos" valor={fmtNum(criticos.length)} tom={criticos.length ? "vermelho" : "verde"} hint={criticos.length ? "Limite ultrapassado em mais de 10%" : "Nenhum limite ultrapassado"} />
        <KpiGer label="Em atenção" valor={fmtNum(atencao.length)} tom={atencao.length ? "amarelo" : "verde"} hint="Perto do limite" />
        <KpiGer label="SLA vencido" valor={fmtNum(v.kpis.vencidos)} unidade="abertos" tom={tomDe("vencidos")} hint={`Limite: ${v.metas.vencidos_max}`} />
        <KpiGer label="Vencem nas próximas 24 h" valor={fmtNum(vencem24h)} unidade="abertos" tom={vencem24h ? "amarelo" : "verde"} hint="Prazo de solução perto de estourar" />
        <KpiGer label="Sem responsável" valor={fmtNum(v.kpis.semResponsavel)} unidade="abertos" tom={tomDe("sem_responsavel")} hint={`Limite: ${v.metas.sem_responsavel_max}`} />
        <KpiGer label="Parados" valor={fmtNum(v.kpis.parados)} unidade="abertos" tom={v.kpis.parados ? "vermelho" : "verde"} hint={`Mais de ${v.metas.parado_dias} dias sem ação`} />
      </div>

      {(Object.keys(NIVEIS) as Alerta["nivel"][]).map((nivel) => {
        const lista = porNivel(nivel);
        const N = NIVEIS[nivel];
        return (
          <Secao key={nivel} titulo={N.label} subtitulo={N.descricao} aside={<Semaforo tom={N.tom}>{lista.length}</Semaforo>}>
            <div className="ger-lista">
              {lista.length === 0 && <p className="gr-vazio">{nivel === "ok" ? "Nenhuma regra dentro do limite neste recorte." : "Nenhum alerta deste nível neste recorte."}</p>}
              {lista.map((a) => (
                <div key={a.id} className={`ger-item ger-item--${a.nivel}`}>
                  <span className="ger-item__icone">
                    <N.icone size={16} aria-hidden="true" />
                  </span>
                  <div>
                    <b>{a.titulo}</b>
                    <p>{a.texto}</p>
                  </div>
                  <span className="ger-item__lado">
                    {fmtComUnidade(a.valor, a.unidade)}
                    <br />
                    limite {fmtComUnidade(a.limite, a.unidade)}
                  </span>
                </div>
              ))}
            </div>
          </Secao>
        );
      })}

      <p className="ger-nota">
        Os limites são os de <Link to={{ pathname: `${base}/indicadores`, search: location.search }}>Indicadores › Metas e limites</Link>. Para receber estes alertas sem abrir a tela (sino, dias úteis às 8h) e para disparar agora, veja <Link to={{ pathname: `${base}/notificacoes`, search: location.search }}>Notificações</Link>.
      </p>
    </>
  );
}
