// Edge Function: cadastro de usuários do Imobdesk (o que precisa da API de admin do Auth).
//
// Ações:
//  - "invite": convida por e-mail. Se a conta já existe no login compartilhado da WSA (usada em
//    outros sistemas), NÃO cria nem mexe na senha: só libera o acesso ao portal.
//  - "create_with_password": cria conta nova com senha temporária (troca obrigatória no 1º acesso).
//    Recusa conta existente: definir senha nela trocaria a senha dela nos outros sistemas.
//  - "set_password": senha temporária para um usuário que já tem acesso ao portal (esqueceu a
//    senha), com troca obrigatória no próximo login. Pedido explícito do admin, avisado na tela de
//    que a senha vale também nos outros sistemas da WSA (login compartilhado).
// Editar, inativar, excluir, exigir troca e redefinir senha por e-mail são RPCs do banco.
import { type AdminClient, errorResponse, fromRpcError, json, PortalError, portalContext, readJson, corsHeaders } from "../_shared/portal.ts";

interface Body {
  action: "invite" | "create_with_password" | "set_password";
  /** Usuário alvo de "set_password". */
  id?: string;
  name: string;
  email: string;
  role: string;
  password?: string;
  /** Página do portal para onde o link do convite leva (precisa estar nas Redirect URLs do Auth). */
  redirectTo?: string;
}

const PASSWORD_RULES: [RegExp, string][] = [
  [/^.{8,}$/, "pelo menos 8 caracteres"],
  [/\p{Lu}/u, "uma letra maiúscula"],
  [/\d/, "um número"],
];

function checkedPassword(value: string | undefined): string {
  const password = value ?? "";
  const missing = PASSWORD_RULES.filter(([rule]) => !rule.test(password)).map(([, label]) => label);
  if (missing.length > 0) {
    throw new PortalError("INVALID_PASSWORD", `A senha temporária precisa de ${missing.join(", ")}.`, 400, "password");
  }
  return password;
}

async function setTemporaryPassword(admin: AdminClient, actorId: string, body: Body) {
  const id = (body.id ?? "").trim();
  if (!id) throw new PortalError("INVALID_INPUT", "Usuário não informado.");
  const password = checkedPassword(body.password);

  // Regras do portal (permissão, proprietário, hierarquia, própria conta) antes de tocar no Auth.
  const check = await admin.rpc("preparar_senha_temporaria", { p_ator: actorId, p_id: id });
  if (check.error) throw fromRpcError(check.error);

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) throw new PortalError("INTERNAL", "Não foi possível definir a senha temporária. Tente novamente.", 502);

  const register = await admin.rpc("registrar_senha_temporaria", { p_ator: actorId, p_id: id });
  if (register.error) throw fromRpcError(register.error);
  return { id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ code: "INVALID_INPUT", message: "Método não suportado." }, 405);

  try {
    const { caller, admin } = await portalContext(req);
    const body = await readJson<Body>(req);
    if (body.action === "set_password") return json(await setTemporaryPassword(admin, caller.id, body));
    const email = (body.email ?? "").trim().toLowerCase();
    const name = (body.name ?? "").trim();

    if (body.action !== "invite" && body.action !== "create_with_password") {
      throw new PortalError("INVALID_INPUT", "Ação inválida.");
    }

    // 1) Regras do portal (permissão, domínio, e-mail já cadastrado, hierarquia) antes de tocar no Auth.
    const validation = await admin.rpc("validar_cadastro_usuario", { p_ator: caller.id, p_email: email, p_perfil: body.role });
    if (validation.error) throw fromRpcError(validation.error);

    const existing = await admin.rpc("buscar_usuario_auth", { p_email: email });
    if (existing.error) throw fromRpcError(existing.error);
    const existingId = (existing.data as string | null) ?? null;

    // 2) Conta de login.
    let userId: string;
    let form: "convite" | "senha" | "existente";
    let createdHere = false;

    if (body.action === "invite") {
      if (existingId) {
        userId = existingId;
        form = "existente";
      } else {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: body.redirectTo,
          data: { full_name: name },
        });
        if (error || !data.user) throw new PortalError("INVITE_FAILED", "Não foi possível enviar o convite. Tente novamente.", 502);
        userId = data.user.id;
        form = "convite";
        createdHere = true;
      }
    } else {
      if (existingId) {
        throw new PortalError(
          "ACCOUNT_EXISTS",
          "Esta pessoa já tem conta de login em outro sistema WSA (usada em outros sistemas). Use “Enviar convite”: o acesso é liberado sem trocar a senha dela.",
          400,
          "email",
        );
      }
      const password = checkedPassword(body.password);
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error || !data.user) throw new PortalError("CREATE_FAILED", "Não foi possível criar a conta. Tente novamente.", 502);
      userId = data.user.id;
      form = "senha";
      createdHere = true;
    }

    // 3) Acesso ao portal + auditoria (revalida as regras dentro da mesma transação).
    const register = await admin.rpc("cadastrar_usuario_portal", {
      p_ator: caller.id,
      p_id: userId,
      p_email: email,
      p_nome: name,
      p_perfil: body.role,
      p_forma: form,
    });
    if (register.error) {
      // Desfaz a conta criada agora (nunca uma que já existia no login compartilhado).
      if (createdHere) await admin.auth.admin.deleteUser(userId);
      throw fromRpcError(register.error);
    }

    return json({ id: userId, form });
  } catch (error) {
    return errorResponse(error);
  }
});
