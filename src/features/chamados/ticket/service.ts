import { ADMIN_ROLE, SUPER_ADMIN_ROLE } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { equipesAtivasMock } from "../../cadastros/services/equipes";
import { DATA_SOURCE } from "../../configuracoes/services";
import { db as dbPortal } from "../../configuracoes/services/mock/db";
import { currentActor, delay } from "../../configuracoes/services/mock/runtime";
import { fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { initialsOf } from "../../dashboard/initials";
import { dashboardMock } from "../../dashboard/mock";
import { ticketsMock } from "../../dashboard/service";
import type { DashboardTicket } from "../../dashboard/types";
import { camposPendentes, estadoCampos } from "../cadastros/regras";
import { CADASTROS_INICIAIS, MACROS_INICIAIS } from "../cadastros/seed";
import { gatilhoAtende, gatilhosDoEvento, type AutorGatilho, type ContextoGatilho } from "../gatilhos/motor";
import { gatilhosMock, jaExecutou, notificarMock, proximoId, registrarExecucao } from "../gatilhos/store";
import { ACOES, type Gatilho, type TipoDisparo } from "../gatilhos/types";
import { nomeSetorMock, setorSolicitanteMock } from "../setorSolicitante";
import { statusFields, STATUS_INICIAIS } from "../status/seed";
import { CATEGORIAS_ENCERRADAS } from "../status/types";
import type { NovaAcao, PatchTicket, Responsavel, SolucaoAnterior, TicketDetalhe } from "./types";

// Tela do ticket. Modo real: RPCs ch_ticket_* (migrations 20261007171000 e 20261007190000). Modo simulado:
// o detalhe é montado a partir dos tickets do painel em memória e aplica as mesmas regras do banco
// (resolver exige serviço, campos obrigatórios e a solução aplicada).

export interface TicketService {
  detalhe(id: number): Promise<TicketDetalhe>;
  atualizar(id: number, patch: PatchTicket): Promise<void>;
  acao(id: number, acao: NovaAcao): Promise<number>;
  seguir(id: number, seguir: boolean): Promise<void>;
  clonar(id: number, opcoes: { copiarCampos: boolean; copiarAcoes: boolean }): Promise<number>;
  mesclar(origem: number, destino: number): Promise<void>;
  excluir(id: number): Promise<void>;
  solucoes(id: number): Promise<SolucaoAnterior[]>;
  responsaveis(): Promise<Responsavel[]>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

const supabaseTicket: TicketService = {
  detalhe: (id) => rpc<TicketDetalhe>("ch_ticket_detalhe", { p_id: id }),
  atualizar: (id, patch) => rpc<void>("ch_ticket_atualizar", { p_id: id, p: patch as unknown as Json }),
  acao: (id, a) =>
    rpc<number>("ch_ticket_acao", {
      p_id: id,
      p: { tipo: a.tipo, texto: a.texto, statusDepois: a.statusDepois ?? null, campos: a.campos ?? null } as unknown as Json,
    }),
  seguir: (id, s) => rpc<void>("ch_ticket_seguir", { p_id: id, p_seguir: s }),
  clonar: (id, o) => rpc<number>("ch_ticket_clonar", { p_id: id, p: o as unknown as Json }),
  mesclar: (origem, destino) => rpc<void>("ch_ticket_mesclar", { p_origem: origem, p_destino: destino }),
  excluir: (id) => rpc<void>("ch_ticket_excluir", { p_id: id }),
  solucoes: (id) => rpc<SolucaoAnterior[]>("ch_ticket_solucoes", { p_id: id }),
  responsaveis: () => rpc<Responsavel[]>("ch_responsaveis"),
};

// ---------- Modo simulado ----------
const CAD = CADASTROS_INICIAIS;
const detalhes = new Map<number, TicketDetalhe>();
const SOLUCOES_EXEMPLO: Record<string, string> = {
  "ERP Sienge": "Reprocessada a remessa no Sienge (Financeiro › Boletos › Reemitir) e enviado o boleto novo ao solicitante.",
  "Portais internos": "Limpado o cache do navegador e liberado o perfil do usuário no portal; o lançamento funcionou.",
  "Rede / VPN": "Reinstalado o cliente da VPN e renovado o certificado; o acesso remoto voltou.",
  "Acessos e usuários": "Criado o usuário no AD e no Sienge com o perfil do cargo; senha provisória enviada por SMS.",
  Impressão: "Reiniciado o spooler no servidor de impressão e trocado o toner; a impressora voltou para a fila.",
  Equipamentos: "Equipamento substituído pelo reserva do estoque de TI; o patrimônio antigo foi para manutenção.",
};
const ORIGEM: Record<string, TicketDetalhe["origem"]> = { "E-mail": "email", WhatsApp: "whatsapp", Intranet: "intranet", Agente: "agente" };

function ehAdmin() {
  const r = currentActor().role;
  return r === ADMIN_ROLE || r === SUPER_ADMIN_ROLE;
}

function nomeServico(id: number | null) {
  return dashboardMock.services.find((s) => s.id === id)?.name ?? CAD.servicos.find((s) => s.id === id)?.nome ?? null;
}

function construir(t: DashboardTicket): TicketDetalhe {
  const geracao = Date.parse(dashboardMock.generated_at);
  const prazo = new Date(geracao + t.sla_due_minutes * 60_000).toISOString();
  const pendente = t.status_categoria === "pendente";
  const encerrado = CATEGORIAS_ENCERRADAS.includes(t.status_categoria);
  return {
    id: t.id,
    assunto: t.subject,
    origem: ORIGEM[t.origin] ?? "agente",
    recebidoEm: t.recebido_em,
    solicitante: { pessoaId: null, nome: t.requester, contato: `${t.requester.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".")}@exemplo.com.br`, departamento: null },
    setorSolicitanteId: setorSolicitanteMock.get(t.id) ?? null,
    setorSolicitante: nomeSetorMock(setorSolicitanteMock.get(t.id) ?? null),
    setorId: CAD.equipes.find((e) => e.nome === t.team)?.setorId ?? 20,
    equipeId: CAD.equipes.find((e) => e.nome === t.team)?.id ?? null,
    responsavelId: t.owner?.id ?? null,
    servicoId: t.service_id,
    categoriaId: 2,
    urgenciaId: CAD.urgencias.find((u) => u.nome === t.prioridade)?.id ?? 3,
    statusId: t.status_id,
    justificativaId: t.justificativa_id,
    tags: [...t.tags],
    cc: [],
    campos: {},
    solucaoAplicada: encerrado ? (SOLUCOES_EXEMPLO[nomeServico(t.service_id) ?? ""] ?? "Resolvido.") : null,
    criadoEm: t.criado_em,
    assumidoEm: t.owner ? t.criado_em : null,
    primeiraRespostaEm: null,
    slaRespostaAte: prazo,
    slaSolucaoAte: prazo,
    slaManual: false,
    slaPausadoDesde: pendente ? dashboardMock.generated_at : null,
    encerradoEm: t.closed_at,
    mescladoEmId: null,
    clonadoDeId: null,
    excluidoEm: null,
    clones: [],
    mesclados: [],
    seguindo: false,
    acoes: [
      {
        numero: 1,
        tipo: "publica",
        canal: ORIGEM[t.origin] === "email" ? "email" : ORIGEM[t.origin] === "whatsapp" ? "whatsapp" : "portal",
        direcao: "entrada",
        autorId: null,
        autorNome: t.requester,
        texto: `${t.description}\n\n${t.subject}.`,
        html: null,
        anexos: [],
        envioStatus: "nao_se_aplica",
        criadoEm: t.criado_em,
        email:
          ORIGEM[t.origin] === "email"
            ? { de: "solicitante@exemplo.com.br", deNome: t.requester, para: ["chamados.ti@exemplo.com.br"], cc: [], assunto: t.subject, data: t.criado_em }
            : null,
      },
    ],
    eventos: [{ tipo: "criado", descricao: `Ticket criado (${ORIGEM[t.origin] ?? "agente"})`, autorNome: "Sistema", criadoEm: t.criado_em }],
    podeAlterarPrazo: false,
    podeExcluir: false,
  };
}

function obter(id: number): { d: TicketDetalhe; t: DashboardTicket } {
  const t = ticketsMock().find((x) => x.id === id);
  if (!t) throw new ServiceError("NOT_FOUND", "Ticket não encontrado.");
  if (!detalhes.has(id)) detalhes.set(id, construir(t));
  const d = detalhes.get(id)!;
  return { d, t };
}

/** Nome do gatilho em execução: o que ele muda aparece como "Gatilho: <nome>" e não dispara outros (G2). */
let emGatilho: string | null = null;

function evento(d: TicketDetalhe, tipo: string, descricao: string, autorNome = emGatilho ? `Gatilho: ${emGatilho}` : currentActor().name) {
  d.eventos.unshift({ tipo, descricao, autorNome, criadoEm: new Date().toISOString() });
}

function nomeUsuario(id: string) {
  return dbPortal.users.find((u) => u.id === id)?.name ?? id;
}

function aplicar(id: number, p: PatchTicket) {
  const { d, t } = obter(id);
  if (d.mescladoEmId) throw new ServiceError("INVALID_INPUT", `Este ticket foi mesclado em #${d.mescladoEmId}.`);
  const n: TicketDetalhe = structuredClone(d);
  if (p.servicoId !== undefined) {
    n.servicoId = p.servicoId;
    const s = CAD.servicos.find((x) => x.id === p.servicoId);
    if (s) {
      n.setorId = s.setorId;
      if (p.equipeId === undefined) {
        // Equipe do serviço (subindo pelos pais).
        let c: typeof s | undefined = s;
        while (c && c.equipeId === null) c = CAD.servicos.find((x) => x.id === c!.paiId);
        n.equipeId = c?.equipeId ?? null;
      }
    }
  }
  if (p.categoriaId !== undefined) n.categoriaId = p.categoriaId;
  if (p.urgenciaId !== undefined) n.urgenciaId = p.urgenciaId;
  if (p.equipeId !== undefined) n.equipeId = p.equipeId;
  if (p.responsavelId !== undefined) n.responsavelId = p.responsavelId;
  if (p.statusId !== undefined) {
    n.statusId = p.statusId;
    n.justificativaId = p.justificativaId ?? null;
  }
  if (p.tags) n.tags = [...new Set(p.tags.map((x) => x.trim()).filter(Boolean))];
  if (p.cc) n.cc = [...new Set(p.cc.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (p.campos) n.campos = { ...d.campos, ...p.campos };
  if (p.solucaoAplicada !== undefined) n.solucaoAplicada = p.solucaoAplicada?.trim() || null;
  if (p.slaSolucaoAte) {
    if (!d.podeAlterarPrazo && !ehAdmin()) throw new ServiceError("FORBIDDEN", "Só o gestor do setor, Admin ou Super admin alteram o prazo.");
    if ((p.slaJustificativa ?? "").trim().length < 5) throw new ServiceError("INVALID_INPUT", "Explique por que o prazo mudou.", "slaJustificativa");
    n.slaSolucaoAte = p.slaSolucaoAte;
    n.slaManual = true;
  }
  const st = STATUS_INICIAIS.find((s) => s.id === n.statusId);
  if (!st) throw new ServiceError("INVALID_INPUT", "Status inválido.", "statusId");
  if (st.categoria === "resolvido" || st.categoria === "fechado") {
    const estado = estadoCampos(CAD.campos, CAD.regras, { servicoId: n.servicoId, categoriaId: n.categoriaId, urgenciaId: n.urgenciaId, setorId: n.setorId, origem: n.origem, campos: n.campos }, CAD.servicos);
    const pend = camposPendentes(CAD.campos, estado, n.campos);
    if (pend.length) throw new ServiceError("INVALID_INPUT", `Preencha antes de resolver: ${pend.join(", ")}.`, "campos");
    if (n.servicoId === null) throw new ServiceError("INVALID_INPUT", "Escolha o serviço antes de resolver.", "servicoId");
    // Como ch_solucao_da_resposta: a última resposta ao solicitante; senão a última nota interna.
    if (!n.solucaoAplicada) {
      const saidas = n.acoes.filter((a) => a.direcao === "saida" && a.texto.trim()).sort((a, b) => b.numero - a.numero);
      n.solucaoAplicada = (saidas.find((a) => a.tipo === "publica") ?? saidas[0])?.texto.trim().slice(0, 20000) || null;
    }
    if (!n.solucaoAplicada) throw new ServiceError("INVALID_INPUT", "Responda ao solicitante antes de resolver: o texto da resposta vira a solução aplicada.", "texto");
  }
  // Histórico das mudanças.
  if (n.statusId !== d.statusId || n.justificativaId !== d.justificativaId) evento(n, "status", `Status alterado para ${st.nome}`);
  if (n.responsavelId !== d.responsavelId) evento(n, "responsavel", `Responsável: ${n.responsavelId ? nomeUsuario(n.responsavelId) : "ninguém"}`);
  if (n.equipeId !== d.equipeId) evento(n, "equipe", `Equipe: ${CAD.equipes.find((e) => e.id === n.equipeId)?.nome ?? "sem equipe"}`);
  if (n.servicoId !== d.servicoId) evento(n, "servico", `Serviço: ${nomeServico(n.servicoId) ?? "—"}`);
  if (n.categoriaId !== d.categoriaId) evento(n, "categoria", `Categoria: ${CAD.categorias.find((c) => c.id === n.categoriaId)?.nome ?? "—"}`);
  if (n.urgenciaId !== d.urgenciaId) evento(n, "urgencia", `Urgência: ${CAD.urgencias.find((u) => u.id === n.urgenciaId)?.nome}`);
  if (JSON.stringify(n.campos) !== JSON.stringify(d.campos)) evento(n, "campos", "Campos adicionais alterados");
  if (JSON.stringify(n.tags) !== JSON.stringify(d.tags)) evento(n, "tags", "Tags alteradas");
  if (n.slaManual && n.slaSolucaoAte !== d.slaSolucaoAte) evento(n, "sla", `Previsão de solução alterada à mão. Motivo: ${p.slaJustificativa}`);
  // Pausa e encerramento, como o gatilho do banco.
  if (st.categoria === "pendente" && !n.slaPausadoDesde) n.slaPausadoDesde = new Date().toISOString();
  if (st.categoria !== "pendente") n.slaPausadoDesde = null;
  const encerrado = CATEGORIAS_ENCERRADAS.includes(st.categoria);
  n.encerradoEm = encerrado ? (d.encerradoEm ?? new Date().toISOString()) : null;
  if (st.categoria === "andamento" && !n.assumidoEm) n.assumidoEm = new Date().toISOString();
  detalhes.set(id, n);
  // O painel (Visão geral, Tickets, Página Inicial) acompanha.
  Object.assign(t, statusFields(n.statusId, n.justificativaId), {
    service_id: n.servicoId ?? t.service_id,
    team: CAD.equipes.find((e) => e.id === n.equipeId)?.nome ?? "",
    prioridade: CAD.urgencias.find((u) => u.id === n.urgenciaId)?.nome ?? t.prioridade,
    tags: [...n.tags],
    closed_at: n.encerradoEm,
    owner: n.responsavelId ? { id: n.responsavelId, name: nomeUsuario(n.responsavelId), initials: initialsOf(nomeUsuario(n.responsavelId)) } : null,
  });
}

// ---------- Gatilhos no modo simulado (mesma lógica de ch_gatilhos_rodar) ----------
export function contextoGatilho(d: TicketDetalhe, dentroExpediente = true): ContextoGatilho {
  return {
    statusId: d.statusId,
    justificativaId: d.justificativaId,
    urgenciaId: d.urgenciaId,
    categoriaId: d.categoriaId,
    servicoId: d.servicoId,
    equipeId: d.equipeId,
    responsavelId: d.responsavelId,
    setorId: d.setorId,
    origem: d.origem,
    tags: d.tags,
    textos: [d.assunto, ...[...d.acoes].sort((a, b) => b.numero - a.numero).slice(0, 3).map((a) => a.texto)],
    campos: d.campos,
    dentroExpediente,
  };
}

/** Disparos de uma alteração (antes × depois), como ch_tickets_gatilho_anotar. */
function disparosDaMudanca(antes: TicketDetalhe, depois: TicketDetalhe): TipoDisparo[] {
  const chaves = ["statusId", "justificativaId", "equipeId", "responsavelId", "servicoId", "categoriaId", "urgenciaId", "tags", "cc", "campos", "assunto", "solucaoAplicada", "slaSolucaoAte"] as const;
  const disparos: TipoDisparo[] = [];
  if (chaves.some((k) => JSON.stringify(antes[k]) !== JSON.stringify(depois[k]))) disparos.push("alterado");
  if (antes.statusId !== depois.statusId || antes.justificativaId !== depois.justificativaId) disparos.push("status");
  return disparos;
}

function liderDa(equipeId: number | null) {
  return equipesAtivasMock().find((e) => e.id === equipeId)?.liderId ?? null;
}

function aplicarGatilho(id: number, g: Gatilho): string {
  const { d } = obter(id);
  const feito: string[] = [];
  const patch: PatchTicket = {};
  let tags = [...d.tags];
  for (const a of g.acoes) {
    if (a.tipo === "status") Object.assign(patch, { statusId: a.statusId, justificativaId: a.justificativaId ?? null });
    else if (a.tipo === "equipe") patch.equipeId = a.equipeId ?? null;
    else if (a.tipo === "responsavel") patch.responsavelId = a.modo === "pessoa" ? (a.usuarioId ?? null) : a.modo === "lider" ? liderDa(patch.equipeId !== undefined ? patch.equipeId : d.equipeId) : null;
    else if (a.tipo === "urgencia" && a.urgenciaId) patch.urgenciaId = a.urgenciaId;
    else if (a.tipo === "categoria") patch.categoriaId = a.categoriaId ?? null;
    else if (a.tipo === "servico") patch.servicoId = a.servicoId ?? null;
    else if (a.tipo === "tags_adicionar") tags = [...new Set([...tags, ...(a.tags ?? [])])];
    else if (a.tipo === "tags_remover") tags = tags.filter((t) => !(a.tags ?? []).includes(t));
    else if (a.tipo === "campo" && a.chave) patch.campos = { ...patch.campos, [a.chave]: a.valor };
    else if (a.tipo === "solucao" && !d.solucaoAplicada) patch.solucaoAplicada = a.texto ?? null;
    else continue;
    feito.push(ACOES.find((x) => x.tipo === a.tipo)?.label.toLowerCase() ?? a.tipo);
  }
  if (JSON.stringify(tags) !== JSON.stringify(d.tags)) patch.tags = tags;
  // Valida como o agente: resolver exige serviço, obrigatórios e solução (se faltar, nada muda).
  if (Object.keys(patch).length) aplicar(id, patch);
  const n = obter(id).d;
  for (const a of g.acoes) {
    if (a.tipo === "nota_interna" || a.tipo === "responder_macro") {
      const macro = MACROS_INICIAIS.find((m) => m.id === a.macroId);
      if (a.tipo === "responder_macro" && !macro) throw new ServiceError("INVALID_INPUT", "A macro da resposta não existe.");
      const texto =
        a.tipo === "nota_interna" || !macro
          ? (a.texto ?? g.nome)
          : macro.texto
              .replaceAll("{{solicitante.nome}}", n.solicitante.nome.split(/\s+/)[0] ?? "")
              .replaceAll("{{ticket.numero}}", String(n.id))
              .replaceAll("{{agente.nome}}", n.responsavelId ? nomeUsuario(n.responsavelId) : "Equipe de atendimento");
      const canal = a.tipo === "nota_interna" ? "portal" : n.origem === "email" || n.origem === "whatsapp" ? n.origem : "portal";
      n.acoes.unshift({
        numero: Math.max(0, ...n.acoes.map((x) => x.numero)) + 1,
        tipo: a.tipo === "nota_interna" ? "interna" : "publica",
        canal,
        direcao: "saida",
        autorId: null,
        autorNome: `Gatilho: ${g.nome}`,
        texto,
        html: null,
        anexos: [],
        envioStatus: a.tipo === "responder_macro" && canal !== "portal" ? "pendente" : "nao_se_aplica",
        criadoEm: new Date().toISOString(),
      });
      feito.push(a.tipo === "nota_interna" ? "nota interna" : "resposta ao solicitante");
    } else if (a.tipo === "avisar") {
      const equipe = equipesAtivasMock().find((e) => e.id === n.equipeId);
      const quem: Record<string, (string | null | undefined)[]> = {
        responsavel: [n.responsavelId],
        lider: [equipe?.liderId],
        equipe: equipe?.membros ?? [],
        pessoa: [a.usuarioId],
        seguidores: n.seguindo ? [currentActor().id] : [],
      };
      notificarMock(quem[a.quem ?? ""] ?? [], n.id, `Ticket #${n.id}: ${n.assunto}`, a.texto?.trim() || g.nome);
      feito.push(`aviso (${a.quem})`);
    } else if (a.tipo === "seguidor") {
      const alvo = a.modo === "lider" ? liderDa(n.equipeId) : a.modo === "responsavel" ? n.responsavelId : a.usuarioId;
      if (alvo && alvo === currentActor().id) n.seguindo = true;
      feito.push("seguidor");
    }
  }
  return feito.join("; ");
}

/** Roda os gatilhos ativos do evento, na ordem; ação de gatilho não dispara gatilho (G2). */
function rodarGatilhos(id: number, disparos: TipoDisparo[], autor: AutorGatilho) {
  if (emGatilho || disparos.length === 0) return;
  const ev = proximoId();
  for (const g of gatilhosDoEvento(gatilhosMock(), disparos)) {
    const { d } = obter(id);
    if (d.mescladoEmId || d.excluidoEm) return;
    if (!gatilhoAtende(g, contextoGatilho(d), autor, CAD.servicos)) continue;
    const chave = g.execucao === "ticket" ? "ticket" : `ev:${ev}`;
    if (jaExecutou(g.id, id, chave)) continue;
    const disparo = g.disparos.find((x) => disparos.includes(x.tipo))!.tipo;
    emGatilho = g.nome;
    try {
      const resumo = aplicarGatilho(id, g);
      registrarExecucao(g, id, chave, disparo, "executado", resumo);
      evento(obter(id).d, "gatilho", `Gatilho "${g.nome}": ${resumo || "executado"}`, "Gatilho");
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : String(e);
      registrarExecucao(g, id, chave, disparo, "erro", msg);
      evento(obter(id).d, "gatilho_erro", `Gatilho "${g.nome}" não executou: ${msg}`, "Gatilho");
    } finally {
      emGatilho = null;
    }
  }
}

/** Detalhe do ticket para a simulação dos gatilhos (modo simulado). */
export function detalheMock(id: number): TicketDetalhe {
  return obter(id).d;
}

const mockTicket: TicketService = {
  async detalhe(id) {
    await delay();
    const { d } = obter(id);
    const actor = currentActor();
    return structuredClone({ ...d, podeAlterarPrazo: ehAdmin(), podeExcluir: actor.role === SUPER_ADMIN_ROLE });
  },
  async atualizar(id, patch) {
    await delay();
    const antes = structuredClone(obter(id).d);
    aplicar(id, patch);
    rodarGatilhos(id, disparosDaMudanca(antes, obter(id).d), "agente");
  },
  async acao(id, a) {
    await delay();
    const { d } = obter(id);
    if (d.mescladoEmId) throw new ServiceError("INVALID_INPUT", "Este ticket não recebe mais ações.");
    if (!a.texto.trim()) throw new ServiceError("INVALID_INPUT", "Escreva o texto da ação.", "texto");
    const actor = currentActor();
    const numero = Math.max(0, ...d.acoes.map((x) => x.numero)) + 1;
    const canal = a.tipo === "interna" ? "portal" : d.origem === "email" || d.origem === "whatsapp" ? d.origem : "portal";
    d.acoes.unshift({
      numero,
      tipo: a.tipo,
      canal,
      direcao: "saida",
      autorId: actor.id,
      autorNome: actor.name,
      texto: a.texto,
      html: null,
      anexos: [],
      envioStatus: a.tipo === "publica" && canal !== "portal" ? "pendente" : "nao_se_aplica",
      criadoEm: new Date().toISOString(),
      email:
        a.tipo === "publica" && canal === "email"
          ? { de: "chamados.ti@exemplo.com.br", deNome: "Chamados TI", para: [d.solicitante.contato], cc: d.cc, assunto: `Re: [#${d.id}] ${d.assunto}`, data: new Date().toISOString() }
          : null,
    });
    if (a.tipo === "publica" && !d.primeiraRespostaEm) d.primeiraRespostaEm = new Date().toISOString();
    const antes = structuredClone(d);
    if (a.campos || a.statusDepois) aplicar(id, { ...a.campos, ...a.statusDepois });
    rodarGatilhos(id, ["acao_agente", ...disparosDaMudanca(antes, obter(id).d)], "agente");
    return numero;
  },
  async seguir(id, s) {
    await delay();
    obter(id).d.seguindo = s;
  },
  async clonar(id, o) {
    await delay();
    const { d, t } = obter(id);
    const novo = Math.max(...ticketsMock().map((x) => x.id)) + 1;
    ticketsMock().push({ ...structuredClone(t), id: novo, owner: null, ...statusFields(STATUS_INICIAIS[0].id), closed_at: null, opened_today: true, tags: o.copiarCampos ? [...t.tags] : [] });
    const c = construir(ticketsMock().at(-1)!);
    c.clonadoDeId = id;
    if (o.copiarCampos) Object.assign(c, { campos: { ...d.campos }, categoriaId: d.categoriaId, urgenciaId: d.urgenciaId, servicoId: d.servicoId });
    c.acoes = o.copiarAcoes ? structuredClone(d.acoes) : [{ ...c.acoes[0], tipo: "interna", direcao: "saida", autorNome: currentActor().name, texto: `Clonado do ticket #${id}.` }];
    detalhes.set(novo, c);
    d.clones.push(novo);
    evento(d, "clonado", `Clonado para #${novo}`);
    return novo;
  },
  async mesclar(origem, destino) {
    await delay();
    if (origem === destino) throw new ServiceError("INVALID_INPUT", "Escolha outro ticket como destino.", "destino");
    const o = obter(origem);
    const dst = obter(destino);
    if (o.d.mescladoEmId || dst.d.mescladoEmId) throw new ServiceError("INVALID_INPUT", "Um dos tickets já foi mesclado.");
    const base = Math.max(0, ...dst.d.acoes.map((a) => a.numero));
    dst.d.acoes = [...o.d.acoes.map((a) => ({ ...a, numero: base + a.numero })), ...dst.d.acoes].sort((a, b) => b.numero - a.numero);
    dst.d.acoes.unshift({ ...dst.d.acoes[0], numero: base + o.d.acoes.length + 1, tipo: "interna", direcao: "saida", autorNome: currentActor().name, texto: `Ticket #${origem} mesclado neste ticket.`, envioStatus: "nao_se_aplica", criadoEm: new Date().toISOString() });
    dst.d.mesclados.push(origem);
    evento(dst.d, "mesclado", `Recebeu as ações de #${origem}`);
    const cancelado = STATUS_INICIAIS.find((s) => s.categoria === "cancelado")!;
    o.d.acoes = [];
    o.d.mescladoEmId = destino;
    o.d.statusId = cancelado.id;
    o.d.justificativaId = null;
    o.d.encerradoEm = new Date().toISOString();
    evento(o.d, "mesclado", `Mesclado em #${destino}`);
    Object.assign(o.t, statusFields(cancelado.id), { closed_at: o.d.encerradoEm });
  },
  async excluir(id) {
    await delay();
    if (currentActor().role !== SUPER_ADMIN_ROLE) throw new ServiceError("FORBIDDEN", "Só o Super admin pode fazer isso.");
    const i = ticketsMock().findIndex((x) => x.id === id);
    if (i < 0) throw new ServiceError("NOT_FOUND", "Ticket não encontrado.");
    ticketsMock().splice(i, 1);
    detalhes.delete(id);
  },
  async solucoes(id) {
    await delay();
    const { d } = obter(id);
    return ticketsMock()
      .filter((x) => x.id !== id && x.service_id === d.servicoId && (x.status_categoria === "resolvido" || x.status_categoria === "fechado"))
      .map((x) => obter(x.id).d)
      .filter((x) => x.solucaoAplicada)
      .sort((a, b) => Date.parse(b.encerradoEm ?? "") - Date.parse(a.encerradoEm ?? ""))
      .slice(0, 3)
      .map((x) => ({ id: x.id, assunto: x.assunto, solucao: x.solucaoAplicada!, encerradoEm: x.encerradoEm!, responsavel: x.responsavelId ? nomeUsuario(x.responsavelId) : "Sistema", servico: nomeServico(x.servicoId) }));
  },
  async responsaveis() {
    await delay();
    const mapa = new Map<string, number[]>();
    // As equipes da TI do mock de equipes (6, 7) são as mesmas do catálogo de cadastros.
    for (const e of equipesAtivasMock()) for (const m of e.membros) mapa.set(m, [...(mapa.get(m) ?? []), e.id]);
    return [...mapa]
      .map(([id, equipes]) => ({ id, nome: nomeUsuario(id), equipes }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  },
};

export const ticketService: TicketService = DATA_SOURCE === "mock" ? mockTicket : supabaseTicket;
