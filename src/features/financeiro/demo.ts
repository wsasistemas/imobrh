import { decisoes } from "./conferencia";
import { configs, mockCadastros } from "./service";
import { cfg, titulos } from "./sienge";
import {
  arquivos, cadeiaAdiantamentoMock, contadorMock, ocrMock, registros, regrasEnvioMock, regrasItemMock,
  type Anexo, type Aprovacao, type DadosAdiantamento, type Detalhe, type Evento, type Item, type LeituraOcr,
} from "./solicitacoes";
import type { StatusSolicitacao } from "./components/StatusChip";
import { DIRETOR, GESTOR_DO_SETOR, SETORES_PRODUCAO } from "../atendimento/services/setoresProducao";

// Modo demonstração (VITE_DATA_SOURCE=mock): solicitações fictícias em todas as etapas, para apresentar o módulo à
// gerência antes dos cadastros reais. Nada vai para o Supabase. Os nomes seguem o mockup aprovado; o usuário que
// apresenta (Wagner Antunes) é o solicitante das "Minhas solicitações". Comprovantes e pedidos são desenhados em SVG.

const EU = { id: "u-wagner", nome: "Wagner Antunes", cpfMascarado: "***.456.789-**" };
// Setores da produção que atendem (setoresProducao.ts): cada solicitante está no seu.
const TI = { id: 20, nome: "TI -  Suporte" };
const CFTV = { id: 21, nome: "CFTV" };
const ADM = { id: 22, nome: "Administrativo" };
/** Marca o gestor do setor do solicitante nas etapas (trocado em criar()). */
const GESTOR = "§gestor";
const pessoa = (id: string, nome: string) => ({ id, nome, cpfMascarado: "***.321.654-**" });
const JOAO = pessoa("demo-joao", "João Silva");
const CARLA = pessoa("demo-carla", "Carla Nunes");
const DIEGO = pessoa("demo-diego", "Diego Ramos");
const CATS = ["Material de obra", "Ferramentas", "EPI", "Combustível", "Transporte", "Estacionamento", "Alimentação", "Copa/mantimentos", "Material de escritório", "Outros"]
  .map((nome, i) => ({ id: i + 1, nome }));
const cat = (nome: string) => CATS.find((c) => c.nome === nome)!;

const agora = Date.now();
const DIA = 86_400_000;
const data = (dias: number) => new Date(agora + dias * DIA).toISOString().slice(0, 10);
const ts = (dias: number, hora = 10) => {
  const d = new Date(agora + dias * DIA);
  d.setHours(hora, 12, 0, 0);
  return d.toISOString();
};
const mes = (() => {
  const d = new Date(agora);
  return { de: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10), ate: new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10) };
})();

let anexoId = 70_000;
let itemId = 80_000;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const br = (v: number) => v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const cnpjBr = (c: string) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;

/** Cupom fiscal desenhado (papel térmico) com fornecedor, CNPJ, itens, total e data. */
function cupomSvg(c: { fornecedor: string; cnpj: string; data: string; itens: [string, number][]; titulo?: string; rodape?: string }): string {
  const total = c.itens.reduce((s, [, v]) => s + v, 0);
  const linhas = c.itens.map(([d, v], i) => `<text x="24" y="${178 + i * 22}">${esc(d.slice(0, 26))}</text><text x="336" y="${178 + i * 22}" text-anchor="end">${br(v)}</text>`).join("");
  const y = 178 + c.itens.length * 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="${y + 150}" viewBox="0 0 360 ${y + 150}" font-family="Courier New, monospace" font-size="14" fill="#222">
<rect width="360" height="${y + 150}" fill="#fbfaf6"/><text x="180" y="40" text-anchor="middle" font-weight="bold" font-size="16">${esc(c.fornecedor.slice(0, 30))}</text>
<text x="180" y="62" text-anchor="middle">CNPJ ${cnpjBr(c.cnpj)}</text><text x="180" y="96" text-anchor="middle" font-weight="bold">${esc(c.titulo ?? "CUPOM FISCAL ELETRÔNICO")}</text>
<line x1="20" y1="120" x2="340" y2="120" stroke="#999" stroke-dasharray="4 3"/><text x="24" y="148" font-weight="bold">DESCRIÇÃO</text><text x="336" y="148" text-anchor="end" font-weight="bold">VALOR</text>
${linhas}<line x1="20" y1="${y + 4}" x2="340" y2="${y + 4}" stroke="#999" stroke-dasharray="4 3"/>
<text x="24" y="${y + 38}" font-weight="bold" font-size="18">TOTAL R$</text><text x="336" y="${y + 38}" text-anchor="end" font-weight="bold" font-size="18">${br(total)}</text>
<text x="180" y="${y + 78}" text-anchor="middle">${dataBr(c.data)} 14:32:07</text><text x="180" y="${y + 104}" text-anchor="middle" font-size="11">${esc(c.rodape ?? "Consulte pela chave de acesso em nfce.fazenda.rj.gov.br")}</text>
<text x="180" y="${y + 130}" text-anchor="middle" font-size="11">DOCUMENTO FICTÍCIO · DEMONSTRAÇÃO</text></svg>`;
}

function guardarArquivo(sol: number, nome: string, svg: string): Anexo {
  const id = anexoId++;
  const path = `mock/${sol}/${id}-${nome}`;
  arquivos.set(path, new Blob([svg], { type: "image/svg+xml" }));
  return { id, nome, path, mime: "image/svg+xml", tamanho: svg.length };
}

function leitura(o: Partial<LeituraOcr>): LeituraOcr {
  return {
    tipo_documento: "nfce", data: null, valor_total: null, favorecido: null, cnpj_cpf_emissor: null, chave_acesso: null, itens: [], motivo_sugestoes: [],
    legibilidade: { data: 0.98, valor: 0.99, favorecido: 0.96 }, alertas: [], numero_documento: null, condicao_pagamento: null, referencia_pedido: null, ...o,
  };
}

interface Despesa {
  dias: number;
  valor: number;
  fornecedor: string;
  cnpj: string;
  motivo: string;
  itens?: [string, number][];
  /** Valor impresso diferente do declarado (para o alerta R04). */
  impresso?: number;
  semComprovante?: boolean;
  conferencia?: Item["statusConferencia"];
  glosa?: number;
}

function itensDe(sol: number, ds: Despesa[]): Item[] {
  return ds.map((x, i) => {
    const id = itemId++;
    const dia = data(x.dias);
    const impresso = x.impresso ?? x.valor;
    const anexos: Anexo[] = [];
    if (!x.semComprovante) {
      const a = guardarArquivo(sol, `comprovante-${i + 1}.svg`, cupomSvg({ fornecedor: x.fornecedor, cnpj: x.cnpj, data: dia, itens: x.itens ?? [[x.motivo.toUpperCase(), impresso]] }));
      anexos.push(a);
      ocrMock.set(a.id, leitura({ data: dia, valor_total: impresso, favorecido: x.fornecedor, cnpj_cpf_emissor: x.cnpj, itens: (x.itens ?? [[x.motivo, impresso]]).map(([d, v]) => ({ descricao: d, valor: v })) }));
    }
    if (impresso !== x.valor) regrasItemMock.set(id, [{ codigo: "R04", resultado: "alerta", detalhe: `Comprovante de R$ ${br(impresso)} e declarado R$ ${br(x.valor)}` }]);
    if (x.conferencia && x.conferencia !== "pendente") decisoes.set(id, { status: x.conferencia, glosa: x.glosa ?? 0, obs: x.glosa ? "Item pessoal glosado" : null });
    return { id, ordem: i + 1, data: dia, valor: x.valor, descricao: x.fornecedor, motivo: x.motivo, categoriaId: cat(x.motivo).id, origem: i % 3 === 2 ? "manual" : "ocr_confirmado",
      statusConferencia: x.conferencia ?? "pendente", anexos };
  });
}

type Passo = { papel: string; aprovador: string; status: Aprovacao["status"]; dias?: number; comentario?: string | null };
function aprovacoes(ciclo: number, passos: Passo[]): Aprovacao[] {
  return passos.map((p, i) => ({
    ciclo, nivel: i + 1, papel: p.papel, status: p.status, comentario: p.comentario ?? null, aprovador: p.aprovador, substituto: null,
    prazoEm: p.status === "aguardando" ? ts((p.dias ?? 0) + 2) : null, decididoEm: ["aprovado", "devolvido", "reprovado"].includes(p.status) ? ts(p.dias ?? -1, 11 + i) : null,
  }));
}

function eventos(enviado: number | null, extra: Evento[] = []): Evento[] {
  const e: Evento[] = [{ tipo: "criada", em: ts((enviado ?? 0) - 1), ator: null, payload: {} }];
  if (enviado != null) e.push({ tipo: "enviada", em: ts(enviado), ator: null, payload: { aceite: true } });
  return [...e, ...extra];
}

interface Base {
  numero: number;
  tipo: Detalhe["tipo"];
  status: StatusSolicitacao;
  solicitante: Detalhe["solicitante"];
  setor?: { id: number; nome: string };
  enviado: number | null;
  despesas?: Despesa[];
  aprov?: Passo[];
  ciclo?: number;
  pagarAte?: string | null;
  fundo?: { valor: number; saldoInicial: number };
  adiantamento?: Partial<DadosAdiantamento> & { valor: number };
  extraEventos?: Evento[];
  regrasEnvio?: { codigo: string; nome: string; resultado: "ok" | "alerta" | "bloqueio"; detalhe: string }[];
}

function criar(b: Base): Detalhe {
  const id = b.numero;
  const itens = b.adiantamento
    ? itensDe(id, [{ dias: b.enviado ?? 0, valor: b.adiantamento.valor, fornecedor: b.adiantamento.favorecido ?? "", cnpj: b.adiantamento.favorecidoDoc ?? "", motivo: "Outros", semComprovante: true,
        conferencia: ["lancamento_gerado", "pagamento_programado", "paga", "comprovacao_pendente", "comprovacao_em_conferencia", "devolucao_pendente", "encerrada"].includes(b.status) ? "aceito" : "pendente" }])
    : itensDe(id, b.despesas ?? []);
  if (b.adiantamento) itens[0].descricao = b.adiantamento.favorecido ?? null;
  const total = Math.round(itens.reduce((s, i) => s + (i.valor ?? 0), 0) * 100) / 100;
  const glosa = (b.despesas ?? []).reduce((s, x) => s + (x.glosa ?? 0), 0);
  const ciclo = b.ciclo ?? 1;
  const d: Detalhe = {
    id, numero: `SF-2026-${String(id).padStart(4, "0")}`, tipo: b.tipo, status: b.status, ciclo,
    podeEditar: ["rascunho", "devolvida"].includes(b.status), podeCancelar: ["rascunho", "devolvida"].includes(b.status),
    solicitante: b.solicitante, setor: b.setor ?? TI, competencia: mes.de, periodoDe: b.tipo === "adiantamento" ? null : mes.de, periodoAte: b.tipo === "adiantamento" ? null : mes.ate,
    centroCusto: "00.00114", valorFundoFixo: b.fundo?.valor ?? null, saldoInicial: b.fundo?.saldoInicial ?? null, totalDespesas: total,
    saldoFinal: b.fundo ? b.fundo.saldoInicial - total : null, valorGlosado: glosa, valorAPagar: total - glosa, pagarAte: b.pagarAte ?? null,
    enviadoEm: b.enviado != null ? ts(b.enviado) : null, aceiteEm: b.enviado != null ? ts(b.enviado) : null, criadoEm: ts((b.enviado ?? 0) - 1), atualizadoEm: ts(b.enviado ?? 0, 16),
    itens, aprovacoes: b.aprov ? aprovacoes(ciclo, b.aprov).map((a) => {
      const g = GESTOR_DO_SETOR[(b.setor ?? TI).id];
      return a.aprovador === GESTOR ? { ...a, aprovador: g.nome, substituto: g.substituto } : a;
    }) : [], eventos: eventos(b.enviado, b.extraEventos), cadeiaPrevista: null, categorias: CATS,
  };
  if (b.adiantamento) d.adiantamento = adiantamento(d, b.adiantamento);
  if (b.regrasEnvio) regrasEnvioMock.set(id, b.regrasEnvio.map((r) => ({ ...r, itemId: null })));
  if (d.podeEditar) d.cadeiaPrevista = b.tipo === "adiantamento"
    ? cadeiaAdiantamentoMock(total)
    : [{ nivel: 1, papel: "Gestor", exigido: true, pulado: false, motivo: "sempre", aprovador: GESTOR_DO_SETOR[(b.setor ?? TI).id].nome, substituto: GESTOR_DO_SETOR[(b.setor ?? TI).id].substituto }];
  registros.set(id, d);
  return d;
}

function adiantamento(d: Detalhe, a: Partial<DadosAdiantamento> & { valor: number }): DadosAdiantamento {
  const pedido = guardarArquivo(d.id, `pedido-${a.pedidoNumero}.svg`, cupomSvg({
    fornecedor: a.pedidoFornecedor ?? a.favorecido ?? "", cnpj: a.pedidoFornecedorDoc ?? a.favorecidoDoc ?? "", data: a.pedidoData ?? data(-10), titulo: `PEDIDO DE COMPRA Nº ${a.pedidoNumero}`,
    itens: [[a.finalidade?.split(" - ")[0]?.slice(0, 26) ?? "ITEM", a.pedidoValor ?? a.valor]], rodape: `Condição: ${a.pedidoCondicao ?? "à vista"}`,
  }));
  const base: DadosAdiantamento = {
    obra: "Obra - Arte Wave", contaCaixa: "11401", contaPagamento: "SICOOB - C/C 30.062-4", centroCusto: "00.00114", centroApuracao: null,
    favorecido: null, favorecidoDoc: null, finalidade: null, formaPagamento: "deposito", banco: "ITAU", agencia: "2847", conta: "98667-2", tipoConta: "corrente",
    vencimento: data(3), prazoComprovacao: data(33), dataPreenchimento: d.criadoEm.slice(0, 10), pedidoNumero: null, pedidoData: data(-10), pedidoFornecedor: null,
    pedidoFornecedorDoc: null, pedidoValor: null, pedidoPercentual: 50, pedidoCondicao: "50% sinal - 50% após a entrega", statusComprovacao: null, pagoEm: null,
    siengeSaldoId: null, siengeSaldoErro: null, prazoDias: 30, setorObra: false, ehSolicitante: d.solicitante.id === EU.id,
    rateio: [{ id: 1, tarefa: "29.02.20", porcentagem: 100, valor: a.valor }], documentos: [{ ...pedido, status: "lido", ocr: null }], arquivosComprovacao: [],
    comprovacoes: [], checagensComprovacao: [], obras: null, ...a,
  };
  base.documentos[0].ocr = leitura({ tipo_documento: "outro", data: base.pedidoData, valor_total: base.pedidoValor, favorecido: base.pedidoFornecedor, cnpj_cpf_emissor: base.pedidoFornecedorDoc,
    numero_documento: base.pedidoNumero, condicao_pagamento: base.pedidoCondicao });
  d.itens[0].anexos = [pedido];
  return base;
}

/** NF da comprovação (adiantamento) com o acerto. */
function comprovacao(d: Detalhe, nota: { valor: number; numero: string; dias: number; status: "enviada" | "aceita" | "devolucao" }) {
  const a = d.adiantamento!;
  const arq = guardarArquivo(d.id, `nf-${nota.numero}.svg`, cupomSvg({ fornecedor: a.favorecido ?? "", cnpj: a.favorecidoDoc ?? "", data: data(nota.dias), titulo: `NF-e Nº ${nota.numero}`,
    itens: [[a.finalidade?.slice(0, 26) ?? "ITEM", nota.valor]], rodape: `Ref. pedido ${a.pedidoNumero}` }));
  const ocr = leitura({ tipo_documento: "nfe", data: data(nota.dias), valor_total: nota.valor, favorecido: a.favorecido, cnpj_cpf_emissor: a.favorecidoDoc, numero_documento: nota.numero,
    referencia_pedido: `PED ${a.pedidoNumero}` });
  a.arquivosComprovacao = [{ ...arq, status: "lido", ocr, enviado: true }];
  const adiantado = a.valor ?? 0;
  a.comprovacoes = [{ id: arq.id, anexoId: arq.id, tipoDocumento: "nfe", emitente: a.favorecido, emitenteDoc: a.favorecidoDoc, emissao: data(nota.dias), valor: nota.valor, numero: nota.numero,
    referencia: `PED ${a.pedidoNumero}`, saldoPagar: Math.max(nota.valor - adiantado, 0), saldoDevolver: Math.max(adiantado - nota.valor, 0), status: nota.status, obs: null,
    conferidaEm: null, criadoEm: ts(nota.dias + 1) }];
  const pago = a.pagoEm ? a.pagoEm.slice(0, 10) : data(-20);
  a.checagensComprovacao = [
    ["Emitente = favorecido", "ok", "CNPJ igual ao do adiantamento"],
    ["Emissão após o pagamento", "ok", `${dataBr(data(nota.dias)).slice(0, 5)} ≥ ${dataBr(pago).slice(0, 5)}`],
    ["Dentro do prazo", "ok", `até ${dataBr(a.prazoComprovacao ?? data(10))}`],
    ["Valor ≥ adiantado", nota.valor >= adiantado ? "ok" : "alerta", `${br(nota.valor)} ${nota.valor >= adiantado ? "≥" : "<"} ${br(adiantado)}${nota.valor < adiantado ? ` · devolução de R$ ${br(adiantado - nota.valor)}` : ""}`],
    ["Nota não usada antes", "ok", "Chave de acesso inédita"],
  ].map(([n, r, det]) => ({ codigo: "A07", resultado: r as "ok" | "alerta", detalhe: `${n}: ${det}` }));
}

const R_OK = (cods: string[]) => cods.map((c) => ({ codigo: c, nome: { R01: "Comprovante anexado", R03: "Data no período", R06: "Sem duplicidade", R10: "Saldo do fundo fixo" }[c] ?? c, resultado: "ok" as const, detalhe: "" }));

/** Monta a demonstração (uma vez). */
export function semear() {
  if (registros.size > 0) return;
  const MARINA = GESTOR;

  // ---------- Minhas solicitações (Wagner) ----------
  criar({ numero: 149, tipo: "reembolso", status: "rascunho", solicitante: EU, enviado: null, despesas: [
    { dias: -2, valor: 38.9, fornecedor: "UBER DO BRASIL TECNOLOGIA LTDA", cnpj: "17895646000187", motivo: "Transporte" },
    { dias: -1, valor: 25, fornecedor: "ESTAPAR ESTACIONAMENTOS", cnpj: "61079117000105", motivo: "Estacionamento" },
  ] });
  criar({ numero: 150, tipo: "reembolso", status: "em_aprovacao", solicitante: EU, enviado: -1, despesas: [
    { dias: -6, valor: 210, fornecedor: "AUTO POSTO SHELL BARRA LTDA", cnpj: "12345678000190", motivo: "Combustível", itens: [["GASOLINA COMUM 35,6L", 210]] },
    { dias: -5, valor: 186.3, fornecedor: "LEROY MERLIN CIA BRASILEIRA", cnpj: "01438784000105", motivo: "Material de obra", itens: [["FITA VEDA ROSCA", 12.9], ["LUVA PVC 25MM X10", 48.4], ["SILICONE INCOLOR", 125]] },
    { dias: -4, valor: 90, fornecedor: "RESTAURANTE SABOR DA OBRA", cnpj: "33444555000166", motivo: "Alimentação", itens: [["REFEICAO EQUIPE X3", 90]] },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aguardando", dias: -1 }], regrasEnvio: R_OK(["R01", "R03", "R06"]) });
  criar({ numero: 143, tipo: "reembolso", status: "devolvida", ciclo: 1, solicitante: EU, enviado: -4, despesas: [
    { dias: -9, valor: 64.5, fornecedor: "UBER DO BRASIL TECNOLOGIA LTDA", cnpj: "17895646000187", motivo: "Transporte" },
    { dias: -8, valor: 421.8, fornecedor: "CASA DO CONSTRUTOR", cnpj: "45987321000144", motivo: "Ferramentas", itens: [["ALUGUEL MARTELETE 2 DIAS", 421.8]] },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "devolvido", dias: -3, comentario: "Falta o comprovante do Uber do dia " + dataBr(data(-9)).slice(0, 5) + ": o arquivo anexado é de outra corrida." }] });
  criar({ numero: 146, tipo: "reembolso", status: "paga", solicitante: EU, enviado: -22, pagarAte: data(-6), despesas: [
    { dias: -28, valor: 980, fornecedor: "HOTEL CENTRO RIO", cnpj: "22333444000155", motivo: "Outros", itens: [["HOSPEDAGEM 2 DIARIAS", 980]], conferencia: "aceito" },
    { dias: -27, valor: 260, fornecedor: "AUTO POSTO SHELL BARRA LTDA", cnpj: "12345678000190", motivo: "Combustível", conferencia: "aceito" },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aprovado", dias: -21 }], regrasEnvio: R_OK(["R01", "R03", "R06"]) });
  const fundo = criar({ numero: 144, tipo: "fundo_fixo", status: "lancamento_gerado", solicitante: EU, enviado: -9, pagarAte: data(6), fundo: { valor: 1500, saldoInicial: 1500 },
    despesas: [
      { dias: -14, valor: 145.6, fornecedor: "SUPERMERCADO ZONA SUL", cnpj: "33111222000133", motivo: "Copa/mantimentos", itens: [["CAFE 500G X4", 89.6], ["ACUCAR 5KG", 26], ["COPOS DESCART.", 30]], conferencia: "aceito" },
      { dias: -12, valor: 312, fornecedor: "EPI CENTER LTDA", cnpj: "28999111000122", motivo: "EPI", itens: [["LUVA NITRILICA X12", 112], ["OCULOS PROTECAO X8", 200]], conferencia: "aceito" },
      { dias: -11, valor: 87.4, fornecedor: "PAPELARIA KALUNGA", cnpj: "43283811000150", motivo: "Material de escritório", conferencia: "aceito" },
      { dias: -10, valor: 54, fornecedor: "CHAVEIRO RAPIDO", cnpj: "10111222000199", motivo: "Outros", conferencia: "glosado", glosa: 54 },
    ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aprovado", dias: -8 }], regrasEnvio: R_OK(["R01", "R06", "R10"]) });
  titulos.set(fundo.id, "48211");

  criar({ numero: 151, tipo: "adiantamento", status: "em_aprovacao", solicitante: EU, enviado: 0,
    adiantamento: { valor: 658.4, favorecido: "J.A BLINDAGEM ARQUITETONICA LTDA", favorecidoDoc: "53520864000109", finalidade: "ADIANTAMENTO REFERENTE A COMPRA DE PASSA DOCUMENTOS - 50% DO TOTAL DO PEDIDO",
      pedidoNumero: "001355", pedidoFornecedor: "J.A BLINDAGEM ARQUITETONICA LTDA", pedidoFornecedorDoc: "53520864000109", pedidoValor: 1316.8, vencimento: data(3), prazoComprovacao: data(33) },
    aprov: [{ papel: "Planejamento", aprovador: "", status: "nao_exigido" },
      { papel: "Gerente", aprovador: MARINA, status: "aguardando", dias: 0 }, { papel: "Diretor", aprovador: DIRETOR.nome, status: "nao_exigido" },
      { papel: "Presidente", aprovador: "", status: "nao_exigido" }] });

  const adtComprovar = criar({ numero: 142, tipo: "adiantamento", status: "comprovacao_pendente", solicitante: EU, enviado: -30, pagarAte: data(-25),
    adiantamento: { valor: 1200, favorecido: "VIDRACARIA ATLANTICA LTDA", favorecidoDoc: "11222333000144", finalidade: "ADIANTAMENTO PARA FABRICAÇÃO DOS GUARDA-CORPOS DE VIDRO - 50% DO PEDIDO",
      pedidoNumero: "001298", pedidoFornecedor: "VIDRACARIA ATLANTICA LTDA", pedidoFornecedorDoc: "11222333000144", pedidoValor: 2400, vencimento: data(-25), prazoComprovacao: data(5),
      statusComprovacao: "pendente", pagoEm: ts(-25) },
    aprov: [{ papel: "Planejamento", aprovador: "", status: "nao_exigido" }, { papel: "Gerente", aprovador: MARINA, status: "aprovado", dias: -28 },
      { papel: "Diretor", aprovador: DIRETOR.nome, status: "nao_exigido" }, { papel: "Presidente", aprovador: "", status: "nao_exigido" }] });
  titulos.set(adtComprovar.id, "47930");

  // ---------- De outros colaboradores (Aprovações e Conferência) ----------
  criar({ numero: 152, tipo: "reembolso", status: "em_aprovacao", solicitante: DIEGO, setor: TI, enviado: -3, despesas: [
    { dias: -10, valor: 840, fornecedor: "LOCADORA MOVIDA", cnpj: "21314559000166", motivo: "Transporte", itens: [["LOCACAO VEICULO 3 DIAS", 840]] },
    { dias: -9, valor: 400, fornecedor: "AUTO POSTO IPIRANGA", cnpj: "33337122000127", motivo: "Combustível" },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aguardando", dias: -3 }], regrasEnvio: [{ codigo: "R08", nome: "Limite por categoria", resultado: "alerta", detalhe: "Linha 1 acima do teto de Transporte" }] });
  const prazoVencido = registros.get(152)!.aprovacoes[0];
  prazoVencido.prazoEm = ts(-1);

  criar({ numero: 145, tipo: "fundo_fixo", status: "em_conferencia", solicitante: CARLA, setor: ADM, enviado: -3, pagarAte: data(13), fundo: { valor: 1000, saldoInicial: 1000 },
    despesas: [
      { dias: -14, valor: 210, fornecedor: "AUTO POSTO SHELL BARRA LTDA", cnpj: "12345678000190", motivo: "Combustível", itens: [["GASOLINA COMUM 35,6L", 210]] },
      { dias: -13, valor: 128.9, fornecedor: "SUPERMERCADO GUANABARA", cnpj: "33015577000183", motivo: "Copa/mantimentos", itens: [["CAFE 500G X2", 44.9], ["FILTRO PAPEL", 12], ["AGUA MINERAL 20L X4", 72]] },
      { dias: -12, valor: 186.4, fornecedor: "CASA DO CONSTRUTOR", cnpj: "45987321000144", motivo: "Ferramentas", impresso: 168.4, itens: [["DISCO CORTE X10", 98.4], ["TRENA 8M", 70]] },
      { dias: -10, valor: 94.8, fornecedor: "EPI CENTER LTDA", cnpj: "28999111000122", motivo: "EPI" },
      { dias: -8, valor: 180, fornecedor: "MADEIREIRA SAO JORGE", cnpj: "07888999000101", motivo: "Material de obra" },
      { dias: -6, valor: 132, fornecedor: "PAPELARIA KALUNGA", cnpj: "43283811000150", motivo: "Material de escritório" },
    ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aprovado", dias: -1 }],
    regrasEnvio: [{ codigo: "R04", nome: "Valor confere", resultado: "alerta", detalhe: "Linha 3: comprovante R$ 168,40 e declarado R$ 186,40" }] });

  criar({ numero: 147, tipo: "reembolso", status: "em_conferencia", solicitante: JOAO, setor: CFTV, enviado: -2, pagarAte: data(14), despesas: [
    { dias: -7, valor: 315.8, fornecedor: "TELHANORTE", cnpj: "60000111000122", motivo: "Material de obra", itens: [["CIMENTO CP-II 50KG X6", 215.8], ["AREIA MEDIA 20KG X5", 100]] },
    { dias: -6, valor: 300, fornecedor: "HOTEL CENTRO RIO", cnpj: "22333444000155", motivo: "Outros", itens: [["HOSPEDAGEM 1 DIARIA", 300]] },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aprovado", dias: -1 }], regrasEnvio: R_OK(["R01", "R03", "R06"]) });

  criar({ numero: 139, tipo: "reembolso", status: "pagamento_programado", solicitante: JOAO, setor: CFTV, enviado: -12, pagarAte: data(2), despesas: [
    { dias: -16, valor: 72, fornecedor: "ESTAPAR ESTACIONAMENTOS", cnpj: "61079117000105", motivo: "Estacionamento", conferencia: "aceito" },
    { dias: -15, valor: 154.3, fornecedor: "UBER DO BRASIL TECNOLOGIA LTDA", cnpj: "17895646000187", motivo: "Transporte", conferencia: "aceito" },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "aprovado", dias: -11 }] });
  titulos.set(139, "48102");

  criar({ numero: 138, tipo: "reembolso", status: "reprovada", solicitante: DIEGO, setor: TI, enviado: -15, despesas: [
    { dias: -18, valor: 459, fornecedor: "LOJAS RENNER", cnpj: "92754738000162", motivo: "Outros", itens: [["CAMISA SOCIAL X2", 459]] },
  ], aprov: [{ papel: "Gestor", aprovador: MARINA, status: "reprovado", dias: -14, comentario: "Vestuário não é despesa reembolsável pela política." }] });

  criar({ numero: 153, tipo: "adiantamento", status: "em_conferencia", solicitante: JOAO, setor: CFTV, enviado: -4, pagarAte: data(4),
    adiantamento: { valor: 6000, favorecido: "SEGURA TECH SISTEMAS DE SEGURANCA LTDA", favorecidoDoc: "44555666000177", finalidade: "ADIANTAMENTO PARA AS CÂMERAS E O GRAVADOR DO CFTV DA OBRA - 30% DO PEDIDO",
      pedidoNumero: "001377", pedidoFornecedor: "SEGURA TECH SISTEMAS DE SEGURANCA LTDA", pedidoFornecedorDoc: "44555666000177", pedidoValor: 20000, pedidoPercentual: 30,
      pedidoCondicao: "30% de sinal - saldo na instalação", vencimento: data(4), prazoComprovacao: data(34),
      rateio: [{ id: 1, tarefa: "07.04.10", porcentagem: 70, valor: 4200 }, { id: 2, tarefa: "07.04.20", porcentagem: 30, valor: 1800 }] },
    aprov: [{ papel: "Planejamento", aprovador: "", status: "nao_exigido" }, { papel: "Gerente", aprovador: MARINA, status: "aprovado", dias: -3 },
      { papel: "Diretor", aprovador: DIRETOR.nome, status: "aprovado", dias: -2, comentario: "Liberado: instalação programada para a próxima semana." }, { papel: "Presidente", aprovador: "", status: "nao_exigido" }] });

  const devolucao = criar({ numero: 148, tipo: "adiantamento", status: "comprovacao_em_conferencia", solicitante: JOAO, setor: CFTV, enviado: -35, pagarAte: data(-30),
    adiantamento: { valor: 1200, favorecido: "SERRALHERIA NOVA ERA LTDA", favorecidoDoc: "55666777000188", finalidade: "ADIANTAMENTO PARA PORTÃO DE SERVIÇO - 50% DO PEDIDO",
      pedidoNumero: "001241", pedidoFornecedor: "SERRALHERIA NOVA ERA LTDA", pedidoFornecedorDoc: "55666777000188", pedidoValor: 2400, vencimento: data(-30), prazoComprovacao: data(0),
      statusComprovacao: "enviada", pagoEm: ts(-30) },
    aprov: [{ papel: "Planejamento", aprovador: "", status: "nao_exigido" }, { papel: "Gerente", aprovador: MARINA, status: "aprovado", dias: -33 },
      { papel: "Diretor", aprovador: DIRETOR.nome, status: "nao_exigido" }, { papel: "Presidente", aprovador: "", status: "nao_exigido" }] });
  comprovacao(devolucao, { valor: 850, numero: "000874", dias: -5, status: "enviada" });
  titulos.set(devolucao.id, "47811");

  contadorMock.solicitacao = 154;
  contadorMock.item = itemId;

  // ---------- Cadastros: setores, aprovadores, fundo fixo e SIENGE ----------
  for (const s of SETORES_PRODUCAO) {
    const g = GESTOR_DO_SETOR[s.id];
    if (!g && !s.obra) continue;
    configs.set(s.id, {
      setorId: s.id, obra: s.obra, financeiro: s.financeiro, modoAprovacao: "sequencial", prazoHoras: 48, acaoPrazoVencido: "escalar", centroCustoPadrao: "00.00114",
      prazoComprovacaoDias: 30, acaoComprovacaoVencida: "avisar_bloquear", limiteAdiantamentosAbertos: 3,
      reembolso: g ? [{ papel: "Gestor", aprovadorId: g.id, substitutoId: g.substitutoId, alcadaMinima: 0 }] : [],
      adiantamento: [
        { papel: "planejamento", aprovadorId: null, substitutoId: null, alcadaMinima: null },
        { papel: "gerente", aprovadorId: g?.id ?? null, substitutoId: g?.substitutoId ?? null, alcadaMinima: null },
        { papel: "diretor", aprovadorId: DIRETOR.id, substitutoId: null, alcadaMinima: 5000 },
        { papel: "presidente", aprovadorId: null, substitutoId: null, alcadaMinima: null },
      ],
    } as never);
  }
  mockCadastros.fundos = [
    { id: 1, usuarioId: "u-wagner", usuario: "Wagner Antunes", setor: TI.nome, valor: 1500, vigenteDesde: data(-120) },
    { id: 2, usuarioId: "demo-carla", usuario: "Carla Nunes", setor: ADM.nome, valor: 1000, vigenteDesde: data(-200) },
  ];
  Object.assign(cfg, {
    ativo: true, ambiente: "homologacao", subdominio: "exemplo", usuario: "api.portal", senhaDefinida: true, senhaDefinidaEm: ts(-2), empresaId: 1, tipoDocumento: "AV", indexadorId: 0,
    planoReembolso: "2010101", planoFundoFixo: "2010102", planoAdiantamento: "2010103", centroCustoPadrao: 114,
    ultimoTeste: { ok: true, em: ts(-2, 9), passos: [
      { passo: "Centros de custo", ok: true, detalhe: "148 cadastrados (412 ms)" }, { passo: "Credores", ok: true, detalhe: "3.912 cadastrados (388 ms)" },
      { passo: "Planos financeiros", ok: true, detalhe: "256 cadastrados (301 ms)" }] },
  });
}
