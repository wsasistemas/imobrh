import { SETORES_PRODUCAO } from "./setoresProducao";
import type { PermissionId } from "../../../config/menuRegistry";
import { isEffectivelyAllowed } from "../../configuracoes/access/policy";
import { db as dbPortal } from "../../configuracoes/services/mock/db";
import { currentActor, rulesFor } from "../../configuracoes/services/mock/runtime";
import { ServiceError } from "../../configuracoes/services/types";
import type {
  AcaoConversa,
  AtendenteSetor,
  Candidato,
  ConexaoZenvia,
  Contexto,
  Conversa,
  Horario,
  Indicadores,
  Mensagem,
  MonitorAtendente,
  MonitorConversa,
  MonitorIndicadores,
  Papel,
  Periodo,
  SetorConfig,
  SetorSalvar,
} from "./tipos";

// Modo simulado da Gestão de Atendimento: os dados do mockup aprovado (docs/mockups/atendimento-portal.html),
// com as mesmas regras do banco (papel por setor, visibilidade e validações). Tudo em memória.

export const esperar = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const agora = Date.now();
const haMin = (m: number) => new Date(agora - m * 60_000).toISOString();

interface SetorMock {
  id: number;
  nome: string;
  ativo: boolean;
  recebeChamados: boolean;
  msgBoasVindas: string;
  msgForaHorario: string;
  msgEncerramento: string;
  limiteSimultaneo: number;
  atendenteSemRespostaMin: number;
  encerrarAposHoras: number;
  alertaFilaMin: number;
  alertaClienteMin: number;
  numeros: { id: number; numero: string; ativo: boolean; naConta: boolean | null }[];
  gestores: string[];
  horarios: Horario[];
}

const horarios = (fecha: string, sabado: [string, string] | null): Horario[] =>
  [0, 1, 2, 3, 4, 5, 6].map((dia) =>
    dia === 0 ? { dia, aberto: false, abre: "08:00", fecha: "18:00" } : dia === 6 ? { dia, aberto: !!sabado, abre: sabado?.[0] ?? "09:00", fecha: sabado?.[1] ?? "13:00" } : { dia, aberto: true, abre: "08:00", fecha },
  );

const regrasPadrao = { limiteSimultaneo: 5, atendenteSemRespostaMin: 30, encerrarAposHoras: 23, alertaFilaMin: 15, alertaClienteMin: 5 };

// Setores iguais aos da produção (setoresProducao.ts). Recebem chamado: TI - Suporte, CFTV,
// Administrativo e Financeiro; os demais existem para o cadastro de Pessoas e as Solicitações Financeiras.
const msgPadrao = (nome: string) => ({
  msgBoasVindas: `Olá! Você falou com o ${nome} da Construtora Exemplo. Em instantes alguém da equipe vai te atender. 🙂`,
  msgForaHorario: `Recebemos sua mensagem! O ${nome} atende de segunda a sexta, das 8h às 18h.`,
  msgEncerramento: `Atendimento do ${nome} encerrado. Se precisar, é só mandar nova mensagem.`,
});
const setor = (id: number, nome: string, recebeChamados = false, extra: Partial<SetorMock> = {}): SetorMock => ({
  id, nome, ativo: true, recebeChamados, ...regrasPadrao, ...msgPadrao(nome.trim()), numeros: [], gestores: [], horarios: horarios("18:00", null), ...extra,
});
const extras: Record<number, Partial<SetorMock>> = {
  20: { gestores: ["u-paula", "u-marcos"], numeros: [{ id: 5, numero: "5521999990001", ativo: true, naConta: true }] },
  21: { gestores: ["u-renato"], numeros: [{ id: 4, numero: "5521999990004", ativo: true, naConta: true }] },
  22: { gestores: ["u-carla"], numeros: [{ id: 2, numero: "5521999990003", ativo: true, naConta: true }, { id: 3, numero: "5521999990005", ativo: true, naConta: true }] },
  23: { gestores: ["u-fernanda"], numeros: [{ id: 1, numero: "5521999990002", ativo: true, naConta: true }] },
};
const setores: SetorMock[] = SETORES_PRODUCAO.map((x) => setor(x.id, x.nome, x.recebeChamados, extras[x.id]));


interface AtendenteMock {
  usuarioId: string;
  setorId: number;
  apto: boolean;
  pausa: boolean;
  onlineEm: string | null;
  hoje: number;
  medioSeg: number | null;
}

const atendentes: AtendenteMock[] = [
  { usuarioId: "u-ana", setorId: 23, apto: true, pausa: false, onlineEm: haMin(0.5), hoje: 9, medioSeg: 660 },
  { usuarioId: "u-bruno", setorId: 23, apto: true, pausa: false, onlineEm: haMin(1), hoje: 7, medioSeg: 840 },
  { usuarioId: "u-fernanda", setorId: 23, apto: true, pausa: true, onlineEm: haMin(1), hoje: 5, medioSeg: 540 },
  { usuarioId: "u-carla", setorId: 22, apto: false, pausa: false, onlineEm: null, hoje: 0, medioSeg: null },
  { usuarioId: "u-gustavo", setorId: 22, apto: true, pausa: false, onlineEm: haMin(0.2), hoje: 3, medioSeg: 720 },
  { usuarioId: "u-helena", setorId: 21, apto: true, pausa: false, onlineEm: haMin(2), hoje: 4, medioSeg: 1080 },
  { usuarioId: "u-marcos", setorId: 20, apto: true, pausa: false, onlineEm: haMin(0.8), hoje: 6, medioSeg: 900 },
  { usuarioId: "u-paula", setorId: 20, apto: true, pausa: false, onlineEm: haMin(3), hoje: 4, medioSeg: 780 },
];

interface ConversaMock extends Omit<Conversa, "numero" | "atendenteNome" | "totalAtendimentos"> {
  numeroId: number;
  ultimoAtendenteId: string | null;
}

let seqMsg = 1000;
const mensagens = new Map<number, Mensagem[]>();
const M = (autor: Mensagem["autor"], texto: string, quando: string, autorNome: string | null = null): Mensagem => ({
  id: ++seqMsg,
  direcao: autor === "cliente" ? "entrada" : autor === "sistema" ? "interna" : "saida",
  autor,
  autorNome,
  tipo: autor === "sistema" ? "evento" : "texto",
  texto,
  arquivo: null,
  status: autor === "cliente" || autor === "sistema" ? "recebida" : "lida",
  erro: null,
  criadoEm: quando,
});

const base = { naoLidas: 0, notaInterna: null, atendenteId: null, atendenteDesde: null, filaDesde: null, ultimoAtendenteId: null, ultimaMsgAtendenteEm: null } as const;
const conversas: ConversaMock[] = [
  { ...base, id: 1, setorId: 23, numeroId: 1, telefone: "5521981234455", nome: "Mariana Souza", modo: "fila", filaDesde: haMin(19.3), ticket: 10241, ultimaMsgClienteEm: haMin(18), ultimaMsgEm: haMin(18), ultimaPrevia: "Preciso da 2ª via do boleto", naoLidas: 2, clienteDesde: haMin(20) },
  { ...base, id: 2, setorId: 23, numeroId: 1, telefone: "5521988771122", nome: null, modo: "fila", filaDesde: haMin(13.7), ticket: 10242, ultimaMsgClienteEm: haMin(13.7), ultimaMsgEm: haMin(13.7), ultimaPrevia: "Posso pagar com PIX?", naoLidas: 1, clienteDesde: haMin(14) },
  { ...base, id: 3, setorId: 23, numeroId: 1, telefone: "5521997771010", nome: "Ricardo Alves", modo: "atendente", atendenteId: "u-ana", atendenteDesde: haMin(25.4), ticket: 10236, ultimaMsgClienteEm: haMin(24), ultimaMsgAtendenteEm: haMin(20), ultimaMsgEm: haMin(20), ultimaPrevia: "Te envio agora", clienteDesde: "2026-09-12T13:00:00.000Z" },
  { ...base, id: 4, setorId: 23, numeroId: 1, telefone: "5521984442020", nome: "João Castro", modo: "atendente", atendenteId: "u-bruno", atendenteDesde: haMin(19.9), ticket: 10238, ultimaMsgClienteEm: haMin(6.2), ultimaMsgAtendenteEm: haMin(15), ultimaMsgEm: haMin(6.2), ultimaPrevia: "Certo, aguardo seu retorno", clienteDesde: haMin(30) },
  { ...base, id: 5, setorId: 22, numeroId: 2, telefone: "5521991230099", nome: "Silvia Barata", modo: "fila", filaDesde: haMin(5.5), ticket: 10243, ultimaMsgClienteEm: haMin(5.5), ultimaMsgEm: haMin(5.5), ultimaPrevia: "Quero remarcar minha visita", naoLidas: 1, clienteDesde: "2026-05-02T13:00:00.000Z" },
  { ...base, id: 6, setorId: 22, numeroId: 3, telefone: "5521985557788", nome: "Letícia Figueiredo", modo: "atendente", atendenteId: "u-gustavo", atendenteDesde: haMin(16.6), ticket: 10239, ultimaMsgClienteEm: haMin(10), ultimaMsgAtendenteEm: haMin(2), ultimaMsgEm: haMin(2), ultimaPrevia: "Já encaminhei seu pedido", clienteDesde: "2026-08-02T13:00:00.000Z" },
  { ...base, id: 7, setorId: 21, numeroId: 4, telefone: "5521973573360", nome: "Paulo Henrique", modo: "fila", filaDesde: haMin(28.1), ticket: 10240, ultimaMsgClienteEm: haMin(28), ultimaMsgEm: haMin(28), ultimaPrevia: "A câmera do portão da obra está sem imagem", naoLidas: 2, clienteDesde: "2026-10-05T13:00:00.000Z" },
  { ...base, id: 8, setorId: 23, numeroId: 1, telefone: "5521990012233", nome: "Cláudia Pires", modo: "encerrada", ultimoAtendenteId: "u-ana", ticket: 10199, ultimaMsgClienteEm: haMin(1500), ultimaMsgAtendenteEm: haMin(1497), ultimaMsgEm: haMin(1495), ultimaPrevia: "Atendimento encerrado", clienteDesde: "2026-06-01T13:00:00.000Z" },
];
const boas = (id: number) => setores.find((s) => s.id === id)!.msgBoasVindas;
mensagens.set(1, [M("cliente", "Boa noite", haMin(19.5)), M("auto", boas(23), haMin(19.4)), M("cliente", "Preciso da 2ª via do boleto", haMin(18)), M("sistema", "Entrou na fila do Financeiro", haMin(19.3))]);
mensagens.set(2, [M("cliente", "Posso pagar com PIX?", haMin(13.7)), M("auto", boas(23), haMin(13.6)), M("sistema", "Entrou na fila do Financeiro", haMin(13.6))]);
mensagens.set(3, [M("cliente", "Quero o extrato das parcelas", haMin(26)), M("auto", boas(23), haMin(26)), M("sistema", "Ana Lima assumiu a conversa", haMin(25.4)), M("atendente", "Oi Ricardo, aqui é a Ana! Vou gerar para você.", haMin(25), "Ana Lima"), M("cliente", "Obrigado!", haMin(24)), M("atendente", "Te envio agora", haMin(20), "Ana Lima")]);
mensagens.set(4, [M("cliente", "Boa tarde, preciso renegociar", haMin(21)), M("sistema", "Bruno Rocha assumiu a conversa", haMin(19.9)), M("atendente", "Boa tarde, João! Vamos ver as opções.", haMin(15), "Bruno Rocha"), M("cliente", "Certo, aguardo seu retorno", haMin(6.2))]);
mensagens.set(5, [M("cliente", "Boa noite! Quero remarcar minha visita", haMin(5.5)), M("auto", boas(22), haMin(5.5)), M("sistema", "Entrou na fila do Administrativo", haMin(5.5))]);
mensagens.set(6, [M("cliente", "Oi, preciso de uma declaração", haMin(17)), M("sistema", "Gustavo Reis assumiu a conversa", haMin(16.6)), M("atendente", "Oi Letícia! Qual declaração?", haMin(15), "Gustavo Reis"), M("cliente", "De quitação", haMin(10)), M("atendente", "Já encaminhei seu pedido", haMin(2), "Gustavo Reis")]);
mensagens.set(7, [M("cliente", "A câmera do portão da obra está sem imagem", haMin(28.1)), M("auto", boas(21), haMin(28)), M("sistema", "Entrou na fila do CFTV", haMin(28))]);
mensagens.set(8, [M("cliente", "Recebi o boleto, obrigada", haMin(1500)), M("atendente", "Por nada, Cláudia!", haMin(1497), "Ana Lima"), M("auto", setores.find((s) => s.id === 23)!.msgEncerramento, haMin(1495)), M("sistema", "Ana Lima encerrou a conversa", haMin(1495))]);

// Tickets fechados dos últimos 70 dias (base dos indicadores do Monitor), gerados de forma fixa.
interface TicketMock {
  setorId: number;
  atendenteId: string;
  entrouFila: number;
  assumido: number;
  encerrado: number;
  foraHorario: boolean;
  transferencias: number;
}
const tickets: TicketMock[] = [];
{
  let semente = 7;
  const rnd = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);
  const porSetor: Record<number, string[]> = { 23: ["u-ana", "u-bruno", "u-fernanda"], 22: ["u-carla", "u-gustavo"], 21: ["u-helena"], 20: ["u-marcos", "u-paula"] };
  const ids = [23, 22, 21, 20];
  for (let i = 0; i < 1400; i++) {
    const setorId = ids[Math.floor(rnd() * ids.length)]!;
    const equipe = porSetor[setorId]!;
    const entrou = agora - rnd() * 70 * 86_400_000;
    const assumido = entrou + (2 + rnd() * 14) * 60_000;
    tickets.push({
      setorId,
      atendenteId: equipe[Math.floor(rnd() * equipe.length)]!,
      entrouFila: entrou,
      assumido,
      encerrado: assumido + (5 + rnd() * 20) * 60_000,
      foraHorario: rnd() < 0.05,
      transferencias: rnd() < 0.07 ? 1 : 0,
    });
  }
}

// ---------- Quem está logado ----------

const nomeDe = (id: string | null) => (id ? (dbPortal.users.find((u) => u.id === id)?.name ?? "—") : null);
const emailDe = (id: string) => dbPortal.users.find((u) => u.id === id)?.email ?? "";

function eu() {
  const ator = currentActor();
  const pode = (p: PermissionId) => isEffectivelyAllowed(p, ator.role, rulesFor(ator.role));
  return { id: ator.id, nome: ator.name, pode, supervisor: pode("gestao_atendimento_supervisao"), superAdmin: ator.role === "super_admin" };
}

function papelEm(setor: SetorMock): Papel | null {
  const e = eu();
  if (e.supervisor) return "supervisor";
  if (e.pode("gestao_atendimento_monitor") && setor.gestores.includes(e.id)) return "gestor";
  if (e.pode("gestao_atendimento_central") && atendentes.some((a) => a.usuarioId === e.id && a.setorId === setor.id)) return "atendente";
  return null;
}

const gestorDe = (setorId: number) => {
  const s = setores.find((x) => x.id === setorId);
  const p = s ? papelEm(s) : null;
  return p === "supervisor" || p === "gestor";
};

function exigirGestor(setorId: number, msg: string) {
  if (!gestorDe(setorId)) throw new ServiceError("FORBIDDEN", msg);
}

function veConversa(c: ConversaMock): boolean {
  const s = setores.find((x) => x.id === c.setorId)!;
  const p = papelEm(s);
  if (p === "supervisor" || p === "gestor") return true;
  if (p !== "atendente") return false;
  const id = eu().id;
  if (c.modo === "atendente") return c.atendenteId === id;
  if (c.modo === "encerrada") return c.ultimoAtendenteId === null || c.ultimoAtendenteId === id;
  return true;
}

// ---------- Contexto, setores e equipe ----------

export const mockContexto = {
  async contexto(): Promise<Contexto> {
    await esperar();
    const e = eu();
    return {
      eu: e.id,
      supervisor: e.supervisor,
      superAdmin: e.superAdmin,
      souAtendente: atendentes.some((a) => a.usuarioId === e.id),
      setores: setores
        .map((s) => ({ s, papel: papelEm(s) }))
        .filter((x): x is { s: SetorMock; papel: Papel } => x.papel !== null)
        .sort((a, b) => a.s.nome.localeCompare(b.s.nome, "pt-BR"))
        .map(({ s, papel }) => ({
          id: s.id, nome: s.nome, ativo: s.ativo, recebeChamados: s.recebeChamados, papel,
          msgBoasVindas: s.msgBoasVindas, msgForaHorario: s.msgForaHorario, msgEncerramento: s.msgEncerramento,
          limiteSimultaneo: s.limiteSimultaneo, atendenteSemRespostaMin: s.atendenteSemRespostaMin, encerrarAposHoras: s.encerrarAposHoras,
          alertaFilaMin: s.alertaFilaMin, alertaClienteMin: s.alertaClienteMin,
          numeros: s.numeros.filter((n) => n.ativo).map((n) => ({ id: n.id, numero: n.numero, verificacao: n.naConta === null ? null : { em: new Date().toISOString(), naConta: n.naConta, erro: null } })),
          gestores: s.gestores.map((id) => ({ id, nome: nomeDe(id)!, email: emailDe(id) })),
          atendentes: atendentes
            .filter((a) => a.setorId === s.id)
            .map((a): AtendenteSetor => ({ id: a.usuarioId, nome: nomeDe(a.usuarioId)!, email: emailDe(a.usuarioId), apto: a.apto, pausa: a.pausa, onlineEm: a.onlineEm }))
            .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
          horarios: s.horarios.map((h) => ({ ...h })),
        })),
    };
  },

  async candidatos(): Promise<Candidato[]> {
    await esperar();
    const e = eu();
    if (!e.supervisor && !(e.pode("gestao_atendimento_monitor") && setores.some((s) => s.gestores.includes(e.id)))) {
      throw new ServiceError("FORBIDDEN", "Só a gestão do setor escolhe a equipe.");
    }
    return dbPortal.users
      .filter((u) => u.status === "active")
      .map((u) => ({ id: u.id, nome: u.name, email: u.email, setorAtendente: atendentes.find((a) => a.usuarioId === u.id)?.setorId ?? null }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  },

  async setorSalvar(p: SetorSalvar): Promise<number> {
    await esperar();
    if (!eu().supervisor) throw new ServiceError("FORBIDDEN", "Só a supervisão geral cadastra setores e números.");
    const nome = p.nome.trim();
    if (nome.length < 2 || nome.length > 60) throw new ServiceError("INVALID_INPUT", "Informe o nome do setor (2 a 60 letras).", "nome");
    if (setores.some((s) => s.nome.toLowerCase() === nome.toLowerCase() && s.id !== p.id)) throw new ServiceError("DUPLICATE", "Já existe um setor com esse nome.", "nome");
    const numeros = [...new Set(p.numeros.map((n) => n.replace(/\D/g, "")).filter(Boolean).map((n) => (n.length === 10 || n.length === 11 ? `55${n}` : n)))];
    for (const n of numeros) {
      if (!/^\d{12,13}$/.test(n)) throw new ServiceError("INVALID_INPUT", `Número inválido: ${n}. Use DDI + DDD + número (ex.: 5521999990002).`, "numeros");
      const outro = setores.find((s) => s.id !== p.id && s.numeros.some((x) => x.ativo && x.numero === n));
      if (outro) throw new ServiceError("DUPLICATE", `O número ${n} já pertence ao setor ${outro.nome}.`, "numeros");
    }
    let s = setores.find((x) => x.id === p.id);
    if (!s) {
      s = { id: Math.max(0, ...setores.map((x) => x.id)) + 1, nome, ativo: p.ativo, recebeChamados: p.recebeChamados, ...regrasPadrao, msgBoasVindas: "Olá! Recebemos sua mensagem e em instantes alguém da nossa equipe vai te atender. 🙂", msgForaHorario: "Recebemos sua mensagem! Estamos fora do horário de atendimento. Assim que abrirmos, falamos com você.", msgEncerramento: "Atendimento encerrado. Se precisar de algo, é só mandar uma nova mensagem. Obrigado!", numeros: [], gestores: [], horarios: horarios("18:00", null) };
      setores.push(s);
    }
    Object.assign(s, { nome, ativo: p.ativo, recebeChamados: p.recebeChamados, gestores: [...new Set(p.gestores)] });
    for (const n of s.numeros) n.ativo = numeros.includes(n.numero);
    for (const n of numeros) {
      const outroInativo = setores.flatMap((x) => x.numeros.map((y) => ({ x, y }))).find(({ y }) => y.numero === n);
      if (outroInativo && outroInativo.x !== s) outroInativo.x.numeros = outroInativo.x.numeros.filter((y) => y.numero !== n);
      if (!s.numeros.some((y) => y.numero === n)) s.numeros.push({ id: Math.max(0, ...setores.flatMap((x) => x.numeros.map((y) => y.id))) + 1, numero: n, ativo: true, naConta: null });
    }
    return s.id;
  },

  async setorConfigSalvar(p: SetorConfig): Promise<void> {
    await esperar();
    exigirGestor(p.setorId, "Só a gestão do setor altera a fila e os horários.");
    const fora = (v: number, min: number, max: number) => !Number.isInteger(v) || v < min || v > max;
    if (fora(p.limiteSimultaneo, 1, 50) || fora(p.encerrarAposHoras, 1, 23) || fora(p.alertaFilaMin, 1, 240) || fora(p.alertaClienteMin, 1, 240) || fora(p.atendenteSemRespostaMin, 5, 1440)) {
      throw new ServiceError("INVALID_INPUT", "Valor fora do permitido: limite de 1 a 50, encerramento de 1 a 23 h, alertas de 1 a 240 min e mensagens de até 1.000 letras.");
    }
    if (p.horarios.some((h) => h.aberto && h.fecha <= h.abre)) throw new ServiceError("INVALID_INPUT", "O horário de fechar precisa ser depois do de abrir.", "horarios");
    const s = setores.find((x) => x.id === p.setorId)!;
    Object.assign(s, {
      msgBoasVindas: p.msgBoasVindas, msgForaHorario: p.msgForaHorario, msgEncerramento: p.msgEncerramento,
      limiteSimultaneo: p.limiteSimultaneo, atendenteSemRespostaMin: p.atendenteSemRespostaMin, encerrarAposHoras: p.encerrarAposHoras,
      alertaFilaMin: p.alertaFilaMin, alertaClienteMin: p.alertaClienteMin, horarios: p.horarios.map((h) => ({ ...h })),
    });
  },

  async atendenteSalvar(p: { usuarioId: string; setorId: number; apto?: boolean }): Promise<void> {
    await esperar();
    exigirGestor(p.setorId, "Só a gestão do setor altera a equipe.");
    const atual = atendentes.find((a) => a.usuarioId === p.usuarioId);
    if (atual && atual.setorId !== p.setorId && !eu().supervisor) {
      throw new ServiceError("DUPLICATE", `${nomeDe(p.usuarioId)} já é atendente de outro setor. Só a supervisão geral pode mudar de setor.`, "usuarioId");
    }
    if (atual) Object.assign(atual, { setorId: p.setorId, apto: p.apto ?? atual.apto });
    else atendentes.push({ usuarioId: p.usuarioId, setorId: p.setorId, apto: p.apto ?? true, pausa: false, onlineEm: null, hoje: 0, medioSeg: null });
  },

  async atendenteRemover(usuarioId: string): Promise<void> {
    await esperar();
    const a = atendentes.find((x) => x.usuarioId === usuarioId);
    if (!a) throw new ServiceError("NOT_FOUND", "Atendente não encontrado.");
    exigirGestor(a.setorId, "Só a gestão do setor altera a equipe.");
    atendentes.splice(atendentes.indexOf(a), 1);
  },

  async ping(): Promise<void> {
    const a = atendentes.find((x) => x.usuarioId === eu().id);
    if (a) a.onlineEm = new Date().toISOString();
  },

  async pausa(pausa: boolean): Promise<void> {
    await esperar(100);
    const a = atendentes.find((x) => x.usuarioId === eu().id);
    if (a) Object.assign(a, { pausa, onlineEm: new Date().toISOString() });
  },
};

// ---------- Central ----------

const numeroDe = (id: number) => setores.flatMap((s) => s.numeros).find((n) => n.id === id)?.numero ?? "";
const paraConversa = (c: ConversaMock): Conversa => {
  const { numeroId, ultimoAtendenteId, ...resto } = c;
  return { ...resto, numero: numeroDe(numeroId), atendenteNome: nomeDe(c.atendenteId ?? ultimoAtendenteId), totalAtendimentos: c.id === 3 ? 3 : c.id === 8 ? 5 : 1 };
};

export const mockCentral = {
  async conversas(): Promise<Conversa[]> {
    await esperar(150);
    return conversas.filter(veConversa).sort((a, b) => (b.ultimaMsgEm ?? "").localeCompare(a.ultimaMsgEm ?? "")).map(paraConversa);
  },

  async mensagens(conversaId: number): Promise<Mensagem[]> {
    await esperar(100);
    const c = conversas.find((x) => x.id === conversaId);
    if (!c || !veConversa(c)) return [];
    return structuredClone(mensagens.get(conversaId) ?? []);
  },

  async acao(conversaId: number, a: AcaoConversa): Promise<void> {
    await esperar(150);
    const c = conversas.find((x) => x.id === conversaId);
    if (!c || !veConversa(c)) throw new ServiceError("NOT_FOUND", "Conversa não encontrada.");
    const e = eu();
    const lista = mensagens.get(conversaId) ?? [];
    mensagens.set(conversaId, lista);
    const ev = (t: string) => lista.push(M("sistema", t, new Date().toISOString()));
    const setor = setores.find((s) => s.id === c.setorId)!;
    const agoraIso = new Date().toISOString();
    if (c.modo === "encerrada") throw new ServiceError("INVALID_INPUT", "Conversa encerrada. Ela reabre quando o cliente escrever de novo.");
    switch (a.acao) {
      case "assumir":
        if (c.modo === "atendente" && c.atendenteId !== e.id && !gestorDe(c.setorId)) throw new ServiceError("FORBIDDEN", "Outro atendente está com esta conversa.");
        ev(c.modo === "atendente" && c.atendenteId !== e.id ? `Conversa transferida de ${nomeDe(c.atendenteId)} para ${e.nome}` : `${e.nome} assumiu a conversa`);
        Object.assign(c, { modo: "atendente", atendenteId: e.id, atendenteDesde: agoraIso, naoLidas: 0 });
        break;
      case "devolver":
        ev(`${nomeDe(c.atendenteId)} devolveu a conversa à fila`);
        Object.assign(c, { modo: "fila", atendenteId: null, filaDesde: agoraIso });
        break;
      case "transferir": {
        if (!gestorDe(c.setorId)) throw new ServiceError("FORBIDDEN", "Só a gestão do setor transfere conversas.");
        const destino = atendentes.find((x) => x.usuarioId === a.para && x.setorId === c.setorId);
        if (!destino) throw new ServiceError("INVALID_INPUT", "Escolha um atendente do mesmo setor.");
        ev(`Conversa transferida para ${nomeDe(a.para)}`);
        Object.assign(c, { modo: "atendente", atendenteId: a.para, atendenteDesde: agoraIso });
        break;
      }
      case "encerrar":
        lista.push(M("auto", setor.msgEncerramento, agoraIso));
        ev(`${e.nome} encerrou a conversa`);
        Object.assign(c, { modo: "encerrada", ultimoAtendenteId: c.atendenteId ?? e.id, atendenteId: null, ultimaPrevia: "Atendimento encerrado", ultimaMsgEm: agoraIso });
        break;
      case "enviar":
        if (c.modo === "atendente" && c.atendenteId !== e.id) throw new ServiceError("FORBIDDEN", "Outro atendente está com esta conversa.");
        if (c.modo === "fila") {
          ev(`${e.nome} assumiu ao responder`);
          Object.assign(c, { modo: "atendente", atendenteId: e.id, atendenteDesde: agoraIso });
        }
        lista.push(M("atendente", a.texto, agoraIso, e.nome));
        Object.assign(c, { ultimaPrevia: a.texto, ultimaMsgEm: agoraIso, ultimaMsgAtendenteEm: agoraIso });
        break;
    }
  },

  async marcarLida(conversaId: number): Promise<void> {
    const c = conversas.find((x) => x.id === conversaId);
    if (c && veConversa(c)) c.naoLidas = 0;
  },

  async editar(conversaId: number, p: { nomeContato?: string; notaInterna?: string }): Promise<void> {
    await esperar(150);
    const c = conversas.find((x) => x.id === conversaId);
    if (!c || !veConversa(c)) throw new ServiceError("NOT_FOUND", "Conversa não encontrada.");
    if (p.nomeContato !== undefined && p.nomeContato.trim().length > 80) throw new ServiceError("INVALID_INPUT", "Nome com até 80 letras.", "nomeContato");
    if (p.nomeContato !== undefined) c.nome = p.nomeContato.trim() || null;
    if (p.notaInterna !== undefined) c.notaInterna = p.notaInterna || null;
  },
};

// ---------- Monitor ----------

function setoresMonitor(setorId: number | null): number[] {
  const e = eu();
  const ids = setores.filter((s) => (setorId === null || s.id === setorId) && (e.supervisor || (e.pode("gestao_atendimento_monitor") && s.gestores.includes(e.id)))).map((s) => s.id);
  if (ids.length === 0) throw new ServiceError("FORBIDDEN", "O Monitor é da gestão do setor e da supervisão geral.");
  return ids;
}

function janela(ini: number, fim: number, ids: number[]): Indicadores {
  const t = tickets.filter((x) => ids.includes(x.setorId));
  const enc = t.filter((x) => x.encerrado >= ini && x.encerrado < fim);
  const assum = t.filter((x) => x.assumido >= ini && x.assumido < fim);
  const media = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length / 1000) : null);
  return {
    atendidas: enc.length,
    resolvidas1o: enc.filter((x) => x.transferencias === 0).length,
    foraHorario: t.filter((x) => x.entrouFila >= ini && x.entrouFila < fim && x.foraHorario).length,
    esperaMediaSeg: media(assum.map((x) => x.assumido - x.entrouFila)),
    atendimentoMedioSeg: media(enc.map((x) => x.encerrado - x.assumido)),
  };
}

function inicioDe(periodo: Periodo, ref: Date): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  if (periodo === "semana") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (periodo === "mes") d.setDate(1);
  return d;
}

export const mockMonitor = {
  async indicadores(periodo: Periodo, setorId: number | null): Promise<MonitorIndicadores> {
    await esperar();
    const ids = setoresMonitor(setorId);
    const ini = inicioDe(periodo, new Date());
    const iniAnt = inicioDe(periodo, new Date(ini.getTime() - 1000));
    const dur = Date.now() - ini.getTime();
    return { inicio: ini.toISOString(), atual: janela(ini.getTime(), Date.now(), ids), anterior: janela(iniAnt.getTime(), iniAnt.getTime() + dur, ids) };
  },

  async atendentes(setorId: number | null): Promise<MonitorAtendente[]> {
    await esperar();
    const ids = setoresMonitor(setorId);
    return atendentes
      .filter((a) => ids.includes(a.setorId))
      .map((a) => {
        const s = setores.find((x) => x.id === a.setorId)!;
        return {
          usuarioId: a.usuarioId, nome: nomeDe(a.usuarioId)!, setorId: s.id, setorNome: s.nome,
          online: !!a.onlineEm && Date.now() - new Date(a.onlineEm).getTime() < 3 * 60_000, apto: a.apto, pausa: a.pausa,
          emAtendimento: conversas.filter((c) => c.modo === "atendente" && c.atendenteId === a.usuarioId).length,
          limite: s.limiteSimultaneo, atendidasHoje: a.hoje, tempoMedioSeg: a.medioSeg,
        };
      })
      .sort((a, b) => a.setorNome.localeCompare(b.setorNome, "pt-BR") || a.nome.localeCompare(b.nome, "pt-BR"));
  },

  async conversas(setorId: number | null): Promise<MonitorConversa[]> {
    await esperar();
    const ids = setoresMonitor(setorId);
    return conversas
      .filter((c): c is ConversaMock & { modo: "fila" | "atendente" } => ids.includes(c.setorId) && (c.modo === "fila" || c.modo === "atendente"))
      .map((c) => ({
        conversaId: c.id, ticket: c.ticket, setorId: c.setorId, setorNome: setores.find((s) => s.id === c.setorId)!.nome,
        nome: c.nome, telefone: c.telefone, numero: numeroDe(c.numeroId), modo: c.modo, ultimaPrevia: c.ultimaPrevia,
        filaDesde: c.filaDesde, atendenteId: c.atendenteId, atendenteNome: nomeDe(c.atendenteId), atendenteDesde: c.atendenteDesde,
        ultimaMsgClienteEm: c.ultimaMsgClienteEm, ultimaMsgAtendenteEm: c.ultimaMsgAtendenteEm,
      }));
  },
};

// ---------- Zenvia ----------

const conexao = { tokenMascara: "••••••••a1b2" as string | null, tokenDefinidoEm: new Date().toISOString() as string | null, ligado: false, travaPiloto: true, telefonesPiloto: ["5521973573360"], verificacao: null as ConexaoZenvia["verificacao"] };

function exigirSuperAdmin() {
  if (!eu().superAdmin) throw new ServiceError("FORBIDDEN", "Só o super admin altera a conexão do WhatsApp.");
}

export const mockZenvia = {
  async carregar(): Promise<ConexaoZenvia> {
    await esperar();
    exigirSuperAdmin();
    return {
      ...structuredClone(conexao),
      numeros: setores.flatMap((s) =>
        s.numeros.filter((n) => n.ativo).map((n) => ({ id: n.id, numero: n.numero, setorNome: s.nome, verificacao: n.naConta === null || !conexao.verificacao ? null : { em: conexao.verificacao.em, naConta: n.naConta, erro: null } })),
      ),
    };
  },
  async salvar(dados: Partial<Pick<ConexaoZenvia, "ligado" | "travaPiloto" | "telefonesPiloto">>): Promise<void> {
    await esperar();
    exigirSuperAdmin();
    Object.assign(conexao, dados);
  },
  async salvarToken(token: string): Promise<void> {
    await esperar();
    exigirSuperAdmin();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token.trim())) throw new ServiceError("INVALID_INPUT", "Token inválido: copie o token inteiro da Zenvia (Console › API).", "token");
    Object.assign(conexao, { tokenMascara: `••••••••${token.trim().slice(-4)}`, tokenDefinidoEm: new Date().toISOString(), verificacao: null });
  },
  async testar() {
    await esperar(400);
    exigirSuperAdmin();
    for (const s of setores) for (const n of s.numeros) n.naConta = true;
    conexao.verificacao = { em: new Date().toISOString(), tokenOk: true, erroToken: null, modelos: 3, assinaturaMensagem: conexao.verificacao?.assinaturaMensagem ?? false, assinaturaStatus: conexao.verificacao?.assinaturaStatus ?? false };
    return conexao.verificacao;
  },
  async assinar() {
    await esperar(400);
    exigirSuperAdmin();
    if (conexao.verificacao) Object.assign(conexao.verificacao, { assinaturaMensagem: true, assinaturaStatus: true });
    return { criadas: ["MESSAGE", "MESSAGE_STATUS"] };
  },
  async enviarTeste() {
    await esperar(400);
    exigirSuperAdmin();
    return { ok: true, erro: null as string | null, aviso: "Modo simulado: nada foi enviado." };
  },
};

