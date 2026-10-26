import { Hourglass } from "lucide-react";
import { Breadcrumb, type BreadcrumbItem } from "../../../components/Breadcrumb";
import { getMenuItem, type MenuItemId } from "../../../config/menuRegistry";
import { configBreadcrumb } from "../../configuracoes/components/configBreadcrumb";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { PageHeader } from "../../configuracoes/components/PageHeader";

/** Tela do menu ainda sem conteúdo: título e descrição do menuRegistry e a fase em que chega (PRD v2). */
export function PaginaEmBreve({ id, fase }: { id: MenuItemId; fase: string }) {
  const item = getMenuItem(id);
  const breadcrumb: BreadcrumbItem[] =
    item.group === "configuracoes" ? configBreadcrumb(item.label) : [{ label: "Início", to: "/" }, { label: item.label }];

  return (
    <>
      <Breadcrumb items={breadcrumb} />
      <PageHeader title={item.label} description={item.description} />
      <div className="card">
        <EmptyState icon={Hourglass} title="Em construção" description={`Esta tela chega na ${fase} do ImobRH (docs/PRD-imobRH-v2.md).`} />
      </div>
    </>
  );
}

export const CaixaRh = () => <PaginaEmBreve id="caixa_rh" fase="Fase 2 — Motor de processos e Console do RH" />;
export const MeusCasos = () => <PaginaEmBreve id="meus_casos" fase="Fase 2 — Motor de processos e Console do RH" />;
export const PrazosLegais = () => <PaginaEmBreve id="prazos_legais" fase="Fase 2 — Motor de processos e Console do RH" />;
export const ModelosProcesso = () => <PaginaEmBreve id="config_processos" fase="Fase 2 — Motor de processos e Console do RH" />;
export const Alcadas = () => <PaginaEmBreve id="config_aprovacoes" fase="Fase 1 — Pedidos e aprovações" />;
