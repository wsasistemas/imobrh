import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Settings2, SquareKanban, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { DetailDialog, formatDuration, slaTone, Toast, useToast } from "../../../components/ds";
import { getMenuItem } from "../../../config/menuRegistry";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { CLOSED_WINDOW_DAYS, isClosed } from "../../dashboard/queue";
import type { DashboardTicket } from "../../dashboard/types";
import { ComPainel, useAtualizarTicket } from "../../dashboard/useDashboardData";
import type { DashboardPayload } from "../../dashboard/types";
import { ServiceError } from "../../configuracoes/services/types";
import { useEmpreendimentos } from "../empreendimentos/hooks";
import { A_IDENTIFICAR } from "../setorSolicitante";
import { useListaExtras, useSalvarVisao, useStatusTickets, useVisoesDisponiveis } from "../hooks";
import { rotuloStatus, type StatusTicket } from "../status/types";
import { atendeCondicoes, colunaDoTicket, ordenarTickets } from "../visoes/avaliar";
import { AGRUPAMENTOS, ehCampoAdicional, formatarCampo, precisaExtras, rotuloColuna } from "../visoes/campos";
import { usePermissoesVisoes } from "../visoes/permissoes";
import type { CampoColuna, ColunaKanban, ColunaLista, ConfigAgrupamento, ListaExtras, StatusRef, Visao } from "../visoes/types";
import { coordenadasPorColuna } from "../dnd";
import { ColunasLista } from "./ColunasLista";
import { FiltroColuna, iconeColuna, VAZIO, type ColunaFiltro, type OpcaoFiltro } from "./FiltroColuna";
import { DialogoColuna, NovaColunaBotao, TituloColuna } from "./KanbanEdicao";
import "./Chamados.css";

// Gestão de Chamados › Tickets: os tickets na visão escolhida (Kanban ou Lista). As visões vêm de
// Configurar visões; o agente vê as das suas equipes. Tickets e mudanças de status ficam no modo
// demonstrativo até existir a tabela de tickets (docs/PLANO-tickets-visoes.md, D7).

const SLA_CLASSE = { red: "ch-badge--danger", amber: "ch-badge--warning", blue: "" } as const;

function SlaBadge({ t }: { t: DashboardTicket }) {
  if (isClosed(t)) return <span className="ch-badge ch-badge--success">{t.status}</span>;
  const m = t.sla_due_minutes;
  return <span className={`ch-badge ${SLA_CLASSE[slaTone(m)]}`}>{`${m < 0 ? "Vencido há" : "Vence em"} ${formatDuration(m)}`}</span>;
}

function Responsavel({ t, meuId }: { t: DashboardTicket; meuId: string }) {
  if (!t.owner) return <span className="ch-badge ch-badge--warning">Não atribuído</span>;
  return (
    <span className="ch-av" title={t.owner.id === meuId ? "Você" : t.owner.name}>
      {t.owner.initials}
    </span>
  );
}

/** Rótulo de um item de coluna: "Aguardando › Retorno do cliente". */
function rotuloRef(ref: StatusRef, status: readonly StatusTicket[]): string {
  const s = status.find((x) => x.id === ref.statusId);
  const j = s?.justificativas.find((x) => x.id === ref.justificativaId);
  return rotuloStatus(s?.nome ?? "?", j?.nome);
}

export function Tickets() {
  return <ComPainel>{(data) => <TicketsConteudo data={data} />}</ComPainel>;
}

function TicketsConteudo({ data }: { data: DashboardPayload }) {
  const me = data.current_user;
  const status = useStatusTickets();
  const visoes = useVisoesDisponiveis(me.id);
  const perm = usePermissoesVisoes();
  const [params, setParams] = useSearchParams();
  const [busca, setBusca] = useState("");
  /** Filtro por empreendimento: "" = todos, "sem" = sem empreendimento, senão o id. */
  const [empFiltro, setEmpFiltro] = useState("");
  const empreendimentos = useEmpreendimentos();
  const usaEmpreendimento = empreendimentos.data?.setores.some((s) => s.iaLigada || s.pedirNoApp) ?? false;
  const extrasFiltro = useListaExtras(empFiltro !== "");
  const tickets = data.tickets;
  const atualizar = useAtualizarTicket();
  const navigate = useNavigate();
  const abrir = (id: number) => navigate(`${getMenuItem("gestao_chamados_tickets").path}/${id}`);
  const [escolha, setEscolha] = useState<{ ticketId: number; coluna: ColunaKanban } | null>(null);
  const toast = useToast();
  const salvarVisao = useSalvarVisao();
  const now = useMemo(() => new Date(data.generated_at), [data.generated_at]);

  const lista = visoes.data ?? [];
  const visao: Visao | undefined = lista.find((v) => String(v.id) === params.get("visao")) ?? lista.find((v) => v.padrao) ?? lista[0];

  const ctx = useMemo(
    () => ({ userId: me.id, now, servicoNome: (id: number) => data.services.find((s) => s.id === id)?.name ?? "" }),
    [me.id, now, data.services],
  );

  // Encerrados só entram se foram encerrados nos últimos 7 dias (o resto do histórico fica fora do quadro).
  const recentes = useMemo(() => {
    const desde = now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000;
    return tickets.filter((t) => !isClosed(t) || (t.closed_at !== null && Date.parse(t.closed_at) >= desde));
  }, [tickets, now]);

  const daVisao = useMemo(() => {
    if (!visao) return [];
    const q = busca.trim().toLowerCase();
    return recentes
      .filter((t) => atendeCondicoes(t, visao.condicoes, ctx))
      .filter((t) => !q || `${t.id} ${t.subject} ${t.requester}`.toLowerCase().includes(q))
      .filter((t) => {
        const x = extrasFiltro.data?.tickets[String(t.id)];
        if (!empFiltro || !extrasFiltro.data) return true;
        return empFiltro === "sem" ? !x?.empreendimento_id : String(x?.empreendimento_id ?? "") === empFiltro;
      });
  }, [recentes, visao, busca, ctx, empFiltro, extrasFiltro.data]);

  /** D5: quem pode mudar o status (arrastar): admin vê tudo; o agente, os seus e os sem responsável. */
  const podeMover = (t: DashboardTicket) => perm.veTodas || !t.owner || t.owner.id === me.id;

  function aplicarStatus(ticketId: number, ref: StatusRef) {
    const st = status.data?.find((x) => x.id === ref.statusId);
    if (!st) return;
    const j = st.justificativas.find((x) => x.id === ref.justificativaId) ?? null;
    atualizar.mutate(
      { id: ticketId, patch: { statusId: st.id, justificativaId: j?.id ?? null } },
      {
        onSuccess: () => toast.show(`Ticket #${ticketId} agora está em "${rotuloStatus(st.nome, j?.nome)}".`),
        // Resolver pede serviço, campos obrigatórios e a solução aplicada: o banco explica o que falta.
        onError: (e) => toast.show(e instanceof ServiceError ? e.message : "Não foi possível mudar o status."),
      },
    );
  }

  /** Edição do Kanban no quadro (Admin/Super admin): grava as colunas na própria visão. */
  function salvarColunas(v: Visao, colunas: ColunaKanban[], mensagem: string, aoSalvar?: () => void) {
    gravar(v, { kanban: { ...v.kanban, colunas } }, mensagem, aoSalvar);
  }

  /** Grava a visão com o que mudou (colunas do Kanban ou da Lista); Admin e Super admin. */
  function gravar(v: Visao, mudanca: { kanban?: Visao["kanban"]; agrupamento?: ConfigAgrupamento }, mensagem: string, aoSalvar?: () => void) {
    const { id, nome, habilitada, tipo, padrao, equipes, condicoes, kanban, agrupamento } = v;
    salvarVisao.mutate(
      { id, nome, habilitada, tipo, padrao, equipes, condicoes, kanban: mudanca.kanban ?? kanban, agrupamento: mudanca.agrupamento ?? agrupamento },
      {
        onSuccess: () => {
          toast.show(`${mensagem} Salvo para todos que usam esta visão.`);
          aoSalvar?.();
        },
        onError: (e) => toast.show(e instanceof ServiceError ? e.message : "Não foi possível salvar."),
      },
    );
  }

  function soltarNaColuna(ticketId: number, coluna: ColunaKanban) {
    if (coluna.status.length === 0) {
      toast.show(`A coluna "${coluna.nome}" não tem status. Peça ao administrador para configurá-la.`);
      return;
    }
    if (coluna.status.length === 1) aplicarStatus(ticketId, coluna.status[0]);
    else setEscolha({ ticketId, coluna });
  }

  if (visoes.isPending || status.isPending) return <PageSkeleton />;
  if (visoes.isError || status.isError) {
    return <ErrorState message="Não foi possível carregar as visões de tickets." onRetry={() => void Promise.all([visoes.refetch(), status.refetch()])} />;
  }

  const configurarPath = `${getMenuItem("gestao_chamados_tickets").path}/visoes${visao ? `?visao=${visao.id}` : ""}`;

  return (
    <section aria-label="Tickets">
      <div className="ch-toolbar">
        {lista.length > 0 && (
          <label className="ch-viewsel">
            Visão:
            <select value={visao?.id ?? ""} onChange={(e) => setParams({ visao: e.target.value }, { replace: true })}>
              {lista.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nome} ({v.tipo === "kanban" ? "Kanban" : "Lista"})
                </option>
              ))}
            </select>
          </label>
        )}
        <input className="input ch-search" type="search" aria-label="Buscar tickets" placeholder="Buscar nº, assunto ou solicitante..." value={busca} onChange={(e) => setBusca(e.target.value)} />
        {usaEmpreendimento && (
          <label className="ch-viewsel">
            Empreendimento:
            <select value={empFiltro} onChange={(e) => setEmpFiltro(e.target.value)}>
              <option value="">Todos</option>
              <option value="sem">Sem empreendimento</option>
              {empreendimentos.data?.empreendimentos
                .filter((e) => e.ativo || e.tickets > 0)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nome}
                  </option>
                ))}
            </select>
          </label>
        )}
        {visao && <span className="ch-count" aria-live="polite">{daVisao.length} tickets nesta visão</span>}
        <span className="ch-toolbar__spacer" />
        {perm.podeConfigurar && visao?.tipo === "lista" && (
          <ColunasLista
            key={visao.id}
            visao={visao}
            salvando={salvarVisao.isPending}
            onSalvar={(colunas, aoSalvar) => gravar(visao, { agrupamento: { ...visao.agrupamento, colunas } }, "Colunas da lista atualizadas.", aoSalvar)}
          />
        )}
        {perm.podeConfigurar && (
          <Link className="btn btn--outline" to={configurarPath}>
            <Settings2 size={16} aria-hidden="true" />
            Configurar visões
          </Link>
        )}
      </div>

      {!visao ? (
        <div className="card">
          <EmptyState
            icon={SquareKanban}
            title="Nenhuma visão para a sua equipe"
            description={perm.podeConfigurar ? "Crie uma visão em Configurar visões." : "Peça ao administrador para criar uma visão para a sua equipe."}
          />
        </div>
      ) : visao.tipo === "kanban" ? (
        <Quadro
          visao={visao}
          tickets={daVisao}
          statusCadastro={status.data}
          meuId={me.id}
          podeMover={podeMover}
          onAbrir={abrir}
          onSoltar={soltarNaColuna}
          editavel={perm.podeConfigurar}
          salvando={salvarVisao.isPending}
          onSalvarColunas={(colunas, mensagem, aoSalvar) => salvarColunas(visao, colunas, mensagem, aoSalvar)}
        />
      ) : (
        <Listagem key={visao.id} visao={visao} tickets={daVisao} meuId={me.id} servicoNome={ctx.servicoNome} onAbrir={abrir} />
      )}

      <DetailDialog
        open={escolha !== null}
        onOpenChange={(o) => !o && setEscolha(null)}
        title={escolha ? `Mover #${escolha.ticketId} para "${escolha.coluna.nome}"` : ""}
        description="Esta coluna tem mais de um status. Escolha qual aplicar."
        closeLabel="Cancelar"
      >
        {escolha && (
          <div className="ch-choices">
            {escolha.coluna.status.map((ref) => (
              <button
                key={`${ref.statusId}:${ref.justificativaId}`}
                type="button"
                className="ch-choice"
                onClick={() => {
                  aplicarStatus(escolha.ticketId, ref);
                  setEscolha(null);
                }}
              >
                {rotuloRef(ref, status.data)}
              </button>
            ))}
          </div>
        )}
      </DetailDialog>

      <Toast message={toast.message} />
    </section>
  );
}

// ---------- Kanban ----------

interface QuadroProps {
  visao: Visao;
  tickets: DashboardTicket[];
  statusCadastro: StatusTicket[];
  meuId: string;
  podeMover: (t: DashboardTicket) => boolean;
  onAbrir: (id: number) => void;
  onSoltar: (ticketId: number, coluna: ColunaKanban) => void;
  /** Admin/Super admin: renomear, escolher status, mover, remover e "+ Coluna" no próprio quadro. */
  editavel: boolean;
  salvando: boolean;
  onSalvarColunas: (colunas: ColunaKanban[], mensagem: string, aoSalvar?: () => void) => void;
}

function Quadro({ visao, tickets, statusCadastro, meuId, podeMover, onAbrir, onSoltar, editavel, salvando, onSalvarColunas }: QuadroProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: coordenadasPorColuna }));
  const [arrastando, setArrastando] = useState<DashboardTicket | null>(null);
  const arrastavel = visao.kanban.arrastar === "mudar_status";
  const colunas = visao.kanban.colunas;
  /** Diálogo de coluna: "nova" ou a coluna cujo status está sendo escolhido. */
  const [dialogo, setDialogo] = useState<ColunaKanban | "nova" | null>(null);
  const mover = (i: number, d: -1 | 1) => {
    const c = [...colunas];
    [c[i], c[i + d]] = [c[i + d], c[i]];
    onSalvarColunas(c, `Coluna "${colunas[i].nome}" movida.`);
  };

  const porColuna = useMemo(() => {
    const mapa = new Map<string, DashboardTicket[]>(colunas.map((c) => [c.id, []]));
    for (const t of ordenarTickets(tickets, visao.kanban.ordenar)) {
      const col = colunaDoTicket(t, colunas);
      if (col) mapa.get(col)?.push(t);
    }
    return mapa;
  }, [tickets, colunas, visao.kanban.ordenar]);

  const inicio = (e: DragStartEvent) => setArrastando(tickets.find((t) => t.id === e.active.id) ?? null);
  const fim = (e: DragEndEvent) => {
    setArrastando(null);
    const destino = colunas.find((c) => c.id === e.over?.id);
    const t = tickets.find((x) => x.id === e.active.id);
    if (!destino || !t || colunaDoTicket(t, colunas) === destino.id) return;
    onSoltar(t.id, destino);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={inicio}
      onDragEnd={fim}
      onDragCancel={() => setArrastando(null)}
      accessibility={{
        screenReaderInstructions: { draggable: "Para mover o ticket, pressione espaço, use ← e → para escolher a coluna e espaço de novo para soltar. Esc cancela." },
      }}
    >
      <div className="ch-board">
        {colunas.map((c, i) => (
          <Coluna
            key={c.id}
            coluna={c}
            tickets={porColuna.get(c.id) ?? []}
            statusCadastro={statusCadastro}
            titulo={
              <TituloColuna
                key={c.nome}
                coluna={c}
                total={porColuna.get(c.id)?.length ?? 0}
                editavel={editavel}
                primeira={i === 0}
                ultima={i === colunas.length - 1}
                salvando={salvando}
                onRenomear={(nome) => onSalvarColunas(colunas.map((x) => (x.id === c.id ? { ...x, nome } : x)), `Coluna renomeada para "${nome}".`)}
                onStatus={() => setDialogo(c)}
                onMover={(d) => mover(i, d)}
                onRemover={() => onSalvarColunas(colunas.filter((x) => x.id !== c.id), `Coluna "${c.nome}" removida.`)}
              />
            }
          >
            {(porColuna.get(c.id) ?? []).map((t) => (
              <Cartao key={t.id} t={t} meuId={meuId} arrastavel={arrastavel && podeMover(t)} onAbrir={onAbrir} />
            ))}
          </Coluna>
        ))}
        {editavel && <NovaColunaBotao onClick={() => setDialogo("nova")} disabled={salvando} />}
      </div>
      {dialogo && (
        <DialogoColuna
          coluna={dialogo === "nova" ? null : dialogo}
          colunas={colunas}
          status={statusCadastro}
          salvando={salvando}
          onFechar={() => setDialogo(null)}
          onSalvar={(lista, mensagem) => onSalvarColunas(lista, mensagem, () => setDialogo(null))}
        />
      )}
      <DragOverlay>{arrastando && <CartaoConteudo t={arrastando} meuId={meuId} overlay onAbrir={() => undefined} />}</DragOverlay>
    </DndContext>
  );
}

function Coluna({ coluna, tickets, statusCadastro, titulo, children }: { coluna: ColunaKanban; tickets: DashboardTicket[]; statusCadastro: StatusTicket[]; titulo: ReactNode; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.id });
  /** Status da coluna numa linha só; o texto inteiro aparece ao passar o mouse. */
  const sub = coluna.status.map((r) => rotuloRef(r, statusCadastro)).join(" · ");
  return (
    <section ref={setNodeRef} className={`ch-col${isOver ? " ch-col--over" : ""}`} aria-label={`${coluna.nome}: ${tickets.length} tickets`}>
      {titulo}
      {sub && <div className="ch-col__sub" title={sub}>{sub}</div>}
      {children}
    </section>
  );
}

function Cartao({ t, meuId, arrastavel, onAbrir }: { t: DashboardTicket; meuId: string; arrastavel: boolean; onAbrir: (id: number) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id, disabled: !arrastavel });
  return (
    <div ref={setNodeRef} {...(arrastavel ? { ...attributes, ...listeners } : {})} className={isDragging ? "ch-card--dragging" : undefined}>
      <CartaoConteudo t={t} meuId={meuId} arrastavel={arrastavel} onAbrir={onAbrir} />
    </div>
  );
}

function CartaoConteudo({ t, meuId, arrastavel = false, overlay = false, onAbrir }: { t: DashboardTicket; meuId: string; arrastavel?: boolean; overlay?: boolean; onAbrir: (id: number) => void }) {
  return (
    // O cartão inteiro abre o ticket; o arraste só começa após 6px de movimento, então clique não arrasta.
    // O botão do assunto fica para o teclado: o clique dele sobe até o article, que faz a navegação.
    <article
      className={`ch-card ch-card--clicavel${arrastavel ? " ch-card--drag" : ""}${overlay ? " ch-card--overlay" : ""}`}
      onClick={overlay ? undefined : () => onAbrir(t.id)}
    >
      <div className="ch-card__meta">
        <span>
          <span className="ch-mono">#{t.id}</span> · {t.requester}
        </span>
        <span>{t.team}</span>
      </div>
      <button type="button" className="ch-card__subject" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {t.subject}
      </button>
      <div className="ch-card__row">
        <SlaBadge t={t} />
        <Responsavel t={t} meuId={meuId} />
      </div>
      {t.justificativa && <div className="ch-card__meta">{rotuloStatus(t.status, t.justificativa)}</div>}
    </article>
  );
}

// ---------- Lista agrupada ----------

function valorGrupo(t: DashboardTicket, por: NonNullable<Visao["agrupamento"]["por"]>, meuId: string, servicoNome: (id: number) => string): string {
  switch (por) {
    case "equipe":
      return t.team || "Sem equipe";
    case "responsavel":
      return t.owner ? (t.owner.id === meuId ? "Você" : t.owner.name) : "Não atribuído";
    case "status":
      return rotuloStatus(t.status, t.justificativa);
    case "servico":
      return servicoNome(t.service_id);
    case "origem":
      return t.origin;
    case "prioridade":
      return t.prioridade;
  }
}

const DATA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

type Extras = ListaExtras["tickets"][string] | undefined;

/** Data em ISO formatada; vazio = "—". */
function Data({ iso }: { iso: string | null | undefined }) {
  return iso ? <>{DATA.format(new Date(iso))}</> : <span className="ch-vazio">—</span>;
}

const vazio = <span className="ch-vazio">—</span>;

function Celula({ coluna, t, x, campos, meuId, servicoNome }: { coluna: ColunaLista; t: DashboardTicket; x: Extras; campos: CampoColuna[]; meuId: string; servicoNome: (id: number) => string }) {
  if (ehCampoAdicional(coluna)) {
    const chave = coluna.slice(6);
    const texto = formatarCampo(campos.find((c) => c.chave === chave)?.tipo, x?.campos[chave]);
    return texto ? <>{texto}</> : vazio;
  }
  switch (coluna) {
    case "solicitante":
      return <>{t.requester}</>;
    case "status":
      return <span className="ch-badge">{rotuloStatus(t.status, t.justificativa)}</span>;
    case "responsavel":
      return t.owner ? <>{t.owner.id === meuId ? "Você" : t.owner.name}</> : <span className="ch-badge ch-badge--warning">Não atribuído</span>;
    case "sla":
      return <SlaBadge t={t} />;
    case "origem":
      return <span className="ch-badge">{t.origin}</span>;
    case "servico":
      return <>{servicoNome(t.service_id)}</>;
    case "equipe":
      return <>{t.team}</>;
    case "prioridade":
      return <>{t.prioridade}</>;
    case "criado":
      return <>{DATA.format(new Date(t.criado_em))}</>;
    case "tags":
      return t.tags.length ? <>{t.tags.join(", ")}</> : vazio;
    case "recebido_em":
      return <>{t.recebido_em}</>;
    case "categoria":
      return x?.categoria ? <>{x.categoria}</> : vazio;
    case "setor":
      return x?.setor ? <>{x.setor}</> : vazio;
    case "contato":
      return x?.contato ? <>{x.contato}</> : vazio;
    case "criado_por":
      return x?.criado_por ? <>{x.criado_por}</> : vazio;
    case "atualizado":
      return <Data iso={x?.atualizado_em} />;
    case "primeira_resposta":
      return <Data iso={x?.primeira_resposta_em} />;
    case "prazo_resposta":
      return <Data iso={x?.sla_resposta_ate} />;
    case "prazo_solucao":
      return <Data iso={x?.sla_solucao_ate} />;
    case "encerrado":
      return <Data iso={x?.encerrado_em ?? t.closed_at} />;
    case "empreendimento":
      return x?.empreendimento ? (
        <>
          {x.empreendimento}
          {x.empreendimento_origem === "ia" && <span className="ch-badge ch-badge--info" style={{ marginLeft: 6 }}>IA</span>}
        </>
      ) : (
        vazio
      );
    case "setor_solicitante":
      return x?.setor_solicitante ? <>{x.setor_solicitante}</> : <span className="ch-badge ch-badge--warning">{A_IDENTIFICAR}</span>;
  }
}

const ORDEM_PRIORIDADE = ["Urgente", "Alta", "Normal", "Baixa"];

/** Valor para ordenar pelo cabeçalho: número e data viram número; o resto, texto. Vazio vai para o fim. */
function valorOrdem(coluna: ColunaLista, t: DashboardTicket, x: Extras, campos: CampoColuna[], meuId: string, servicoNome: (id: number) => string): string | number | null {
  const data = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
  const texto = (v: string | null | undefined) => (v ? v.toLowerCase() : null);
  if (ehCampoAdicional(coluna)) {
    const chave = coluna.slice(6);
    const tipo = campos.find((c) => c.chave === chave)?.tipo;
    const v = x?.campos[chave];
    if (v === undefined || v === null || v === "") return null;
    if (tipo === "numero") return Number(v);
    if (tipo === "data" || tipo === "data_hora") return Date.parse(String(v));
    return formatarCampo(tipo, v).toLowerCase();
  }
  switch (coluna) {
    case "solicitante": return texto(t.requester);
    case "status": return rotuloStatus(t.status, t.justificativa).toLowerCase();
    case "responsavel": return t.owner ? (t.owner.id === meuId ? "você" : t.owner.name.toLowerCase()) : null;
    case "sla": return t.sla_due_minutes;
    case "origem": return t.origin;
    case "servico": return texto(servicoNome(t.service_id));
    case "equipe": return texto(t.team);
    case "prioridade": return ORDEM_PRIORIDADE.indexOf(t.prioridade);
    case "criado": return Date.parse(t.criado_em);
    case "tags": return texto(t.tags.join(", "));
    case "recebido_em": return texto(t.recebido_em);
    case "categoria": return texto(x?.categoria);
    case "setor": return texto(x?.setor);
    case "contato": return texto(x?.contato);
    case "criado_por": return texto(x?.criado_por);
    case "atualizado": return data(x?.atualizado_em);
    case "primeira_resposta": return data(x?.primeira_resposta_em);
    case "prazo_resposta": return data(x?.sla_resposta_ate);
    case "prazo_solucao": return data(x?.sla_solucao_ate);
    case "encerrado": return data(x?.encerrado_em ?? t.closed_at);
    case "empreendimento": return texto(x?.empreendimento);
    case "setor_solicitante": return texto(x?.setor_solicitante);
  }
}

const DIA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
const SLA_FAIXAS = ["Vencido", "Vence em até 24h", "No prazo", "Encerrado"];

/** Valores do filtro de uma coluna para o ticket (Tags pode ter vários). Datas viram o dia; SLA, a faixa. */
function valoresFiltro(coluna: ColunaFiltro, t: DashboardTicket, x: Extras, campos: CampoColuna[], meuId: string, servicoNome: (id: number) => string): string[] {
  const dia = (iso: string | null | undefined) => [iso ? DIA.format(new Date(iso)) : VAZIO];
  const txt = (v: string | null | undefined) => [v?.trim() || VAZIO];
  if (coluna === "ticket") return txt(t.subject);
  if (ehCampoAdicional(coluna)) {
    const chave = coluna.slice(6);
    return txt(formatarCampo(campos.find((c) => c.chave === chave)?.tipo, x?.campos[chave]));
  }
  switch (coluna) {
    case "solicitante": return txt(t.requester);
    case "status": return txt(rotuloStatus(t.status, t.justificativa));
    case "responsavel": return [t.owner ? (t.owner.id === meuId ? "Você" : t.owner.name) : "Não atribuído"];
    case "sla": {
      if (isClosed(t)) return [SLA_FAIXAS[3]];
      const m = t.sla_due_minutes;
      return [m < 0 ? SLA_FAIXAS[0] : m <= 24 * 60 ? SLA_FAIXAS[1] : SLA_FAIXAS[2]];
    }
    case "origem": return txt(t.origin);
    case "servico": return txt(servicoNome(t.service_id));
    case "equipe": return txt(t.team);
    case "prioridade": return txt(t.prioridade);
    case "criado": return dia(t.criado_em);
    case "tags": return t.tags.length ? t.tags : [VAZIO];
    case "recebido_em": return txt(t.recebido_em);
    case "categoria": return txt(x?.categoria);
    case "setor": return txt(x?.setor);
    case "contato": return txt(x?.contato);
    case "criado_por": return txt(x?.criado_por);
    case "atualizado": return dia(x?.atualizado_em);
    case "primeira_resposta": return dia(x?.primeira_resposta_em);
    case "prazo_resposta": return dia(x?.sla_resposta_ate);
    case "prazo_solucao": return dia(x?.sla_solucao_ate);
    case "encerrado": return dia(x?.encerrado_em ?? t.closed_at);
    case "empreendimento": return txt(x?.empreendimento);
    case "setor_solicitante": return [x?.setor_solicitante?.trim() || A_IDENTIFICAR];
  }
}

/** Ordem das opções no filtro: faixas e prioridades na ordem natural, datas da mais nova, o resto em A–Z; vazio por último. */
function ordenarOpcoes(coluna: ColunaFiltro, opcoes: OpcaoFiltro[]): OpcaoFiltro[] {
  const fixa = coluna === "sla" ? SLA_FAIXAS : coluna === "prioridade" ? ORDEM_PRIORIDADE : null;
  const data = (v: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    return m ? Number(`${m[3]}${m[2]}${m[1]}`) : null;
  };
  return [...opcoes].sort((a, b) => {
    if (a.valor === VAZIO || b.valor === VAZIO) return a.valor === VAZIO ? 1 : -1;
    if (fixa) return fixa.indexOf(a.valor) - fixa.indexOf(b.valor);
    const da = data(a.valor);
    const db = data(b.valor);
    if (da !== null && db !== null) return db - da;
    return a.valor.localeCompare(b.valor, "pt-BR", { numeric: true });
  });
}

/** O ticket atende a todos os filtros ativos (em cada coluna, a qualquer um dos valores marcados)? */
function passaFiltros(
  doTicket: Map<ColunaFiltro, string[]> | undefined,
  filtros: Partial<Record<ColunaFiltro, Set<string>>>,
  colunas: readonly ColunaFiltro[],
  ignorar?: ColunaFiltro,
): boolean {
  return colunas.every((c) => {
    const sel = filtros[c];
    if (c === ignorar || !sel || sel.size === 0) return true;
    return (doTicket?.get(c) ?? []).some((v) => sel.has(v));
  });
}

function Listagem({ visao, tickets, meuId, servicoNome, onAbrir }: { visao: Visao; tickets: DashboardTicket[]; meuId: string; servicoNome: (id: number) => string; onAbrir: (id: number) => void }) {
  const [pagina, setPagina] = useState(0);
  /** Ordenação pelo cabeçalho: só nesta tela, não salva na visão. */
  const [ordem, setOrdem] = useState<{ coluna: ColunaLista; asc: boolean } | null>(null);
  const { por, ordemGrupos, ordenar, porPagina, colunas } = visao.agrupamento;
  const extras = useListaExtras(precisaExtras(colunas));
  const campos = useMemo(() => extras.data?.campos ?? [], [extras.data]);
  const extrasDe = (t: DashboardTicket): Extras => extras.data?.tickets[String(t.id)];

  /** Filtros do cabeçalho (múltipla escolha por coluna): só nesta tela, não salvos na visão. */
  const [filtros, setFiltros] = useState<Partial<Record<ColunaFiltro, Set<string>>>>({});
  const colunasFiltro = useMemo<ColunaFiltro[]>(() => ["ticket", ...colunas], [colunas]);
  const ativos = colunasFiltro.filter((c) => (filtros[c]?.size ?? 0) > 0);

  /** Valores de cada coluna por ticket, calculados uma vez para filtrar e montar as opções. */
  const valores = useMemo(() => {
    const mapa = new Map<number, Map<ColunaFiltro, string[]>>();
    for (const t of tickets) {
      const x = extras.data?.tickets[String(t.id)];
      mapa.set(t.id, new Map(colunasFiltro.map((c) => [c, valoresFiltro(c, t, x, campos, meuId, servicoNome)])));
    }
    return mapa;
  }, [tickets, colunasFiltro, extras.data, campos, meuId, servicoNome]);

  const passa = (t: DashboardTicket, ignorar?: ColunaFiltro) => passaFiltros(valores.get(t.id), filtros, colunasFiltro, ignorar);

  const filtrados = useMemo(() => tickets.filter((t) => passaFiltros(valores.get(t.id), filtros, colunasFiltro)), [tickets, valores, filtros, colunasFiltro]);

  /** Opções de uma coluna considerando os outros filtros (como numa planilha), com a contagem de tickets. */
  const opcoesDe = (c: ColunaFiltro): OpcaoFiltro[] => {
    const qtd = new Map<string, number>();
    for (const t of tickets) {
      if (!passa(t, c)) continue;
      for (const v of new Set(valores.get(t.id)?.get(c) ?? [])) qtd.set(v, (qtd.get(v) ?? 0) + 1);
    }
    // Valor marcado que sumiu com outro filtro continua na lista, para poder desmarcar.
    for (const v of filtros[c] ?? []) if (!qtd.has(v)) qtd.set(v, 0);
    return ordenarOpcoes(c, [...qtd].map(([valor, n]) => ({ valor, qtd: n })));
  };

  const mudarFiltro = (c: ColunaFiltro, sel: Set<string> | null) => {
    setPagina(0);
    setFiltros((f) => ({ ...f, [c]: sel ?? new Set() }));
  };

  const rotuloFiltro = (c: ColunaFiltro) => (c === "ticket" ? "Ticket" : rotuloColuna(c, campos));

  const ordenados = useMemo(() => {
    const base = ordenarTickets(filtrados, ordenar);
    if (!ordem) return base;
    const chave = new Map(base.map((t) => [t.id, valorOrdem(ordem.coluna, t, extras.data?.tickets[String(t.id)], campos, meuId, servicoNome)]));
    return [...base].sort((a, b) => {
      const va = chave.get(a.id) ?? null;
      const vb = chave.get(b.id) ?? null;
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "pt-BR");
      return ordem.asc ? r : -r;
    });
  }, [filtrados, ordenar, ordem, extras.data, campos, meuId, servicoNome]);

  const grupos = useMemo(() => {
    if (!por) return [{ nome: "", itens: ordenados }];
    const mapa = new Map<string, DashboardTicket[]>();
    for (const t of ordenados) {
      const k = valorGrupo(t, por, meuId, servicoNome);
      mapa.set(k, [...(mapa.get(k) ?? []), t]);
    }
    return [...mapa]
      .map(([nome, itens]) => ({ nome, itens }))
      .sort((a, b) => (ordemGrupos === "quantidade" ? b.itens.length - a.itens.length : 0) || a.nome.localeCompare(b.nome, "pt-BR"));
  }, [ordenados, por, ordemGrupos, meuId, servicoNome]);

  // Pagina sobre a lista já agrupada; o cabeçalho do grupo repete na página seguinte.
  const linhas = grupos.flatMap((g) => g.itens.map((t) => ({ grupo: g.nome, total: g.itens.length, t })));
  const totalPaginas = Math.max(1, Math.ceil(linhas.length / porPagina));
  const atual = Math.min(pagina, totalPaginas - 1);
  const visiveis = linhas.slice(atual * porPagina, (atual + 1) * porPagina);

  if (tickets.length === 0) return <p className="ch-empty card">Nenhum ticket atende a esta visão agora.</p>;

  const filtro = (c: ColunaFiltro) => (
    <FiltroColuna rotulo={rotuloFiltro(c)} opcoes={opcoesDe(c)} selecionados={filtros[c] ?? new Set()} onChange={(sel) => mudarFiltro(c, sel)} />
  );
  const TicketIcone = iconeColuna("ticket");

  return (
    <>
      {ativos.length > 0 && (
        <div className="ch-filtros-ativos" aria-label="Filtros ativos">
          {ativos.map((c) => {
            const Icone = iconeColuna(c);
            const sel = [...(filtros[c] ?? [])];
            return (
              <span key={c} className="ch-filtro-chip">
                <Icone size={13} aria-hidden="true" />
                <strong>{rotuloFiltro(c)}:</strong>
                <span className="ch-filtro-chip__valores" title={sel.join(", ")}>
                  {sel.length > 2 ? `${sel.slice(0, 2).join(", ")} +${sel.length - 2}` : sel.join(", ")}
                </span>
                <button type="button" aria-label={`Remover filtro de ${rotuloFiltro(c)}`} onClick={() => mudarFiltro(c, null)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            );
          })}
          <button type="button" className="ch-link" onClick={() => { setPagina(0); setFiltros({}); }}>
            Limpar filtros
          </button>
          <span className="ch-count" aria-live="polite">{filtrados.length} de {tickets.length} tickets</span>
        </div>
      )}
      <div className="ch-table-wrap">
        <table className="ch-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="ch-th">
                  <TicketIcone size={14} className="ch-th__icone" aria-hidden="true" />
                  Ticket
                  {filtro("ticket")}
                </span>
              </th>
              {colunas.map((c) => {
                const ativa = ordem?.coluna === c;
                const Icone = iconeColuna(c);
                return (
                  <th key={c} scope="col" aria-sort={ativa ? (ordem.asc ? "ascending" : "descending") : "none"}>
                    <span className="ch-th">
                      <button
                        type="button"
                        className="ch-th-ordem"
                        title="Ordenar (só para você)"
                        onClick={() => {
                          setPagina(0);
                          setOrdem(ativa ? (ordem.asc ? { coluna: c, asc: false } : null) : { coluna: c, asc: true });
                        }}
                      >
                        <Icone size={14} className="ch-th__icone" aria-hidden="true" />
                        {rotuloColuna(c, campos)}
                        {ativa && <span className="ch-th-ordem__seta" aria-hidden="true">{ordem.asc ? "▲" : "▼"}</span>}
                      </button>
                      {filtro(c)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visiveis.length === 0 && (
              <tr>
                <td colSpan={colunas.length + 1} className="ch-filtro-vazio">
                  Nenhum ticket com esses filtros.{" "}
                  <button type="button" className="ch-link" onClick={() => setFiltros({})}>
                    Limpar filtros
                  </button>
                </td>
              </tr>
            )}
            {visiveis.map(({ grupo, total, t }, i) => (
              <FragmentoLinha key={t.id} mostrarGrupo={Boolean(por) && (i === 0 || visiveis[i - 1].grupo !== grupo)} grupo={grupo} total={total} colSpan={colunas.length + 1} rotuloGrupo={por ? AGRUPAMENTOS[por] : ""}>
                {/* A linha inteira abre o ticket; o botão do assunto fica para o teclado (o clique dele sobe até a linha). */}
                <tr className="ch-table__row--clicavel" onClick={() => onAbrir(t.id)}>
                  <td>
                    <span className="ch-mono ch-muted" style={{ fontSize: 12 }}>#{t.id}</span>
                    <br />
                    <button type="button" className="ch-link">{t.subject}</button>
                  </td>
                  {colunas.map((c) => (
                    <td key={c}>
                      <Celula coluna={c} t={t} x={extrasDe(t)} campos={campos} meuId={meuId} servicoNome={servicoNome} />
                    </td>
                  ))}
                </tr>
              </FragmentoLinha>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ch-pager">
        <span aria-live="polite">
          {linhas.length === 0 ? 0 : atual * porPagina + 1}–{Math.min((atual + 1) * porPagina, linhas.length)} de {linhas.length} tickets
        </span>
        <span>
          <button type="button" className="icon-btn icon-btn--bordered" aria-label="Página anterior" disabled={atual === 0} onClick={() => setPagina(atual - 1)}>←</button>{" "}
          <button type="button" className="icon-btn icon-btn--bordered" aria-label="Próxima página" disabled={atual >= totalPaginas - 1} onClick={() => setPagina(atual + 1)}>→</button>
        </span>
      </div>
    </>
  );
}

function FragmentoLinha({ mostrarGrupo, grupo, total, colSpan, rotuloGrupo, children }: { mostrarGrupo: boolean; grupo: string; total: number; colSpan: number; rotuloGrupo: string; children: ReactNode }) {
  return (
    <>
      {mostrarGrupo && (
        <tr className="ch-table__group">
          <td colSpan={colSpan}>
            <span className="visually-hidden">{rotuloGrupo}: </span>
            {grupo}
            <small>{total} tickets</small>
          </td>
        </tr>
      )}
      {children}
    </>
  );
}
