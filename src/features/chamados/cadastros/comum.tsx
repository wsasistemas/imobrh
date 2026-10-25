import { ArrowDown, ArrowUp } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { useCadastros, useOrdenarCadastro } from "../hooks";
import type { TabelaOrdenavel } from "./service";
import type { Cadastros } from "./types";
import "../pages/Chamados.css";
import "./Cadastros.css";

/** Carrega os cadastros e entrega prontos (esqueleto e erro no meio). */
export function ComCadastros({ children }: { children: (c: Cadastros) => ReactNode }) {
  const q = useCadastros();
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar os cadastros." onRetry={() => void q.refetch()} />;
  return <>{children(q.data)}</>;
}

export function Situacao({ ativo, feminino = false }: { ativo: boolean; feminino?: boolean }) {
  return <span className={`ch-badge${ativo ? " ch-badge--success" : ""}`}>{ativo ? (feminino ? "Ativa" : "Ativo") : feminino ? "Inativa" : "Inativo"}</span>;
}

/** Subir/descer um item da lista (reordena e grava). */
export function OrdemBotoes({ tabela, ids, index, nome }: { tabela: TabelaOrdenavel; ids: number[]; index: number; nome: string }) {
  const ordenar = useOrdenarCadastro();
  const mover = (delta: number) => {
    const nova = [...ids];
    [nova[index], nova[index + delta]] = [nova[index + delta], nova[index]];
    ordenar.mutate({ tabela, ids: nova }, { onError: (e) => toast.error(mensagem(e, "Não foi possível reordenar.")) });
  };
  return (
    <span className="cad-ordem" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn" aria-label={`Subir ${nome}`} disabled={index === 0 || ordenar.isPending} onClick={() => mover(-1)}>
        <ArrowUp size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn" aria-label={`Descer ${nome}`} disabled={index === ids.length - 1 || ordenar.isPending} onClick={() => mover(1)}>
        <ArrowDown size={15} aria-hidden="true" />
      </button>
    </span>
  );
}

export function mensagem(e: unknown, padrao: string): string {
  return e instanceof ServiceError ? e.message : padrao;
}

/** Linha clicável e acessível por teclado (Enter/Espaço abre no editor). */
export function linhaProps(selecionada: boolean, abrir: () => void) {
  return {
    tabIndex: 0,
    "aria-selected": selecionada,
    onClick: abrir,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        abrir();
      }
    },
  };
}

export function Rodape({ salvando, onCancelar, erro }: { salvando: boolean; onCancelar: () => void; erro: string | null }) {
  return (
    <>
      {erro && (
        <p className="cad-erro" role="alert">
          {erro}
        </p>
      )}
      <div className="cad-acoes">
        <button type="button" className="btn btn--outline" onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </>
  );
}
