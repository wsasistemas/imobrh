import * as Popover from "@radix-ui/react-popover";
import {
  AlarmClock,
  AtSign,
  Building,
  Building2,
  CalendarCheck,
  CalendarPlus,
  CalendarSync,
  CircleCheckBig,
  CircleDot,
  Contact,
  Flag,
  FolderTree,
  HardHat,
  Inbox,
  ListFilter,
  ListPlus,
  MessageSquareReply,
  Search,
  Tags,
  Ticket,
  Timer,
  User,
  UserCheck,
  UserPen,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { ehCampoAdicional } from "../visoes/campos";
import type { ColunaLista, ColunaPadrao } from "../visoes/types";

// Cabeçalho da Lista de tickets: ícone de cada campo e o filtro de múltipla escolha (estilo planilha).
// O filtro vale só nesta tela, não é salvo na visão.

/** Coluna fixa do nº/assunto + as colunas configuráveis da visão. */
export type ColunaFiltro = "ticket" | ColunaLista;

const ICONES: Record<ColunaPadrao, LucideIcon> = {
  solicitante: User,
  status: CircleDot,
  responsavel: UserCheck,
  sla: Timer,
  origem: Inbox,
  servico: Wrench,
  equipe: Users,
  prioridade: Flag,
  criado: CalendarPlus,
  tags: Tags,
  recebido_em: AtSign,
  categoria: FolderTree,
  setor: Building2,
  contato: Contact,
  criado_por: UserPen,
  atualizado: CalendarSync,
  primeira_resposta: MessageSquareReply,
  prazo_resposta: AlarmClock,
  prazo_solucao: CalendarCheck,
  encerrado: CircleCheckBig,
  empreendimento: HardHat,
  setor_solicitante: Building,
};

export function iconeColuna(c: ColunaFiltro): LucideIcon {
  if (c === "ticket") return Ticket;
  if (ehCampoAdicional(c)) return ListPlus;
  return ICONES[c] ?? ListPlus;
}

/** Rótulo usado para tickets sem valor na coluna. */
export const VAZIO = "(Vazio)";

export interface OpcaoFiltro {
  valor: string;
  qtd: number;
}

interface FiltroColunaProps {
  rotulo: string;
  opcoes: OpcaoFiltro[];
  /** Valores marcados; vazio = sem filtro nesta coluna. */
  selecionados: ReadonlySet<string>;
  onChange: (selecionados: Set<string>) => void;
}

export function FiltroColuna({ rotulo, opcoes, selecionados, onChange }: FiltroColunaProps) {
  const [busca, setBusca] = useState("");
  const id = useId();
  const ativo = selecionados.size > 0;
  const q = busca.trim().toLowerCase();
  const visiveis = q ? opcoes.filter((o) => o.valor.toLowerCase().includes(q)) : opcoes;
  const todasVisiveisMarcadas = visiveis.length > 0 && visiveis.every((o) => selecionados.has(o.valor));

  const alternar = (valor: string) => {
    const novo = new Set(selecionados);
    if (novo.has(valor)) novo.delete(valor);
    else novo.add(valor);
    onChange(novo);
  };

  const alternarVisiveis = () => {
    const novo = new Set(selecionados);
    for (const o of visiveis) {
      if (todasVisiveisMarcadas) novo.delete(o.valor);
      else novo.add(o.valor);
    }
    onChange(novo);
  };

  return (
    <Popover.Root onOpenChange={(o) => !o && setBusca("")}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`ch-th-filtro${ativo ? " ch-th-filtro--ativo" : ""}`}
          aria-label={ativo ? `Filtrar ${rotulo} (${selecionados.size} selecionados)` : `Filtrar ${rotulo}`}
          title={ativo ? `${selecionados.size} selecionado(s)` : "Filtrar"}
        >
          <ListFilter size={13} aria-hidden="true" />
          {ativo && <span className="ch-th-filtro__qtd">{selecionados.size}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="ch-filtropop" align="start" sideOffset={6} collisionPadding={12} aria-label={`Filtrar ${rotulo}`}>
          <div className="ch-filtropop__head">
            <strong>{rotulo}</strong>
            <span className="ch-hint">Marque um ou mais valores</span>
          </div>

          {opcoes.length > 6 && (
            <label className="ch-filtropop__busca">
              <Search size={14} aria-hidden="true" />
              <input type="search" placeholder="Buscar valor..." aria-label={`Buscar valor de ${rotulo}`} value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus />
            </label>
          )}

          {visiveis.length === 0 ? (
            <p className="ch-filtropop__vazio">Nenhum valor encontrado.</p>
          ) : (
            <ul className="ch-filtropop__lista" role="list">
              <li>
                <label className="ch-filtropop__opcao ch-filtropop__opcao--todos">
                  <input type="checkbox" checked={todasVisiveisMarcadas} onChange={alternarVisiveis} />
                  <span>{q ? "Marcar resultados" : "Marcar todos"}</span>
                </label>
              </li>
              {visiveis.map((o, i) => (
                <li key={o.valor}>
                  <label className="ch-filtropop__opcao" htmlFor={`${id}-${i}`}>
                    <input id={`${id}-${i}`} type="checkbox" checked={selecionados.has(o.valor)} onChange={() => alternar(o.valor)} />
                    <span className={o.valor === VAZIO ? "ch-vazio" : undefined}>{o.valor}</span>
                    <small>{o.qtd}</small>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="ch-filtropop__rod">
            <span className="ch-hint">{ativo ? `${selecionados.size} selecionado(s)` : "Sem filtro"}</span>
            <button type="button" className="btn btn--outline" disabled={!ativo} onClick={() => onChange(new Set())}>
              Limpar
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
