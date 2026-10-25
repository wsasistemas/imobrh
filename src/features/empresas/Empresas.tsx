import { Building2, CalendarDays, Globe, Info, Users } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../components/Breadcrumb";
import { getMenuItem } from "../../config/menuRegistry";
import { formatDateTime } from "../../utils/dates";
import { configBreadcrumb } from "../configuracoes/components/configBreadcrumb";
import { DataTable, type Column } from "../configuracoes/components/DataTable";
import { EmptyState } from "../configuracoes/components/EmptyState";
import { Notice } from "../configuracoes/components/Notice";
import { PageHeader } from "../configuracoes/components/PageHeader";
import { StatusBadge } from "../configuracoes/components/StatusBadge";
import { ServiceError } from "../configuracoes/services/types";
import { useCriarEmpresa, useEmpresasWsa } from "./hooks";
import type { EmpresaWsa } from "./service";
import "./empresas.css";

/** Configurações › Empresas: só o Super admin da WSA cria empresas (decisão P2 de 23/10/2026). */
export function Empresas() {
  const page = getMenuItem("manage_empresas");
  const ids = useId();
  const empresas = useEmpresasWsa();
  const criar = useCriarEmpresa();
  const [nome, setNome] = useState("");
  const [dominios, setDominios] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [erro, setErro] = useState<{ campo?: string; texto: string } | null>(null);

  const enviar = (event: FormEvent) => {
    event.preventDefault();
    setErro(null);
    const lista = dominios.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
    criar.mutate(
      { nome, dominios: lista, adminEmail },
      {
        onSuccess: () => {
          toast.success(`Empresa ${nome.trim()} criada. Ela já está aberta para você no topo.`);
          setNome("");
          setDominios("");
          setAdminEmail("");
        },
        onError: (error) => setErro(error instanceof ServiceError
          ? { campo: error.field, texto: error.message }
          : { texto: "Não foi possível criar a empresa." }),
      },
    );
  };

  const colunas: Column<EmpresaWsa>[] = [
    { id: "nome", header: "Empresa", icon: Building2, cell: (e) => <strong>{e.nome}</strong> },
    {
      id: "dominios",
      header: "Domínios dos solicitantes",
      icon: Globe,
      cell: (e) =>
        e.dominios.length ? (
          <span className="empresas-dominios">{e.dominios.map((d) => <StatusBadge key={d} variant="neutral">@{d}</StatusBadge>)}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { id: "usuarios", header: "Usuários", icon: Users, align: "right", width: "110px", cell: (e) => e.usuarios },
    { id: "criada", header: "Criada em", icon: CalendarDays, width: "180px", cell: (e) => formatDateTime(e.criadaEm) },
    {
      id: "situacao",
      header: "Situação",
      width: "120px",
      cell: (e) => <StatusBadge variant={e.ativa ? "success" : "neutral"}>{e.ativa ? "Ativa" : "Inativa"}</StatusBadge>,
    },
  ];

  const campoId = (n: string) => `${ids}-${n}`;
  return (
    <>
      <Breadcrumb items={configBreadcrumb(page.label)} />
      <PageHeader title={page.label} description={page.description} />

      <Notice icon={Info}>
        A empresa nova recebe a configuração inicial (status, urgências, categorias, perfis e visões) e abre para você
        como Super admin. Os usuários dela são cadastrados em Configurações › Usuários, com a empresa aberta no topo.
      </Notice>

      <form className="card empresas-form" onSubmit={enviar} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={campoId("nome")}>Nome da empresa</label>
          <input id={campoId("nome")} className="input" value={nome} onChange={(e) => setNome(e.target.value)}
            placeholder="Ex.: Construtora Exemplo" aria-invalid={erro?.campo === "nome" ? "true" : undefined} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={campoId("dominios")}>Domínios de e-mail</label>
          <input id={campoId("dominios")} className="input" value={dominios} onChange={(e) => setDominios(e.target.value)}
            placeholder="suaempresa.com.br" aria-describedby={campoId("dominios-ajuda")} aria-invalid={erro?.campo === "dominios" ? "true" : undefined} />
          <span id={campoId("dominios-ajuda")} className="field__help">Quem tem e-mail destes domínios abre chamado no App do solicitante.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={campoId("admin")}>Admin da empresa (opcional)</label>
          <input id={campoId("admin")} className="input" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="admin@suaempresa.com.br" aria-describedby={campoId("admin-ajuda")} />
          <span id={campoId("admin-ajuda")} className="field__help">Precisa já ter login em algum sistema da WSA.</span>
        </div>
        <button type="submit" className="btn btn--primary" disabled={criar.isPending} aria-busy={criar.isPending}>
          {criar.isPending ? "Criando…" : "Criar empresa"}
        </button>
        {erro && (
          <p className="field__error" role="alert" style={{ gridColumn: "1 / -1", margin: 0 }}>
            {erro.texto}
          </p>
        )}
      </form>

      <section className="card empresas-lista" aria-label="Empresas">
        <DataTable
          caption="Empresas"
          columns={colunas}
          rows={empresas.data}
          rowKey={(e) => e.id}
          isLoading={empresas.isPending}
          isFetching={empresas.isFetching}
          isError={empresas.isError}
          onRetry={() => void empresas.refetch()}
          skeletonRows={3}
          emptyState={<EmptyState icon={Building2} title="Nenhuma empresa ainda" description="Crie a primeira empresa cliente acima." />}
        />
      </section>
    </>
  );
}
