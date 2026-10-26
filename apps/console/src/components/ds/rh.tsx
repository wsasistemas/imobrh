import type { EstadoCaso, EstadoEtapa } from "@imobrh/shared";
import { AlertTriangle, Bot, Check, Database, Lock, Server, User } from "lucide-react";
import { estadoCaso, estadoEtapa, prazoRelativo } from "./estados";
import { Panel, PanelHeader } from "./Panel";
import { Pill } from "./Pill";
import "./rh.css";

// Componentes do Console do RH que o imobdesk não tinha (docs/design-system.md, seção "Componentes do RH").
// Mesmo estilo do design system: só tokens --ds-*, estado sempre com texto (nunca só a cor), alvos de 44px.

/** Selo do estado do caso (mapa único em estados.ts). */
export function EstadoCasoBadge({ estado }: { estado: EstadoCaso }) {
  const { rotulo, tom } = estadoCaso(estado);
  return <Pill tone={tom}>{rotulo}</Pill>;
}

/** Selo do estado da etapa (mapa único em estados.ts). */
export function EstadoEtapaBadge({ estado }: { estado: EstadoEtapa }) {
  const { rotulo, tom } = estadoEtapa(estado);
  return <Pill tone={tom}>{rotulo}</Pill>;
}

export interface EtapaStepper {
  id: string;
  nome: string;
  responsavel: string;
  estado: EstadoEtapa;
  /** ISO; null quando a etapa não tem prazo (ex.: "Na triagem"). */
  venceEm: string | null;
  /** Prazo da CLT/eSocial: aparece com a base legal. */
  baseLegal?: string;
}

/**
 * Stepper vertical das etapas do caso (coluna esquerda da tela do caso). A etapa atual fica destacada; as que
 * dependem de outra aparecem com cadeado. Navegável por teclado: cada etapa é um botão quando `onSelect` existe.
 */
export function StepperEtapas({ etapas, atual, onSelect }: { etapas: EtapaStepper[]; atual?: string; onSelect?: (id: string) => void }) {
  return (
    <ol className="rh-stepper" aria-label="Etapas do processo">
      {etapas.map((etapa, indice) => {
        const marcador =
          etapa.estado === "concluida" ? <Check size={14} aria-hidden="true" /> : etapa.estado === "bloqueada" ? <Lock size={12} aria-hidden="true" /> : etapa.estado === "erro_rm" || etapa.estado === "atrasada" ? <AlertTriangle size={13} aria-hidden="true" /> : indice + 1;
        const prazo = etapa.venceEm && etapa.estado !== "concluida" ? prazoRelativo(etapa.venceEm) : null;
        const conteudo = (
          <>
            <span className={`rh-stepper__marca rh-stepper__marca--${etapa.estado}`}>{marcador}</span>
            <span className="rh-stepper__texto">
              <strong>{etapa.nome}</strong>
              <small>{etapa.responsavel}</small>
              <span className="rh-stepper__meta">
                <EstadoEtapaBadge estado={etapa.estado} />
                {prazo && <Pill tone={prazo.tom}>{prazo.texto}</Pill>}
              </span>
            </span>
          </>
        );
        return (
          <li key={etapa.id} className={`rh-stepper__item${etapa.id === atual ? " rh-stepper__item--atual" : ""}`} aria-current={etapa.id === atual ? "step" : undefined}>
            {onSelect ? (
              <button type="button" className="rh-stepper__botao" onClick={() => onSelect(etapa.id)}>
                {conteudo}
              </button>
            ) : (
              <div className="rh-stepper__botao">{conteudo}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export type AtorEvento = "pessoa" | "sistema" | "rm" | "ia";

export interface EventoTimeline {
  id: string;
  em: string;
  ator: AtorEvento;
  autor: string;
  texto: string;
  /** caso_evento.visivel_colaborador: aparece também na timeline do app. */
  visivelColaborador: boolean;
}

const ICONE_ATOR = { pessoa: User, sistema: Server, rm: Database, ia: Bot } as const;
const ROTULO_ATOR: Record<AtorEvento, string> = { pessoa: "Pessoa", sistema: "Sistema", rm: "TOTVS RM", ia: "IA" };

/** Timeline do caso (caso_evento, só INSERT). Cada evento diz se o colaborador vê ou se é nota interna. */
export function TimelineCaso({ eventos }: { eventos: EventoTimeline[] }) {
  const dataHora = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return (
    <ol className="rh-timeline" aria-label="Linha do tempo do caso">
      {eventos.map((evento) => {
        const Icone = ICONE_ATOR[evento.ator];
        return (
          <li key={evento.id} className="rh-timeline__item">
            <span className={`rh-timeline__icone rh-timeline__icone--${evento.ator}`} aria-hidden="true">
              <Icone size={14} />
            </span>
            <div className="rh-timeline__corpo">
              <div className="rh-timeline__topo">
                <strong>{evento.autor}</strong>
                <span className="ds-small">{ROTULO_ATOR[evento.ator]}</span>
                <time dateTime={evento.em} className="ds-small">
                  {dataHora.format(new Date(evento.em))}
                </time>
                <Pill tone={evento.visivelColaborador ? "green" : "neutral"}>{evento.visivelColaborador ? "Visível ao colaborador" : "Nota interna"}</Pill>
              </div>
              <p>{evento.texto}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface PrazoLegal {
  id: string;
  etapa: string;
  colaborador: string;
  baseLegal: string;
  venceEm: string;
}

/** Painel de prazos legais (coluna direita do caso e tela /prazos): ordenado pelo vencimento, vencidos primeiro. */
export function PainelPrazos({ prazos, titulo = "Prazos legais" }: { prazos: PrazoLegal[]; titulo?: string }) {
  const ordenados = [...prazos].sort((a, b) => a.venceEm.localeCompare(b.venceEm));
  const vencidos = ordenados.filter((p) => prazoRelativo(p.venceEm).dias < 0).length;
  return (
    <Panel aria-labelledby="rh-prazos-titulo">
      <PanelHeader
        title={titulo}
        titleId="rh-prazos-titulo"
        subtitle="CLT e eSocial: vencidos primeiro, depois o mais próximo."
        aside={vencidos > 0 ? <Pill tone="red">{vencidos} vencido{vencidos === 1 ? "" : "s"}</Pill> : <Pill tone="green">Em dia</Pill>}
      />
      <ul className="rh-prazos">
        {ordenados.map((prazo) => {
          const relativo = prazoRelativo(prazo.venceEm);
          return (
            <li key={prazo.id} className="rh-prazos__item">
              <div>
                <strong>{prazo.etapa}</strong>
                <small>
                  {prazo.colaborador} · {prazo.baseLegal}
                </small>
              </div>
              <Pill tone={relativo.tom}>{relativo.texto}</Pill>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
