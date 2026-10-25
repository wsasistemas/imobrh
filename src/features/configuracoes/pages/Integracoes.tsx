import type { LucideIcon } from "lucide-react";
import { Database, FileCode2, HardDrive, MessageCircle } from "lucide-react";
import { lazy } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { getMenuItem, type PermissionId } from "../../../config/menuRegistry";
import { NotFound } from "../../../pages/NotFound";
import { useAccess } from "../access/useAccess";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { PageHeader } from "../components/PageHeader";
import { IntegracaoTotvs } from "./integracoes/IntegracaoTotvs";
import "./Integracoes.css";

const IntegracaoZenvia = lazy(() =>
  import("../../atendimento/pages/IntegracaoZenvia").then((m) => ({ default: m.IntegracaoZenvia })),
);
const IntegracaoSienge = lazy(() => import("../../financeiro/IntegracaoSienge").then((m) => ({ default: m.IntegracaoSienge })));
const IntegracaoConsultas = lazy(() =>
  import("./integracoes/IntegracaoConsultas").then((m) => ({ default: m.IntegracaoConsultas })),
);

interface Section {
  /** Segmento da rota abaixo de /configuracoes/integracoes. */
  path: string;
  label: string;
  icon: LucideIcon;
  permission: PermissionId;
}

const page = getMenuItem("configure_integrations");

// TOTVS RM e Consultas SQL usam a permissão do próprio menu (só super admin). Uma seção com permissão
// própria entra no menuRegistry com `parent: "configure_integrations"` e a rota completa.
/**
 * Caminho absoluto da seção. Nada de link relativo aqui: no React Router v7, dentro de uma rota
 * "/*" o relativo parte da URL inteira (em .../totvs, "consultas" viraria .../totvs/consultas).
 */
function sectionUrl(section: Section): string {
  return `${page.path}/${section.path}`;
}

const SECTIONS: Section[] = [
  { path: "totvs", label: "TOTVS RM", icon: Database, permission: "configure_integrations" },
  { path: "consultas", label: "Consultas SQL", icon: FileCode2, permission: "configure_integrations" },
  { path: "zenvia", label: "Zenvia WhatsApp", icon: MessageCircle, permission: "atendimento_zenvia" },
  { path: "sienge", label: "SIENGE", icon: HardDrive, permission: "integracao_sienge" },
];

export function Integracoes() {
  const { hasPermission } = useAccess();
  const { pathname } = useLocation();
  const sections = SECTIONS.filter((section) => hasPermission(section.permission));
  const current = sections.find((section) => pathname === sectionUrl(section) || pathname.startsWith(`${sectionUrl(section)}/`));

  const breadcrumb = current
    ? [...configBreadcrumb(page.label).slice(0, -1), { label: page.label, to: page.path }, { label: current.label }]
    : configBreadcrumb(page.label);

  return (
    <>
      <Breadcrumb items={breadcrumb} />
      <PageHeader title={page.label} description={page.description} />

      <nav className="section-nav" aria-label="Seções de Integrações">
        {sections.map((section) => (
          <NavLink
            key={section.path}
            to={sectionUrl(section)}
            className={({ isActive }) => `section-nav__link${isActive ? " section-nav__link--active" : ""}`}
          >
            <section.icon size={16} aria-hidden="true" />
            {section.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        {/* A raiz abre a primeira seção liberada para o usuário. */}
        <Route index element={sections[0] ? <Navigate to={sectionUrl(sections[0])} replace /> : <NotFound />} />
        {/* A aba E-mail saiu (2026-09-28): convites e redefinição de senha saem pelo e-mail do login (Supabase). */}
        <Route path="email" element={<Navigate to={`${page.path}/totvs`} replace />} />
        <Route path="totvs" element={<IntegracaoTotvs />} />
        <Route path="consultas" element={<IntegracaoConsultas />} />
        <Route path="zenvia" element={hasPermission("atendimento_zenvia") ? <IntegracaoZenvia /> : <NotFound />} />
        <Route path="sienge" element={hasPermission("integracao_sienge") ? <IntegracaoSienge /> : <NotFound />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
