import { edgeFunction } from "../../../config/app";
import type { Json } from "../../../lib/database.types";
import { supabase } from "../../../lib/supabase";
import { DATA_SOURCE } from "../../configuracoes/services";
import { fromFunction, fromPostgrest } from "../../configuracoes/services/supabase/errors";
import { ServiceError } from "../../configuracoes/services/types";
import { esperar, mockContexto } from "./mock";

// Gestão de Atendimento › Central Email (estrutura da Movidesk). Cada conta pertence a um setor.
// Leitura pela RPC at_email_contas_lista (sem segredo); escrita pelas RPCs at_email_conta_*; teste pela
// Edge Function <schema>-email. A chave do Google fica em Integrações › Google Workspace.

export type ProvedorEmail = "google" | "outlook" | "exchange" | "yahoo" | "uol" | "bol" | "terra" | "ig" | "ibest" | "manual";
export type ModoEmail = "oauth_google" | "api_google" | "imap_smtp";
export type AbrirTickets = "qualquer" | "cliente" | "cliente_ou_dominio" | "dominio" | "nao";

export interface PassoTeste {
  passo: string;
  ok: boolean;
  detalhe: string;
}

export interface VerificacaoEmail {
  em: string;
  ok: boolean;
  passos: PassoTeste[];
}

export interface ContaEmailDados {
  nome: string;
  email: string;
  setorId: number | null;
  nomeRemetente: string;
  exibirNoEnvio: boolean;
  padraoDoSetor: boolean;
  usarLogo: boolean;
  habilitada: boolean;
  provedor: ProvedorEmail;
  modo: ModoEmail;
  imapHost: string;
  imapPorta: number;
  imapSeguranca: "ssl" | "starttls";
  smtpHost: string;
  smtpPorta: number;
  usuario: string;
  pasta: string;
  intervaloMin: number;
  lerDesde: string;
  marcarLido: boolean;
  moverPara: string;
  juntarRespostas: boolean;
  ignorarRemetentes: string[];
  responderPara: string;
  copiaOculta: string;
  assinatura: string;
  receberHabilitado: boolean;
  apagarAposDias: number | null;
  abrirTickets: AbrirTickets;
  /** Regra "Só domínio": domínios aceitos para ticket novo (sem @). */
  dominiosPermitidos: string[];
}

export interface ContaEmail extends ContaEmailDados {
  oauthEmail: string | null;
  oauthAutorizadoEm: string | null;
  oauthAutorizadoPor: string | null;
  id: number;
  setorNome: string | null;
  senhaMascara: string | null;
  status: "conectado" | "falha" | "aguardando";
  ultimoErro: string | null;
  ultimaLeituraEm: string | null;
  verificacao: VerificacaoEmail | null;
  naFila: number;
}

/** Servidores sugeridos por provedor (como o "Selecione o provedor" da Movidesk). */
export const PROVEDORES: { id: ProvedorEmail; rotulo: string; imap: string; smtp: string; aviso?: string }[] = [
  { id: "google", rotulo: "Google Workspace / Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  { id: "outlook", rotulo: "Outlook / Microsoft 365", imap: "outlook.office365.com", smtp: "smtp.office365.com", aviso: "O Microsoft 365 só aceita envio pela porta 587, que o servidor do portal bloqueia. O recebimento funciona; o envio por essas contas exige outra solução." },
  { id: "exchange", rotulo: "Exchange", imap: "", smtp: "" },
  { id: "yahoo", rotulo: "Yahoo", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  { id: "uol", rotulo: "Uol", imap: "imap.uol.com.br", smtp: "smtps.uol.com.br" },
  { id: "bol", rotulo: "Bol", imap: "imap.bol.com.br", smtp: "smtps.bol.com.br" },
  { id: "terra", rotulo: "Terra", imap: "imap.terra.com.br", smtp: "smtp.terra.com.br" },
  { id: "ig", rotulo: "Ig", imap: "imap.ig.com.br", smtp: "smtp.ig.com.br" },
  { id: "ibest", rotulo: "IBest", imap: "imap.ibest.com.br", smtp: "smtp.ibest.com.br" },
  { id: "manual", rotulo: "Definir manualmente", imap: "", smtp: "" },
];

export function contaNova(setorId: number | null): ContaEmailDados {
  return {
    nome: "", email: "", setorId, nomeRemetente: "", exibirNoEnvio: true, padraoDoSetor: false, usarLogo: false, habilitada: true,
    provedor: "google", modo: "oauth_google", imapHost: "imap.gmail.com", imapPorta: 993, imapSeguranca: "ssl", smtpHost: "smtp.gmail.com", smtpPorta: 465,
    usuario: "", pasta: "INBOX", intervaloMin: 1, lerDesde: new Date().toISOString().slice(0, 10), marcarLido: true, moverPara: "",
    juntarRespostas: true, ignorarRemetentes: ["mailer-daemon@", "noreply@", "no-reply@"], responderPara: "", copiaOculta: "", assinatura: "",
    receberHabilitado: true, apagarAposDias: null, abrirTickets: "qualquer", dominiosPermitidos: ["exemplo.com.br"],
  };
}

/** Aplicativo OAuth do portal (Central Email › Aplicativo do Google). A chave secreta nunca volta para a tela. */
export interface AppGoogle {
  clientId: string | null;
  definidoEm: string | null;
}

export interface EmailService {
  lista(): Promise<ContaEmail[]>;
  salvar(p: ContaEmailDados & { id?: number }): Promise<number>;
  senha(id: number, senha: string): Promise<void>;
  habilitar(ids: number[], habilitada: boolean): Promise<number>;
  excluir(id: number): Promise<void>;
  testar(id: number, enviarPara?: string): Promise<VerificacaoEmail>;
  /** URL do "Autorizar com Gmail" (abre numa janela; o Google volta para /oauth/google). */
  autorizarGoogle(id: number): Promise<string>;
  appGoogle(): Promise<AppGoogle>;
  salvarAppGoogle(clientId: string, clientSecret: string): Promise<void>;
}

async function rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(nome as never, args as never);
  if (error) throw fromPostgrest(error);
  return data as T;
}

async function funcao<T>(corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(edgeFunction("email"), { body: corpo });
  if (error) throw await fromFunction(error);
  return data as T;
}

const supabaseEmail: EmailService = {
  lista: () => rpc<ContaEmail[]>("at_email_contas_lista"),
  salvar: (p) => rpc<number>("at_email_conta_salvar", { p: p as unknown as Json }),
  senha: (id, senha) => rpc<void>("at_email_conta_senha", { p_id: id, p_senha: senha }),
  habilitar: (ids, habilitada) => rpc<number>("at_email_conta_habilitar", { p_ids: ids, p_habilitada: habilitada }),
  excluir: (id) => rpc<void>("at_email_conta_excluir", { p_id: id }),
  testar: (id, enviarPara) => funcao<VerificacaoEmail>({ acao: "testar", contaId: id, enviarPara: enviarPara ?? null }),
  async autorizarGoogle(id) {
    const r = await funcao<{ url: string }>({ acao: "oauth_iniciar", contaId: id, retorno: window.location.origin });
    return r.url;
  },
  async appGoogle() {
    // at_config só é visível para o super admin (RLS): para os demais volta vazio.
    const { data, error } = await supabase.from("at_config").select("google_oauth_client_id, google_oauth_definido_em").maybeSingle();
    if (error) throw fromPostgrest(error);
    return { clientId: data?.google_oauth_client_id ?? null, definidoEm: data?.google_oauth_definido_em ?? null };
  },
  salvarAppGoogle: (clientId, clientSecret) => rpc<void>("at_google_oauth_salvar", { p_client_id: clientId, p_client_secret: clientSecret }),
};

// ---------- Modo simulado (as contas do mockup) ----------

type ContaMock = ContaEmail & { senha: string | null; historico: boolean };
let seq = 20;
// Setores que recebem chamado, com os ids da produção (src/features/atendimento/services/mock.ts).
const setorPorNome = (nome: string) => ({ "TI -  Suporte": 20, CFTV: 21, Administrativo: 22, Financeiro: 23 } as Record<string, number>)[nome] ?? 20;
const base = (id: number, nome: string, email: string, setor: string, extra: Partial<ContaMock> = {}): ContaMock => ({
  ...contaNova(setorPorNome(setor)),
  id, nome, email, setorNome: setor, nomeRemetente: `Construtora Exemplo · ${nome}`, senhaMascara: null, status: "conectado", ultimoErro: null,
  ultimaLeituraEm: new Date(Date.now() - 60_000).toISOString(), verificacao: null, naFila: 0, senha: null, historico: true,
  oauthEmail: email, oauthAutorizadoEm: new Date(Date.now() - 86_400_000).toISOString(), oauthAutorizadoPor: "Wagner Antunes", ...extra,
});
const contas: ContaMock[] = [
  base(1, "CFTV", "cftv@exemplo.com.br", "CFTV", { padraoDoSetor: true }),
  base(2, "Cobrança", "cobranca@exemplo.com.br", "Financeiro", { naFila: 1, padraoDoSetor: true }),
  base(3, "Administrativo", "administrativo@exemplo.com.br", "Administrativo", { padraoDoSetor: true }),
  base(4, "Dept° Pessoal", "dp@exemplo.com.br", "Administrativo", {
    provedor: "manual", modo: "imap_smtp", imapHost: "imap.exemplo.com.br", smtpHost: "smtp.exemplo.com.br", usuario: "dp@exemplo.com.br",
    senhaMascara: "••••••••4f", senha: "x", status: "falha", ultimoErro: "Invalid credentials (Failure)", ultimaLeituraEm: new Date(Date.now() - 7_200_000).toISOString(),
  }),
  base(5, "Jurídico", "juridico@exemplo.com.br", "Administrativo", { status: "aguardando", ultimaLeituraEm: null, historico: false, oauthEmail: null, oauthAutorizadoEm: null, oauthAutorizadoPor: null }),
  base(6, "chamados.sistemas@exemplo.com.br", "chamados.sistemas@exemplo.com.br", "TI -  Suporte", { padraoDoSetor: true, status: "aguardando", ultimaLeituraEm: null }),
];

const appMock: AppGoogle = { clientId: null, definidoEm: null };

async function contexto() {
  return mockContexto.contexto();
}

async function exigirSupervisor() {
  if (!(await contexto()).supervisor) throw new ServiceError("FORBIDDEN", "Só a supervisão geral cadastra contas de e-mail.");
}

const mockEmail: EmailService = {
  async lista() {
    const ctx = await contexto();
    const meus = new Set(ctx.setores.filter((s) => s.papel !== "atendente").map((s) => s.id));
    return contas.filter((c) => ctx.supervisor || meus.has(c.setorId ?? 0)).map(({ senha: _s, historico: _h, ...c }) => structuredClone(c));
  },
  async salvar(p) {
    await exigirSupervisor();
    const email = p.email.trim().toLowerCase();
    if (p.nome.trim().length < 2) throw new ServiceError("INVALID_INPUT", "Informe o nome da conta (2 a 80 letras).", "nome");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ServiceError("INVALID_INPUT", "Endereço de e-mail inválido.", "email");
    if (contas.some((c) => c.email === email && c.id !== p.id)) throw new ServiceError("DUPLICATE", "Já existe uma conta com esse endereço.", "email");
    if (p.modo !== "imap_smtp" && p.provedor !== "google") throw new ServiceError("INVALID_INPUT", "A autorização pelo Google só existe para contas do Google Workspace / Gmail.", "modo");
    if (p.modo === "imap_smtp" && (!p.imapHost.trim() || !p.smtpHost.trim())) throw new ServiceError("INVALID_INPUT", "Informe os servidores de entrada (IMAP) e de saída (SMTP).", "imapHost");
    if ([25, 587].includes(p.smtpPorta)) throw new ServiceError("INVALID_INPUT", "Use a porta 465 (SSL): o servidor do portal bloqueia as portas 25 e 587.", "smtpPorta");
    const setorNome = (await contexto()).setores.find((s) => s.id === p.setorId)?.nome ?? null;
    if (p.setorId && p.padraoDoSetor) for (const c of contas) if (c.setorId === p.setorId && c.id !== p.id) c.padraoDoSetor = false;
    const existente = contas.find((c) => c.id === p.id);
    if (existente) {
      // A autorização do Google não vem do formulário (como no banco, a gravação não mexe nela).
      const { oauthEmail, oauthAutorizadoEm, oauthAutorizadoPor } = existente;
      Object.assign(existente, p, { email, setorNome, status: existente.modo !== p.modo ? "aguardando" : existente.status, oauthEmail, oauthAutorizadoEm, oauthAutorizadoPor });
      return existente.id;
    }
    const nova: ContaMock = { ...p, id: ++seq, email, setorNome, senhaMascara: null, status: "aguardando", ultimoErro: null, ultimaLeituraEm: null, verificacao: null, naFila: 0, senha: null, historico: false, oauthEmail: null, oauthAutorizadoEm: null, oauthAutorizadoPor: null };
    contas.push(nova);
    return nova.id;
  },
  async senha(id, senha) {
    await exigirSupervisor();
    if (senha.length < 4) throw new ServiceError("INVALID_INPUT", "Informe a senha da conta (ou a senha de app).", "senha");
    const c = contas.find((x) => x.id === id);
    if (!c) throw new ServiceError("NOT_FOUND", "Conta não encontrada.");
    Object.assign(c, { senha, senhaMascara: `••••••••${senha.slice(-2)}`, status: "aguardando" });
  },
  async habilitar(ids, habilitada) {
    await exigirSupervisor();
    let n = 0;
    for (const c of contas) {
      if (!ids.includes(c.id)) continue;
      c.habilitada = habilitada;
      n++;
    }
    return n;
  },
  async excluir(id) {
    await exigirSupervisor();
    const c = contas.find((x) => x.id === id);
    if (!c) throw new ServiceError("NOT_FOUND", "Conta não encontrada.");
    if (c.historico) throw new ServiceError("INVALID_INPUT", "Esta conta já tem e-mails no histórico. Desabilite em vez de excluir.");
    contas.splice(contas.indexOf(c), 1);
  },
  async testar(id, enviarPara) {
    await esperar(700);
    await exigirSupervisor();
    const c = contas.find((x) => x.id === id);
    if (!c) throw new ServiceError("NOT_FOUND", "Conta não encontrada.");
    const passos: PassoTeste[] =
      c.modo === "oauth_google"
        ? c.oauthEmail
          ? [
              { passo: "Autorização do Google (OAuth)", ok: true, detalhe: `autorizado como ${c.oauthEmail}` },
              { passo: `Leitura da pasta ${c.pasta}`, ok: true, detalhe: "128 e-mails, 3 não lidos" },
            ]
          : [{ passo: "Autorização do Google (OAuth)", ok: false, detalhe: "A caixa ainda não foi autorizada: clique em Autorizar com Gmail." }]
        : [
            { passo: `Conexão com ${c.imapHost}:${c.imapPorta}`, ok: true, detalhe: "* OK pronto" },
            c.senha ? { passo: `Login de ${c.usuario || c.email}`, ok: true, detalhe: "aceito" } : { passo: `Login de ${c.usuario || c.email}`, ok: false, detalhe: "Senha não informada." },
          ];
    if (enviarPara && passos.every((p) => p.ok)) passos.push({ passo: `E-mail de teste para ${enviarPara}`, ok: true, detalhe: "Modo simulado: nada foi enviado." });
    const ok = passos.every((p) => p.ok);
    c.verificacao = { em: new Date().toISOString(), ok, passos };
    c.status = ok ? "conectado" : "falha";
    c.ultimoErro = ok ? null : (passos.find((p) => !p.ok)?.detalhe ?? null);
    return c.verificacao;
  },
  async autorizarGoogle(id) {
    await esperar(300);
    await exigirSupervisor();
    const c = contas.find((x) => x.id === id);
    if (!c) throw new ServiceError("NOT_FOUND", "Conta não encontrada.");
    // Modo simulado: finge o vaivém com o Google e já volta autorizado.
    Object.assign(c, { modo: "oauth_google", oauthEmail: c.email, oauthAutorizadoEm: new Date().toISOString(), oauthAutorizadoPor: "Você", status: "conectado", ultimoErro: null });
    return `${window.location.origin}/oauth/google?${new URLSearchParams({ status: "ok", conta: String(id), email: c.email }).toString()}`;
  },
  async appGoogle() {
    await esperar();
    return { ...appMock };
  },
  async salvarAppGoogle(clientId, clientSecret) {
    await esperar();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw new ServiceError("INVALID_INPUT", "ID do cliente inválido: termina em .apps.googleusercontent.com.", "clientId");
    if (!clientSecret.trim() && !appMock.clientId) throw new ServiceError("INVALID_INPUT", "Informe a chave secreta do cliente.", "clientSecret");
    Object.assign(appMock, { clientId: clientId.trim(), definidoEm: new Date().toISOString() });
  },
};

export const emailService: EmailService = DATA_SOURCE === "mock" ? mockEmail : supabaseEmail;
