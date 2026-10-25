// Centro de Treinamento (docs/PLANO-centro-treinamento.md): tipos das funções tr_* do banco.

export type Papel = "atendente" | "solicitante" | "gestor" | "financeiro";
/** P2: só quem é gestor de setor (ou supervisão) / aprovador ou substituto vê o módulo. */
export type Restricao = "gestor_setor" | "aprovador";
export type PosicaoBalao = "auto" | "direita" | "esquerda" | "abaixo" | "acima";
export type StatusModulo = "rascunho" | "publicado";
/** Contorno do botão explicado: [x, y, largura, altura] em % da tela capturada. */
export type Alvo = [number, number, number, number];

export interface Trilha {
  id: number;
  codigo: string;
  nome: string;
  descricao: string;
  padrao: boolean;
}

export interface ModuloResumo {
  id: number;
  codigo: string;
  titulo: string;
  descricao: string;
  papel: Papel;
  restricao: Restricao | null;
  minutos: number;
  rotaDemo: string;
  celular: boolean;
  status: StatusModulo;
  /** Quantidade de balões. */
  passos: number;
  /** Tela do 1º balão, usada como capa do cartão. */
  capa: string | null;
  passoAtual: number;
  concluidoEm: string | null;
  iniciado: boolean;
}

export interface Balao {
  id: number;
  ordem: number;
  tela: string;
  titulo: string;
  texto: string;
  alvo: Alvo;
  posicao: PosicaoBalao;
}

/** O módulo para o tour: sem o gabarito. */
export interface Modulo extends ModuloResumo {
  pergunta: string;
  opcoes: string[];
  baloes: Balao[];
}

export interface MeusTreinamentos {
  setor: { id: number; nome: string } | null;
  /** O e-mail do usuário não está em Pessoas (P3). */
  semCadastro: boolean;
  trilha: Trilha | null;
  modulos: ModuloResumo[];
}

export interface Resposta {
  certo: boolean;
  concluidoEm: string | null;
}

// ---------- Gerenciar tutoriais (Admin) ----------

export interface ModuloAdmin extends Modulo {
  resposta: number;
  trilhas: number[];
}

export interface TrilhaAdmin extends Trilha {
  setores: { id: number; nome: string }[];
  modulos: number[];
}

export interface PainelTreinamento {
  trilhas: TrilhaAdmin[];
  modulos: (ModuloResumo & { concluiram: number; publico: number })[];
  setores: { id: number; nome: string }[];
}

export interface ProgressoSetor {
  setorId: number | null;
  setor: string;
  trilha: string;
  pessoas: number;
  concluiram: number;
  andamento: number;
  naoComecaram: number;
}

export interface ProgressoPessoa {
  usuarioId: string;
  nome: string;
  modulos: { id: number; titulo: string; passoAtual: number; passos: number; concluidoEm: string | null }[];
}

export interface SalvarModulo {
  id?: number;
  titulo: string;
  descricao: string;
  papel: Papel;
  restricao: Restricao | null;
  minutos: number;
  rotaDemo: string;
  celular: boolean;
  pergunta: string;
  opcoes: string[];
  resposta: number;
  status: StatusModulo;
  trilhas: number[];
}

export interface SalvarBalao {
  id?: number;
  moduloId: number;
  tela: string;
  titulo: string;
  texto: string;
  alvo: Alvo;
  posicao: PosicaoBalao;
}

// ---------- Constantes de tela ----------

export const PAPEIS: Record<Papel, string> = {
  atendente: "Quem atende",
  solicitante: "Quem abre / solicita",
  gestor: "Quem aprova / gere",
  financeiro: "Quem administra",
};

/** Telas capturadas por `npm run treinamento:capturar` (public/treinamento/<tela>.webp). */
export const TELAS = [
  "t-visao", "t-tickets", "t-ticket", "t-ticket2", "t-conversas", "t-monitor",
  "f-minhas", "f-nova", "f-reembolso", "f-detalhe", "f-aprov", "f-aprov-det", "f-conf", "f-conf-det",
  "app-home", "app-fin",
] as const;

/** Progresso do cartão: concluído = 100%; senão, o passo em que parou. */
export const percentual = (m: Pick<ModuloResumo, "concluidoEm" | "passoAtual" | "passos">) =>
  m.concluidoEm ? 100 : m.passos > 0 ? Math.round((Math.min(m.passoAtual, m.passos) / m.passos) * 100) : 0;

export const telaUrl =(tela: string) => `/treinamento/${tela}.webp`;
export const ehTelaCelular = (tela: string) => tela.startsWith("app-");

/** Demonstração com dados fictícios: "Praticar na demonstração" (D2). */
export const DEMO_URL = "https://imobdesk-demo.vercel.app";

/** Até 220 caracteres cabem no balão sem rolar (aviso do editor). */
export const TEXTO_RECOMENDADO = 220;
