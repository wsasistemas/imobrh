import type {
  AppAccessService,
  AuditService,
  AuthService,
  IntegrationsService,
  PermissionsService,
  RolesService,
  SessionsService,
  SqlQueriesService,
  TotvsService,
  UsersService,
} from "./contracts";
import { mockAppAccessService } from "./mock/appAccess";
import { mockAuditService } from "./mock/audit";
import { mockAuthService } from "./mock/auth";
import { mockIntegrationsService } from "./mock/integrations";
import { mockPermissionsService } from "./mock/permissions";
import { mockRolesService } from "./mock/roles";
import { mockSessionsService } from "./mock/sessions";
import { mockSqlQueriesService } from "./mock/sqlQueries";
import { mockTotvsService } from "./mock/totvs";
import { mockUsersService } from "./mock/users";
import { supabaseAppAccessService } from "./supabase/appAccess";
import { supabaseAuditService } from "./supabase/audit";
import { supabaseAuthService } from "./supabase/auth";
import { supabaseIntegrationsService } from "./supabase/integrations";
import { supabasePermissionsService } from "./supabase/permissions";
import { supabaseRolesService } from "./supabase/roles";
import { supabaseSessionsService } from "./supabase/sessions";
import { supabaseSqlQueriesService } from "./supabase/sqlQueries";
import { supabaseTotvsService } from "./supabase/totvs";
import { supabaseUsersService } from "./supabase/users";
import { SUPABASE_CONFIGURED } from "../../../lib/supabase";

/**
 * Ponto único de troca da camada de dados. Padrão: Supabase (schema do aplicativo, em config/app.ts).
 * VITE_DATA_SOURCE=mock, ou nenhum Supabase configurado no .env.local, usa os dados em memória
 * (demonstração e testes), com o "Ver como".
 * Hooks e telas não mudam em nenhum dos dois modos.
 */
export const DATA_SOURCE: "mock" | "supabase" =
  import.meta.env.VITE_DATA_SOURCE === "mock" || !SUPABASE_CONFIGURED ? "mock" : "supabase";

const useMock = DATA_SOURCE === "mock";

export const usersService: UsersService = useMock ? mockUsersService : supabaseUsersService;
export const rolesService: RolesService = useMock ? mockRolesService : supabaseRolesService;
export const permissionsService: PermissionsService = useMock ? mockPermissionsService : supabasePermissionsService;
export const integrationsService: IntegrationsService = useMock ? mockIntegrationsService : supabaseIntegrationsService;
export const totvsService: TotvsService = useMock ? mockTotvsService : supabaseTotvsService;
export const sqlQueriesService: SqlQueriesService = useMock ? mockSqlQueriesService : supabaseSqlQueriesService;
export const auditService: AuditService = useMock ? mockAuditService : supabaseAuditService;
export const sessionsService: SessionsService = useMock ? mockSessionsService : supabaseSessionsService;
export const appAccessService: AppAccessService = useMock ? mockAppAccessService : supabaseAppAccessService;
export const authService: AuthService = useMock ? mockAuthService : supabaseAuthService;
