import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheckBig,
  CircleX,
  ClipboardCheck,
  Columns3,
  Headset,
  Hourglass,
  Inbox,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { DetailDialog } from "../../../components/ds";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { rotuloStatus, type StatusTicket } from "../status/types";
import type { ColunaKanban, StatusRef } from "../visoes/types";

// Edição do Kanban direto no quadro (docs/PLANO-visoes-colunas.md, Fase 1; mockup docs/mockups/visoes-colunas.html):
// renomear no título, menu ⋯ (status, mover, remover) e "+ Coluna". Só Admin e Super admin; salva na própria visão.

export const refKey = (r: StatusRef) => `${r.statusId}:${r.justificativaId ?? ""}`;
export const novaColunaId = () => `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Todos os itens que uma coluna pode ter: cada status ativo (qualquer justificativa) e cada justificativa ativa. */
export function itensDeStatus(status: readonly StatusTicket[]): StatusRef[] {
  return status
    .filter((s) => s.ativo)
    .flatMap((s) => [{ statusId: s.id, justificativaId: null }, ...s.justificativas.filter((j) => j.ativa).map((j) => ({ statusId: s.id, justificativaId: j.id }))]);
}

export function rotuloItem(r: StatusRef, status: readonly StatusTicket[]): string {
  const s = status.find((x) => x.id === r.statusId);
  const j = s?.justificativas.find((x) => x.id === r.justificativaId);
  if (j) return rotuloStatus(s?.nome ?? "?", j.nome);
  return s?.justificativas.length ? `${s.nome} (qualquer justificativa)` : (s?.nome ?? "?");
}

interface TituloProps {
  coluna: ColunaKanban;
  total: number;
  editavel: boolean;
  primeira: boolean;
  ultima: boolean;
  salvando: boolean;
  onRenomear: (nome: string) => void;
  onStatus: () => void;
  onMover: (d: -1 | 1) => void;
  onRemover: () => void;
}

/** Ícone da coluna pelo nome (a ordem importa: "A Fazer · Aguardando" é espera; "Pré-fechamento" não é concluído). */
const ICONES_COLUNA: [RegExp, LucideIcon][] = [
  [/aguard|pend[êe]ncia|espera/i, Hourglass],
  [/pr[ée]-?fechamento|valida[çc]|homolog|revis/i, ClipboardCheck],
  [/reabert/i, RotateCcw],
  [/cancel/i, CircleX],
  [/conclu|fechad|resolvid|finaliz|encerrad/i, CircleCheckBig],
  [/atendimento|andamento|execu[çc]|fazendo/i, Headset],
  [/fazer|novo|entrada|backlog|triagem/i, Inbox],
];

export function iconeDaColuna(nome: string): LucideIcon {
  return ICONES_COLUNA.find(([re]) => re.test(nome))?.[1] ?? Columns3;
}

/** Cabeçalho da coluna: nome (vira campo ao renomear), contador e menu ⋯. */
export function TituloColuna({ coluna, total, editavel, primeira, ultima, salvando, onRenomear, onStatus, onMover, onRemover }: TituloProps) {
  const [editando, setEditando] = useState(false);
  const [nome, setNome] = useState(coluna.nome);
  const [remover, setRemover] = useState(false);

  const abrir = () => {
    setNome(coluna.nome);
    setEditando(true);
  };
  const salvar = () => {
    const n = nome.trim();
    setEditando(false);
    if (n && n !== coluna.nome) onRenomear(n.slice(0, 40));
  };
  const Icone = iconeDaColuna(coluna.nome);
  const tecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") salvar();
    if (e.key === "Escape") setEditando(false);
  };

  if (editando) {
    return (
      <div className="ch-col__head ch-col__head--edit" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="ch-col__nome"
          autoFocus
          maxLength={40}
          value={nome}
          aria-label="Nome da coluna"
          onChange={(e) => setNome(e.target.value)}
          onKeyDown={tecla}
          onBlur={salvar}
        />
        <button type="button" className="ch-col__btn" aria-label="Salvar nome" onMouseDown={(e) => e.preventDefault()} onClick={salvar}>
          <Check size={15} aria-hidden="true" />
        </button>
        <button type="button" className="ch-col__btn" aria-label="Cancelar" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditando(false)}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="ch-col__head">
      {/* Nome numa linha só (reticências se faltar espaço; o nome inteiro aparece ao passar o mouse).
          Renomear fica no menu ⋯ e no duplo clique, para sobrar espaço ao nome. */}
      <span className="ch-col__titulo" title={coluna.nome} onDoubleClick={editavel ? abrir : undefined}>
        <Icone size={15} className="ch-col__icone" aria-hidden="true" />
        <span className="ch-col__texto">{coluna.nome}</span>
      </span>
      <span className="ch-col__count">{total}</span>
      {editavel && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="ch-col__btn" aria-label={`Mais opções da coluna ${coluna.nome}`} disabled={salvando}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu">
              <DropdownMenu.Item className="menu__item" onSelect={abrir}>
                <Pencil size={15} aria-hidden="true" />
                Renomear
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu__item" onSelect={onStatus}>
                <ListChecks size={15} aria-hidden="true" />
                Escolher status…
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu__item" disabled={primeira} onSelect={() => onMover(-1)}>
                <ArrowLeft size={15} aria-hidden="true" />
                Mover para a esquerda
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu__item" disabled={ultima} onSelect={() => onMover(1)}>
                <ArrowRight size={15} aria-hidden="true" />
                Mover para a direita
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu__separator" />
              {/* O Kanban precisa de ao menos uma coluna (o banco também confere). */}
              <DropdownMenu.Item className="menu__item menu__item--danger" disabled={primeira && ultima} onSelect={() => setRemover(true)}>
                <Trash2 size={15} aria-hidden="true" />
                Remover coluna…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <ConfirmDialog
        open={remover}
        onOpenChange={setRemover}
        title={`Remover a coluna "${coluna.nome}"?`}
        description={
          total > 0
            ? `Os status dela ficam sem coluna e os ${total} tickets saem do quadro desta visão. Os tickets não mudam de status.`
            : "Os status dela ficam sem coluna. Os tickets não mudam de status."
        }
        confirmLabel="Remover coluna"
        tone="danger"
        isPending={false}
        onConfirm={() => {
          setRemover(false);
          onRemover();
        }}
      />
    </div>
  );
}

/** Botão tracejado no fim do quadro. */
export function NovaColunaBotao({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" className="ch-col-nova" onClick={onClick} disabled={disabled}>
      <Plus size={16} aria-hidden="true" />
      Coluna
    </button>
  );
}

interface DialogoProps {
  /** null = coluna nova. */
  coluna: ColunaKanban | null;
  colunas: ColunaKanban[];
  status: StatusTicket[];
  salvando: boolean;
  onFechar: () => void;
  onSalvar: (colunas: ColunaKanban[], mensagem: string) => void;
}

/** Nova coluna (nome, status e posição) ou "Escolher status…" de uma coluna existente. */
export function DialogoColuna({ coluna, colunas, status, salvando, onFechar, onSalvar }: DialogoProps) {
  const ids = useId();
  const nova = coluna === null;
  const [nome, setNome] = useState(coluna?.nome ?? "");
  const [marcados, setMarcados] = useState<Set<string>>(() => new Set((coluna?.status ?? []).map(refKey)));
  const [depoisDe, setDepoisDe] = useState<string>(colunas[colunas.length - 1]?.id ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const itens = itensDeStatus(status);
  const dono = (r: StatusRef) => colunas.find((c) => c.id !== coluna?.id && c.status.some((x) => refKey(x) === refKey(r)));

  const alternar = (k: string) =>
    setMarcados((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const n = nome.trim();
    if (!n) {
      setErro("Informe o nome da coluna.");
      return;
    }
    const escolhidos = itens.filter((r) => marcados.has(refKey(r)));
    // Um status só fica numa coluna: o marcado aqui sai da outra.
    const sem = colunas.map((c) => (c.id === coluna?.id ? c : { ...c, status: c.status.filter((r) => !marcados.has(refKey(r))) }));
    if (nova) {
      const col: ColunaKanban = { id: novaColunaId(), nome: n.slice(0, 40), status: escolhidos };
      const i = sem.findIndex((c) => c.id === depoisDe);
      const lista = i < 0 ? [col, ...sem] : [...sem.slice(0, i + 1), col, ...sem.slice(i + 1)];
      onSalvar(lista, `Coluna "${col.nome}" criada.`);
    } else {
      onSalvar(
        sem.map((c) => (c.id === coluna.id ? { ...c, nome: n.slice(0, 40), status: escolhidos } : c)),
        `Coluna "${n}" atualizada.`,
      );
    }
  };

  return (
    <DetailDialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={nova ? "Nova coluna" : `Status da coluna "${coluna.nome}"`}
      description="Uma coluna do Kanban junta os tickets pelos status. Escolha o nome e quais status entram nela."
      closeLabel="Cancelar"
    >
      <form className="ch-coldlg" onSubmit={enviar}>
        <label className="field">
          <span className="field__label">Nome da coluna</span>
          <input id={`${ids}-n`} className="input" autoFocus maxLength={40} value={nome} onChange={(e) => { setNome(e.target.value); setErro(null); }} aria-invalid={erro ? true : undefined} />
          {erro && <span className="field__error">{erro}</span>}
        </label>
        <fieldset className="ch-coldlg__status">
          <legend className="field__label">Status desta coluna</legend>
          <div className="ch-coldlg__lista">
            {itens.map((r) => {
              const k = refKey(r);
              const outra = dono(r);
              return (
                <label key={k} className="ch-check ch-coldlg__item">
                  <input type="checkbox" checked={marcados.has(k)} onChange={() => alternar(k)} />
                  <span>{rotuloItem(r, status)}</span>
                  <small className={outra && marcados.has(k) ? "ch-badge ch-badge--warning" : "ch-muted"}>
                    {outra ? (marcados.has(k) ? `sai de "${outra.nome}"` : `em "${outra.nome}"`) : "sem coluna"}
                  </small>
                </label>
              );
            })}
          </div>
        </fieldset>
        {nova && colunas.length > 0 && (
          <label className="field">
            <span className="field__label">Posição</span>
            <select className="input" value={depoisDe} onChange={(e) => setDepoisDe(e.target.value)}>
              <option value="">No começo do quadro</option>
              {colunas.map((c) => (
                <option key={c.id} value={c.id}>
                  Depois de "{c.nome}"
                </option>
              ))}
            </select>
          </label>
        )}
        {marcados.size === 0 && <p className="ch-hint">Sem status, a coluna fica vazia: nenhum ticket aparece nela e não dá para soltar cartões.</p>}
        <div className="ch-coldlg__acoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary" disabled={salvando}>
            {salvando ? "Salvando…" : nova ? "Criar coluna" : "Salvar"}
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}
