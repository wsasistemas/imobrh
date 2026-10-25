import { Headset } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { Breadcrumb } from "../components/Breadcrumb";
import { PageSkeleton } from "../components/PageSkeleton";
import { getMenuItem, type MenuItemId } from "../config/menuRegistry";
import { useAccess } from "../features/configuracoes/access/useAccess";
import { EmptyState } from "../features/configuracoes/components/EmptyState";
import { PageHeader } from "../features/configuracoes/components/PageHeader";
import { NotFound } from "./NotFound";
// Abas de seção (mesmo visual de Integrações).
import "../features/configuracoes/pages/Integracoes.css";

const WhatsappOpenwa = lazy(() => import("../features/atendimento/pages/WhatsappOpenwa").then((m) => ({ default: m.WhatsappOpenwa })));
const SolicitanteAdmin = lazy(() => import("../features/solicitante/admin/SolicitanteAdmin").then((m) => ({ default: m.SolicitanteAdmin })));
const FilaHorarios = lazy(() => import("../features/atendimento/pages/FilaHorarios").then((m) => ({ default: m.FilaHorarios })));
const ContasEmail = lazy(() => import("../features/atendimento/pages/ContasEmail").then((m) => ({ default: m.ContasEmail })));
const Setores = lazy(() => import("../features/atendimento/pages/Setores").then((m) => ({ default: m.Setores })));
const ServicosCadastro = lazy(() => import("../features/chamados/cadastros/ServicosCadastro").then((m) => ({ default: m.ServicosCadastro })));
const UrgenciasCadastro = lazy(() => import("../features/chamados/cadastros/UrgenciasCadastro").then((m) => ({ default: m.UrgenciasCadastro })));
const CategoriasCadastro = lazy(() => import("../features/chamados/cadastros/CategoriasCadastro").then((m) => ({ default: m.CategoriasCadastro })));
const CamposCadastro = lazy(() => import("../features/chamados/cadastros/CamposCadastro").then((m) => ({ default: m.CamposCadastro })));
const EmpreendimentosCadastro = lazy(() => import("../features/chamados/empreendimentos/EmpreendimentosCadastro").then((m) => ({ default: m.EmpreendimentosCadastro })));
const GatilhosCadastro = lazy(() => import("../features/chamados/gatilhos/GatilhosCadastro").then((m) => ({ default: m.GatilhosCadastro })));
const RegrasCadastro = lazy(() => import("../features/chamados/cadastros/RegrasCadastro").then((m) => ({ default: m.RegrasCadastro })));

// Gestão de Atendimento: item `gestao_atendimento` do menuRegistry. Cada tela é uma seção
// (`parent: "gestao_atendimento"`) com rota própria abaixo de /gestao-atendimento. O que cada um vê
// dentro da tela (setores, Monitor) vem do banco: gestor só nos setores dele, supervisão geral em todos.
const page = getMenuItem("gestao_atendimento");

const SECOES: { id: MenuItemId; segmento: string }[] = [
  { id: "gestao_atendimento_fila", segmento: "fila" },
  { id: "gestao_atendimento_setores", segmento: "setores" },
  { id: "gestao_atendimento_openwa", segmento: "whatsapp-openwa" },
  { id: "gestao_atendimento_solicitante", segmento: "app-solicitante" },
  { id: "gestao_atendimento_emails", segmento: "emails" },
  { id: "gestao_atendimento_servicos", segmento: "servicos" },
  { id: "gestao_atendimento_urgencias", segmento: "urgencias" },
  { id: "gestao_atendimento_categorias", segmento: "categorias" },
  { id: "gestao_atendimento_campos", segmento: "campos-adicionais" },
  { id: "gestao_atendimento_empreendimentos", segmento: "empreendimentos" },
  { id: "gestao_atendimento_regras_exibicao", segmento: "regras-exibicao" },
  { id: "gestao_atendimento_gatilhos", segmento: "gatilhos" },
];


export function GestaoAtendimento() {
  const { hasPermission } = useAccess();
  const liberadas = SECOES.filter((s) => hasPermission(s.id)).map((s) => ({ ...s, item: getMenuItem(s.id) }));
  const pode = (id: MenuItemId) => hasPermission(id);

  return (
    <>
      <Breadcrumb items={[{ label: "Início", to: "/home" }, { label: page.label }]} />
      <PageHeader title={page.label} description={page.description} />

      {liberadas.length > 1 && (
        <nav className="section-nav" aria-label={`Seções de ${page.label}`}>
          {liberadas.map(({ id, item }) => {
            const Icone = item.icon;
            return (
              <NavLink key={id} to={item.path} className={({ isActive }) => `section-nav__link${isActive ? " section-nav__link--active" : ""}`}>
                <Icone size={16} aria-hidden="true" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      )}

      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route
            index
            element={
              liberadas[0] ? (
                <Navigate to={liberadas[0].item.path} replace />
              ) : (
                <div className="card">
                  <EmptyState icon={Headset} title="Nenhuma tela liberada" description="Peça ao administrador acesso às telas de Administração." />
                </div>
              )
            }
          />
          {/* A Central virou "Conversas" dentro da Gestão de Chamados (09/10/2026): o endereço antigo continua valendo. */}
          <Route path="central" element={<Navigate to={getMenuItem("gestao_atendimento_central").path} replace />} />
          <Route path="fila" element={pode("gestao_atendimento_fila") ? <FilaHorarios /> : <NotFound />} />
          <Route path="setores" element={pode("gestao_atendimento_setores") ? <Setores /> : <NotFound />} />
          <Route path="whatsapp-openwa" element={pode("gestao_atendimento_openwa") ? <WhatsappOpenwa /> : <NotFound />} />
          <Route path="app-solicitante" element={pode("gestao_atendimento_solicitante") ? <SolicitanteAdmin /> : <NotFound />} />
          <Route path="emails" element={pode("gestao_atendimento_emails") ? <ContasEmail /> : <NotFound />} />
          <Route path="servicos" element={pode("gestao_atendimento_servicos") ? <ServicosCadastro /> : <NotFound />} />
          <Route path="urgencias" element={pode("gestao_atendimento_urgencias") ? <UrgenciasCadastro /> : <NotFound />} />
          <Route path="categorias" element={pode("gestao_atendimento_categorias") ? <CategoriasCadastro /> : <NotFound />} />
          <Route path="campos-adicionais" element={pode("gestao_atendimento_campos") ? <CamposCadastro /> : <NotFound />} />
          <Route path="empreendimentos" element={pode("gestao_atendimento_empreendimentos") ? <EmpreendimentosCadastro /> : <NotFound />} />
          <Route path="regras-exibicao" element={pode("gestao_atendimento_regras_exibicao") ? <RegrasCadastro /> : <NotFound />} />
          <Route path="gatilhos" element={pode("gestao_atendimento_gatilhos") ? <GatilhosCadastro /> : <NotFound />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}
