import { Calendar, Home as HomeIcon, LayoutGrid, UserRound } from "lucide-react";
import { Breadcrumb } from "../components/Breadcrumb";
import { ModuleCard } from "../components/ModuleCard";
import { modules, type ModuleCardData } from "../data/modules";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { HomeTicketsSummary } from "../features/dashboard/HomeTicketsSummary";
import { HomeFinanceiro } from "../features/financeiro/HomeFinanceiro";
import { EmptyState } from "../features/configuracoes/components/EmptyState";
import "./Home.css";

// Data por extenso em português, ex.: "terça-feira, 29 de setembro de 2026".
const formattedDate = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date());

// Saudação conforme o horário local do navegador.
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

/** Agrupa os cards por seção, na ordem em que aparecem em `modules`. */
function bySection(items: ModuleCardData[]): [string, ModuleCardData[]][] {
  const sections = new Map<string, ModuleCardData[]>();
  for (const item of items) sections.set(item.section, [...(sections.get(item.section) ?? []), item]);
  return [...sections];
}

export function Home() {
  const { user, roleLabel, canOpen } = useAccess();
  // Só os módulos que o perfil abre.
  const visible = modules.filter((module) => canOpen(module.permission));

  return (
    <>
      <Breadcrumb items={[{ label: "Início" }, { label: "Página Inicial" }]} />

      <header className="home-hero">
        <div className="home-hero__icon" aria-hidden="true">
          <HomeIcon size={22} />
        </div>
        <div>
          <h1>
            {greeting()}, {user?.name ?? ""}!
          </h1>
          <div className="home-hero__meta">
            <span>
              <UserRound size={14} aria-hidden="true" />
              {roleLabel}
            </span>
            <span>
              <Calendar size={14} aria-hidden="true" />
              {formattedDate}
            </span>
          </div>
        </div>
      </header>

      {/* Quem atende chamados vê só o resumo; os cards de módulo ficam para os demais perfis (o menu continua igual).
          O resumo das Solicitações Financeiras vem para todos os perfis, conforme as telas que cada um abre. */}
      {/* Perfil do Financeiro: o resumo financeiro vem antes de tudo. */}
      {canOpen("sf_conferencia") && <HomeFinanceiro key={`sf-${user?.id}`} />}
      {canOpen("gestao_chamados") ? (
        <HomeTicketsSummary key={user?.id} />
      ) : visible.length === 0 ? (
        canOpen("sf_minhas") ? null : (
        <div className="card">
          <EmptyState icon={LayoutGrid} title="Nenhum módulo liberado" description="Peça ao administrador para liberar os módulos do seu perfil." />
        </div>
        )
      ) : (
        bySection(visible).map(([section, items]) => (
          <section key={section} aria-label={section}>
            <h2 className="section-title">{section}</h2>
            <div className="module-grid">
              {items.map((module, index) => (
                <ModuleCard key={module.title} {...module} index={index} />
              ))}
            </div>
          </section>
        ))
      )}
      {!canOpen("sf_conferencia") && <HomeFinanceiro key={`sf-${user?.id}`} />}
    </>
  );
}
