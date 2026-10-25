import { createContext } from "react";

export type AuthStatus = "loading" | "signedOut" | "signedIn";

export interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  /** Aviso para a tela de login (ex.: e-mail fora do domínio foi desconectado). */
  notice: string | null;
  clearNotice: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
