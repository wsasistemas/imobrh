import { lazy, Suspense } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { Breadcrumb } from "../components/Breadcrumb";
import { PageSkeleton } from "../components/PageSkeleton";
import { getMenuItem, type MenuItemId } from "../config/menuRegistry";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { PageHeader } from "../features/configuracoes/components/PageHeader";
import { NotFound } from "./NotFound";
import "../features/configuracoes/pages/Integracoes.css";
import "../features/treinamento/treinamento.css";

const MeusTreinamentos = lazy(() => import("../features/treinamento/MeusTreinamentos").then((m) => ({ default: m.MeusTreinamentos })));
const GerenciarTutoriais = lazy(() => import("../features/treinamento/GerenciarTutoriais").then((m) => ({ default: m.GerenciarTutoriais })));

// Centro de Treinamento: item `centro_treinamento` do menuRegistry (docs/PLANO-centro-treinamento.md).
// Meus treinamentos para todos (a trilha do setor de cada um); Gerenciar tutoriais só para o Admin.
const page = getMenuItem("centro_treinamento");

const SECOES: MenuItemId[] = ["centro_treinamento_meus", "centro_treinamento_gerenciar"];

export function CentroTreinamento() {
  const { hasPermission } = useAccess();
  const liberadas = SECOES.filter((id) => hasPermission(id)).map((id) => getMenuItem(id));
  const meus = getMenuItem("centro_treinamento_meus");

  return (
    <>
      <Breadcrumb items={[{ label: "Início", to: "/home" }, { label: page.label }]} />
      <PageHeader title={page.label} description={page.description} />

      {liberadas.length > 1 && (
        <nav className="section-nav" aria-label={`Seções de ${page.label}`}>
          {liberadas.map((item) => {
            const Icone = item.icon;
            return (
              <NavLink key={item.id} to={item.path} className={({ isActive }) => `section-nav__link${isActive ? " section-nav__link--active" : ""}`}>
                <Icone size={16} aria-hidden="true" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      )}

      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route index element={<Navigate to={meus.path} replace />} />
          <Route path="meus" element={<MeusTreinamentos />} />
          <Route path="meus/:moduloId" element={<MeusTreinamentos />} />
          <Route path="gerenciar" element={hasPermission("centro_treinamento_gerenciar") ? <GerenciarTutoriais /> : <NotFound />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}
