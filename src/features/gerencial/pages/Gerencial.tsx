import { Activity, ArrowLeftRight, BarChart3, Bell, BellRing, Briefcase, Building2, CalendarDays, CalendarRange, Download, FileText, Filter, Gauge, LayoutDashboard, Lightbulb, PieChart, Radio, Sparkles, TrendingUp, Trophy, Users } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { getMenuItem } from "../../../config/menuRegistry";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { dia, diasEntre } from "../calculos";
import { PRESETS, useFiltros, useGerencialDados, VisaoProvider } from "../hooks";
import { ORIGEM_ROTULO, type Filtros, type GerencialPayload, type OrigemTicket } from "../types";
import "../Gerencial.css";

// Gestão de Chamados › Gerencial (seção `gestao_chamados_gerencial`): quinze telas sobre os mesmos dados e os mesmos
// filtros (que ficam na URL, então um link reproduz exatamente o que se vê). Cada tela tem um objetivo:
// Dashboard Gerencial (acompanhar a operação) → Dashboard Estratégico (apoiar decisões) → KPIs (medir desempenho) →
// Relatórios (análise detalhada) → Indicadores (situação rápida) → Gráficos (interpretação) → Alertas (antecipar
// problemas) → Notificações (comunicar) → Projeções (cenários) → Comparativos (variações) → Ranking (comparar
// desempenho) → Exportações (uso externo) → Relatórios Executivos (diretoria) → Insights (oportunidades) →
// Recomendações por IA (orientar ações).

const DashboardGerencial = lazy(() => import("./DashboardGerencial").then((m) => ({ default: m.DashboardGerencial })));
const DashboardEstrategico = lazy(() => import("./DashboardEstrategico").then((m) => ({ default: m.DashboardEstrategico })));
const Kpis = lazy(() => import("./Kpis").then((m) => ({ default: m.Kpis })));
const Relatorios = lazy(() => import("./Relatorios").then((m) => ({ default: m.Relatorios })));
const Indicadores = lazy(() => import("./Indicadores").then((m) => ({ default: m.Indicadores })));
const Graficos = lazy(() => import("./Graficos").then((m) => ({ default: m.Graficos })));
const Alertas = lazy(() => import("./Alertas").then((m) => ({ default: m.Alertas })));
const Notificacoes = lazy(() => import("./Notificacoes").then((m) => ({ default: m.Notificacoes })));
const Projecoes = lazy(() => import("./Projecoes").then((m) => ({ default: m.Projecoes })));
const Comparativos = lazy(() => import("./Comparativos").then((m) => ({ default: m.Comparativos })));
const Ranking = lazy(() => import("./Ranking").then((m) => ({ default: m.Ranking })));
const Exportacoes = lazy(() => import("./Exportacoes").then((m) => ({ default: m.Exportacoes })));
const RelatoriosExecutivos = lazy(() => import("./RelatoriosExecutivos").then((m) => ({ default: m.RelatoriosExecutivos })));
const Insights = lazy(() => import("./Insights").then((m) => ({ default: m.Insights })));
const RecomendacoesIa = lazy(() => import("./RecomendacoesIa").then((m) => ({ default: m.RecomendacoesIa })));

export const TELAS = [
  { segmento: "dashboard-gerencial", label: "Dashboard Gerencial", icon: LayoutDashboard, descricao: "Acompanhar a operação: volumes, status, pendências e produtividade." },
  { segmento: "dashboard-estrategico", label: "Dashboard Estratégico", icon: TrendingUp, descricao: "Apoiar decisões: metas, tendências, crescimento, capacidade e projeções." },
  { segmento: "kpis", label: "KPIs", icon: Gauge, descricao: "Medir desempenho: SLA, prazo médio, custo médio, conversão e inadimplência de prazo." },
  { segmento: "relatorios", label: "Relatórios", icon: FileText, descricao: "Análise detalhada: analítico, sintético, consolidado e comparativo." },
  { segmento: "indicadores", label: "Indicadores", icon: Activity, descricao: "Situação rápida: semáforo, percentual, evolução e atingimento de meta." },
  { segmento: "graficos", label: "Gráficos", icon: PieChart, descricao: "Interpretação: linha, barras, pizza, waterfall, linha do tempo e mapa de calor." },
  { segmento: "alertas", label: "Alertas", icon: Bell, descricao: "Antecipar problemas: vencimentos, atrasos, desvios e limites ultrapassados." },
  { segmento: "notificacoes", label: "Notificações", icon: BellRing, descricao: "Comunicar acontecimentos: sino do portal, e-mail, WhatsApp e push." },
  { segmento: "projecoes", label: "Projeções / Forecast", icon: BarChart3, descricao: "Antecipar cenários: demanda, capacidade e backlog para 30, 60 e 90 dias." },
  { segmento: "comparativos", label: "Comparativos", icon: ArrowLeftRight, descricao: "Identificar variações: mês × mês, ano × ano, período × anterior e realizado × meta." },
  { segmento: "ranking", label: "Ranking", icon: Trophy, descricao: "Comparar desempenho: equipes, agentes, serviços, departamentos e canais." },
  { segmento: "exportacoes", label: "Exportações", icon: Download, descricao: "Uso externo: Excel, CSV, PDF, JSON e API." },
  { segmento: "relatorios-executivos", label: "Relatórios Executivos", icon: Briefcase, descricao: "Diretoria: resumo executivo, principais desvios e decisões necessárias." },
  { segmento: "insights", label: "Insights", icon: Lightbulb, descricao: "Oportunidades: anomalias, tendências, riscos e oportunidades." },
  { segmento: "recomendacoes-ia", label: "Recomendações por IA", icon: Sparkles, descricao: "Orientar ações: causas prováveis, previsão e recomendação de decisão." },
] as const;

/** Rotas antigas (antes das quinze abas) → tela equivalente. */
const LEGADO: Record<string, string> = { "visao-geral": "dashboard-gerencial", gestao: "dashboard-gerencial", estrategico: "dashboard-estrategico", analises: "graficos" };

export function Gerencial() {
  const dados = useGerencialDados();
  if (dados.isPending) return <PageSkeleton />;
  if (dados.isError) return <ErrorState message="Não foi possível carregar a visão gerencial." onRetry={() => void dados.refetch()} />;
  return <GerencialConteudo payload={dados.data} />;
}

function GerencialConteudo({ payload }: { payload: GerencialPayload }) {
  const hoje = dia(payload.generated_at);
  const { filtros, preset, definir, aplicarPreset } = useFiltros(hoje);
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const setores = [...new Set(payload.tickets.map((t) => t.setor).filter((s): s is string => Boolean(s)))].sort();
  const equipes = [...new Set(payload.tickets.filter((t) => !filtros.setor || t.setor === filtros.setor).map((t) => t.equipe ?? "").filter(Boolean))].sort();
  const inicio = <Navigate to={{ pathname: `${base}/${TELAS[0].segmento}`, search: location.search }} replace />;

  return (
    <div className="ger">
      <nav className="ger-tabs" aria-label="Telas da visão gerencial">
        {TELAS.map((t) => (
          <NavLink key={t.segmento} to={{ pathname: `${base}/${t.segmento}`, search: location.search }} className={({ isActive }) => `ger-tabs__link${isActive ? " ger-tabs__link--active" : ""}`} title={t.descricao}>
            <t.icon size={15} aria-hidden="true" />
            {t.label}
          </NavLink>
        ))}
      </nav>

      <IntroTela base={base} />

      <BarraFiltros filtros={filtros} preset={preset} definir={definir} aplicarPreset={aplicarPreset} hoje={hoje} setores={setores} equipes={equipes} total={payload.tickets.length} />

      <VisaoProvider payload={payload} filtros={filtros}>
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route index element={inicio} />
            <Route path="dashboard-gerencial" element={<DashboardGerencial />} />
            <Route path="dashboard-estrategico" element={<DashboardEstrategico />} />
            <Route path="kpis" element={<Kpis />} />
            <Route path="relatorios" element={<Relatorios />} />
            <Route path="indicadores" element={<Indicadores />} />
            <Route path="graficos" element={<Graficos />} />
            <Route path="alertas" element={<Alertas />} />
            <Route path="notificacoes" element={<Notificacoes />} />
            <Route path="projecoes" element={<Projecoes />} />
            <Route path="comparativos" element={<Comparativos />} />
            <Route path="ranking" element={<Ranking />} />
            <Route path="exportacoes" element={<Exportacoes />} />
            <Route path="relatorios-executivos" element={<RelatoriosExecutivos />} />
            <Route path="insights" element={<Insights />} />
            <Route path="recomendacoes-ia" element={<RecomendacoesIa />} />
            {Object.entries(LEGADO).map(([de, para]) => (
              <Route key={de} path={de} element={<Navigate to={{ pathname: `${base}/${para}`, search: location.search }} replace />} />
            ))}
            <Route path="*" element={inicio} />
          </Routes>
        </Suspense>
      </VisaoProvider>
    </div>
  );
}

/** Faixa de abertura de cada tela: ícone, nome e o objetivo, para ninguém precisar adivinhar o que está vendo. */
function IntroTela({ base }: { base: string }) {
  const { pathname } = useLocation();
  const tela = TELAS.find((t) => pathname.startsWith(`${base}/${t.segmento}`));
  if (!tela) return null;
  const [objetivo, detalhe] = tela.descricao.split(": ");
  return (
    <div className="ger-intro">
      <span className="ger-intro__ico" aria-hidden="true">
        <tela.icon size={20} />
      </span>
      <div>
        <h2>{tela.label}</h2>
        <p>
          <b>{objetivo}</b>
          {detalhe ? `: ${detalhe}` : ""}
        </p>
      </div>
    </div>
  );
}

interface BarraProps {
  filtros: Filtros;
  preset: string;
  definir: (p: Partial<Filtros>) => void;
  aplicarPreset: (p: (typeof PRESETS)[number]["id"]) => void;
  hoje: string;
  setores: string[];
  equipes: string[];
  total: number;
}

function BarraFiltros({ filtros, preset, definir, aplicarPreset, hoje, setores, equipes, total }: BarraProps) {
  return (
    <div className="ger-filtros" role="group" aria-label="Filtros da visão gerencial">
      <div className="ger-filtros__grupo">
        <span className="ger-filtros__rotulo"><CalendarRange size={13} aria-hidden="true" /> Período</span>
        <div className="ger-filtros__presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={`ger-filtros__preset${preset === p.id ? " ger-filtros__preset--ativo" : ""}`} onClick={() => aplicarPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <label className="ger-filtros__grupo">
        <span className="ger-filtros__rotulo"><CalendarDays size={13} aria-hidden="true" /> De</span>
        <input type="date" value={filtros.de} max={filtros.ate} onChange={(e) => e.target.value && definir({ de: e.target.value })} />
      </label>
      <label className="ger-filtros__grupo">
        <span className="ger-filtros__rotulo"><CalendarDays size={13} aria-hidden="true" /> Até</span>
        <input type="date" value={filtros.ate} min={filtros.de} max={hoje} onChange={(e) => e.target.value && definir({ ate: e.target.value })} />
      </label>
      {setores.length > 1 && (
        <label className="ger-filtros__grupo">
          <span className="ger-filtros__rotulo"><Building2 size={13} aria-hidden="true" /> Setor</span>
          <select value={filtros.setor} onChange={(e) => definir({ setor: e.target.value, equipe: "" })}>
            <option value="">Todos</option>
            {setores.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      )}
      <label className="ger-filtros__grupo">
        <span className="ger-filtros__rotulo"><Users size={13} aria-hidden="true" /> Equipe</span>
        <select value={filtros.equipe} onChange={(e) => definir({ equipe: e.target.value })}>
          <option value="">Todas</option>
          {equipes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="ger-filtros__grupo">
        <span className="ger-filtros__rotulo"><Radio size={13} aria-hidden="true" /> Canal</span>
        <select value={filtros.origem} onChange={(e) => definir({ origem: e.target.value as OrigemTicket | "" })}>
          <option value="">Todos</option>
          {(Object.keys(ORIGEM_ROTULO) as OrigemTicket[]).map((o) => (
            <option key={o} value={o}>{ORIGEM_ROTULO[o]}</option>
          ))}
        </select>
      </label>
      <span className="ger-filtros__resumo">
        <Filter size={13} aria-hidden="true" /> {diasEntre(filtros.de, filtros.ate)} dias · {total.toLocaleString("pt-BR")} tickets carregados (13 meses)
      </span>
    </div>
  );
}
