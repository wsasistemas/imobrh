import * as Switch from "@radix-ui/react-switch";
import { ArrowLeftRight, CheckCircle2, FileText, Gauge, Kanban, List, MessagesSquare, Pencil, RotateCcw, Send, UserCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { getMenuItem } from "../../../config/menuRegistry";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { formatDateTime } from "../../../utils/dates";
import {
  useAcaoConversa,
  useContexto,
  useConversas,
  useEditarConversa,
  useMarcarLida,
  useMensagens,
  usePausa,
  usePresenca,
  useTempoReal,
} from "../hooks/useAtendimento";
import type { AcaoConversa, Contexto, Conversa, Mensagem, Setor } from "../services/tipos";
import { gerencia, gravar, hora, iniciais, ler, rotuloSituacao, situacao, SITUACAO_SELO, telefone, type Situacao } from "./util";
import { ImagemAnexo, ListaAnexos } from "./Anexos";
import { EncerrarConversa } from "./EncerrarConversa";
import "./Atendimento.css";

const Monitor = lazy(() => import("./Monitor").then((m) => ({ default: m.Monitor })));

type Visao = "lista" | "kanban";
type Modo = "conversas" | "monitor";
type Filtro = "todas" | Situacao;
const FILTROS: { id: Filtro; rotulo: string }[] = [
  { id: "todas", rotulo: "Todas" },
  { id: "fila", rotulo: "Na fila" },
  { id: "comigo", rotulo: "Comigo" },
  { id: "outro", rotulo: "Com outro atendente" },
  { id: "fim", rotulo: "Encerradas" },
];

export const msgErro = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);

/** Gestão de Chamados › Conversas (lista e Kanban) e › Monitor de atendimento (o mesmo dado, visão do gestor). */
export function Central({ modo = "conversas" }: { modo?: Modo }) {
  const contexto = useContexto();
  if (contexto.isPending) return <PageSkeleton />;
  if (contexto.isError) return <ErrorState message="Não foi possível carregar o atendimento." onRetry={() => void contexto.refetch()} />;
  if (contexto.data.setores.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={MessagesSquare}
          title="Você ainda não está em nenhum setor"
          description="A Central mostra as conversas dos setores em que você é atendente ou gestor. Peça à supervisão para incluir você em Setores e números ou em Fila e horários."
        />
      </div>
    );
  }
  return <CentralSetores ctx={contexto.data} modo={modo} />;
}

function CentralSetores({ ctx, modo }: { ctx: Contexto; modo: Modo }) {
  const conversas = useConversas();
  useTempoReal();
  usePresenca(ctx.souAtendente);
  const ids = useId();
  const eu = ctx.eu;
  const podeMonitor = ctx.setores.some(gerencia);
  const variosSetores = ctx.setores.length > 1;

  const navigate = useNavigate();
  const [busca_, setBusca_] = useSearchParams();
  const [visao, setVisao] = useState<Visao>(() => (ler("central-visao") === "kanban" ? "kanban" : "lista"));
  const [setorId, setSetorId] = useState<number | null>(() => {
    const v = Number(ler("central-setor"));
    return ctx.setores.some((s) => s.id === v) ? v : null;
  });
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [busca, setBusca] = useState("");
  // ?conversa=ID (vindo do Monitor ou do ticket) abre a conversa direto.
  const [aberta, setAberta] = useState<number | null>(() => Number(busca_.get("conversa")) || null);
  useEffect(() => {
    const id = Number(busca_.get("conversa"));
    if (!id) return;
    setAberta(id);
    setVisao("lista");
    setBusca_({}, { replace: true });
  }, [busca_, setBusca_]);

  const setorDe = useMemo(() => new Map(ctx.setores.map((s) => [s.id, s])), [ctx.setores]);
  const todas = conversas.data ?? [];
  const doSetor = todas.filter((c) => setorId === null || c.setorId === setorId);
  const visiveis = doSetor.filter((c) => {
    const q = busca.trim().toLowerCase();
    if (q && !`${c.nome ?? ""} ${c.telefone}`.toLowerCase().includes(q)) return false;
    return filtro === "todas" || situacao(c, eu) === filtro;
  });
  const naFila = doSetor.filter((c) => c.modo === "fila").length;
  const atual = todas.find((c) => c.id === aberta) ?? null;

  const trocarVisao = (v: Visao) => {
    setVisao(v);
    gravar("central-visao", v);
  };
  const trocarSetor = (v: string) => {
    setSetorId(v ? Number(v) : null);
    gravar("central-setor", v);
  };
  const abrir = (id: number) => {
    if (modo === "monitor") {
      navigate(`${getMenuItem("gestao_atendimento_central").path}?conversa=${id}`);
      return;
    }
    setAberta(id);
    trocarVisao("lista");
  };

  const meuSetor = ctx.setores.find((s) => s.atendentes.some((a) => a.id === eu));
  const eu_ = meuSetor?.atendentes.find((a) => a.id === eu);

  return (
    <div>
      <div className="at-barra">
        {modo === "conversas" && (
        <div className="at-visoes" role="group" aria-label="Visão">
          <button type="button" className={`at-visao${visao === "lista" ? " at-visao--on" : ""}`} aria-pressed={visao === "lista"} onClick={() => trocarVisao("lista")}>
            <List size={16} aria-hidden="true" />
            Lista
          </button>
          <button type="button" className={`at-visao${visao === "kanban" ? " at-visao--on" : ""}`} aria-pressed={visao === "kanban"} onClick={() => trocarVisao("kanban")}>
            <Kanban size={16} aria-hidden="true" />
            Kanban por situação
          </button>
        </div>
        )}
        {variosSetores ? (
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-setor`}>Setor</label>
            <select id={`${ids}-setor`} className="input" value={setorId ?? ""} onChange={(e) => trocarSetor(e.target.value)}>
              <option value="">Todos os setores</option>
              {ctx.setores.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="at-setor-chip">
            {ctx.setores[0]!.nome}
            <small>· {ctx.setores[0]!.numeros.map((n) => telefone(n.numero)).join(", ") || "sem número"}</small>
          </span>
        )}
        <div className="at-barra__dir">
          {eu_ && <MinhaPausa pausa={eu_.pausa} />}
          {modo === "conversas" && <span className="at-setor-chip" role="status">{naFila > 0 ? `${naFila} na fila` : "Fila vazia"}</span>}
        </div>
      </div>

      {modo === "monitor" ? (
        podeMonitor ? (
          <Suspense fallback={<PageSkeleton />}>
            <Monitor ctx={ctx} setorId={setorId} onAbrir={abrir} />
          </Suspense>
        ) : (
          <div className="card">
            <EmptyState icon={Gauge} title="Monitor só para a gestão" description="O Monitor mostra os setores em que você é gestor (Setores e números) ou todos, para a supervisão geral." />
          </div>
        )
      ) : visao === "kanban" ? (
        <KanbanSituacao conversas={visiveis} eu={eu} setorDe={setorDe} mostrarSetor={variosSetores && setorId === null} onAbrir={abrir} carregando={conversas.isPending} />
      ) : (
        <div className="card at-central">
          <aside className="at-lista" aria-label="Conversas">
            <div className="at-lista__topo">
              <label className="visually-hidden" htmlFor={`${ids}-busca`}>Buscar</label>
              <input id={`${ids}-busca`} className="input" type="search" placeholder="Buscar nome ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} />
              <div className="at-chips" role="group" aria-label="Filtrar conversas">
                {FILTROS.map((f) => (
                  <button key={f.id} type="button" className={`at-chip${filtro === f.id ? " at-chip--on" : ""}`} aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
                    {f.rotulo}
                  </button>
                ))}
              </div>
            </div>
            {conversas.isError && <ErrorState bare message="Não foi possível carregar as conversas." onRetry={() => void conversas.refetch()} />}
            {conversas.isPending && <p className="at-vazio">Carregando…</p>}
            {!conversas.isPending && visiveis.length === 0 && <p className="at-vazio">Nenhuma conversa neste filtro.</p>}
            <ul>
              {visiveis.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`at-conv${c.id === aberta ? " at-conv--on" : ""}${c.naoLidas > 0 ? " at-conv--nova" : ""}`} onClick={() => setAberta(c.id)} aria-current={c.id === aberta}>
                    <span className="at-av" aria-hidden="true">{iniciais(c.nome)}</span>
                    <span className="at-conv__nome">{c.nome ?? telefone(c.telefone)}</span>
                    <span className="at-conv__hora">{hora(c.ultimaMsgEm)}</span>
                    <span className="at-conv__previa">
                      {variosSetores && setorId === null && <span className="at-tag">{setorDe.get(c.setorId)?.nome}</span>} {c.ultimaPrevia ?? "—"}
                    </span>
                    <span className="at-conv__dir">
                      {c.naoLidas > 0 && <span className="at-nao-lidas" aria-label={`${c.naoLidas} não lidas`}>{c.naoLidas}</span>}
                      <span className={`at-selo ${SITUACAO_SELO[situacao(c, eu)]}`}>{rotuloSituacao(c, eu)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          {atual ? (
            <>
              <Chat c={atual} eu={eu} setor={setorDe.get(atual.setorId)} />
              <Contato c={atual} eu={eu} setor={setorDe.get(atual.setorId)} />
            </>
          ) : (
            <div className="at-nada">
              <EmptyState icon={MessagesSquare} title="Escolha uma conversa" description="As conversas aparecem aqui assim que o cliente escreve num número do setor." />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MinhaPausa({ pausa }: { pausa: boolean }) {
  const mudar = usePausa();
  const id = useId();
  return (
    <span className="at-setor-chip">
      <Switch.Root
        id={id}
        className="switch"
        checked={pausa}
        disabled={mudar.isPending}
        onCheckedChange={(on) => mudar.mutate(on, { onSuccess: () => toast.success(on ? "Pausa ligada: você não recebe da fila" : "Pausa desligada: você volta a receber da fila"), onError: (e) => toast.error(msgErro(e, "Não foi possível mudar a pausa.")) })}
      >
        <Switch.Thumb className="switch__thumb" />
      </Switch.Root>
      <label htmlFor={id}>Pausa</label>
    </span>
  );
}

// ---------------------------------------------------------------- Kanban por situação

const COLUNAS: { id: Situacao; titulo: string }[] = [
  { id: "fila", titulo: "Na fila" },
  { id: "comigo", titulo: "Comigo" },
  { id: "outro", titulo: "Com outros atendentes" },
  { id: "fim", titulo: "Encerradas" },
];

function KanbanSituacao({
  conversas,
  eu,
  setorDe,
  mostrarSetor,
  onAbrir,
  carregando,
}: {
  conversas: Conversa[];
  eu: string | null;
  setorDe: Map<number, Setor>;
  mostrarSetor: boolean;
  onAbrir: (id: number) => void;
  carregando: boolean;
}) {
  if (carregando) return <PageSkeleton />;
  return (
    <div className="at-kb" role="list" aria-label="Conversas por situação">
      {COLUNAS.map((col) => {
        const cards = conversas.filter((c) => situacao(c, eu) === col.id);
        return (
          <section key={col.id} className="at-kb__col" role="listitem" aria-label={`${col.titulo}: ${cards.length}`}>
            <h3>
              {col.titulo} <small>{cards.length}</small>
            </h3>
            {cards.length === 0 && <p className="at-vazio">Nenhuma conversa.</p>}
            {cards.map((c) => (
              <button key={c.id} type="button" className={`at-kb__card at-kb__card--${col.id}${c.naoLidas > 0 ? " at-conv--nova" : ""}`} onClick={() => onAbrir(c.id)}>
                <b>{c.nome ?? telefone(c.telefone)}</b>
                <span>{c.ultimaPrevia ?? "—"}</span>
                <span className="at-kb__rod">
                  <span className={`at-selo ${SITUACAO_SELO[col.id]}`}>{rotuloSituacao(c, eu)}</span>
                  <small>{mostrarSetor ? setorDe.get(c.setorId)?.nome : hora(c.ultimaMsgEm)}</small>
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Chat

const FAIXA: Record<Situacao, string> = {
  fila: "Aguardando atendente do setor. Assuma para responder (ou responda: a conversa passa para você).",
  comigo: "Você está atendendo. Ao encerrar, o cliente recebe a mensagem de encerramento do setor.",
  outro: "Outro atendente do setor está com esta conversa. A gestão do setor pode transferir.",
  fim: "Conversa encerrada. Se o cliente escrever de novo, ela volta para a fila do setor.",
};

export function Chat({ c, eu, setor, somenteLeitura = false }: { c: Conversa; eu: string | null; setor: Setor | undefined; somenteLeitura?: boolean }) {
  const mensagens = useMensagens(c.id);
  const acao = useAcaoConversa();
  const lida = useMarcarLida();
  const [texto, setTexto] = useState("");
  const fim = useRef<HTMLDivElement>(null);
  const s = situacao(c, eu);
  const gestor = gerencia(setor);

  useEffect(() => {
    if (!somenteLeitura && c.naoLidas > 0) lida.mutate(c.id);
    // Só ao abrir/receber: o mutate é estável.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, c.naoLidas, somenteLeitura]);
  useEffect(() => {
    // scrollIntoView não devolve nada: sem chaves o efeito retornaria um valor e o React quebraria.
    fim.current?.scrollIntoView({ block: "end" });
  }, [mensagens.data?.length, c.id]);

  const executar = (a: AcaoConversa, ok: string) =>
    acao.mutate({ conversaId: c.id, acao: a }, { onSuccess: () => toast.success(ok), onError: (e) => toast.error(msgErro(e, "Não foi possível concluir.")) });

  const enviar = (ev?: FormEvent) => {
    ev?.preventDefault();
    const t = texto.trim();
    if (!t) return;
    executar({ acao: "enviar", texto: t }, "Mensagem enviada");
    setTexto("");
  };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  };

  return (
    <section className="at-chat" aria-label={`Conversa com ${c.nome ?? telefone(c.telefone)}`}>
      <header className="at-chat__head">
        <span className="at-av" aria-hidden="true">{iniciais(c.nome)}</span>
        <div className="at-chat__quem">
          <b>{c.nome ?? telefone(c.telefone)}</b>
          <span>
            {telefone(c.telefone)} → {telefone(c.numero)} · {setor?.nome ?? "—"}
            {c.ticket && ` · ticket #${c.ticket}`}
          </span>
        </div>
        <span className={`at-selo ${SITUACAO_SELO[s]}`}>{s === "outro" ? `Com ${c.atendenteNome ?? "outro atendente"}` : rotuloSituacao(c, eu)}</span>
        {!somenteLeitura && s === "comigo" && (
          <button type="button" className="btn btn--outline btn--sm" disabled={acao.isPending} onClick={() => executar({ acao: "devolver" }, "Conversa devolvida à fila")}>
            <RotateCcw size={14} aria-hidden="true" />
            Devolver à fila
          </button>
        )}
        {!somenteLeitura && (s === "fila" || (s === "outro" && gestor)) && (
          <button type="button" className="btn btn--primary btn--sm" disabled={acao.isPending} onClick={() => executar({ acao: "assumir" }, s === "outro" ? "Conversa transferida para você" : "Conversa assumida")}>
            <UserCheck size={14} aria-hidden="true" />
            {s === "outro" ? "Transferir para mim" : "Assumir conversa"}
          </button>
        )}
      </header>
      <div className="at-msgs">
        {mensagens.isPending && <p className="at-vazio">Carregando…</p>}
        {mensagens.isError && <p className="at-vazio">Não foi possível carregar as mensagens.</p>}
        {(mensagens.data ?? []).map((m) => (
          <Bolha key={m.id} m={m} />
        ))}
        <div ref={fim} />
      </div>
      <p className={`at-faixa at-faixa--${s}`}>{somenteLeitura ? "Só leitura. Para responder, use Atender." : FAIXA[s]}</p>
      {!somenteLeitura && (s === "fila" || s === "comigo") && (
        <form className="at-compor" onSubmit={enviar}>
          <label className="visually-hidden" htmlFor={`msg-${c.id}`}>Mensagem</label>
          <textarea id={`msg-${c.id}`} className="input" rows={2} placeholder="Escreva uma mensagem… (Enter envia, Shift+Enter quebra a linha)" value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={teclas} maxLength={4000} />
          <button type="submit" className="btn btn--primary" disabled={!texto.trim() || acao.isPending}>
            <Send size={15} aria-hidden="true" />
            Enviar
          </button>
        </form>
      )}
    </section>
  );
}

function Bolha({ m }: { m: Mensagem }) {
  if (m.tipo === "evento") return <p className="at-ev">{m.texto}</p>;
  const autor = m.autor === "atendente" ? (m.autorNome ?? "Atendente") : m.autor === "auto" ? "Mensagem automática" : m.autor === "sistema" ? "Sistema" : null;
  return (
    <div className={`at-bal at-bal--${m.autor}`}>
      {autor && <span className="at-bal__autor">{autor}</span>}
      {m.tipo !== "texto" && m.arquivo && (m.arquivo.path || m.arquivo.url) && (m.arquivo.mime ?? "").startsWith("image/") ? (
        <span>
          <ImagemAnexo a={m.arquivo} />
          {m.texto && !/^\[[a-z]+\]$/.test(m.texto) && <><br />{m.texto}</>}
        </span>
      ) : m.tipo !== "texto" && m.arquivo && (m.arquivo.path || m.arquivo.url) ? (
        <span>
          <ListaAnexos anexos={[m.arquivo]} />
          {m.texto && !/^\[[a-z]+\]$/.test(m.texto) && <><br />{m.texto}</>}
        </span>
      ) : m.tipo !== "texto" ? (
        // Chegou sem o arquivo (o WhatsApp/OpenWA não liberou o download): deixa claro em vez de "[imagem]".
        <span className="at-bal__sem-arquivo">
          <FileText size={14} aria-hidden="true" /> <b>{m.tipo === "imagem" ? "Imagem" : m.tipo === "audio" ? "Áudio" : m.tipo === "video" ? "Vídeo" : "Arquivo"} não recebido(a)</b>
          <br />
          <small>{m.arquivo?.erro ? `Motivo: ${m.arquivo.erro}.` : "O WhatsApp não liberou o arquivo."} Peça ao colaborador para reenviar.</small>
          {m.texto && !/^\[[a-z]+\]$/.test(m.texto) && <><br />{m.texto}</>}
        </span>
      ) : (
        m.texto
      )}
      <small>
        {hora(m.criadoEm)}
        {m.direcao === "saida" && ` · ${{ pendente: "enviando", enviada: "✓", entregue: "✓✓", lida: "✓✓ lida", falhou: "falhou", recebida: "" }[m.status]}`}
      </small>
      {m.status === "falhou" && m.erro && <em className="at-bal__erro">{m.erro}</em>}
    </div>
  );
}

// ---------------------------------------------------------------- Contato e ações

function Contato({ c, eu, setor }: { c: Conversa; eu: string | null; setor: Setor | undefined }) {
  const acao = useAcaoConversa();
  const editar = useEditarConversa();
  const ids = useId();
  const [nota, setNota] = useState(c.notaInterna ?? "");
  const [nome, setNome] = useState<string | null>(null);
  const [para, setPara] = useState("");
  const [encerrar, setEncerrar] = useState(false);
  const s = situacao(c, eu);
  const gestor = gerencia(setor);

  useEffect(() => {
    setNota(c.notaInterna ?? "");
    setNome(null);
    setPara("");
  }, [c.id, c.notaInterna]);

  const salvarEdicao = (dados: { nomeContato?: string; notaInterna?: string }, ok: string) =>
    editar.mutate({ conversaId: c.id, ...dados }, { onSuccess: () => { toast.success(ok); setNome(null); }, onError: (e) => toast.error(msgErro(e, "Não foi possível salvar.")) });

  const executar = (a: AcaoConversa, ok: string) =>
    acao.mutate({ conversaId: c.id, acao: a }, { onSuccess: () => { toast.success(ok); setEncerrar(false); }, onError: (e) => { toast.error(msgErro(e, "Não foi possível concluir.")); setEncerrar(false); } });

  const colegas = (setor?.atendentes ?? []).filter((a) => a.id !== c.atendenteId);

  return (
    <aside className="at-lado" aria-label="Contato e ações">
      <h4>Contato</h4>
      {nome !== null ? (
        <form
          className="at-acao-linha"
          onSubmit={(e) => {
            e.preventDefault();
            salvarEdicao({ nomeContato: nome }, "Nome do contato salvo");
          }}
        >
          <label className="visually-hidden" htmlFor={`${ids}-nome`}>Nome do contato</label>
          <input id={`${ids}-nome`} className="input input--sm" value={nome} maxLength={80} autoFocus onChange={(e) => setNome(e.target.value)} />
          <button type="submit" className="btn btn--primary btn--sm" disabled={editar.isPending}>Salvar</button>
        </form>
      ) : null}
      <dl className="at-kv">
        <dt>Nome</dt><dd>{c.nome ?? "—"}</dd>
        <dt>Telefone</dt><dd>{telefone(c.telefone)}</dd>
        <dt>Canal</dt><dd><span className="at-selo s-info">WhatsApp · orgânico</span></dd>
        <dt>Cliente desde</dt><dd>{formatDateTime(c.clienteDesde)}</dd>
        <dt>Atendimentos</dt><dd>{c.totalAtendimentos}</dd>
      </dl>

      <h4>Atendimento</h4>
      <dl className="at-kv">
        <dt>Setor</dt><dd>{setor?.nome ?? "—"}</dd>
        <dt>Número</dt><dd>{telefone(c.numero)}</dd>
        <dt>Situação</dt><dd><span className={`at-selo ${SITUACAO_SELO[s]}`}>{rotuloSituacao(c, eu)}</span></dd>
        <dt>Atendente</dt><dd>{c.atendenteNome ?? "—"}</dd>
        <dt>Ticket</dt>
        <dd>{c.ticket ? <Link to={`${getMenuItem("gestao_chamados_tickets").path}/${c.ticket}`}>#{c.ticket} · abrir</Link> : "—"}</dd>
      </dl>

      <h4>Nota interna</h4>
      <label className="visually-hidden" htmlFor={`${ids}-nota`}>Nota interna</label>
      <textarea id={`${ids}-nota`} className="input" rows={3} maxLength={4000} placeholder="Visível só para a equipe do setor" value={nota} onChange={(e) => setNota(e.target.value)} />
      {nota !== (c.notaInterna ?? "") && (
        <div className="at-rodape" style={{ marginTop: 6 }}>
          <button type="button" className="btn btn--outline btn--sm" disabled={editar.isPending} onClick={() => salvarEdicao({ notaInterna: nota }, "Nota salva")}>Salvar nota</button>
        </div>
      )}

      <h4>Ações</h4>
      <div className="at-acoes">
        <button type="button" className="btn btn--outline btn--sm" onClick={() => setNome(c.nome ?? "")}>
          <Pencil size={14} aria-hidden="true" />
          Editar nome do contato
        </button>
        {gestor && s !== "fim" && (
          <div className="at-acao-linha">
            <label className="visually-hidden" htmlFor={`${ids}-para`}>Transferir para</label>
            <select id={`${ids}-para`} className="input input--sm" value={para} onChange={(e) => setPara(e.target.value)}>
              <option value="">Transferir para… (mesmo setor)</option>
              {colegas.map((a) => (
                <option key={a.id} value={a.id}>{a.nome}</option>
              ))}
            </select>
            <button type="button" className="btn btn--outline btn--sm" disabled={!para || acao.isPending} onClick={() => executar({ acao: "transferir", para }, "Conversa transferida")}>
              <ArrowLeftRight size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {(s === "comigo" || (gestor && s !== "fim")) && (
          <button type="button" className="btn btn--danger-outline btn--sm" disabled={acao.isPending} onClick={() => setEncerrar(true)}>
            <CheckCircle2 size={14} aria-hidden="true" />
            Encerrar conversa
          </button>
        )}
      </div>
      <EncerrarConversa c={c} setor={setor} open={encerrar} onOpenChange={setEncerrar} />
    </aside>
  );
}
