import {
  Activity,
  AlarmClock,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  BarChart3,
  Bell,
  BellRing,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Clock,
  Compass,
  Download,
  FileSpreadsheet,
  FileText,
  Flame,
  Gauge,
  Globe,
  Hourglass,
  Inbox,
  Layers,
  LineChart,
  ListChecks,
  ListOrdered,
  Medal,
  MessagesSquare,
  PauseCircle,
  PieChart,
  Radio,
  RefreshCcw,
  Repeat,
  Rocket,
  ScrollText,
  ShieldCheck,
  Siren,
  Sparkles,
  Tags,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserRound,
  UserRoundX,
  Users,
  Waves,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Ícones por assunto do Gerencial: seções e KPIs escolhem o ícone pelo título, para cada análise ser reconhecida de
// relance (o mesmo assunto tem o mesmo ícone em todas as telas). A ordem importa: a primeira regra que casa vence,
// então as mais específicas vêm antes. Quem precisar de outro ícone passa `icone` explicitamente.

export type Tema = "azul" | "verde" | "ambar" | "vermelho" | "roxo" | "ciano" | "cinza";

interface Regra {
  re: RegExp;
  icone: LucideIcon;
  tema: Tema;
}

const REGRAS: Regra[] = [
  // IA, insights e decisões
  { re: /\bIA\b|intelig|recomenda/i, icone: Sparkles, tema: "roxo" },
  { re: /anomal/i, icone: Zap, tema: "ambar" },
  { re: /oportunidad/i, icone: Rocket, tema: "verde" },
  { re: /risco/i, icone: Siren, tema: "vermelho" },
  { re: /insight/i, icone: Sparkles, tema: "roxo" },
  { re: /decis/i, icone: Compass, tema: "roxo" },
  { re: /resumo executivo|executiv|diretoria/i, icone: Briefcase, tema: "roxo" },
  { re: /desvio/i, icone: AlertTriangle, tema: "vermelho" },

  // Títulos que misturam assuntos: resolvidos antes das regras genéricas
  { re: /metas e limites/i, icone: Target, tema: "verde" },
  { re: /mapa de calor|dia × hora|dia da semana|quando os chamados/i, icone: Flame, tema: "vermelho" },
  { re: /waterfall|ponte do backlog/i, icone: Waves, tema: "azul" },
  { re: /linha do tempo|ritmo/i, icone: Activity, tema: "azul" },
  { re: /entradas e resolvidos|entradas, resolvidos/i, icone: Activity, tema: "azul" },
  { re: /produtividade/i, icone: UserRound, tema: "ciano" },

  // Alertas e avisos
  { re: /cr[ií]tico/i, icone: Siren, tema: "vermelho" },
  { re: /aten[cç][aã]o/i, icone: AlertTriangle, tema: "ambar" },
  { re: /dentro do limite/i, icone: ShieldCheck, tema: "verde" },
  { re: /notifica|aviso|sino/i, icone: BellRing, tema: "ambar" },
  { re: /enviar alertas/i, icone: Bell, tema: "ambar" },
  { re: /alerta|limite/i, icone: AlertTriangle, tema: "ambar" },
  { re: /canais\b|canais ativos/i, icone: Radio, tema: "ciano" },

  // Projeções e tendências
  { re: /proje|previs|forecast|cen[aá]rio/i, icone: TrendingUp, tema: "roxo" },
  { re: /capacidade/i, icone: Gauge, tema: "ciano" },
  { re: /confiabilidade/i, icone: ShieldCheck, tema: "cinza" },
  { re: /zerar/i, icone: CalendarClock, tema: "verde" },
  { re: /tend[eê]ncia|crescimento|trimestre/i, icone: TrendingUp, tema: "azul" },
  { re: /queda/i, icone: TrendingDown, tema: "azul" },

  // Comparações e rankings
  { re: /ano ×|ano anterior|ano x/i, icone: CalendarDays, tema: "azul" },
  { re: /m[eê]s ×|mês a mês|mes x/i, icone: CalendarDays, tema: "azul" },
  { re: /realizado|×|compar/i, icone: ArrowLeftRight, tema: "azul" },
  { re: /top 10|ranking/i, icone: Trophy, tema: "ambar" },
  { re: /pareto/i, icone: ListOrdered, tema: "azul" },

  // Metas e indicadores
  { re: /atingimento|meta/i, icone: Target, tema: "verde" },
  { re: /indicador|kpi|painel/i, icone: Gauge, tema: "azul" },

  // Prazos e tempos
  { re: /vencem|vence nas/i, icone: AlarmClock, tema: "ambar" },
  { re: /vencid/i, icone: AlarmClock, tema: "vermelho" },
  { re: /fora do prazo/i, icone: AlarmClock, tema: "vermelho" },
  { re: /\bsla\b|no prazo/i, icone: Timer, tema: "verde" },
  { re: /1ª resposta|primeira resposta|\btpr\b/i, icone: MessagesSquare, tema: "ciano" },
  { re: /assumir/i, icone: UserRound, tema: "ciano" },
  { re: /mais antigo|idade/i, icone: Hourglass, tema: "ambar" },
  { re: /parado/i, icone: PauseCircle, tema: "vermelho" },
  { re: /pendente|pend[eê]ncia/i, icone: Hourglass, tema: "ambar" },
  { re: /tempo|\btmr\b|prazo/i, icone: Clock, tema: "ciano" },

  // Volumes e fluxo
  { re: /reabert/i, icone: Repeat, tema: "vermelho" },
  { re: /cancelad/i, icone: RefreshCcw, tema: "cinza" },
  { re: /taxa de resolu|convers|1º contato|primeiro contato/i, icone: CheckCircle2, tema: "verde" },
  { re: /resolvid|resolu/i, icone: CheckCircle2, tema: "verde" },
  { re: /sem respons/i, icone: UserRoundX, tema: "vermelho" },
  { re: /backlog|fila|abertos/i, icone: Inbox, tema: "ambar" },
  { re: /entrada|demanda|volume/i, icone: ArrowDownToLine, tema: "azul" },
  { re: /ritmo|linha do tempo|por dia\b/i, icone: Activity, tema: "azul" },

  // Pessoas e organização
  { re: /agente|produtividade|carga/i, icone: UserRound, tema: "ciano" },
  { re: /equipe/i, icone: Users, tema: "ciano" },
  { re: /departament|setor/i, icone: Building2, tema: "cinza" },
  { re: /servi[cç]o/i, icone: Wrench, tema: "cinza" },
  { re: /canal|\bmix\b/i, icone: Radio, tema: "ciano" },
  { re: /categoria|urg[eê]ncia|status/i, icone: Tags, tema: "cinza" },

  // Esforço e custo
  { re: /esfor[cç]o|intera[cç]|custo/i, icone: Layers, tema: "roxo" },

  // Gráficos e análises
  { re: /mapa de calor|dia × hora|dia da semana|quando os chamados/i, icone: Flame, tema: "vermelho" },
  { re: /waterfall|ponte/i, icone: Waves, tema: "azul" },
  { re: /pizza|participa/i, icone: PieChart, tema: "roxo" },
  { re: /linha\b/i, icone: LineChart, tema: "azul" },
  { re: /barras|colunas|distribui/i, icone: BarChart3, tema: "azul" },
  { re: /hist[oó]rico|meses/i, icone: CalendarDays, tema: "cinza" },

  // Relatórios e exportações
  { re: /\bapi\b/i, icone: Globe, tema: "cinza" },
  { re: /excel|pasta completa/i, icone: FileSpreadsheet, tema: "verde" },
  { re: /json|dados brutos/i, icone: ScrollText, tema: "cinza" },
  { re: /export|baixar|individuais/i, icone: Download, tema: "azul" },
  { re: /relat[oó]rio|anal[ií]tico|sint[eé]tico|consolidado/i, icone: FileText, tema: "azul" },
  { re: /como a proje|o que a ia recebe|como /i, icone: ListChecks, tema: "cinza" },
  { re: /medalha|reconhec/i, icone: Medal, tema: "ambar" },
];

const PADRAO: Regra = { re: /.*/, icone: BarChart3, tema: "azul" };

/** Ícone e cor de fundo para um título de seção ou rótulo de KPI. */
export function iconeDe(texto: string): { icone: LucideIcon; tema: Tema } {
  const r = REGRAS.find((x) => x.re.test(texto)) ?? PADRAO;
  return { icone: r.icone, tema: r.tema };
}
