import { ArrowLeft, Bell, BellOff, CheckCircle2, Copy, GitMerge, History, Lightbulb, Lock, MoreVertical, Printer, RotateCcw, Timer, Trash2, Zap } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { DetailDialog, formatDuration } from "../../../components/ds";
import { getMenuItem } from "../../../config/menuRegistry";
import { useAccess } from "../../configuracoes/access/useAccess";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { estadoCampos } from "../cadastros/regras";
import { caminhoServico, equipeDoServico, type Cadastros, type Campo, type Macro } from "../cadastros/types";
import { useCadastros, useMacros, useStatusTickets } from "../hooks";
import { rotuloStatus, type StatusTicket } from "../status/types";
import {
  useAdicionarAcao,
  useAtualizarDetalhe,
  useClonarTicket,
  useExcluirTicket,
  useMesclarTicket,
  useResponsaveis,
  useSeguirTicket,
  useSolucoesAnteriores,
  useTicket,
} from "./hooks";
import { ORIGENS, type PatchTicket, type Responsavel, type TicketDetalhe } from "./types";
import "../pages/Chamados.css";
import "../cadastros/Cadastros.css";
import { LinhaDoTempo } from "./LinhaDoTempo";

const ConversaAoVivo = lazy(() => import("../../atendimento/pages/ConversaAoVivo").then((m) => ({ default: m.ConversaAoVivo })));
import { ServicoBusca } from "./ServicoBusca";
import { CampoEmpreendimento } from "../empreendimentos/CampoEmpreendimento";
import { CampoSetorSolicitante } from "./CampoSetorSolicitante";
import "./Ticket.css";

// Gestão de Chamados › Tickets › #número (mockup aprovado docs/mockups/tela-ticket.html): classificar à
// esquerda, responder ao solicitante ou anotar no centro, usar a solução anterior e as funções do menu Opções.
// Os campos da esquerda são salvos junto com a ação (Wagner, 08/10/2026): ao enviar, o compositor exige serviço,
// status e texto, e grava tudo numa chamada só (ch_ticket_acao com "campos" e "statusDepois").

const TZ = "America/Sao_Paulo";
const DATA_HORA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const DIA_HORA = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const fmt = (iso: string | null | undefined) => (iso ? DATA_HORA.format(new Date(iso)) : "—");
const erroMsg = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);
const chaveStatus = (statusId: number, justificativaId: number | null) => `${statusId}:${justificativaId ?? ""}`;
const lerStatus = (v: string) => {
  const [s, j] = v.split(":");
  return { statusId: Number(s), justificativaId: j ? Number(j) : null };
};

function iniciais(nome: string) {
  const p = nome.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

export function TicketTela() {
  const { numero } = useParams();
  const id = Number(numero);
  const ticket = useTicket(id);
  const cad = useCadastros();
  const status = useStatusTickets();
  const resp = useResponsaveis();
  const macros = useMacros();

  if (ticket.isPending || cad.isPending || status.isPending) return <PageSkeleton />;
  if (ticket.isError) {
    const naoAchou = ticket.error instanceof ServiceError && ticket.error.code === "NOT_FOUND";
    return naoAchou ? (
      <div className="card">
        <EmptyState icon={Lock} title={`Ticket #${numero} não encontrado`} description="Ele não existe ou não está visível para você." />
      </div>
    ) : (
      <ErrorState message="Não foi possível abrir o ticket." onRetry={() => void ticket.refetch()} />
    );
  }
  if (cad.isError || status.isError) return <ErrorState message="Não foi possível carregar os cadastros." onRetry={() => void Promise.all([cad.refetch(), status.refetch()])} />;
  return <TicketConteudo d={ticket.data} cad={cad.data} status={status.data} responsaveis={resp.data ?? []} macros={macros.data ?? []} />;
}

interface ConteudoProps {
  d: TicketDetalhe;
  cad: Cadastros;
  status: StatusTicket[];
  responsaveis: Responsavel[];
  macros: Macro[];
}

function TicketConteudo({ d, cad, status, responsaveis, macros }: ConteudoProps) {
  const { user } = useAccess();
  const navigate = useNavigate();
  const atualizar = useAtualizarDetalhe();
  const seguir = useSeguirTicket();
  const [menu, setMenu] = useState(false);
  const [dialogo, setDialogo] = useState<"sla" | "clonar" | "mesclar" | "excluir" | "prazo" | null>(null);
  // "Status após enviar" do compositor. Fica aqui para o seletor do topo poder preencher (Resolvido/Fechado).
  const [depois, setDepois] = useState("");
  // Linha do tempo com o histórico de alterações ligado: quem fez e o que fez (modelo Movidesk).
  const [historico, setHistorico] = useState(true);
  // Compositor (fora do formulário da esquerda, para não perder o texto quando os campos são salvos).
  const [tipo, setTipo] = useState<"publica" | "interna">("publica");
  const [texto, setTexto] = useState("");
  const textoRef = useRef<HTMLTextAreaElement>(null);
  const [macroAberta, setMacroAberta] = useState(false);
  // Campos alterados à esquerda, ainda não salvos: vão junto com a próxima ação.
  const rascunho = useRef<Rascunho>({ patch: {}, servicoId: d.servicoId });
  const ticketsPath = getMenuItem("gestao_chamados_tickets").path;
  const guardarRascunho = useMemo(
    () => (r: Rascunho) => {
      rascunho.current = r;
    },
    [],
  );
  const statusAtual = status.find((s) => s.id === d.statusId);
  // Encerrado (resolvido, fechado ou cancelado): só leitura até "Reabrir ticket".
  const encerrado = Boolean(statusAtual && ["resolvido", "fechado", "cancelado"].includes(statusAtual.categoria));
  const bloqueado = Boolean(d.mescladoEmId || d.excluidoEm || encerrado);
  const justAtual = statusAtual?.justificativas.find((j) => j.id === d.justificativaId);

  const mudarStatus = (v: string) => {
    const alvo = lerStatus(v);
    const st = status.find((s) => s.id === alvo.statusId);
    // Encerrar exige a ação de encerramento: o seletor só prepara o compositor.
    if (st && (st.categoria === "resolvido" || st.categoria === "fechado")) {
      setDepois(v);
      focarResposta("publica");
      toast.info(`Escreva a ação de encerramento e clique em "Adicionar ação" para deixar o ticket ${st.nome.toLowerCase()}.`);
      return;
    }
    atualizar.mutate({ id: d.id, patch: alvo }, { onSuccess: () => toast.success(`Status: ${rotuloStatus(st?.nome ?? "", st?.justificativas.find((j) => j.id === alvo.justificativaId)?.nome)}`), onError: (e) => toast.error(erroMsg(e, "Não foi possível mudar o status.")) });
  };

  const reabrir = () => {
    const alvo =
      status.find((s) => s.ativo && s.categoria === "andamento" && s.nome.trim().toLowerCase() === "reaberto") ??
      [...status].filter((s) => s.ativo && s.categoria === "andamento").sort((a, b) => a.ordem - b.ordem)[0];
    if (!alvo) {
      toast.error("Cadastre um status de atendimento para poder reabrir.");
      return;
    }
    atualizar.mutate(
      { id: d.id, patch: { statusId: alvo.id, justificativaId: null } },
      { onSuccess: () => toast.success(`Ticket #${d.id} reaberto (${alvo.nome}).`), onError: (e) => toast.error(erroMsg(e, "Não foi possível reabrir o ticket.")) },
    );
  };

  function focarResposta(t: "publica" | "interna") {
    setTipo(t);
    setTimeout(() => textoRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!menu) return;
    const fechar = (e: MouseEvent) => !(e.target as HTMLElement).closest(".tk-menu") && setMenu(false);
    document.addEventListener("click", fechar);
    return () => document.removeEventListener("click", fechar);
  }, [menu]);

  const itemMenu = (acao: () => void) => () => {
    setMenu(false);
    acao();
  };

  return (
    <div className="tk">
      {/* ---------- Barra ---------- */}
      <div className="tk-bar">
        <Link className="btn btn--outline" to={ticketsPath}>
          <ArrowLeft size={16} aria-hidden="true" />
          Fila
        </Link>
        <div className="tk-bar__who">
          <span className="tk-bar__num">#{d.id}</span>
          <span className="ch-muted">·</span>
          <span>{d.solicitante.nome}</span>
          <span className="ch-badge">{ORIGENS[d.origem]}</span>
          {d.recebidoEm && d.recebidoEm !== ORIGENS[d.origem] && <span className="ch-badge ch-badge--info">{d.recebidoEm}</span>}
        </div>
        <span className="tk-bar__spacer" />
        <button
          type="button"
          className="btn btn--outline"
          aria-pressed={d.seguindo}
          onClick={() => seguir.mutate({ id: d.id, seguir: !d.seguindo }, { onSuccess: () => toast.success(d.seguindo ? "Você deixou de seguir este ticket" : "Você vai receber os avisos deste ticket") })}
        >
          {d.seguindo ? <BellOff size={15} aria-hidden="true" /> : <Bell size={15} aria-hidden="true" />}
          {d.seguindo ? "Seguindo" : "Seguir"}
        </button>
        {encerrado ? (
          <>
            <span className="tk-encerrado" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              {rotuloStatus(statusAtual?.nome ?? "", justAtual?.nome)}
              {d.encerradoEm ? ` em ${fmt(d.encerradoEm)}` : ""}
            </span>
          </>
        ) : (
        <select className="input tk-status" aria-label="Status do ticket" value={chaveStatus(d.statusId, d.justificativaId)} disabled={bloqueado || atualizar.isPending} onChange={(e) => mudarStatus(e.target.value)}>
          {status
            .filter((s) => s.ativo || s.id === d.statusId)
            .flatMap((s) => [
              <option key={`${s.id}:`} value={chaveStatus(s.id, null)}>
                {s.nome}
              </option>,
              ...s.justificativas
                .filter((j) => j.ativa || j.id === d.justificativaId)
                .map((j) => (
                  <option key={`${s.id}:${j.id}`} value={chaveStatus(s.id, j.id)}>
                    {rotuloStatus(s.nome, j.nome)}
                  </option>
                )),
            ])}
        </select>
        )}
        <div className="tk-menu">
          <button type="button" className="btn btn--outline" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            Opções
            <MoreVertical size={15} aria-hidden="true" />
          </button>
          {menu && (
            <div className="tk-menu__lista" role="menu">
              <button role="menuitem" type="button" disabled={bloqueado} onClick={itemMenu(() => focarResposta("interna"))}>
                <Lock size={15} aria-hidden="true" /> Enviar mensagem interna
              </button>
              <button role="menuitem" type="button" disabled={bloqueado} onClick={itemMenu(() => setMacroAberta(true))}>
                <Zap size={15} aria-hidden="true" /> Aplicar macro
              </button>
              <hr />
              <button role="menuitem" type="button" onClick={itemMenu(() => setDialogo("sla"))}>
                <Timer size={15} aria-hidden="true" /> Detalhes do SLA
              </button>
              <button role="menuitem" type="button" onClick={itemMenu(() => setHistorico(true))}>
                <History size={15} aria-hidden="true" /> Eventos do ticket
              </button>
              <button role="menuitem" type="button" onClick={itemMenu(() => window.print())}>
                <Printer size={15} aria-hidden="true" /> Imprimir ticket
              </button>
              <hr />
              <button role="menuitem" type="button" onClick={itemMenu(() => setDialogo("clonar"))}>
                <Copy size={15} aria-hidden="true" /> Clonar ticket
              </button>
              <button role="menuitem" type="button" disabled={bloqueado} onClick={itemMenu(() => setDialogo("mesclar"))}>
                <GitMerge size={15} aria-hidden="true" /> Mesclar ticket
              </button>
              {d.podeExcluir && (
                <button role="menuitem" type="button" className="tk-menu__perigo" onClick={itemMenu(() => setDialogo("excluir"))}>
                  <Trash2 size={15} aria-hidden="true" /> Excluir ticket
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tk-grid">
        <PainelCampos
          key={`${d.id}-${d.eventos.length}`}
          d={d}
          cad={cad}
          responsaveis={responsaveis}
          meuId={user?.id ?? ""}
          bloqueado={bloqueado}
          onAlterarPrazo={() => setDialogo("prazo")}
          onRascunho={guardarRascunho}
        />

        <section className="tk-main" aria-label="Conversa do ticket">
          <h1 className="tk-titulo">{d.assunto}</h1>
          <p className="tk-sub">
            Ticket aberto via {ORIGENS[d.origem].toLowerCase()} pelo solicitante <b>{d.solicitante.nome}</b> em {fmt(d.criadoEm)} · equipe{" "}
            <b>{cad.equipes.find((e) => e.id === d.equipeId)?.nome ?? "sem equipe"}</b> · status <b>{rotuloStatus(statusAtual?.nome ?? "?", justAtual?.nome)}</b>
          </p>
          {d.origem === "whatsapp" && !d.encerradoEm && (
            <Suspense fallback={null}>
              <ConversaAoVivo ticketId={d.id} />
            </Suspense>
          )}
          {!d.encerradoEm && (
            <p className="tk-limite">
              {d.primeiraRespostaEm ? `Primeira resposta em ${fmt(d.primeiraRespostaEm)}.` : `Limite para a primeira resposta: ${d.slaRespostaAte ? DIA_HORA.format(new Date(d.slaRespostaAte)) : "—"}.`}
            </p>
          )}
          {d.mescladoEmId && (
            <div className="tk-aviso">
              Este ticket foi <b>mesclado</b> em <Link to={`${ticketsPath}/${d.mescladoEmId}`}>#{d.mescladoEmId}</Link>: as respostas continuam lá.
            </div>
          )}
          {d.excluidoEm && <div className="tk-aviso">Este ticket foi excluído em {fmt(d.excluidoEm)}.</div>}
          {encerrado && !d.mescladoEmId && !d.excluidoEm && (
            // Tarja de ticket encerrado (modelo Movidesk): em destaque, com o botão de reabrir.
            <div className="tk-tarja" role="status">
              <div className="tk-tarja__texto">
                <b>
                  Esse ticket está {(statusAtual?.nome ?? "encerrado").toLowerCase()} e por isso não poderá ser atualizado.
                </b>
                <span>
                  {d.encerradoEm ? `${statusAtual?.nome ?? "Encerrado"} em ${fmt(d.encerradoEm)}. ` : ""}Para voltar ao atendimento, reabra o ticket. Se o solicitante responder ao
                  e-mail, ele reabre sozinho.
                </span>
              </div>
              <button type="button" className="tk-tarja__reabrir" disabled={atualizar.isPending} onClick={reabrir}>
                <RotateCcw size={16} aria-hidden="true" />
                {atualizar.isPending ? "Reabrindo…" : "Reabrir ticket"}
              </button>
            </div>
          )}

          {!bloqueado && (
            <Compositor
              d={d}
              status={status}
              macros={macros}
              tipo={tipo}
              setTipo={setTipo}
              texto={texto}
              setTexto={setTexto}
              textoRef={textoRef}
              macroAberta={macroAberta}
              setMacroAberta={setMacroAberta}
              nomeAgente={user?.name ?? "Equipe"}
              obterRascunho={() => rascunho.current}
              depois={depois}
              setDepois={setDepois}
            />
          )}

          <SolucaoAnterior
            d={d}
            bloqueado={bloqueado}
            onUsarNaResposta={(t) => {
              setTexto((atual) => (atual.trim() ? `${atual}\n\n${t}` : t));
              focarResposta("publica");
              toast.success("Solução colocada na resposta. Revise antes de enviar.");
            }}
          />

          <p className="tk-rel">
            {d.clonadoDeId || d.clones.length || d.mesclados.length || d.mescladoEmId ? (
              <>
                Relacionamentos:{" "}
                {d.clonadoDeId && (
                  <>
                    clonado de <Link to={`${ticketsPath}/${d.clonadoDeId}`}>#{d.clonadoDeId}</Link>.{" "}
                  </>
                )}
                {d.clones.map((c) => (
                  <span key={c}>
                    clonado para <Link to={`${ticketsPath}/${c}`}>#{c}</Link>.{" "}
                  </span>
                ))}
                {d.mesclados.map((m) => (
                  <span key={m}>
                    recebeu #{m} (mesclado).{" "}
                  </span>
                ))}
              </>
            ) : (
              "Nenhum relacionamento (clonado, mesclado ou pai/filho) para este ticket."
            )}
          </p>

          <LinhaDoTempo d={d} historico={historico} setHistorico={setHistorico} />
        </section>
      </div>

      {/* ---------- Diálogos ---------- */}
      {dialogo === "prazo" && <DialogoPrazo d={d} onFechar={() => setDialogo(null)} />}
      {dialogo === "sla" && <DialogoSla d={d} cad={cad} onFechar={() => setDialogo(null)} />}
      {dialogo === "clonar" && <DialogoClonar d={d} onFechar={() => setDialogo(null)} onClonado={(novo) => navigate(`${ticketsPath}/${novo}`)} />}
      {dialogo === "mesclar" && <DialogoMesclar d={d} onFechar={() => setDialogo(null)} />}
      {dialogo === "excluir" && <DialogoExcluir d={d} onFechar={() => setDialogo(null)} onExcluido={() => navigate(ticketsPath)} />}
    </div>
  );
}

// ---------- Esquerda: classificação ----------

interface Rascunho {
  patch: PatchTicket;
  servicoId: number | null;
}

interface PainelProps {
  d: TicketDetalhe;
  cad: Cadastros;
  responsaveis: Responsavel[];
  meuId: string;
  bloqueado: boolean;
  onAlterarPrazo: () => void;
  onRascunho: (r: Rascunho) => void;
}

function PainelCampos({ d, cad, responsaveis, meuId, bloqueado, onAlterarPrazo, onRascunho }: PainelProps) {
  const servicoRotuloId = useId();
  const [aba, setAba] = useState<"publico" | "interno">("publico");
  const [servicoId, setServicoId] = useState<number | null>(d.servicoId);
  const [categoriaId, setCategoriaId] = useState<number | null>(d.categoriaId);
  const [urgenciaId, setUrgenciaId] = useState<number>(d.urgenciaId);
  const [equipeId, setEquipeId] = useState<number | null>(d.equipeId);
  const [responsavelId, setResponsavelId] = useState<string | null>(d.responsavelId);
  const [campos, setCampos] = useState<Record<string, unknown>>(d.campos);
  const [tags, setTags] = useState(d.tags.join(", "));
  const [cc, setCc] = useState(d.cc.join("; "));

  const folhas = useMemo(
    () =>
      cad.servicos
        .filter((s) => (s.ativo || s.id === d.servicoId) && !cad.servicos.some((f) => f.paiId === s.id))
        .sort((a, b) => caminhoServico(a.id, cad.servicos).localeCompare(caminhoServico(b.id, cad.servicos), "pt-BR")),
    [cad.servicos, d.servicoId],
  );
  const opcoesServico = useMemo(() => folhas.map((s) => ({ id: s.id, rotulo: caminhoServico(s.id, cad.servicos) })), [folhas, cad.servicos]);
  const setorAtual = cad.servicos.find((s) => s.id === servicoId)?.setorId ?? d.setorId;
  const estado = estadoCampos(cad.campos, cad.regras, { servicoId, categoriaId, urgenciaId, setorId: setorAtual, origem: d.origem, campos }, cad.servicos);
  const visiveis = (interno: boolean) =>
    [...cad.campos].filter((c) => c.ativo && c.interno === interno && c.aparece.includes("detalhe") && estado[c.chave]?.visivel).sort((a, b) => a.ordem - b.ordem);

  const listaTags = tags.split(",").map((x) => x.trim()).filter(Boolean);
  const listaCc = cc.split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
  const patch: PatchTicket = {};
  if (servicoId !== d.servicoId) patch.servicoId = servicoId;
  if (categoriaId !== d.categoriaId) patch.categoriaId = categoriaId;
  if (urgenciaId !== d.urgenciaId) patch.urgenciaId = urgenciaId;
  if (equipeId !== d.equipeId) patch.equipeId = equipeId;
  if (responsavelId !== d.responsavelId) patch.responsavelId = responsavelId;
  if (JSON.stringify(campos) !== JSON.stringify(d.campos)) patch.campos = campos;
  if (listaTags.join("|") !== d.tags.join("|")) patch.tags = listaTags;
  if (listaCc.join("|") !== d.cc.join("|")) patch.cc = listaCc;
  const sujo = Object.keys(patch).length > 0;
  const patchJson = JSON.stringify(patch);

  // Sem botão "Salvar campos": o compositor lê este rascunho e salva junto com a ação.
  useEffect(() => {
    onRascunho({ patch: JSON.parse(patchJson) as PatchTicket, servicoId });
  }, [patchJson, servicoId, onRascunho]);

  const enviar = (e: FormEvent) => e.preventDefault();

  // Equipe › Pessoa: as equipes do setor do ticket (ou todas) e seus membros.
  const equipes = cad.equipes.filter((e) => e.ativa && (e.setorId === setorAtual || e.id === equipeId));
  const valorResp = `${equipeId ?? ""}|${responsavelId ?? ""}`;
  const opcoesResp: { value: string; label: string }[] = [{ value: "|", label: "— Sem equipe e sem responsável —" }];
  for (const e of equipes) {
    opcoesResp.push({ value: `${e.id}|`, label: `${e.nome} › (sem pessoa)` });
    for (const r of responsaveis.filter((x) => x.equipes.includes(e.id))) opcoesResp.push({ value: `${e.id}|${r.id}`, label: `${e.nome} › ${r.nome}` });
  }
  // O serviço define a equipe; o responsável fica se for dessa equipe.
  const escolherServico = (id: number | null) => {
    setServicoId(id);
    const eq = equipeDoServico(id, cad.servicos);
    if (eq === null || eq === equipeId) return;
    setEquipeId(eq);
    if (responsavelId && !responsaveis.find((r) => r.id === responsavelId)?.equipes.includes(eq)) setResponsavelId(null);
  };
  // Seleciona o usuário logado. Equipe: a do serviço se ele for dela; senão a atual (se for dele) ou uma das dele no setor.
  const atribuirParaMim = () => {
    const minhas = responsaveis.find((r) => r.id === meuId)?.equipes ?? [];
    const doServico = equipeDoServico(servicoId, cad.servicos);
    const eq =
      doServico !== null && minhas.includes(doServico)
        ? doServico
        : equipeId !== null && minhas.includes(equipeId)
          ? equipeId
          : (equipes.find((e) => minhas.includes(e.id))?.id ?? equipeId);
    setEquipeId(eq);
    setResponsavelId(meuId);
  };
  if (!opcoesResp.some((o) => o.value === valorResp)) {
    const nome = responsaveis.find((r) => r.id === responsavelId)?.nome ?? (responsavelId === meuId ? "Você" : "Responsável atual");
    opcoesResp.push({ value: valorResp, label: `${cad.equipes.find((e) => e.id === equipeId)?.nome ?? "Sem equipe"} › ${nome}` });
  }

  return (
    <form className="tk-left" aria-label="Dados do ticket" onSubmit={enviar}>
      <div className="tk-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={aba === "publico"} onClick={() => setAba("publico")}>
          Público
        </button>
        <button type="button" role="tab" aria-selected={aba === "interno"} onClick={() => setAba("interno")}>
          Interno
        </button>
      </div>
      <fieldset disabled={bloqueado} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {aba === "publico" ? (
          <>
            <div className="field">
              <span className="field__label">Solicitante</span>
              <div className="tk-pessoa">
                <span className="tk-av" aria-hidden="true">
                  {iniciais(d.solicitante.nome)}
                </span>
                <div>
                  <b>{d.solicitante.nome}</b>
                  <small>
                    {d.solicitante.contato ?? "sem contato"}
                    {d.solicitante.departamento ? ` · Departamento ${d.solicitante.departamento}` : ""}
                  </small>
                </div>
              </div>
            </div>
            <CampoSetorSolicitante d={d} bloqueado={bloqueado} />
            <div className="field">
              <span className="field__label tk-req" id={servicoRotuloId}>
                Serviço
              </span>
              <ServicoBusca rotuloId={servicoRotuloId} opcoes={opcoesServico} valor={servicoId} onChange={escolherServico} />
              <span className="field__help">Digite parte do nome (ex.: impressora, totvs). Define a equipe e o prazo de SLA. Obrigatório para enviar a ação.</span>
            </div>
            <CampoEmpreendimento ticketId={d.id} bloqueado={bloqueado} />
            <div className="tk-row2">
              <label className="field">
                <span className="field__label">Categoria</span>
                <select className="input" value={categoriaId ?? ""} onChange={(e) => setCategoriaId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">— Selecione —</option>
                  {cad.categorias
                    .filter((c) => c.ativa || c.id === categoriaId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Urgência</span>
                <select className="input" value={urgenciaId} onChange={(e) => setUrgenciaId(Number(e.target.value))}>
                  {[...cad.urgencias]
                    .filter((u) => u.ativa || u.id === urgenciaId)
                    .sort((a, b) => a.ordem - b.ordem)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nome}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {visiveis(false).map((c) => (
              <CampoInput key={c.chave} campo={c} obrigatorio={estado[c.chave].obrigatorio} valor={campos[c.chave]} responsaveis={responsaveis} onChange={(v) => setCampos((x) => ({ ...x, [c.chave]: v }))} />
            ))}
            <div className="field">
              <span className="field__label">
                Previsão de solução
                {d.podeAlterarPrazo && !d.encerradoEm && (
                  <button type="button" className="tk-link" onClick={onAlterarPrazo}>
                    Alterar
                  </button>
                )}
              </span>
              <CaixaSla d={d} />
            </div>
            <label className="field">
              <span className="field__label">
                Responsável
                <button type="button" className="tk-btn-eu" disabled={!meuId || responsavelId === meuId} onClick={atribuirParaMim}>
                  {responsavelId === meuId ? "Atribuído a você" : "Atribuir para mim"}
                </button>
              </span>
              <select
                className="input"
                value={valorResp}
                onChange={(e) => {
                  const [eq, r] = e.target.value.split("|");
                  setEquipeId(eq ? Number(eq) : null);
                  setResponsavelId(r || null);
                }}
              >
                {opcoesResp.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Tags</span>
              <input className="input" placeholder="firewall, urgente" value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Cc (cópia dos e-mails)</span>
              <input className="input" placeholder="pessoa@exemplo.com.br; outra@exemplo.com.br" value={cc} onChange={(e) => setCc(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="ch-muted" style={{ marginTop: 0, fontSize: 12 }}>
              Campos que o solicitante não vê.
            </p>
            {visiveis(true).length === 0 && <p className="ch-muted" style={{ fontSize: 13 }}>Nenhum campo interno para este ticket.</p>}
            {visiveis(true).map((c) => (
              <CampoInput key={c.chave} campo={c} obrigatorio={estado[c.chave].obrigatorio} valor={campos[c.chave]} responsaveis={responsaveis} onChange={(v) => setCampos((x) => ({ ...x, [c.chave]: v }))} />
            ))}
          </>
        )}
        {sujo && <p className="tk-sujo">Campos alterados: são salvos quando você enviar a ação.</p>}
      </fieldset>
    </form>
  );
}

function CampoInput({ campo, obrigatorio, valor, responsaveis, onChange }: { campo: Campo; obrigatorio: boolean; valor: unknown; responsaveis: Responsavel[]; onChange: (v: unknown) => void }) {
  const rotulo = <span className={`field__label${obrigatorio ? " tk-req" : ""}`}>{campo.rotulo}</span>;
  const texto = valor === undefined || valor === null ? "" : String(valor);
  const ajuda = campo.ajuda && <span className="field__help">{campo.ajuda}</span>;
  if (campo.tipo === "multipla") {
    const lista = Array.isArray(valor) ? (valor as string[]) : [];
    return (
      <div className="field">
        {rotulo}
        <div className="cad-multi" role="group" aria-label={campo.rotulo}>
          {campo.opcoes.map((o) => (
            <label key={o}>
              <input type="checkbox" checked={lista.includes(o)} onChange={(e) => onChange(e.target.checked ? [...lista, o] : lista.filter((x) => x !== o))} />
              {o}
            </label>
          ))}
        </div>
        {ajuda}
      </div>
    );
  }
  let controle;
  if (campo.tipo === "lista") {
    controle = (
      <select className="input" value={texto} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {campo.opcoes.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (campo.tipo === "sim_nao") {
    controle = (
      <select className="input" value={texto} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
        <option value="">—</option>
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </select>
    );
  } else if (campo.tipo === "usuario") {
    controle = (
      <select className="input" value={texto} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {responsaveis.map((r) => (
          <option key={r.id} value={r.id}>
            {r.nome}
          </option>
        ))}
      </select>
    );
  } else if (campo.tipo === "texto_longo") {
    controle = <textarea className="input" rows={3} value={texto} onChange={(e) => onChange(e.target.value)} />;
  } else {
    const tipoInput = { texto: "text", numero: "number", data: "date", data_hora: "datetime-local" }[campo.tipo] ?? "text";
    controle = <input className="input" type={tipoInput} value={texto} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className="field">
      {rotulo}
      {controle}
      {ajuda}
    </label>
  );
}

function CaixaSla({ d }: { d: TicketDetalhe }) {
  if (d.encerradoEm) return <div className="tk-sla tk-sla--encerrado">Encerrado em {fmt(d.encerradoEm)}</div>;
  if (d.slaPausadoDesde) return <div className="tk-sla tk-sla--pausa">⏸ SLA em pausa desde {fmt(d.slaPausadoDesde)} (aguardando)</div>;
  if (!d.slaSolucaoAte) return <div className="tk-sla tk-sla--encerrado">Sem prazo definido</div>;
  const min = Math.round((Date.parse(d.slaSolucaoAte) - Date.now()) / 60_000);
  if (min < 0) return <div className="tk-sla tk-sla--vencido">⏱ Vencido há {formatDuration(min)} ({fmt(d.slaSolucaoAte)})</div>;
  return (
    <div className={`tk-sla${min < 720 ? " tk-sla--hoje" : ""}`}>
      ⏱ Vence {DIA_HORA.format(new Date(d.slaSolucaoAte))} · faltam {formatDuration(min)}
      {d.slaManual ? " · prazo alterado à mão" : ""}
    </div>
  );
}

// ---------- Compositor ----------

interface CompositorProps {
  d: TicketDetalhe;
  status: StatusTicket[];
  macros: Macro[];
  tipo: "publica" | "interna";
  setTipo: (t: "publica" | "interna") => void;
  texto: string;
  setTexto: (t: string) => void;
  textoRef: React.RefObject<HTMLTextAreaElement | null>;
  macroAberta: boolean;
  setMacroAberta: (v: boolean) => void;
  nomeAgente: string;
  obterRascunho: () => Rascunho;
  depois: string;
  setDepois: (v: string) => void;
}

function Compositor({ d, status, macros, tipo, setTipo, texto, setTexto, textoRef, macroAberta, setMacroAberta, nomeAgente, obterRascunho, depois, setDepois }: CompositorProps) {
  const adicionar = useAdicionarAcao();
  const [camposMacro, setCamposMacro] = useState<PatchTicket>({});
  const [busca, setBusca] = useState("");
  const interna = tipo === "interna";
  const canalExterno = !interna && (d.origem === "email" || d.origem === "whatsapp");

  const aplicarMacro = (m: Macro) => {
    const primeiro = d.solicitante.nome.split(/\s+/)[0] ?? "";
    const t = m.texto
      .replaceAll("{{solicitante.nome}}", primeiro)
      .replaceAll("{{agente.nome}}", nomeAgente)
      .replaceAll("{{ticket.numero}}", String(d.id));
    setTexto(texto.trim() ? `${texto}\n\n${t}` : t);
    if (m.acoes.statusId) setDepois(chaveStatus(m.acoes.statusId, m.acoes.justificativaId ?? null));
    const extra: PatchTicket = {};
    if (m.acoes.categoriaId) extra.categoriaId = m.acoes.categoriaId;
    if (m.acoes.urgenciaId) extra.urgenciaId = m.acoes.urgenciaId;
    if (m.acoes.equipeId) extra.equipeId = m.acoes.equipeId;
    if (m.acoes.responsavelId) extra.responsavelId = m.acoes.responsavelId;
    if (m.acoes.tags?.length) extra.tags = [...new Set([...d.tags, ...m.acoes.tags])];
    setCamposMacro(extra);
    setMacroAberta(false);
    setTimeout(() => textoRef.current?.focus(), 0);
    toast.success(`Macro "${m.nome}" aplicada: confira o texto e o status antes de enviar.`);
  };

  const enviar = () => {
    // Obrigatórios para salvar o ticket com a ação: serviço, status e o texto.
    const r = obterRascunho();
    const faltam = [!r.servicoId && "o serviço", !depois && "o status", !texto.trim() && "o texto da ação"].filter(Boolean) as string[];
    if (faltam.length) {
      toast.error(`Preencha ${faltam.join(", ").replace(/, ([^,]*)$/, " e $1")} antes de enviar.`);
      if (!texto.trim()) textoRef.current?.focus();
      return;
    }
    const campos: PatchTicket = { ...r.patch, ...camposMacro };
    const statusDepois = lerStatus(depois);
    const st = status.find((s) => s.id === statusDepois.statusId);
    const encerra = Boolean(st && (st.categoria === "resolvido" || st.categoria === "fechado"));
    // "Solução aplicada" não aparece na tela (Wagner, 13/10/2026): o texto da ação de encerramento vira a solução
    // (base de conhecimento: sugestões e App do solicitante). Sem ele, o banco usa a última resposta. Obrigatórios faltando: o banco recusa tudo e avisa.
    if (encerra && !d.solucaoAplicada && !campos.solucaoAplicada) campos.solucaoAplicada = texto.trim();
    const temCampos = Object.keys(campos).length > 0;
    adicionar.mutate(
      { id: d.id, acao: { tipo, texto, statusDepois, campos: temCampos ? campos : undefined } },
      {
        onSuccess: () => {
          limpar();
          if (encerra) {
            toast.success(`Ticket #${d.id} ${st?.nome.toLowerCase() ?? "encerrado"}.${!interna && d.origem === "email" ? " A resposta sai por e-mail em até 1 minuto." : ""}`);
            return;
          }
          toast.success(
            interna
              ? "Nota interna adicionada."
              : d.origem === "email"
                ? "Resposta registrada. Sai por e-mail para o solicitante em até 1 minuto."
                : canalExterno
                  ? `Resposta registrada. Será enviada por ${ORIGENS[d.origem]} quando o envio estiver ligado.`
                  : "Resposta registrada.",
          );
        },
        onError: (e) => toast.error(erroMsg(e, "Não foi possível adicionar a ação.")),
      },
    );
  };

  const limpar = () => {
    setTexto("");
    setDepois("");
    setCamposMacro({});
  };

  const filtradas = macros.filter((m) => m.ativa && (!busca.trim() || m.nome.toLowerCase().includes(busca.trim().toLowerCase())));

  return (
    <div className={`tk-comp${interna ? " tk-comp--interna" : ""}`}>
      <div className="tk-comp__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!interna} onClick={() => setTipo("publica")}>
          Responder ao solicitante
        </button>
        <button type="button" role="tab" aria-selected={interna} onClick={() => setTipo("interna")}>
          Nota interna
        </button>
        <span className="tk-comp__para">
          {interna ? "Visível só para a equipe" : `Para: ${d.solicitante.contato ?? d.solicitante.nome}${d.cc.length ? ` · Cc: ${d.cc.join(", ")}` : ""} (${ORIGENS[d.origem]})`}
        </span>
      </div>
      <textarea
        ref={textoRef}
        aria-label={interna ? "Texto da nota interna" : "Texto da resposta"}
        placeholder={interna ? "Anotação para a equipe…" : "Escreva a resposta ao solicitante…"}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
      />
      <div className="tk-comp__tools">
        <div className="tk-macro">
          <button type="button" className="btn btn--outline" aria-haspopup="true" aria-expanded={macroAberta} onClick={() => setMacroAberta(!macroAberta)}>
            <Zap size={15} aria-hidden="true" />
            Aplicar macro
          </button>
          {macroAberta && (
            <div className="tk-macro__lista">
              <input className="input" placeholder="Buscar macro" aria-label="Buscar macro" value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus style={{ marginBottom: 6 }} />
              {filtradas.length === 0 && <p className="ch-muted" style={{ margin: 6, fontSize: 12 }}>Nenhuma macro.</p>}
              {filtradas.map((m) => (
                <button key={m.id} type="button" onClick={() => aplicarMacro(m)}>
                  {m.nome}
                  <small>
                    {m.escopo === "pessoal" ? "Pessoal" : m.escopo === "equipe" ? "Da equipe" : "Para todos"}
                    {m.acoes.statusId ? ` · status ${status.find((s) => s.id === m.acoes.statusId)?.nome ?? ""}` : ""}
                    {m.acoes.tags?.length ? ` · tags ${m.acoes.tags.join(", ")}` : ""}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
        {Object.keys(camposMacro).length > 0 && <span className="ch-badge ch-badge--info">a macro também muda campos ao enviar</span>}
        <span className="tk-bar__spacer" />
        <label className="ch-muted tk-req" style={{ fontSize: 12 }} htmlFor="tk-depois">
          Status após enviar
        </label>
        <select id="tk-depois" className="input" value={depois} aria-required="true" onChange={(e) => setDepois(e.target.value)}>
          <option value="">— Selecione —</option>
          {status
            .filter((s) => s.ativo || s.id === d.statusId)
            .flatMap((s) => [
              <option key={`${s.id}:`} value={chaveStatus(s.id, null)}>
                {s.nome}
                {s.id === d.statusId && !d.justificativaId ? " (atual)" : ""}
              </option>,
              ...s.justificativas
                .filter((j) => j.ativa)
                .map((j) => (
                  <option key={`${s.id}:${j.id}`} value={chaveStatus(s.id, j.id)}>
                    {rotuloStatus(s.nome, j.nome)}
                  </option>
                )),
            ])}
        </select>
        <button type="button" className="btn btn--primary" disabled={adicionar.isPending} onClick={enviar}>
          {adicionar.isPending ? "Enviando…" : interna ? "Adicionar nota" : "Adicionar ação"}
        </button>
      </div>
    </div>
  );
}

// ---------- Solução anterior ----------

function SolucaoAnterior({ d, bloqueado, onUsarNaResposta }: { d: TicketDetalhe; bloqueado: boolean; onUsarNaResposta: (t: string) => void }) {
  const q = useSolucoesAnteriores(d.id, d.servicoId);
  const [todas, setTodas] = useState(false);
  if (!q.data?.length) {
    return q.isSuccess && !d.encerradoEm ? (
      <p className="tk-rel" style={{ fontStyle: "normal" }}>
        <Lightbulb size={13} aria-hidden="true" /> Ainda não há solução registrada para {d.servicoId ? "este serviço" : "esta equipe"}. Ao resolver, a resposta ao solicitante deste ticket vira a solução sugerida nos próximos.
      </p>
    ) : null;
  }
  const lista = todas ? q.data : q.data.slice(0, 1);
  return (
    <section className="tk-sol" aria-label="Solução anterior">
      {lista.map((s, i) => (
        <div key={s.id} style={{ display: "grid", gap: 8, borderTop: i ? "1px solid var(--info-border)" : 0, paddingTop: i ? 8 : 0 }}>
          <div className="tk-sol__h">
            <Lightbulb size={16} aria-hidden="true" />
            <b>{i === 0 ? "Última solução para esta demanda" : "Outra solução parecida"}</b>
            <span className="tk-bar__spacer" />
            <span className="ch-muted" style={{ fontSize: 12 }}>
              <Link to={`${getMenuItem("gestao_chamados_tickets").path}/${s.id}`}>#{s.id}</Link> · {s.responsavel} · {fmt(s.encerradoEm)}
            </span>
          </div>
          <p>
            <b>{s.assunto}:</b> {s.solucao}
          </p>
          {!bloqueado && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn btn--primary" onClick={() => onUsarNaResposta(s.solucao)}>
                Usar esta solução na resposta
              </button>
            </div>
          )}
        </div>
      ))}
      {q.data.length > 1 && (
        <button type="button" className="tk-link" style={{ justifySelf: "start" }} onClick={() => setTodas(!todas)}>
          {todas ? "Mostrar só a última" : `Ver mais ${q.data.length - 1} parecida${q.data.length > 2 ? "s" : ""}`}
        </button>
      )}
    </section>
  );
}

// ---------- Linha do tempo ----------

// ---------- Diálogos ----------

function DialogoPrazo({ d, onFechar }: { d: TicketDetalhe; onFechar: () => void }) {
  const atualizar = useAtualizarDetalhe();
  const inicial = d.slaSolucaoAte ? new Date(Date.parse(d.slaSolucaoAte) - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
  const [quando, setQuando] = useState(inicial);
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    atualizar.mutate(
      { id: d.id, patch: { slaSolucaoAte: new Date(quando).toISOString(), slaJustificativa: motivo } },
      { onSuccess: () => (toast.success("Previsão de solução alterada"), onFechar()), onError: (er) => setErro(erroMsg(er, "Não foi possível alterar o prazo.")) },
    );
  };
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title="Alterar previsão de solução" description="Fica registrado no histórico, com o motivo.">
      <form className="tk-dlg-campos" onSubmit={enviar}>
        <label className="field">
          <span className="field__label">Nova previsão</span>
          <input className="input" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label tk-req">Motivo</span>
          <textarea className="input" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </label>
        {erro && (
          <p className="cad-erro" role="alert">
            {erro}
          </p>
        )}
        <div className="tk-dlg-acoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary" disabled={!quando || atualizar.isPending}>
            Salvar prazo
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}

function DialogoSla({ d, cad, onFechar }: { d: TicketDetalhe; cad: Cadastros; onFechar: () => void }) {
  const servico = cad.servicos.find((s) => s.id === d.servicoId);
  const urg = cad.urgencias.find((u) => u.id === d.urgenciaId);
  const setor = cad.setores.find((s) => s.id === d.setorId);
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title={`Detalhes do SLA · #${d.id}`}>
      <div className="tk-dlg-campos" style={{ fontSize: 13 }}>
        <p style={{ margin: 0 }}>
          <b>Regra:</b> {servico ? caminhoServico(servico.id, cad.servicos) : "sem serviço"} · urgência {urg?.nome ?? "—"}
          {servico ? "" : ` → SLA padrão do setor ${setor?.nome ?? ""} (${setor?.slaPadraoHoras ?? "?"} h úteis)`}
        </p>
        <p style={{ margin: 0 }}>
          <b>Horas úteis:</b> contadas no horário do setor {setor?.nome ?? ""} (Administração › Fila e horários).
        </p>
        <p style={{ margin: 0 }}>
          <b>Aberto:</b> {fmt(d.criadoEm)} · <b>1ª resposta até:</b> {fmt(d.slaRespostaAte)} · <b>respondido:</b> {fmt(d.primeiraRespostaEm)}
        </p>
        <p style={{ margin: 0 }}>
          <b>Solução até:</b> {fmt(d.slaSolucaoAte)}
          {d.slaManual ? " (alterado à mão)" : ""} · <b>encerrado:</b> {fmt(d.encerradoEm)}
        </p>
        <p style={{ margin: 0 }}>
          <b>Pausa:</b> {d.slaPausadoDesde ? `em pausa desde ${fmt(d.slaPausadoDesde)} (status pendente)` : "não está em pausa"}. Nos status pendentes o prazo para e, ao sair, anda o tempo que ficou parado.
        </p>
        <div className="tk-dlg-acoes">
          <button type="button" className="btn btn--primary" onClick={onFechar}>
            Fechar
          </button>
        </div>
      </div>
    </DetailDialog>
  );
}

function DialogoClonar({ d, onFechar, onClonado }: { d: TicketDetalhe; onFechar: () => void; onClonado: (id: number) => void }) {
  const clonar = useClonarTicket();
  const [copiarCampos, setCopiarCampos] = useState(true);
  const [copiarAcoes, setCopiarAcoes] = useState(false);
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title={`Clonar ticket #${d.id}`} description="Cria um ticket novo com os mesmos dados. Útil quando o pedido precisa ir para outra equipe ou outro solicitante.">
      <div className="tk-dlg-campos">
        <label className="cad-check">
          <input type="checkbox" checked={copiarCampos} onChange={(e) => setCopiarCampos(e.target.checked)} /> Copiar campos (categoria, campos adicionais, tags)
        </label>
        <label className="cad-check">
          <input type="checkbox" checked={copiarAcoes} onChange={(e) => setCopiarAcoes(e.target.checked)} /> Copiar a conversa (ações)
        </label>
        <div className="tk-dlg-acoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={clonar.isPending}
            onClick={() =>
              clonar.mutate(
                { id: d.id, copiarCampos, copiarAcoes },
                {
                  onSuccess: (novo) => {
                    toast.success(`Ticket #${novo} criado (clone de #${d.id}).`);
                    onFechar();
                    onClonado(novo as number);
                  },
                  onError: (e) => toast.error(erroMsg(e, "Não foi possível clonar.")),
                },
              )
            }
          >
            Clonar
          </button>
        </div>
      </div>
    </DetailDialog>
  );
}

function DialogoMesclar({ d, onFechar }: { d: TicketDetalhe; onFechar: () => void }) {
  const mesclar = useMesclarTicket();
  const [destino, setDestino] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    mesclar.mutate(
      { origem: d.id, destino: Number(destino) },
      { onSuccess: () => (toast.success(`Ticket #${d.id} mesclado em #${destino}.`), onFechar()), onError: (er) => setErro(erroMsg(er, "Não foi possível mesclar.")) },
    );
  };
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title={`Mesclar ticket #${d.id}`} description="As ações deste ticket vão para o destino. Este fica Cancelado com o aviso “mesclado em #…”.">
      <form className="tk-dlg-campos" onSubmit={enviar}>
        <label className="field">
          <span className="field__label">Número do ticket de destino</span>
          <input className="input" inputMode="numeric" value={destino} onChange={(e) => setDestino(e.target.value.replace(/\D/g, ""))} autoFocus />
        </label>
        {erro && (
          <p className="cad-erro" role="alert">
            {erro}
          </p>
        )}
        <div className="tk-dlg-acoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary" disabled={!destino || mesclar.isPending}>
            Mesclar em #{destino || "…"}
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}

function DialogoExcluir({ d, onFechar, onExcluido }: { d: TicketDetalhe; onFechar: () => void; onExcluido: () => void }) {
  const excluir = useExcluirTicket();
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Excluir o ticket #${d.id}?`}
      description="Ele some das filas e dos relatórios, mas fica guardado na auditoria (não é apagado do banco)."
      confirmLabel="Excluir ticket"
      tone="danger"
      isPending={excluir.isPending}
      onConfirm={() =>
        excluir.mutate(d.id, {
          onSuccess: () => {
            toast.success(`Ticket #${d.id} excluído.`);
            onExcluido();
          },
          onError: (e) => toast.error(erroMsg(e, "Não foi possível excluir.")),
        })
      }
    />
  );
}
