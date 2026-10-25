import { ADMIN_ROLE, type RoleKey } from "../../../config/app";
import { useAccess } from "../../configuracoes/access/useAccess";

// Quem faz o quê nas visões de Tickets (docs/PLANO-tickets-visoes.md, D1 e D4). A mesma regra está nas RPCs
// ch_visao_* do banco; aqui ela só decide o que a tela mostra.
//
// | Ação                                           | Agente (equipe) | Admin | Super admin |
// |------------------------------------------------|:---------------:|:-----:|:-----------:|
// | Usar as visões habilitadas da(s) sua(s) equipe(s) |       ✓        |   ✓   |      ✓      |
// | Ver todas as visões (de qualquer equipe)        |                 |   ✓   |      ✓      |
// | Criar, editar, duplicar, habilitar/desabilitar  |                 |   ✓   |      ✓      |
// | Excluir visão                                    |                 |       |      ✓      |
// | Definir / restaurar o Kanban padrão do sistema   |                 |       |      ✓      |

export interface PermissoesVisoes {
  /** Vê todas as visões, de qualquer equipe (e as desabilitadas, na configuração). */
  veTodas: boolean;
  podeConfigurar: boolean;
  podeExcluir: boolean;
  podeDefinirPadrao: boolean;
}

export function permissoesVisoes(role: RoleKey | null, isSuperAdmin: boolean): PermissoesVisoes {
  const admin = isSuperAdmin || role === ADMIN_ROLE;
  return { veTodas: admin, podeConfigurar: admin, podeExcluir: isSuperAdmin, podeDefinirPadrao: isSuperAdmin };
}

export function usePermissoesVisoes(): PermissoesVisoes {
  const { role, isSuperAdmin } = useAccess();
  return permissoesVisoes(role, isSuperAdmin);
}
