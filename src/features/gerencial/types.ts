import type { CategoriaStatus } from "../chamados/status/types";

// Gestão de Chamados › Gerencial (docs/PLANO-gerencial.md). Mesmo formato da RPC ch_gerencial (camelCase).
// Toda a conta (KPIs, séries, projeções, alertas, insights) é feita no front, em calculos.ts, a partir
// destas linhas enxutas: um único carregamento serve às dez telas e aos filtros.

export type OrigemTicket = "email" | "whatsapp" | "intranet" | "agente";

export interface TicketGerencial {
  id: number;
  assunto: string;
  criadoEm: string;
  assumidoEm: string | null;
  primeiraRespostaEm: string | null;
  encerradoEm: string | null;
  slaRespostaAte: string | null;
  slaSolucaoAte: string | null;
  slaManual: boolean;
  slaPausadoDesde: string | null;
  ultimaAcaoEm: string | null;
  status: string;
  categoriaStatus: CategoriaStatus;
  setor: string | null;
  equipe: string | null;
  servico: string | null;
  categoria: string | null;
  urgencia: string | null;
  origem: OrigemTicket;
  responsavelId: string | null;
  responsavel: string | null;
  solicitante: string;
  departamento: string | null;
  reaberturas: number;
  acoesPublicas: number;
  ia: "aplicado" | "sugerido" | "baixa_confianca" | "erro" | null;
}

/** Metas e limites (tabela ch_gerencial_metas). As chaves são fixas; os valores, editáveis por Admin. */
export interface Metas {
  sla_solucao_pct: number;
  sla_resposta_pct: number;
  tmr_horas: number;
  tpr_horas: number;
  reabertura_pct_max: number;
  backlog_max: number;
  vencidos_max: number;
  sem_responsavel_max: number;
  parado_dias: number;
  crescimento_alerta_pct: number;
}

export const METAS_PADRAO: Metas = {
  sla_solucao_pct: 85,
  sla_resposta_pct: 90,
  tmr_horas: 24,
  tpr_horas: 4,
  reabertura_pct_max: 5,
  backlog_max: 50,
  vencidos_max: 5,
  sem_responsavel_max: 5,
  parado_dias: 7,
  crescimento_alerta_pct: 20,
};

export const METAS_ROTULOS: Record<keyof Metas, { label: string; unidade: string; descricao: string }> = {
  sla_solucao_pct: { label: "SLA de solução", unidade: "%", descricao: "Meta mínima de tickets resolvidos no prazo." },
  sla_resposta_pct: { label: "SLA de 1ª resposta", unidade: "%", descricao: "Meta mínima de tickets respondidos no prazo." },
  tmr_horas: { label: "Tempo médio de resolução", unidade: "h", descricao: "Máximo aceitável, em horas corridas." },
  tpr_horas: { label: "Tempo médio de 1ª resposta", unidade: "h", descricao: "Máximo aceitável, em horas corridas." },
  reabertura_pct_max: { label: "Reabertura", unidade: "%", descricao: "Máximo de tickets reabertos depois de resolvidos." },
  backlog_max: { label: "Backlog", unidade: "tickets", descricao: "Máximo de tickets abertos ao mesmo tempo." },
  vencidos_max: { label: "SLA vencido", unidade: "tickets", descricao: "Máximo de tickets abertos com prazo vencido." },
  sem_responsavel_max: { label: "Sem responsável", unidade: "tickets", descricao: "Máximo de tickets abertos sem ninguém." },
  parado_dias: { label: "Ticket parado", unidade: "dias", descricao: "Dias sem ação para considerar o ticket parado." },
  crescimento_alerta_pct: { label: "Crescimento das entradas", unidade: "%", descricao: "Alerta quando as entradas crescem mais que isto." },
};

export interface GerencialPayload {
  generated_at: string;
  /** Início da janela carregada (1º dia do mês, N meses atrás). */
  inicio: string;
  metas: Partial<Metas>;
  tickets: TicketGerencial[];
}

export type Dimensao = "setor" | "equipe" | "servico" | "categoria" | "urgencia" | "origem" | "responsavel" | "departamento" | "mes";

export const DIMENSOES: Record<Dimensao, string> = {
  setor: "Setor",
  equipe: "Equipe",
  servico: "Serviço",
  categoria: "Categoria",
  urgencia: "Urgência",
  origem: "Canal",
  responsavel: "Responsável",
  departamento: "Departamento solicitante",
  mes: "Mês",
};

export const ORIGEM_ROTULO: Record<OrigemTicket, string> = { email: "E-mail", whatsapp: "WhatsApp", intranet: "Intranet", agente: "Agente" };

/** Recorte aplicado a todas as telas (fica na URL: ?de=&ate=&setor=&equipe=&origem=). */
export interface Filtros {
  /** Primeiro dia do período (ISO yyyy-mm-dd, no fuso de São Paulo). */
  de: string;
  /** Último dia do período (inclusivo). */
  ate: string;
  setor: string;
  equipe: string;
  origem: OrigemTicket | "";
}

export type Semaforo = "verde" | "amarelo" | "vermelho" | "cinza";

export interface Kpis {
  entradas: number;
  resolvidos: number;
  cancelados: number;
  /** Abertos no fim do período (ou agora, quando o período inclui hoje). */
  backlog: number;
  vencidos: number;
  semResponsavel: number;
  parados: number;
  /** % dos resolvidos no período dentro do prazo de solução (null sem prazo). */
  slaSolucaoPct: number | null;
  slaRespostaPct: number | null;
  /** Horas corridas, média. */
  tmrHoras: number | null;
  tprHoras: number | null;
  reaberturaPct: number | null;
  /** Resolvidos ÷ entradas, em %. */
  taxaResolucaoPct: number | null;
  /** Dias do ticket aberto mais antigo. */
  maisAntigoDias: number | null;
  /** % das entradas classificadas pela IA automaticamente. */
  iaAutomaticaPct: number | null;
  /** Média de interações públicas por ticket resolvido (esforço). */
  esforcoMedio: number | null;
}

export interface Grupo {
  chave: string;
  entradas: number;
  resolvidos: number;
  backlog: number;
  vencidos: number;
  semResponsavel: number;
  slaSolucaoPct: number | null;
  tmrHoras: number | null;
}

export interface PontoDiario {
  dia: string;
  entradas: number;
  resolvidos: number;
  backlog: number;
}

export interface PontoMensal {
  mes: string;
  rotulo: string;
  entradas: number;
  resolvidos: number;
  backlogFim: number;
  slaSolucaoPct: number | null;
  tmrHoras: number | null;
}

export interface Alerta {
  id: string;
  nivel: "critico" | "atencao" | "ok";
  titulo: string;
  texto: string;
  valor: number;
  limite: number;
  unidade: string;
}

export interface Insight {
  tipo: "anomalia" | "tendencia" | "risco" | "oportunidade";
  titulo: string;
  texto: string;
  evidencia: string;
}

export interface Projecao {
  /** Dias projetados: data, entradas previstas, resolvidos previstos (capacidade) e backlog projetado. */
  dias: { dia: string; entradas: number; resolvidos: number; backlog: number }[];
  entradasPorDia: number;
  capacidadePorDia: number;
  tendenciaPorDia: number;
  backlogFinal: number;
  /** Dias até zerar o backlog com a capacidade atual (null se não zera). */
  diasParaZerar: number | null;
  confiabilidade: "baixa" | "media" | "alta";
}

export interface RecomendacaoIa {
  titulo: string;
  causaProvavel: string;
  previsao: string;
  recomendacao: string;
  prioridade: "alta" | "media" | "baixa";
}
