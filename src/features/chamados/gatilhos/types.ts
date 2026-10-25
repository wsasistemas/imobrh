// Administração › Gatilhos (docs/PLANO-gatilhos.md). Mesmo formato de ch_gatilhos_lista / ch_gatilho_salvar
// (migration 20261007210000).

export type TipoDisparo = "criado" | "alterado" | "status" | "acao_solicitante" | "acao_agente" | "tempo_status" | "sla_vence" | "sla_vencido";

export interface Disparo {
  tipo: TipoDisparo;
  /** Só em tempo_status (horas úteis) e sla_vence (horas). */
  horas?: number;
}

export type CampoGatilho =
  | "status"
  | "urgencia"
  | "categoria"
  | "servico"
  | "equipe"
  | "responsavel"
  | "setor"
  | "origem"
  | "tags"
  | "texto"
  | "horario"
  | "autor"
  | `campo:${string}`;

export type OperadorGatilho = "um_de" | "nao_um_de" | "preenchido" | "vazio" | "contem" | "nao_contem";

export interface CondicaoGatilho {
  campo: CampoGatilho;
  operador: OperadorGatilho;
  valores: string[];
}

export type TipoAcao =
  | "status"
  | "equipe"
  | "responsavel"
  | "urgencia"
  | "categoria"
  | "servico"
  | "tags_adicionar"
  | "tags_remover"
  | "campo"
  | "solucao"
  | "nota_interna"
  | "responder_macro"
  | "seguidor"
  | "avisar";

/** Uma ação e o valor dela (só os campos do tipo são usados). */
export interface AcaoGatilho {
  tipo: TipoAcao;
  statusId?: number;
  justificativaId?: number | null;
  equipeId?: number | null;
  urgenciaId?: number;
  categoriaId?: number | null;
  servicoId?: number | null;
  /** responsavel: pessoa | lider | ninguem · seguidor: responsavel | lider | pessoa */
  modo?: string;
  usuarioId?: string | null;
  tags?: string[];
  chave?: string;
  valor?: unknown;
  texto?: string;
  macroId?: number;
  /** avisar: responsavel | lider | seguidores | equipe | pessoa */
  quem?: string;
}

export interface Gatilho {
  id: number;
  nome: string;
  para: "tickets";
  disparos: Disparo[];
  todas: CondicaoGatilho[];
  qualquer: CondicaoGatilho[];
  acoes: AcaoGatilho[];
  /** evento = uma vez por evento; ticket = uma vez por ticket. */
  execucao: "evento" | "ticket";
  ordem: number;
  ativo: boolean;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  execucoes7d: number;
  erros7d: number;
}

export type GatilhoSalvar = Pick<Gatilho, "nome" | "disparos" | "todas" | "qualquer" | "acoes" | "execucao" | "ativo"> & { id?: number };

export interface ExecucaoGatilho {
  id: number;
  gatilhoId: number;
  gatilho: string;
  ticketId: number;
  disparo: TipoDisparo;
  resultado: "executado" | "erro";
  detalhe: string | null;
  criadoEm: string;
}

export interface SimulacaoGatilho {
  ticket: { id: number; assunto: string };
  todas: { condicao: CondicaoGatilho; ok: boolean }[];
  qualquer: { condicao: CondicaoGatilho; ok: boolean }[];
  executaria: boolean;
  jaExecutou: boolean;
}

export interface Notificacao {
  id: number;
  ticketId: number | null;
  titulo: string;
  texto: string;
  /** Caminho no portal (ex.: Solicitações Financeiras), quando o aviso não é de ticket. */
  link?: string | null;
  lida: boolean;
  criadoEm: string;
}

export const DISPAROS: { tipo: TipoDisparo; label: string; horas?: "uteis" | "corridas" }[] = [
  { tipo: "criado", label: "Ticket criado" },
  { tipo: "alterado", label: "Ticket alterado" },
  { tipo: "status", label: "Status alterado" },
  { tipo: "acao_solicitante", label: "Ação do solicitante recebida" },
  { tipo: "acao_agente", label: "Ação do agente adicionada" },
  { tipo: "tempo_status", label: "Tempo no status ≥", horas: "uteis" },
  { tipo: "sla_vence", label: "SLA de solução vence em ≤", horas: "corridas" },
  { tipo: "sla_vencido", label: "SLA de solução vencido" },
];

export const OPERADORES: Record<OperadorGatilho, string> = {
  um_de: "é um de",
  nao_um_de: "não é um de",
  preenchido: "está preenchido",
  vazio: "está vazio",
  contem: "contém",
  nao_contem: "não contém",
};

export const ACOES: { tipo: TipoAcao; label: string; grupo: "Mudar o ticket" | "Escrever" | "Avisar" }[] = [
  { tipo: "status", label: "Alterar status", grupo: "Mudar o ticket" },
  { tipo: "equipe", label: "Alterar equipe", grupo: "Mudar o ticket" },
  { tipo: "responsavel", label: "Alterar responsável", grupo: "Mudar o ticket" },
  { tipo: "urgencia", label: "Alterar urgência", grupo: "Mudar o ticket" },
  { tipo: "categoria", label: "Alterar categoria", grupo: "Mudar o ticket" },
  { tipo: "servico", label: "Alterar serviço", grupo: "Mudar o ticket" },
  { tipo: "tags_adicionar", label: "Adicionar tags", grupo: "Mudar o ticket" },
  { tipo: "tags_remover", label: "Remover tags", grupo: "Mudar o ticket" },
  { tipo: "campo", label: "Preencher campo adicional", grupo: "Mudar o ticket" },
  { tipo: "solucao", label: "Preencher solução aplicada (se vazia)", grupo: "Mudar o ticket" },
  { tipo: "nota_interna", label: "Adicionar nota interna", grupo: "Escrever" },
  { tipo: "responder_macro", label: "Responder ao solicitante (macro)", grupo: "Escrever" },
  { tipo: "avisar", label: "Avisar (sino do portal)", grupo: "Avisar" },
  { tipo: "seguidor", label: "Adicionar seguidor", grupo: "Avisar" },
];

export const QUEM_AVISAR: Record<string, string> = {
  responsavel: "Responsável",
  lider: "Líder da equipe",
  seguidores: "Seguidores",
  equipe: "Membros da equipe do ticket",
  pessoa: "Uma pessoa",
};

export const AUTORES: Record<string, string> = { solicitante: "Solicitante", agente: "Agente", sistema: "Sistema (tempo)" };
