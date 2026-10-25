import type { Cadastros, Macro, Servico } from "./types";

// Modo simulado: a mesma carga inicial da migration 20261007170000 (setores, equipes, urgências, categorias,
// serviços com SLA, campos adicionais, regras e macros).

const SLA_FATORES: [number, number][] = [
  [1, 0.5],
  [2, 0.75],
  [3, 1],
  [4, 2],
];

function servico(id: number, paiId: number | null, setorId: number, nivel: number, nome: string, equipeId: number | null, descricao: string | null, horas: number | null): Servico {
  return {
    id,
    paiId,
    setorId,
    nivel,
    nome,
    equipeId,
    descricao,
    urgenciaPadraoId: 3,
    categoriaPadraoId: 2,
    canais: ["agente", "intranet", "email", "whatsapp"],
    ordem: id,
    ativo: true,
    sla: horas === null ? [] : SLA_FATORES.map(([urgenciaId, f]) => ({ urgenciaId, respostaHoras: (horas * f) / 2, solucaoHoras: horas * f })),
  };
}

export const CADASTROS_INICIAIS: Cadastros = {
  setores: [
    // Os que recebem chamado na produção (mesmos ids e nomes de setoresProducao.ts).
    { id: 20, nome: "TI -  Suporte", ativo: true, recebeChamados: true, slaPadraoHoras: 8, equipePadraoId: null },
    { id: 21, nome: "CFTV", ativo: true, recebeChamados: true, slaPadraoHoras: 8, equipePadraoId: 8 },
    { id: 22, nome: "Administrativo", ativo: true, recebeChamados: true, slaPadraoHoras: 8, equipePadraoId: 9 },
    { id: 23, nome: "Financeiro", ativo: true, recebeChamados: true, slaPadraoHoras: 8, equipePadraoId: 10 },
  ],
  equipes: [
    { id: 6, nome: "Sistemas", setorId: 20, ativa: true, descricaoIa: "Sistemas e software: ERP Sienge, portais internos, acessos e senhas de sistemas." },
    { id: 7, nome: "Infraestrutura", setorId: 20, ativa: true, descricaoIa: "Rede, Wi-Fi, VPN, firewall e liberação de sites, impressoras, computadores e periféricos." },
    { id: 8, nome: "CFTV", setorId: 21, ativa: true, descricaoIa: "Câmeras, gravações e monitoramento." },
    { id: 9, nome: "Administração", setorId: 22, ativa: true, descricaoIa: "Compras, documentos e solicitações internas." },
    { id: 10, nome: "Financeiro", setorId: 23, ativa: true, descricaoIa: "Pagamentos, boletos, notas fiscais, reembolsos e fundo fixo." },
  ],
  urgencias: [
    { id: 1, nome: "Urgente", ordem: 1, cor: "vermelho", descricao: "Operação parada, obra inteira sem sistema ou rede.", padrao: false, ativa: true },
    { id: 2, nome: "Alta", ordem: 2, cor: "laranja", descricao: "Um setor parado ou prazo legal no dia.", padrao: false, ativa: true },
    { id: 3, nome: "Normal", ordem: 3, cor: "azul", descricao: "Uma pessoa afetada, existe contorno.", padrao: true, ativa: true },
    { id: 4, nome: "Baixa", ordem: 4, cor: "cinza", descricao: "Dúvidas e melhorias sem impacto.", padrao: false, ativa: true },
  ],
  categorias: [
    { id: 1, nome: "Dúvida", descricao: "Como fazer algo; sem defeito.", servicos: null, ordem: 1, padrao: false, ativa: true },
    { id: 2, nome: "Problema", descricao: "Algo que funcionava parou ou dá erro.", servicos: null, ordem: 2, padrao: true, ativa: true },
    { id: 3, nome: "Solicitação", descricao: "Pedido de algo novo: acesso, equipamento, cadastro, liberação.", servicos: null, ordem: 3, padrao: false, ativa: true },
    { id: 4, nome: "Incidente", descricao: "Falha que afeta várias pessoas.", servicos: null, ordem: 4, padrao: false, ativa: true },
    { id: 5, nome: "Melhoria", descricao: "Sugestão de mudança.", servicos: null, ordem: 5, padrao: false, ativa: false },
  ],
  servicos: [
    servico(1, null, 1, 1, "TI", null, null, null),
    servico(2, 1, 1, 2, "Sistemas", 6, "Sistemas e software da empresa.", null),
    servico(3, 2, 1, 3, "ERP Sienge", 6, "Erros, lentidão, boletos, notas e relatórios do ERP Sienge.", 8),
    servico(4, 2, 1, 3, "Portais internos", 6, "Portais da empresa: erros e dúvidas.", 8),
    servico(5, 2, 1, 3, "Acessos e usuários", 6, "Criar, bloquear ou liberar usuário; senha de sistema; permissões.", 4),
    servico(6, 1, 1, 2, "Infraestrutura", 7, "Rede, equipamentos e serviços de TI.", null),
    servico(7, 6, 1, 3, "Rede / VPN", 7, "Sem internet, Wi-Fi, VPN que não conecta, rede lenta.", 4),
    servico(8, 6, 1, 3, "Liberação de acesso a sites", 7, "Liberar site ou domínio bloqueado no firewall.", 8),
    servico(9, 6, 1, 3, "Impressão", 7, "Impressora offline, sem toner, fila travada, scanner.", 8),
    servico(10, 6, 1, 3, "Equipamentos", 7, "Computador, notebook, monitor e periféricos.", 16),
    servico(11, null, 2, 1, "CFTV", 8, null, null),
    servico(12, 11, 2, 2, "Câmera sem imagem", 8, "Câmera apagada, sem imagem ou com imagem ruim.", 8),
    servico(13, 11, 2, 2, "Recuperar gravação", 8, "Pedido de imagens gravadas de um período.", 24),
    servico(14, null, 3, 1, "Administrativo", 9, null, null),
    servico(15, 14, 3, 2, "Solicitação administrativa", 9, "Pedidos administrativos em geral.", 24),
  ],
  campos: [
    { id: 1, chave: "forma_atendimento", rotulo: "Forma de atendimento", tipo: "lista", opcoes: ["E-mail", "WhatsApp", "Telefone", "Presencial", "Acesso remoto"], ajuda: "Canal usado pelo agente.", aparece: ["abertura", "detalhe"], interno: false, obrigatorio: "nao", usarEmVisoes: true, ordem: 1, ativo: true },
    { id: 2, chave: "previsao_inicio", rotulo: "Data de previsão de início", tipo: "data", opcoes: [], ajuda: "Para tickets de projeto.", aparece: ["detalhe"], interno: true, obrigatorio: "nao", usarEmVisoes: true, ordem: 2, ativo: true },
    { id: 3, chave: "protocolo", rotulo: "PROTOCOLO", tipo: "texto", opcoes: [], ajuda: "Número do protocolo do fornecedor ou do órgão.", aparece: ["abertura", "detalhe"], interno: false, obrigatorio: "regra", usarEmVisoes: true, ordem: 3, ativo: true },
    { id: 4, chave: "patrimonio", rotulo: "Patrimônio do equipamento", tipo: "texto", opcoes: [], ajuda: "Etiqueta de patrimônio do equipamento.", aparece: ["abertura", "detalhe"], interno: false, obrigatorio: "regra", usarEmVisoes: true, ordem: 4, ativo: true },
    { id: 5, chave: "camera", rotulo: "Câmera", tipo: "texto", opcoes: [], ajuda: "Identificação ou local da câmera.", aparece: ["abertura", "detalhe"], interno: false, obrigatorio: "regra", usarEmVisoes: true, ordem: 5, ativo: true },
    { id: 6, chave: "data_ocorrido", rotulo: "Data do ocorrido", tipo: "data_hora", opcoes: [], ajuda: null, aparece: ["abertura", "detalhe"], interno: false, obrigatorio: "nao", usarEmVisoes: true, ordem: 6, ativo: true },
  ],
  regras: [
    { id: 1, nome: "Protocolo em portais e acessos", ordem: 1, ativa: true, condicoes: [{ campo: "servico", operador: "um_de", valores: ["4", "5"] }, { campo: "categoria", operador: "um_de", valores: ["3"] }], acoes: [{ acao: "obrigar", campo: "protocolo" }] },
    { id: 2, nome: "Patrimônio para equipamentos e impressão", ordem: 2, ativa: true, condicoes: [{ campo: "servico", operador: "um_de", valores: ["9", "10"] }], acoes: [{ acao: "obrigar", campo: "patrimonio" }] },
    { id: 3, nome: "Câmera no CFTV", ordem: 3, ativa: true, condicoes: [{ campo: "setor", operador: "um_de", valores: ["2"] }], acoes: [{ acao: "obrigar", campo: "camera" }, { acao: "exibir", campo: "data_ocorrido" }] },
  ],
};

export const MACROS_INICIAIS: Macro[] = [
  { id: 1, nome: "Pedido de novo teste", texto: "Olá, {{solicitante.nome}}.\n\nPor gentileza, faça um novo teste e nos avise o resultado.\n\nAtenciosamente,\n{{agente.nome}}", acoes: { statusId: 3, justificativaId: 1 }, escopo: "todos", donoId: null, equipeId: null, ativa: true },
  { id: 2, nome: "Acesso liberado", texto: "Olá, {{solicitante.nome}}. O acesso foi liberado. Qualquer dúvida, responda esta mensagem.\n\n{{agente.nome}}", acoes: { statusId: 4, tags: ["liberado"] }, escopo: "todos", donoId: null, equipeId: null, ativa: true },
  { id: 3, nome: "Pedir mais informações", texto: "Olá, {{solicitante.nome}}. Para seguir com o atendimento, precisamos de um print da tela de erro e do horário em que aconteceu.\n\n{{agente.nome}}", acoes: { statusId: 3, justificativaId: 1 }, escopo: "todos", donoId: null, equipeId: null, ativa: true },
  { id: 4, nome: "Encerramento por falta de retorno", texto: "Olá, {{solicitante.nome}}.\n\nComo não tivemos retorno, estamos encerrando o ticket #{{ticket.numero}}. Se precisar, é só responder esta mensagem que ele volta a ser atendido.\n\n{{agente.nome}}", acoes: {}, escopo: "todos", donoId: null, equipeId: null, ativa: true },
];
