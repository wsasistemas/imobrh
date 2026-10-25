import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import "../../configuracoes/components/Sheet.css";
import { useOrdenarStatus, useSalvarJustificativa, useSalvarStatus, useStatusTickets } from "../hooks";
import { CATEGORIAS, type CategoriaStatus, type Justificativa, type StatusTicket } from "../status/types";
import "./Chamados.css";

// Gestão de Chamados › Status (seção adminOnly): cadastro dos status de ticket e das justificativas de cada um.
// A categoria decide os números do painel; o Kanban das visões arrasta "status › justificativa".

type Edicao =
  | { tipo: "status"; status: StatusTicket | null }
  | { tipo: "justificativa"; status: StatusTicket; justificativa: Justificativa | null }
  | null;

const CATEGORIA_TOM: Record<CategoriaStatus, string> = {
  novo: "ch-badge--info",
  andamento: "ch-badge--info",
  pendente: "ch-badge--warning",
  resolvido: "ch-badge--success",
  fechado: "ch-badge--success",
  cancelado: "",
};

const categoriaLabel = (c: CategoriaStatus) => CATEGORIAS.find((x) => x.value === c)?.label ?? c;

export function StatusCadastro() {
  const status = useStatusTickets();
  const ordenar = useOrdenarStatus();
  const [edicao, setEdicao] = useState<Edicao>(null);

  const mover = (lista: StatusTicket[], i: number, delta: number) => {
    const ids = lista.map((s) => s.id);
    [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
    ordenar.mutate(ids, { onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível reordenar.") });
  };

  if (status.isPending) return <PageSkeleton />;
  if (status.isError) return <ErrorState message="Não foi possível carregar os status." onRetry={() => void status.refetch()} />;
  const lista = status.data;

  return (
    <section aria-labelledby="ch-status-titulo">
      <div className="ch-toolbar">
        <div>
          <h2 id="ch-status-titulo" style={{ margin: 0, fontSize: 16 }}>
            Status de ticket
          </h2>
          <p className="ch-hint" style={{ margin: 0 }}>
            A <b>categoria</b> decide em que número o ticket conta (Abertos, Pendentes, Fechados). Justificativas detalham o status, por exemplo{" "}
            <b>Aguardando › Retorno do cliente</b>. Em uso, nada é excluído: desative.
          </p>
        </div>
        <span className="ch-toolbar__spacer" />
        <button type="button" className="btn btn--primary" onClick={() => setEdicao({ tipo: "status", status: null })}>
          <Plus size={16} aria-hidden="true" />
          Novo status
        </button>
      </div>

      {lista.length === 0 ? (
        <div className="card">
          <EmptyState icon={ListChecks} title="Nenhum status cadastrado" description="Crie o primeiro status de ticket." />
        </div>
      ) : (
        <ol className="ch-status-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {lista.map((s, i) => (
            <li key={s.id} className={`ch-status${s.ativo ? "" : " ch-status--inativo"}`}>
              <div className="ch-status__order">
                <button type="button" className="icon-btn" aria-label={`Subir ${s.nome}`} disabled={i === 0 || ordenar.isPending} onClick={() => mover(lista, i, -1)}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn" aria-label={`Descer ${s.nome}`} disabled={i === lista.length - 1 || ordenar.isPending} onClick={() => mover(lista, i, 1)}>
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
              </div>
              <div>
                <div className="ch-status__name">
                  {s.nome}
                  <span className={`ch-badge ${CATEGORIA_TOM[s.categoria]}`}>{categoriaLabel(s.categoria)}</span>
                  {!s.ativo && <span className="ch-badge">Inativo</span>}
                </div>
                <div className="ch-status__just">
                  {s.justificativas.length === 0 && <span className="ch-muted" style={{ fontSize: 12 }}>Sem justificativas.</span>}
                  {s.justificativas.map((j) => (
                    <button
                      key={j.id}
                      type="button"
                      className={`ch-badge${j.ativa ? "" : " ch-badge--off"}`}
                      title={j.ativa ? "Editar justificativa" : "Inativa · editar"}
                      onClick={() => setEdicao({ tipo: "justificativa", status: s, justificativa: j })}
                    >
                      {j.nome}
                    </button>
                  ))}
                  <button type="button" className="btn btn--outline" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => setEdicao({ tipo: "justificativa", status: s, justificativa: null })}>
                    <Plus size={13} aria-hidden="true" />
                    Justificativa
                  </button>
                </div>
              </div>
              <button type="button" className="btn btn--outline" onClick={() => setEdicao({ tipo: "status", status: s })}>
                <Pencil size={14} aria-hidden="true" />
                Editar
              </button>
            </li>
          ))}
        </ol>
      )}

      <Dialog.Root open={edicao !== null} onOpenChange={(o) => !o && setEdicao(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="sheet" aria-describedby={undefined}>
            {edicao?.tipo === "status" && <StatusForm key={edicao.status?.id ?? "novo"} status={edicao.status} onFechar={() => setEdicao(null)} />}
            {edicao?.tipo === "justificativa" && (
              <JustificativaForm key={edicao.justificativa?.id ?? "nova"} status={edicao.status} justificativa={edicao.justificativa} onFechar={() => setEdicao(null)} />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function Cabecalho({ titulo, descricao }: { titulo: string; descricao: string }) {
  return (
    <header className="sheet__header">
      <div>
        <Dialog.Title className="sheet__title">{titulo}</Dialog.Title>
        <p className="sheet__description">{descricao}</p>
      </div>
      <Dialog.Close asChild>
        <button type="button" className="icon-btn" aria-label="Fechar">
          <X size={18} aria-hidden="true" />
        </button>
      </Dialog.Close>
    </header>
  );
}

function Rodape({ salvando, onFechar }: { salvando: boolean; onFechar: () => void }) {
  return (
    <footer className="sheet__footer">
      <button type="button" className="btn btn--outline" onClick={onFechar}>
        Cancelar
      </button>
      <button type="submit" className="btn btn--primary" disabled={salvando}>
        {salvando ? "Salvando…" : "Salvar"}
      </button>
    </footer>
  );
}

function StatusForm({ status, onFechar }: { status: StatusTicket | null; onFechar: () => void }) {
  const ids = useId();
  const salvar = useSalvarStatus();
  const [nome, setNome] = useState(status?.nome ?? "");
  const [categoria, setCategoria] = useState<CategoriaStatus>(status?.categoria ?? "andamento");
  const [ativo, setAtivo] = useState(status?.ativo ?? true);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: status?.id, nome, categoria, ativo },
      {
        onSuccess: () => {
          toast.success(status ? "Status salvo" : "Status criado");
          onFechar();
        },
        onError: (er) => setErro(er instanceof ServiceError ? er.message : "Não foi possível salvar o status."),
      },
    );
  };

  return (
    <form className="sheet__form" onSubmit={enviar}>
      <Cabecalho titulo={status ? `Editar status · ${status.nome}` : "Novo status"} descricao="O nome aparece no ticket; a categoria decide os números do painel." />
      <div className="sheet__body">
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-n`}>Nome</label>
          <input id={`${ids}-n`} className="input" maxLength={40} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Aguardando" autoFocus />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-c`}>Categoria</label>
          <select id={`${ids}-c`} className="input" value={categoria} onChange={(e) => setCategoria(e.target.value as CategoriaStatus)}>
            {CATEGORIAS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <span className="field__help">{CATEGORIAS.find((c) => c.value === categoria)?.descricao}</span>
        </div>
        <label className="ch-check">
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
          Ativo (aparece para escolher no ticket e no Kanban)
        </label>
        {erro && <p className="field__error" role="alert">{erro}</p>}
      </div>
      <Rodape salvando={salvar.isPending} onFechar={onFechar} />
    </form>
  );
}

function JustificativaForm({ status, justificativa, onFechar }: { status: StatusTicket; justificativa: Justificativa | null; onFechar: () => void }) {
  const ids = useId();
  const salvar = useSalvarJustificativa();
  const [nome, setNome] = useState(justificativa?.nome ?? "");
  const [ativa, setAtiva] = useState(justificativa?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: justificativa?.id, statusId: status.id, nome, ativa },
      {
        onSuccess: () => {
          toast.success(justificativa ? "Justificativa salva" : "Justificativa criada");
          onFechar();
        },
        onError: (er) => setErro(er instanceof ServiceError ? er.message : "Não foi possível salvar a justificativa."),
      },
    );
  };

  return (
    <form className="sheet__form" onSubmit={enviar}>
      <Cabecalho
        titulo={justificativa ? `Editar justificativa · ${status.nome} › ${justificativa.nome}` : `Nova justificativa de "${status.nome}"`}
        descricao="Detalha o status no ticket e no Kanban."
      />
      <div className="sheet__body">
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-n`}>Nome</label>
          <input id={`${ids}-n`} className="input" maxLength={40} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Retorno do cliente" autoFocus />
        </div>
        <label className="ch-check">
          <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
          Ativa
        </label>
        {erro && <p className="field__error" role="alert">{erro}</p>}
      </div>
      <Rodape salvando={salvar.isPending} onFechar={onFechar} />
    </form>
  );
}
