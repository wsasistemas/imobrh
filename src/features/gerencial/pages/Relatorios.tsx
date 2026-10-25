import { Download, FileSpreadsheet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { Secao, Semaforo, Tabela, Variacao, type Coluna } from "../componentes";
import { baixarCsv, baixarXlsx, nomeArquivo, type Celula, type Tabela as TabelaDados } from "../exportar";
import { fmtNum } from "../graficos";
import { useVisao } from "../hooks";
import { tabelaAnalitica, tabelaComparativa, tabelaConsolidada, tabelaSintetica } from "../tabelas";
import { DIMENSOES, type Dimensao } from "../types";

const TIPOS = [
  { id: "analitico", label: "Analítico", descricao: "Um ticket por linha, com prazos, tempos e situação." },
  { id: "sintetico", label: "Sintético", descricao: "Totais por setor, equipe, serviço, canal, responsável ou mês." },
  { id: "consolidado", label: "Consolidado", descricao: "KPIs por setor e o total do período." },
  { id: "comparativo", label: "Comparativo", descricao: "Período atual × período anterior, indicador a indicador." },
] as const;
type Tipo = (typeof TIPOS)[number]["id"];
const PAGINA = 25;

/** Relatórios: análise detalhada (analítico, sintético, consolidado e comparativo), com exportação direta. */
export function Relatorios() {
  const v = useVisao();
  const [tipo, setTipo] = useState<Tipo>("analitico");
  const [dimensao, setDimensao] = useState<Dimensao>("equipe");
  const [busca, setBusca] = useState("");
  const [pagina, setPagina] = useState(0);

  const dados: TabelaDados = useMemo(() => {
    if (tipo === "analitico") return tabelaAnalitica(v);
    if (tipo === "sintetico") return tabelaSintetica(v, dimensao);
    if (tipo === "consolidado") return tabelaConsolidada(v);
    return tabelaComparativa(v);
  }, [v, tipo, dimensao]);

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return dados.linhas;
    return dados.linhas.filter((l) => l.some((c) => String(c ?? "").toLowerCase().includes(q)));
  }, [dados, busca]);
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / PAGINA));
  const pag = Math.min(pagina, totalPaginas - 1);
  const visiveis = tipo === "analitico" ? filtradas.slice(pag * PAGINA, (pag + 1) * PAGINA) : filtradas;
  const nome = nomeArquivo(dados.nome, v.filtros.de, v.filtros.ate);
  const basePath = getMenuItem("gestao_chamados_tickets").path;

  type Linha = { i: number; c: Celula[] };
  const linhas: Linha[] = visiveis.map((c, i) => ({ i, c }));
  const colunas: Coluna<Linha>[] = dados.colunas.map((label, ci) => ({
    chave: String(ci),
    label,
    num: dados.linhas.some((l) => typeof l[ci] === "number"),
    valor: (l) => (l.c[ci] ?? null) as string | number | null,
    render:
      tipo === "analitico" && ci === 0
        ? (l) => <Link to={`${basePath}/${l.c[0]}`}>#{l.c[0]}</Link>
        : tipo === "comparativo" && ci === 4
          ? (l) => <Variacao pct={l.c[4] as number | null} maiorMelhor={!/TMR|TPR|Backlog|Vencidos|Sem responsável|Reabertura|Cancelados/.test(String(l.c[0]))} sufixo="" />
          : tipo !== "analitico" && /SLA/.test(label)
            ? (l) => (l.c[ci] === null || l.c[ci] === undefined ? "—" : <Semaforo tom={(l.c[ci] as number) >= v.metas.sla_solucao_pct ? "verde" : (l.c[ci] as number) >= v.metas.sla_solucao_pct - 8.5 ? "amarelo" : "vermelho"}>{fmtNum(l.c[ci] as number)}%</Semaforo>)
            : undefined,
  }));

  return (
    <>
      <div className="ger-acoes ger-nao-imprime" style={{ marginBottom: 16 }}>
        {TIPOS.map((t) => (
          <button key={t.id} type="button" className={`ger-filtros__preset${tipo === t.id ? " ger-filtros__preset--ativo" : ""}`} title={t.descricao} onClick={() => { setTipo(t.id); setPagina(0); }}>
            {t.label}
          </button>
        ))}
        {tipo === "sintetico" && (
          <select className="ds-search" style={{ height: 34 }} value={dimensao} onChange={(e) => setDimensao(e.target.value as Dimensao)} aria-label="Agrupar por">
            {(Object.keys(DIMENSOES) as Dimensao[]).map((d) => (
              <option key={d} value={d}>por {DIMENSOES[d]}</option>
            ))}
          </select>
        )}
        <input className="ds-search" type="search" placeholder="Filtrar linhas…" aria-label="Filtrar linhas" value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(0); }} style={{ marginLeft: "auto" }} />
        <button type="button" className="btn btn--outline" onClick={() => baixarCsv(nome, { ...dados, linhas: filtradas })}>
          <Download size={16} aria-hidden="true" /> CSV
        </button>
        <button type="button" className="btn btn--outline" onClick={() => baixarXlsx(nome, [{ ...dados, linhas: filtradas }])}>
          <FileSpreadsheet size={16} aria-hidden="true" /> Excel
        </button>
      </div>

      <Secao titulo={dados.nome} subtitulo={`${TIPOS.find((t) => t.id === tipo)!.descricao} ${filtradas.length.toLocaleString("pt-BR")} linhas.`}>
        <Tabela colunas={colunas} linhas={linhas} chave={(l) => String(l.i)} ordemInicial={tipo === "analitico" ? { chave: "0", desc: true } : { chave: "0" }} />
        {tipo === "analitico" && totalPaginas > 1 && (
          <div className="ger-acoes" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" className="btn btn--outline" disabled={pag === 0} onClick={() => setPagina(pag - 1)}>Anterior</button>
            <span className="ds-muted" style={{ fontSize: 13 }}>Página {pag + 1} de {totalPaginas}</span>
            <button type="button" className="btn btn--outline" disabled={pag >= totalPaginas - 1} onClick={() => setPagina(pag + 1)}>Próxima</button>
          </div>
        )}
      </Secao>
    </>
  );
}
