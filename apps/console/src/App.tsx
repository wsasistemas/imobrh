import { lazy, Suspense, type ReactElement } from "react";
import { Route, Routes } from "react-router";
import { CONFIG_ROOT_PATH, menuRegistry, routeChildrenOf, type TopLevelMenuId } from "./config/menuRegistry";
import { PageSkeleton } from "./components/PageSkeleton";
import { LOGIN_PATH, RequireSession } from "./features/auth/RequireSession";
import { VisaoGeral } from "./features/configuracoes/pages/VisaoGeral";
import { Alcadas, CaixaRh, MeusCasos, ModelosProcesso, PrazosLegais } from "./features/rh/pages/PaginaEmBreve";
import { ProtectedLayout } from "./layouts/ProtectedLayout";
import { NotFound } from "./pages/NotFound";

// Telas carregadas sob demanda (formulários, zod e diálogos ficam fora do bundle inicial).
const VinculosPendentes = lazy(() => import("./features/rh/pages/VinculosPendentes").then((m) => ({ default: m.VinculosPendentes })));
const Usuarios = lazy(() => import("./features/configuracoes/pages/Usuarios").then((m) => ({ default: m.Usuarios })));
const PerfisPermissoes = lazy(() =>
  import("./features/configuracoes/pages/PerfisPermissoes").then((m) => ({ default: m.PerfisPermissoes })),
);
const Integracoes = lazy(() => import("./features/configuracoes/pages/Integracoes").then((m) => ({ default: m.Integracoes })));
const Auditoria = lazy(() => import("./features/configuracoes/pages/Auditoria").then((m) => ({ default: m.Auditoria })));
const Sessoes = lazy(() => import("./features/configuracoes/pages/Sessoes").then((m) => ({ default: m.Sessoes })));
const Login = lazy(() => import("./features/auth/pages/Login").then((m) => ({ default: m.Login })));

// Vitrine do design system: só em desenvolvimento (o Vite remove o import no build de produção).
const DesignSystem = import.meta.env.DEV
  ? lazy(() => import("./pages/DesignSystem").then((m) => ({ default: m.DesignSystem })))
  : null;

// Tela de cada item do menuRegistry. O Record obriga todo item registrado a ter uma página; as rotas em si são
// geradas a partir do registro. Seções (itens com `parent`) são rotas internas da tela do pai ("/*").
const pages: Record<TopLevelMenuId, ReactElement> = {
  caixa_rh: <CaixaRh />,
  meus_casos: <MeusCasos />,
  prazos_legais: <PrazosLegais />,
  config_processos: <ModelosProcesso />,
  config_aprovacoes: <Alcadas />,
  config_vinculos: <VinculosPendentes />,
  manage_users: <Usuarios />,
  manage_permissions: <PerfisPermissoes />,
  configure_integrations: <Integracoes />,
  view_audit_logs: <Auditoria />,
  manage_sessions: <Sessoes />,
};

/** Tela fora do layout carregada sob demanda. */
function Standalone({ children }: { children: ReactElement }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

function App() {
  return (
    <Routes>
      {/* Pública: login pelo gateway do imobdesk (o mesmo usuário e senha). */}
      <Route path={LOGIN_PATH} element={<Standalone><Login /></Standalone>} />

      {DesignSystem && <Route path="/design-system" element={<Standalone><DesignSystem /></Standalone>} />}

      <Route
        element={
          <RequireSession>
            <ProtectedLayout />
          </RequireSession>
        }
      >
        <Route path={CONFIG_ROOT_PATH} element={<VisaoGeral />} />
        {menuRegistry.map((item) =>
          item.parent ? null : (
            <Route
              key={item.id}
              path={routeChildrenOf(item.id).length > 0 || item.subroutes ? `${item.path}/*` : item.path}
              element={pages[item.id as TopLevelMenuId]}
            />
          ),
        )}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default App;
