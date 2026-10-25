import { Cloud, HardDrive, LogOut, Menu, UserRound } from "lucide-react";
import { APP_TOPBAR_NAME, COMPANY_NAME } from "../config/app";
import { SinoAvisos } from "../features/chamados/gatilhos/SinoAvisos";
import { DevUserSwitcher } from "../features/configuracoes/access/DevUserSwitcher";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { DATA_SOURCE } from "../features/configuracoes/services";
import { useSignOut } from "../features/auth/useSignOut";
import { MenuAparencia } from "../features/empresas/MenuAparencia";
import { SeletorEmpresa } from "../features/empresas/SeletorEmpresa";
import "./Topbar.css";

interface TopbarProps {
  onToggleSidebar: () => void;
}

// Data curta em português, ex.: "ter., 29 de set. de 2026".
const todayLabel = new Date().toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

export function Topbar({ onToggleSidebar }: TopbarProps) {
  const { user, roleLabel } = useAccess();
  const { signingOut, handleSignOut } = useSignOut();
  const connected = DATA_SOURCE === "supabase";

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          type="button"
          className="topbar__icon-button"
          onClick={onToggleSidebar}
          aria-label="Alternar menu lateral"
        >
          <Menu size={18} />
        </button>

        <img className="topbar__logo" src="/wsa-logo.png" alt={COMPANY_NAME} width={36} height={36} />

        <div className="topbar__divider" aria-hidden="true" />

        <span className="topbar__title">{APP_TOPBAR_NAME.toUpperCase()}</span>
      </div>

      <div className="topbar__right">
        {/* Só com dados em memória: com o Supabase não há como entrar na conta de outra pessoa. */}
        {(import.meta.env.DEV || import.meta.env.MODE === "demo") && DATA_SOURCE === "mock" && <DevUserSwitcher />}

        <SeletorEmpresa ativo={Boolean(user)} />

        <span className="topbar__status" title={connected ? "Dados no Supabase" : "Dados simulados em memória"}>
          {connected ? <Cloud size={14} aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}
          <span className="topbar__hide-sm">{connected ? "Sincronizado" : "Modo simulado"}</span>
        </span>

        <span className="topbar__date topbar__hide-sm">{todayLabel}</span>

        <div className="topbar__user" title={user ? `${user.name} · ${roleLabel}` : undefined}>
          <UserRound size={14} aria-hidden="true" />
          <span className="topbar__user-text">
            <strong>{user?.name}</strong>
            <small>{roleLabel}</small>
          </span>
          <button
            type="button"
            className="topbar__logout"
            aria-label="Sair"
            title="Sair"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            <LogOut size={14} />
          </button>
        </div>

        <MenuAparencia ativo={Boolean(user)} />

        <SinoAvisos ativo={Boolean(user)} />
      </div>
    </header>
  );
}
