import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronRight, ClipboardList, Lightbulb, Megaphone, MessageCircle, PlusCircle, User, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Cabecalho, Carregando, SubCabecalho, useCd } from "./SolicitanteApp";
import { solicitanteApi, formatarTelefone, iniciais, type Aviso, type ChamadoResumo, type Departamento } from "./service";
import { IconeSetor } from "./IconeSetor";

// ---------- utilitários de exibição ----------

const HORA = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const DIA_HORA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DIA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "há 5 min", "hoje 08:44", "02/10 14:00". */
export function quando(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min >= 0 && min < 1) return "agora";
  if (min >= 0 && min < 60) return `há ${min} min`;
  const hoje = new Date();
  if (d.toDateString() === hoje.toDateString()) return `hoje ${HORA.format(d)}`;
  return DIA_HORA.format(d);
}

/** "hoje até 11:30" / "até 02/10 14:00". */
export function prazo(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? `hoje até ${HORA.format(d)}` : `até ${DIA_HORA.format(d)}`;
}

export const dia = (iso: string | null | undefined) => (iso ? DIA.format(new Date(iso)) : "");

export function Status({ s }: { s: ChamadoResumo["status"] }) {
  const rotulo = s.categoria === "novo" ? "Aberto" : s.nome;
  return <span className={`cd-st cd-st--${s.categoria}`}>{rotulo}</span>;
}

export function CartaoChamado({ c }: { c: ChamadoResumo }) {
  const fechado = c.encerradoEm !== null;
  return (
    <Link to={`/app/chamados/${c.id}`} className={`cd-card${c.novo ? " cd-card--novo" : ""}${fechado ? " cd-card--fechado" : ""}`}>
      <div className="cd-card__l1">
        <span>
          #{c.id} · {c.servico ? c.servico.split(" › ").pop() : c.setor}
        </span>
        <Status s={c.status} />
      </div>
      <h3>{c.assunto}</h3>
      <p>
        {c.novo && <span className="cd-novo">● Nova resposta · </span>}
        {c.ultima && c.ultima.direcao === "saida"
          ? `${c.ultima.autor}: ${c.ultima.texto}`
          : fechado
            ? `Encerrado em ${dia(c.encerradoEm)}`
            : c.responsavel
              ? `Com ${c.responsavel}`
              : c.slaRespostaAte
                ? `Aguardando a equipe · resposta ${prazo(c.slaRespostaAte)}`
                : "Aguardando a equipe"}
        {c.ultima && ` · ${quando(c.ultima.em)}`}
      </p>
    </Link>
  );
}

/** Departamento da URL (/app/d/:setorId); null se não existir ou não estiver no app. */
function useDepartamento(): Departamento | null {
  const { setorId } = useParams();
  const { entrada } = useCd();
  return entrada.setores.find((s) => String(s.id) === setorId) ?? null;
}

const ARTE: Record<Aviso["tipo"], string> = { manutencao: "🛠️", alerta: "⚠️", resolvido: "✅", comunicado: "📣" };
const TIPO: Record<Aviso["tipo"], string> = { manutencao: "Manutenção", alerta: "Alerta", resolvido: "Resolvido", comunicado: "Comunicado" };

// ---------- telas ----------

// ---------- setor escolhido (vale na sessão do navegador) ----------

const SETOR_KEY = "solicitante-setor";

function lerSetor(): string | null {
  try {
    return sessionStorage.getItem(SETOR_KEY);
  } catch {
    return null;
  }
}

export function guardarSetor(id: number | null) {
  try {
    if (id === null) sessionStorage.removeItem(SETOR_KEY);
    else sessionStorage.setItem(SETOR_KEY, String(id));
  } catch {
    // navegador sem armazenamento: o setor vale só nesta tela
  }
}

/** /app/d/:setorId (endereço antigo do início): escolhe o setor e volta para a página inicial. */
export function EscolherSetorPelaUrl() {
  const { setorId } = useParams();
  guardarSetor(Number(setorId) || null);
  return <Navigate to="/app" replace />;
}

/** Lista de setores (folha que sobe na página inicial). */
function SeletorSetor({ setores, atual, motivo, onEscolher, onFechar }: { setores: Departamento[]; atual: number | null; motivo: string | null; onEscolher: (s: Departamento) => void; onFechar: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onFechar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onFechar]);
  return (
    <div className="cd-folha" role="presentation" onClick={onFechar}>
      <div className="cd-folha__caixa" role="dialog" aria-modal="true" aria-labelledby="cd-folha-t" onClick={(e) => e.stopPropagation()}>
        <span className="cd-folha__puxador" aria-hidden="true" />
        <h2 id="cd-folha-t">Com qual setor você precisa falar?</h2>
        {motivo && <p className="cd-folha__motivo">{motivo}</p>}
        {setores.length === 0 ? (
          <p className="cd-vazio">Nenhum setor disponível no app ainda. Fale com a TI.</p>
        ) : (
          <div className="cd-deptos" style={{ padding: 0 }}>
            {setores.map((s, i) => (
              <button key={s.id} type="button" className={`cd-depto${s.id === atual ? " cd-depto--on" : ""}`} autoFocus={i === 0} onClick={() => onEscolher(s)}>
                <span className="cd-depto__icone" aria-hidden="true">
                  <IconeSetor valor={s.icone} tamanho={34} />
                </span>
                <span>
                  <b>{s.nome}</b>
                  {s.descricao && <small>{s.descricao}</small>}
                </span>
                {s.id === atual ? <span className="cd-depto__seta" aria-label="escolhido">✓</span> : <ChevronRight className="cd-depto__seta" size={20} aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Carrossel do topo: avisos da empresa (do setor escolhido ou gerais); sem aviso, um estado vazio simples. */
function Carrossel({ avisos, setor }: { avisos: Aviso[]; setor: Departamento | null }) {
  const slides = avisos;
  const [i, setI] = useState(0);
  const total = slides.length;
  useEffect(() => {
    if (total < 2) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % total), 6000);
    return () => window.clearInterval(t);
  }, [total]);
  const s = slides[i % Math.max(total, 1)];

  const pontos =
    total > 1 ? (
      <div className="cd-pontos">
        {slides.map((_, n) => (
          <button key={n} type="button" aria-label={`Slide ${n + 1} de ${total}`} aria-current={n === i % total} onClick={() => setI(n)} />
        ))}
      </div>
    ) : null;

  if (!s) {
    return (
      <div className="cd-hero">
        <div className="cd-hero__arte" aria-hidden="true">
          <IconeSetor valor={setor?.icone} tamanho={56} />
        </div>
        <div className="cd-hero__txt">
          <small>Avisos</small>
          <h2>Tudo funcionando por aqui</h2>
          <p>Sem avisos no momento. Precisa de algo? Escolha o setor e abra um chamado.</p>
        </div>
      </div>
    );
  }
  const a = s;
  return (
    <section className={`cd-hero cd-hero--${a.tipo}`} aria-roledescription="carrossel" aria-label="Avisos">
      <div className="cd-hero__arte" aria-hidden="true">
        {ARTE[a.tipo]}
      </div>
      <div className="cd-hero__txt" aria-live="polite">
        <small>
          Aviso · {TIPO[a.tipo]}
          {a.setor ? ` · ${a.setor}` : ""}
        </small>
        <h2>{a.titulo}</h2>
        {a.texto && <p>{a.texto}</p>}
        {a.link ? (
          <a className="cd-hero__mais" href={a.link} target="_blank" rel="noreferrer noopener">
            Saber mais ↗
          </a>
        ) : (
          <Link className="cd-hero__mais" to={setor ? `/app/d/${setor.id}/avisos` : "/app/avisos"}>
            Ver avisos
          </Link>
        )}
      </div>
      {pontos}
    </section>
  );
}

/**
 * Página inicial (igual ao "Seu Imóvel" do Superapp): Bem-vindo, carrossel e a grade. O 1º quadro escolhe o setor;
 * "Abrir chamado" só se habilita depois disso. Os demais quadros continuam.
 */
export function Inicio() {
  const { entrada, como } = useCd();
  const navigate = useNavigate();
  const setores = entrada.setores;
  const [setorId, setSetorId] = useState<number | null>(() => {
    const salvo = Number(lerSetor());
    return setores.some((s) => s.id === salvo) ? salvo : setores.length === 1 ? setores[0].id : null;
  });
  const setor = setores.find((s) => s.id === setorId) ?? null;
  /** Folha de setores aberta; o texto diz por que abriu (ex.: tocou em Abrir chamado sem setor). */
  const [folha, setFolha] = useState<{ motivo: string | null; depois: string | null } | null>(null);
  const meus = useQuery({ queryKey: ["cd", "meus", como, "abertos"], queryFn: () => solicitanteApi.meusChamados("abertos", como), refetchInterval: 60_000 });
  const avisos = useQuery({ queryKey: ["cd", "avisos", setor?.id ?? null], queryFn: () => solicitanteApi.avisos(setor?.id ?? null) });
  const q = entrada.config.quadros;
  const wa = entrada.config.whatsapp;
  const noAr = (avisos.data ?? []).filter((a) => !a.fim || Date.parse(a.fim) > Date.now());

  const escolher = (s: Departamento) => {
    setSetorId(s.id);
    guardarSetor(s.id);
    const depois = folha?.depois;
    setFolha(null);
    if (depois) navigate(depois.replace(":id", String(s.id)));
  };
  /** Quadro que precisa de setor: sem setor, abre a escolha e segue depois. */
  const comSetor = (destino: string, motivo: string) => () => {
    if (setor) navigate(destino.replace(":id", String(setor.id)));
    else setFolha({ motivo, depois: destino });
  };

  return (
    <>
      <Cabecalho />
      <div className="cd-bv">
        <h1>Bem-vindo</h1>
        <p>
          Olá, {entrada.nome.split(" ")[0]} · {entrada.config.boasVindas}
        </p>
      </div>
      {/* Quadro "Avisos" desligado: o carrossel mostra só o estado vazio. */}
      <Carrossel avisos={q.avisos !== false ? noAr : []} setor={setor} />
      <nav className="cd-grade" aria-label="Atalhos">
        <button type="button" className={`cd-tile${setor ? " cd-tile--feito" : " cd-tile--ouro"}`} onClick={() => setFolha({ motivo: null, depois: null })}>
          {setor ? (
            <span className="cd-tile__emoji" aria-hidden="true">
              <IconeSetor valor={setor.icone} tamanho={32} />
            </span>
          ) : (
            <Building2 size={30} strokeWidth={1.5} aria-hidden="true" />
          )}
          <span>{setor ? setor.nome : "Setor"}</span>
          <small>{setor ? "trocar" : "selecionar"}</small>
        </button>
        <button
          type="button"
          className={`cd-tile${setor ? " cd-tile--ouro" : " cd-tile--off"}`}
          aria-disabled={!setor}
          onClick={comSetor("/app/d/:id/abrir", "Primeiro escolha o setor; depois você abre o chamado.")}
        >
          <PlusCircle size={30} strokeWidth={1.5} aria-hidden="true" />
          <span>Abrir chamado</span>
          <small>{setor ? setor.nome : "escolha o setor"}</small>
        </button>
        {q.meus !== false && (
          <Link to="/app/chamados" className="cd-tile">
            {(meus.data?.novos ?? 0) > 0 && <span className="cd-badge" aria-label={`${meus.data?.novos} com resposta nova`}>{meus.data?.novos}</span>}
            <ClipboardList size={28} strokeWidth={1.6} aria-hidden="true" />
            <span>Meus chamados</span>
            {meus.data && <small>{meus.data.abertos} {meus.data.abertos === 1 ? "aberto" : "abertos"}</small>}
          </Link>
        )}
        {q.avisos !== false && (
          <Link to={setor ? `/app/d/${setor.id}/avisos` : "/app/avisos"} className="cd-tile">
            <Megaphone size={28} strokeWidth={1.6} aria-hidden="true" />
            <span>Avisos</span>
          </Link>
        )}
        {q.solucoes !== false && (
          <button type="button" className="cd-tile" onClick={comSetor("/app/d/:id/solucoes", "As soluções são de cada setor. Escolha qual.")}>
            <Lightbulb size={28} strokeWidth={1.6} aria-hidden="true" />
            <span>Soluções</span>
          </button>
        )}
        {q.whatsapp !== false && wa && (
          <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer noopener" className="cd-tile cd-tile--wa">
            <MessageCircle size={28} strokeWidth={1.6} aria-hidden="true" />
            <span>Falar no WhatsApp</span>
          </a>
        )}
        <Link to="/app/financeiro" className="cd-tile">
          <Wallet size={28} strokeWidth={1.6} aria-hidden="true" />
          <span>Financeiro</span>
          <small>reembolso e fundo fixo</small>
        </Link>
        {q.perfil !== false && (
          <Link to="/app/perfil" className="cd-tile">
            <User size={28} strokeWidth={1.6} aria-hidden="true" />
            <span>Meu perfil</span>
          </Link>
        )}
      </nav>
      {meus.data && meus.data.itens.length > 0 && (
        <div className="cd-sec">
          <span className="cd-rot">Em andamento</span>
          <div style={{ display: "grid", gap: 10 }}>
            {meus.data.itens.slice(0, 3).map((c) => (
              <CartaoChamado key={c.id} c={c} />
            ))}
          </div>
        </div>
      )}
      {folha && <SeletorSetor setores={setores} atual={setorId} motivo={folha.motivo} onEscolher={escolher} onFechar={() => setFolha(null)} />}
    </>
  );
}

/** Avisos da empresa (do setor ou gerais). Sem nenhum, um estado vazio simples. */
export function Avisos() {
  const { setorId } = useParams();
  const { entrada } = useCd();
  const setor = entrada.setores.find((s) => String(s.id) === setorId) ?? null;
  const avisos = useQuery({ queryKey: ["cd", "avisos", setor?.id ?? null], queryFn: () => solicitanteApi.avisos(setor?.id ?? null) });
  const vazio = avisos.isSuccess && avisos.data.length === 0;
  return (
    <>
      <SubCabecalho titulo="Avisos" sub={setor ? `${setor.nome} e avisos gerais` : "Avisos de todos os setores"} voltar="/app" />
      {avisos.isPending ? (
        <Carregando />
      ) : !vazio ? (
        <div className="cd-lista">
          {avisos.data!.map((a) => (
            <article key={a.id} className="cd-card">
              <div className="cd-card__l1">
                <span>
                  {quando(a.inicio)}
                  {a.fim ? ` → ${DIA_HORA.format(new Date(a.fim))}` : ""}
                  {a.setor ? ` · ${a.setor}` : ""}
                </span>
                <span className={`cd-st cd-st--${a.tipo === "resolvido" ? "resolvido" : a.tipo === "comunicado" ? "novo" : "andamento"}`}>{TIPO[a.tipo]}</span>
              </div>
              <h3>
                {ARTE[a.tipo]} {a.titulo}
              </h3>
              {a.texto && <p>{a.texto}</p>}
              {a.link && (
                <p style={{ marginTop: 6 }}>
                  <a href={a.link} target="_blank" rel="noreferrer noopener" style={{ color: "var(--cd-ouro)" }}>
                    Saber mais ↗
                  </a>
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="cd-vazio" style={{ paddingTop: 4 }}>
          ✅ Nenhum aviso no momento.
        </p>
      )}
    </>
  );
}

export function Solucoes() {
  const setor = useDepartamento();
  const [busca, setBusca] = useState("");
  const [aberta, setAberta] = useState<number | null>(null);
  const lista = useQuery({ queryKey: ["cd", "solucoes", setor?.id], queryFn: () => solicitanteApi.solucoes(setor!.id, null, null), enabled: Boolean(setor) });
  if (!setor) return <Navigate to="/app" replace />;
  const termo = busca.trim().toLowerCase();
  const itens = (lista.data ?? []).filter((s) => !termo || `${s.titulo} ${s.texto} ${s.servico ?? ""}`.toLowerCase().includes(termo));
  const abrir = (id: number) => {
    setAberta((x) => (x === id ? null : id));
    if (aberta !== id) void solicitanteApi.solucaoUsada(id).catch(() => {});
  };
  return (
    <>
      <SubCabecalho titulo="Soluções" sub="Resolva sozinho em segundos" voltar="/app" />
      <div className="cd-sec">
        <input className="cd-campo" type="search" placeholder="Buscar: senha, vpn, impressora…" aria-label="Buscar solução" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      {lista.isPending ? (
        <Carregando />
      ) : itens.length === 0 ? (
        <p className="cd-vazio">
          Nenhuma solução encontrada.
          <br />
          <Link to={`/app/d/${setor.id}/abrir`} style={{ color: "var(--cd-ouro)" }}>
            Abrir um chamado
          </Link>
        </p>
      ) : (
        <div className="cd-lista">
          {itens.map((s) => (
            <button key={s.id} type="button" className="cd-card" aria-expanded={aberta === s.id} onClick={() => abrir(s.id)}>
              <div className="cd-card__l1">
                <span>{s.servico ?? setor.nome}</span>
                {s.usos > 0 && <span>usada {s.usos}×</span>}
              </div>
              <h3>{s.titulo}</h3>
              <p>{aberta === s.id ? s.texto : s.texto.length > 90 ? `${s.texto.slice(0, 90)}…` : s.texto}</p>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function Perfil() {
  const { entrada, simulando } = useCd();
  const qc = useQueryClient();
  const [nome, setNome] = useState(entrada.nome);
  const [telefone, setTelefone] = useState(formatarTelefone(entrada.telefone));
  const [erro, setErro] = useState<{ campo?: string; texto: string } | null>(null);
  const salvar = useMutation({
    mutationFn: () => solicitanteApi.salvarPerfil({ nome: nome.trim(), telefone }),
    onSuccess: async () => {
      setErro(null);
      toast.success("Perfil salvo.");
      await qc.invalidateQueries({ queryKey: ["cd", "entrada"] });
    },
    onError: (e: Error & { field?: string }) => setErro({ campo: e.field, texto: e.message }),
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    salvar.mutate();
  };
  return (
    <>
      <SubCabecalho titulo="Meu perfil" sub="Para a equipe te encontrar rápido" voltar="/app" />
      <form className="cd-sec" onSubmit={enviar}>
        <div className="cd-ident" style={{ margin: 0 }}>
          <span className="cd-av" aria-hidden="true">
            {iniciais(entrada.nome)}
          </span>
          <div>
            <b>{entrada.nome}</b>
            <span>{entrada.email}</span>
          </div>
        </div>
        {erro && !erro.campo && <p className="cd-alerta" style={{ marginTop: 12 }}>{erro.texto}</p>}
        <label className="cd-rot" htmlFor="cd-nome">
          Nome completo
        </label>
        <input id="cd-nome" className="cd-campo" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" aria-invalid={erro?.campo === "nome" || undefined} />
        {erro?.campo === "nome" && <span className="cd-erro">{erro.texto}</span>}
        <label className="cd-rot" htmlFor="cd-tel">
          Telefone corporativo (WhatsApp)
        </label>
        <input
          id="cd-tel"
          className="cd-campo"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(21) 99999-9999"
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
          aria-invalid={erro?.campo === "telefone" || undefined}
        />
        {erro?.campo === "telefone" ? (
          <span className="cd-erro">{erro.texto}</span>
        ) : (
          <span className="cd-erro" style={{ color: "var(--cd-txt-3)" }}>
            Com ele, a equipe já sabe quem é você quando você escreve no WhatsApp do suporte.
          </span>
        )}
        <div style={{ height: 16 }} />
        <button type="submit" className="cd-btn-ouro" disabled={simulando || salvar.isPending}>
          {salvar.isPending ? "Salvando…" : "Salvar"}
        </button>
        {entrada.equipe && !simulando && (
          <>
            <div style={{ height: 10 }} />
            <Link to="/home" className="cd-btn-vidro">
              Ir para o portal da equipe
            </Link>
          </>
        )}
      </form>
    </>
  );
}
