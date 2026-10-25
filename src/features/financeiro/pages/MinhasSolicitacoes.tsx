import { Calculator, CalendarClock, CircleCheckBig, CircleDot, Clock, FileText, Hash, Hourglass, Inbox, Plus, Receipt, SearchX, Tags, UserPen, Wallet } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { IconeIlustrativo } from "../../../components/ds/IconeColorido";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { moeda } from "../cadeia";
import { STATUS, StatusChip, type StatusSolicitacao } from "../components/StatusChip";
import { useCriarSolicitacao, useMinhasSolicitacoes } from "../hooks";
import type { LinhaLista, TipoSolicitacao } from "../solicitacoes";
import { dataBR, mesBR, NOME_TIPO } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 1 — Minhas solicitações (/financeiro/solicitacoes): cartões de início, contadores e histórico com busca.

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function MinhasSolicitacoes() {
  const q = useMinhasSolicitacoes();
  const [busca, setBusca] = useState("");
  const [tipo, setTipo] = useState<TipoSolicitacao | "">("");
  // ?status= (cards da Página Inicial) abre o histórico já filtrado.
  const [params] = useSearchParams();
  const [status, setStatus] = useState<StatusSolicitacao | "">(() => (params.get("status") as StatusSolicitacao | null) ?? "");
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar as suas solicitações." onRetry={() => void q.refetch()} />;
  const { kpis, lista } = q.data;
  const termos = norm(busca).split(/\s+/).filter(Boolean);
  const filtrada = lista.filter(
    (l) => (!tipo || l.tipo === tipo) && (!status || l.status === status) && termos.every((t) => norm(`${l.numero} ${NOME_TIPO[l.tipo]} ${l.valor.toFixed(2).replace(".", ",")}`).includes(t)),
  );

  return (
    <>
      <CartoesInicio temFundoFixo={q.data.temFundoFixo} temSetor={q.data.temSetor} />

      <div className="sf-kpis" aria-label="Contadores">
        <Kpi icon={FileText} rotulo="Rascunhos" valor={kpis.rascunho} legenda="salvos automaticamente" />
        <Kpi icon={Clock} rotulo="Em aprovação" valor={kpis.emAprovacao} legenda="com os aprovadores" />
        <Kpi icon={UserPen} rotulo="Devolvidas" valor={kpis.devolvida} legenda="precisam de ajuste seu" tom="roxo" />
        <Kpi icon={Inbox} rotulo="No Financeiro" valor={kpis.noFinanceiro} legenda="conferência e lançamento" />
        <Kpi icon={Hourglass} rotulo="A comprovar" valor={kpis.aComprovar} legenda="adiantamentos" alerta={kpis.aComprovar > 0} />
        <Kpi icon={CircleCheckBig} rotulo="Pagas no mês" valor={kpis.pagasMes} legenda={moeda(kpis.pagasMesValor)} tom="ok" />
      </div>

      <div className="sf-barra">
        <input className="input sf-barra__busca" type="search" aria-label="Buscar solicitação" placeholder="Buscar por número, tipo ou valor" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select className="input sf-barra__filtro" aria-label="Tipo" value={tipo} onChange={(e) => setTipo(e.target.value as TipoSolicitacao | "")}>
          <option value="">Todos os tipos</option>
          <option value="reembolso">Reembolso</option>
          <option value="fundo_fixo">Fundo fixo</option>
          <option value="adiantamento">Adiantamento</option>
        </select>
        <select className="input sf-barra__filtro" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusSolicitacao | "")}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS).filter(([s]) => s !== "cancelada").map(([s, v]) => (
            <option key={s} value={s}>{v.rotulo}</option>
          ))}
        </select>
      </div>

      <div className="card sf-tabela">
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Hash}>Número</ThLabel></th>
                <th><ThLabel icon={Tags}>Tipo</ThLabel></th>
                <th><ThLabel icon={CalendarClock}>Competência / Vencimento</ThLabel></th>
                <th className="n"><ThLabel icon={Wallet}>Valor</ThLabel></th>
                <th>Etapa</th>
                <th><ThLabel icon={CircleDot}>Status</ThLabel></th>
                <th>Pagar até</th>
                <th>Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {filtrada.map((l) => <Linha key={l.id} l={l} />)}
              {filtrada.length === 0 && (
                <tr>
                  <td colSpan={8} className="at-vazio">
                    <span className="sf-vazio">
                      <IconeIlustrativo icon={SearchX} size={28} />
                      {lista.length ? "Nada encontrado com esses filtros." : "Você ainda não tem solicitações. Comece por um dos cartões acima."}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Linha({ l }: { l: LinhaLista }) {
  return (
    <tr>
      <td><Link className="sf-link" to={`/financeiro/solicitacoes/${l.id}`}>{l.numero}</Link></td>
      <td>{NOME_TIPO[l.tipo]}</td>
      <td>{l.tipo === "adiantamento" ? `Venc. ${dataBR(l.vencimento)}` : mesBR(l.competencia)}</td>
      <td className="n">{moeda(l.valor)}</td>
      <td>{l.etapa ? `${l.etapa.papel} · ${l.etapa.nivel} de ${l.etapa.de}` : "—"}</td>
      <td><StatusChip status={l.status} /></td>
      <td>{dataBR(l.pagarAte)}</td>
      <td>{new Date(l.atualizadoEm).toLocaleDateString("pt-BR")}</td>
    </tr>
  );
}

function Kpi({ icon, rotulo, valor, legenda, tom, alerta }: { icon: typeof Clock; rotulo: string; valor: number; legenda: string; tom?: "roxo" | "ok"; alerta?: boolean }) {
  return (
    <div className={`sf-kpi${alerta ? " sf-kpi--alerta" : ""}`}>
      <span className="sf-kpi__rot"><IconeIlustrativo icon={icon} size={18} />{rotulo}</span>
      <b className={tom ? `sf-kpi__n--${tom}` : undefined}>{valor}</b>
      <span className="sf-kpi__leg">{legenda}</span>
    </div>
  );
}

/** Cartões de início (também é a tela "Nova solicitação"). */
export function CartoesInicio({ temFundoFixo, temSetor }: { temFundoFixo: boolean; temSetor: boolean }) {
  const criar = useCriarSolicitacao();
  const navegar = useNavigate();
  const iniciar = (tipo: TipoSolicitacao) =>
    criar.mutate(tipo, {
      onSuccess: (id) => navegar(`/financeiro/solicitacoes/${id}`),
      onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível criar a solicitação."),
    });
  return (
    <>
      {!temSetor && (
        <div className="sf-aviso sf-aviso--w" role="alert">
          <b>Seu cadastro está sem setor.</b> O setor define quem aprova as suas solicitações. Peça ao administrador para definir o seu setor em Pessoas.
        </div>
      )}
      <div className="sf-inicio">
        <Cartao icone={Receipt} titulo="Reembolso de despesas" texto="Gastos pagos do seu bolso a serviço da empresa. Pagamento em até 15 dias após a última aprovação."
          botao="Novo reembolso" onClick={() => iniciar("reembolso")} desabilitado={criar.isPending || !temSetor} />
        <Cartao icone={Calculator} titulo="Fundo fixo de caixa" texto="Prestação de contas do caixinha: as despesas do período e a reposição do fundo."
          botao="Prestar contas" onClick={() => iniciar("fundo_fixo")} desabilitado={criar.isPending || !temSetor || !temFundoFixo}
          aviso={temFundoFixo ? undefined : "Você não tem fundo fixo cadastrado."} />
        <Cartao icone={Wallet} titulo="Adiantamento de numerário" texto="Pagamento antecipado a fornecedor a partir de um pedido de compras. Comprovação em até 30 dias."
          botao="Novo adiantamento" onClick={() => iniciar("adiantamento")} desabilitado={criar.isPending || !temSetor} />
      </div>
    </>
  );
}

function Cartao({ icone, titulo, texto, botao, onClick, desabilitado, aviso }: {
  icone: typeof Clock; titulo: string; texto: string; botao: string; onClick?: () => void; desabilitado?: boolean; aviso?: string;
}) {
  return (
    <div className="sf-ini">
      <span className="sf-ini__ic"><IconeIlustrativo icon={icone} size={30} /></span>
      <h3>{titulo}</h3>
      <p>{texto}</p>
      {aviso && <span className="field__help">{aviso}</span>}
      <button type="button" className="btn btn--primary" disabled={desabilitado} onClick={onClick}>
        <Plus size={16} aria-hidden="true" />
        {botao}
      </button>
    </div>
  );
}
