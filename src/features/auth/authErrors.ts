import { AuthError } from "@supabase/supabase-js";
export const INVALID_EMAIL = "Informe um e-mail válido.";

/** Erro de autenticação já com a mensagem pronta para a tela. */
export class AuthFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFailure";
  }
}

// Só erros de quem JÁ está logado (sair, trocar senha). Login e "esqueci a senha" passam pelo
// gateway e têm mensagem única (lib/authGateway.ts): nada aqui pode dizer se uma conta existe.
const MESSAGES: Record<string, string> = {
  over_request_rate_limit: "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.",
  same_password: "A nova senha precisa ser diferente da atual.",
  weak_password: "A senha não atende aos requisitos de segurança.",
  session_not_found: "O link expirou. Peça um novo em “Esqueci minha senha”.",
};

/** Traduz o erro do Supabase Auth; nunca repassa a mensagem nem o código técnico para a tela. */
export function toAuthFailure(error: unknown, fallback: string): AuthFailure {
  if (error instanceof AuthFailure) return error;
  if (error instanceof AuthError) {
    const message = (error.code && MESSAGES[error.code]) || (error.status === 429 ? MESSAGES.over_request_rate_limit : null);
    if (message) return new AuthFailure(message);
    // Detalhe técnico só no console do próprio usuário (código e status, sem a mensagem do Auth).
    console.error("[auth] erro não mapeado", error.name, error.status, error.code);
    if (!error.status) return new AuthFailure("Sem conexão com o servidor. Confira a internet e tente de novo.");
    return new AuthFailure(fallback);
  }
  console.error("[auth] erro inesperado", error instanceof Error ? error.name : typeof error);
  return new AuthFailure(fallback);
}
