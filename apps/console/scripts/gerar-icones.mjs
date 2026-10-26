// Gera iconesMenu.data.ts (menu lateral) e ds/iconesColoridos.data.ts (telas) com os ícones coloridos, embutidos
// no bundle: o <Icon> do Iconify buscaria na api.iconify.design, que a CSP do portal (connect-src) bloqueia.
// Para incluir um ícone: some na lista abaixo e rode `npm run icones -w apps/console`.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Menu lateral do portal (Sidebar): ícone colorido de cada item e subitem, pelo id do menuRegistry.
const MENU = [
  ["caixa_rh", "fluent-color:mail-inbox-all-24"],
  ["meus_casos", "fluent-color:clipboard-task-24"],
  ["prazos_legais", "fluent-color:calendar-clock-24"],
  ["config_processos", "fluent-color:flow-24"],
  ["config_aprovacoes", "fluent-color:person-available-24"],
  ["config_vinculos", "fluent-color:contact-card-24"],
  ["configuracoes", "fluent-color:settings-24"],
  ["manage_users", "fluent-color:people-24"],
  ["manage_permissions", "fluent-color:person-key-24"],
  ["configure_integrations", "flat-color-icons:data-configuration"],
  ["view_audit_logs", "fluent-color:history-24"],
  ["manage_sessions", "fluent-color:shield-checkmark-24"],
  // Rodapé do menu (ids próprios, fora do menuRegistry).
  ["rodape_recolher", "flat-color-icons:previous"],
  ["rodape_expandir", "flat-color-icons:next"],
  ["rodape_senha", "flat-color-icons:key"],
  ["rodape_sair", "flat-color-icons:export"],
];

// Ícones ilustrativos de dentro das telas (cabeçalho de tabela, aviso, tela vazia, cards da Página Inicial): o ícone
// Lucide que a tela já passa → o colorido. Botões de ação não passam por aqui e continuam em linha (decisão 16/10/2026).
const LUCIDE = [
  ["Activity", "flat-color-icons:line-chart"], ["AlignLeft", "fluent-color:text-bullet-list-square-24"],
  ["AppWindow", "fluent-color:apps-24"], ["ArrowUpDown", "flat-color-icons:generic-sorting-asc"],
  ["Asterisk", "flat-color-icons:high-priority"], ["Briefcase", "flat-color-icons:briefcase"],
  ["Building", "fluent-color:building-multiple-24"], ["Building2", "fluent-color:building-24"],
  ["CalendarClock", "fluent-color:calendar-clock-24"], ["CalendarPlus", "fluent-color:calendar-checkmark-24"],
  ["CalendarRange", "fluent-color:calendar-24"], ["ChartColumn", "flat-color-icons:bar-chart"],
  ["CircleCheckBig", "flat-color-icons:ok"], ["CircleDot", "fluent-color:checkmark-circle-24"],
  ["Clock", "fluent-color:clock-24"], ["Columns3", "flat-color-icons:add-column"],
  ["Contact", "fluent-color:book-contacts-24"], ["Crown", "fluent-color:premium-24"],
  ["Eye", "flat-color-icons:binoculars"], ["FileCode2", "fluent-color:code-24"],
  ["FileDown", "flat-color-icons:download"], ["FileSearch", "flat-color-icons:inspection"],
  ["FileText", "fluent-color:document-text-24"], ["Flag", "fluent-color:flag-24"],
  ["FolderTree", "flat-color-icons:tree-structure"], ["Gauge", "fluent-color:gauge-24"],
  ["HardDrive", "flat-color-icons:database"], ["HardHat", "flat-color-icons:engineering"],
  ["Hash", "fluent-color:number-symbol-square-24"], ["Headset", "fluent-color:headset-24"],
  ["History", "fluent-color:history-24"], ["Hourglass", "flat-color-icons:overtime"],
  ["IdCard", "fluent-color:contact-card-24"], ["Inbox", "flat-color-icons:feed-in"],
  ["Info", "flat-color-icons:info"], ["KeyRound", "flat-color-icons:key"],
  ["Layers", "flat-color-icons:template"], ["LayoutDashboard", "flat-color-icons:combo-chart"],
  ["LayoutGrid", "flat-color-icons:grid"], ["LayoutPanelTop", "fluent-color:content-view-24"],
  ["Lightbulb", "fluent-color:lightbulb-24"], ["ListChecks", "flat-color-icons:todo-list"],
  ["ListOrdered", "flat-color-icons:numerical-sorting-12"], ["ListPlus", "flat-color-icons:add-row"],
  ["Lock", "fluent-color:lock-closed-24"], ["LogIn", "flat-color-icons:import"],
  ["Mail", "fluent-color:mail-24"], ["Megaphone", "fluent-color:megaphone-loud-24"],
  ["MessageSquare", "fluent-color:comment-24"], ["MessageSquareReply", "fluent-color:chat-more-24"],
  ["MessagesSquare", "fluent-color:comment-multiple-24"], ["MonitorOff", "flat-color-icons:display"],
  ["MonitorSmartphone", "flat-color-icons:multiple-devices"], ["Paperclip", "flat-color-icons:file"],
  ["Percent", "flat-color-icons:pie-chart"], ["Phone", "fluent-color:phone-24"],
  ["SearchX", "flat-color-icons:search"], ["Server", "fluent-color:database-24"],
  ["Shapes", "fluent-color:puzzle-piece-24"], ["Smartphone", "flat-color-icons:iphone"],
  ["Smile", "flat-color-icons:like"], ["Sparkles", "fluent-color:bot-sparkle-24"],
  ["Star", "fluent-color:star-24"], ["Tag", "flat-color-icons:bookmark"],
  ["Tags", "fluent-color:bookmark-24"], ["Ticket", "fluent-color:receipt-24"],
  ["Timer", "fluent-color:clock-alarm-24"], ["ToggleRight", "fluent-color:options-24"],
  ["TrendingUp", "fluent-color:data-trending-24"], ["User", "fluent-color:person-24"],
  ["UserCheck", "fluent-color:person-available-24"], ["UserPen", "fluent-color:person-feedback-24"],
  ["Users", "fluent-color:people-24"], ["UsersRound", "fluent-color:people-team-24"],
  ["Wallet", "flat-color-icons:money-transfer"], ["Receipt", "fluent-color:receipt-24"], ["Calculator", "flat-color-icons:calculator"], ["Wifi", "fluent-color:wifi-24"], ["Wrench", "fluent-color:wrench-24"],
  ["Zap", "flat-color-icons:flash-on"],
];

const colecoes = new Map();
const dadosDe = (nome) => {
  const [prefixo, icone] = nome.split(":");
  if (!colecoes.has(prefixo)) colecoes.set(prefixo, JSON.parse(readFileSync(require.resolve(`@iconify-json/${prefixo}/icons.json`), "utf8")));
  const c = colecoes.get(prefixo);
  const i = c.icons[icone];
  if (!i) throw new Error(`Ícone não existe: ${nome}`);
  return { body: i.body, width: i.width ?? c.width ?? 16, height: i.height ?? c.height ?? 16 };
};
const menu = MENU.map(([id, nome]) => ({ id, nome, data: dadosDe(nome) }));
writeFileSync(new URL("../src/components/iconesMenu.data.ts", import.meta.url), `// Gerado por scripts/gerar-icones-setor.mjs (npm run icones). Não edite à mão.
import type { IconifyIcon } from "@iconify/react";

/** Ícone colorido de cada item e subitem do menu lateral, pelo id do menuRegistry. */
export const ICONES_MENU: Record<string, { nome: string; data: IconifyIcon }> = ${JSON.stringify(Object.fromEntries(menu.map((m) => [m.id, { nome: m.nome, data: m.data }])), null, 2)};
`);
const usados = [...new Set(LUCIDE.map(([, n]) => n))];
writeFileSync(new URL("../src/components/ds/iconesColoridos.data.ts", import.meta.url), `// Gerado por scripts/gerar-icones-setor.mjs (npm run icones). Não edite à mão.
import type { IconifyIcon } from "@iconify/react";
import { ${LUCIDE.map(([l]) => l).join(", ")}, type LucideIcon } from "lucide-react";

/** Ícone Lucide ilustrativo → nome do colorido (Iconify). */
export const COLORIDO_DE = new Map<LucideIcon, string>([
${LUCIDE.map(([l, n]) => `  [${l}, ${JSON.stringify(n)}],`).join("\n")}
]);

export const DADOS_COLORIDOS: Record<string, IconifyIcon> = ${JSON.stringify(Object.fromEntries(usados.map((n) => [n, dadosDe(n)])), null, 2)};
`);
console.log(`${menu.length} ícones do menu e ${LUCIDE.length} das telas gravados.`);
