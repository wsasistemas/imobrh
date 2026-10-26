import { Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ESTADOS_CASO, ESTADOS_ETAPA, type EstadoCaso, type EstadoEtapa } from "@imobrh/shared";
import {
  AlertBanner,
  DetailBody,
  DetailDialog,
  EstadoCasoBadge,
  EstadoEtapaBadge,
  FilterSelect,
  KpiCard,
  PageHeading,
  PainelPrazos,
  Panel,
  PanelHeader,
  Pill,
  ScopeSegmented,
  StepperEtapas,
  TablePagination,
  TimelineCaso,
  Toast,
  useToast,
  type EtapaStepper,
  type EventoTimeline,
  type KpiVariant,
  type PrazoLegal,
} from "../components/ds";
import "./DesignSystem.css";

// Vitrine do design system do Console do RH (catálogo em docs/design-system.md). Só existe em desenvolvimento (rota /design-system em App.tsx).
// O hex de cada cor é lido do próprio token em tempo de execução, para não repetir valores fora do index.css.

const PALETA: { grupo: string; tokens: string[] }[] = [
  { grupo: "Base", tokens: ["background", "surface", "ink", "muted", "line", "table-head"] },
  { grupo: "Ação e foco", tokens: ["primary", "primary-hover", "primary-fg", "primary-soft", "primary-soft-fg", "ring", "brand"] },
  {
    grupo: "Navegação",
    tokens: ["nav", "nav-fg", "nav-active", "nav-hover", "nav-text", "nav-caption", "nav-count", "nav-border", "nav-active-inset"],
  },
  {
    grupo: "Estados e prazos",
    tokens: ["danger", "danger-soft", "danger-border", "danger-fg", "warning", "warning-soft", "warning-border", "warning-fg", "success", "success-soft"],
  },
  { grupo: "IA e destaque", tokens: ["ai", "ai-soft"] },
  {
    grupo: "Derivados",
    tokens: ["subtle", "seg-track", "neutral-soft", "neutral-fg", "row-line", "row-hover", "field-border", "field-bg", "danger-tint", "warning-tint"],
  },
];

const TIPOGRAFIA: { classe: string; nome: string; spec: string; texto: string }[] = [
  { classe: "ds-eyebrow", nome: "Eyebrow", spec: "10px · 700 · tracking 1.7px", texto: "CONSOLE DO RH" },
  { classe: "ds-h1", nome: "H1", spec: "29px · 1.25 · -1px", texto: "Olá, Wagner." },
  { classe: "ds-h2", nome: "H2", spec: "16px · -0.3px", texto: "Caixa do RH" },
  { classe: "", nome: "Corpo", spec: "14px / 1.5", texto: "Sua equipe, suas prioridades. Tudo em um só lugar." },
  { classe: "ds-small", nome: "Pequeno / tabela", spec: "12px", texto: "Férias de Ana Paula Ribeiro · início 05/01/2027" },
  { classe: "ds-subtitle", nome: "Subtítulo de painel", spec: "11px", texto: "Ordenada pelo próximo prazo legal." },
  { classe: "ds-footnote", nome: "Rodapé", spec: "10px", texto: "Ambiente demonstrativo." },
  { classe: "ds-mono", nome: "Protocolo / chapa", spec: "IBM Plex Mono 500", texto: "RH-2026-000184 · 000101" },
];

const KPIS: { variant: KpiVariant; label: string; value: number; hint: string }[] = [
  { variant: "default", label: "Abertos", value: 24, hint: "Casos nas suas filas" },
  { variant: "warning", label: "Vencendo hoje", value: 3, hint: "Prazo legal hoje" },
  { variant: "danger", label: "Atrasados", value: 2, hint: "Prazo legal vencido" },
  { variant: "info", label: "Aguardando", value: 6, hint: "Colaborador ou terceiro" },
];

const ESCOPOS = [
  { value: "meus", label: "Meus casos" },
  { value: "fila", label: "Minha fila" },
  { value: "todos", label: "Todos" },
] as const;

const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const ETAPAS: EtapaStepper[] = [
  { id: "e1", nome: "Conferir saldo e programação", responsavel: "DP", estado: "concluida", venceEm: null },
  { id: "e2", nome: "Lançar férias no RM", responsavel: "DP · Lançamento de Férias", estado: "em_andamento", venceEm: dias(2) },
  { id: "e3", nome: "Emitir aviso e coletar assinatura", responsavel: "DP + colaborador", estado: "aberta", venceEm: dias(7), baseLegal: "CLT, art. 135" },
  { id: "e4", nome: "Calcular férias", responsavel: "DP · Cálculo de Férias", estado: "bloqueada", venceEm: dias(32) },
  { id: "e5", nome: "Pagar e coletar recibo assinado", responsavel: "Financeiro + colaborador", estado: "bloqueada", venceEm: dias(35), baseLegal: "CLT, art. 145" },
];

const EVENTOS: EventoTimeline[] = [
  { id: "t3", em: dias(0), ator: "pessoa", autor: "Bruno Carvalho", texto: "Saldo conferido: 30 dias no período 2025/2026.", visivelColaborador: false },
  { id: "t2", em: dias(-1), ator: "rm", autor: "API.RH.FERIAS_SALDO", texto: "Períodos aquisitivos lidos do RM (cache de 15 min).", visivelColaborador: false },
  { id: "t1", em: dias(-2), ator: "sistema", autor: "ImobRH", texto: "Pedido aprovado pela gestora Carla Mendes. Caso aberto.", visivelColaborador: true },
];

const PRAZOS: PrazoLegal[] = [
  { id: "p1", etapa: "Pagar verbas rescisórias", colaborador: "Diego Souza", baseLegal: "CLT, art. 477, §6º", venceEm: dias(-1) },
  { id: "p2", etapa: "Emitir aviso de férias", colaborador: "Ana Paula Ribeiro", baseLegal: "CLT, art. 135", venceEm: dias(0) },
  { id: "p3", etapa: "Enviar admissão ao eSocial (S-2200)", colaborador: "Igor Martins", baseLegal: "eSocial", venceEm: dias(2) },
  { id: "p4", etapa: "Pagar férias", colaborador: "Ana Paula Ribeiro", baseLegal: "CLT, art. 145", venceEm: dias(12) },
];

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
  const [kpi, setKpi] = useState<string | null>("Atrasados");
  const [escopo, setEscopo] = useState<(typeof ESCOPOS)[number]["value"]>("fila");
  const [servico, setServico] = useState("");
  const [pagina, setPagina] = useState(0);
  const [etapa, setEtapa] = useState("e2");
  const [detalhe, setDetalhe] = useState(false);

  return (
    <div className="ds ds-showcase">
      <header className="ds-showcase__header">
        <div className="ds-eyebrow">DESIGN SYSTEM</div>
        <h1 className="ds-h1">ImobRH · Console do RH</h1>
        <p className="ds-muted">Tokens e componentes copiados do imobdesk (src/components/ds) e os do RH. Só em desenvolvimento.</p>
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
            Ver atrasados →
          </button>
          <button type="button" className="ds-btn ds-btn--primary">
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" className="ds-btn__icon" />
            Abrir caso
          </button>
          <button type="button" className="ds-linkbtn">
            Limpar filtros
          </button>
        </div>
        <div className="ds-showcase__inline">
          <Pill>Férias</Pill>
          <Pill tone="red">Vencido há 1 dia</Pill>
          <Pill tone="amber">Vence em 2 dias</Pill>
          <Pill tone="green">Concluído</Pill>
          <Pill tone="blue">Vence em 12 dias</Pill>
        </div>
      </Secao>

      <Secao id="ds-estados" titulo="Estados do caso e da etapa (mapa único)">
        <div className="ds-showcase__stack">
          <div className="ds-showcase__inline">
            {(Object.keys(ESTADOS_CASO) as EstadoCaso[]).map((estado) => (
              <EstadoCasoBadge key={estado} estado={estado} />
            ))}
          </div>
          <div className="ds-showcase__inline">
            {(Object.keys(ESTADOS_ETAPA) as EstadoEtapa[]).map((estado) => (
              <EstadoEtapaBadge key={estado} estado={estado} />
            ))}
          </div>
        </div>
      </Secao>

      <Secao id="ds-heading" titulo="PageHeading, ScopeSegmented e FilterSelect">
        <div className="ds-showcase__stack">
          <PageHeading
            eyebrow="CONSOLE DO RH"
            title="Caixa do RH"
            description="Casos das suas filas, ordenados pelo próximo prazo."
            action={
              <button type="button" className="ds-btn ds-btn--primary" onClick={() => toast.show("Abrir caso: Fase 2.")}>
                <Plus size={16} strokeWidth={1.6} aria-hidden="true" className="ds-btn__icon" />
                Abrir caso
              </button>
            }
          />
          <div className="ds-showcase__inline">
            <ScopeSegmented label="Escopo" options={ESCOPOS} value={escopo} onChange={setEscopo} />
            <FilterSelect
              label="Serviço"
              ariaLabel="Filtrar serviço"
              value={servico}
              onChange={setServico}
              options={[
                { value: "", label: "Todos" },
                { value: "ferias", label: "Férias" },
                { value: "atestado", label: "Atestado" },
                { value: "admissao", label: "Admissão" },
                { value: "desligamento", label: "Desligamento" },
              ]}
            />
          </div>
        </div>
      </Secao>

      <Secao id="ds-kpis" titulo="KpiCard (indicadores da Caixa do RH)">
        <p className="ds-subtitle">Clique para alternar o selecionado (outline 2px primary).</p>
        <div className="ds-showcase__kpis">
          {KPIS.map((k) => (
            <KpiCard key={k.label} {...k} selected={kpi === k.label} onClick={() => setKpi((atual) => (atual === k.label ? null : k.label))} />
          ))}
        </div>
      </Secao>

      <Secao id="ds-alerta" titulo="AlertBanner">
        <AlertBanner
          title="2 casos com prazo legal vencido"
          description="Rescisão fora do prazo do art. 477 gera multa. Priorize os vencidos."
          actionLabel="Ver atrasados →"
          onAction={() => toast.show("Ação do alerta.")}
        />
      </Secao>

      <Secao id="ds-caso" titulo="Tela do caso: StepperEtapas, TimelineCaso e PainelPrazos">
        <div className="ds-showcase__two">
          <Panel padded aria-label="Etapas">
            <StepperEtapas etapas={ETAPAS} atual={etapa} onSelect={setEtapa} />
          </Panel>
          <div className="ds-showcase__stack">
            <Panel padded aria-label="Timeline">
              <TimelineCaso eventos={EVENTOS} />
            </Panel>
            <PainelPrazos prazos={PRAZOS} />
          </div>
        </div>
      </Secao>

      <Secao id="ds-painel" titulo="Panel e TablePagination">
        <Panel>
          <PanelHeader title="Painel vazio" subtitle="Subtítulo do painel." aside={<Pill tone="blue">0 casos</Pill>} />
          <TablePagination page={pagina} pageSize={10} total={24} context="Todos" onPageChange={setPagina} />
        </Panel>
      </Secao>

      <Secao id="ds-dialogos" titulo="DetailDialog e Toast">
        <div className="ds-showcase__inline">
          <button type="button" className="ds-btn" onClick={() => setDetalhe(true)}>
            Abrir DetailDialog
          </button>
          <button type="button" className="ds-btn" onClick={() => toast.show("Vínculo gravado: chapa 000101.")}>
            Mostrar Toast
          </button>
        </div>
      </Secao>

      <DetailDialog open={detalhe} onOpenChange={setDetalhe} title="Caso RH-2026-000184">
        <DetailBody>
          <h2 className="ds-h2">Férias · Ana Paula Ribeiro</h2>
          <p className="ds-muted">Chapa 000101 · Recursos Humanos</p>
          <p>
            <EstadoCasoBadge estado="em_andamento" /> <Pill tone="amber">Vence em 2 dias</Pill>
          </p>
        </DetailBody>
      </DetailDialog>

      <Toast message={toast.message} />
    </div>
  );
}
