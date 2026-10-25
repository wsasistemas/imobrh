import * as Switch from "@radix-ui/react-switch";
import { AppWindow, Info, KeyRound, LogIn, Plus, RefreshCw, Search, ShieldCheck, TriangleAlert, User, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ThLabel } from "../../../components/ds";
import { getMenuItem } from "../../../config/menuRegistry";
import { formatRelative } from "../../../utils/dates";
import { configBreadcrumb } from "../components/configBreadcrumb";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { StatusBadge } from "../components/StatusBadge";
import { UserAvatar } from "../components/UserAvatar";
import {
  useAppAccessApps,
  useAppAccessUsers,
  useSaveApp,
  useSetAppControl,
  useSetAppPermission,
} from "../hooks/useAppAccess";
import { ServiceError, type AppAccessApp, type AppAccessUser } from "../services/types";
import { AddAppDialog } from "./AddAppDialog";
import "./PermissoesAplicativo.css";

const PAGE_SIZE = 10;
/** A verificação conta como instalada se o aplicativo chamou pode_acessar_app nos últimos 30 dias. */
const CHECK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Filter = "all" | "yes" | "no";

function errorMessage(error: unknown): string {
  return error instanceof ServiceError ? error.message : "Não foi possível concluir a ação. Tente novamente.";
}

function checkInstalled(app: AppAccessApp): boolean {
  return app.lastCheckAt !== null && Date.now() - new Date(app.lastCheckAt).getTime() < CHECK_WINDOW_MS;
}

function AppStatus({ app }: { app: AppAccessApp }) {
  if (!app.configured) return <StatusBadge variant="info">Novo · configurar</StatusBadge>;
  if (!app.controlActive) return <StatusBadge variant="neutral">Controle desligado</StatusBadge>;
  if (!checkInstalled(app)) return <StatusBadge variant="danger">Bloqueio NÃO está valendo</StatusBadge>;
  return <StatusBadge variant="success">Controle ativo</StatusBadge>;
}

// Siglas fixas de aplicativos cujas iniciais automáticas confundem (Contratos e Pesagem).
const SIGLAS_APP: Record<string, string> = { contratos: "CT", pesagem: "PS" };

const initials = (name: string) =>
  name
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

export function PermissoesAplicativo() {
  const item = getMenuItem("manage_app_access");
  const apps = useAppAccessApps();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Só os schemas expostos na API de fato: os demais não têm o que controlar e ficam ocultos.
  const list = useMemo(() => (apps.data ?? []).filter((app) => app.exposed), [apps.data]);
  const current = list.find((app) => app.schema === selected) ?? list[0] ?? null;

  return (
    <>
      <Breadcrumb items={configBreadcrumb(item.label)} />
      <PageHeader
        title={item.label}
        description="Cada schema exposto no Supabase é um aplicativo. Escolha quem pode entrar em cada um. O login e a senha continuam os mesmos em todos; o perfil dentro de cada aplicativo continua sendo definido nele."
        actions={<StatusBadge variant="danger">Somente super admin</StatusBadge>}
      />

      {apps.isPending ? (
        <PageSkeleton />
      ) : apps.isError ? (
        <ErrorState message={errorMessage(apps.error)} onRetry={() => void apps.refetch()} />
      ) : list.length === 0 ? (
        <div className="card">
          <EmptyState icon={AppWindow} title="Nenhum schema exposto" description="Nenhum schema está exposto na API do Supabase." />
        </div>
      ) : (
        <div className="app-access">
          <section className="card app-access__list" aria-label="Aplicativos">
            <div className="app-access__list-head">
              <h2>Aplicativos</h2>
              <button type="button" className="btn btn--outline btn--sm-app" onClick={() => setAdding(true)}>
                <Plus size={14} aria-hidden="true" />
                Adicionar
              </button>
              <button
                type="button"
                className="btn btn--outline btn--sm-app"
                onClick={() =>
                  void apps.refetch().then(({ data }) => {
                    if (!data) return;
                    const exposed = data.filter((app) => app.exposed).length;
                    toast.success(`Lista atualizada: ${exposed} ${exposed === 1 ? "aplicativo exposto" : "aplicativos expostos"} na API`);
                  })
                }
                disabled={apps.isFetching}
              >
                <RefreshCw size={14} aria-hidden="true" className={apps.isFetching ? "app-access__spin" : undefined} />
                Atualizar lista
              </button>
            </div>
            <div className="app-access__apps">
              {list.map((app) => (
                <button
                  key={app.schema}
                  type="button"
                  className={`app-access__app${app.schema === current?.schema ? " is-active" : ""}`}
                  aria-pressed={app.schema === current?.schema}
                  onClick={() => setSelected(app.schema)}
                >
                  <span className="app-access__icon" aria-hidden="true">
                    {SIGLAS_APP[app.schema] ?? initials(app.name)}
                  </span>
                  <span className="app-access__app-text">
                    <strong>{app.name}</strong>
                    <code>{app.manual ? `${app.schema} · dados em ${app.dataSchema}` : app.schema}</code>
                    <AppStatus app={app} />
                  </span>
                  <span className="app-access__count">
                    {app.allowedCount}
                    <small>de {app.totalLogins}</small>
                  </span>
                </button>
              ))}
            </div>
            <p className="app-access__detect">
              A lista mostra só os schemas que a API do Supabase expõe <strong>de fato</strong>. Quando um projeto novo expõe
              o schema dele, ele aparece aqui sozinho como <strong>Novo</strong>, com o controle desligado.
            </p>
          </section>

          {current && <AppDetail key={current.schema} app={current} />}
        </div>
      )}
      <AddAppDialog open={adding} onClose={() => setAdding(false)} onAdded={(key) => setSelected(key)} />
    </>
  );
}

function AppDetail({ app }: { app: AppAccessApp }) {
  const users = useAppAccessUsers(app.schema);
  const save = useSaveApp();
  const setControl = useSetAppControl();
  const setPermission = useSetAppPermission();

  const [name, setName] = useState(app.name);
  const [url, setUrl] = useState(app.url ?? "");
  const [releaseProfile, setReleaseProfile] = useState(app.releaseProfile ?? "");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmControl, setConfirmControl] = useState(false);

  const rows = useMemo(() => users.data ?? [], [users.data]);
  const counts = useMemo(
    () => ({ all: rows.length, yes: rows.filter((row) => row.canEnter).length, no: rows.filter((row) => !row.canEnter).length }),
    [rows],
  );
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (!term || row.name.toLowerCase().includes(term) || row.email.toLowerCase().includes(term)) &&
        (filter === "all" || (filter === "yes") === row.canEnter),
    );
  }, [rows, search, filter]);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [search, filter]);

  const saveMeta = (newLoginsDefault = app.newLoginsDefault) =>
    save.mutate(
      { schema: app.schema, input: { name, url, newLoginsDefault, releaseProfile: releaseProfile || null } },
      {
        onSuccess: () => toast.success(`Aplicativo ${name} salvo`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  const toggleControl = () => {
    const active = !app.controlActive;
    setControl.mutate(
      { schema: app.schema, active },
      {
        onSuccess: () => {
          toast.success(active ? `Controle de acesso ligado no ${app.name}` : `Controle de acesso desligado no ${app.name}`);
          setConfirmControl(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  /** `name` só quando é um login; em lote, a mensagem usa a quantidade alterada. */
  const applyPermission = (userIds: string[], canEnter: boolean, name?: string) =>
    setPermission.mutate(
      { schema: app.schema, userIds, canEnter },
      {
        onSuccess: ({ changed, created, reactivated, skippedSuffix, profile }) => {
          setPicked(new Set());
          if (changed === 0 && created === 0 && reactivated === 0) return toast.info("Nenhuma permissão mudou");
          const who = name ?? (changed === 1 ? "1 login" : `${changed} logins`);
          const verb = name ? (canEnter ? "pode entrar" : "foi bloqueado") : canEnter ? (changed === 1 ? "liberado" : "liberados") : changed === 1 ? "bloqueado" : "bloqueados";
          const extras = [
            created > 0 && (name ? `cadastrado como ${profile}` : `${created} cadastrado(s) como ${profile}`),
            reactivated > 0 && `${reactivated} cadastro(s) reativado(s)`,
            skippedSuffix > 0 && `${skippedSuffix} conta(s) com sufixo sem cadastro automático`,
          ].filter(Boolean);
          const head = changed > 0 ? `${who} ${verb} no ${app.name}` : `${app.name}`;
          toast.success(`${head}${extras.length ? ` · ${extras.join(" · ")}` : ""} · registrado na Auditoria`);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  const selectable = pageRows.filter((row) => !row.owner);
  const allPicked = selectable.length > 0 && selectable.every((row) => picked.has(row.id));
  const togglePick = (id: string) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="card app-access__detail" aria-label={`Permissões do ${app.name}`}>
      <div className="app-access__detail-head">
        <h2>{app.name}</h2>
        <AppStatus app={app} />
      </div>

      <div className="app-access__meta">
        <div className="field">
          <label className="field__label" htmlFor="app-name">
            Nome do aplicativo
          </label>
          <input id="app-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="app-schema">
            {app.manual ? "Chave · schema de dados" : "Schema"}
          </label>
          <input
            id="app-schema"
            className="input app-access__mono"
            value={app.manual ? `${app.schema} · ${app.dataSchema}` : app.schema}
            readOnly
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="app-url">
            Endereço (URL)
          </label>
          <input
            id="app-url"
            className="input app-access__mono"
            value={url}
            placeholder="ex.: contratos.suaempresa.com.br"
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="app-release-profile">
            Perfil ao liberar
          </label>
          <select
            id="app-release-profile"
            className="input"
            value={releaseProfile}
            disabled={!app.profiles || app.profiles.length === 0}
            onChange={(event) => setReleaseProfile(event.target.value)}
          >
            {!app.profiles || app.profiles.length === 0 ? (
              <option value="">Sem cadastro próprio</option>
            ) : (
              app.profiles.map((profile, index) => (
                <option key={profile.value} value={profile.value}>
                  {profile.label}
                  {index === app.profiles!.length - 1 ? " (mais simples)" : ""}
                </option>
              ))
            )}
          </select>
        </div>
        <button type="button" className="btn btn--primary" disabled={save.isPending} onClick={() => saveMeta()}>
          {save.isPending ? "Salvando…" : "Salvar"}
        </button>
      </div>

      <div className="app-access__control">
        <div className={`app-access__opt${app.controlActive ? " is-on" : ""}`}>
          <Switch.Root
            className="switch"
            checked={app.controlActive}
            disabled={setControl.isPending}
            onCheckedChange={() => setConfirmControl(true)}
            aria-label="Controle de acesso"
          >
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <strong>Controle de acesso</strong>
            <span>
              {app.controlActive ? (
                <>
                  <b>Ligado:</b> só entra quem está marcado como “Pode entrar” abaixo.
                </>
              ) : (
                <>
                  <b>Desligado:</b> o aplicativo funciona como hoje e todo login da WSA entra. Ligue quando quiser restringir.
                </>
              )}
            </span>
          </div>
        </div>
        <div className="app-access__opt">
          <div>
            <strong>Logins novos da WSA</strong>
            <span>Quando alguém ganha login no Supabase depois de o controle ser ligado, neste aplicativo ele fica:</span>
            <div className="app-access__seg" role="radiogroup" aria-label="Logins novos">
              {(["bloqueado", "liberado"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={app.newLoginsDefault === value}
                  className={app.newLoginsDefault === value ? "is-on" : undefined}
                  disabled={save.isPending}
                  onClick={() => app.newLoginsDefault !== value && saveMeta(value)}
                >
                  {value === "bloqueado" ? "Bloqueado" : "Liberado"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="app-access__banner app-access__banner--info">
        <UserPlus size={16} aria-hidden="true" />
        <span>
          {app.defaultProfile ? (
            <>
              Ao liberar, quem ainda não tem cadastro no {app.name} é <strong>cadastrado como {app.defaultProfile}</strong>.
              Só logins do domínio da empresa, sem sufixo; o perfil pode ser trocado depois no próprio aplicativo.
            </>
          ) : (
            <>O {app.name} não tem cadastro próprio: liberar só abre a porta.</>
          )}
        </span>
      </p>
      {app.controlActive && !checkInstalled(app) && (
        <p className="app-access__banner app-access__banner--danger">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            <strong>O bloqueio NÃO está valendo no {app.name}.</strong> O site dele ainda não consulta esta tela depois do login
            (chave <code>{app.schema}</code>): quem está bloqueado aqui continua entrando até a verificação ser instalada
            {app.protected ? ", mas os dados do schema já ficam protegidos no banco" : ""}. Guia:
            docs/guia-verificacao-acesso-por-aplicativo.md.
          </span>
        </p>
      )}
      {app.controlActive && app.protected && (
        <p className="app-access__banner app-access__banner--ok">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>Proteção no banco ligada:</strong> quem está bloqueado não lê nem grava as tabelas do schema{" "}
            <code>{app.dataSchema ?? app.schema}</code>, mesmo fora do site.
          </span>
        </p>
      )}
      {!app.controlActive && (
        <p className="app-access__banner">
          <Info size={16} aria-hidden="true" />
          <span>
            Com o controle desligado, ninguém é bloqueado. Ao ligar, quem já tem cadastro no aplicativo entra liberado e os demais
            logins ficam bloqueados; depois você ajusta um a um.
          </span>
        </p>
      )}

      <div className="app-access__toolbar">
        <label className="app-access__search">
          <Search size={16} aria-hidden="true" />
          <input
            className="input"
            placeholder="Buscar por nome ou e-mail"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar por nome ou e-mail"
          />
        </label>
        <div className="app-access__seg" role="radiogroup" aria-label="Filtro">
          {(
            [
              ["all", "Todos", counts.all],
              ["yes", "Podem entrar", counts.yes],
              ["no", "Bloqueados", counts.no],
            ] as const
          ).map(([value, label, count]) => (
            <button key={value} type="button" role="radio" aria-checked={filter === value} className={filter === value ? "is-on" : undefined} onClick={() => setFilter(value)}>
              {label} <span>{count}</span>
            </button>
          ))}
        </div>
        <div className="app-access__bulk">
          <span>
            {picked.size} selecionado{picked.size === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn btn--sm-app app-access__ok"
            disabled={picked.size === 0 || !app.controlActive || setPermission.isPending}
            onClick={() => applyPermission([...picked], true)}
          >
            Liberar
          </button>
          <button
            type="button"
            className="btn btn--sm-app app-access__no"
            disabled={picked.size === 0 || !app.controlActive || setPermission.isPending}
            onClick={() => applyPermission([...picked], false)}
          >
            Bloquear
          </button>
        </div>
      </div>

      {users.isPending ? (
        <div className="skeleton" style={{ height: 320, margin: 16 }} aria-busy="true" aria-label="Carregando os logins" />
      ) : users.isError ? (
        <ErrorState message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
      ) : (
        <>
          <div className="app-access__table-wrap">
            <table className="app-access__table">
              <thead>
                <tr>
                  <th className="app-access__check">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos desta página"
                      checked={allPicked}
                      disabled={!app.controlActive || selectable.length === 0}
                      onChange={() =>
                        setPicked(allPicked ? new Set() : new Set([...picked, ...selectable.map((row) => row.id)]))
                      }
                    />
                  </th>
                  <th><ThLabel icon={User}>Usuário</ThLabel></th>
                  <th><ThLabel icon={LogIn}>Último login na WSA</ThLabel></th>
                  <th><ThLabel icon={AppWindow}>Cadastro no aplicativo</ThLabel></th>
                  <th><ThLabel icon={KeyRound}>Pode entrar</ThLabel></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="app-access__empty">
                      Nenhum login encontrado.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((row) => (
                    <UserRow
                      key={row.id}
                      row={row}
                      controlActive={app.controlActive}
                      picked={picked.has(row.id)}
                      busy={setPermission.isPending}
                      onPick={() => togglePick(row.id)}
                      onToggle={() => applyPermission([row.id], !row.canEnter, row.name)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} noun="logins" onPageChange={setPage} />
        </>
      )}

      <ConfirmDialog
        open={confirmControl}
        onOpenChange={setConfirmControl}
        tone="warning"
        title={app.controlActive ? `Desligar o controle no ${app.name}?` : `Ligar o controle no ${app.name}?`}
        description={
          app.controlActive
            ? "Todo login da WSA volta a entrar neste aplicativo. As permissões ficam guardadas para quando você ligar de novo."
            : "Quem já tem cadastro no aplicativo entra liberado e os demais logins ficam bloqueados. Logins criados depois seguem o padrão de logins novos."
        }
        confirmLabel={app.controlActive ? "Desligar controle" : "Ligar controle"}
        isPending={setControl.isPending}
        onConfirm={toggleControl}
      />
    </section>
  );
}

function UserRow({
  row,
  controlActive,
  picked,
  busy,
  onPick,
  onToggle,
}: {
  row: AppAccessUser;
  controlActive: boolean;
  picked: boolean;
  busy: boolean;
  onPick: () => void;
  onToggle: () => void;
}) {
  return (
    <tr>
      <td className="app-access__check">
        <input
          type="checkbox"
          aria-label={`Selecionar ${row.name}`}
          checked={picked}
          disabled={row.owner || !controlActive}
          onChange={onPick}
        />
      </td>
      <td>
        <div className="app-access__who">
          <UserAvatar name={row.name} />
          <div>
            <strong title={row.name}>{row.name}</strong>
            <small title={row.email}>{row.email}</small>
          </div>
        </div>
      </td>
      <td className="app-access__muted">{row.lastSignInAt ? formatRelative(row.lastSignInAt) : "Nunca entrou"}</td>
      <td className="app-access__muted">
        {row.registered ? (
          row.registeredByCentral ? (
            "Cadastrado pela permissão"
          ) : (
            "Cadastrado (origem)"
          )
        ) : row.suffix ? (
          <span className="app-access__faint" title="Conta com sufixo ou fora do domínio da empresa: não recebe cadastro automático.">
            Conta com sufixo
          </span>
        ) : (
          <span className="app-access__faint">Sem cadastro</span>
        )}
      </td>
      <td>
        <div className="app-access__enter">
          <Switch.Root
            className="switch"
            checked={row.canEnter}
            disabled={row.owner || !controlActive || busy}
            onCheckedChange={onToggle}
            aria-label={`${row.name} pode entrar`}
          >
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          {row.owner ? (
            <StatusBadge variant="success">Proprietário</StatusBadge>
          ) : !controlActive ? (
            <StatusBadge variant="neutral">Livre (controle desligado)</StatusBadge>
          ) : row.canEnter ? (
            <StatusBadge variant="success">Pode entrar</StatusBadge>
          ) : (
            <StatusBadge variant="danger">Bloqueado</StatusBadge>
          )}
        </div>
      </td>
    </tr>
  );
}
