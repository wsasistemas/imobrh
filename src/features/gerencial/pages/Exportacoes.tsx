import { AlignLeft, Braces, Download, FileDown, FileSpreadsheet, FileText, Globe, Printer } from "lucide-react";
import { useState } from "react";
import { ThLabel } from "../../../components/ds/ThLabel";
import { APP_SCHEMA } from "../../../config/app";
import { SUPABASE_URL } from "../../../lib/supabase";
import { Secao } from "../componentes";
import { baixarCsv, baixarJson, baixarXlsx, imprimir, nomeArquivo } from "../exportar";
import { useVisao } from "../hooks";
import { pastaCompleta, tabelaAlertas, tabelaAnalitica, tabelaComparativa, tabelaConsolidada, tabelaIndicadores, tabelaMensal, tabelaProdutividade, tabelaSintetica } from "../tabelas";
import { DIMENSOES, type Dimensao } from "../types";

/** Exportações: permitir uso externo (Excel, CSV, PDF, JSON e a API para integrações). */
export function Exportacoes() {
  const v = useVisao();
  const [dimensao, setDimensao] = useState<Dimensao>("equipe");
  const nome = (base: string) => nomeArquivo(base, v.filtros.de, v.filtros.ate);
  const itens = [
    { titulo: "Analítico", descricao: "Um ticket por linha, com todas as datas, prazos e tempos.", tabela: () => tabelaAnalitica(v) },
    { titulo: "Consolidado", descricao: "KPIs por setor e o total.", tabela: () => tabelaConsolidada(v) },
    { titulo: "Comparativo", descricao: "Período atual × anterior.", tabela: () => tabelaComparativa(v) },
    { titulo: "Indicadores", descricao: "Valor, meta, situação e atingimento de cada KPI.", tabela: () => tabelaIndicadores(v) },
    { titulo: "Mensal (13 meses)", descricao: "Entradas, resolvidos, backlog e SLA por mês.", tabela: () => tabelaMensal(v) },
    { titulo: "Produtividade", descricao: "Resolvidos, carga, SLA e TMR por agente.", tabela: () => tabelaProdutividade(v) },
    { titulo: "Alertas", descricao: "Limites e situação atual.", tabela: () => tabelaAlertas(v) },
  ];
  const api = `${SUPABASE_URL || "https://<projeto>.supabase.co"}/rest/v1/rpc/ch_gerencial`;

  return (
    <>
      <div className="ger-grid ger-grid--2">
        <Secao titulo="Pasta completa (Excel)" subtitulo="Uma aba para cada relatório, com o recorte e o período atuais.">
          <div className="ger-acoes">
            <button type="button" className="btn btn--primary" onClick={() => baixarXlsx(nome("gerencial_completo"), pastaCompleta(v))}>
              <FileSpreadsheet size={16} aria-hidden="true" /> Baixar pasta completa (.xlsx)
            </button>
            <button type="button" className="btn btn--outline" onClick={imprimir}>
              <Printer size={16} aria-hidden="true" /> Esta tela em PDF
            </button>
          </div>
          <p className="ger-nota">O PDF usa a impressão do navegador: escolha "Salvar como PDF". Para o relatório executivo, imprima a tela Relatórios Executivos.</p>
        </Secao>
        <Secao titulo="Dados brutos (JSON)" subtitulo="Os tickets do recorte, no mesmo formato da API, para outras ferramentas.">
          <div className="ger-acoes">
            <button type="button" className="btn btn--outline" onClick={() => baixarJson(nome("gerencial_tickets"), { generated_at: v.payload.generated_at, filtros: v.filtros, metas: v.metas, kpis: v.kpis, tickets: v.tickets })}>
              <Braces size={16} aria-hidden="true" /> Baixar JSON
            </button>
          </div>
          <p className="ger-nota">{v.tickets.length.toLocaleString("pt-BR")} tickets no recorte (13 meses carregados), mais os KPIs do período.</p>
        </Secao>
      </div>

      <Secao titulo="Relatórios individuais" subtitulo="CSV abre direto no Excel em português (separador ; e vírgula decimal).">
        <div className="ger-tabela__rolagem">
          <table className="ger-tabela">
            <thead>
              <tr>
                <th><ThLabel icon={FileText}>Relatório</ThLabel></th>
                <th><ThLabel icon={AlignLeft}>Conteúdo</ThLabel></th>
                <th><ThLabel icon={FileDown}>Baixar</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.titulo}>
                  <td><b>{it.titulo}</b></td>
                  <td>{it.descricao}</td>
                  <td>
                    <div className="ger-acoes">
                      <button type="button" className="btn btn--outline" onClick={() => baixarCsv(nome(it.titulo), it.tabela())}><Download size={14} aria-hidden="true" /> CSV</button>
                      <button type="button" className="btn btn--outline" onClick={() => baixarXlsx(nome(it.titulo), [it.tabela()])}><FileSpreadsheet size={14} aria-hidden="true" /> Excel</button>
                    </div>
                  </td>
                </tr>
              ))}
              <tr>
                <td><b>Sintético</b></td>
                <td>
                  Totais por{" "}
                  <select className="ds-search" style={{ height: 32 }} value={dimensao} onChange={(e) => setDimensao(e.target.value as Dimensao)} aria-label="Dimensão do sintético">
                    {(Object.keys(DIMENSOES) as Dimensao[]).map((d) => (
                      <option key={d} value={d}>{DIMENSOES[d]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="ger-acoes">
                    <button type="button" className="btn btn--outline" onClick={() => baixarCsv(nome(`sintetico_${dimensao}`), tabelaSintetica(v, dimensao))}><Download size={14} aria-hidden="true" /> CSV</button>
                    <button type="button" className="btn btn--outline" onClick={() => baixarXlsx(nome(`sintetico_${dimensao}`), [tabelaSintetica(v, dimensao)])}><FileSpreadsheet size={14} aria-hidden="true" /> Excel</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Secao>

      <Secao titulo="API" subtitulo="Os mesmos dados por HTTP, com a sessão do usuário (só o que ele pode ver).">
        <p style={{ fontSize: 13.5, margin: "0 0 8px" }}>
          <Globe size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> <code>POST {api}</code> devolve <code>{"{ generated_at, metas, tickets[] }"}</code> dos últimos <code>p_meses</code> meses (1 a 36). Exige a chave pública do projeto e o token de acesso de um usuário com a permissão Gerencial; a RLS aplica o mesmo recorte da tela.
        </p>
        <pre className="ger-codigo">{`curl -X POST "${api}" \\
  -H "apikey: <chave publicável do projeto>" \\
  -H "Authorization: Bearer <access_token do usuário>" \\
  -H "Content-Profile: ${APP_SCHEMA}" \\
  -H "Content-Type: application/json" \\
  -d '{"p_meses": 13}'`}</pre>
        <p className="ger-nota">
          <FileText size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> O token sai do login pelo portal (sessão do Supabase Auth). Não existe chave de API separada: quem exporta é sempre uma pessoa, com o que ela pode ver, e o acesso fica na auditoria de sessões.
        </p>
      </Secao>
    </>
  );
}
