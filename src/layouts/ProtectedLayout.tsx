import { Suspense, useState } from "react";
import { Outlet } from "react-router";
import { PageSkeleton } from "../components/PageSkeleton";
import { Sidebar } from "../components/Sidebar";
import { Topbar } from "../components/Topbar";
import { AccessGate } from "../features/configuracoes/access/AccessGate";
import { useMediaQuery } from "../hooks/useMediaQuery";
import "../App.css";

/** Abaixo desta largura a sidebar começa recolhida. */
const NARROW_SCREEN = "(max-width: 1279px)";

/** Layout único das rotas protegidas: topbar, sidebar e o guard de acesso em volta do conteúdo. */
export function ProtectedLayout() {
  const isNarrow = useMediaQuery(NARROW_SCREEN);
  // Escolha manual pelo botão da topbar ou do rodapé da sidebar; null segue o tamanho da tela.
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const [wasNarrow, setWasNarrow] = useState(isNarrow);

  // Ao cruzar os 1280px, a tela volta a mandar: recolhe no estreito e expande no largo.
  if (isNarrow !== wasNarrow) {
    setWasNarrow(isNarrow);
    setManualCollapsed(null);
  }

  const collapsed = manualCollapsed ?? isNarrow;
  const toggle = () => setManualCollapsed(!collapsed);

  return (
    <div className="app-shell">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      <Topbar onToggleSidebar={toggle} />

      <div className="app-body">
        <Sidebar collapsed={collapsed} onCollapse={toggle} />

        <main id="conteudo" className="app-main" tabIndex={-1}>
          <AccessGate>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </AccessGate>
        </main>
      </div>
    </div>
  );
}
