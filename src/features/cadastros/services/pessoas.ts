import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { db as dbPortal } from "../../configuracoes/services/mock/db";
import { requirePermission } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { documentoValido } from "./documento";

// Configurações › Pessoas: clientes que abrem chamados (estrutura do cadastro de pessoas da Movidesk).
// Criadas sozinhas pelo e-mail ou pelo WhatsApp (RPC at_pessoa_identificar, no servidor) ou à mão.
// Leitura e escrita pelas RPCs at_pessoa*; imagem e anexos no bucket privado imobdesk-atendimento-pessoas.

export type TipoPessoa = "pessoa" | "empresa" | "departamento";
export type OrigemPessoa = "manual" | "email" | "whatsapp" | "importacao";
export type TipoContato = "email" | "telefone" | "whatsapp";

export interface Contato {
  tipo: TipoContato;
  valor: string;
  principal: boolean;
}

export interface Relacao {
  pessoaId: number;
  nome: string;
  tipo: TipoPessoa;
  cargo: string | null;
  email: string | null;
}

export interface Anexo {
  id: number;
  nome: string;
  path: string;
  mime: string | null;
  tamanho: number | null;
  enviadoPor: string | null;
  enviadoEm: string;
}

export interface ItemHistorico {
  canal: "whatsapp" | "email";
  ticket: number | null;
  titulo: string;
  setor: string;
  atendente: string | null;
  pessoa: string;
  em: string;
  situacao: "andamento" | "encerrado" | "ignorado";
}

export interface PessoaResumo {
  id: number;
  tipo: TipoPessoa;
  nome: string;
  documento: string | null;
  codRef: string | null;
  origem: OrigemPessoa;
  habilitada: boolean;
  ultimoContatoEm: string | null;
  avatarPath: string | null;
  email: string | null;
  telefone: string | null;
  empresa: string | null;
  chamados: number;
}

export interface PessoaDados {
  tipo: TipoPessoa;
  nome: string;
  razaoSocial: string;
  ramo: string;
  documento: string;
  codRef: string;
  codRefAdicional: string;
  classificacao: string;
  dominios: string[];
  sinalizadores: string[];
  observacoes: string;
  avatarPath: string | null;
  habilitada: boolean;
  contatos: Contato[];
  relacoes: { pessoaId: number; cargo: string | null }[];
}

export interface PessoaDetalhe extends Omit<PessoaDados, "relacoes"> {
  id: number;
  origem: OrigemPessoa;
  origemDetalhe: string | null;
  ultimoContatoEm: string | null;
  criadoEm: string;
  criadoPor: string | null;
  /** Setor da pessoa (migration 20261016100000): vai para o ticket na abertura. Nulo = "A identificar". */
  setorId?: number | null;
  relacoes: Relacao[];
  anexos: Anexo[];
  historico: ItemHistorico[];
}

export interface FiltroPessoas {
  busca: string;
  tipo: TipoPessoa | "";
  origem: OrigemPessoa | "";
  pagina: number;
}

export const CLASSIFICACOES = ["Cliente", "Cliente VIP", "Fornecedor", "Corretor parceiro", "Colaborador", "Outros"];
export const SINALIZADORES = ["Inadimplente", "Cliente VIP", "Reclamação recorrente", "Jurídico", "Imprensa", "Não enviar e-mail"];

export function pessoaNova(): PessoaDados {
  return {
    tipo: "pessoa", nome: "", razaoSocial: "", ramo: "", documento: "", codRef: "", codRefAdicional: "", classificacao: "Cliente",
    dominios: [], sinalizadores: [], observacoes: "", avatarPath: null, habilitada: true, contatos: [], relacoes: [],
  };
}

export interface PessoasService {
  lista(f: FiltroPessoas): Promise<{ total: number; linhas: PessoaResumo[] }>;
  busca(q: string, tipos?: TipoPessoa[]): Promise<{ id: number; nome: string; tipo: TipoPessoa; email: string | null }[]>;
  detalhe(id: number): Promise<PessoaDetalhe>;
  salvar(p: PessoaDados & { id?: number }): Promise<number>;
  mesclar(fica: number, sai: number): Promise<void>;
  excluir(id: number): Promise<void>;
  enviarImagem(pessoaId: number, arquivo: File): Promise<string>;
  anexar(pessoaId: number, arquivo: File): Promise<void>;
  removerAnexo(id: number): Promise<void>;
  url(path: string): Promise<string>;
}

const BUCKET = "imobdesk-atendimento-pessoas";
const POR_PAGINA = 25;

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

function nomeSeguro(nome: string): string {
  const ponto = nome.lastIndexOf(".");
  const ext = ponto > 0 ? nome.slice(ponto).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  return `${crypto.randomUUID()}${ext}`;
}

async function subir(path: string, arquivo: File) {
  if (arquivo.size > 20 * 1024 * 1024) throw new ServiceError("INVALID_INPUT", "Arquivo maior que 20 MB.");
  const { error } = await supabase.storage.from(BUCKET).upload(path, arquivo, { contentType: arquivo.type || undefined, upsert: false });
  if (error) throw new ServiceError("INTERNAL", `Não foi possível enviar o arquivo: ${error.message}`);
}

const supabasePessoas: PessoasService = {
  lista: (f) => rpc("at_pessoas_lista", { p: { ...f, porPagina: POR_PAGINA } as unknown as Json }),
  busca: (q, tipos) => rpc("at_pessoas_busca", { p_busca: q, p_tipos: tipos ?? null }),
  detalhe: (id) => rpc<PessoaDetalhe>("at_pessoa_detalhe", { p_id: id }),
  salvar: (p) => rpc<number>("at_pessoa_salvar", { p: p as unknown as Json }),
  mesclar: (fica, sai) => rpc<void>("at_pessoa_mesclar", { p_fica: fica, p_sai: sai }),
  async excluir(id) {
    const r = await rpc<{ arquivos: string[] }>("at_pessoa_excluir", { p_id: id });
    if (r.arquivos.length) await supabase.storage.from(BUCKET).remove(r.arquivos);
  },
  async enviarImagem(pessoaId, arquivo) {
    if (!arquivo.type.startsWith("image/")) throw new ServiceError("INVALID_INPUT", "Envie uma imagem (PNG ou JPG).");
    const path = `pessoas/${pessoaId}/imagem-${nomeSeguro(arquivo.name)}`;
    await subir(path, arquivo);
    return path;
  },
  async anexar(pessoaId, arquivo) {
    const path = `pessoas/${pessoaId}/anexos/${nomeSeguro(arquivo.name)}`;
    await subir(path, arquivo);
    await rpc("at_pessoa_anexo_registrar", { p_pessoa: pessoaId, p_nome: arquivo.name, p_path: path, p_mime: arquivo.type || null, p_tamanho: arquivo.size });
  },
  async removerAnexo(id) {
    const path = await rpc<string>("at_pessoa_anexo_remover", { p_id: id });
    await supabase.storage.from(BUCKET).remove([path]);
  },
  async url(path) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error || !data) throw new ServiceError("INTERNAL", "Não foi possível abrir o arquivo.");
    return data.signedUrl;
  },
};

// ---------- Modo simulado ----------
interface PessoaMock extends PessoaDetalhe {
  _relacoesIds: { pessoaId: number; cargo: string | null; souMembro: boolean }[];
}
const agora = Date.now();
const iso = (horasAtras: number) => new Date(agora - horasAtras * 3_600_000).toISOString();
const arquivos = new Map<string, string>();
let seq = 100;
let seqAnexo = 10;

function mk(id: number, tipo: TipoPessoa, nome: string, extra: Partial<PessoaDetalhe> = {}): PessoaMock {
  return {
    ...pessoaNova(), id, tipo, nome, origem: "manual", origemDetalhe: null, ultimoContatoEm: iso(5), criadoEm: iso(24 * 30), criadoPor: "Ana Lima",
    relacoes: [], anexos: [], historico: [], _relacoesIds: [], ...extra,
  } as PessoaMock;
}
const pessoas: PessoaMock[] = [
  mk(1, "empresa", "CASA NOVA MOVEIS E COLCHAO LTDA", {
    razaoSocial: "CASA NOVA MOVEIS E COLCHAO LTDA", ramo: "Comércio varejista de móveis", documento: "22417565000101", codRef: "2fe1e4c3-f55b-4b4e", codRefAdicional: "00050722",
    dominios: ["casanovamoveis.com.br"], sinalizadores: ["Cliente VIP"], origem: "email", origemDetalhe: "cobranca@exemplo.com.br", ultimoContatoEm: iso(1),
    contatos: [{ tipo: "email", valor: "financeiro@casanovamoveis.com.br", principal: true }, { tipo: "telefone", valor: "552133331010", principal: true }],
    anexos: [{ id: 1, nome: "contrato-social.pdf", path: "mock/1", mime: "application/pdf", tamanho: 1_200_000, enviadoPor: "Ana Lima", enviadoEm: iso(96) }],
  }),
  mk(2, "pessoa", "Mariana Souza", {
    documento: "52998224725", origem: "whatsapp", origemDetalhe: "WhatsApp do Financeiro", ultimoContatoEm: iso(1),
    contatos: [{ tipo: "email", valor: "mariana@casanovamoveis.com.br", principal: true }, { tipo: "whatsapp", valor: "5521981234455", principal: true }],
    historico: [
      { canal: "whatsapp", ticket: 10241, titulo: "Preciso da 2ª via do boleto", setor: "Financeiro", atendente: "Ana Lima", pessoa: "Mariana Souza", em: iso(1), situacao: "andamento" },
      { canal: "email", ticket: null, titulo: "Boleto de setembro", setor: "Financeiro", atendente: null, pessoa: "Mariana Souza", em: iso(30), situacao: "encerrado" },
    ],
  }),
  mk(3, "pessoa", "João Castro", { origem: "email", origemDetalhe: "cobranca@exemplo.com.br", contatos: [{ tipo: "email", valor: "joao@casanovamoveis.com.br", principal: true }, { tipo: "whatsapp", valor: "5521984442020", principal: true }] }),
  mk(4, "pessoa", "Paulo Henrique", { origem: "whatsapp", origemDetalhe: "WhatsApp do CFTV", ultimoContatoEm: iso(26), contatos: [{ tipo: "whatsapp", valor: "5521973573360", principal: true }] }),
  mk(5, "departamento", "Condomínio Arte Wave", { contatos: [{ tipo: "email", valor: "sindico@artewave.com.br", principal: true }], ultimoContatoEm: iso(96) }),
  mk(6, "pessoa", "Cláudia Pires", { documento: "", habilitada: false, origem: "email", contatos: [{ tipo: "email", valor: "claudia.pires@gmail.com", principal: true }], ultimoContatoEm: iso(48) }),
];
// Colaboradores da Construtora Exemplo (fictícios), cada um no seu setor (mesmos ids da produção: setoresProducao.ts).
const colaborador = (id: number, nome: string, email: string, setorId: number, cargo: string) =>
  mk(id, "pessoa", nome, {
    classificacao: "Colaborador", setorId, origem: "manual", ultimoContatoEm: iso(24),
    contatos: [{ tipo: "email", valor: email, principal: true }], observacoes: cargo,
  });
pessoas.push(
  colaborador(20, "Wagner Antunes", "wagner.antunes@exemplo.com.br", 20, "Coordenador de TI"),
  colaborador(21, "Marcos Prado", "marcos.prado@exemplo.com.br", 20, "Gestor de TI · Infraestrutura"),
  colaborador(22, "Paula Nunes", "paula.nunes@exemplo.com.br", 20, "Gestora de TI · Sistemas"),
  colaborador(23, "Diego Ramos", "diego.ramos@exemplo.com.br", 20, "Analista de suporte"),
  colaborador(24, "Renato Lopes", "renato.lopes@exemplo.com.br", 21, "Gestor do CFTV"),
  colaborador(25, "Helena Costa", "helena.costa@exemplo.com.br", 21, "Operadora de monitoramento"),
  colaborador(26, "João Silva", "joao.silva@exemplo.com.br", 21, "Técnico de CFTV"),
  colaborador(27, "Carla Mendes", "carla.mendes@exemplo.com.br", 22, "Gestora administrativa"),
  colaborador(28, "Gustavo Reis", "gustavo.reis@exemplo.com.br", 22, "Assistente administrativo"),
  colaborador(29, "Carla Nunes", "carla.nunes@exemplo.com.br", 22, "Auxiliar administrativa"),
  colaborador(30, "Fernanda Dias", "fernanda.dias@exemplo.com.br", 23, "Analista financeira · Conferência"),
  colaborador(31, "Ana Lima", "ana.lima@exemplo.com.br", 23, "Analista de contas a receber"),
  colaborador(32, "Bruno Rocha", "bruno.rocha@exemplo.com.br", 23, "Assistente financeiro"),
);
pessoas[1]!._relacoesIds = [{ pessoaId: 1, cargo: "Financeiro", souMembro: true }];
pessoas[2]!._relacoesIds = [{ pessoaId: 1, cargo: "Sócio", souMembro: true }];
pessoas[0]!._relacoesIds = [{ pessoaId: 2, cargo: "Financeiro", souMembro: false }, { pessoaId: 3, cargo: "Sócio", souMembro: false }];

const exigir = () => requirePermission("manage_pessoas");
const esperar = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const normalizar = (c: Contato) => (c.tipo === "email" ? c.valor.trim().toLowerCase() : ((d) => (d.length === 10 || d.length === 11 ? `55${d}` : d))(c.valor.replace(/\D/g, "")));
const principal = (p: PessoaMock, email: boolean) => p.contatos.filter((c) => (c.tipo === "email") === email).sort((a, b) => Number(b.principal) - Number(a.principal))[0]?.valor ?? null;

function relacoesDe(p: PessoaMock): Relacao[] {
  return p._relacoesIds
    .map((r): Relacao | null => {
      const o = pessoas.find((x) => x.id === r.pessoaId);
      return o ? { pessoaId: o.id, nome: o.nome, tipo: o.tipo, cargo: r.cargo, email: principal(o, true) } : null;
    })
    .filter((x): x is Relacao => x !== null);
}

const mockPessoas: PessoasService = {
  async lista(f) {
    await esperar();
    exigir();
    const q = f.busca.trim().toLowerCase();
    const dig = f.busca.replace(/\D/g, "");
    const lista = pessoas
      .filter((p) => (!f.tipo || p.tipo === f.tipo) && (!f.origem || p.origem === f.origem))
      .filter((p) => q.length < 3 || [p.nome, p.razaoSocial, p.codRef, p.codRefAdicional].some((v) => v.toLowerCase().includes(q)) || (dig.length >= 3 && p.documento.includes(dig)) || p.contatos.some((c) => c.valor.includes(q) || (dig.length >= 4 && c.valor.includes(dig))))
      .sort((a, b) => Number(b.habilitada) - Number(a.habilitada) || (b.ultimoContatoEm ?? "").localeCompare(a.ultimoContatoEm ?? ""));
    return {
      total: lista.length,
      linhas: lista.slice((f.pagina - 1) * POR_PAGINA, f.pagina * POR_PAGINA).map((p) => ({
        id: p.id, tipo: p.tipo, nome: p.nome, documento: p.documento || null, codRef: p.codRef || null, origem: p.origem, habilitada: p.habilitada,
        ultimoContatoEm: p.ultimoContatoEm, avatarPath: p.avatarPath, email: principal(p, true), telefone: principal(p, false),
        empresa: p.tipo === "pessoa" ? (relacoesDe(p)[0]?.nome ?? null) : null, chamados: p.historico.length,
      })),
    };
  },
  async busca(q, tipos) {
    exigir();
    const s = q.trim().toLowerCase();
    return pessoas.filter((p) => (!tipos || tipos.includes(p.tipo)) && (p.nome.toLowerCase().includes(s) || p.contatos.some((c) => c.valor.includes(s)))).slice(0, 20).map((p) => ({ id: p.id, nome: p.nome, tipo: p.tipo, email: principal(p, true) }));
  },
  async detalhe(id) {
    await esperar(150);
    exigir();
    const p = pessoas.find((x) => x.id === id);
    if (!p) throw new ServiceError("NOT_FOUND", "Pessoa não encontrada.");
    const grupo = [p.id, ...(p.tipo === "pessoa" ? [] : p._relacoesIds.map((r) => r.pessoaId))];
    const historico = pessoas.filter((x) => grupo.includes(x.id)).flatMap((x) => x.historico).sort((a, b) => b.em.localeCompare(a.em));
    const { _relacoesIds: _r, ...resto } = structuredClone(p);
    return { ...resto, relacoes: relacoesDe(p), historico };
  },
  async salvar(dados) {
    await esperar();
    exigir();
    const nome = dados.nome.trim();
    if (!nome) throw new ServiceError("INVALID_INPUT", "Informe o nome.", "nome");
    const doc = dados.documento.replace(/\D/g, "");
    if (doc) {
      const esperado = dados.tipo === "pessoa" ? 11 : 14;
      if (doc.length !== esperado) throw new ServiceError("INVALID_INPUT", dados.tipo === "pessoa" ? "CPF precisa ter 11 dígitos." : "CNPJ precisa ter 14 dígitos.", "documento");
      if (!documentoValido(doc)) throw new ServiceError("INVALID_INPUT", `${dados.tipo === "pessoa" ? "CPF" : "CNPJ"} inválido (dígito verificador não confere).`, "documento");
      const dono = pessoas.find((x) => x.documento === doc && x.id !== dados.id);
      if (dono) throw new ServiceError("DUPLICATE", `Esse documento já está cadastrado em "${dono.nome}". Use Mesclar pessoa se for a mesma.`, "documento");
    }
    const contatos = dados.contatos.map((c) => ({ ...c, valor: normalizar(c) }));
    for (const c of contatos) {
      if (c.tipo === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.valor)) throw new ServiceError("INVALID_INPUT", `E-mail inválido: ${c.valor}`, "contatos");
      if (c.tipo !== "email" && !/^\d{10,15}$/.test(c.valor)) throw new ServiceError("INVALID_INPUT", `Telefone inválido: ${c.valor} (use DDD + número).`, "contatos");
      const dono = pessoas.find((x) => x.id !== dados.id && x.contatos.some((y) => y.tipo === c.tipo && y.valor === c.valor));
      if (dono) throw new ServiceError("DUPLICATE", `O contato ${c.valor} já pertence a "${dono.nome}". Use Mesclar pessoa se for a mesma.`, "contatos");
    }
    let p = pessoas.find((x) => x.id === dados.id);
    if (!p) {
      p = mk(++seq, dados.tipo, nome, { criadoEm: new Date().toISOString(), criadoPor: dbPortal.users.find((u) => u.id === dbPortal.currentUserId)?.name ?? null, ultimoContatoEm: null });
      pessoas.push(p);
    }
    // Sem o `id` do formulário: numa ficha nova ele vem undefined e apagaria o id gerado.
    const { relacoes, id: _id, ...resto } = dados;
    Object.assign(p, resto, { nome, documento: doc, contatos, dominios: dados.tipo === "pessoa" ? [] : dados.dominios });
    // Relações dos dois lados.
    for (const o of pessoas) o._relacoesIds = o._relacoesIds.filter((r) => r.pessoaId !== p!.id);
    p._relacoesIds = relacoes.map((r) => ({ pessoaId: r.pessoaId, cargo: r.cargo, souMembro: dados.tipo === "pessoa" }));
    for (const r of relacoes) pessoas.find((o) => o.id === r.pessoaId)?._relacoesIds.push({ pessoaId: p.id, cargo: r.cargo, souMembro: dados.tipo !== "pessoa" });
    return p.id;
  },
  async mesclar(fica, sai) {
    await esperar(400);
    exigir();
    const f = pessoas.find((x) => x.id === fica);
    const s = pessoas.find((x) => x.id === sai);
    if (!f || !s || fica === sai) throw new ServiceError("INVALID_INPUT", "Escolha duas fichas diferentes.");
    for (const c of s.contatos) if (!f.contatos.some((x) => x.tipo === c.tipo && x.valor === c.valor)) f.contatos.push({ ...c, principal: false });
    f.historico.push(...s.historico.map((h) => ({ ...h, pessoa: f.nome })));
    f.anexos.push(...s.anexos);
    f.documento ||= s.documento;
    for (const o of pessoas) for (const r of o._relacoesIds) if (r.pessoaId === sai) r.pessoaId = fica;
    for (const r of s._relacoesIds) if (r.pessoaId !== fica && !f._relacoesIds.some((x) => x.pessoaId === r.pessoaId)) f._relacoesIds.push(r);
    pessoas.splice(pessoas.indexOf(s), 1);
  },
  async excluir(id) {
    await esperar();
    exigir();
    const p = pessoas.find((x) => x.id === id);
    if (!p) throw new ServiceError("NOT_FOUND", "Pessoa não encontrada.");
    if (p.historico.length) throw new ServiceError("INVALID_INPUT", "Esta pessoa já tem chamados no histórico. Desabilite em vez de excluir.");
    for (const o of pessoas) o._relacoesIds = o._relacoesIds.filter((r) => r.pessoaId !== id);
    pessoas.splice(pessoas.indexOf(p), 1);
  },
  async enviarImagem(_pessoaId, arquivo) {
    if (!arquivo.type.startsWith("image/")) throw new ServiceError("INVALID_INPUT", "Envie uma imagem (PNG ou JPG).");
    const path = `mock/img-${++seqAnexo}`;
    arquivos.set(path, URL.createObjectURL(arquivo));
    return path;
  },
  async anexar(pessoaId, arquivo) {
    await esperar();
    const p = pessoas.find((x) => x.id === pessoaId);
    if (!p) throw new ServiceError("NOT_FOUND", "Pessoa não encontrada.");
    const path = `mock/anexo-${++seqAnexo}`;
    arquivos.set(path, URL.createObjectURL(arquivo));
    p.anexos.unshift({ id: seqAnexo, nome: arquivo.name, path, mime: arquivo.type, tamanho: arquivo.size, enviadoPor: "Você", enviadoEm: new Date().toISOString() });
  },
  async removerAnexo(id) {
    for (const p of pessoas) p.anexos = p.anexos.filter((a) => a.id !== id);
  },
  async url(path) {
    return arquivos.get(path) ?? "about:blank";
  },
};

export const pessoasService: PessoasService = DATA_SOURCE === "mock" ? mockPessoas : supabasePessoas;
