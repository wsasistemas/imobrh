import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CalendarClock, Camera, CheckCircle2, ClipboardCopy, ImagePlus, LogOut, MapPin, MessageCircle, Phone, Plus, SlidersHorizontal, User, Wrench } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { AppAccessDeniedPopup } from "../auth/AppAccessDeniedPopup";
import { useAuthSession } from "../auth/useAuthSession";
import { Carregando, Logo, SubCabecalho } from "./SolicitanteApp";
import { AnexoNaMensagem, Miniaturas, useAnexos } from "./anexos";
import { solicitanteApi, formatarTelefone, type CampoTecnico, type ChamadoTecnico, type ChamadoTecnicoDetalhe, type EntradaTecnico, type TipoResolucao } from "./service";
import { prazo, quando } from "./Telas";

// App do solicitante · modo Técnico (mockup docs/mockups/app-solicitante-tecnico.html, aprovado em 13/10/2026). Entra pela aba
// Técnico do login; só membros das equipes do CFTV (cd_tec_*). Vê todos os chamados do setor e registra atendimento
// nos que são dele: fotos, tipo de resolução (define o status) e o texto, que vira a Solução aplicada.

const TecContext = createContext<EntradaTecnico | null>(null);
function useTec(): EntradaTecnico {
  const ctx = useContext(TecContext);
  if (!ctx) throw new Error("useTec fora do modo Técnico");
  return ctx;
}

const TIPOS: { tipo: TipoResolucao; icone: string; titulo: string; dica: string; efeito: ReactNode }[] = [
  { tipo: "resolvido", icone: "✅", titulo: "Resolvido", dica: "Problema corrigido", efeito: <>Vai para <b>Resolvido</b>. O solicitante recebe no app "Ficou bom?" — Sim fecha; Não reabre para você.</> },
  { tipo: "voltar", icone: "🔁", titulo: "Precisa voltar ao local", dica: "Não deu para terminar hoje", efeito: <>Continua <b>Em atendimento</b> com você. O prazo do SLA segue contando.</> },
  { tipo: "peca", icone: "📦", titulo: "Aguardando peça / equipamento", dica: "Precisa trocar algo", efeito: <>Vai para <b>Aguardando · Fornecedor</b>. O prazo pausa até a peça chegar.</> },
  { tipo: "orcamento", icone: "💰", titulo: "Precisa de orçamento", dica: "Serviço ou peça com custo", efeito: <>Vai para <b>Aguardando · Cotação</b>. O prazo pausa.</> },
  { tipo: "aprovacao", icone: "✋", titulo: "Depende de aprovação", dica: "Gestor precisa autorizar", efeito: <>Vai para <b>Aguardando · Aprovação do gestor</b>. O prazo pausa e o líder da equipe é avisado.</> },
  { tipo: "sem_acesso", icone: "🔒", titulo: "Sem acesso ao local", dica: "Ninguém para abrir, chave…", efeito: <>Vai para <b>Aguardando · Retorno do cliente</b>. O prazo pausa e o solicitante vê o seu texto.</> },
  { tipo: "nao_procede", icone: "✖", titulo: "Não procede", dica: "Sem defeito ou pedido errado", efeito: <>Vai para <b>Cancelado</b>. Explique o motivo no texto.</> },
];

const ETIQUETAS: Record<string, { rotulo: string; classe: string }> = {
  "estou-parado": { rotulo: "Estou parado", classe: "cd-etq--parado" },
  grave: { rotulo: "Grave", classe: "cd-etq--grave" },
  "tenho-prazo": { rotulo: "Tenho prazo", classe: "cd-etq--prazo" },
};

// ---------- utilitários ----------

function duracao(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 1440) return `${Math.round(min / 60)} h`;
  const d = Math.round(min / 1440);
  return `${d} ${d === 1 ? "dia" : "dias"}`;
}

/** Prazo do SLA (automático) para o cartão e o detalhe. */
function situacaoPrazo(c: ChamadoTecnico): { texto: string; vencido: boolean } {
  if (c.encerradoEm) return { texto: `concluído ${quando(c.encerradoEm)}`, vencido: false };
  if (c.slaPausadoDesde) return { texto: "⏸ prazo pausado", vencido: false };
  if (!c.slaSolucaoAte) return { texto: "sem prazo", vencido: false };
  const min = (Date.parse(c.slaSolucaoAte) - Date.now()) / 60_000;
  return min < 0 ? { texto: `prazo vencido há ${duracao(-min)}`, vencido: true } : { texto: `prazo ${prazo(c.slaSolucaoAte)}`, vencido: false };
}

const aberto = (c: ChamadoTecnico) => c.encerradoEm === null;
const diaLocal = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : null);

function StatusTec({ c }: { c: Pick<ChamadoTecnico, "status" | "justificativa"> }) {
  const nome = c.status.categoria === "novo" ? "Aberto" : c.justificativa ? `${c.status.nome} · ${c.justificativa}` : c.status.nome;
  return <span className={`cd-st cd-st--${c.status.categoria}`}>{nome}</span>;
}

function Etiquetas({ c }: { c: ChamadoTecnico }) {
  const tags = c.tags.filter((t) => ETIQUETAS[t]);
  if (tags.length === 0 && (!c.urgencia || c.urgencia === "Normal")) return null;
  return (
    <div className="cd-etqs">
      {tags.map((t) => (
        <span key={t} className={`cd-etq ${ETIQUETAS[t].classe}`}>
          {ETIQUETAS[t].rotulo}
        </span>
      ))}
      {tags.length === 0 && c.urgencia && <span className="cd-etq">{c.urgencia}</span>}
    </div>
  );
}

function digitos(tel: string | null): string | null {
  const d = (tel ?? "").replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.length <= 11 ? `55${d}` : d;
}

// ---------- casca ----------

export function AppTecnico({ onColaborador }: { onColaborador: () => void }) {
  const { email, signOut } = useAuthSession();
  const entrada = useQuery({ queryKey: ["cd", "tec", "entrada"], queryFn: solicitanteApi.tec.entrar, retry: false, staleTime: 60_000 });
  const acesso = useQuery({ queryKey: ["cd", "acesso"], queryFn: solicitanteApi.podeAcessar, enabled: entrada.isSuccess, staleTime: 300_000 });
  const [saindo, setSaindo] = useState(false);

  if (entrada.isPending) {
    return (
      <div className="cd cd--tec">
        <div className="cd__col">
          <Carregando />
        </div>
      </div>
    );
  }
  if (entrada.isError) {
    return (
      <div className="cd cd--tec">
        <div className="cd__col">
          <div className="cd__centro">
            <div>
              <p className="cd-alerta">{entrada.error.message}</p>
              <div className="cd-confirma__acoes" style={{ margin: "0 auto" }}>
                <button type="button" className="cd-btn-ouro" onClick={onColaborador}>
                  <User size={18} aria-hidden="true" /> Entrar como Colaborador
                </button>
                <button type="button" className="cd-btn-vidro" onClick={() => void entrada.refetch()}>
                  Tentar de novo
                </button>
                <button type="button" className="cd-btn-vidro" onClick={() => void signOut()}>
                  Sair
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TecContext.Provider value={entrada.data}>
      <div className="cd cd--tec">
        <div className="cd__col">
          <Routes>
            <Route index element={<TecLista onColaborador={onColaborador} />} />
            <Route path="t/:id" element={<TecChamado />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </div>
      </div>
      {acesso.data === false && (
        <AppAccessDeniedPopup
          open
          onOpenChange={() => {}}
          email={email}
          signingOut={saindo}
          onSignOut={() => {
            setSaindo(true);
            void signOut();
          }}
        />
      )}
    </TecContext.Provider>
  );
}

// ---------- lista ----------

type Quadro = "todos" | "sem" | "meus" | "concluidos";
type Rapido = "vencido" | "aguardando" | "parado";

function TecLista({ onColaborador }: { onColaborador: () => void }) {
  const tec = useTec();
  const { signOut } = useAuthSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const lista = useQuery({ queryKey: ["cd", "tec", "chamados"], queryFn: () => solicitanteApi.tec.chamados(30), refetchInterval: 60_000 });
  const [quadro, setQuadro] = useState<Quadro>("todos");
  const [rapido, setRapido] = useState<Rapido | null>(null);
  const [filtroAberto, setFiltroAberto] = useState(false);
  const [tipoData, setTipoData] = useState<"abertura" | "prazo" | "conclusao">("abertura");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [status, setStatus] = useState("");
  const [tecnico, setTecnico] = useState<"" | "eu" | "sem">("");
  const [emp, setEmp] = useState("");

  const atribuir = useMutation({
    mutationFn: (id: number) => solicitanteApi.tec.atribuir(id),
    onSuccess: (_, id) => {
      toast.success(`Chamado #${id} agora é seu.`);
      void qc.invalidateQueries({ queryKey: ["cd", "tec"] });
      navigate(`/app/t/${id}`);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: ["cd", "tec", "chamados"] });
    },
  });

  const itens = lista.data ?? [];
  const contagem = {
    todos: itens.filter(aberto).length,
    sem: itens.filter((c) => aberto(c) && !c.responsavelId).length,
    meus: itens.filter((c) => aberto(c) && c.meu).length,
    concluidos: itens.filter((c) => !aberto(c)).length,
  };
  const filtrosAtivos = [de, ate, status, tecnico, emp.trim()].filter(Boolean).length;

  const visiveis = useMemo(() => {
    const busca = emp.trim().toLowerCase();
    return itens.filter((c) => {
      if (quadro === "todos" && !aberto(c)) return false;
      if (quadro === "sem" && !(aberto(c) && !c.responsavelId)) return false;
      if (quadro === "meus" && !(aberto(c) && c.meu)) return false;
      if (quadro === "concluidos" && aberto(c)) return false;
      if (rapido === "vencido" && !situacaoPrazo(c).vencido) return false;
      if (rapido === "aguardando" && c.status.categoria !== "pendente") return false;
      if (rapido === "parado" && !c.tags.includes("estou-parado")) return false;
      if (status && c.status.categoria !== status) return false;
      if (tecnico === "eu" && !c.meu) return false;
      if (tecnico === "sem" && c.responsavelId) return false;
      if (busca && !(c.empreendimento ?? "").toLowerCase().includes(busca)) return false;
      if (de || ate) {
        const dia = diaLocal(tipoData === "abertura" ? c.criadoEm : tipoData === "prazo" ? c.slaSolucaoAte : c.encerradoEm);
        if (!dia || (de && dia < de) || (ate && dia > ate)) return false;
      }
      return true;
    });
  }, [itens, quadro, rapido, status, tecnico, emp, de, ate, tipoData]);

  const primeiroNome = tec.nome.split(/\s+/)[0];
  const quadros: { q: Quadro; rotulo: string; cor: string }[] = [
    { q: "todos", rotulo: "Todos abertos", cor: "#94a3b8" },
    { q: "sem", rotulo: "Sem atribuição", cor: "#fb923c" },
    { q: "meus", rotulo: "Atribuídos a mim", cor: "#f26b78" },
    { q: "concluidos", rotulo: "Concluídos (30 dias)", cor: "#34d399" },
  ];
  const rapidos: { r: Rapido; rotulo: string }[] = [
    { r: "vencido", rotulo: "Prazo vencido" },
    { r: "aguardando", rotulo: "Aguardando" },
    { r: "parado", rotulo: "Estou parado" },
  ];

  return (
    <>
      <header className="cd-hdr">
        <Logo />
        <div className="cd-hdr__acoes">
          <span className="cd-selo">
            <Wrench size={13} aria-hidden="true" /> {tec.setores.map((s) => s.nome).join(" · ")}
          </span>
          <button type="button" className="cd-pilula" onClick={() => void signOut()} aria-label="Sair">
            <LogOut size={15} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="cd-bv" style={{ paddingBottom: 12 }}>
        <h1>Olá, {primeiroNome}</h1>
        <p>Chamados do {tec.setores.map((s) => s.nome).join(" e ")}</p>
      </div>

      <div className="cd-kpis" role="group" aria-label="Quadros">
        {quadros.map((k) => (
          <button key={k.q} type="button" className="cd-kpi" aria-pressed={quadro === k.q} style={{ ["--c" as string]: k.cor }} onClick={() => setQuadro(k.q)}>
            <b>{lista.isSuccess ? contagem[k.q] : "–"}</b>
            <span>{k.rotulo}</span>
          </button>
        ))}
      </div>
      <div className="cd-filtros" role="group" aria-label="Filtros rápidos">
        <button type="button" className="cd-chip" aria-pressed={filtroAberto} aria-expanded={filtroAberto} onClick={() => setFiltroAberto((v) => !v)}>
          <SlidersHorizontal size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> Filtros{filtrosAtivos ? ` (${filtrosAtivos})` : ""}
        </button>
        {rapidos.map((r) => (
          <button key={r.r} type="button" className="cd-chip" aria-pressed={rapido === r.r} onClick={() => setRapido(rapido === r.r ? null : r.r)}>
            {r.rotulo}
          </button>
        ))}
      </div>
      {filtroAberto && (
        <div className="cd-filtro">
          <label className="cd-rot" htmlFor="tf-tipo">Tipo de data</label>
          <select id="tf-tipo" className="cd-campo" value={tipoData} onChange={(e) => setTipoData(e.target.value as typeof tipoData)}>
            <option value="abertura">Abertura</option>
            <option value="prazo">Prazo (SLA)</option>
            <option value="conclusao">Conclusão</option>
          </select>
          <div className="cd-filtro__2">
            <div>
              <label className="cd-rot" htmlFor="tf-de">De</label>
              <input id="tf-de" className="cd-campo" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
            </div>
            <div>
              <label className="cd-rot" htmlFor="tf-ate">Até</label>
              <input id="tf-ate" className="cd-campo" type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
            </div>
          </div>
          <div className="cd-filtro__2">
            <div>
              <label className="cd-rot" htmlFor="tf-st">Status</label>
              <select id="tf-st" className="cd-campo" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Todos</option>
                <option value="novo">Aberto</option>
                <option value="andamento">Em atendimento</option>
                <option value="pendente">Aguardando</option>
                <option value="resolvido">Resolvido</option>
                <option value="fechado">Fechado</option>
                <option value="cancelado">Cancelado</option>
              </select>
            </div>
            <div>
              <label className="cd-rot" htmlFor="tf-tec">Técnico</label>
              <select id="tf-tec" className="cd-campo" value={tecnico} onChange={(e) => setTecnico(e.target.value as typeof tecnico)}>
                <option value="">Todos</option>
                <option value="eu">Eu</option>
                <option value="sem">Sem atribuição</option>
              </select>
            </div>
          </div>
          <label className="cd-rot" htmlFor="tf-emp">Empreendimento</label>
          <input id="tf-emp" className="cd-campo" placeholder="Buscar empreendimento" value={emp} onChange={(e) => setEmp(e.target.value)} />
          {filtrosAtivos > 0 && (
            <button type="button" className="cd-link" style={{ marginTop: 10 }} onClick={() => { setDe(""); setAte(""); setStatus(""); setTecnico(""); setEmp(""); }}>
              Limpar filtros
            </button>
          )}
        </div>
      )}

      {lista.isPending ? (
        <Carregando />
      ) : lista.isError ? (
        <p className="cd-vazio">{lista.error.message}</p>
      ) : visiveis.length === 0 ? (
        <p className="cd-vazio">Nenhum chamado por aqui.</p>
      ) : (
        <div className="cd-lista">
          {visiveis.map((c) => (
            <CartaoTec key={c.id} c={c} atribuindo={atribuir.isPending && atribuir.variables === c.id} onAtribuir={() => atribuir.mutate(c.id)} />
          ))}
        </div>
      )}
      <p className="cd-vazio" style={{ paddingTop: 0 }}>
        <button type="button" className="cd-link" onClick={onColaborador}>
          Abrir um chamado como colaborador
        </button>
      </p>
    </>
  );
}

function CartaoTec({ c, atribuindo, onAtribuir }: { c: ChamadoTecnico; atribuindo: boolean; onAtribuir: () => void }) {
  const p = situacaoPrazo(c);
  const servico = c.servico ? c.servico.split(" › ").pop() : "Sem serviço";
  return (
    <article className={`cd-card cd-tk${c.meu && aberto(c) ? " cd-card--meu" : ""}${aberto(c) ? "" : " cd-card--fechado"}`}>
      <Link to={`/app/t/${c.id}`} className="cd-tk" style={{ color: "inherit", textDecoration: "none" }}>
        <div className="cd-card__l1">
          <span>
            #{c.id} · {servico}
          </span>
          <StatusTec c={c} />
        </div>
        <h3>{c.assunto}</h3>
        <Etiquetas c={c} />
        <div className="cd-meta">
          <div>
            <Building2 size={13} aria-hidden="true" />
            <span>{c.empreendimento ?? "Empreendimento não informado"}</span>
          </div>
          <div>
            <Phone size={13} aria-hidden="true" />
            <span>
              {c.solicitante ?? "—"}
              {c.telefone ? ` · ${formatarTelefone(c.telefone)}` : ""}
            </span>
          </div>
          <div>
            <CalendarClock size={13} aria-hidden="true" />
            <span className={p.vencido ? "cd-vencido" : undefined}>
              Aberto {quando(c.criadoEm)} · {p.texto}
            </span>
          </div>
        </div>
      </Link>
      <div className="cd-tk__pe">
        <span>
          Técnico: <b>{c.meu ? "Você" : (c.responsavel ?? "Sem atribuição")}</b>
        </span>
        {aberto(c) && !c.responsavelId ? (
          <button type="button" className="cd-btn-mini" disabled={atribuindo} onClick={onAtribuir}>
            <Plus size={14} aria-hidden="true" /> {atribuindo ? "Aguarde…" : "Atribuir-me"}
          </button>
        ) : (
          <Link to={`/app/t/${c.id}`} style={{ color: "var(--cd-txt-3)", textDecoration: "none" }}>
            {c.meu && aberto(c) ? "Atender ›" : "Ver ›"}
          </Link>
        )}
      </div>
    </article>
  );
}

// ---------- detalhe ----------

function TecChamado() {
  const { id } = useParams();
  const ticketId = Number(id);
  const tec = useTec();
  const qc = useQueryClient();
  const detalhe = useQuery({ queryKey: ["cd", "tec", "chamado", ticketId], queryFn: () => solicitanteApi.tec.chamado(ticketId), enabled: Number.isFinite(ticketId), refetchInterval: 60_000 });
  const [concluido, setConcluido] = useState<{ status: string; fotos: number } | null>(null);

  const atualizar = () => void qc.invalidateQueries({ queryKey: ["cd", "tec"] });
  const atribuir = useMutation({
    mutationFn: () => solicitanteApi.tec.atribuir(ticketId),
    onSuccess: () => {
      toast.success("O chamado agora é seu.");
      atualizar();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      atualizar();
    },
  });

  if (!Number.isFinite(ticketId)) return <Navigate to="/app" replace />;
  if (concluido) {
    return (
      <div className="cd__centro">
        <div className="cd-confirma">
          <div className="cd-ok">
            <CheckCircle2 size={40} aria-hidden="true" />
          </div>
          <h2>Atendimento registrado</h2>
          <p>
            #{ticketId} foi para <b>{concluido.status}</b>.
          </p>
          <p>
            O solicitante recebe a sua resposta{concluido.fotos ? ` com ${concluido.fotos} ${concluido.fotos === 1 ? "foto" : "fotos"}` : ""}.
          </p>
          <div className="cd-confirma__acoes" style={{ margin: "22px auto 0" }}>
            <Link to="/app" className="cd-btn-ouro">
              Voltar aos chamados
            </Link>
            <button type="button" className="cd-btn-vidro" onClick={() => setConcluido(null)}>
              Ver o chamado
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (detalhe.isPending) return <Carregando />;
  if (detalhe.isError) {
    return (
      <>
        <SubCabecalho titulo="Chamado" voltar="/app" />
        <p className="cd-vazio">{detalhe.error.message}</p>
      </>
    );
  }
  const d = detalhe.data;
  const p = situacaoPrazo(d);
  const pedido = d.acoes.find((a) => a.direcao === "entrada");
  const conversa = d.acoes.filter((a) => a !== pedido);
  const tel = digitos(d.telefone);
  const endereco = d.local ? [d.local.endereco, d.local.cidade].filter(Boolean).join(" — ") : "";
  const busca = d.local ? [d.local.nome, d.local.endereco, d.local.cidade].filter(Boolean).join(", ") : "";

  return (
    <>
      <SubCabecalho
        titulo={`#${d.id} · ${d.servico ? d.servico.split(" › ").pop() : (d.setor ?? "Chamado")}`}
        sub={
          <>
            <StatusTec c={d} /> {d.meu ? "· com você" : d.responsavel ? `· com ${d.responsavel}` : "· sem responsável"} ·{" "}
            <span className={p.vencido ? "cd-vencido" : undefined}>{p.texto}</span>
          </>
        }
        voltar="/app"
      />

      {!d.meu && d.responsavel && !d.encerradoEm && (
        <div className="cd-com-outro">
          👤 Com <b>{d.responsavel}</b>. Você pode ver, mas só ele registra o atendimento.
        </div>
      )}

      <div className="cd-bloco">
        <h4>Local</h4>
        {d.local ? (
          <>
            <p>
              <b>{d.local.nome}</b>
              {endereco && (
                <>
                  <br />
                  <small>{endereco}</small>
                </>
              )}
            </p>
            {d.local.observacao && <div className="cd-obs">📝 Para o técnico: {d.local.observacao}</div>}
            <div className="cd-dois" style={{ marginTop: 10 }}>
              <a className="cd-btn-vidro" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(busca)}`} target="_blank" rel="noreferrer noopener">
                <MapPin size={16} aria-hidden="true" /> Mapa
              </a>
              <button
                type="button"
                className="cd-btn-vidro"
                onClick={() => navigator.clipboard.writeText(busca).then(() => toast.success("Endereço copiado."), () => toast.error("Não foi possível copiar."))}
              >
                <ClipboardCopy size={16} aria-hidden="true" /> Copiar
              </button>
            </div>
          </>
        ) : (
          <p>
            <small>Empreendimento não informado no chamado.</small>
          </p>
        )}
      </div>

      <div className="cd-bloco">
        <h4>Solicitante</h4>
        <p>
          <b>{d.solicitante ?? "—"}</b>
          {(d.telefone || d.email) && (
            <>
              <br />
              <small>{[d.telefone && formatarTelefone(d.telefone), d.email].filter(Boolean).join(" · ")}</small>
            </>
          )}
        </p>
        {tel && (
          <div className="cd-dois" style={{ marginTop: 10 }}>
            <a className="cd-btn-vidro" href={`tel:+${tel}`}>
              <Phone size={16} aria-hidden="true" /> Ligar
            </a>
            <a className="cd-btn-vidro" href={`https://wa.me/${tel}`} target="_blank" rel="noreferrer noopener" style={{ color: "#4ade80" }}>
              <MessageCircle size={16} aria-hidden="true" /> WhatsApp
            </a>
          </div>
        )}
      </div>

      <div className="cd-bloco">
        <h4>O que foi pedido · {quando(d.criadoEm)}</h4>
        <p>{pedido?.texto ?? d.assunto}</p>
        <Etiquetas c={d} />
        {pedido && pedido.anexos.length > 0 && (
          <div className="cd-anexos">
            {pedido.anexos.map((a, i) => (
              <AnexoNaMensagem key={`${a.path ?? a.nome}-${i}`} a={a} />
            ))}
          </div>
        )}
      </div>

      {conversa.length > 0 && (
        <div className="cd-bloco">
          <h4>Conversa</h4>
          <div className="cd-tl cd-tl--tec">
            {conversa.map((a) => (
              <div key={a.numero} className={`cd-msg ${a.direcao === "entrada" ? "cd-msg--eu" : "cd-msg--ti"}`}>
                <b>{a.autorNome}</b>
                {a.texto}
                {a.anexos.length > 0 && (
                  <div className="cd-anexos">
                    {a.anexos.map((x, i) => (
                      <AnexoNaMensagem key={`${x.path ?? x.nome}-${i}`} a={x} />
                    ))}
                  </div>
                )}
                <small>{quando(a.criadoEm)}</small>
              </div>
            ))}
          </div>
        </div>
      )}

      {d.encerradoEm && d.solucao && (
        <div className="cd-resolvido">
          <p className="cd-resolvido__solucao" style={{ margin: 0 }}>
            Solução: {d.solucao}
          </p>
        </div>
      )}

      {d.podeAtender && <Registrar d={d} usuarioId={tec.usuarioId} onConcluido={(r) => { setConcluido(r); atualizar(); }} />}

      {d.eventos.length > 0 && (
        <div className="cd-bloco">
          <h4>Histórico</h4>
          <div className="cd-tl cd-tl--tec">
            {d.eventos.map((e, i) => (
              <div key={i} className="cd-evt">
                {e.tipo === "responsavel" ? e.descricao.replace("Responsável:", "Com") : e.descricao} · {quando(e.criadoEm)}
              </div>
            ))}
          </div>
        </div>
      )}

      {d.podeAtribuir && (
        <div className="cd-rodape">
          <button type="button" className="cd-btn-ouro" disabled={atribuir.isPending} onClick={() => atribuir.mutate()}>
            <Plus size={18} aria-hidden="true" /> {atribuir.isPending ? "Aguarde…" : "Atribuir-me"}
          </button>
          <small>O chamado passa para você e vai para Em atendimento.</small>
        </div>
      )}
    </>
  );
}

function Registrar({ d, usuarioId, onConcluido }: { d: ChamadoTecnicoDetalhe; usuarioId: string; onConcluido: (r: { status: string; fotos: number }) => void }) {
  const fotos = useAnexos(usuarioId, false);
  const [tipo, setTipo] = useState<TipoResolucao | null>(null);
  const [texto, setTexto] = useState("");
  const [servicoId, setServicoId] = useState<number | null>(null);
  const [campos, setCampos] = useState<Record<string, unknown>>(() => Object.fromEntries(d.campos.map((c) => [c.chave, c.valor ?? null])));
  const [erro, setErro] = useState<{ campo?: string; texto: string } | null>(null);

  const concluir = useMutation({
    mutationFn: () => solicitanteApi.tec.concluir(d.id, { tipo: tipo!, texto: texto.trim(), fotos: fotos.anexos, servicoId, campos }),
    onSuccess: (r) => {
      const n = fotos.anexos.length;
      fotos.limpar();
      onConcluido({ status: r.justificativa ? `${r.status} · ${r.justificativa}` : r.status, fotos: n });
    },
    onError: (e: Error & { field?: string }) => setErro({ campo: e.field, texto: e.message }),
  });

  const enviar = () => {
    setErro(null);
    if (!tipo) return setErro({ campo: "tipo", texto: "Escolha o tipo de resolução." });
    if (tipo === "resolvido" && fotos.anexos.length === 0) return setErro({ campo: "fotos", texto: "Tire pelo menos 1 foto do atendimento para concluir como Resolvido." });
    if (tipo === "resolvido" && d.servicos && !servicoId) return setErro({ campo: "servicoId", texto: "Escolha o serviço antes de concluir como Resolvido." });
    const vazios = d.campos.filter((c) => vazio(campos[c.chave])).map((c) => c.rotulo);
    if (tipo === "resolvido" && vazios.length) return setErro({ campo: "campos", texto: `Preencha antes de concluir: ${vazios.join(", ")}.` });
    if (texto.trim().length < 5) return setErro({ campo: "texto", texto: "Escreva o que foi feito." });
    concluir.mutate();
  };

  const efeito = TIPOS.find((t) => t.tipo === tipo)?.efeito;
  const msg = (campo: string) => (erro?.campo === campo ? <span className="cd-erro" role="alert">{erro.texto}</span> : null);

  return (
    <>
      <div className="cd-bloco cd-bloco--acao">
        <h4>Registrar atendimento</h4>
        <span className="cd-rot" style={{ marginTop: 0 }}>
          Fotos do atendimento{tipo === "resolvido" || !tipo ? " *" : ""}
        </span>
        <div className="cd-fotos">
          <label className="cd-foto-add">
            <Camera size={20} aria-hidden="true" />
            Tirar foto
            <input type="file" accept="image/*" capture="environment" onChange={(e) => { fotos.adicionar(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="cd-foto-add">
            <ImagePlus size={20} aria-hidden="true" />
            Galeria
            <input type="file" accept="image/*" multiple onChange={(e) => { fotos.adicionar(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <Miniaturas itens={fotos.itens} onRemover={fotos.remover} />
        {msg("fotos")}

        {d.servicos && (
          <>
            <label className="cd-rot" htmlFor="tec-serv">
              Serviço {tipo === "resolvido" ? "*" : ""}
            </label>
            <select id="tec-serv" className="cd-campo" value={servicoId ?? ""} onChange={(e) => setServicoId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">— Escolha o serviço —</option>
              {d.servicos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.rotulo}
                </option>
              ))}
            </select>
            {msg("servicoId")}
          </>
        )}

        {d.campos.map((c) => (
          <CampoAdicional key={c.chave} c={c} obrigatorio={tipo === "resolvido" || !tipo} valor={campos[c.chave]} onChange={(v) => setCampos((x) => ({ ...x, [c.chave]: v }))} />
        ))}
        {msg("campos")}

        <span className="cd-rot">Tipo de resolução *</span>
        <div className="cd-tipos" role="radiogroup" aria-label="Tipo de resolução">
          {TIPOS.map((t) => (
            <button key={t.tipo} type="button" className="cd-tipo" role="radio" aria-checked={tipo === t.tipo} onClick={() => setTipo(t.tipo)}>
              <i aria-hidden="true">{t.icone}</i>
              <span>
                <b>{t.titulo}</b>
                <small>{t.dica}</small>
              </span>
            </button>
          ))}
        </div>
        {msg("tipo")}
        {efeito && <div className="cd-efeito">{efeito}</div>}

        <label className="cd-rot" htmlFor="tec-texto">
          O que foi feito *
        </label>
        <textarea
          id="tec-texto"
          className="cd-campo"
          maxLength={4000}
          placeholder="Ex.: HD do NVR cheio; ativada a sobrescrita automática e testada a reprodução das câmeras."
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          aria-invalid={erro?.campo === "texto"}
        />
        {msg("texto")}
        <span style={{ display: "block", fontSize: 12, color: "var(--cd-txt-3)", marginTop: 6 }}>Vai para o solicitante e vira a Solução aplicada.</span>
        {erro && !["fotos", "servicoId", "tipo", "texto", "campos"].includes(erro.campo ?? "") && (
          <p className="cd-alerta" role="alert" style={{ margin: "10px 0 0" }}>
            {erro.texto}
          </p>
        )}
      </div>
      <div className="cd-rodape">
        <button type="button" className="cd-btn-ouro" disabled={concluir.isPending || fotos.enviando} onClick={enviar}>
          {concluir.isPending ? "Enviando…" : fotos.enviando ? "Enviando foto…" : "Concluir atendimento"}
        </button>
        <small>Obrigatórios: tipo de resolução, o que foi feito e foto (para Resolvido).</small>
      </div>
    </>
  );
}

const vazio = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Campo adicional obrigatório do chamado (Administração › Campos adicionais), no visual do app. */
function CampoAdicional({ c, obrigatorio, valor, onChange }: { c: CampoTecnico; obrigatorio: boolean; valor: unknown; onChange: (v: unknown) => void }) {
  const id = `tec-campo-${c.chave}`;
  const texto = valor === null || valor === undefined ? "" : String(valor);
  let controle: ReactNode;
  if (c.tipo === "lista") {
    controle = (
      <select id={id} className="cd-campo" value={texto} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— Escolha —</option>
        {c.opcoes.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (c.tipo === "multipla") {
    const lista = Array.isArray(valor) ? (valor as string[]) : [];
    controle = (
      <div className="cd-chips" role="group" aria-labelledby={`${id}-rot`}>
        {c.opcoes.map((o) => (
          <button key={o} type="button" className="cd-chip" aria-pressed={lista.includes(o)} onClick={() => onChange(lista.includes(o) ? lista.filter((x) => x !== o) : [...lista, o])}>
            {o}
          </button>
        ))}
      </div>
    );
  } else if (c.tipo === "sim_nao") {
    controle = (
      <div className="cd-chips" role="group" aria-labelledby={`${id}-rot`}>
        {[true, false].map((b) => (
          <button key={String(b)} type="button" className="cd-chip" aria-pressed={valor === b} onClick={() => onChange(b)}>
            {b ? "Sim" : "Não"}
          </button>
        ))}
      </div>
    );
  } else if (c.tipo === "texto_longo") {
    controle = <textarea id={id} className="cd-campo" style={{ minHeight: 70 }} value={texto} onChange={(e) => onChange(e.target.value)} />;
  } else {
    const tipo = { texto: "text", numero: "number", data: "date", data_hora: "datetime-local" }[c.tipo] ?? "text";
    controle = <input id={id} className="cd-campo" type={tipo} inputMode={c.tipo === "numero" ? "decimal" : undefined} value={texto} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <>
      <label className="cd-rot" id={`${id}-rot`} htmlFor={id}>
        {c.rotulo}
        {obrigatorio ? " *" : ""}
      </label>
      {controle}
      {c.ajuda && <span style={{ display: "block", fontSize: 12, color: "var(--cd-txt-3)", marginTop: 4 }}>{c.ajuda}</span>}
    </>
  );
}
