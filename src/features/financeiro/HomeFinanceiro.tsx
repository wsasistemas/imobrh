import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAccess } from "../configuracoes/access/useAccess";
import { moeda } from "./cadeia";
import { StatusChip } from "./components/StatusChip";
import { conferenciaService, type LinhaConferencia } from "./conferencia";
import { useMinhasSolicitacoes } from "./hooks";
import { dataBR, NOME_TIPO } from "./pages/formato";
import { aprovacaoService } from "./solicitacoes";
import "../dashboard/HomeTicketsSummary.css";
import "./financeiro.css";

// Página Inicial — resumo das Solicitações Financeiras, no mesmo visual do resumo de chamados (cards .ts-card).
// Cada bloco aparece conforme a tela que o perfil abre:
//   Conferência financeira (perfil Financeiro): etapas da fila e os próximos pagamentos;
//   Aprovações: o que aguarda a pessoa (só para quem é aprovador);
//   Minhas solicitações: todo colaborador.
// Cada card abre a tela já filtrada (?etapa= na fila, ?status= em Minhas solicitações).

const PREVIA = 5;
const DIA = 86_400_000;

function diasAte(iso: string | null): number | null {
  if (!iso) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00`) - hoje.getTime()) / DIA);
}

function Prazo({ iso }: { iso: string | null }) {
  const d = diasAte(iso);
  if (d == null) return <span className="ts-badge">sem data</span>;
  if (d < 0) return <span className="ts-badge ts-badge--danger">Vencido há {-d} d</span>;
  if (d === 0) return <span className="ts-badge ts-badge--danger">Vence hoje</span>;
  return <span className={`ts-badge${d <= 3 ? " ts-badge--warning" : ""}`}>Vence em {d} d</span>;
}

function Card({ to, rotulo, aside, valor, acao, children }: { to: string; rotulo: string; aside?: string; valor: number; acao: string; children: ReactNode }) {
  return (
    <Link to={to} className="ts-card">
      <span className="ts-card__label">
        {rotulo}
        {aside && <small>{aside}</small>}
      </span>
      <strong className="ts-card__value">{valor}</strong>
      <span className="ts-card__detail">{children}</span>
      <span className="ts-card__action" aria-hidden="true">{acao} →</span>
    </Link>
  );
}

/** Resumo financeiro da Página Inicial (some quando não há nada a mostrar para o perfil). */
export function HomeFinanceiro() {
  const { canOpen } = useAccess();
  const financeiro = canOpen("sf_conferencia");
  return (
    <div className="hf">
      {financeiro && <BlocoConferencia />}
      {canOpen("sf_aprovacoes") && <BlocoAprovacoes />}
      {canOpen("sf_minhas") && <BlocoMinhas compacto={financeiro} />}
    </div>
  );
}

// ---------- Financeiro: fila e próximos pagamentos ----------
function BlocoConferencia() {
  const q = useQuery({ queryKey: ["financeiro", "conferencia"], queryFn: () => conferenciaService.fila(), refetchInterval: 60_000 });
  if (q.isPending) return <div className="ts-cards"><div className="ts-card hf-carregando" /><div className="ts-card hf-carregando" /><div className="ts-card hf-carregando" /></div>;
  if (q.isError) return null;
  const { kpis, lista } = q.data;
  const fila = "/financeiro/conferencia";
  const aConferir = lista.filter((l) => l.status === "em_conferencia");
  const vencendo = aConferir.filter((l) => (diasAte(l.pagarAte) ?? 99) <= 3).length;
  const aPagar: LinhaConferencia[] = lista
    .filter((l) => ["em_conferencia", "pendencia_solicitante", "lancamento_gerado", "pagamento_programado"].includes(l.status))
    .sort((a, b) => (a.pagarAte ?? "9999").localeCompare(b.pagarAte ?? "9999"));

  return (
    <section className="ts" aria-labelledby="hf-conf">
      <div className="ts-head">
        <h2 className="section-title" id="hf-conf">Conferência financeira</h2>
        <div className="ts-head__tools">
          <Link className="ts-link" to={fila}>Abrir fila do Financeiro →</Link>
        </div>
      </div>
      <div className="ts-cards hf-cards--seis">
        <Card to={`${fila}?etapa=em_conferencia`} rotulo="A conferir" aside={moeda(kpis.aConferirValor)} valor={kpis.aConferir} acao="Conferir">
          <span className="ts-chips">
            {vencendo > 0 ? <span className="ts-badge ts-badge--warning">{vencendo} vence{vencendo > 1 ? "m" : ""} em até 3 dias</span>
              : kpis.aConferir > 0 ? <span className="ts-badge ts-badge--success">Tudo no prazo</span> : <span className="ts-badge">Nada na fila</span>}
          </span>
        </Card>
        <Card to={`${fila}?etapa=pendencia_solicitante`} rotulo="Pendência do solicitante" valor={kpis.pendencia} acao="Ver pendências">
          Aguardando ajuste do colaborador
        </Card>
        <Card to={`${fila}?etapa=lancamento_gerado`} rotulo="Lançamento gerado" aside="SIENGE" valor={kpis.lancamentoGerado} acao="Programar pagamento">
          Título criado, falta programar o pagamento
        </Card>
        <Card to={`${fila}?etapa=pagamento_programado`} rotulo="Pagamento programado" valor={kpis.pagamentoProgramado} acao="Marcar pagas">
          A pagar na data programada
        </Card>
        <Card to={`${fila}?etapa=comprovar`} rotulo="Adiantamentos a comprovar" valor={kpis.aComprovar} acao="Ver comprovações">
          <span className="ts-chips">
            {kpis.aComprovarVencidos > 0 ? <span className="ts-badge ts-badge--danger">{kpis.aComprovarVencidos} vencido{kpis.aComprovarVencidos > 1 ? "s" : ""}</span>
              : <span className="ts-badge">Nenhum vencido</span>}
          </span>
        </Card>
        <Card to={`${fila}?etapa=paga`} rotulo="Pagas no mês" aside={moeda(kpis.pagasMesValor)} valor={kpis.pagasMes} acao="Ver pagas">
          Reembolsos, fundos e adiantamentos
        </Card>
      </div>

      <section className="ts-panel" aria-labelledby="hf-pag">
        <div className="ts-panel__head">
          <div>
            <h3 id="hf-pag">Próximos pagamentos</h3>
            <p>Pelo "pagar até": vencidos primeiro. Reembolso e fundo fixo, 15 dias após a última aprovação; adiantamento, no vencimento.</p>
          </div>
          <span className="ts-badge">{aPagar.length} solicitaç{aPagar.length === 1 ? "ão" : "ões"}</span>
        </div>
        {aPagar.length === 0 ? (
          <p className="ts-empty">Nenhuma solicitação aguardando pagamento.</p>
        ) : (
          <ul className="ts-list">
            {aPagar.slice(0, PREVIA).map((l) => (
              <li key={l.id} className="ts-row">
                <div className="ts-row__main">
                  <div className="ts-row__meta">
                    <span className="ts-row__id">{l.numero}</span> · {l.solicitante}{l.setor ? ` · ${l.setor}` : ""}
                  </div>
                  <Link className="ts-row__subject" to={`${fila}/${l.id}`}>
                    {NOME_TIPO[l.tipo]} · {moeda(l.valorAPagar ?? l.valor)}
                  </Link>
                  <div className="ts-row__category">Pagar até {dataBR(l.pagarAte)}{l.status === "em_conferencia" ? ` · ${l.resolvidos} de ${l.itens} itens conferidos` : ""}</div>
                </div>
                <span className="ts-row__origin"><StatusChip status={l.status} /></span>
                <span className="ts-row__sla"><Prazo iso={l.pagarAte} /></span>
              </li>
            ))}
          </ul>
        )}
        {aPagar.length > PREVIA && (
          <div className="ts-panel__foot">
            <span>{PREVIA} de {aPagar.length}</span>
            <Link className="ts-link" to={`${fila}?etapa=todas`}>Ver fila completa →</Link>
          </div>
        )}
      </section>
    </section>
  );
}

// ---------- Aprovador ----------
function BlocoAprovacoes() {
  const q = useQuery({ queryKey: ["financeiro", "aprovacoes", "aguardando"], queryFn: () => aprovacaoService.fila("aguardando"), refetchInterval: 60_000 });
  if (!q.data || (!q.data.ehAprovador && q.data.contagem === 0)) return null;
  const lista = q.data.lista;
  const vencidas = lista.filter((l) => l.prazoEm && Date.parse(l.prazoEm) < Date.now()).length;
  const valor = lista.reduce((s, l) => s + l.valor, 0);
  const comAlerta = lista.filter((l) => l.alertas > 0).length;
  return (
    <section className="ts" aria-labelledby="hf-apr">
      <div className="ts-head">
        <h2 className="section-title" id="hf-apr">Aprovações financeiras</h2>
        <div className="ts-head__tools"><Link className="ts-link" to="/financeiro/aprovacoes">Abrir Aprovações →</Link></div>
      </div>
      <div className="ts-cards">
        <Card to="/financeiro/aprovacoes" rotulo="Aguardando você" aside={moeda(valor)} valor={q.data.contagem} acao="Aprovar">
          <span className="ts-chips">
            {vencidas > 0 && <span className="ts-badge ts-badge--danger">{vencidas} com prazo vencido</span>}
            {vencidas === 0 && q.data.contagem > 0 && <span className="ts-badge ts-badge--success">Tudo no prazo</span>}
            {q.data.contagem === 0 && <span className="ts-badge">Nada pendente</span>}
          </span>
        </Card>
        <Card to="/financeiro/aprovacoes" rotulo="Com alerta" valor={comAlerta} acao="Revisar">
          Checagens com alerta para olhar antes de aprovar
        </Card>
        <Card to="/financeiro/aprovacoes" rotulo="Adiantamentos" valor={lista.filter((l) => l.tipo === "adiantamento").length} acao="Ver">
          Aguardando a sua etapa na cadeia
        </Card>
      </div>
    </section>
  );
}

// ---------- Colaborador ----------
function BlocoMinhas({ compacto }: { compacto: boolean }) {
  const q = useMinhasSolicitacoes();
  if (!q.data) return null;
  const k = q.data.kpis;
  const total = k.rascunho + k.emAprovacao + k.devolvida + k.noFinanceiro + k.aComprovar + k.pagasMes;
  // O Financeiro vê o próprio bloco só quando tem solicitação; o colaborador sempre vê (com o atalho para começar).
  if (compacto && total === 0) return null;
  const minhas = "/financeiro/solicitacoes";
  return (
    <section className="ts" aria-labelledby="hf-min">
      <div className="ts-head">
        <h2 className="section-title" id="hf-min">Minhas solicitações financeiras</h2>
        <div className="ts-head__tools">
          <Link className="ts-link" to="/financeiro/nova">Nova solicitação →</Link>
          <Link className="ts-link" to={minhas}>Ver todas →</Link>
        </div>
      </div>
      <div className="ts-cards hf-cards--seis">
        <Card to={`${minhas}?status=rascunho`} rotulo="Rascunhos" valor={k.rascunho} acao="Continuar">Salvos automaticamente</Card>
        <Card to={`${minhas}?status=em_aprovacao`} rotulo="Em aprovação" valor={k.emAprovacao} acao="Acompanhar">Com os aprovadores</Card>
        <Card to={`${minhas}?status=devolvida`} rotulo="Devolvidas" valor={k.devolvida} acao="Ajustar">
          <span className="ts-chips">{k.devolvida > 0 ? <span className="ts-badge ts-badge--warning">Precisam de ajuste seu</span> : <span className="ts-badge">Nenhuma</span>}</span>
        </Card>
        <Card to={`${minhas}?status=em_conferencia`} rotulo="No Financeiro" valor={k.noFinanceiro} acao="Acompanhar">Conferência, lançamento e pagamento</Card>
        <Card to={`${minhas}?status=comprovacao_pendente`} rotulo="A comprovar" valor={k.aComprovar} acao="Comprovar">
          <span className="ts-chips">{k.aComprovar > 0 ? <span className="ts-badge ts-badge--warning">Envie a nota fiscal ou o recibo</span> : <span className="ts-badge">Nenhum adiantamento</span>}</span>
        </Card>
        <Card to={`${minhas}?status=paga`} rotulo="Pagas no mês" aside={moeda(k.pagasMesValor)} valor={k.pagasMes} acao="Ver pagas">Reembolsos e fundos pagos</Card>
      </div>
    </section>
  );
}
