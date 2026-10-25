import { Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertBanner,
  DetailBody,
  DetailDialog,
  FilterSelect,
  InboundChart,
  KpiCard,
  NewTicketDialog,
  PageHeading,
  Panel,
  PanelHeader,
  Pill,
  QueueTable,
  ScopeSegmented,
  SlaHealth,
  TablePagination,
  TeamDistribution,
  Toast,
  TriagePanel,
  useToast,
  type KpiVariant,
  type QueueTableRow,
  type TicketService,
} from "../components/ds";
import "./DesignSystem.css";

// Vitrine do design system do dashboard. Só existe em desenvolvimento (rota /design-system em App.tsx).
// O hex de cada cor é lido do próprio token em tempo de execução, para não repetir valores fora do index.css.

const PALETA: { grupo: string; tokens: string[] }[] = [
  { grupo: "Base", tokens: ["background", "surface", "ink", "muted", "line", "table-head"] },
  { grupo: "Ação e foco", tokens: ["primary", "primary-hover", "primary-fg", "primary-soft", "primary-soft-fg", "ring", "brand"] },
  {
    grupo: "Navegação",
    tokens: ["nav", "nav-fg", "nav-active", "nav-hover", "nav-text", "nav-caption", "nav-count", "nav-border", "nav-active-inset"],
  },
  {
    grupo: "Estados de SLA",
    tokens: ["danger", "danger-soft", "danger-border", "danger-fg", "warning", "warning-soft", "warning-border", "warning-fg", "success", "success-soft"],
  },
  {
    grupo: "Gráficos",
    tokens: ["chart-today", "chart-yesterday", "chart-grid", "team-sistemas", "team-infra", "ai", "ai-soft", "triage-rule", "triage-ai"],
  },
  {
    grupo: "Derivados",
    tokens: ["subtle", "seg-track", "neutral-soft", "neutral-fg", "row-line", "row-hover", "field-border", "field-bg", "danger-tint", "warning-tint"],
  },
];

const TIPOGRAFIA: { classe: string; nome: string; spec: string; texto: string }[] = [
  { classe: "ds-eyebrow", nome: "Eyebrow", spec: "10px · 700 · tracking 1.7px", texto: "PAINEL DA OPERAÇÃO" },
  { classe: "ds-h1", nome: "H1", spec: "29px · 1.25 · -1px", texto: "Olá, Wagner." },
  { classe: "ds-h2", nome: "H2", spec: "16px · -0.3px", texto: "Precisa de ação agora" },
  { classe: "", nome: "Corpo", spec: "14px / 1.5", texto: "Sua equipe, suas prioridades. Tudo em um só lugar." },
  { classe: "ds-small", nome: "Pequeno / tabela", spec: "12px", texto: "Sienge não gera boleto da unidade 1204" },
  { classe: "ds-subtitle", nome: "Subtítulo de painel", spec: "11px", texto: "Vencidos primeiro, depois o próximo prazo de SLA." },
  { classe: "ds-footnote", nome: "Rodapé", spec: "10px", texto: "Ambiente demonstrativo." },
  { classe: "ds-mono", nome: "Nº do ticket", spec: "IBM Plex Mono 500", texto: "#48213" },
];

const KPIS: { variant: KpiVariant; label: string; value: number; hint: string }[] = [
  { variant: "default", label: "Sem responsável", value: 17, hint: "Aguardando atribuição" },
  { variant: "danger", label: "SLA vencido", value: 38, hint: "Prioridade de atendimento" },
  { variant: "warning", label: "Vencem hoje", value: 5, hint: "Antecipe o próximo prazo" },
  { variant: "info", label: "Abertos hoje", value: 29, hint: "Entradas do dia" },
];

const ESCOPOS = [
  { value: "mine", label: "Meus" },
  { value: "team", label: "Minha equipe" },
  { value: "all", label: "Todos" },
] as const;

const LINHAS: QueueTableRow[] = [
  { id: 48213, requester: "Mariana Costa", subject: "Sienge não gera boleto da unidade 1204", team: "Sistemas", service: "ERP Sienge", origin: "Intranet", owner: null, dueMinutes: -3120 },
  { id: 48214, requester: "Pedro Alves", subject: "Erro ao lançar NF no Portal Financeiro", team: "Sistemas", service: "Portais internos", origin: "E-mail", owner: { name: "Ana Silva", initials: "AS" }, dueMinutes: 190 },
  { id: 48215, requester: "Ana Souza", subject: "VPN sem acesso no canteiro Recreio", team: "Infraestrutura", service: "Rede / VPN", origin: "Agente", owner: { name: "Você", initials: "WA" }, dueMinutes: 1530 },
];

const SERVICOS: TicketService[] = [
  { id: 0, name: "ERP Sienge", team: "Sistemas", slaHours: 8 },
  { id: 1, name: "Portais internos", team: "Sistemas", slaHours: 8 },
  { id: 2, name: "Rede / VPN", team: "Infraestrutura", slaHours: 4 },
];

const ENTRADA = [2, 6, 5, 4, 3, 1, 3, 2, 2, 1, 0].map((today, i) => ({ hour: 8 + i, today, yesterday: [3, 4, 5, 3, 2, 2, 2, 1, 1, 1, 0][i] }));

const TOKENS = PALETA.flatMap((g) => g.tokens);

/** Valor atual de cada token --ds-*, lido do :root. */
function useTokenValues() {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(TOKENS.map((n) => [n, style.getPropertyValue(`--ds-${n}`).trim().toUpperCase()])));
  }, []);
  return values;
}

function Secao({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section className="ds-showcase__section" aria-labelledby={id}>
      <h2 className="ds-showcase__title" id={id}>
        {titulo}
      </h2>
      {children}
    </section>
  );
}

export function DesignSystem() {
  const hex = useTokenValues();
  const toast = useToast();
  const [kpi, setKpi] = useState<string | null>("SLA vencido");
  const [escopo, setEscopo] = useState<(typeof ESCOPOS)[number]["value"]>("team");
  const [equipe, setEquipe] = useState("");
  const [pagina, setPagina] = useState(0);
  const [novoAberto, setNovoAberto] = useState(false);
  const [detalhe, setDetalhe] = useState<QueueTableRow | null>(null);

  return (
    <div className="ds ds-showcase">
      <header className="ds-showcase__header">
        <div className="ds-eyebrow">DESIGN SYSTEM</div>
        <h1 className="ds-h1">Imobdesk</h1>
        <p className="ds-muted">Tokens e componentes do dashboard (src/components/ds). Só em desenvolvimento.</p>
      </header>

      <Secao id="ds-paleta" titulo="Paleta">
        {PALETA.map(({ grupo, tokens }) => (
          <div key={grupo} className="ds-showcase__group">
            <p className="ds-subtitle">{grupo}</p>
            <ul className="ds-showcase__swatches">
              {tokens.map((t) => (
                <li key={t} className="ds-showcase__swatch">
                  <span className="ds-showcase__chip" style={{ background: `var(--ds-${t})` }} aria-hidden="true" />
                  <code>--ds-{t}</code>
                  <span className="ds-muted ds-mono">{hex[t]}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Secao>

      <Secao id="ds-tipo" titulo="Escala tipográfica">
        <dl className="ds-showcase__type">
          {TIPOGRAFIA.map(({ classe, nome, spec, texto }) => (
            <div key={nome}>
              <dt className="ds-footnote">
                {nome} · {spec}
              </dt>
              <dd className={classe}>{texto}</dd>
            </div>
          ))}
        </dl>
      </Secao>

      <Secao id="ds-botoes" titulo="Botões e pills">
        <div className="ds-showcase__inline">
          <button type="button" className="ds-btn">
            Ver vencidos →
          </button>
          <button type="button" className="ds-btn ds-btn--primary">
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" className="ds-btn__icon" />
            Novo ticket
          </button>
          <button type="button" className="ds-linkbtn">
            Limpar filtros
          </button>
        </div>
        <div className="ds-showcase__inline">
          <Pill>E-mail</Pill>
          <Pill tone="red">Vencido há 2d 4h</Pill>
          <Pill tone="amber">Vence em 3h 10min</Pill>
          <Pill tone="green">7 dias</Pill>
          <Pill tone="blue">Vence em 1d 2h</Pill>
        </div>
      </Secao>

      <Secao id="ds-heading" titulo="PageHeading, ScopeSegmented e FilterSelect">
        <div className="ds-showcase__stack">
          <PageHeading
            eyebrow="PAINEL DA OPERAÇÃO"
            title="Olá, Wagner."
            description="Sua equipe, suas prioridades. Tudo em um só lugar."
            action={
              <button type="button" className="ds-btn ds-btn--primary" onClick={() => setNovoAberto(true)}>
                <Plus size={16} strokeWidth={1.6} aria-hidden="true" className="ds-btn__icon" />
                Novo ticket
              </button>
            }
          />
          <div className="ds-showcase__inline">
            <ScopeSegmented label="Escopo" options={ESCOPOS} value={escopo} onChange={setEscopo} />
            <FilterSelect
              label="Equipe"
              ariaLabel="Filtrar equipe"
              value={equipe}
              onChange={setEquipe}
              options={[
                { value: "", label: "Todas" },
                { value: "Sistemas", label: "Sistemas" },
                { value: "Infraestrutura", label: "Infraestrutura" },
              ]}
            />
          </div>
        </div>
      </Secao>

      <Secao id="ds-kpis" titulo="KpiCard">
        <p className="ds-subtitle">Clique para alternar o selecionado (outline 2px primary).</p>
        <div className="ds-showcase__kpis">
          {KPIS.map((k) => (
            <KpiCard
              key={k.label}
              {...k}
              selected={kpi === k.label}
              onClick={() => setKpi((atual) => (atual === k.label ? null : k.label))}
            />
          ))}
        </div>
      </Secao>

      <Secao id="ds-alerta" titulo="AlertBanner">
        <AlertBanner
          title="38 tickets com SLA vencido neste recorte"
          description="Priorize o maior atraso e distribua os tickets sem responsável."
          actionLabel="Ver vencidos →"
          onAction={() => toast.show("Ação do alerta.")}
        />
      </Secao>

      <Secao id="ds-fila" titulo="Panel, QueueTable e TablePagination">
        <div className="ds-showcase__stack">
          <Panel>
            <PanelHeader title="Painel vazio" subtitle="Subtítulo do painel." aside={<Pill tone="blue">0 tickets</Pill>} />
          </Panel>
          <Panel aria-labelledby="ds-queue-title">
            <PanelHeader
              title="Precisa de ação agora"
              titleId="ds-queue-title"
              subtitle="Vencidos primeiro, depois o próximo prazo de SLA."
              aside={<Pill tone="blue">{LINHAS.length} tickets</Pill>}
            />
            <div className="ds-queue-tools">
              <input className="ds-search" type="search" aria-label="Buscar tickets" placeholder="Buscar nº, assunto ou solicitante..." />
              <button type="button" className="ds-linkbtn">
                Limpar filtros
              </button>
            </div>
            <QueueTable rows={LINHAS} onOpen={(id) => setDetalhe(LINHAS.find((l) => l.id === id) ?? null)} />
            <TablePagination page={pagina} pageSize={2} total={LINHAS.length} context="Todos" onPageChange={setPagina} />
          </Panel>
          <Panel>
            <QueueTable rows={[]} onOpen={() => undefined} />
          </Panel>
        </div>
      </Secao>

      <Secao id="ds-rail" titulo="TriagePanel e SlaHealth">
        <div className="ds-showcase__two">
          <TriagePanel
            subtitle="Hoje · amostra geral"
            automatic={26}
            total={29}
            bars={[
              { label: "Formulário da intranet", value: 18, tone: "ai" },
              { label: "Regras de e-mail", value: 5, tone: "rule" },
              { label: "IA · confiança ≥ 80%", value: 3, tone: "triage-ai" },
            ]}
            note="3 encaminhados para triagem manual."
            review={{ title: "1 e-mail precisa da sua revisão", text: "Confiança abaixo de 80%. Validar categoria.", onClick: () => toast.show("Revisão aberta.") }}
          />
          <SlaHealth
            period="7 dias"
            metrics={[
              { label: "1ª resposta", percent: 92, tone: "success" },
              { label: "Solução", percent: 78, tone: "warning" },
            ]}
            note={
              <>
                Exemplo global · horário comercial por equipe.
                <br />
                Metas a definir conforme o PRD.
              </>
            }
          />
        </div>
      </Secao>

      <Secao id="ds-graficos" titulo="InboundChart e TeamDistribution">
        <div className="ds-showcase__two">
          <InboundChart subtitle="Tickets por hora · exemplo global" data={ENTRADA} max={6} />
          <TeamDistribution
            grandTotal={76}
            onSelect={(t) => toast.show(`Filtrar a fila por ${t}.`)}
            teams={[
              { name: "Sistemas", total: 42, late: 30, unassigned: 10, colorToken: "--ds-team-sistemas" },
              { name: "Infraestrutura", total: 34, late: 8, unassigned: 7, colorToken: "--ds-team-infra" },
            ]}
          />
        </div>
      </Secao>

      <Secao id="ds-dialogos" titulo="NewTicketDialog, DetailDialog e Toast">
        <div className="ds-showcase__inline">
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => setNovoAberto(true)}>
            Abrir NewTicketDialog
          </button>
          <button type="button" className="ds-btn" onClick={() => setDetalhe(LINHAS[0])}>
            Abrir DetailDialog
          </button>
          <button type="button" className="ds-btn" onClick={() => toast.show("Ticket de exemplo #48289 criado. Sem envio ao sistema real.")}>
            Mostrar Toast
          </button>
        </div>
      </Secao>

      <NewTicketDialog
        open={novoAberto}
        onOpenChange={setNovoAberto}
        services={SERVICOS}
        submitLabel="Criar ticket de exemplo"
        disclaimer="Simulação local. Equipe, prioridade e SLA são regras ilustrativas do catálogo, ainda sujeitas à validação."
        onSubmit={(input) => {
          setNovoAberto(false);
          toast.show(`Ticket de exemplo "${input.subject}" criado. Sem envio ao sistema real.`);
        }}
      />

      <DetailDialog open={detalhe !== null} onOpenChange={(o) => !o && setDetalhe(null)} title={detalhe ? `Ticket #${detalhe.id}` : ""}>
        {detalhe && (
          <DetailBody>
            <h2 className="ds-h2">{detalhe.subject}</h2>
            <p className="ds-muted">
              Solicitante: {detalhe.requester} · Origem: {detalhe.origin}
            </p>
            <p>
              <Pill tone="blue">{detalhe.team}</Pill> <Pill>Novo</Pill>
            </p>
            <p>
              <strong>Responsável:</strong> {detalhe.owner?.name ?? "Não atribuído"}
            </p>
          </DetailBody>
        )}
      </DetailDialog>

      <Toast message={toast.message} />
    </div>
  );
}
