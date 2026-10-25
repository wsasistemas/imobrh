import type { LucideIcon } from "lucide-react";
import { MessagesSquare } from "lucide-react";
import type { MenuItemId } from "../config/menuRegistry";

/** Cor do quadro do ícone (tons do design system: marca, info, sucesso, aviso). */
export type ModuleAccent = "brand" | "info" | "success" | "warning";

export interface ModuleCardData {
  title: string;
  description: string;
  icon: LucideIcon;
  accent: ModuleAccent;
  /** Rota do card inteiro. */
  to: string;
  /** Item do menu que libera o card (o card some para quem não abre o módulo). */
  permission: MenuItemId;
  /** Atalhos para as telas do módulo (itens do menu com `parent`). */
  shortcuts?: MenuItemId[];
  /** Seção da página inicial em que o card aparece (os cards da mesma seção ficam juntos). */
  section: string;
  /** Destaque visual (borda da marca), como o módulo principal do sistema. */
  highlighted?: boolean;
}

// Cards da página inicial: um por tela de módulo. Troque pelos módulos do sistema.
export const modules: ModuleCardData[] = [
  {
    title: "Administração",
    description: "Canais de atendimento de cada setor: WhatsApp, e-mail, fila e horários.",
    icon: MessagesSquare,
    accent: "brand",
    to: "/gestao-atendimento",
    permission: "gestao_atendimento_fila",
    shortcuts: ["gestao_atendimento_fila", "gestao_atendimento_setores", "gestao_atendimento_openwa", "gestao_atendimento_emails"],
    section: "Atendimento",
    highlighted: true,
  },
];
