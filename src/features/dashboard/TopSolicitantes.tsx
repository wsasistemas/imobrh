import { Building2, Hash, User, Wrench } from "lucide-react";
import { useId, useState } from "react";
import { Panel, PanelHeader } from "../../components/ds/Panel";
import { Pill } from "../../components/ds/Pill";
import { ThLabel } from "../../components/ds/ThLabel";
import { useTopSolicitantes } from "../atendimento/hooks/useAtendimento";

const PERIODOS = [7, 30, 90] as const;

/**
 * Visão geral › Quem mais abre chamados (mockup aprovado em 09/10/2026, tela 5). Conta os tickets que a pessoa
 * pode ver, por solicitante identificado, em todos os canais.
 */
export function TopSolicitantes() {
  const ids = useId();
  const [dias, setDias] = useState<(typeof PERIODOS)[number]>(30);
  const q = useTopSolicitantes(dias);
  const d = q.data;
  const max = Math.max(1, ...(d?.top ?? []).map((t) => t.tickets));
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);

  return (
    <Panel aria-labelledby={`${ids}-t`} className="ds-top">
      <PanelHeader
        title="Quem mais abre chamados"
        titleId={`${ids}-t`}
        subtitle="Por colaborador identificado, em todos os canais."
        aside={
          <label className="ds-top__periodo">
            <span className="visually-hidden">Período</span>
            <select className="ds-search" value={dias} onChange={(e) => setDias(Number(e.target.value) as (typeof PERIODOS)[number])}>
              {PERIODOS.map((p) => (
                <option key={p} value={p}>{p} dias</option>
              ))}
            </select>
          </label>
        }
      />
      {q.isPending && <p className="ds-top__vazio">Carregando…</p>}
      {q.isError && <p className="ds-top__vazio">Não foi possível carregar.</p>}
      {d && (
        <>
          <div className="ds-top__kpis">
            <div><small>Tickets no período</small><b>{d.total}</b></div>
            <div><small>Por WhatsApp</small><b>{d.whatsapp}</b></div>
            <div><small>Resolvidos na conversa</small><b>{pct(d.resolvidosNaConversa)}</b></div>
            <div><small>Solicitantes identificados</small><b>{pct(d.identificados)}</b></div>
          </div>
          <div className="ds-top__grade">
            <div className="ds-tablewrap">
              <table className="ds-table">
                <thead>
                  <tr><th><ThLabel icon={User}>Colaborador</ThLabel></th><th><ThLabel icon={Hash}>Tickets</ThLabel></th><th aria-hidden="true" /><th><ThLabel icon={Wrench}>Serviço mais pedido</ThLabel></th></tr>
                </thead>
                <tbody>
                  {d.top.length === 0 && <tr><td colSpan={4}>Nenhum ticket com solicitante identificado no período.</td></tr>}
                  {d.top.map((t) => (
                    <tr key={t.pessoaId}>
                      <td>{t.nome}</td>
                      <td>{t.tickets}</td>
                      <td className="ds-top__barra" aria-hidden="true"><span style={{ width: `${(100 * t.tickets) / max}%` }} /></td>
                      <td>{t.servico ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ds-tablewrap">
              <table className="ds-table">
                <thead>
                  <tr><th><ThLabel icon={Building2}>Departamento</ThLabel></th><th><ThLabel icon={Hash}>Tickets</ThLabel></th></tr>
                </thead>
                <tbody>
                  {d.departamentos.length === 0 && <tr><td colSpan={2}>Sem departamento nos cadastros de Pessoas.</td></tr>}
                  {d.departamentos.map((x) => (
                    <tr key={x.nome}><td>{x.nome}</td><td>{x.tickets}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="ds-top__nota"><Pill>Departamento</Pill> vem do cadastro de Pessoas (relação com o departamento).</p>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
