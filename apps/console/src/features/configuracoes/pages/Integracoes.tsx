import type { LucideIcon } from "lucide-react";
import { Database, FileCode2 } from "lucide-react";
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

// Conexão e Consultas SQL usam a permissão do próprio menu. Uma seção com permissão própria entra no
// menuRegistry com `parent: "configure_integrations"` e a rota completa.
/**
 * Caminho absoluto da seção. Nada de link relativo aqui: no React Router v7, dentro de uma rota
 * "/*" o relativo parte da URL inteira (em .../totvs, "consultas" viraria .../totvs/consultas).
 */
function sectionUrl(section: Section): string {
  return `${page.path}/${section.path}`;
}

const SECTIONS: Section[] = [
  { path: "totvs", label: "Conexão", icon: Database, permission: "configure_integrations" },
  { path: "consultas", label: "Consultas SQL", icon: FileCode2, permission: "configure_integrations" },
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

      <nav className="section-nav" aria-label="Seções da Integração TOTVS RM">
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
        <Route path="totvs" element={<IntegracaoTotvs />} />
        <Route path="consultas" element={<IntegracaoConsultas />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
