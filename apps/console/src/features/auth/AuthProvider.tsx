import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isAllowedLoginEmail, STORAGE_PREFIX } from "../../config/app";
import { LOGIN_FAILED_MESSAGE, OFFLINE_MESSAGE, requestResetThroughGateway, signInThroughGateway } from "../../lib/authGateway";
import { SUPABASE_CONFIGURED, supabase } from "../../lib/supabase";
import { authService } from "../configuracoes/services";
import { ServiceError } from "../configuracoes/services/types";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./AuthContext";
import { AuthFailure, INVALID_EMAIL, toAuthFailure } from "./authErrors";

/** Login real (gateway imobdesk-auth + Supabase Auth) ou simulado (sem Supabase no .env.local). */
export function AuthProvider({ children }: { children: ReactNode }) {
  return SUPABASE_CONFIGURED ? <SupabaseAuthProvider>{children}</SupabaseAuthProvider> : <SimulatedAuthProvider>{children}</SimulatedAuthProvider>;
}

const SIMULATED_SESSION_KEY = `${STORAGE_PREFIX}:sessao-simulada`;

function readSimulatedEmail(): string | null {
  try {
    return sessionStorage.getItem(SIMULATED_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSimulatedEmail(value: string | null) {
  try {
    if (value) sessionStorage.setItem(SIMULATED_SESSION_KEY, value);
    else sessionStorage.removeItem(SIMULATED_SESSION_KEY);
  } catch {
    // Sem sessionStorage (aba privada): a sessão simulada vale só até recarregar.
  }
}

/**
 * Sem Supabase no .env.local: login simulado para ver e testar o modelo (dados em memória).
 * Qualquer e-mail do domínio corporativo e qualquer senha preenchida entram. A sessão fica só na aba.
 */
function SimulatedAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);

  const apply = useCallback(
    async (next: string | null) => {
      await authService.bindSession(next);
      writeSimulatedEmail(next);
      if (!next) queryClient.removeQueries();
      setEmail(next);
      setStatus(next ? "signedIn" : "signedOut");
    },
    [queryClient],
  );

  useEffect(() => {
    void apply(readSimulatedEmail());
  }, [apply]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      email,
      notice: null,
      clearNotice: () => {},
      signIn: async (loginEmail, password) => {
        const normalized = loginEmail.trim().toLowerCase();
        if (!isAllowedLoginEmail(normalized)) throw new AuthFailure(INVALID_EMAIL);
        if (!password) throw new AuthFailure("Informe a senha.");
        await apply(normalized);
      },
      signOut: async () => {
        await authService.endSession();
        await apply(null);
      },
      requestPasswordReset: async (resetEmail) => {
        if (!isAllowedLoginEmail(resetEmail.trim().toLowerCase())) throw new AuthFailure(INVALID_EMAIL);
      },
    }),
    [status, email, apply],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** A sessão salva ainda vale no portal? Falha de rede não derruba ninguém (a RLS nega de qualquer forma). */
/** A sessão vale para o imobdesk (aberta pelo gateway de login)? É a mesma regra que o banco do ImobRH aplica. */
async function sessionTrusted(): Promise<boolean> {
  const { data, error } = await supabase.schema("imobdesk").rpc("sessao_atual_confiavel");
  return error ? true : data === true;
}

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const apply = async (session: Session | null) => {
      const sessionEmail = session?.user.email?.toLowerCase() ?? null;
      if (session && !(await sessionTrusted())) {
        // Sessão que o portal não aceita mais (aberta direto no Auth, encerrada por um admin ou
        // anterior ao gateway de login): descarta e pede login de novo.
        if (active) setNotice("Sua sessão expirou. Entre novamente.");
        await supabase.auth.signOut({ scope: "local" });
        return;
      }
      await authService.bindSession(sessionEmail);
      if (!active) return;
      if (!sessionEmail) queryClient.removeQueries();
      setEmail(sessionEmail);
      setStatus(sessionEmail ? "signedIn" : "signedOut");
    };

    // Dispara INITIAL_SESSION ao assinar, então não é preciso chamar getSession().
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Chamadas ao Supabase dentro deste callback podem travar (recomendação do supabase-js): adia.
      setTimeout(() => void apply(session), 0);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  // Sessão encerrada em outro lugar (Sair em outro aparelho, admin, troca de senha): o token local ainda vale,
  // mas o banco recusa tudo com FORBIDDEN. Em vez de deixar a tela em "Algo deu errado", confere a sessão e,
  // se ela não vale mais, pede login de novo. Uma conferência por vez.
  const conferindo = useRef(false);
  useEffect(() => {
    if (status !== "signedIn") return;
    return queryClient.getQueryCache().subscribe((evento) => {
      const erro = evento.type === "updated" ? evento.query.state.error : null;
      if (!(erro instanceof ServiceError) || !["FORBIDDEN", "SEM_PERMISSAO", "NAO_AUTENTICADO"].includes(erro.code) || conferindo.current) return;
      conferindo.current = true;
      void sessionTrusted()
        .then(async (ok) => {
          if (ok) return;
          setNotice("Sua sessão foi encerrada. Entre novamente.");
          await supabase.auth.signOut({ scope: "local" });
        })
        .finally(() => {
          conferindo.current = false;
        });
    });
  }, [queryClient, status]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      email,
      notice,
      clearNotice: () => setNotice(null),
      signIn: async (loginEmail, password) => {
        const normalized = loginEmail.trim().toLowerCase();
        // Só ajuda quem digitou o e-mail errado; o gateway valida de novo no servidor.
        if (!isAllowedLoginEmail(normalized)) throw new AuthFailure(INVALID_EMAIL);
        // Limites, bloqueio e risco são decididos no servidor (gateway). Resposta única para qualquer motivo.
        const result = await signInThroughGateway(normalized, password);
        if (!result.ok) throw new AuthFailure(result.offline ? OFFLINE_MESSAGE : LOGIN_FAILED_MESSAGE);
      },
      signOut: async () => {
        await authService.endSession();
        // "local": encerra só esta sessão. O padrão do supabase-js ("global") derruba o usuário em todos os
        // aparelhos e abas (ex.: sair do app do solicitante no celular deslogava o portal no PC).
        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) throw toAuthFailure(error, "Não foi possível sair. Tente novamente.");
        // Já marca como deslogado: quem navega logo em seguida para /login não é devolvido para /home
        // pelo status antigo (o SIGNED_OUT do listener chega depois, adiado).
        setEmail(null);
        setStatus("signedOut");
      },
      requestPasswordReset: async (resetEmail) => {
        const normalized = resetEmail.trim().toLowerCase();
        if (!isAllowedLoginEmail(normalized)) throw new AuthFailure(INVALID_EMAIL);
        // O gateway devolve sempre a mesma resposta (exista ou não a conta) e monta o link de volta.
        const result = await requestResetThroughGateway(normalized);
        if (!result.ok && result.offline) throw new AuthFailure(OFFLINE_MESSAGE);
      },
    }),
    [status, email, notice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
