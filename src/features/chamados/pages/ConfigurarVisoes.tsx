import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Kanban, List, Lock, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { getMenuItem } from "../../../config/menuRegistry";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { ComPainel } from "../../dashboard/useDashboardData";
import type { DashboardPayload } from "../../dashboard/types";
import { useEquipesVisoes, useExcluirVisao, useKanbanPadrao, useListaExtras, useSalvarKanbanPadrao, useSalvarVisao, useStatusTickets, useVisoesConfig } from "../hooks";
import { rotuloStatus, type StatusTicket } from "../status/types";
import { atendeCondicoes } from "../visoes/avaliar";
import { AGRUPAMENTOS, CAMPOS, campoDef, fonteDoValor, OPERADORES, ORDENACOES, PRIORIDADES } from "../visoes/campos";
import { SeletorColunas } from "../visoes/SeletorColunas";
import { usePermissoesVisoes } from "../visoes/permissoes";
import { AGRUPAMENTO_PADRAO } from "../visoes/seed";
import type { CampoAgrupamento, ColunaKanban, Condicao, Condicoes, Ordenacao, StatusRef, Visao, VisaoSalvar } from "../visoes/types";
import { coordenadasPorColuna } from "../dnd";
import "./Chamados.css";

// Gestão de Chamados › Tickets › Configurar visões (só Admin e Super admin). Abas iguais ao modelo da
// Movidesk: Principal, Condições, Kanban e Agrupamento (docs/mockups/tickets-visoes.html).

type Aba = "principal" | "condicoes" | "kanban" | "agrupamento";
const ABAS: { id: Aba; label: string }[] = [
  { id: "principal", label: "Principal" },
  { id: "condicoes", label: "Condições" },
  { id: "kanban", label: "Kanban" },
  { id: "agrupamento", label: "Agrupamento" },
];

const refKey = (r: StatusRef) => `${r.statusId}:${r.justificativaId ?? ""}`;
const novaColunaId = () => `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function rascunhoNovo(colunas: ColunaKanban[]): VisaoSalvar {
  return {
    nome: "",
    habilitada: true,
    tipo: "kanban",
    padrao: false,
    equipes: [],
    condicoes: { todas: [], qualquer: [] },
    kanban: { colunas: structuredClone(colunas), ordenar: "sla", arrastar: "mudar_status" },
    agrupamento: structuredClone(AGRUPAMENTO_PADRAO),
  };
}

function paraRascunho(v: Visao): VisaoSalvar {
  const { atualizadoEm: _a, atualizadoPor: _p, ...resto } = structuredClone(v);
  return resto;
}

export function ConfigurarVisoes() {
  const visoes = useVisoesConfig();
  const status = useStatusTickets();
  const padrao = useKanbanPadrao();
  const perm = usePermissoesVisoes();
  const [params, setParams] = useSearchParams();
  const [rascunho, setRascunho] = useState<VisaoSalvar | null>(null);
  const selecionadaId = params.get("visao");

  // Abre a visão da URL (ou a padrão) quando a lista chega ou a seleção muda.
  useEffect(() => {
    if (!visoes.data || selecionadaId === "nova") return;
    const v = visoes.data.find((x) => String(x.id) === selecionadaId) ?? visoes.data.find((x) => x.padrao) ?? visoes.data[0];
    setRascunho(v ? paraRascunho(v) : null);
  }, [visoes.data, selecionadaId]);

  if (visoes.isPending || status.isPending || padrao.isPending) return <PageSkeleton />;
  if (visoes.isError || status.isError || padrao.isError) {
    return <ErrorState message="Não foi possível carregar as visões." onRetry={() => void Promise.all([visoes.refetch(), status.refetch(), padrao.refetch()])} />;
  }

  const ticketsPath = getMenuItem("gestao_chamados_tickets").path;
  const selecionar = (id: number | "nova") => {
    setParams({ visao: String(id) }, { replace: true });
    if (id === "nova") setRascunho(rascunhoNovo(padrao.data));
  };

  return (
    <section aria-label="Configurar visões">
      <div className="ch-toolbar">
        <Link className="btn btn--outline" to={`${ticketsPath}${rascunho?.id ? `?visao=${rascunho.id}` : ""}`}>
          <ArrowLeft size={16} aria-hidden="true" />
          Voltar para Tickets
        </Link>
        <span className="ch-toolbar__spacer" />
        <span className="ch-lock">
          <Lock size={13} aria-hidden="true" />
          Só Admin e Super admin configuram visões{perm.podeExcluir ? "" : " · excluir e Kanban padrão: só Super admin"}
        </span>
      </div>

      <div className="ch-cfg">
        <nav className="ch-vlist" aria-label="Visões">
          <div className="ch-vlist__head">
            <h2>Visões</h2>
            <button type="button" className="btn btn--primary" onClick={() => selecionar("nova")}>
              <Plus size={15} aria-hidden="true" />
              Nova
            </button>
          </div>
          {visoes.data.map((v) => (
            <button key={v.id} type="button" className="ch-vitem" aria-current={rascunho?.id === v.id} onClick={() => selecionar(v.id)}>
              <span className="ch-vitem__icon" aria-hidden="true">{v.tipo === "kanban" ? <Kanban size={15} /> : <List size={15} />}</span>
              <span>
                <b>{v.nome}</b>
                <small>
                  {v.tipo === "kanban" ? "Kanban" : "Lista"} · {v.habilitada ? "Habilitada" : "Desabilitada"}
                  {v.padrao ? " · Padrão" : ""}
                </small>
              </span>
            </button>
          ))}
          {selecionadaId === "nova" && (
            <button type="button" className="ch-vitem" aria-current>
              <span className="ch-vitem__icon" aria-hidden="true"><Plus size={15} /></span>
              <span><b>{rascunho?.nome || "Nova visão"}</b><small>Ainda não salva</small></span>
            </button>
          )}
        </nav>

        {rascunho ? (
          <Editor
            key={rascunho.id ?? "nova"}
            inicial={rascunho}
            status={status.data}
            padrao={padrao.data}
            onSalvo={(id) => setParams({ visao: String(id) }, { replace: true })}
            onExcluido={() => setParams({}, { replace: true })}
            onDuplicar={(copia) => {
              setParams({ visao: "nova" }, { replace: true });
              setRascunho(copia);
            }}
          />
        ) : (
          <div className="card ch-empty">Nenhuma visão ainda. Clique em <b>Nova</b> para criar a primeira.</div>
        )}
      </div>
    </section>
  );
}

// ---------- Editor ----------

interface EditorProps {
  inicial: VisaoSalvar;
  status: StatusTicket[];
  padrao: ColunaKanban[];
  onSalvo: (id: number) => void;
  onExcluido: () => void;
  onDuplicar: (copia: VisaoSalvar) => void;
}

function Editor({ inicial, status, padrao, onSalvo, onExcluido, onDuplicar }: EditorProps) {
  const perm = usePermissoesVisoes();
  const salvar = useSalvarVisao();
  const excluir = useExcluirVisao();
  const salvarPadrao = useSalvarKanbanPadrao();
  const [v, setV] = useState<VisaoSalvar>(inicial);
  const [aba, setAba] = useState<Aba>("principal");
  const [erro, setErro] = useState<string | null>(null);
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);
  const muda = <K extends keyof VisaoSalvar>(k: K, valor: VisaoSalvar[K]) => setV((x) => ({ ...x, [k]: valor }));

  const enviar = () => {
    setErro(null);
    salvar.mutate(v, {
      onSuccess: (id) => {
        toast.success(v.id ? "Visão salva" : "Visão criada");
        onSalvo(id as number);
      },
      onError: (e) => setErro(e instanceof ServiceError ? e.message : "Não foi possível salvar a visão."),
    });
  };

  return (
    <div className="ch-editor">
      <div className="ch-editor__head">
        <h2>{v.nome.trim() || "Nova visão"}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {v.id && (
            <button type="button" className="btn btn--outline" onClick={() => onDuplicar({ ...structuredClone(v), id: undefined, nome: `${v.nome} (cópia)`, padrao: false })}>
              <Copy size={15} aria-hidden="true" />
              Duplicar
            </button>
          )}
          {v.id && perm.podeExcluir && (
            <button type="button" className="btn btn--danger-outline" onClick={() => setConfirmarExclusao(true)}>
              <Trash2 size={15} aria-hidden="true" />
              Excluir
            </button>
          )}
        </div>
      </div>

      <div className="ch-tabs" role="tablist" aria-label="Configuração da visão">
        {ABAS.map((a) => (
          <button key={a.id} type="button" role="tab" id={`ch-tab-${a.id}`} aria-selected={aba === a.id} aria-controls={`ch-pane-${a.id}`} onClick={() => setAba(a.id)}>
            {a.label}
          </button>
        ))}
      </div>

      <div className="ch-pane" role="tabpanel" id={`ch-pane-${aba}`} aria-labelledby={`ch-tab-${aba}`}>
        {aba === "principal" && <AbaPrincipal v={v} muda={muda} />}
        {aba === "condicoes" && <AbaCondicoes condicoes={v.condicoes} status={status} onChange={(c) => muda("condicoes", c)} />}
        {aba === "kanban" && (
          <AbaKanban
            v={v}
            status={status}
            onChange={(k) => muda("kanban", k)}
            onRestaurar={() => muda("kanban", { ...v.kanban, colunas: structuredClone(padrao) })}
            onDefinirPadrao={
              perm.podeDefinirPadrao
                ? () => salvarPadrao.mutate(v.kanban.colunas, { onSuccess: () => toast.success("Kanban padrão do sistema atualizado"), onError: () => toast.error("Não foi possível definir o padrão.") })
                : undefined
            }
          />
        )}
        {aba === "agrupamento" && <AbaAgrupamento v={v} onChange={(a) => muda("agrupamento", a)} />}
      </div>

      <div className="ch-editor__foot">
        <span className="ch-editor__error" role="alert">{erro}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn--outline" onClick={() => setV(inicial)} disabled={salvar.isPending}>
            Descartar alterações
          </button>
          <button type="button" className="btn btn--primary" onClick={enviar} disabled={salvar.isPending}>
            {salvar.isPending ? "Salvando…" : "Salvar visão"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmarExclusao}
        onOpenChange={setConfirmarExclusao}
        title={`Excluir a visão "${v.nome}"?`}
        description="Ela some da tela Tickets de todas as equipes. Para só esconder, desabilite em Principal."
        confirmLabel="Excluir visão"
        tone="danger"
        isPending={excluir.isPending}
        onConfirm={() =>
          v.id &&
          excluir.mutate(v.id, {
            onSuccess: () => {
              toast.success("Visão excluída");
              setConfirmarExclusao(false);
              onExcluido();
            },
            onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível excluir."),
          })
        }
      />
    </div>
  );
}

// ---------- Principal ----------

function AbaPrincipal({ v, muda }: { v: VisaoSalvar; muda: <K extends keyof VisaoSalvar>(k: K, valor: VisaoSalvar[K]) => void }) {
  const equipes = useEquipesVisoes();
  const alternarEquipe = (id: number) => muda("equipes", v.equipes.includes(id) ? v.equipes.filter((x) => x !== id) : [...v.equipes, id]);
  return (
    <>
      <div className="ch-sec">
        <label className="field" style={{ maxWidth: 520 }}>
          <span className="field__label">Nome da visão</span>
          <input className="input" maxLength={60} value={v.nome} onChange={(e) => muda("nome", e.target.value)} placeholder="Ex.: TI · Fila de chamados" />
        </label>
        <div className="ch-radios" role="radiogroup" aria-label="Situação">
          <label><input type="radio" name="ch-hab" checked={v.habilitada} onChange={() => muda("habilitada", true)} /> Habilitada</label>
          <label><input type="radio" name="ch-hab" checked={!v.habilitada} onChange={() => muda("habilitada", false)} /> Desabilitada</label>
        </div>
        <p className="ch-hint">Habilitada aparece no seletor de visões da tela Tickets. Desabilitada some do seletor, sem perder a configuração.</p>
        <div className="field">
          <span className="field__label">Tipo de visualização</span>
          <div className="ch-types">
            <button type="button" aria-pressed={v.tipo === "lista"} onClick={() => muda("tipo", "lista")}><List size={16} aria-hidden="true" /> Listagem</button>
            <button type="button" aria-pressed={v.tipo === "kanban"} onClick={() => muda("tipo", "kanban")}><Kanban size={16} aria-hidden="true" /> Kanban</button>
          </div>
        </div>
        <label className="ch-check">
          <input type="checkbox" checked={v.padrao} onChange={(e) => muda("padrao", e.target.checked)} />
          Visão padrão ao abrir Tickets (só uma no sistema)
        </label>
      </div>
      <div className="ch-sec">
        <h3>Equipes que veem esta visão</h3>
        <p className="ch-hint">Os membros das equipes marcadas veem a visão. Admin e Super admin veem todas. <b>Nenhuma marcada</b> = só Admin e Super admin.</p>
        {equipes.isPending ? (
          <p className="ch-muted">Carregando equipes…</p>
        ) : (
          <div className="ch-equipes">
            {(equipes.data ?? []).map((e) => (
              <label key={e.id} className="ch-check">
                <input type="checkbox" checked={v.equipes.includes(e.id)} onChange={() => alternarEquipe(e.id)} />
                {e.nome}
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------- Condições ----------

function useOpcoes(status: StatusTicket[], data: DashboardPayload) {
  return useMemo(() => {
    const distintos = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")).map((x) => ({ value: x, label: x }));
    const usuarios = new Map<string, string>([[data.current_user.id, data.current_user.name]]);
    for (const t of data.tickets) if (t.owner) usuarios.set(t.owner.id, t.owner.name);
    return {
      recebido_em: distintos(data.tickets.map((t) => t.recebido_em)),
      origem: distintos(["E-mail", "WhatsApp", "Intranet", "Agente"]),
      equipe: distintos([...data.teams.map((t) => t.name), ...data.tickets.map((t) => t.team)]),
      usuario: [...usuarios].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR")),
      servico: distintos(data.services.map((s) => s.name)),
      status: status.map((s) => ({ value: String(s.id), label: s.nome })),
      justificativa: status.flatMap((s) => s.justificativas.map((j) => ({ value: String(j.id), label: rotuloStatus(s.nome, j.nome) }))),
      prioridade: PRIORIDADES.map((p) => ({ value: p, label: p })),
      tag: distintos(["Verificado", "Urgente", "Diretoria", ...data.tickets.flatMap((t) => t.tags)]),
    };
  }, [data, status]);
}

interface AbaCondicoesProps {
  condicoes: Condicoes;
  status: StatusTicket[];
  onChange: (c: Condicoes) => void;
}

/** As opções de valor e a prévia usam os tickets que a pessoa vê (o painel). */
function AbaCondicoes(props: AbaCondicoesProps) {
  return <ComPainel>{(data) => <AbaCondicoesConteudo {...props} data={data} />}</ComPainel>;
}

function AbaCondicoesConteudo({ condicoes, status, onChange, data }: AbaCondicoesProps & { data: DashboardPayload }) {
  const opcoes = useOpcoes(status, data);
  const ctx = useMemo(
    () => ({ userId: data.current_user.id, now: new Date(data.generated_at), servicoNome: (id: number) => data.services.find((s) => s.id === id)?.name ?? "" }),
    [data],
  );
  const total = data.tickets.filter((t) => atendeCondicoes(t, condicoes, ctx)).length;

  const bloco = (chave: keyof Condicoes, titulo: string, regra: ReactNode, conector: string) => {
    const lista = condicoes[chave];
    const set = (nova: Condicao[]) => onChange({ ...condicoes, [chave]: nova });
    return (
      <div className="ch-sec">
        <h3>{titulo}</h3>
        <p className="ch-hint">{regra}</p>
        <div className="ch-conds">
          {lista.map((c, i) => (
            <LinhaCondicao
              key={i}
              rotulo={i === 0 ? "Se" : conector}
              c={c}
              opcoes={opcoes}
              onChange={(nova) => set(lista.map((x, k) => (k === i ? nova : x)))}
              onRemover={() => set(lista.filter((_, k) => k !== i))}
            />
          ))}
        </div>
        <button type="button" className="btn btn--outline ch-add" onClick={() => set([...lista, { campo: "status", operador: "igual", valores: [] }])}>
          <Plus size={15} aria-hidden="true" />
          Adicionar condição
        </button>
      </div>
    );
  };

  return (
    <>
      {bloco("todas", "Condições combinadas", <>O ticket deverá corresponder a <b>todas</b> as condições:</>, "e")}
      {bloco("qualquer", "Condições independentes", <>O ticket deverá corresponder a <b>ao menos uma</b> das condições:</>, "ou")}
      <p className="ch-note">
        Ao usar os dois tipos, o ticket precisa atender a todas as condições combinadas <b>e também</b> a pelo menos uma das independentes. Sem condições, a visão mostra todos os tickets.
      </p>
      <p className="ch-preview" aria-live="polite">
        <b>{total}</b> tickets atendem a estas condições agora (amostra demonstrativa, sem contar o filtro de encerrados há mais de 7 dias).
      </p>
    </>
  );
}

type Opcoes = ReturnType<typeof useOpcoes>;

function LinhaCondicao({ rotulo, c, opcoes, onChange, onRemover }: { rotulo: string; c: Condicao; opcoes: Opcoes; onChange: (c: Condicao) => void; onRemover: () => void }) {
  const def = campoDef(c.campo);
  const fonte = fonteDoValor(c.campo, c.operador);
  const lista = fonte && fonte in opcoes ? opcoes[fonte as keyof Opcoes] : null;
  const multi = lista && (c.operador === "igual" || c.operador === "diferente");

  const valor = (() => {
    if (fonte === null) return <span />;
    if (multi && lista) {
      return (
        <div className="ch-multi" role="group" aria-label="Valores">
          {lista.map((o) => (
            <label key={o.value}>
              <input
                type="checkbox"
                checked={c.valores.includes(o.value)}
                onChange={(e) => onChange({ ...c, valores: e.target.checked ? [...c.valores, o.value] : c.valores.filter((x) => x !== o.value) })}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    const tipo = fonte === "data" ? "date" : fonte === "dias" ? "number" : "text";
    return <input className="input" type={tipo} min={fonte === "dias" ? 1 : undefined} aria-label="Valor" value={c.valores[0] ?? ""} onChange={(e) => onChange({ ...c, valores: [e.target.value] })} placeholder="Valor" />;
  })();

  return (
    <div className="ch-cond">
      <span className="ch-cond__lg">{rotulo}</span>
      <select
        className="input"
        aria-label="Campo"
        value={c.campo}
        onChange={(e) => {
          const novo = campoDef(e.target.value as Condicao["campo"]);
          onChange({ campo: novo.id, operador: novo.operadores[0], valores: [] });
        }}
      >
        {CAMPOS.map((x) => (
          <option key={x.id} value={x.id}>{x.label}</option>
        ))}
      </select>
      <select className="input" aria-label="Operador" value={c.operador} onChange={(e) => onChange({ ...c, operador: e.target.value as Condicao["operador"], valores: [] })}>
        {def.operadores.map((o) => (
          <option key={o} value={o}>{OPERADORES[o].label}</option>
        ))}
      </select>
      {valor}
      <button type="button" className="icon-btn" aria-label="Remover condição" onClick={onRemover}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------- Kanban ----------

const POOL = "pool";

function AbaKanban({ v, status, onChange, onRestaurar, onDefinirPadrao }: { v: VisaoSalvar; status: StatusTicket[]; onChange: (k: VisaoSalvar["kanban"]) => void; onRestaurar: () => void; onDefinirPadrao?: () => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: coordenadasPorColuna }));
  const [arrastando, setArrastando] = useState<string | null>(null);
  const colunas = v.kanban.colunas;

  // Todos os itens possíveis: cada status ativo (qualquer justificativa) e cada justificativa ativa.
  const todos: StatusRef[] = status.filter((s) => s.ativo).flatMap((s) => [{ statusId: s.id, justificativaId: null }, ...s.justificativas.filter((j) => j.ativa).map((j) => ({ statusId: s.id, justificativaId: j.id }))]);
  const usados = new Set(colunas.flatMap((c) => c.status.map(refKey)));
  const pool = todos.filter((r) => !usados.has(refKey(r)));
  const rotulo = (r: StatusRef) => {
    const s = status.find((x) => x.id === r.statusId);
    const j = s?.justificativas.find((x) => x.id === r.justificativaId);
    return { status: s?.nome ?? "?", detalhe: j ? j.nome : s?.justificativas.length ? "qualquer justificativa" : "" };
  };

  const setColunas = (c: ColunaKanban[]) => onChange({ ...v.kanban, colunas: c });
  const mover = (key: string, destino: string) => {
    const ref = todos.find((r) => refKey(r) === key) ?? colunas.flatMap((c) => c.status).find((r) => refKey(r) === key);
    if (!ref) return;
    const sem = colunas.map((c) => ({ ...c, status: c.status.filter((r) => refKey(r) !== key) }));
    setColunas(destino === POOL ? sem : sem.map((c) => (c.id === destino ? { ...c, status: [...c.status, ref] } : c)));
  };
  const fim = (e: DragEndEvent) => {
    setArrastando(null);
    if (e.over) mover(String(e.active.id), String(e.over.id));
  };
  const trocar = (i: number, d: number) => {
    const c = [...colunas];
    [c[i], c[i + d]] = [c[i + d], c[i]];
    setColunas(c);
  };

  return (
    <div className="ch-sec">
      <h3>Colunas e status</h3>
      <p className="ch-hint">
        Arraste os status para as colunas (mouse, ou teclado: espaço para pegar, ← → para escolher a coluna e espaço para soltar). Use ‹ › para reordenar as colunas e clique no nome para renomear. A ordem dos
        status dentro da coluna <b>não</b> é a ordem dos tickets.
        {v.tipo === "lista" && <> Esta visão é <b>Listagem</b>: as colunas só valem se ela virar Kanban.</>}
      </p>
      <div className="ch-kb-tools">
        <button type="button" className="btn btn--primary" onClick={() => setColunas([...colunas, { id: novaColunaId(), nome: "Nova coluna", status: [] }])}>
          <Plus size={15} aria-hidden="true" />
          Adicionar coluna
        </button>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {onDefinirPadrao && (
            <button type="button" className="btn btn--outline" onClick={onDefinirPadrao}>Definir como padrão</button>
          )}
          <button type="button" className="btn btn--outline" onClick={onRestaurar}>Restaurar padrão</button>
        </div>
      </div>

      <DndContext sensors={sensors} onDragStart={(e) => setArrastando(String(e.active.id))} onDragEnd={fim} onDragCancel={() => setArrastando(null)}>
        <div className="ch-kb">
          <ColunaConfig id={POOL} titulo="Status sem coluna">
            {pool.map((r) => (
              <Chip key={refKey(r)} id={refKey(r)} {...rotulo(r)} />
            ))}
          </ColunaConfig>
          {colunas.map((c, i) => (
            <ColunaConfig
              key={c.id}
              id={c.id}
              nome={c.nome}
              onNome={(nome) => setColunas(colunas.map((x) => (x.id === c.id ? { ...x, nome } : x)))}
              onRemover={() => setColunas(colunas.filter((x) => x.id !== c.id))}
              onEsquerda={i > 0 ? () => trocar(i, -1) : undefined}
              onDireita={i < colunas.length - 1 ? () => trocar(i, 1) : undefined}
            >
              {c.status.map((r) => (
                <Chip key={refKey(r)} id={refKey(r)} {...rotulo(r)} />
              ))}
            </ColunaConfig>
          ))}
        </div>
        <DragOverlay>{arrastando && <span className="ch-chip">{rotulo(todos.find((r) => refKey(r) === arrastando) ?? { statusId: 0, justificativaId: null }).status}</span>}</DragOverlay>
      </DndContext>

      <div className="ch-grid2" style={{ marginTop: 14 }}>
        <label className="field">
          <span className="field__label">Ordenar cartões por</span>
          <select className="input" value={v.kanban.ordenar} onChange={(e) => onChange({ ...v.kanban, ordenar: e.target.value as Ordenacao })}>
            {Object.entries(ORDENACOES).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Ao arrastar um cartão para outra coluna</span>
          <select className="input" value={v.kanban.arrastar} onChange={(e) => onChange({ ...v.kanban, arrastar: e.target.value as VisaoSalvar["kanban"]["arrastar"] })}>
            <option value="mudar_status">Mudar o status (pergunta se a coluna tiver mais de um)</option>
            <option value="bloqueado">Não permitir arrastar</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function ColunaConfig({ id, titulo, nome, onNome, onRemover, onEsquerda, onDireita, children }: { id: string; titulo?: string; nome?: string; onNome?: (n: string) => void; onRemover?: () => void; onEsquerda?: () => void; onDireita?: () => void; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const pool = id === POOL;
  return (
    <div className={`ch-kcol${pool ? " ch-kcol--pool" : ""}`}>
      <div className="ch-kcol__head">
        {pool ? (
          titulo
        ) : (
          <>
            <button type="button" aria-label={`Mover a coluna ${nome} para a esquerda`} disabled={!onEsquerda} onClick={onEsquerda}><ChevronLeft size={15} aria-hidden="true" /></button>
            <input aria-label="Nome da coluna" maxLength={40} value={nome} onChange={(e) => onNome?.(e.target.value)} />
            <button type="button" aria-label={`Mover a coluna ${nome} para a direita`} disabled={!onDireita} onClick={onDireita}><ChevronRight size={15} aria-hidden="true" /></button>
            <button type="button" aria-label={`Remover a coluna ${nome}`} onClick={onRemover}><X size={15} aria-hidden="true" /></button>
          </>
        )}
      </div>
      <div ref={setNodeRef} className={`ch-kcol__body${isOver ? " ch-kcol__body--over" : ""}`} aria-label={pool ? "Status sem coluna" : `Status da coluna ${nome}`}>
        {children}
      </div>
    </div>
  );
}

function Chip({ id, status, detalhe }: { id: string; status: string; detalhe: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <button ref={setNodeRef} type="button" className={`ch-chip${isDragging ? " ch-chip--dragging" : ""}`} {...attributes} {...listeners}>
      {status}
      {detalhe && <small>{detalhe}</small>}
    </button>
  );
}

// ---------- Agrupamento ----------

function AbaAgrupamento({ v, onChange }: { v: VisaoSalvar; onChange: (a: VisaoSalvar["agrupamento"]) => void }) {
  const a = v.agrupamento;
  const extras = useListaExtras(true);
  return (
    <div className="ch-sec">
      <h3>Agrupamento da listagem</h3>
      <p className="ch-hint">
        Na Listagem, os tickets aparecem em grupos com o total de cada um. No Kanban, as colunas já agrupam por status.
        {v.tipo === "kanban" && <> Esta visão é <b>Kanban</b>: o agrupamento só vale se ela virar Listagem.</>}
      </p>
      <div className="ch-grid2">
        <label className="field">
          <span className="field__label">Agrupar por</span>
          <select className="input" value={a.por ?? ""} onChange={(e) => onChange({ ...a, por: (e.target.value || null) as CampoAgrupamento | null })}>
            <option value="">Nenhum</option>
            {Object.entries(AGRUPAMENTOS).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Ordem dos grupos</span>
          <select className="input" value={a.ordemGrupos} onChange={(e) => onChange({ ...a, ordemGrupos: e.target.value as typeof a.ordemGrupos })} disabled={!a.por}>
            <option value="az">A → Z</option>
            <option value="quantidade">Mais tickets primeiro</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Ordenar tickets por</span>
          <select className="input" value={a.ordenar} onChange={(e) => onChange({ ...a, ordenar: e.target.value as Ordenacao })}>
            {Object.entries(ORDENACOES).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Itens por página</span>
          <select className="input" value={a.porPagina} onChange={(e) => onChange({ ...a, porPagina: Number(e.target.value) as typeof a.porPagina })}>
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span className="field__label">Colunas da listagem</span>
        <SeletorColunas valor={a.colunas} onChange={(colunas) => onChange({ ...a, colunas })} campos={extras.data?.campos ?? []} carregandoCampos={extras.isPending} />
      </div>
    </div>
  );
}
