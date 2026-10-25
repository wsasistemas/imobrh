import { CalendarClock, CircleCheckBig, CircleDot, HardDrive, Hash, Hourglass, Inbox, ListChecks, SearchX, Tags, User, UserPen, Wallet } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ThLabel } from "../../../components/ds";
import { IconeIlustrativo } from "../../../components/ds/IconeColorido";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { moeda } from "../cadeia";
import { StatusChip, type StatusSolicitacao } from "../components/StatusChip";
import type { LinhaConferencia } from "../conferencia";
import { useFilaConferencia } from "../hooks";
import { dataBR, NOME_TIPO } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 8 — Fila do Financeiro (/financeiro/conferencia): contadores por etapa e a lista pela aprovação mais antiga,
// com "pagar até" (reembolso e fundo fixo: última aprovação + 15 dias).

type Filtro = "todas" | StatusSolicitacao | "comprovar";
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function FilaFinanceiro() {
  const q = useFilaConferencia();
  // ?etapa= (cards da Página Inicial) abre a fila já filtrada.
  const [params] = useSearchParams();
  const [filtro, setFiltro] = useState<Filtro>(() => (params.get("etapa") as Filtro | null) ?? "em_conferencia");
  const [busca, setBusca] = useState("");
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar a fila do Financeiro." onRetry={() => void q.refetch()} />;
  const { kpis, lista } = q.data;
  const termos = norm(busca).split(/\s+/).filter(Boolean);
  const filtrada = lista.filter(
    (l) =>
      (filtro === "todas" || (filtro === "comprovar" ? ["comprovacao_pendente", "comprovacao_em_conferencia"].includes(l.status) : l.status === filtro)) &&
      termos.every((t) => norm(`${l.numero} ${l.solicitante} ${l.setor ?? ""}`).includes(t)),
  );
  const kpi = (f: Filtro, icon: typeof Inbox, rotulo: string, n: number, leg: string, tom?: string) => (
    <button type="button" className={`sf-kpi sf-kpi--botao${filtro === f ? " sf-kpi--on" : ""}${tom === "alerta" && n > 0 ? " sf-kpi--alerta" : ""}`} aria-pressed={filtro === f} onClick={() => setFiltro(f)}>
      <span className="sf-kpi__rot"><IconeIlustrativo icon={icon} size={18} />{rotulo}</span>
      <b className={tom && tom !== "alerta" ? `sf-kpi__n--${tom}` : undefined}>{n}</b>
      <span className="sf-kpi__leg">{leg}</span>
    </button>
  );

  return (
    <>
      <div className="sf-ph">
        <div>
          <h2 className="sf-ph__t">Fila do Financeiro</h2>
          <p className="sf-ph__s">Pela aprovação mais antiga. Reembolso e fundo fixo: pagar até 15 dias após a última aprovação.</p>
        </div>
      </div>
      <div className="sf-kpis">
        {kpi("em_conferencia", ListChecks, "A conferir", kpis.aConferir, moeda(kpis.aConferirValor))}
        {kpi("pendencia_solicitante", UserPen, "Pendência do solicitante", kpis.pendencia, "aguardando ajuste", "roxo")}
        {kpi("lancamento_gerado", HardDrive, "Lançamento gerado", kpis.lancamentoGerado, "no SIENGE", "info")}
        {kpi("pagamento_programado", CalendarClock, "Pagamento programado", kpis.pagamentoProgramado, "a pagar", "info")}
        {kpi("comprovar", Hourglass, "Adiantamentos a comprovar", kpis.aComprovar, `${kpis.aComprovarVencidos} vencido${kpis.aComprovarVencidos === 1 ? "" : "s"}`, "alerta")}
        {kpi("paga", CircleCheckBig, "Pagas no mês", kpis.pagasMes, moeda(kpis.pagasMesValor), "ok")}
      </div>
      <div className="sf-barra">
        <input className="input sf-barra__busca" type="search" aria-label="Buscar" placeholder="Buscar número, solicitante ou setor" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <button type="button" className="btn btn--outline" aria-pressed={filtro === "todas"} onClick={() => setFiltro("todas")}>Ver todas</button>
      </div>
      <div className="card sf-tabela">
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Hash}>Número</ThLabel></th>
                <th><ThLabel icon={User}>Solicitante · setor</ThLabel></th>
                <th><ThLabel icon={Tags}>Tipo</ThLabel></th>
                <th className="n"><ThLabel icon={Wallet}>A pagar</ThLabel></th>
                <th>Última aprovação</th>
                <th><ThLabel icon={CalendarClock}>Pagar até</ThLabel></th>
                <th>Itens</th>
                <th><ThLabel icon={CircleDot}>Status</ThLabel></th>
                <th><span className="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody>
              {filtrada.map((l) => <Linha key={l.id} l={l} />)}
              {filtrada.length === 0 && (
                <tr><td colSpan={9} className="at-vazio"><span className="sf-vazio"><IconeIlustrativo icon={SearchX} size={28} />Nada nesta etapa.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PagarAte({ l }: { l: LinhaConferencia }) {
  const data = l.tipo === "adiantamento" ? l.vencimento : l.pagarAte;
  if (!data) return <span>—</span>;
  const dias = Math.round((new Date(`${data}T12:00:00`).getTime() - Date.now()) / 86_400_000);
  if (["paga", "encerrada"].includes(l.status)) return <span>{dataBR(data)}</span>;
  return <span className={`sf-chip ${dias < 0 ? "sf-chip--erro" : "sf-chip--aviso"}`}>{dataBR(data)} · {dias < 0 ? `vencido há ${-dias} d` : dias === 0 ? "hoje" : `em ${dias} d`}</span>;
}

function Linha({ l }: { l: LinhaConferencia }) {
  return (
    <tr>
      <td><Link className="sf-link" to={`/financeiro/conferencia/${l.id}`}>{l.numero}</Link></td>
      <td>{l.solicitante}{l.setor && <span className="sf-sub">{l.setor}</span>}</td>
      <td>{NOME_TIPO[l.tipo]}</td>
      <td className="n">{moeda(l.valorAPagar ?? l.valor)}</td>
      <td>{dataBR(l.ultimaAprovacaoEm)}</td>
      <td><PagarAte l={l} /></td>
      <td>{l.itens ? `${l.resolvidos} de ${l.itens} resolvidos` : "—"}</td>
      <td><StatusChip status={l.status} /></td>
      <td><Link className="btn btn--outline btn--sm" to={`/financeiro/conferencia/${l.id}`}>{l.status === "em_conferencia" ? "Conferir" : "Abrir"}</Link></td>
    </tr>
  );
}
