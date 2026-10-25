// PDF do formulário no layout padrão 2026 (o mesmo do preview, tela 10): título, cabeçalho, linhas,
// totais, informações de preenchimento e o bloco de aceites (substitui as assinaturas). Vai anexado ao título no SIENGE
// e é o "Baixar PDF" do preview.

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import { valorPorExtenso } from "../_shared/sf/adiantamento.ts";

export interface DadosPdf {
  /** Nome da empresa no canto do cabeçalho (sem ele, "Imobdesk"). */
  empresa?: string;
  numero: string;
  tipo: "reembolso" | "fundo_fixo" | "adiantamento";
  solicitante: { nome: string };
  cpf: string | null;
  setor: { nome: string } | null;
  competencia: string | null;
  periodoDe: string | null;
  periodoAte: string | null;
  valorFundoFixo: number | null;
  saldoInicial: number | null;
  totalDespesas: number;
  saldoFinal: number | null;
  valorGlosado: number;
  valorAPagar: number | null;
  aceiteEm: string | null;
  itens: { data: string | null; valor: number | null; descricao: string | null; motivo: string | null }[];
  aprovacoes: { ciclo: number; papel: string; status: string; aprovador: string | null; decididoEm: string | null; comentario: string | null }[];
  ciclo: number;
  adiantamento?: DadosAdiantamento;
}

export interface DadosAdiantamento {
  obra: string | null; contaCaixa: string | null; contaPagamento: string | null; centroCusto: string | null; centroApuracao: string | null;
  valor: number | string | null; favorecido: string | null; favorecidoDoc: string | null; finalidade: string | null;
  formaPagamento: string | null; banco: string | null; agencia: string | null; conta: string | null; tipoConta: string | null;
  vencimento: string | null; prazoComprovacao: string | null; dataPreenchimento: string | null; pedidoNumero: string | null;
  rateio: { tarefa: string; porcentagem: number | string; valor: number | string }[];
}

const TITULO = { reembolso: "REEMBOLSO", fundo_fixo: "FUNDO FIXO DE CAIXA", adiantamento: "ADIANTAMENTO DE NUMERÁRIO" } as const;
const MESES = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];

const n2 = (v: number | null | undefined) => (Number(v ?? 0)).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const dataBR = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const dataHoraBR = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "pendente";
const mes = (iso: string | null) => (iso ? `${MESES[Number(iso.slice(5, 7)) - 1]} - ${iso.slice(0, 4)}` : "—");
const cpfFmt = (d: string | null) => (d && /^\d{11}$/.test(d) ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d ?? "—");
/** Helvetica padrão usa WinAnsi: troca o que ela não desenha. */
const limpo = (s: string) => s.replace(/[→←]/g, "-").replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/g, "");

function corta(t: string, f: PDFFont, tam: number, largura: number): string {
  let s = limpo(t);
  if (f.widthOfTextAtSize(s, tam) <= largura) return s;
  while (s.length > 1 && f.widthOfTextAtSize(`${s}…`, tam) > largura) s = s.slice(0, -1);
  return `${s}…`;
}

export async function gerarPdf(d: DadosPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${TITULO[d.tipo]} ${d.numero}`);
  doc.setProducer("Imobdesk · WSA Sistemas");
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const preto = rgb(0.07, 0.07, 0.07);
  const cinza = rgb(0.94, 0.94, 0.94);
  const azulWsa = rgb(0.24, 0.45, 0.66);
  const M = 40;
  const L = 595 - 2 * M;
  let pagina: PDFPage = doc.addPage([595, 842]);
  let y = 842 - M;

  const texto = (t: string, x: number, yy: number, tam = 9, fonte = f, cor = preto) => pagina.drawText(limpo(t), { x, y: yy, size: tam, font: fonte, color: cor });
  const caixa = (x: number, yy: number, w: number, h: number, fundo?: ReturnType<typeof rgb>) =>
    pagina.drawRectangle({ x, y: yy, width: w, height: h, borderColor: preto, borderWidth: 0.7, color: fundo });
  const novaPagina = () => {
    pagina = doc.addPage([595, 842]);
    y = 842 - M;
  };

  // Topo
  texto("Título:", M, y - 8, 7, b);
  texto(TITULO[d.tipo], M, y - 22, 13, b);
  const marca = limpo(d.empresa?.trim() || "Imobdesk");
  const tamMarca = Math.min(22, (L / 2) / Math.max(1, b.widthOfTextAtSize(marca, 1)));
  texto(marca, 595 - M - b.widthOfTextAtSize(marca, tamMarca), y - 22, tamMarca, b);
  pagina.drawRectangle({ x: 595 - M - 8, y: y - 26, width: 8, height: 3, color: azulWsa });
  pagina.drawLine({ start: { x: M, y: y - 32 }, end: { x: 595 - M, y: y - 32 }, thickness: 1.5, color: preto });
  y -= 48;

  // Adiantamento de numerário (modelo padrão): campos do formulário, rateio, termo e as aprovações da cadeia.
  if (d.tipo === "adiantamento" && d.adiantamento) {
    const a = d.adiantamento;
    const docFmt = (x: string | null) =>
      x && /^\d{14}$/.test(x) ? `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}` : cpfFmt(x);
    const forma = { deposito: "DEPÓSITO", boleto: "BOLETO", cheque: "CHEQUE", dinheiro: "DINHEIRO" }[a.formaPagamento ?? ""] ?? "—";
    const kv: [string, string, string, string][] = [
      ["OBRA (EMPRESA PAGADORA):", (a.obra ?? "—").toUpperCase(), "DATA DO PREENCHIMENTO:", dataBR(a.dataPreenchimento)],
      ["CONTA CAIXA:", a.contaCaixa ?? "—", "CONTA DE PAGAMENTO:", a.contaPagamento ?? "—"],
      ["CENTRO DE CUSTO:", a.centroCusto ?? "—", "CENTRO DE APURAÇÃO:", a.centroApuracao ?? "—"],
      ["VALOR:", `R$ ${n2(Number(a.valor ?? 0))}`, "Nº:", d.numero],
      ["FAVORECIDO:", (a.favorecido ?? "—").toUpperCase(), "CPF/CNPJ:", docFmt(a.favorecidoDoc)],
      ["FORMA DE PAGAMENTO:", forma, "PEDIDO:", a.pedidoNumero ?? "—"],
      ...(a.formaPagamento === "deposito"
        ? [["BANCO / AGÊNCIA:", `${a.banco ?? "—"} / ${a.agencia ?? "—"}`, "CONTA / TIPO:", `${a.conta ?? "—"} / ${a.tipoConta === "poupanca" ? "POUPANÇA" : "CORRENTE"}`] as [string, string, string, string]]
        : []),
      ["VENCIMENTO:", dataBR(a.vencimento), "COMPROVAR ATÉ:", dataBR(a.prazoComprovacao)],
      ["FUNCIONÁRIO:", d.solicitante.nome.toUpperCase(), "DEPARTAMENTO:", (d.setor?.nome ?? "—").toUpperCase()],
    ];
    const ck = [130, 150, 110, L - 390];
    for (const linha of kv) {
      let x = M;
      linha.forEach((v, i) => {
        caixa(x, y - 16, ck[i], 16, i % 2 === 0 ? cinza : undefined);
        texto(corta(v, i % 2 === 0 ? b : f, 8, ck[i] - 8), x + 4, y - 11, 8, i % 2 === 0 ? b : f);
        x += ck[i];
      });
      y -= 16;
    }
    // Valor por extenso e finalidade (linha inteira)
    for (const [rot, val] of [["VALOR POR EXTENSO:", valorPorExtenso(Number(a.valor ?? 0))], ["FINALIDADE:", (a.finalidade ?? "—").toUpperCase()]] as const) {
      caixa(M, y - 16, ck[0], 16, cinza);
      texto(rot, M + 4, y - 11, 8, b);
      caixa(M + ck[0], y - 16, L - ck[0], 16);
      texto(corta(val, f, 8, L - ck[0] - 8), M + ck[0] + 4, y - 11, 8);
      y -= 16;
    }
    y -= 12;
    // Rateio por tarefa
    const cr = [L - 220, 100, 120];
    const linhaR = (vals: string[], negrito: boolean, fundoCor?: ReturnType<typeof rgb>) => {
      let x = M;
      vals.forEach((v, i) => {
        caixa(x, y - 15, cr[i], 15, fundoCor);
        const fo = negrito ? b : f;
        const tt = corta(v, fo, 8.5, cr[i] - 8);
        texto(tt, i === 0 ? x + 4 : x + cr[i] - 4 - fo.widthOfTextAtSize(tt, 8.5), y - 10.5, 8.5, fo);
        x += cr[i];
      });
      y -= 15;
    };
    linhaR(["RATEIO POR TAREFA", "PORCENTAGEM", "VALOR"], true, cinza);
    for (const r of a.rateio) linhaR([r.tarefa, `${String(r.porcentagem).replace(".", ",")}%`, n2(Number(r.valor))], false);
    y -= 14;
    // Termo
    const termo = limpo(`TERMO DE RESPONSABILIDADE: o funcionário assume comprovar este adiantamento com nota fiscal ou recibo até ${dataBR(a.prazoComprovacao)}. `
      + "Sem comprovação no prazo, o gestor é avisado e novos adiantamentos ficam bloqueados. As assinaturas foram substituídas pelo aceite eletrônico e pelas aprovações registradas no Portal.");
    const lt: string[] = [];
    let atual = "";
    for (const w of termo.split(" ")) {
      const tt = atual ? `${atual} ${w}` : w;
      if (f.widthOfTextAtSize(tt, 8.5) > L - 12) {
        lt.push(atual);
        atual = w;
      } else atual = tt;
    }
    lt.push(atual);
    const hT = lt.length * 11 + 8;
    caixa(M, y - hT, L, hT);
    lt.forEach((l, i) => texto(l, M + 6, y - 12 - i * 11, 8.5));
    y -= hT + 26;
    // Aceite + aprovações do ciclo (Planejamento, Gerente, Diretor, Presidente)
    const aprov = d.aprovacoes.filter((x) => x.ciclo === d.ciclo && x.status === "aprovado");
    const blocosA: [string, string][] = [
      ["ACEITE DO FUNCIONÁRIO", `${d.solicitante.nome} · ${dataHoraBR(d.aceiteEm)}`],
      ...aprov.map((x) => [`APROVAÇÃO · ${x.papel.toUpperCase()}`, `${x.aprovador ?? x.papel} · ${dataHoraBR(x.decididoEm)}`] as [string, string]),
    ];
    blocosA.forEach(([tt, l1], i) => {
      if (i % 2 === 0 && i > 0) y -= 44;
      if (y < M + 40) novaPagina();
      const x = M + (i % 2) * (L / 2 + 6);
      const w = L / 2 - 6;
      pagina.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.7, color: preto });
      texto(tt, x, y - 12, 8.5, b);
      texto(corta(l1, f, 8.5, w), x, y - 24, 8.5);
    });
    return await doc.save();
  }

  // Cabeçalho (2 pares por linha)
  const fundo = d.tipo === "fundo_fixo";
  const pares: [string, string, string, string][] = [
    ...(fundo ? [["VALOR DO FUNDO FIXO:", `R$ ${n2(d.valorFundoFixo)}`, "SALDO INICIAL:", `R$ ${n2(d.saldoInicial)}`] as [string, string, string, string]] : []),
    ["FUNCIONÁRIO:", d.solicitante.nome.toUpperCase(), "CPF:", cpfFmt(d.cpf)],
    ["DEPARTAMENTO:", (d.setor?.nome ?? "—").toUpperCase(), "MÊS:", mes(d.competencia)],
    ["PERÍODO:", `DE ${dataBR(d.periodoDe)} A ${dataBR(d.periodoAte)}`, "Nº:", d.numero],
  ];
  const cols = [120, 150, 95, L - 365];
  for (const linha of pares) {
    let x = M;
    linha.forEach((v, i) => {
      caixa(x, y - 16, cols[i], 16, i % 2 === 0 ? cinza : undefined);
      texto(corta(v, i % 2 === 0 ? b : f, 8.5, cols[i] - 8), x + 4, y - 11, 8.5, i % 2 === 0 ? b : f);
      x += cols[i];
    });
    y -= 16;
  }
  y -= 12;

  // Linhas
  const c2 = [92, 70, (L - 162) / 2, (L - 162) / 2];
  const cab = ["DATA", "VALOR", fundo ? "FAVORECIDO" : "DESCRIÇÃO", fundo ? "MOTIVO / DESCRIÇÃO" : "MOTIVO"];
  const linhaTabela = (vals: string[], negrito: boolean, fundoCor?: ReturnType<typeof rgb>) => {
    if (y < M + 200) novaPagina();
    let x = M;
    vals.forEach((v, i) => {
      caixa(x, y - 15, c2[i], 15, fundoCor);
      const t = corta(v, negrito ? b : f, 8.5, c2[i] - 8);
      const fx = i === 1 ? x + c2[i] - 4 - (negrito ? b : f).widthOfTextAtSize(t, 8.5) : x + 4;
      texto(t, fx, y - 10.5, 8.5, negrito ? b : f);
      x += c2[i];
    });
    y -= 15;
  };
  linhaTabela(cab, true, cinza);
  for (const i of d.itens) linhaTabela([dataBR(i.data), n2(i.valor), i.descricao ?? "", i.motivo ?? ""], false);
  linhaTabela([fundo ? "DESPESAS TOTAIS" : "VALOR TOTAL", n2(d.totalDespesas), fundo ? "SALDO FINAL:" : d.valorGlosado > 0 ? "GLOSAS / A PAGAR:" : "",
    fundo ? n2(d.saldoFinal) : d.valorGlosado > 0 ? `R$ ${n2(d.valorGlosado)} / R$ ${n2(d.valorAPagar)}` : ""], true);
  y -= 14;

  // Informações
  const info = [
    "INFORMAÇÕES DE PREENCHIMENTO",
    "1 - Preencher corretamente o campo de data, valor, descrição (fornecedor) e motivo da despesa; o reembolso ocorrerá conforme padrão de pagamento, 15 dias.",
    "2 - Os comprovantes da despesa seguem anexados a este formulário.",
    "3 - As assinaturas do funcionário e do gestor foram substituídas pelo aceite eletrônico e pelas aprovações registradas no Portal.",
  ];
  const linhasInfo: string[] = [];
  for (const p of info) {
    let atual = "";
    for (const w of limpo(p).split(" ")) {
      const t = atual ? `${atual} ${w}` : w;
      if (f.widthOfTextAtSize(t, 8.5) > L - 12) {
        linhasInfo.push(atual);
        atual = w;
      } else atual = t;
    }
    linhasInfo.push(atual);
  }
  const hInfo = linhasInfo.length * 11 + 8;
  if (y - hInfo < M + 80) novaPagina();
  caixa(M, y - hInfo, L, hInfo);
  linhasInfo.forEach((l, i) => texto(l, M + 6, y - 12 - i * 11, 8.5, i === 0 ? b : f));
  y -= hInfo + 30;

  // Aceites
  const gestor = [...d.aprovacoes].reverse().find((a) => a.status === "aprovado" && a.ciclo === d.ciclo);
  const blocos: [string, string, string | null][] = [
    ["ACEITE DO FUNCIONÁRIO", `${d.solicitante.nome} · ${dataHoraBR(d.aceiteEm)}`, null],
    ["APROVAÇÃO DO GESTOR", gestor ? `${gestor.aprovador ?? gestor.papel} · ${dataHoraBR(gestor.decididoEm)}` : "pendente", gestor?.comentario ? `"${gestor.comentario}"` : null],
  ];
  blocos.forEach(([t, l1, l2], i) => {
    const x = M + i * (L / 2 + 6);
    const w = L / 2 - 6;
    pagina.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.7, color: preto });
    texto(t, x, y - 12, 8.5, b);
    texto(corta(l1, f, 8.5, w), x, y - 24, 8.5);
    if (l2) texto(corta(l2, f, 8.5, w), x, y - 35, 8.5);
  });

  return await doc.save();
}
