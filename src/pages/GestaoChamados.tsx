import { Ticket } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { Breadcrumb } from "../components/Breadcrumb";
import { PageSkeleton } from "../components/PageSkeleton";
import { getMenuItem, type MenuItemId } from "../config/menuRegistry";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { EmptyState } from "../features/configuracoes/components/EmptyState";
import { PageHeader } from "../features/configuracoes/components/PageHeader";
import { usePermissoesVisoes } from "../features/chamados/visoes/permissoes";
import { NotFound } from "./NotFound";
// Abas de seção (mesmo visual de Integrações e da Administração).
import "../features/configuracoes/pages/Integracoes.css";

const Dashboard = lazy(() => import("./Dashboard").then((m) => ({ default: m.Dashboard })));
const Tickets = lazy(() => import("../features/chamados/pages/Tickets").then((m) => ({ default: m.Tickets })));
const ConfigurarVisoes = lazy(() => import("../features/chamados/pages/ConfigurarVisoes").then((m) => ({ default: m.ConfigurarVisoes })));
const TicketTela = lazy(() => import("../features/chamados/ticket/TicketTela").then((m) => ({ default: m.TicketTela })));
const Central = lazy(() => import("../features/atendimento/pages/Central").then((m) => ({ default: m.Central })));
const StatusCadastro = lazy(() => import("../features/chamados/pages/StatusCadastro").then((m) => ({ default: m.StatusCadastro })));
const Gerencial = lazy(() => import("../features/gerencial/pages/Gerencial").then((m) => ({ default: m.Gerencial })));

// Gestão de Chamados: item `gestao_chamados` do menuRegistry, com as seções Visão geral, Tickets, Conversas
// (WhatsApp ao vivo), Monitor de atendimento, Status e Gerencial (`parent: "gestao_chamados"`, nesta ordem). Configurar
// visões não é seção: abre pelo botão da tela Tickets, só para Admin e Super admin (docs/PLANO-tickets-visoes.md, D1).
const page = getMenuItem("gestao_chamados");

const SECOES: { id: MenuItemId; segmento: string }[] = [
  { id: "gestao_chamados_visao_geral", segmento: "visao-geral" },
  { id: "gestao_chamados_tickets", segmento: "tickets" },
  { id: "gestao_atendimento_central", segmento: "conversas" },
  { id: "gestao_chamados_monitor", segmento: "monitor" },
  { id: "gestao_chamados_status", segmento: "status" },
  { id: "gestao_chamados_gerencial", segmento: "gerencial" },
];

export function GestaoChamados() {
  const { hasPermission } = useAccess();
  const { podeConfigurar } = usePermissoesVisoes();
  const { search, pathname } = useLocation();
  // Dentro do Gerencial as abas próprias (Dashboard Gerencial, KPIs…) substituem a barra de seções.
  const noGerencial = pathname.startsWith(getMenuItem("gestao_chamados_gerencial").path);
  const liberadas = SECOES.filter((s) => hasPermission(s.id)).map((s) => ({ ...s, item: getMenuItem(s.id) }));
  const pode = (id: MenuItemId) => hasPermission(id);

  return (
    <>
      <Breadcrumb items={[{ label: "Início", to: "/home" }, { label: page.label }]} />
      <PageHeader title={page.label} description={page.description} />

      {liberadas.length > 1 && !noGerencial && (
        <nav className="section-nav" aria-label={`Seções de ${page.label}`}>
          {liberadas.map(({ id, item }) => {
            const Icone = item.icon;
            return (
              <NavLink key={id} to={item.path} className={({ isActive }) => `section-nav__link${isActive ? " section-nav__link--active" : ""}`}>
                <Icone size={16} aria-hidden="true" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      )}

      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          {/* Links antigos (/gestao-chamados?escopo=…) caem na primeira seção liberada com os mesmos filtros. */}
          <Route
            index
            element={
              liberadas[0] ? (
                <Navigate to={{ pathname: liberadas[0].item.path, search }} replace />
              ) : (
                <div className="card">
                  <EmptyState icon={Ticket} title="Nenhuma tela liberada" description="Peça ao administrador acesso às telas de Gestão de Chamados." />
                </div>
              )
            }
          />
          <Route path="visao-geral" element={pode("gestao_chamados_visao_geral") ? <Dashboard /> : <NotFound />} />
          <Route path="tickets" element={pode("gestao_chamados_tickets") ? <Tickets /> : <NotFound />} />
          <Route path="tickets/visoes" element={pode("gestao_chamados_tickets") && podeConfigurar ? <ConfigurarVisoes /> : <NotFound />} />
          <Route path="tickets/:numero" element={pode("gestao_chamados_tickets") ? <TicketTela /> : <NotFound />} />
          <Route path="conversas" element={pode("gestao_atendimento_central") ? <Central modo="conversas" /> : <NotFound />} />
          <Route path="monitor" element={pode("gestao_chamados_monitor") ? <Central modo="monitor" /> : <NotFound />} />
          <Route path="gerencial/*" element={pode("gestao_chamados_gerencial") ? <Gerencial /> : <NotFound />} />
          <Route path="status" element={pode("gestao_chamados_status") ? <StatusCadastro /> : <NotFound />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}
