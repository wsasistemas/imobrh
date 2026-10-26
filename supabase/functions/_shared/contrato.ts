// Contrato da API do ImobRH (rotas /rh/*), compartilhado entre as Edge Functions (Deno), o Console do RH e o app do
// imobdesk. Fonte única: o pacote packages/shared reexporta este arquivo (o deploy das Edge Functions só sobe o que
// está dentro de supabase/functions). Só TypeScript puro: sem Deno.*, node:* nem dependências.

/** Códigos de erro estáveis: o app traduz cada um numa mensagem. */
export const CODIGOS_ERRO = [
  "VALIDACAO",
  "SEM_PERMISSAO",
  "RM_INDISPONIVEL",
  "ESTADO_INVALIDO",
  // Fora da regra de negócio: sessão ausente/expirada e falha inesperada.
  "NAO_AUTENTICADO",
  "INTERNO",
] as const;

export type CodigoErro = (typeof CODIGOS_ERRO)[number];

export interface ErroApi {
  code: CodigoErro;
  message: string;
  /** Erro por campo do formulário: nome do campo → mensagem. */
  fields?: Record<string, string>;
}

/** Toda resposta da API: { data, error }. Exatamente um dos dois vem preenchido. */
export type RespostaApi<T> = { data: T; error: null } | { data: null; error: ErroApi };

export function isCodigoErro(valor: unknown): valor is CodigoErro {
  return typeof valor === "string" && (CODIGOS_ERRO as readonly string[]).includes(valor);
}

/** Status HTTP de cada código. */
export const STATUS_DO_ERRO: Record<CodigoErro, number> = {
  VALIDACAO: 400,
  SEM_PERMISSAO: 403,
  RM_INDISPONIVEL: 503,
  ESTADO_INVALIDO: 409,
  NAO_AUTENTICADO: 401,
  INTERNO: 500,
};

/** Os 8 papéis do PRD v2. */
export const PAPEIS = ["admin", "rh_dp", "rh_dp_restrita", "recrutamento", "compliance", "diretoria", "gestor", "colaborador"] as const;
export type Papel = (typeof PAPEIS)[number];

/** Papéis que usam o Console do RH (os outros usam o app do imobdesk). */
export const PAPEIS_CONSOLE: readonly Papel[] = ["admin", "rh_dp", "rh_dp_restrita", "recrutamento", "compliance"];

export const ROTULO_PAPEL: Record<Papel, string> = {
  admin: "Administrador",
  rh_dp: "RH / Departamento Pessoal",
  rh_dp_restrita: "DP restrita",
  recrutamento: "Recrutamento",
  compliance: "Comitê de compliance",
  diretoria: "Diretoria",
  gestor: "Gestor",
  colaborador: "Colaborador",
};

/** Itens do menu RH do app do imobdesk, decididos pelo backend (app_imobrh.menu_app). */
export const ITENS_MENU_APP = [
  "rh_novo_pedido",
  "rh_meus_pedidos",
  "rh_aprovacoes",
  "rh_requisicao_pessoal",
  "rh_canal_confidencial",
  "rh_console",
] as const;
export type ItemMenuApp = (typeof ITENS_MENU_APP)[number];

export type ModoRm = "mock" | "real";

export type StatusVinculo = "vinculado" | "pendente" | "divergente";

/** Vínculo do login com o funcionário do TOTVS RM. */
export interface VinculoRm {
  status: StatusVinculo;
  coligada: number | null;
  chapa: string | null;
  nome: string | null;
  situacao: string | null;
  secao: { codigo: string | null; nome: string | null };
  funcao: string | null;
  gestorChapa: string | null;
  /** Dado de demonstração (RM_MODO=mock). */
  mock: boolean;
}

/** GET /rh/me */
export interface RhMe {
  usuario: { id: string; email: string; nome: string };
  vinculo: VinculoRm | null;
  papeis: Papel[];
  menu: ItemMenuApp[];
  modoRm: ModoRm;
}

/** Linha da Consulta SQL API.RH.FUNCIONARIO (campos em docs/consultas-rm.md). */
export interface RmFuncionario {
  CODCOLIGADA: number;
  CHAPA: string;
  NOME: string;
  CPF: string;
  EMAIL: string | null;
  CODSITUACAO: string;
  SITUACAO: string;
  CODSECAO: string;
  SECAO: string;
  CODFUNCAO: string;
  FUNCAO: string;
  DATAADMISSAO: string;
  CHAPA_GESTOR: string | null;
}

/** Linha da Consulta SQL API.RH.HIERARQUIA. */
export interface RmHierarquia {
  CODCOLIGADA: number;
  CODSECAO: string;
  SECAO: string;
  CODSECAO_PAI: string | null;
  CHAPA_CHEFE: string | null;
  NOME_CHEFE: string | null;
}

/**
 * Estados de um caso: os mesmos para todos os serviços (PRD v1, "Console do RH"); o que muda entre serviços são as
 * etapas dentro de "em_andamento". Rótulo único, usado no Console e no app. A cor fica no front (components/ds/estados).
 * Confirmar a lista na Fase 2, com o motor de processos.
 */
export const ESTADOS_CASO = {
  aberto: "Aberto",
  em_andamento: "Em andamento",
  aguardando_colaborador: "Aguardando colaborador",
  aguardando_terceiro: "Aguardando terceiro",
  concluido: "Concluído",
  cancelado: "Cancelado",
} as const;
export type EstadoCaso = keyof typeof ESTADOS_CASO;

/** Estados de uma etapa do caso (caso_etapa). */
export const ESTADOS_ETAPA = {
  bloqueada: "Aguardando etapa anterior",
  aberta: "A fazer",
  em_andamento: "Em andamento",
  concluida: "Concluída",
  atrasada: "Atrasada",
  erro_rm: "Erro no RM",
} as const;
export type EstadoEtapa = keyof typeof ESTADOS_ETAPA;
