import type { Json } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";
import { DATA_SOURCE } from "../configuracoes/services";
import { db } from "../configuracoes/services/mock/db";
import { currentActor } from "../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../configuracoes/services/supabase/errors";
import { ServiceError } from "../configuracoes/services/types";
import { GESTOR_DO_SETOR, nomeDoSetor, SETOR_DO_USUARIO, SETOR_ID, SETORES_PRODUCAO } from "../atendimento/services/setoresProducao";
import type {
  Balao, MeusTreinamentos, Modulo, ModuloAdmin, ModuloResumo, PainelTreinamento, ProgressoPessoa, ProgressoSetor, Resposta,
  Restricao, SalvarBalao, SalvarModulo, StatusModulo, Trilha,
} from "./types";

// Centro de Treinamento (docs/PLANO-centro-treinamento.md). Regras no banco (funções tr_*, migration 20261023100000):
// trilha pelo setor da pessoa, módulos de gestor só para gestor/aprovador, gabarito conferido no banco, edição só do Admin.

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const json = (v: unknown) => v as unknown as Json;

export const treinamento = {
  /** p_setor (só Admin): ver como as pessoas de um setor veem, com todos os módulos da trilha. */
  meus: (setor: number | null = null) => rpc<MeusTreinamentos>("tr_meus_treinamentos", { p_setor: setor }),
  modulo: (id: number) => rpc<Modulo>("tr_modulo", { p_id: id }),
  salvarProgresso: (moduloId: number, passo: number) => rpc<void>("tr_progresso_salvar", { p_modulo: moduloId, p_passo: passo }),
  responder: (moduloId: number, opcao: number) => rpc<Resposta>("tr_responder", { p_modulo: moduloId, p_opcao: opcao }),

  // Gerenciar tutoriais (Admin)
  painel: () => rpc<PainelTreinamento>("tr_admin_painel"),
  moduloAdmin: (id: number) => rpc<ModuloAdmin>("tr_admin_modulo", { p_id: id }),
  salvarModulo: (p: SalvarModulo) => rpc<number>("tr_modulo_salvar", { p: json(p) }),
  salvarBalao: (p: SalvarBalao) => rpc<number>("tr_passo_salvar", { p: json(p) }),
  excluirBalao: (id: number) => rpc<void>("tr_passo_excluir", { p_id: id }),
  reordenarBaloes: (moduloId: number, ids: number[]) => rpc<void>("tr_passos_reordenar", { p_modulo: moduloId, p_ids: ids }),
  salvarSetoresDaTrilha: (trilhaId: number, setores: number[]) => rpc<void>("tr_trilha_setores_salvar", { p_trilha: trilhaId, p_setores: setores }),
  progressoPorSetor: () => rpc<ProgressoSetor[]>("tr_progresso_por_setor"),
  progressoPessoas: (setorId: number | null) => rpc<ProgressoPessoa[]>("tr_progresso_pessoas", { p_setor: setorId }),
};

// Modo simulado (demonstração): o mesmo conteúdo da migration, em memória, com as mesmas regras. TI, CFTV e
// Administrativo seguem Gestão de Tickets; Financeiro, Solicitações Financeiras; os demais, a trilha Colaborador.
if (DATA_SOURCE === "mock") {
  interface ModuloMem extends Omit<Modulo, "passos" | "capa" | "passoAtual" | "concluidoEm" | "iniciado" | "baloes"> {
    resposta: number;
    ordem: number;
    baloes: Balao[];
  }
  interface Progresso { passoAtual: number; concluidoEm: string | null }

  let carregado: Promise<void> | null = null;
  const trilhas: (Trilha & { setores: number[]; modulos: number[] })[] = [];
  const modulos: ModuloMem[] = [];
  const progresso = new Map<string, Progresso>();
  let proximoBalao = 1;

  /** Sob demanda: o conteúdo não entra no pacote de produção. */
  const carregar = () =>
    (carregado ??= import("./conteudo").then(({ MODULOS_SEMENTE, TRILHAS_SEMENTE }) => {
      MODULOS_SEMENTE.forEach((m, i) => {
        const { baloes, ...resto } = m;
        modulos.push({ ...resto, id: i + 1, ordem: i + 1, status: "publicado",
          baloes: baloes.map((b, k) => ({ ...b, id: proximoBalao++, ordem: k + 1, posicao: "auto" })) });
      });
      const SETORES: Record<string, number[]> = {
        tickets: [SETOR_ID.ti, SETOR_ID.cftv, SETOR_ID.administrativo],
        fin: [SETOR_ID.financeiro],
      };
      TRILHAS_SEMENTE.forEach((t, i) => trilhas.push({
        id: i + 1, codigo: t.codigo, nome: t.nome, descricao: t.descricao, padrao: t.padrao, setores: SETORES[t.codigo] ?? [],
        modulos: t.modulos.map((c) => modulos.find((m) => m.codigo === c)!.id),
      }));
    }));

  const eAdmin = (role: string | null | undefined) => role === "admin" || role === "super_admin";
  const exigirAdmin = () => {
    if (!eAdmin(currentActor().role)) throw new ServiceError("FORBIDDEN", "Só o Admin gerencia os tutoriais.");
  };
  const setorDe = (usuarioId: string): number | null => SETOR_DO_USUARIO[usuarioId] ?? null;
  const nomeSetor = (id: number) => nomeDoSetor(id) ?? "Setor";
  const trilhaDoSetor = (setor: number | null) => trilhas.find((t) => setor != null && t.setores.includes(setor)) ?? trilhas.find((t) => t.padrao)!;
  const atende = (usuarioId: string, r: Restricao | null) => {
    const gestores = Object.values(GESTOR_DO_SETOR);
    if (r === "gestor_setor") return gestores.some((g) => g.id === usuarioId);
    if (r === "aprovador") return gestores.some((g) => g.id === usuarioId || g.substitutoId === usuarioId);
    return true;
  };
  const visiveis = (usuarioId: string, t: (typeof trilhas)[number], todos = false) =>
    t.modulos.map((id) => modulos.find((m) => m.id === id)!).filter((m) => m.status === "publicado" && (todos || atende(usuarioId, m.restricao)));
  const podeVer = (usuarioId: string, role: string | null, id: number) =>
    eAdmin(role) || visiveis(usuarioId, trilhaDoSetor(setorDe(usuarioId))).some((m) => m.id === id);
  const chave = (usuarioId: string, id: number) => `${usuarioId}:${id}`;

  const resumo = (m: ModuloMem, usuarioId: string | null): ModuloResumo => {
    const p = usuarioId ? progresso.get(chave(usuarioId, m.id)) : undefined;
    const { id, codigo, titulo, descricao, papel, restricao, minutos, rotaDemo, celular, status } = m;
    return { id, codigo, titulo, descricao, papel, restricao, minutos, rotaDemo, celular, status, passos: m.baloes.length, capa: m.baloes[0]?.tela ?? null,
      passoAtual: p?.passoAtual ?? 0, concluidoEm: p?.concluidoEm ?? null, iniciado: p != null };
  };
  const achar = (id: number) => {
    const m = modulos.find((x) => x.id === id);
    if (!m) throw new ServiceError("NOT_FOUND", "Treinamento não encontrado.");
    return m;
  };
  const doTour = (m: ModuloMem, usuarioId: string): Modulo => ({
    ...resumo(m, usuarioId), pergunta: m.pergunta, opcoes: [...m.opcoes], baloes: m.baloes.map((b) => ({ ...b, alvo: [...b.alvo] as Balao["alvo"] })),
  });
  /** Pessoas do portal ativas, com o setor e a trilha (como tr_pessoas_trilha). */
  const pessoas = () =>
    db.users.filter((u) => u.status !== "inactive").map((u) => {
      const setor = setorDe(u.id);
      return { usuarioId: u.id, nome: u.name, setor, trilha: trilhaDoSetor(setor) };
    });

  Object.assign(treinamento, {
    async meus(setor: number | null = null): Promise<MeusTreinamentos> {
      await carregar();
      const u = currentActor();
      if (setor != null) exigirAdmin();
      const s = setor ?? setorDe(u.id);
      const t = trilhaDoSetor(s);
      return {
        setor: s != null ? { id: s, nome: nomeSetor(s) } : null,
        semCadastro: setor == null && setorDe(u.id) == null,
        trilha: { id: t.id, codigo: t.codigo, nome: t.nome, descricao: t.descricao, padrao: t.padrao },
        modulos: visiveis(u.id, t, setor != null).map((m) => resumo(m, u.id)),
      };
    },
    async modulo(id: number): Promise<Modulo> {
      await carregar();
      const u = currentActor();
      const m = achar(id);
      if (!podeVer(u.id, u.role, id)) throw new ServiceError("FORBIDDEN", "Este treinamento não é da sua trilha.");
      return doTour(m, u.id);
    },
    async salvarProgresso(id: number, passo: number) {
      await carregar();
      const u = currentActor();
      const m = achar(id);
      if (!podeVer(u.id, u.role, id)) throw new ServiceError("FORBIDDEN", "Este treinamento não é da sua trilha.");
      const atual = progresso.get(chave(u.id, id));
      progresso.set(chave(u.id, id), { passoAtual: Math.min(Math.max(passo, 0), m.baloes.length), concluidoEm: atual?.concluidoEm ?? null });
    },
    async responder(id: number, opcao: number): Promise<Resposta> {
      await carregar();
      const u = currentActor();
      const m = achar(id);
      if (!podeVer(u.id, u.role, id)) throw new ServiceError("FORBIDDEN", "Este treinamento não é da sua trilha.");
      const certo = m.resposta === opcao;
      const atual = progresso.get(chave(u.id, id));
      if (certo) progresso.set(chave(u.id, id), { passoAtual: m.baloes.length, concluidoEm: atual?.concluidoEm ?? new Date().toISOString() });
      return { certo, concluidoEm: progresso.get(chave(u.id, id))?.concluidoEm ?? null };
    },

    async painel(): Promise<PainelTreinamento> {
      await carregar();
      exigirAdmin();
      const ps = pessoas();
      return {
        trilhas: trilhas.map((t) => ({ ...t, setores: t.setores.map((id) => ({ id, nome: nomeSetor(id) })), modulos: [...t.modulos] })),
        modulos: [...modulos].sort((a, b) => a.ordem - b.ordem).map((m) => ({
          ...resumo(m, null),
          concluiram: [...progresso.entries()].filter(([k, p]) => k.endsWith(`:${m.id}`) && p.concluidoEm).length,
          publico: ps.filter((p) => p.trilha.modulos.includes(m.id) && atende(p.usuarioId, m.restricao)).length,
        })),
        setores: SETORES_PRODUCAO.map((s) => ({ id: s.id, nome: s.nome })),
      };
    },
    async moduloAdmin(id: number): Promise<ModuloAdmin> {
      await carregar();
      exigirAdmin();
      const m = achar(id);
      return { ...doTour(m, currentActor().id), resposta: m.resposta, trilhas: trilhas.filter((t) => t.modulos.includes(id)).map((t) => t.id) };
    },
    async salvarModulo(p: SalvarModulo): Promise<number> {
      await carregar();
      exigirAdmin();
      if (p.resposta < 0 || p.resposta >= p.opcoes.length) throw new ServiceError("INVALID_INPUT", "Marque qual opção é a resposta certa.");
      const campos = { titulo: p.titulo.trim(), descricao: p.descricao, papel: p.papel, restricao: p.restricao, minutos: p.minutos, rotaDemo: p.rotaDemo || "/",
        celular: p.celular, pergunta: p.pergunta.trim(), opcoes: [...p.opcoes], resposta: p.resposta, status: p.status as StatusModulo };
      let id = p.id;
      if (id == null) {
        id = Math.max(0, ...modulos.map((m) => m.id)) + 1;
        modulos.push({ ...campos, id, codigo: `m${id}`, ordem: id, baloes: [] });
      } else {
        Object.assign(achar(id), campos);
      }
      for (const t of trilhas) {
        const dentro = p.trilhas.includes(t.id);
        if (dentro && !t.modulos.includes(id)) t.modulos.push(id);
        if (!dentro) t.modulos = t.modulos.filter((x) => x !== id);
      }
      return id;
    },
    async salvarBalao(p: SalvarBalao): Promise<number> {
      await carregar();
      exigirAdmin();
      if (p.alvo.some((v) => v < 0 || v > 100)) throw new ServiceError("INVALID_INPUT", "O contorno precisa ficar dentro da tela.");
      const m = achar(p.moduloId);
      const campos = { tela: p.tela, titulo: p.titulo.trim(), texto: p.texto.trim(), alvo: [...p.alvo] as Balao["alvo"], posicao: p.posicao };
      if (p.id == null) {
        const b: Balao = { ...campos, id: proximoBalao++, ordem: m.baloes.length + 1 };
        m.baloes.push(b);
        return b.id;
      }
      const b = m.baloes.find((x) => x.id === p.id);
      if (!b) throw new ServiceError("NOT_FOUND", "Balão não encontrado.");
      Object.assign(b, campos);
      return b.id;
    },
    async excluirBalao(id: number) {
      await carregar();
      exigirAdmin();
      const m = modulos.find((x) => x.baloes.some((b) => b.id === id));
      if (!m) throw new ServiceError("NOT_FOUND", "Balão não encontrado.");
      m.baloes = m.baloes.filter((b) => b.id !== id).map((b, k) => ({ ...b, ordem: k + 1 }));
    },
    async reordenarBaloes(moduloId: number, ids: number[]) {
      await carregar();
      exigirAdmin();
      const m = achar(moduloId);
      if (ids.length !== m.baloes.length || !m.baloes.every((b) => ids.includes(b.id))) {
        throw new ServiceError("INVALID_INPUT", "A lista precisa ter todos os balões do módulo, uma vez cada.");
      }
      m.baloes = ids.map((id, k) => ({ ...m.baloes.find((b) => b.id === id)!, ordem: k + 1 }));
    },
    async salvarSetoresDaTrilha(trilhaId: number, setores: number[]) {
      await carregar();
      exigirAdmin();
      for (const t of trilhas) t.setores = t.id === trilhaId ? [...setores] : t.setores.filter((s) => !setores.includes(s));
    },
    async progressoPorSetor(): Promise<ProgressoSetor[]> {
      await carregar();
      exigirAdmin();
      const grupos = new Map<string, ProgressoSetor>();
      for (const p of pessoas()) {
        const k = String(p.setor);
        const g = grupos.get(k) ?? { setorId: p.setor, setor: p.setor != null ? nomeSetor(p.setor) : "Sem setor", trilha: p.trilha.nome,
          pessoas: 0, concluiram: 0, andamento: 0, naoComecaram: 0 };
        const ms = visiveis(p.usuarioId, p.trilha);
        const feitos = ms.filter((m) => progresso.get(chave(p.usuarioId, m.id))?.concluidoEm).length;
        const mexeu = ms.some((m) => progresso.has(chave(p.usuarioId, m.id)));
        g.pessoas++;
        if (ms.length > 0 && feitos === ms.length) g.concluiram++;
        else if (mexeu) g.andamento++;
        else g.naoComecaram++;
        grupos.set(k, g);
      }
      return [...grupos.values()].sort((a, b) => (a.setorId == null ? 1 : b.setorId == null ? -1 : a.setor.localeCompare(b.setor)));
    },
    async progressoPessoas(setorId: number | null): Promise<ProgressoPessoa[]> {
      await carregar();
      exigirAdmin();
      return pessoas().filter((p) => p.setor === setorId).sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => ({
        usuarioId: p.usuarioId, nome: p.nome,
        modulos: visiveis(p.usuarioId, p.trilha).map((m) => {
          const pr = progresso.get(chave(p.usuarioId, m.id));
          return { id: m.id, titulo: m.titulo, passoAtual: pr?.passoAtual ?? 0, passos: m.baloes.length, concluidoEm: pr?.concluidoEm ?? null };
        }),
      }));
    },
  });
}
