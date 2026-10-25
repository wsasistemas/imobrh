// IA nos tickets — triagem por equipe (docs/PLANO-ia-triagem-solucoes.md, IA-2).
// Chamada pelo pg_cron a cada 1 min (job imobdesk-ia-1min), sem JWT: a autenticação é o cabeçalho
// x-atendimento-chave (chave no Vault). Também aceita a supervisão geral logada (rodar agora).
//
//   {acao: "triagem"}  classifica até 10 tickets sem equipe de setores com IA ligada (ch_ia_pendentes) e
//                      identifica o empreendimento de até 10 tickets sem ele (ch_ia_empreendimentos_pendentes, CFTV)
//   {acao: "resumir", ticketId}  pessoa logada que vê o ticket: sugere a "Solução aplicada" a partir da conversa
//                                 (diálogo "Foi resolvido?" ao encerrar o WhatsApp; o atendente revisa)
//
// Para cada ticket: limpa e mascara o texto, pede ao Gemini a equipe e o serviço SÓ entre os do setor, valida a
// resposta e grava em ch_ia_registrar (que aplica sozinho no modo automático com confiança ≥ limiar).
// Secrets: GEMINI_API_KEY (chave da WSA), APP_PORTAL_ATENDIMENTO_IA_MODELO e _RESERVA (opcionais).

import { createClient } from "npm:@supabase/supabase-js@2";
import { clienteServico, paraCadaEmpresa } from "../_shared/empresa.ts";
import { corsHeaders, errorResponse, json, PortalError, portalContext, type AdminClient } from "../_shared/portal.ts";
import { classificarComGemini } from "../_shared/ia/gemini.ts";
import {
  ESQUEMA_CLASSIFICACAO,
  montarPedido,
  prepararTicket,
  REGRAS_FIXAS,
  validarClassificacao,
  type EquipeCandidata,
  type ServicoCandidato,
} from "../_shared/ia/triagem.ts";
import { ESQUEMA_EMPREENDIMENTO, montarPedidoEmpreendimento, REGRAS_EMPREENDIMENTO, validarIdentificacao, type EmpreendimentoCandidato } from "../_shared/ia/empreendimento.ts";
import { ESQUEMA_RESUMO, montarConversa, REGRAS_RESUMO, validarResumo, type AcaoParaResumo } from "../_shared/ia/resumo.ts";

interface Pendente {
  ticketId: number;
  assunto: string;
  descricao: string;
  equipes: EquipeCandidata[];
  servicos: ServicoCandidato[];
}

interface PendenteEmpreendimento {
  ticketId: number;
  assunto: string;
  descricao: string;
  empreendimentos: EmpreendimentoCandidato[];
}

function iguais(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const corpo = (await req.clone().json().catch(() => ({}))) as { acao?: string; ticketId?: number };

    // ---------- resumir: quem vê o ticket (o banco confere pela RPC chamada com o token da pessoa) ----------
    if (corpo.acao === "resumir") {
      await portalContext(req);
      const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const comoUsuario = createClient(url, anon, {
        db: { schema: "imobdesk" },
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const det = await comoUsuario.rpc("ch_ticket_detalhe", { p_id: Number(corpo.ticketId) });
      if (det.error) throw new PortalError("NOT_FOUND", "Ticket não encontrado.", 404);
      const t = det.data as { assunto: string; acoes: AcaoParaResumo[] };
      const chaveIa = Deno.env.get("GEMINI_API_KEY") ?? "";
      if (!chaveIa) throw new PortalError("AI_NOT_CONFIGURED", "Falta o secret GEMINI_API_KEY nas Edge Functions.");
      const r = await classificarComGemini(fetch, {
        chave: chaveIa,
        modelo: Deno.env.get("APP_PORTAL_ATENDIMENTO_IA_MODELO") || "gemini-3.6-flash",
        reserva: Deno.env.get("APP_PORTAL_ATENDIMENTO_IA_RESERVA") || "gemini-flash-latest",
        sistema: REGRAS_RESUMO,
        pedido: montarConversa(t.assunto, t.acoes ?? []),
        esquema: ESQUEMA_RESUMO,
      });
      const resumo = validarResumo(r.json);
      if (!resumo) throw new PortalError("AI_LIMIT", "A IA não conseguiu resumir esta conversa. Escreva a solução.");
      return json({ ...resumo, modelo: r.modelo });
    }

    const chaveIa = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!chaveIa) throw new PortalError("INTEGRATION_NOT_CONFIGURED", "Falta o secret GEMINI_API_KEY nas Edge Functions.");

    // pg_cron (chave do Vault): todas as empresas; supervisão geral logada ("rodar agora"): só a empresa dela.
    const chave = await clienteServico().rpc("at_ia_cron_chave");
    if (iguais(req.headers.get("x-atendimento-chave") ?? "", (chave.data as string | null) ?? "")) {
      return json(await paraCadaEmpresa((db) => triagem(db, chaveIa)));
    }
    const { caller, admin } = await portalContext(req);
    const [perfil, sup] = await Promise.all([
      admin.rpc("perfil_de", { p_usuario: caller.id }),
      admin.rpc("tem_permissao_de", { p_usuario: caller.id, p_permissao: "gestao_atendimento_supervisao" }),
    ]);
    if (!(perfil.data === "super_admin" || sup.data === true)) throw new PortalError("FORBIDDEN", "Só a supervisão geral roda a triagem.", 403);
    return json(await triagem(admin, chaveIa));
  } catch (error) {
    return errorResponse(error);
  }
});

/** Triagem por equipe e identificação do empreendimento nos tickets pendentes de uma empresa (db preso a ela). */
async function triagem(db: AdminClient, chaveIa: string) {
  const modelo = Deno.env.get("APP_PORTAL_ATENDIMENTO_IA_MODELO") || "gemini-3.6-flash";
  const reserva = Deno.env.get("APP_PORTAL_ATENDIMENTO_IA_RESERVA") || "gemini-flash-latest";

  const { data, error } = await db.rpc("ch_ia_pendentes", { p_limite: 10 });
  if (error) throw new Error(error.message);
  const resultados: Record<string, unknown>[] = [];
  for (const t of (data ?? []) as Pendente[]) {
    const inicio = Date.now();
    let registro: Record<string, unknown>;
    try {
      if (t.equipes.length === 0) throw new Error("O setor não tem equipes ativas.");
      const r = await classificarComGemini(fetch, {
        chave: chaveIa,
        modelo,
        reserva,
        sistema: REGRAS_FIXAS,
        pedido: montarPedido(prepararTicket(t.assunto, t.descricao), t.equipes, t.servicos),
        esquema: ESQUEMA_CLASSIFICACAO,
      });
      const c = validarClassificacao(r.json, t.equipes, t.servicos);
      registro = c
        ? { ...c, modelo: r.modelo, tokensEntrada: r.tokensEntrada, tokensSaida: r.tokensSaida, ms: Date.now() - inicio }
        : { erro: "Resposta da IA fora das equipes do setor.", modelo: r.modelo, ms: Date.now() - inicio };
    } catch (e) {
      registro = { erro: String(e instanceof Error ? e.message : e).slice(0, 500), modelo, ms: Date.now() - inicio };
    }
    const g = await db.rpc("ch_ia_registrar", { p_ticket: t.ticketId, p: registro });
    resultados.push({ ticket: t.ticketId, ...(g.error ? { erro: g.error.message } : (g.data as Record<string, unknown>)) });
  }
  console.log(JSON.stringify({ evento: "ia.triagem", resultados }));

  // Empreendimento (Administração › Empreendimentos): mesmos cuidados; aplica sozinho a partir do limiar do setor.
  const pend = await db.rpc("ch_ia_empreendimentos_pendentes", { p_limite: 10 });
  if (pend.error) throw new Error(pend.error.message);
  const empreendimentos: Record<string, unknown>[] = [];
  for (const t of (pend.data ?? []) as PendenteEmpreendimento[]) {
    const inicio = Date.now();
    let registro: Record<string, unknown>;
    try {
      if (t.empreendimentos.length === 0) throw new Error("Nenhum empreendimento ativo no cadastro.");
      const r = await classificarComGemini(fetch, {
        chave: chaveIa,
        modelo,
        reserva,
        sistema: REGRAS_EMPREENDIMENTO,
        pedido: montarPedidoEmpreendimento(prepararTicket(t.assunto, t.descricao), t.empreendimentos),
        esquema: ESQUEMA_EMPREENDIMENTO,
      });
      const c = validarIdentificacao(r.json, t.empreendimentos);
      registro = c
        ? { ...c, modelo: r.modelo, tokensEntrada: r.tokensEntrada, tokensSaida: r.tokensSaida, ms: Date.now() - inicio }
        : { erro: "Resposta da IA fora do formato.", modelo: r.modelo, ms: Date.now() - inicio };
    } catch (e) {
      registro = { erro: String(e instanceof Error ? e.message : e).slice(0, 500), modelo, ms: Date.now() - inicio };
    }
    const g = await db.rpc("ch_ia_empreendimento_registrar", { p_ticket: t.ticketId, p: registro });
    empreendimentos.push({ ticket: t.ticketId, ...(g.error ? { erro: g.error.message } : (g.data as Record<string, unknown>)) });
  }
  if (empreendimentos.length) console.log(JSON.stringify({ evento: "ia.empreendimento", resultados: empreendimentos }));
  return { resultados, empreendimentos };
}
