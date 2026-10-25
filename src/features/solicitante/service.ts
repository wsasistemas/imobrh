import type { Json } from "../../lib/database.types";
import { central, supabase } from "../../lib/supabase";
import { APP_SCHEMA } from "../../config/app";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { DATA_SOURCE } from "../configuracoes/services";
import { currentActor } from "../configuracoes/services/mock/runtime";
import { ServiceError } from "../configuracoes/services/types";
import { SETOR_ID } from "../atendimento/services/setoresProducao";

// App do solicitante (docs/PLANO-app-solicitante.md). Regras no banco (RPCs cd_*): só os próprios tickets,
// sessão confiável e e-mail de uma empresa cliente. Anexos no bucket privado "imobdesk-solicitante", na pasta do próprio usuário.

export const BUCKET = "imobdesk-solicitante";
export const MAX_ARQUIVO = 10 * 1024 * 1024;
export const MAX_ANEXOS = 5;

export interface Departamento {
  id: number;
  nome: string;
  icone: string;
  descricao: string | null;
}

export interface Quadros {
  meus: boolean;
  avisos: boolean;
  solucoes: boolean;
  whatsapp: boolean;
  perfil: boolean;
}

export interface Entrada {
  usuarioId: string;
  nome: string;
  email: string;
  telefone: string | null;
  pessoaId: number | null;
  perfil: string | null;
  /** Tem perfil de equipe (operador, admin…): mostra o atalho para o portal. */
  equipe: boolean;
  simulando: boolean;
  setores: Departamento[];
  config: { quadros: Quadros; whatsapp: string | null; boasVindas: string };
}

export interface Servico {
  id: number;
  paiId: number | null;
  nome: string;
  nivel: number;
  descricao: string | null;
}

export interface StatusTicket {
  id: number;
  nome: string;
  categoria: "novo" | "andamento" | "pendente" | "resolvido" | "fechado" | "cancelado";
}

export interface ChamadoResumo {
  id: number;
  assunto: string;
  origem: string;
  setor: string | null;
  servico: string | null;
  status: StatusTicket;
  responsavel: string | null;
  criadoEm: string;
  slaRespostaAte: string | null;
  primeiraRespostaEm: string | null;
  encerradoEm: string | null;
  ultima: { autor: string; texto: string; direcao: "entrada" | "saida"; em: string } | null;
  novo: boolean;
}

export interface MeusChamados {
  abertos: number;
  recentes: number;
  novos: number;
  itens: ChamadoResumo[];
}

export interface Anexo {
  bucket?: string | null;
  path?: string | null;
  nome?: string | null;
  mime?: string | null;
  tamanho?: number | null;
  url?: string | null;
  erro?: string | null;
}

export interface Chamado {
  id: number;
  assunto: string;
  origem: string;
  setor: string | null;
  servico: string | null;
  status: StatusTicket;
  responsavel: string | null;
  criadoEm: string;
  slaRespostaAte: string | null;
  encerradoEm: string | null;
  solucao: string | null;
  podeResponder: boolean;
  aguardandoConfirmacao: boolean;
  acoes: { numero: number; direcao: "entrada" | "saida"; canal: string; autorNome: string; texto: string; anexos: Anexo[]; criadoEm: string }[];
  eventos: { tipo: string; descricao: string; autorNome: string; criadoEm: string }[];
}

export interface Aviso {
  id: number;
  titulo: string;
  texto: string;
  tipo: "comunicado" | "manutencao" | "alerta" | "resolvido";
  link: string | null;
  inicio: string;
  fim: string | null;
  setor: string | null;
}

export interface Solucao {
  id: number;
  titulo: string;
  texto: string;
  usos: number;
  servico: string | null;
}

export interface NovoChamado {
  setorId: number;
  servicoId: number | null;
  /** Obrigatório quando o setor pede (Administração › Empreendimentos, ex.: CFTV). */
  empreendimentoId: number | null;
  descricao: string;
  /** "Tipo urgência": normal = a do serviço; prazo e grave = Alta; parado = Urgente (cd_ticket_criar). */
  urgencia: TipoUrgencia;
  anexos: Anexo[];
}

export type TipoUrgencia = "normal" | "prazo" | "grave" | "parado";

export interface EmpreendimentosSetor {
  pedir: boolean;
  lista: { id: number; nome: string; apelidos: string[]; cidade: string | null }[];
}

// ---------- Modo Técnico (docs/mockups/app-solicitante-tecnico.html) ----------

export interface EntradaTecnico {
  usuarioId: string;
  nome: string;
  email: string;
  setores: { id: number; nome: string }[];
}

export interface ChamadoTecnico {
  id: number;
  assunto: string;
  origem: string;
  servico: string | null;
  status: StatusTicket;
  justificativa: string | null;
  urgencia: string | null;
  tags: string[];
  empreendimento: string | null;
  solicitante: string | null;
  telefone: string | null;
  criadoEm: string;
  slaSolucaoAte: string | null;
  slaPausadoDesde: string | null;
  encerradoEm: string | null;
  responsavelId: string | null;
  responsavel: string | null;
  meu: boolean;
}

export interface ChamadoTecnicoDetalhe extends ChamadoTecnico {
  setor: string | null;
  servicoId: number | null;
  local: { nome: string; cidade: string | null; endereco: string | null; observacao: string | null } | null;
  email: string | null;
  solucao: string | null;
  podeAtribuir: boolean;
  podeAtender: boolean;
  /** Só quando o chamado está sem serviço: as opções do setor. */
  servicos: { id: number; rotulo: string }[] | null;
  /** Campos adicionais obrigatórios para resolver este chamado (regras de exibição), com o valor atual. */
  campos: CampoTecnico[];
  acoes: { numero: number; direcao: "entrada" | "saida"; autorNome: string; texto: string; anexos: Anexo[]; criadoEm: string }[];
  eventos: { tipo: string; descricao: string; autorNome: string; criadoEm: string }[];
}

export interface CampoTecnico {
  chave: string;
  rotulo: string;
  tipo: "texto" | "texto_longo" | "numero" | "data" | "data_hora" | "lista" | "multipla" | "sim_nao";
  opcoes: string[];
  ajuda: string | null;
  valor: unknown;
}

/** Tipo de resolução do técnico → status (cd_tec_concluir). */
export type TipoResolucao = "resolvido" | "voltar" | "peca" | "orcamento" | "aprovacao" | "sem_acesso" | "nao_procede";

// ---------- Administração ----------

export interface SetorApp {
  id: number;
  nome: string;
  visivel: boolean;
  icone: string | null;
  descricao: string | null;
  ordem: number;
  servicos: number;
}

export interface AvisoAdmin {
  id: number;
  setorId: number | null;
  titulo: string;
  texto: string;
  tipo: Aviso["tipo"];
  link: string | null;
  inicio: string;
  fim: string | null;
  ativo: boolean;
}

export interface SolucaoAdmin {
  id: number;
  setorId: number;
  servicoId: number | null;
  servico: string | null;
  ticketId: number | null;
  titulo: string;
  texto: string;
  publicado: boolean;
  usos: number;
}

export interface PainelSolicitante {
  config: { quadros: Quadros; whatsapp: string | null; boasVindas: string };
  setores: SetorApp[];
  avisos: AvisoAdmin[];
  solucoes: SolucaoAdmin[];
  sugestoes: { ticketId: number; assunto: string; setorId: number; servicoId: number | null; servico: string | null; solucao: string }[];
  solicitantes: number;
  chamadosApp30d: number;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const json = (v: unknown) => v as unknown as Json;

export const solicitanteApi = {
  entrar: (como: string | null) => rpc<Entrada>("cd_entrar", { p_como: como }),
  /** Permissões por aplicativo (Central): bloqueio manual do Super admin vale também no app. */
  async podeAcessar(): Promise<boolean> {
    const r = await central.rpc("pode_acessar_app", { p_app: APP_SCHEMA });
    if (r.error) return r.error.code === "PGRST202";
    return r.data !== false;
  },
  salvarPerfil: (p: { nome: string; telefone: string }) => rpc<void>("cd_perfil_salvar", { p: json(p) }),
  servicos: (setor: number) => rpc<Servico[]>("cd_servicos", { p_setor: setor }),
  empreendimentosDoSetor: (setor: number) => rpc<EmpreendimentosSetor>("cd_setor_empreendimentos", { p_setor: setor }),
  meusChamados: (filtro: "abertos" | "resolvidos" | "todos", como: string | null) => rpc<MeusChamados>("cd_meus_chamados", { p_filtro: filtro, p_como: como }),
  avisos: (setor: number | null) => rpc<Aviso[]>("cd_avisos_listar", { p_setor: setor }),
  solucoes: (setor: number, servico: number | null, busca: string | null) =>
    rpc<Solucao[]>("cd_solucoes_listar", { p_setor: setor, p_servico: servico, p_busca: busca }),
  solucaoUsada: (id: number) => rpc<void>("cd_solucao_usada", { p_id: id }),
  criar: (p: NovoChamado) => rpc<{ id: number; servico: string | null; slaRespostaAte: string | null; setor: string; empreendimento?: string | null }>("cd_ticket_criar", { p: json(p) }),
  chamado: (id: number, como: string | null) => rpc<Chamado>("cd_chamado", { p_id: id, p_como: como }),
  responder: (id: number, p: { texto: string; anexos: Anexo[] }) => rpc<void>("cd_chamado_responder", { p_id: id, p: json(p) }),
  confirmar: (id: number, resolveu: boolean, comentario: string | null) =>
    rpc<void>("cd_chamado_confirmar", { p_id: id, p_resolveu: resolveu, p_comentario: comentario }),

  /** Envia o arquivo para a pasta do usuário (o banco confere a pasta e se o arquivo existe). */
  async enviarArquivo(usuarioId: string, file: File): Promise<Anexo> {
    if (file.size > MAX_ARQUIVO) throw new ServiceError("INVALID_INPUT", `"${file.name}" passa de 10 MB.`);
    const limpo = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(-80) || "arquivo";
    const path = `${usuarioId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${limpo}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (error) throw new ServiceError("INTERNAL", `Não foi possível enviar "${file.name}". Tente de novo.`);
    return { bucket: BUCKET, path, nome: file.name.slice(0, 160), mime: file.type || "application/octet-stream", tamanho: file.size };
  },
  async removerArquivo(path: string) {
    await supabase.storage.from(BUCKET).remove([path]);
  },

  // Modo Técnico
  tec: {
    entrar: () => rpc<EntradaTecnico>("cd_tec_entrar"),
    chamados: (dias = 30) => rpc<ChamadoTecnico[]>("cd_tec_chamados", { p_dias: dias }),
    chamado: (id: number) => rpc<ChamadoTecnicoDetalhe>("cd_tec_chamado", { p_id: id }),
    atribuir: (id: number) => rpc<void>("cd_tec_atribuir", { p_id: id }),
    concluir: (id: number, p: { tipo: TipoResolucao; texto: string; fotos: Anexo[]; servicoId: number | null; campos: Record<string, unknown> }) =>
      rpc<{ status: string; justificativa: string | null }>("cd_tec_concluir", { p_id: id, p: json(p) }),
  },

  // Administração › App do solicitante
  painel: () => rpc<PainelSolicitante>("cd_admin_painel"),
  pessoas: (busca: string) => rpc<{ id: string; nome: string; email: string; perfil: string | null }[]>("cd_admin_pessoas", { p_busca: busca }),
  salvarSetor: (id: number, p: Partial<Pick<SetorApp, "visivel" | "icone" | "descricao" | "ordem">>) => rpc<void>("cd_admin_setor_salvar", { p_id: id, p: json(p) }),
  salvarConfig: (p: { quadros?: Partial<Quadros>; whatsapp?: string; boasVindas?: string }) => rpc<void>("cd_admin_config_salvar", { p: json(p) }),
  salvarAviso: (p: Partial<AvisoAdmin>) => rpc<number>("cd_aviso_salvar", { p: json(p) }),
  excluirAviso: (id: number) => rpc<void>("cd_aviso_excluir", { p_id: id }),
  salvarSolucao: (p: Partial<SolucaoAdmin>) => rpc<number>("cd_solucao_salvar", { p: json(p) }),
  excluirSolucao: (id: number) => rpc<void>("cd_solucao_excluir", { p_id: id }),
};

/** Telefone para exibir: 5521996453552 → (21) 99645-3552. */
export function formatarTelefone(v: string | null | undefined): string {
  const d = (v ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v ?? "";
}

export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÀ-Ú]/.test(p));
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase() || "?";
}

// Modo simulado (demonstração): o App do solicitante abre com o usuário do portal, com os 4 setores que recebem chamado
// (mesmos da produção), os serviços do seed, os empreendimentos simulados (CFTV pede) e chamados em memória.
// O quadro Financeiro usa as Solicitações Financeiras simuladas.
if (DATA_SOURCE === "mock") {
  const SETORES_APP: Departamento[] = [
    { id: SETOR_ID.ti, nome: "TI - Suporte", icone: "fluent-color:code-block-24", descricao: "Sistemas, acessos, rede, impressoras e equipamentos." },
    { id: SETOR_ID.cftv, nome: "CFTV", icone: "flat-color-icons:multiple-cameras", descricao: "Câmeras e gravações das obras e da sede." },
    { id: SETOR_ID.administrativo, nome: "Administrativo", icone: "flat-color-icons:briefcase", descricao: "Compras, documentos e pedidos internos." },
    { id: SETOR_ID.financeiro, nome: "Financeiro", icone: "flat-color-icons:money-transfer", descricao: "Pagamentos, boletos e notas fiscais." },
  ];
  // Raiz da árvore de serviços de cada setor no seed (cadastros/seed.ts).
  const RAIZ_DO_SETOR: Record<number, number> = { [SETOR_ID.ti]: 1, [SETOR_ID.cftv]: 11, [SETOR_ID.administrativo]: 14 };
  // Sob demanda: o seed e os empreendimentos simulados não entram no pacote de produção.
  const seed = () => import("../chamados/cadastros/seed").then((m) => m.CADASTROS_INICIAIS.servicos);
  const servicosDoSetor = async (setor: number): Promise<Servico[]> => {
    const raiz = RAIZ_DO_SETOR[setor];
    if (raiz == null) return [];
    const todos = await seed();
    const ids = new Set([raiz]);
    for (let mudou = true; mudou; ) {
      mudou = false;
      for (const s of todos) if (s.paiId != null && ids.has(s.paiId) && !ids.has(s.id)) { ids.add(s.id); mudou = true; }
    }
    return todos.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, paiId: s.paiId, nome: s.nome, nivel: s.nivel, descricao: s.descricao }));
  };
  const nomeServico = async (id: number | null) => (await seed()).find((s) => s.id === id)?.nome ?? null;
  const nomeSetor = (id: number) => SETORES_APP.find((s) => s.id === id)?.nome ?? "Setor";
  const ST = {
    novo: { id: 1, nome: "Novo", categoria: "novo" },
    andamento: { id: 2, nome: "Em atendimento", categoria: "andamento" },
    resolvido: { id: 5, nome: "Resolvido", categoria: "resolvido" },
  } satisfies Record<string, StatusTicket>;
  const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  // Chamados do usuário da demonstração: um em atendimento com resposta nova e um resolvido.
  const chamados: Chamado[] = [
    {
      id: 48290, assunto: "Impressora do 2º andar não imprime", origem: "intranet", setor: nomeSetor(SETOR_ID.ti), servico: "Impressão",
      status: ST.andamento, responsavel: "Bruno Lima", criadoEm: horasAtras(5), slaRespostaAte: horasAtras(1), encerradoEm: null, solucao: null,
      podeResponder: true, aguardandoConfirmacao: false,
      acoes: [
        { numero: 1, direcao: "entrada", canal: "portal", autorNome: "Você", texto: "A impressora do 2º andar mostra \"offline\" e nada sai.", anexos: [], criadoEm: horasAtras(5) },
        { numero: 2, direcao: "saida", canal: "portal", autorNome: "Bruno Lima", texto: "Reiniciei o spooler. Pode tentar de novo e me dizer se saiu?", anexos: [], criadoEm: horasAtras(1) },
      ],
      eventos: [{ tipo: "criado", descricao: "Chamado aberto pelo App do solicitante", autorNome: "Você", criadoEm: horasAtras(5) }],
    },
    {
      id: 48241, assunto: "Acesso ao portal de fornecedores", origem: "intranet", setor: nomeSetor(SETOR_ID.ti), servico: "Acessos e usuários",
      status: ST.resolvido, responsavel: "Marcos Prado", criadoEm: horasAtras(76), slaRespostaAte: horasAtras(72), encerradoEm: horasAtras(70),
      solucao: "Usuário liberado no portal de fornecedores com o perfil Compras.", podeResponder: false, aguardandoConfirmacao: false,
      acoes: [
        { numero: 1, direcao: "entrada", canal: "portal", autorNome: "Você", texto: "Preciso de acesso ao portal de fornecedores.", anexos: [], criadoEm: horasAtras(76) },
        { numero: 2, direcao: "saida", canal: "portal", autorNome: "Marcos Prado", texto: "Acesso liberado. Entre com o seu e-mail.", anexos: [], criadoEm: horasAtras(70) },
      ],
      eventos: [{ tipo: "criado", descricao: "Chamado aberto pelo App do solicitante", autorNome: "Você", criadoEm: horasAtras(76) }],
    },
  ];
  let proximoId = 48300;
  const lidos = new Set<number>([48241]);
  const resumo = (c: Chamado): ChamadoResumo => {
    const ultima = c.acoes[c.acoes.length - 1];
    return {
      id: c.id, assunto: c.assunto, origem: c.origem, setor: c.setor, servico: c.servico, status: c.status, responsavel: c.responsavel,
      criadoEm: c.criadoEm, slaRespostaAte: c.slaRespostaAte, primeiraRespostaEm: c.acoes.find((a) => a.direcao === "saida")?.criadoEm ?? null,
      encerradoEm: c.encerradoEm, ultima: ultima ? { autor: ultima.autorNome, texto: ultima.texto, direcao: ultima.direcao, em: ultima.criadoEm } : null,
      novo: ultima?.direcao === "saida" && !lidos.has(c.id),
    };
  };
  const aberto = (c: Chamado) => c.status.categoria !== "resolvido" && c.status.categoria !== "fechado" && c.status.categoria !== "cancelado";
  const achar = (id: number) => {
    const c = chamados.find((x) => x.id === id);
    if (!c) throw new ServiceError("NOT_FOUND", "Chamado não encontrado.");
    return c;
  };

  Object.assign(solicitanteApi, {
    async entrar(): Promise<Entrada> {
      const u = currentActor();
      return {
        usuarioId: u.id, nome: u.name, email: u.email, telefone: null, pessoaId: null, perfil: u.role, equipe: true, simulando: false, setores: SETORES_APP,
        config: { quadros: { meus: true, avisos: false, solucoes: false, whatsapp: false, perfil: true } as Quadros, whatsapp: null, boasVindas: "Como podemos ajudar?" },
      };
    },
    podeAcessar: async () => true,
    servicos: (setor: number) => servicosDoSetor(setor),
    async empreendimentosDoSetor(setor: number): Promise<EmpreendimentosSetor> {
      const { empreendimentosService } = await import("../chamados/empreendimentos/service");
      const cad = await empreendimentosService.carregar();
      const pedir = cad.setores.some((s) => s.setorId === setor && s.pedirNoApp);
      return { pedir, lista: pedir ? cad.empreendimentos.filter((e) => e.ativo).map((e) => ({ id: e.id, nome: e.nome, apelidos: e.apelidos, cidade: e.cidade })) : [] };
    },
    solucoes: async () => [],
    async criar(p: NovoChamado) {
      const servico = await nomeServico(p.servicoId);
      const assunto = p.descricao.split("\n")[0].slice(0, 80) || "Chamado pelo App do solicitante";
      const c: Chamado = {
        id: proximoId++, assunto, origem: "intranet", setor: nomeSetor(p.setorId), servico, status: ST.novo, responsavel: null,
        criadoEm: new Date().toISOString(), slaRespostaAte: new Date(Date.now() + 4 * 3_600_000).toISOString(), encerradoEm: null, solucao: null,
        podeResponder: true, aguardandoConfirmacao: false,
        acoes: [{ numero: 1, direcao: "entrada", canal: "portal", autorNome: "Você", texto: p.descricao, anexos: [], criadoEm: new Date().toISOString() }],
        eventos: [{ tipo: "criado", descricao: "Chamado aberto pelo App do solicitante", autorNome: "Você", criadoEm: new Date().toISOString() }],
      };
      chamados.unshift(c);
      return { id: c.id, servico, slaRespostaAte: c.slaRespostaAte, setor: c.setor ?? "" };
    },
    async meusChamados(filtro: "abertos" | "resolvidos" | "todos"): Promise<MeusChamados> {
      const itens = chamados.filter((c) => (filtro === "todos" ? true : filtro === "abertos" ? aberto(c) : !aberto(c))).map(resumo);
      return { abertos: chamados.filter(aberto).length, recentes: chamados.length, novos: chamados.map(resumo).filter((r) => r.novo).length, itens };
    },
    async chamado(id: number): Promise<Chamado> {
      lidos.add(id);
      return structuredClone(achar(id));
    },
    async responder(id: number, p: { texto: string; anexos: Anexo[] }) {
      const c = achar(id);
      c.acoes.push({ numero: c.acoes.length + 1, direcao: "entrada", canal: "portal", autorNome: "Você", texto: p.texto, anexos: p.anexos, criadoEm: new Date().toISOString() });
    },
    async confirmar(id: number, resolveu: boolean) {
      const c = achar(id);
      c.aguardandoConfirmacao = false;
      if (resolveu) { c.status = ST.resolvido; c.encerradoEm = new Date().toISOString(); } else c.status = ST.andamento;
    },
    avisos: async () => [],
  });
}
