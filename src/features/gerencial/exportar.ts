// Exportações da visão gerencial sem biblioteca externa: CSV (Excel pt-BR), XLSX (zip "stored" montado à mão,
// com células inlineStr) e impressão (o navegador salva em PDF). Tudo roda no navegador, com os dados já na tela.

export type Celula = string | number | null | undefined;

export interface Tabela {
  nome: string;
  colunas: string[];
  linhas: Celula[][];
}

const BOM = "﻿";

function textoCsv(v: Celula): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString("pt-BR", { maximumFractionDigits: 2, useGrouping: false });
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV com ; e vírgula decimal (abre direto no Excel em português), com BOM para acentos. */
export function paraCsv(t: Tabela): string {
  return BOM + [t.colunas, ...t.linhas].map((l) => l.map(textoCsv).join(";")).join("\r\n");
}

// ---------- XLSX ----------

const CRC_TABLE = (() => {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c >>> 0;
  }
  return tab;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip sem compressão (método 0): o XLSX não exige deflate, e assim não há dependência nem código assíncrono. */
export function zipStored(arquivos: { nome: string; conteudo: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const partes: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const a of arquivos) {
    const nome = enc.encode(a.nome);
    const dados = enc.encode(a.conteudo);
    const crc = crc32(dados);
    const cabecalho = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(dados.length), ...u32(dados.length), ...u16(nome.length), ...u16(0),
    ]);
    partes.push(cabecalho, nome, dados);
    centrais.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(dados.length), ...u32(dados.length), ...u16(nome.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]), nome);
    offset += cabecalho.length + nome.length + dados.length;
  }
  const tamCentral = centrais.reduce((s, c) => s + c.length, 0);
  const fim = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(arquivos.length), ...u16(arquivos.length), ...u32(tamCentral), ...u32(offset), ...u16(0)]);
  const total = [...partes, ...centrais, fim];
  const saida = new Uint8Array(total.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of total) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colunaExcel(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function planilhaXml(t: Tabela): string {
  const linha = (valores: Celula[], r: number, negrito: boolean) =>
    `<row r="${r}">${valores
      .map((v, c) => {
        const ref = `${colunaExcel(c)}${r}`;
        if (v === null || v === undefined || v === "") return "";
        if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${negrito ? ' s="1"' : ""}><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${negrito ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
      })
      .join("")}</row>`;
  const larguras = t.colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, c.length + 4))}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${larguras}</cols><sheetData>${[linha(t.colunas, 1, true), ...t.linhas.map((l, i) => linha(l, i + 2, false))].join("")}</sheetData></worksheet>`;
}

/** Pasta de trabalho com uma aba por tabela (nomes de aba com até 31 caracteres, sem caracteres proibidos). */
export function paraXlsx(tabelas: Tabela[]): Uint8Array {
  const nomeAba = (n: string, i: number) => (n.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Planilha${i + 1}`);
  const abas = tabelas.map((t, i) => ({ id: i + 1, nome: nomeAba(t.nome, i), xml: planilhaXml(t) }));
  const arquivos = [
    {
      nome: "[Content_Types].xml",
      conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${abas.map((a) => `<Override PartName="/xl/worksheets/sheet${a.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      nome: "_rels/.rels",
      conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      nome: "xl/workbook.xml",
      conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas.map((a) => `<sheet name="${xml(a.nome)}" sheetId="${a.id}" r:id="rId${a.id}"/>`).join("")}</sheets></workbook>`,
    },
    {
      nome: "xl/_rels/workbook.xml.rels",
      conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((a) => `<Relationship Id="rId${a.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${a.id}.xml"/>`).join("")}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      nome: "xl/styles.xml",
      conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`,
    },
    ...abas.map((a) => ({ nome: `xl/worksheets/sheet${a.id}.xml`, conteudo: a.xml })),
  ];
  return zipStored(arquivos);
}

// ---------- Download e impressão ----------

export function baixar(nome: string, conteudo: string | Uint8Array, tipo: string) {
  const blob = new Blob([conteudo as BlobPart], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function baixarCsv(nome: string, t: Tabela) {
  baixar(`${nome}.csv`, paraCsv(t), "text/csv;charset=utf-8");
}

export function baixarXlsx(nome: string, tabelas: Tabela[]) {
  baixar(`${nome}.xlsx`, paraXlsx(tabelas), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export function baixarJson(nome: string, dados: unknown) {
  baixar(`${nome}.json`, JSON.stringify(dados, null, 2), "application/json");
}

/** Imprime a tela atual (o CSS @media print esconde menu, filtros e botões); o navegador oferece "Salvar como PDF". */
export function imprimir() {
  window.print();
}

export function nomeArquivo(base: string, de: string, ate: string): string {
  return `${base}_${de}_a_${ate}`.replace(/[^a-z0-9_-]/gi, "_");
}
