import { useMemo, useState } from "react";
import { projecao, serieDiaria, somarDias } from "../calculos";
import { KpiGer, Secao, Semaforo, Tabela, type Coluna } from "../componentes";
import { fmtDia, fmtNum, GraficoLinha } from "../graficos";
import { useVisao } from "../hooks";

const HORIZONTES = [30, 60, 90] as const;
const CENARIOS = [
  { id: 1, label: "Capacidade atual" },
  { id: 1.1, label: "+10% de capacidade" },
  { id: 1.25, label: "+25% de capacidade" },
] as const;

/** Projeções: antecipar cenários (demanda prevista, backlog projetado e quanto de capacidade falta). */
export function Projecoes() {
  const v = useVisao();
  const [dias, setDias] = useState<(typeof HORIZONTES)[number]>(30);
  const [cenario, setCenario] = useState<number>(1);
  // A base da projeção são sempre as últimas 8 semanas até hoje, independentemente do período escolhido.
  const historico = useMemo(() => serieDiaria(v.tickets, { de: somarDias(v.hoje, -55), ate: v.hoje }, v.agora), [v.tickets, v.hoje, v.agora]);
  const backlogHoje = historico.length ? historico[historico.length - 1].backlog : v.kpis.backlog;
  const proj = useMemo(() => projecao(historico, dias, backlogHoje, cenario), [historico, dias, backlogHoje, cenario]);
  const base = useMemo(() => projecao(historico, dias, backlogHoje, 1), [historico, dias, backlogHoje]);

  const rotulos = [...historico.slice(-28).map((p) => fmtDia(p.dia)), ...proj.dias.map((p) => fmtDia(p.dia))];
  const nH = historico.slice(-28).length;
  const entradasReais = [...historico.slice(-28).map((p) => p.entradas), ...proj.dias.map(() => NaN)];
  const entradasProj = [...historico.slice(-28).map((p, i) => (i === nH - 1 ? p.entradas : NaN)), ...proj.dias.map((p) => p.entradas)];
  const backlogReal = [...historico.slice(-28).map((p) => p.backlog), ...proj.dias.map(() => NaN)];
  const backlogProj = [...historico.slice(-28).map((p, i) => (i === nH - 1 ? p.backlog : NaN)), ...proj.dias.map((p) => p.backlog)];

  // Demanda prevista por equipe: proporção das últimas 8 semanas aplicada à projeção total.
  const totalHist = historico.reduce((s, p) => s + p.entradas, 0);
  const totalProj = proj.dias.reduce((s, p) => s + p.entradas, 0);
  const porEquipe = v.grupos.equipe.map((g) => ({ equipe: g.chave, participacao: totalHist ? g.entradas / Math.max(1, v.kpis.entradas) : 0, backlog: g.backlog }));
  type Linha = { equipe: string; previstas: number; backlog: number; participacao: number };
  const linhas: Linha[] = porEquipe.map((e) => ({ equipe: e.equipe, previstas: Math.round(totalProj * e.participacao), backlog: e.backlog, participacao: Math.round(e.participacao * 1000) / 10 }));
  const colunas: Coluna<Linha>[] = [
    { chave: "equipe", label: "Equipe", valor: (l) => l.equipe },
    { chave: "participacao", label: "Participação (%)", num: true, valor: (l) => l.participacao },
    { chave: "previstas", label: `Entradas previstas (${dias} dias)`, num: true, valor: (l) => l.previstas },
    { chave: "backlog", label: "Backlog hoje", num: true, valor: (l) => l.backlog },
  ];
  const faltaCapacidade = proj.entradasPorDia > proj.capacidadePorDia;
  const confTom = proj.confiabilidade === "alta" ? "verde" : proj.confiabilidade === "media" ? "amarelo" : "vermelho";

  return (
    <>
      <div className="ger-acoes ger-nao-imprime" style={{ marginBottom: 16 }}>
        <span className="ds-muted" style={{ fontSize: 13 }}>Horizonte</span>
        {HORIZONTES.map((h) => (
          <button key={h} type="button" className={`ger-filtros__preset${dias === h ? " ger-filtros__preset--ativo" : ""}`} onClick={() => setDias(h)}>{h} dias</button>
        ))}
        <span className="ds-muted" style={{ fontSize: 13, marginLeft: 12 }}>Cenário</span>
        {CENARIOS.map((c) => (
          <button key={c.id} type="button" className={`ger-filtros__preset${cenario === c.id ? " ger-filtros__preset--ativo" : ""}`} onClick={() => setCenario(c.id)}>{c.label}</button>
        ))}
      </div>

      <div className="ds-kpis">
        <KpiGer label="Entradas por dia (média 8 semanas)" valor={fmtNum(proj.entradasPorDia, 1)} hint={`Tendência ${proj.tendenciaPorDia >= 0 ? "+" : ""}${fmtNum(proj.tendenciaPorDia, 2)}/dia`} />
        <KpiGer label="Capacidade por dia útil" valor={fmtNum(proj.capacidadePorDia, 1)} unidade="resolvidos" hint={cenario === 1 ? "Média observada" : `Cenário ${CENARIOS.find((c) => c.id === cenario)?.label}`} tom={faltaCapacidade ? "vermelho" : "verde"} />
        <KpiGer label={`Entradas previstas em ${dias} dias`} valor={fmtNum(totalProj)} hint="Tendência × sazonalidade semanal" />
        <KpiGer label={`Backlog projetado em ${dias} dias`} valor={fmtNum(proj.backlogFinal)} hint={`Hoje: ${fmtNum(backlogHoje)}`} tom={proj.backlogFinal > v.metas.backlog_max ? "vermelho" : proj.backlogFinal > backlogHoje ? "amarelo" : "verde"} />
        <KpiGer label="Dias para zerar o backlog" valor={proj.diasParaZerar === null ? "não zera" : String(proj.diasParaZerar)} hint={proj.diasParaZerar === null ? `Em ${dias} dias, com esta capacidade` : "Com a capacidade do cenário"} />
        <KpiGer label="Confiabilidade" valor={proj.confiabilidade === "alta" ? "Alta" : proj.confiabilidade === "media" ? "Média" : "Baixa"} hint={`${historico.length} dias de histórico`} tom={confTom} />
      </div>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Entradas: últimas 4 semanas e previsão" subtitulo="Linha tracejada = projeção.">
          <GraficoLinha titulo="Entradas reais e previstas" rotulos={rotulos} series={[{ nome: "Entradas", valores: entradasReais }, { nome: "Previsão", valores: entradasProj, tracejada: true }]} formato={(x) => fmtNum(x, 1)} />
        </Secao>
        <Secao titulo="Backlog: real e projetado" subtitulo={cenario === 1 ? "Com a capacidade atual." : `Cenário: ${CENARIOS.find((c) => c.id === cenario)?.label} (base: ${fmtNum(base.backlogFinal)} no fim).`}>
          <GraficoLinha titulo="Backlog real e projetado" rotulos={rotulos} series={[{ nome: "Backlog", valores: backlogReal }, { nome: "Projeção", valores: backlogProj, tracejada: true }]} formato={(x) => fmtNum(x, 1)} />
        </Secao>
      </div>

      <div className="ger-grid ger-grid--21">
        <Secao titulo="Demanda prevista por equipe" subtitulo="Participação das últimas 8 semanas aplicada à previsão.">
          <Tabela colunas={colunas} linhas={linhas} chave={(l) => l.equipe} ordemInicial={{ chave: "previstas", desc: true }} />
        </Secao>
        <Secao titulo="Como a projeção é feita" subtitulo="Método simples e explicável.">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
            <li><b>Entradas:</b> tendência linear dos últimos 56 dias × fator do dia da semana (segunda costuma ter mais).</li>
            <li><b>Capacidade:</b> média de resolvidos por dia útil no mesmo intervalo; zero nos fins de semana.</li>
            <li><b>Backlog:</b> dia a dia, backlog + entradas previstas − capacidade.</li>
            <li><b>Cenários:</b> aumentam só a capacidade (mais gente, automação ou base de conhecimento).</li>
            <li><b>Confiabilidade:</b> <Semaforo tom={confTom}>{proj.confiabilidade}</Semaforo> depende de quantos dias há de histórico; não considera feriados nem campanhas.</li>
          </ul>
          {faltaCapacidade && <p className="ger-nota">Hoje entram {fmtNum(proj.entradasPorDia, 1)} por dia e saem {fmtNum(proj.capacidadePorDia, 1)}: faltam {fmtNum(proj.entradasPorDia - proj.capacidadePorDia, 1)} resoluções por dia para o backlog parar de crescer.</p>}
        </Secao>
      </div>
    </>
  );
}
