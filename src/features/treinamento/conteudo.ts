import type { Papel, Restricao } from "./types";

// Conteúdo dos tutoriais para o modo simulado: o mesmo da carga inicial da migration 20261023100000 (os dois saíram de
// MODULOS e QUIZ em docs/mockups/centro-treinamento.html). Carregado sob demanda: não entra no pacote de produção.

export interface ModuloSemente {
  codigo: string;
  titulo: string;
  descricao: string;
  papel: Papel;
  restricao: Restricao | null;
  minutos: number;
  rotaDemo: string;
  celular: boolean;
  pergunta: string;
  opcoes: string[];
  resposta: number;
  baloes: { tela: string; titulo: string; texto: string; alvo: [number, number, number, number] }[];
}

export const TRILHAS_SEMENTE = [
  { codigo: "tickets", nome: "Gestão de Tickets", descricao: "Atender, acompanhar e gerir os chamados do seu setor.", padrao: false, modulos: ["t1", "t2", "t3", "t4", "t5", "t6"] },
  { codigo: "fin", nome: "Solicitações Financeiras", descricao: "Quem pede, quem aprova e quem administra: do reembolso ao pagamento.", padrao: false, modulos: ["f1", "f2", "f3", "f4", "f5"] },
  { codigo: "colaborador", nome: "Colaborador", descricao: "Abrir um chamado e pedir um reembolso, no computador ou no celular.", padrao: true, modulos: ["t6", "f1", "f2"] },
];

export const MODULOS_SEMENTE: ModuloSemente[] = [
  {
    codigo: "t1", titulo: "Visão geral: o painel da sua equipe", descricao: "O que olhar primeiro ao começar o dia: prazos vencidos, tickets sem dono e a triagem.", papel: "atendente", restricao: null,
    minutos: 4, rotaDemo: "/gestao-chamados/visao-geral", celular: false,
    pergunta: "O cartão vermelho \"SLA vencido\" mostra…", opcoes: ["Tickets já fora do prazo","Tickets novos de hoje","Tickets sem categoria"], resposta: 0,
    baloes: [
      { tela: "t-visao", titulo: "Comece pela Visão geral", texto: "É o painel da sua equipe: tudo o que precisa de atenção hoje, num lugar só.", alvo: [1, 22.8, 18.2, 3.9] },
      { tela: "t-visao", titulo: "Os números do dia", texto: "Sem responsável, SLA vencido, vencem hoje, em atendimento. Clique num cartão para ver a lista dele.", alvo: [21.5, 48, 76.5, 14.6] },
      { tela: "t-visao", titulo: "SLA vencido", texto: "O cartão vermelho conta os tickets que já passaram do prazo. Eles são a prioridade.", alvo: [34.5, 48.4, 12, 14.2] },
      { tela: "t-visao", titulo: "Meus, equipe ou todos", texto: "Troque o recorte do painel. Os filtros de equipe e origem ficam à direita.", alvo: [21.5, 41.6, 17.8, 5] },
      { tela: "t-visao", titulo: "Novo ticket", texto: "Abre um ticket na hora, por exemplo para um pedido que chegou por telefone.", alvo: [89.2, 32, 8.7, 4.6] },
      { tela: "t-visao", titulo: "Precisa de ação agora", texto: "A lista já vem em ordem: vencidos primeiro, depois o próximo prazo de SLA.", alvo: [21.5, 74.6, 54, 25.4] },
    ],
  },
  {
    codigo: "t2", titulo: "A fila de tickets: Kanban e visões", descricao: "Colunas por situação, busca, visões da equipe e como ler o prazo de cada cartão.", papel: "atendente", restricao: null,
    minutos: 5, rotaDemo: "/gestao-chamados/tickets", celular: false,
    pergunta: "Para atender um ticket da fila, você…", opcoes: ["Clica no cartão","Arrasta para Pré-fechamento","Liga para o solicitante"], resposta: 0,
    baloes: [
      { tela: "t-tickets", titulo: "A fila em colunas", texto: "A fazer, Aguardando, Em atendimento e Pré-fechamento. Cada cartão é um ticket.", alvo: [21.5, 41.2, 77.3, 58.8] },
      { tela: "t-tickets", titulo: "Escolha a visão", texto: "A visão filtra a fila da sua equipe, em Kanban ou em lista.", alvo: [21.6, 29.8, 19.8, 4.8] },
      { tela: "t-tickets", titulo: "Busque", texto: "Digite o número, parte do assunto ou o nome do solicitante.", alvo: [42, 29.6, 18.2, 4.9] },
      { tela: "t-tickets", titulo: "Leia o cartão", texto: "Número, quem pediu, o assunto e o prazo. A etiqueta vermelha avisa que o SLA venceu; as iniciais são do responsável.", alvo: [61.5, 61.9, 17.4, 12] },
      { tela: "t-tickets", titulo: "Abra o ticket", texto: "Clique no cartão para atender. No próximo módulo abrimos este, o 48231.", alvo: [61.5, 61.9, 17.4, 12] },
    ],
  },
  {
    codigo: "t3", titulo: "Atender um ticket do começo ao fim", descricao: "Serviço, responsável, resposta ao solicitante, solução reaproveitada e status.", papel: "atendente", restricao: null,
    minutos: 7, rotaDemo: "/gestao-chamados/tickets/48231", celular: false,
    pergunta: "O que define a equipe e o prazo de SLA do ticket?", opcoes: ["A urgência","O serviço","As tags"], resposta: 1,
    baloes: [
      { tela: "t-ticket", titulo: "Quem pediu e por onde", texto: "Número, solicitante e canal (aqui, e-mail). Seguir avisa você de cada novidade do ticket.", alvo: [29, 32, 28.6, 3.3] },
      { tela: "t-ticket", titulo: "Status do ticket", texto: "Mostra e muda a situação: Em atendimento, Aguardando, Resolvido…", alvo: [68.5, 31.1, 19.7, 4.8] },
      { tela: "t-ticket", titulo: "Classifique pelo serviço", texto: "O serviço define a equipe e o prazo de SLA. Ele é obrigatório para enviar a resposta.", alvo: [23, 64.6, 22.4, 12.6] },
      { tela: "t-ticket2", titulo: "Assuma o ticket", texto: "Em Responsável, escolha você mesmo. Acima, a Previsão de solução mostra quanto falta, ou quanto já venceu.", alvo: [23, 57.6, 22.4, 16] },
      { tela: "t-ticket", titulo: "Já resolveram antes?", texto: "O portal acha tickets parecidos. Se servir, clique em Usar esta solução na resposta e ajuste o texto.", alvo: [48.3, 80.2, 47.9, 17] },
      { tela: "t-ticket", titulo: "Responda ou anote", texto: "Responder ao solicitante vai para ele. Nota interna fica só para a equipe.", alvo: [48.6, 48.6, 19.3, 3.4] },
      { tela: "t-ticket", titulo: "Escreva a resposta", texto: "A resposta sai pelo mesmo canal em que o pedido chegou.", alvo: [48.3, 51.6, 47.9, 14.8] },
      { tela: "t-ticket", titulo: "Escolha o status e envie", texto: "Marque o Status após enviar, por exemplo Resolvido, e clique em Adicionar ação.", alvo: [48.9, 67.2, 46.6, 10.6] },
      { tela: "t-ticket2", titulo: "Tudo fica no histórico", texto: "Cada resposta, nota e mudança de status entra aqui, com data e autor.", alvo: [48.3, 47, 47.9, 22.5] },
    ],
  },
  {
    codigo: "t4", titulo: "Conversas de WhatsApp", descricao: "A fila do setor, assumir uma conversa e acompanhar quem está com quem.", papel: "atendente", restricao: null,
    minutos: 4, rotaDemo: "/gestao-chamados/conversas", celular: false,
    pergunta: "Onde ficam as conversas esperando atendimento?", opcoes: ["No filtro Na fila","Em Encerradas","No Monitor"], resposta: 0,
    baloes: [
      { tela: "t-conversas", titulo: "WhatsApp ao vivo", texto: "As conversas do seu setor chegam aqui. À esquerda a lista; à direita, o chat e o ticket da conversa.", alvo: [21.7, 38.5, 76.1, 61.5] },
      { tela: "t-conversas", titulo: "Quantos esperam", texto: "Conta as conversas na fila, sem ninguém atendendo.", alvo: [91.6, 32.6, 6.2, 4.3] },
      { tela: "t-conversas", titulo: "Filtre a lista", texto: "Na fila: quem espera. Comigo: as suas. Com outro atendente: as dos colegas.", alvo: [22.4, 45, 21.6, 7.4] },
      { tela: "t-conversas", titulo: "Assuma a conversa", texto: "Na fila e o número vermelho mostram quem espera e quantas mensagens não lidas há. Clique para assumir.", alvo: [21.7, 60.8, 22.9, 7.6] },
      { tela: "t-conversas", titulo: "Lista ou Kanban", texto: "Veja as conversas em lista ou num quadro por situação.", alvo: [21.7, 32.6, 20.8, 4.2] },
    ],
  },
  {
    codigo: "t5", titulo: "Monitor de atendimento", descricao: "Para gestores: indicadores do mês e a situação de cada atendente em tempo real.", papel: "gestor", restricao: "gestor_setor",
    minutos: 4, rotaDemo: "/gestao-chamados/monitor", celular: false,
    pergunta: "Quem vê o Monitor de atendimento?", opcoes: ["Todos os atendentes","Gestores do setor e a supervisão geral","Só o solicitante"], resposta: 1,
    baloes: [
      { tela: "t-monitor", titulo: "Escolha o setor", texto: "Você vê os setores em que é gestor; a supervisão geral vê todos.", alvo: [21.7, 32, 16.7, 4.9] },
      { tela: "t-monitor", titulo: "Os indicadores", texto: "Atendidas, resolvidas no 1º atendimento, tempo médio de espera e de atendimento, com a variação do período.", alvo: [21.7, 38.2, 37.5, 50.8] },
      { tela: "t-monitor", titulo: "Período", texto: "Troque entre hoje, semana e mês.", alvo: [46, 39.6, 9.1, 4.6] },
      { tela: "t-monitor", titulo: "A equipe agora", texto: "Cada atendente: online, disponível, em atendimento e quantas conversas tem. Laranja é pausa; vermelho, ausente.", alvo: [60.3, 38.2, 37.6, 61] },
    ],
  },
  {
    codigo: "t6", titulo: "Como o colaborador abre um chamado", descricao: "O App do solicitante no celular ou no computador: setor, chamado e acompanhamento.", papel: "solicitante", restricao: null,
    minutos: 3, rotaDemo: "/app", celular: true,
    pergunta: "Antes de abrir um chamado no App do solicitante, o colaborador…", opcoes: ["Escolhe o setor","Liga para a TI","Manda um e-mail"], resposta: 0,
    baloes: [
      { tela: "app-home", titulo: "O App do solicitante", texto: "É o app em que qualquer colaborador abre chamados, com o próprio e-mail.", alvo: [4, 6, 92, 34] },
      { tela: "app-home", titulo: "1. Escolha o setor", texto: "Toque em Setor e escolha quem vai atender: TI, Administrativo ou CFTV.", alvo: [4.8, 44.5, 28.5, 13.2] },
      { tela: "app-home", titulo: "2. Abra o chamado", texto: "Descreva o problema e, se ajudar, anexe uma foto.", alvo: [35.9, 44.5, 28.6, 13.2] },
      { tela: "app-home", titulo: "3. Acompanhe", texto: "Em Meus chamados você vê as respostas da equipe.", alvo: [66.8, 44.5, 28.6, 13.2] },
    ],
  },
  {
    codigo: "f1", titulo: "Pedir um reembolso de despesas", descricao: "Do botão Novo reembolso ao envio, com o comprovante lido automaticamente.", papel: "solicitante", restricao: null,
    minutos: 6, rotaDemo: "/financeiro/nova", celular: false,
    pergunta: "Seu pedido voltou como Devolvida. O que fazer?", opcoes: ["Abrir outro pedido","Ler o comentário, corrigir e reenviar","Esperar o Financeiro"], resposta: 1,
    baloes: [
      { tela: "f-minhas", titulo: "Minhas solicitações", texto: "Seus pedidos e a etapa de cada um.", alvo: [21.6, 21.2, 13.2, 3.9] },
      { tela: "f-minhas", titulo: "Contadores por situação", texto: "Rascunhos, em aprovação, devolvidas, no Financeiro, a comprovar e pagas no mês.", alvo: [21.6, 60.2, 76.3, 13.6] },
      { tela: "f-nova", titulo: "Novo reembolso", texto: "Gastou do seu bolso a serviço da empresa? Comece aqui. Paga em até 15 dias após a última aprovação.", alvo: [23.1, 48.5, 11.8, 5] },
      { tela: "f-reembolso", titulo: "Seus dados já vêm", texto: "Nome, CPF e setor vêm do cadastro e não se editam aqui.", alvo: [21.7, 48, 51, 15.9] },
      { tela: "f-reembolso", titulo: "Quem vai aprovar", texto: "A cadeia de aprovação do seu setor, na ordem.", alvo: [74.2, 48, 23.6, 30.2] },
      { tela: "f-reembolso", titulo: "Rascunho automático", texto: "Tudo é salvo sozinho. Pode sair e voltar depois.", alvo: [21.5, 40.4, 14.5, 2.6] },
      { tela: "f-reembolso", titulo: "Antes de enviar", texto: "Confira as checagens e marque a declaração de aceite. O aceite substitui a assinatura.", alvo: [74.2, 80, 23.6, 18] },
      { tela: "f-detalhe", titulo: "Acompanhe", texto: "A linha do tempo mostra cada etapa: gestor, conferência, SIENGE e pagamento.", alvo: [74.2, 41.8, 23.6, 35] },
    ],
  },
  {
    codigo: "f2", titulo: "Pelo celular: comprovante pela câmera", descricao: "Reembolso e fundo fixo no App do solicitante, com a foto do cupom na hora.", papel: "solicitante", restricao: null,
    minutos: 3, rotaDemo: "/app/financeiro", celular: true,
    pergunta: "Sem internet no celular, o comprovante…", opcoes: ["Se perde","Fica no rascunho e sincroniza depois","Vai por e-mail"], resposta: 1,
    baloes: [
      { tela: "app-home", titulo: "Toque em Financeiro", texto: "No App do solicitante do celular, o Financeiro fica na tela inicial.", alvo: [4.8, 58.8, 28.5, 13.2] },
      { tela: "app-fin", titulo: "Reembolso ou fundo fixo", texto: "Escolha e fotografe o cupom na hora. Sem internet, o rascunho sincroniza quando a rede voltar.", alvo: [4.8, 9.6, 90.4, 13.6] },
      { tela: "app-fin", titulo: "Devolvida para ajuste", texto: "Abra, leia o comentário do aprovador, corrija e reenvie.", alvo: [4.8, 60.4, 90.4, 10.8] },
    ],
  },
  {
    codigo: "f3", titulo: "Aprovar, devolver ou reprovar", descricao: "Para aprovadores: a fila, os prazos, o substituto e a decisão.", papel: "gestor", restricao: "aprovador",
    minutos: 4, rotaDemo: "/financeiro/aprovacoes", celular: false,
    pergunta: "Para devolver ou reprovar, é obrigatório…", opcoes: ["Escrever o motivo no comentário","Anexar um PDF","Avisar o Financeiro"], resposta: 0,
    baloes: [
      { tela: "f-aprov", titulo: "Aguardando mim", texto: "O que espera pela sua decisão, com o prazo de cada etapa.", alvo: [21.6, 39.5, 13.4, 5.3] },
      { tela: "f-aprov", titulo: "Prazo vencido", texto: "Faltando 25% do prazo você recebe um lembrete; vencido, a etapa vai para o substituto.", alvo: [70.3, 66.8, 10.2, 3.8] },
      { tela: "f-aprov", titulo: "Definir substituto", texto: "Vai sair de férias? Indique quem aprova no seu lugar.", alvo: [85.6, 31, 12.2, 4.4] },
      { tela: "f-aprov", titulo: "Abrir", texto: "Abre o pedido com as despesas e as checagens automáticas.", alvo: [92.5, 53.3, 4.8, 4.5] },
      { tela: "f-aprov-det", titulo: "Comentário", texto: "Obrigatório para devolver ou reprovar: explique o que precisa mudar.", alvo: [22.8, 81.4, 48.9, 5] },
      { tela: "f-aprov-det", titulo: "Decida", texto: "Reprovar encerra. Devolver para ajuste volta ao solicitante. Aprovar segue para a próxima etapa.", alvo: [39.8, 87.6, 31.9, 5.6] },
    ],
  },
  {
    codigo: "f4", titulo: "Conferência item a item", descricao: "Fila do Financeiro, comprovante ao lado do declarado, aceitar, pedir ajuste ou glosar.", papel: "financeiro", restricao: null,
    minutos: 6, rotaDemo: "/financeiro/conferencia", celular: false,
    pergunta: "Valor do comprovante menor que o declarado. No item, você pode…", opcoes: ["Glosar a diferença","Lançar no SIENGE mesmo assim","Apagar o item"], resposta: 0,
    baloes: [
      { tela: "f-conf", titulo: "A fila do Financeiro", texto: "Os contadores de cada etapa. Comece por A conferir.", alvo: [21.6, 39.6, 76.3, 13.4] },
      { tela: "f-conf", titulo: "Pagar até", texto: "O limite de pagamento de cada pedido. Ordem: aprovação mais antiga primeiro.", alvo: [63.8, 71.4, 11, 21] },
      { tela: "f-conf-det", titulo: "Os itens", texto: "Cada despesa é um item. O alerta laranja indica uma regra a conferir.", alvo: [21.7, 41.8, 17.3, 42.4] },
      { tela: "f-conf-det", titulo: "O comprovante", texto: "Abre aqui dentro, com zoom, girar e tela cheia.", alvo: [40.1, 41.8, 30.2, 42.3] },
      { tela: "f-conf-det", titulo: "Declarado × comprovante", texto: "O que o solicitante informou ao lado do que está no comprovante.", alvo: [71.5, 41.8, 26.5, 30.2] },
      { tela: "f-conf-det", titulo: "Decida o item", texto: "Aceitar, Pedir ajuste ao solicitante ou Glosar o valor.", alvo: [72.6, 92.8, 20.6, 5.6] },
    ],
  },
  {
    codigo: "f5", titulo: "Lançamento no SIENGE e pagamento", descricao: "Gerar o título, programar e marcar como paga.", papel: "financeiro", restricao: null,
    minutos: 4, rotaDemo: "/financeiro/conferencia", celular: false,
    pergunta: "Depois do Lançamento no SIENGE, o pedido vai para…", opcoes: ["Rascunho","Pagamento programado","Aprovação do gestor"], resposta: 1,
    baloes: [
      { tela: "f-conf-det", titulo: "Totais", texto: "Total, glosas e valor a pagar, já com os descontos.", alvo: [22.6, 85.2, 34, 4.4] },
      { tela: "f-conf-det", titulo: "Devolver ao solicitante", texto: "Se faltar algo que só ele resolve, devolva com o motivo.", alvo: [66.2, 88.4, 13, 4.4] },
      { tela: "f-conf-det", titulo: "Lançamento no SIENGE", texto: "Libera quando todos os itens estão resolvidos. Cria o título a pagar com os padrões configurados.", alvo: [80.9, 87.6, 15.8, 5.6] },
      { tela: "f-conf", titulo: "Pagamento programado", texto: "Depois do lançamento, o pedido vem para cá. Quando pagar, marque como paga e o solicitante é avisado.", alvo: [60.2, 39.6, 12.1, 13.4] },
    ],
  },
];
