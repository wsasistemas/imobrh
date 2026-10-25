// Gera iconesSetor.data.ts (App do solicitante), iconesMenu.data.ts (menu lateral) e ds/iconesColoridos.data.ts (telas) com os ícones coloridos, embutidos
// no bundle: o <Icon> do Iconify buscaria na api.iconify.design, que a CSP do portal (connect-src) bloqueia.
// Para incluir um ícone: some na lista abaixo e rode `npm run icones:setor`.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ICONES = [
  ["flat-color-icons:folder", "Pasta (padrão)"],
  ["fluent-color:people-team-24", "Equipe"],
  ["flat-color-icons:customer-support", "Suporte"],
  ["fluent-color:code-block-24", "Sistemas / TI"],
  ["flat-color-icons:settings", "Configurações"],
  ["flat-color-icons:multiple-cameras", "CFTV / Câmeras"],
  ["fluent-color:video-24", "Vídeo"],
  ["flat-color-icons:money-transfer", "Financeiro"],
  ["flat-color-icons:calculator", "Contabilidade / Fiscal"],
  ["flat-color-icons:briefcase", "Administrativo"],
  ["flat-color-icons:businessman", "Gestão"],
  ["flat-color-icons:manager", "Diretoria"],
  ["flat-color-icons:document", "Contratos"],
  ["fluent-color:document-text-24", "Documentos"],
  ["flat-color-icons:sales-performance", "Comercial"],
  ["flat-color-icons:shop", "Loja / Vendas"],
  ["flat-color-icons:engineering", "Engenharia"],
  ["flat-color-icons:factory", "Obra"],
  ["fluent-color:building-24", "Prédio"],
  ["fluent-color:building-home-24", "Empreendimento"],
  ["flat-color-icons:home", "Casa"],
  ["fluent-color:wrench-screwdriver-24", "Manutenção"],
  ["fluent-color:toolbox-24", "Assistência técnica"],
  ["fluent-color:shield-checkmark-24", "Compliance / Segurança"],
  ["flat-color-icons:lock", "Acessos"],
  ["flat-color-icons:package", "Suprimentos"],
  ["fluent-color:clipboard-task-24", "Tarefas"],
  ["fluent-color:calendar-24", "Agenda"],
  ["fluent-color:mail-24", "E-mail"],
  ["fluent-color:chat-24", "Atendimento"],
  ["flat-color-icons:phone", "Telefone"],
  ["fluent-color:people-community-24", "RH / Pessoas"],
  ["fluent-color:building-government-24", "Jurídico"],
  ["flat-color-icons:statistics", "Indicadores"],
  ["flat-color-icons:idea", "Ideias / Projetos"],
];

// Menu lateral do portal (Sidebar): ícone colorido de cada item e subitem, pelo id do menuRegistry.
const MENU = [
  ["home", "fluent-color:home-24"],
  ["gestao_chamados", "fluent-color:clipboard-task-24"],
  ["gestao_chamados_visao_geral", "fluent-color:data-pie-24"],
  ["gestao_chamados_tickets", "fluent-color:board-24"],
  ["gestao_atendimento_central", "fluent-color:chat-multiple-24"],
  ["gestao_chamados_monitor", "fluent-color:phone-laptop-24"],
  ["gestao_chamados_status", "fluent-color:checkbox-24"],
  ["gestao_chamados_gerencial", "fluent-color:data-bar-vertical-ascending-24"],
  ["gestao_movidesk", "fluent-color:book-database-24"],
  ["gestao_movidesk_tickets", "fluent-color:apps-list-detail-24"],
  ["gestao_atendimento", "fluent-color:apps-24"],
  ["gestao_atendimento_openwa", "flat-color-icons:phone-android"],
  ["gestao_atendimento_solicitante", "flat-color-icons:touchscreen-smartphone"],
  ["gestao_atendimento_fila", "fluent-color:clock-24"],
  ["gestao_atendimento_setores", "fluent-color:building-people-24"],
  ["gestao_atendimento_emails", "fluent-color:mail-multiple-24"],
  ["gestao_atendimento_servicos", "fluent-color:toolbox-24"],
  ["gestao_atendimento_urgencias", "fluent-color:clock-alarm-24"],
  ["gestao_atendimento_categorias", "fluent-color:document-folder-24"],
  ["gestao_atendimento_campos", "fluent-color:clipboard-text-edit-24"],
  ["gestao_atendimento_empreendimentos", "fluent-color:building-home-24"],
  ["gestao_atendimento_regras_exibicao", "flat-color-icons:filled-filter"],
  ["gestao_atendimento_gatilhos", "fluent-color:arrow-clockwise-dashes-settings-24"],
  ["solicitacoes_financeiras", "flat-color-icons:money-transfer"],
  ["sf_minhas", "fluent-color:document-text-24"],
  ["sf_nova", "fluent-color:clipboard-text-edit-24"],
  ["sf_aprovacoes", "fluent-color:person-available-24"],
  ["sf_conferencia", "flat-color-icons:inspection"],
  ["sf_cadastros", "fluent-color:settings-24"],
  ["configuracoes", "fluent-color:settings-24"],
  ["manage_users", "fluent-color:people-24"],
  ["manage_users_equipes", "fluent-color:people-team-24"],
  ["manage_pessoas", "fluent-color:people-community-24"],
  ["manage_permissions", "fluent-color:person-key-24"],
  ["manage_app_access", "fluent-color:lock-shield-24"],
  ["configure_integrations", "flat-color-icons:data-configuration"],
  ["atendimento_zenvia", "fluent-color:chat-24"],
  ["integracao_movidesk", "fluent-color:book-database-24"],
  ["integracao_sienge", "flat-color-icons:database"],
  ["view_audit_logs", "fluent-color:history-24"],
  ["manage_sessions", "fluent-color:shield-checkmark-24"],
  ["centro_treinamento", "flat-color-icons:graduation-cap"],
  ["centro_treinamento_meus", "flat-color-icons:reading"],
  ["centro_treinamento_gerenciar", "fluent-color:settings-24"],
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
const dados = ICONES.map(([nome, rotulo]) => ({ nome, rotulo, data: dadosDe(nome) }));

const saida = `// Gerado por scripts/gerar-icones-setor.mjs (npm run icones:setor). Não edite à mão.
import type { IconifyIcon } from "@iconify/react";

export const ICONES_SETOR: { nome: string; rotulo: string; data: IconifyIcon }[] = ${JSON.stringify(dados, null, 2)};
`;
writeFileSync(new URL("../src/features/solicitante/iconesSetor.data.ts", import.meta.url), saida);

const menu = MENU.map(([id, nome]) => ({ id, nome, data: dadosDe(nome) }));
writeFileSync(new URL("../src/components/iconesMenu.data.ts", import.meta.url), `// Gerado por scripts/gerar-icones-setor.mjs (npm run icones:setor). Não edite à mão.
import type { IconifyIcon } from "@iconify/react";

/** Ícone colorido de cada item e subitem do menu lateral, pelo id do menuRegistry. */
export const ICONES_MENU: Record<string, { nome: string; data: IconifyIcon }> = ${JSON.stringify(Object.fromEntries(menu.map((m) => [m.id, { nome: m.nome, data: m.data }])), null, 2)};
`);
const usados = [...new Set(LUCIDE.map(([, n]) => n))];
writeFileSync(new URL("../src/components/ds/iconesColoridos.data.ts", import.meta.url), `// Gerado por scripts/gerar-icones-setor.mjs (npm run icones:setor). Não edite à mão.
import type { IconifyIcon } from "@iconify/react";
import { ${LUCIDE.map(([l]) => l).join(", ")}, type LucideIcon } from "lucide-react";

/** Ícone Lucide ilustrativo → nome do colorido (Iconify). */
export const COLORIDO_DE = new Map<LucideIcon, string>([
${LUCIDE.map(([l, n]) => `  [${l}, ${JSON.stringify(n)}],`).join("\n")}
]);

export const DADOS_COLORIDOS: Record<string, IconifyIcon> = ${JSON.stringify(Object.fromEntries(usados.map((n) => [n, dadosDe(n)])), null, 2)};
`);
console.log(`${dados.length} ícones de setor, ${menu.length} do menu e ${LUCIDE.length} das telas gravados.`);
