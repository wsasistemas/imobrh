import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";

// Empresas do Imobdesk (multiempresa): seletor do topo, aparência do login e Configurações › Empresas
// (só o Super admin da WSA). RPCs da migration imobdesk_multiempresa.

export type Tema = "claro" | "escuro" | "auto";

export interface MinhaEmpresa {
  id: string;
  nome: string;
  slug: string;
  perfil: string | null;
  atual: boolean;
}

export interface Preferencias {
  tema: Tema;
  empresaId: string | null;
  empresaNome: string | null;
  adminWsa: boolean;
}

export interface EmpresaWsa {
  id: string;
  nome: string;
  slug: string;
  dominios: string[];
  ativa: boolean;
  usuarios: number;
  criadaEm: string;
}

export interface NovaEmpresa {
  nome: string;
  dominios: string[];
  adminEmail: string;
}

export interface EmpresasService {
  minhas(): Promise<MinhaEmpresa[]>;
  trocar(id: string): Promise<void>;
  preferencias(): Promise<Preferencias>;
  salvarTema(tema: Tema): Promise<void>;
  listarWsa(): Promise<EmpresaWsa[]>;
  criar(dados: NovaEmpresa): Promise<string>;
}

// As RPCs novas ainda não estão nos tipos gerados (database.types.ts): chamada sem tipo, resultado conferido aqui.
type Resultado<T> = { data: T | null; error: PostgrestError | null };
const rpc = <T>(nome: string, args: Record<string, unknown> = {}) =>
  (supabase.rpc as unknown as (n: string, a: Record<string, unknown>) => PromiseLike<Resultado<T>>)(nome, args);

async function chamar<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const r = await rpc<T>(nome, args);
  if (r.error) throw fromPostgrest(r.error);
  return r.data as T;
}

const supabaseEmpresas: EmpresasService = {
  minhas: () => chamar<MinhaEmpresa[]>("minhas_empresas").then((l) => l ?? []),
  trocar: (id) => chamar<void>("trocar_empresa", { p_empresa: id }),
  async preferencias() {
    const p = await chamar<Preferencias | null>("minhas_preferencias");
    return p ?? { tema: "claro", empresaId: null, empresaNome: null, adminWsa: false };
  },
  salvarTema: (tema) => chamar<void>("salvar_tema", { p_tema: tema }),
  async listarWsa() {
    const linhas = await chamar<{ id: string; nome: string; slug: string; dominios: string[]; ativa: boolean; usuarios: number; created_at: string }[]>(
      "listar_empresas_wsa",
    );
    return (linhas ?? []).map((l) => ({ ...l, dominios: l.dominios ?? [], criadaEm: l.created_at }));
  },
  criar: (d) =>
    chamar<string>("criar_empresa", { p_nome: d.nome, p_dominios: d.dominios, p_admin_email: d.adminEmail.trim() || null }),
};

// ---------- Modo simulado (demonstração e testes) ----------

// No modo simulado, "salvo no login" é o mesmo cache do navegador (tema.ts).
const CHAVE_TEMA = "imobdesk:tema";
const demo: { empresas: EmpresaWsa[]; atual: string } = {
  empresas: [
    { id: "demo-1", nome: "Construtora Exemplo", slug: "construtora-exemplo", dominios: ["exemplo.com.br"], ativa: true, usuarios: 12, criadaEm: "2026-10-23T12:00:00Z" },
  ],
  atual: "demo-1",
};

function temaDemo(): Tema {
  try {
    const t = localStorage.getItem(CHAVE_TEMA);
    return t === "escuro" || t === "auto" ? t : "claro";
  } catch {
    return "claro";
  }
}

const mockEmpresas: EmpresasService = {
  async minhas() {
    return demo.empresas.map((e) => ({ id: e.id, nome: e.nome, slug: e.slug, perfil: "super_admin", atual: e.id === demo.atual }));
  },
  async trocar(id) {
    if (!demo.empresas.some((e) => e.id === id)) throw new ServiceError("FORBIDDEN", "Você não tem acesso a esta empresa.");
    demo.atual = id;
  },
  async preferencias() {
    const e = demo.empresas.find((x) => x.id === demo.atual);
    return { tema: temaDemo(), empresaId: e?.id ?? null, empresaNome: e?.nome ?? null, adminWsa: true };
  },
  async salvarTema(tema) {
    try {
      localStorage.setItem(CHAVE_TEMA, tema);
    } catch {
      // navegador sem armazenamento: vale só nesta visita
    }
  },
  async listarWsa() {
    return [...demo.empresas];
  },
  async criar(d) {
    const nome = d.nome.trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 80) throw new ServiceError("INVALID_INPUT", "O nome da empresa deve ter de 2 a 80 caracteres.", "nome");
    const id = `demo-${demo.empresas.length + 1}`;
    demo.empresas.push({ id, nome, slug: id, dominios: d.dominios, ativa: true, usuarios: 1, criadaEm: new Date().toISOString() });
    demo.atual = id;
    return id;
  },
};

export const empresasService: EmpresasService = DATA_SOURCE === "mock" ? mockEmpresas : supabaseEmpresas;
