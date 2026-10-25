import { APP_SCHEMA, edgeFunction } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { fromFunction, fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { mockCentral, mockContexto, mockMonitor, mockZenvia } from "./mock";
import type {
  AcaoConversa,
  Candidato,
  ConexaoZenvia,
  Contexto,
  Conversa,
  Mensagem,
  MonitorAtendente,
  MonitorConversa,
  MonitorIndicadores,
  Periodo,
  SalvarConexao,
  SetorConfig,
  SetorSalvar,
  VerificacaoNumero,
  VerificacaoZenvia,
} from "./tipos";

// Gestão de Atendimento: leitura pela RLS e pelas RPCs at_* do schema do aplicativo; escrita só por RPC.
// As ações do chat (assumir, enviar, encerrar…) e a Zenvia passam por Edge Functions.

/** RPC com argumentos opcionais/nulos (os tipos gerados marcam tudo como obrigatório). */
async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

async function funcao<T>(nome: Parameters<typeof edgeFunction>[0], corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(edgeFunction(nome), { body: corpo });
  if (error) throw await fromFunction(error);
  return data as T;
}

// ---------- Contexto, setores e equipe ----------

export interface ContextoService {
  contexto(): Promise<Contexto>;
  candidatos(): Promise<Candidato[]>;
  setorSalvar(p: SetorSalvar): Promise<number>;
  setorConfigSalvar(p: SetorConfig): Promise<void>;
  atendenteSalvar(p: { usuarioId: string; setorId: number; apto?: boolean }): Promise<void>;
  atendenteRemover(usuarioId: string): Promise<void>;
  ping(): Promise<void>;
  pausa(pausa: boolean): Promise<void>;
}

const supabaseContexto: ContextoService = {
  contexto: () => rpc<Contexto>("at_contexto"),
  async candidatos() {
    const linhas = await rpc<{ id: string; nome: string; email: string; setor_atendente: number | null }[]>("at_candidatos");
    return linhas.map((l) => ({ id: l.id, nome: l.nome, email: l.email, setorAtendente: l.setor_atendente }));
  },
  setorSalvar: (p) => rpc<number>("at_setor_salvar", { p: p as unknown as Json }),
  setorConfigSalvar: (p) => rpc<void>("at_setor_config_salvar", { p: p as unknown as Json }),
  atendenteSalvar: (p) => rpc<void>("at_atendente_salvar", { p: p as unknown as Json }),
  atendenteRemover: (usuarioId) => rpc<void>("at_atendente_remover", { p_usuario: usuarioId }),
  async ping() {
    await rpc<boolean | null>("at_ping");
  },
  pausa: (pausa) => rpc<void>("at_minha_pausa", { p_pausa: pausa }),
};

// ---------- Central ----------

export interface CentralService {
  conversas(): Promise<Conversa[]>;
  mensagens(conversaId: number): Promise<Mensagem[]>;
  acao(conversaId: number, a: AcaoConversa): Promise<void>;
  marcarLida(conversaId: number): Promise<void>;
  editar(conversaId: number, p: { nomeContato?: string; notaInterna?: string }): Promise<void>;
  /** Assina as mudanças (Realtime). Devolve a função para cancelar. */
  assinar(aoMudar: (tabela: "conversas" | "mensagens" | "atendentes", conversaId: number | null) => void): () => void;
}

interface ConversaRow {
  id: number;
  setor_id: number;
  numero: string;
  telefone: string;
  nome_contato: string | null;
  modo: Conversa["modo"];
  atendente_id: string | null;
  atendente_nome: string | null;
  atendente_desde: string | null;
  fila_desde: string | null;
  ticket: number | null;
  ultima_msg_cliente_em: string | null;
  ultima_msg_atendente_em: string | null;
  ultima_msg_em: string | null;
  ultima_previa: string | null;
  nao_lidas: number;
  nota_interna: string | null;
  cliente_desde: string;
  total_atendimentos: number;
}

const supabaseCentral: CentralService = {
  async conversas() {
    const linhas = await rpc<ConversaRow[]>("at_conversas_lista", { p_limite: 300 });
    return linhas.map((c) => ({
      id: c.id,
      setorId: c.setor_id,
      numero: c.numero,
      telefone: c.telefone,
      nome: c.nome_contato,
      modo: c.modo,
      atendenteId: c.atendente_id,
      atendenteNome: c.atendente_nome,
      atendenteDesde: c.atendente_desde,
      filaDesde: c.fila_desde,
      ticket: c.ticket,
      ultimaMsgClienteEm: c.ultima_msg_cliente_em,
      ultimaMsgAtendenteEm: c.ultima_msg_atendente_em,
      ultimaMsgEm: c.ultima_msg_em,
      ultimaPrevia: c.ultima_previa,
      naoLidas: c.nao_lidas,
      notaInterna: c.nota_interna,
      clienteDesde: c.cliente_desde,
      totalAtendimentos: Number(c.total_atendimentos),
    }));
  },

  async mensagens(conversaId) {
    const { data, error } = await supabase.from("at_mensagens").select("*").eq("conversa_id", conversaId).order("criado_em").limit(500);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((m) => ({
      id: m.id,
      direcao: m.direcao as Mensagem["direcao"],
      autor: m.autor as Mensagem["autor"],
      autorNome: null,
      tipo: m.tipo as Mensagem["tipo"],
      texto: m.texto,
      arquivo: (m.arquivo as Mensagem["arquivo"]) ?? null,
      status: m.status as Mensagem["status"],
      erro: m.erro,
      criadoEm: m.criado_em,
    }));
  },

  async acao(conversaId, a) {
    // A regra (quem pode, fila, ticket) é do banco; o envio sai pela Edge na hora (o cron cobre se ela falhar).
    await rpc<unknown>("at_conversa_acao", { p_conversa: conversaId, p: a as unknown as Json });
    if (a.acao === "enviar" || a.acao === "encerrar") {
      await funcao("whatsapp", { acao: "despachar", conversaId }).catch(() => undefined);
    }
  },

  marcarLida: (conversaId) => rpc<void>("at_marcar_lida", { p_conversa: conversaId }),
  editar: (conversaId, p) => rpc<void>("at_conversa_editar", { p_conversa: conversaId, p: p as unknown as Json }),

  assinar(aoMudar) {
    const canal = supabase
      .channel(`atendimento-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: APP_SCHEMA, table: "at_conversas" }, (p) => aoMudar("conversas", ((p.new ?? p.old) as { id?: number })?.id ?? null))
      .on("postgres_changes", { event: "*", schema: APP_SCHEMA, table: "at_mensagens" }, (p) => aoMudar("mensagens", ((p.new ?? p.old) as { conversa_id?: number })?.conversa_id ?? null))
      .on("postgres_changes", { event: "*", schema: APP_SCHEMA, table: "at_atendentes" }, () => aoMudar("atendentes", null))
      .subscribe();
    return () => void supabase.removeChannel(canal);
  },
};

// ---------- Monitor ----------

export interface MonitorService {
  indicadores(periodo: Periodo, setorId: number | null): Promise<MonitorIndicadores>;
  atendentes(setorId: number | null): Promise<MonitorAtendente[]>;
  conversas(setorId: number | null): Promise<MonitorConversa[]>;
}

const supabaseMonitor: MonitorService = {
  indicadores: (periodo, setorId) => rpc<MonitorIndicadores>("at_monitor_indicadores", { p_periodo: periodo, p_setor: setorId }),
  async atendentes(setorId) {
    const linhas = await rpc<
      { usuario_id: string; nome: string; setor_id: number; setor_nome: string; online: boolean; apto: boolean; pausa: boolean; em_atendimento: number; limite: number; atendidas_hoje: number; tempo_medio_seg: number | null }[]
    >("at_monitor_atendentes", { p_setor: setorId });
    return linhas.map((l) => ({
      usuarioId: l.usuario_id,
      nome: l.nome,
      setorId: l.setor_id,
      setorNome: l.setor_nome,
      online: l.online,
      apto: l.apto,
      pausa: l.pausa,
      emAtendimento: l.em_atendimento,
      limite: l.limite,
      atendidasHoje: l.atendidas_hoje,
      tempoMedioSeg: l.tempo_medio_seg === null ? null : Number(l.tempo_medio_seg),
    }));
  },
  async conversas(setorId) {
    const linhas = await rpc<
      {
        conversa_id: number; ticket: number | null; setor_id: number; setor_nome: string; nome_contato: string | null; telefone: string; numero: string;
        modo: "fila" | "atendente"; ultima_previa: string | null; fila_desde: string | null; atendente_id: string | null; atendente_nome: string | null;
        atendente_desde: string | null; ultima_msg_cliente_em: string | null; ultima_msg_atendente_em: string | null;
      }[]
    >("at_monitor_conversas", { p_setor: setorId });
    return linhas.map((l) => ({
      conversaId: l.conversa_id,
      ticket: l.ticket,
      setorId: l.setor_id,
      setorNome: l.setor_nome,
      nome: l.nome_contato,
      telefone: l.telefone,
      numero: l.numero,
      modo: l.modo,
      ultimaPrevia: l.ultima_previa,
      filaDesde: l.fila_desde,
      atendenteId: l.atendente_id,
      atendenteNome: l.atendente_nome,
      atendenteDesde: l.atendente_desde,
      ultimaMsgClienteEm: l.ultima_msg_cliente_em,
      ultimaMsgAtendenteEm: l.ultima_msg_atendente_em,
    }));
  },
};

// ---------- Zenvia (Configurações › Integrações, só super admin) ----------

export interface ZenviaService {
  carregar(): Promise<ConexaoZenvia>;
  salvar(dados: SalvarConexao): Promise<void>;
  salvarToken(token: string): Promise<void>;
  testar(): Promise<VerificacaoZenvia>;
  assinar(): Promise<{ criadas: string[] }>;
  enviarTeste(numeroId: number, telefone: string): Promise<{ ok: boolean; erro: string | null; aviso: string }>;
}

const supabaseZenvia: ZenviaService = {
  async carregar() {
    const [cfg, nums] = await Promise.all([
      supabase.from("at_config").select("token_mascara, token_definido_em, ligado, trava_piloto, telefones_piloto, verificacao").maybeSingle(),
      supabase.from("at_numeros").select("id, numero, verificacao, at_setores(nome)").eq("ativo", true).order("id"),
    ]);
    if (cfg.error) throw fromPostgrest(cfg.error);
    if (nums.error) throw fromPostgrest(nums.error);
    return {
      tokenMascara: cfg.data?.token_mascara ?? null,
      tokenDefinidoEm: cfg.data?.token_definido_em ?? null,
      ligado: cfg.data?.ligado ?? false,
      travaPiloto: cfg.data?.trava_piloto ?? true,
      telefonesPiloto: cfg.data?.telefones_piloto ?? [],
      verificacao: (cfg.data?.verificacao as unknown as VerificacaoZenvia | null) ?? null,
      numeros: (nums.data ?? []).map((n) => ({
        id: n.id,
        numero: n.numero,
        setorNome: (n.at_setores as unknown as { nome: string } | null)?.nome ?? "—",
        verificacao: (n.verificacao as unknown as VerificacaoNumero | null) ?? null,
      })),
    };
  },
  salvar: (dados) => rpc<void>("at_config_salvar", { p: dados as unknown as Json }),
  salvarToken: (token) => rpc<void>("at_zenvia_salvar_token", { p_token: token }),
  testar: () => funcao<VerificacaoZenvia>("zenvia", { acao: "testar" }),
  assinar: () => funcao<{ criadas: string[] }>("zenvia", { acao: "assinar" }),
  enviarTeste: (numeroId, telefone) => funcao("zenvia", { acao: "enviar_teste", numeroId, telefone }),
};

const mock = DATA_SOURCE === "mock";
export const contextoService: ContextoService = mock ? mockContexto : supabaseContexto;
export const centralService: CentralService = mock ? { ...mockCentral, assinar: () => () => undefined } : supabaseCentral;
export const monitorService: MonitorService = mock ? mockMonitor : supabaseMonitor;
export const zenviaService: ZenviaService = mock ? mockZenvia : supabaseZenvia;
