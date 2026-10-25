// Tipos da Gestão de Atendimento (mesmos nomes dos JSONs das RPCs at_*).
// Tudo é separado por setor: cada número, atendente e gestor pertence a um setor.

export type Papel = "supervisor" | "gestor" | "atendente";

export interface Pessoa {
  id: string;
  nome: string;
  email: string;
}

export interface AtendenteSetor extends Pessoa {
  apto: boolean;
  pausa: boolean;
  onlineEm: string | null;
}

/** 0 = domingo (como no banco). Horas em "HH:MM". */
export interface Horario {
  dia: number;
  aberto: boolean;
  abre: string;
  fecha: string;
}

export interface VerificacaoNumero {
  em: string;
  naConta: boolean;
  erro: string | null;
}

export interface NumeroSetor {
  id: number;
  numero: string;
  verificacao: VerificacaoNumero | null;
}

export interface RegrasSetor {
  msgBoasVindas: string;
  msgForaHorario: string;
  msgEncerramento: string;
  limiteSimultaneo: number;
  atendenteSemRespostaMin: number;
  encerrarAposHoras: number;
  alertaFilaMin: number;
  alertaClienteMin: number;
}

export interface Setor extends RegrasSetor {
  id: number;
  nome: string;
  ativo: boolean;
  /** Atende chamados (fila, serviços, App do solicitante). Desmarcado: só identifica o setor de quem pede. */
  recebeChamados: boolean;
  /** Papel de quem está logado neste setor. */
  papel: Papel;
  numeros: NumeroSetor[];
  gestores: Pessoa[];
  atendentes: AtendenteSetor[];
  horarios: Horario[];
}

export interface Contexto {
  eu: string | null;
  supervisor: boolean;
  superAdmin: boolean;
  souAtendente: boolean;
  setores: Setor[];
}

export interface Candidato extends Pessoa {
  /** Setor em que já é atendente (cada atendente pertence a um setor só). */
  setorAtendente: number | null;
}

export interface SetorSalvar {
  id?: number;
  nome: string;
  ativo: boolean;
  recebeChamados: boolean;
  numeros: string[];
  gestores: string[];
}

export interface SetorConfig extends RegrasSetor {
  setorId: number;
  horarios: Horario[];
}

// ---------- Central ----------

export type Modo = "fila" | "atendente" | "encerrada" | "robo";

export interface Conversa {
  id: number;
  setorId: number;
  numero: string;
  telefone: string;
  nome: string | null;
  modo: Modo;
  atendenteId: string | null;
  /** Atendente atual ou, na encerrada, quem atendeu por último. */
  atendenteNome: string | null;
  atendenteDesde: string | null;
  filaDesde: string | null;
  ticket: number | null;
  ultimaMsgClienteEm: string | null;
  ultimaMsgAtendenteEm: string | null;
  ultimaMsgEm: string | null;
  ultimaPrevia: string | null;
  naoLidas: number;
  notaInterna: string | null;
  clienteDesde: string;
  totalAtendimentos: number;
}

export interface Mensagem {
  id: number;
  direcao: "entrada" | "saida" | "interna";
  autor: "cliente" | "atendente" | "auto" | "sistema";
  autorNome: string | null;
  tipo: "texto" | "arquivo" | "imagem" | "audio" | "video" | "evento";
  texto: string | null;
  arquivo: { nome?: string | null; url?: string; mime?: string; path?: string; bucket?: string; erro?: string } | null;
  status: "recebida" | "pendente" | "enviada" | "entregue" | "lida" | "falhou";
  erro: string | null;
  criadoEm: string;
}

export type AcaoConversa =
  | { acao: "assumir" | "devolver" }
  | { acao: "enviar"; texto: string }
  | { acao: "transferir"; para: string }
  /** Encerrar: resolvido → ticket Resolvido (exige solução e serviço); senão o ticket fica "Em atendimento". */
  | { acao: "encerrar"; resolvido?: boolean; solucao?: string; servicoId?: number | null; categoriaId?: number | null };

// ---------- Monitor ----------

export type Periodo = "hoje" | "semana" | "mes";

export interface Indicadores {
  atendidas: number;
  resolvidas1o: number;
  foraHorario: number;
  esperaMediaSeg: number | null;
  atendimentoMedioSeg: number | null;
}

export interface MonitorIndicadores {
  inicio: string;
  atual: Indicadores;
  anterior: Indicadores;
}

export interface MonitorAtendente {
  usuarioId: string;
  nome: string;
  setorId: number;
  setorNome: string;
  online: boolean;
  apto: boolean;
  pausa: boolean;
  emAtendimento: number;
  limite: number;
  atendidasHoje: number;
  tempoMedioSeg: number | null;
}

export interface MonitorConversa {
  conversaId: number;
  ticket: number | null;
  setorId: number;
  setorNome: string;
  nome: string | null;
  telefone: string;
  numero: string;
  modo: "fila" | "atendente";
  ultimaPrevia: string | null;
  filaDesde: string | null;
  atendenteId: string | null;
  atendenteNome: string | null;
  atendenteDesde: string | null;
  ultimaMsgClienteEm: string | null;
  ultimaMsgAtendenteEm: string | null;
}

// ---------- Zenvia ----------

export interface VerificacaoZenvia {
  em: string;
  tokenOk: boolean;
  erroToken: string | null;
  modelos: number;
  assinaturaMensagem: boolean;
  assinaturaStatus: boolean;
}

export interface NumeroConta {
  id: number;
  numero: string;
  setorNome: string;
  verificacao: VerificacaoNumero | null;
}

export interface ConexaoZenvia {
  tokenMascara: string | null;
  tokenDefinidoEm: string | null;
  ligado: boolean;
  travaPiloto: boolean;
  telefonesPiloto: string[];
  verificacao: VerificacaoZenvia | null;
  numeros: NumeroConta[];
}

export type SalvarConexao = Partial<Pick<ConexaoZenvia, "ligado" | "travaPiloto" | "telefonesPiloto">>;
