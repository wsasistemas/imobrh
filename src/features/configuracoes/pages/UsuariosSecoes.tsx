import { lazy, Suspense } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { getMenuItem } from "../../../config/menuRegistry";
import { NotFound } from "../../../pages/NotFound";
import { useAccess } from "../access/useAccess";
import { Usuarios } from "./Usuarios";
// Barra de seções (mesmo visual de Integrações).
import "./Integracoes.css";

const Equipes = lazy(() => import("../../cadastros/pages/Equipes").then((m) => ({ default: m.Equipes })));

const usuarios = getMenuItem("manage_users");
const equipes = getMenuItem("manage_users_equipes");

/** Configurações › Usuários: a lista (com as abas de situação) e a seção Equipes. */
function UsuariosNav() {
  const { hasPermission } = useAccess();
  const secoes = [usuarios, equipes].filter((s) => hasPermission(s.id));
  if (secoes.length < 2) return null;
  return (
    <nav className="section-nav" aria-label="Seções de Usuários">
      {secoes.map((s) => (
        <NavLink key={s.id} to={s.path} end className={({ isActive }) => `section-nav__link${isActive ? " section-nav__link--active" : ""}`}>
          <s.icon size={16} aria-hidden="true" />
          {s.id === "manage_users" ? "Usuários" : s.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function UsuariosSecoes() {
  const { hasPermission } = useAccess();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route index element={hasPermission("manage_users") ? <Usuarios nav={<UsuariosNav />} /> : <Navigate to={equipes.path} replace />} />
        <Route path="equipes" element={hasPermission("manage_users_equipes") ? <Equipes nav={<UsuariosNav />} /> : <NotFound />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
