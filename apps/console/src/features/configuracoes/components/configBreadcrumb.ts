import type { BreadcrumbItem } from "../../../components/Breadcrumb";
import { CONFIG_ROOT_PATH } from "../../../config/menuRegistry";

/** Trilha "Início / Configurações / Tela"; sem `current`, a própria visão geral. */
export function configBreadcrumb(current?: string): BreadcrumbItem[] {
  const home: BreadcrumbItem = { label: "Início", to: "/" };
  if (!current) return [home, { label: "Configurações" }];
  return [home, { label: "Configurações", to: CONFIG_ROOT_PATH }, { label: current }];
}
