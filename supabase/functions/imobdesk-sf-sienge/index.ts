// Solicitações Financeiras, Fase 5 (parte 2): integração SIENGE e PDF do formulário (CONTEXTO.md, seção 6).
// Chamada pelo portal com o token da pessoa. Ações:
//   testar  {}                                             Admin: confere subdomínio, usuário e senha (GET /cost-centers e /creditors)
//   listas  {}                                             Financeiro/Admin: centros de custo, planos financeiros e tipos de documento
//   lancar  {solicitacaoId, centroCustoId, plano, vencimento}  Financeiro: credor pelo CPF, procura título com o mesmo número
//                                                          (idempotência), POST /bills e anexa o PDF do formulário e os comprovantes
//   lancar_saldo {solicitacaoId, centroCustoId, plano, vencimento}  Financeiro: adiantamento comprovado com nota maior que o
//                                                          adiantado; título SF-…-S do saldo do pedido contra a nota (anexa a nota)
//   pdf     {solicitacaoId}                                quem vê a solicitação: PDF do formulário (layout 2026)
// Credenciais na tabela sf_sienge_config (senha no Vault). Credor inexistente = erro claro, sem cadastro automático.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, fromRpcError, json, PortalError, portalContext, type AdminClient } from "../_shared/portal.ts";
import {
  autorizacao, faltandoNaConfig, filtroCredor, idDoTitulo, mensagemSienge, montarTitulo, planoDoTipo, resultados, urlBase, validarEscolhas,
  type ConfigSienge, type PedidoLancamento,
} from "../_shared/sf/sienge.ts";
import { gerarPdf, type DadosPdf } from "./pdf.ts";

const BUCKET = "imobdesk-sf-comprovantes";
const TIMEOUT = 30_000;

interface Corpo {
  acao?: string;
  solicitacaoId?: number;
  centroCustoId?: number;
  plano?: string;
  vencimento?: string;
  obraId?: number | null;
  unidadeId?: number | null;
}

function comoUsuario(req: Request) {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    db: { schema: "imobdesk" },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function config(db: AdminClient): Promise<ConfigSienge> {
  const { data, error } = await db.rpc("sf_sienge_credenciais");
  if (error) throw fromRpcError(error);
  return data as ConfigSienge;
}

/** Chamada à API do SIENGE com Basic e timeout. */
async function sienge(c: ConfigSienge, metodo: string, caminho: string, corpo?: unknown | FormData): Promise<{ status: number; corpo: unknown; location: string | null }> {
  const form = corpo instanceof FormData;
  const r = await fetch(`${urlBase(c.subdominio!)}${caminho}`, {
    method: metodo,
    headers: { Authorization: autorizacao(c.usuario!, c.senha!), Accept: "application/json", ...(corpo && !form ? { "Content-Type": "application/json" } : {}) },
    body: corpo === undefined ? undefined : form ? (corpo as FormData) : JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const texto = await r.text();
  if (!r.ok) throw new PortalError("SIENGE_ERROR", mensagemSienge(r.status, texto), 502);
  let j: unknown = null;
  try {
    j = texto ? JSON.parse(texto) : null;
  } catch {
    j = texto;
  }
  return { status: r.status, corpo: j, location: r.headers.get("Location") ?? r.headers.get("location") };
}

async function exigir(req: Request, rpc: string): Promise<{ admin: boolean; financeiro: boolean }> {
  const r = await comoUsuario(req).rpc(rpc);
  if (r.error) throw new PortalError("FORBIDDEN", r.error.message, 403);
  return r.data as { admin: boolean; financeiro: boolean };
}

async function pdfDe(req: Request, id: number): Promise<Uint8Array<ArrayBuffer>> {
  const r = await comoUsuario(req).rpc("sf_pdf_dados", { p_id: id });
  if (r.error) throw new PortalError("NOT_FOUND", "Solicitação não encontrada.", 404);
  const d = r.data as DadosPdf & { totalDespesas: number | string };
  // Nome da empresa aberta por quem pediu (cabeçalho do formulário).
  const pref = await comoUsuario(req).rpc("minhas_preferencias");
  const empresa = (pref.data as { empresaNome?: string | null } | null)?.empresaNome ?? undefined;
  const bytes = await gerarPdf({
    ...d,
    empresa,
    totalDespesas: Number(d.totalDespesas), valorGlosado: Number(d.valorGlosado), valorAPagar: d.valorAPagar == null ? null : Number(d.valorAPagar),
    valorFundoFixo: d.valorFundoFixo == null ? null : Number(d.valorFundoFixo), saldoInicial: d.saldoInicial == null ? null : Number(d.saldoInicial),
    saldoFinal: d.saldoFinal == null ? null : Number(d.saldoFinal), itens: d.itens.map((i) => ({ ...i, valor: i.valor == null ? null : Number(i.valor) })),
  });
  return new Uint8Array(bytes);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  let lancando: number | null = null;
  let lancandoSaldo = false;
  let adminDb: AdminClient | null = null;
  let ator: string | null = null;
  try {
    const ctx = await portalContext(req);
    adminDb = ctx.admin;
    ator = ctx.caller.id;
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const acao = String(corpo.acao ?? "");

    if (acao === "pdf") {
      const bytes = await pdfDe(req, Number(corpo.solicitacaoId ?? 0));
      return new Response(bytes, { headers: { ...corsHeaders, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=formulario.pdf" } });
    }

    if (acao === "testar") {
      const papel = await exigir(req, "sf_sienge_pode_usar");
      if (!papel.admin) throw new PortalError("FORBIDDEN", "Só Admin testa a integração.", 403);
      const c = await config(ctx.admin);
      if (!c.subdominio || !c.usuario || !c.senha) throw new PortalError("INVALID_INPUT", "Preencha subdomínio, usuário e senha e salve antes de testar.");
      const passos: { passo: string; ok: boolean; detalhe: string }[] = [];
      for (const [passo, caminho] of [["Centros de custo", "/cost-centers?limit=1"], ["Credores", "/creditors?limit=1"], ["Planos financeiros", "/payment-categories?limit=1"]] as const) {
        const inicio = Date.now();
        try {
          const r = await sienge(c, "GET", caminho);
          const meta = (r.corpo as { resultSetMetadata?: { count?: number } } | null)?.resultSetMetadata;
          passos.push({ passo, ok: true, detalhe: `${meta?.count != null ? `${meta.count} cadastrados` : "respondeu"} (${Date.now() - inicio} ms)` });
        } catch (e) {
          passos.push({ passo, ok: false, detalhe: e instanceof Error ? e.message : String(e) });
        }
      }
      const ok = passos.every((p) => p.ok);
      await ctx.admin.rpc("sf_sienge_teste_registrar", { p: { ok, passos } });
      return json({ ok, passos });
    }

    if (acao === "listas") {
      const papel = await exigir(req, "sf_sienge_pode_usar");
      if (!papel.financeiro) throw new PortalError("FORBIDDEN", "Só o Financeiro consulta o SIENGE.", 403);
      const c = await config(ctx.admin);
      if (!c.subdominio || !c.usuario || !c.senha) throw new PortalError("INTEGRATION_NOT_CONFIGURED", "Integração SIENGE não configurada.");
      const [cc, pc, di] = await Promise.all([
        sienge(c, "GET", "/cost-centers?limit=200"),
        sienge(c, "GET", "/payment-categories?limit=200"),
        sienge(c, "GET", "/document-identifications?limit=200"),
      ]);
      return json({
        centrosCusto: resultados<{ id: number; name: string }>(cc.corpo).map((x) => ({ id: x.id, nome: x.name })),
        planos: resultados<{ id: number; name: string }>(pc.corpo).map((x) => ({ id: String(x.id), nome: x.name })),
        documentos: resultados<{ id: string; name?: string; description?: string }>(di.corpo).map((x) => ({ id: x.id, nome: x.name ?? x.description ?? x.id })),
        padroes: { planoReembolso: c.planoReembolso, planoFundoFixo: c.planoFundoFixo, planoAdiantamento: c.planoAdiantamento, centroCustoPadrao: c.centroCustoPadrao },
      });
    }

    if (acao === "lancar" || acao === "lancar_saldo") {
      const saldo = acao === "lancar_saldo";
      const id = Number(corpo.solicitacaoId ?? 0);
      const c = await config(ctx.admin);
      const falta = faltandoNaConfig(c);
      if (falta.length) throw new PortalError("INTEGRATION_NOT_CONFIGURED", `Integração SIENGE incompleta: ${falta.join(", ")} (Configurações › Integrações › SIENGE).`);
      const ped = await comoUsuario(req).rpc(saldo ? "sf_lancamento_saldo_pedido" : "sf_lancamento_pedido", { p_id: id });
      if (ped.error) throw fromRpcError(ped.error);
      lancando = id;
      lancandoSaldo = saldo;
      const p = ped.data as PedidoLancamento & { anexos: { path: string; nome: string; mime: string; ordem: number; finalidade?: string }[]; centroCusto?: number | string | null; plano?: string | null };
      const documento = saldo ? `${p.numero}-S` : p.numero;
      const escolhas = {
        centroCustoId: Number(corpo.centroCustoId ?? (saldo ? p.centroCusto : null) ?? c.centroCustoPadrao ?? 0),
        plano: String(corpo.plano ?? (saldo ? p.plano : null) ?? planoDoTipo(c, p.tipo) ?? ""),
        vencimento: String(corpo.vencimento ?? p.pagarAte ?? p.vencimento ?? ""),
        obraId: corpo.obraId == null ? null : Number(corpo.obraId),
        unidadeId: corpo.unidadeId == null ? null : Number(corpo.unidadeId),
      };
      const invalido = validarEscolhas(escolhas);
      if (invalido) throw new PortalError("INVALID_INPUT", invalido);

      // Credor: o colaborador pelo CPF; no adiantamento, o favorecido pelo CPF/CNPJ (sem cadastro automático).
      const cred = resultados<{ id: number; name: string }>((await sienge(c, "GET", `/creditors?${filtroCredor(p.cpf)}&limit=5`)).corpo);
      if (!cred.length) {
        const quem = p.tipo === "adiantamento" ? (p.favorecido ?? "O favorecido") : p.solicitante;
        const doc = p.cpf.length === 14 ? `CNPJ ${p.cpf.slice(0, 2)}.***.***/****-${p.cpf.slice(-2)}` : `CPF ${p.cpf.slice(0, 3)}.***.***-${p.cpf.slice(-2)}`;
        throw new PortalError("SIENGE_CREDITOR_NOT_FOUND", `${quem} não está cadastrado como credor no SIENGE (${doc}). Cadastre o credor no SIENGE e tente de novo.`);
      }
      const credorId = cred[0].id;

      // Idempotência: título com o mesmo número já existe? (busca por emissão nos últimos 120 dias)
      const ate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const de = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
      const procurar = async () =>
        resultados<{ id: number; documentNumber: string }>(
          (await sienge(c, "GET", `/bills?startDate=${de}&endDate=${ate}&creditorId=${credorId}&documentNumber=${encodeURIComponent(documento)}&limit=5`)).corpo,
        ).find((x) => x.documentNumber === documento);
      let tituloId = (await procurar())?.id ?? null;
      const jaExistia = tituloId != null;
      if (!tituloId) {
        const r = await sienge(c, "POST", "/bills", montarTitulo(p, c, { credorId, ...escolhas }, documento));
        tituloId = idDoTitulo(r.corpo, r.location) ?? (await procurar())?.id ?? null;
        if (!tituloId) throw new PortalError("SIENGE_ERROR", "O SIENGE aceitou o título, mas não devolveu o número. Confira no SIENGE pelo documento " + documento + ".");
      }

      // Anexos: PDF do formulário e comprovantes (falha em anexo não desfaz o título; vira aviso).
      const avisos: string[] = [];
      if (!jaExistia) {
        const anexar = async (nome: string, blob: Blob, descricao: string) => {
          const form = new FormData();
          form.append("file", blob, nome.slice(-100));
          try {
            await sienge(c, "POST", `/bills/${tituloId}/attachments?description=${encodeURIComponent(descricao.slice(0, 500))}`, form);
          } catch (e) {
            avisos.push(`${nome}: ${e instanceof Error ? e.message : String(e)}`);
          }
        };
        await anexar(`${p.numero}-formulario.pdf`, new Blob([await pdfDe(req, id)], { type: "application/pdf" }), `Formulário ${p.numero} (Imobdesk)`);
        const rotulo = (a: { finalidade?: string; ordem: number }) =>
          a.finalidade === "documento_origem" ? "Documento de origem" : a.finalidade === "comprovacao" ? "Nota da comprovação" : `Comprovante da linha ${a.ordem}`;
        for (const a of p.anexos) {
          const arq = await ctx.admin.storage.from(BUCKET).download(a.path);
          if (arq.error || !arq.data) {
            avisos.push(`${a.nome}: arquivo não encontrado no portal`);
            continue;
          }
          await anexar(a.nome, arq.data, `${rotulo(a)} · ${p.numero}`);
        }
      }

      const reg = await ctx.admin.rpc(saldo ? "sf_lancamento_saldo_registrar" : "sf_lancamento_registrar", {
        p_id: id, p_ok: true, p_titulo: String(tituloId), p_erro: null,
        p_detalhe: { credorId, centroCusto: escolhas.centroCustoId, plano: escolhas.plano, vencimento: escolhas.vencimento, obraId: escolhas.obraId, atorId: ator, jaExistia, avisos },
      });
      if (reg.error) throw fromRpcError(reg.error);
      lancando = null;
      return json({ titulo: tituloId, jaExistia, avisos, ambiente: c.ambiente });
    }

    throw new PortalError("INVALID_INPUT", `Ação inválida: ${acao}`);
  } catch (error) {
    if (lancando != null && adminDb) {
      const msg = error instanceof Error ? error.message : String(error);
      await adminDb.rpc(lancandoSaldo ? "sf_lancamento_saldo_registrar" : "sf_lancamento_registrar", { p_id: lancando, p_ok: false, p_titulo: null, p_erro: msg, p_detalhe: { atorId: ator } }).then(() => undefined, () => undefined);
    }
    return errorResponse(error);
  }
});
