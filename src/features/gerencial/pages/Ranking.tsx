import { useState } from "react";
import { semaforo } from "../calculos";
import { Secao, Semaforo, Tabela, type Coluna } from "../componentes";
import { CORES, fmtHoras, fmtNum, fmtPct, GraficoBarras } from "../graficos";
import { useVisao, type Visao } from "../hooks";
import type { Grupo } from "../types";

type Dimensao = keyof Visao["grupos"];
const DIMENSOES: { id: Dimensao; label: string; descricao: string }[] = [
  { id: "equipe", label: "Equipe", descricao: "As equipes de atendimento." },
  { id: "responsavel", label: "Agente", descricao: "Quem atende os tickets." },
  { id: "servico", label: "Serviço", descricao: "O catálogo de serviços (o \"projeto\" de cada chamado)." },
  { id: "departamento", label: "Departamento solicitante", descricao: "Quem pede: a área da empresa que abriu o chamado." },
  { id: "setor", label: "Setor", descricao: "O setor que atende." },
  { id: "origem", label: "Canal", descricao: "Por onde o chamado chegou." },
  { id: "categoria", label: "Categoria", descricao: "Problema, solicitação, dúvida…" },
];

type Criterio = "resolvidos" | "slaSolucaoPct" | "tmrHoras" | "entradas" | "backlog" | "vencidos";
const CRITERIOS: { id: Criterio; label: string; maiorMelhor: boolean; fmt: (n: number | null) => string; minimo?: number }[] = [
  { id: "resolvidos", label: "Resolvidos", maiorMelhor: true, fmt: (n) => fmtNum(n) },
  { id: "slaSolucaoPct", label: "SLA de solução", maiorMelhor: true, fmt: (n) => fmtPct(n), minimo: 3 },
  { id: "tmrHoras", label: "Tempo médio de resolução", maiorMelhor: false, fmt: (n) => fmtHoras(n), minimo: 3 },
  { id: "entradas", label: "Entradas (volume)", maiorMelhor: true, fmt: (n) => fmtNum(n) },
  { id: "backlog", label: "Backlog (menor é melhor)", maiorMelhor: false, fmt: (n) => fmtNum(n) },
  { id: "vencidos", label: "Vencidos (menor é melhor)", maiorMelhor: false, fmt: (n) => fmtNum(n) },
];

type Linha = Grupo & { posicao: number; elegivel: boolean };

/** Ranking: comparar desempenho (equipes, agentes, serviços, departamentos, setores, canais e categorias). */
export function Ranking() {
  const v = useVisao();
  const [dimensao, setDimensao] = useState<Dimensao>("equipe");
  const [criterio, setCriterio] = useState<Criterio>("resolvidos");
  const C = CRITERIOS.find((c) => c.id === criterio)!;
  const D = DIMENSOES.find((d) => d.id === dimensao)!;

  const ordenadas = [...v.grupos[dimensao]]
    .map((g) => ({ ...g, elegivel: C.minimo === undefined || g.resolvidos >= C.minimo }))
    .sort((a, b) => {
      if (a.elegivel !== b.elegivel) return a.elegivel ? -1 : 1;
      const va = a[criterio];
      const vb = b[criterio];
      if (va === null) return 1;
      if (vb === null) return -1;
      return C.maiorMelhor ? vb - va : va - vb;
    });
  const linhas: Linha[] = ordenadas.map((g, i) => ({ ...g, posicao: i + 1 }));
  const top = linhas.filter((l) => l.elegivel && l[criterio] !== null).slice(0, 10);

  const colunas: Coluna<Linha>[] = [
    { chave: "posicao", label: "#", num: true, valor: (l) => l.posicao, render: (l) => (l.elegivel ? `${l.posicao}º` : "—") },
    { chave: "chave", label: D.label, valor: (l) => l.chave },
    { chave: "criterio", label: C.label, num: true, valor: (l) => l[criterio], render: (l) => <b>{C.fmt(l[criterio])}</b> },
    { chave: "entradas", label: "Entradas", num: true, valor: (l) => l.entradas },
    { chave: "resolvidos", label: "Resolvidos", num: true, valor: (l) => l.resolvidos },
    { chave: "backlog", label: "Backlog", num: true, valor: (l) => l.backlog },
    { chave: "vencidos", label: "Vencidos", num: true, valor: (l) => l.vencidos },
    { chave: "sla", label: "SLA solução", num: true, valor: (l) => l.slaSolucaoPct, render: (l) => <Semaforo tom={semaforo(l.slaSolucaoPct, v.metas.sla_solucao_pct, true)}>{fmtPct(l.slaSolucaoPct)}</Semaforo> },
    { chave: "tmr", label: "TMR", num: true, valor: (l) => l.tmrHoras, render: (l) => fmtHoras(l.tmrHoras) },
  ];

  return (
    <>
      <div className="ger-acoes ger-nao-imprime" style={{ marginBottom: 16 }}>
        <span className="ds-muted" style={{ fontSize: 13 }}>Comparar</span>
        {DIMENSOES.map((d) => (
          <button key={d.id} type="button" className={`ger-filtros__preset${dimensao === d.id ? " ger-filtros__preset--ativo" : ""}`} title={d.descricao} onClick={() => setDimensao(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="ger-acoes ger-nao-imprime" style={{ marginBottom: 16 }}>
        <span className="ds-muted" style={{ fontSize: 13 }}>Por</span>
        {CRITERIOS.map((c) => (
          <button key={c.id} type="button" className={`ger-filtros__preset${criterio === c.id ? " ger-filtros__preset--ativo" : ""}`} onClick={() => setCriterio(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="ger-grid ger-grid--21">
        <Secao titulo={`Ranking por ${D.label.toLowerCase()}: ${C.label.toLowerCase()}`} subtitulo={`${D.descricao}${C.minimo ? ` Entram no ranking só quem tem pelo menos ${C.minimo} resolvidos no período.` : ""}`}>
          <Tabela colunas={colunas} linhas={linhas} chave={(l) => l.chave} ordemInicial={{ chave: "posicao" }} />
        </Secao>
        <Secao titulo="Top 10" subtitulo={C.maiorMelhor ? "Maior é melhor." : "Menor é melhor."}>
          <GraficoBarras titulo={`Top 10 por ${C.label}`} itens={top.map((l, i) => ({ rotulo: `${l.posicao}º ${l.chave}`, valor: l[criterio] ?? 0, detalhe: `${l.resolvidos} resolvidos`, cor: i === 0 ? CORES[1] : CORES[0] }))} formato={(x) => C.fmt(x)} max={criterio === "slaSolucaoPct" ? 100 : undefined} />
        </Secao>
      </div>

      <p className="ger-nota">Fornecedores e vendedores não existem nos chamados; os equivalentes aqui são o serviço (o que foi pedido), o agente (quem atendeu) e o departamento solicitante (quem pediu).</p>
    </>
  );
}
