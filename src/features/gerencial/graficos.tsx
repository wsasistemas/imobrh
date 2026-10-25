import { useId, useState, type ReactNode } from "react";

// Gráficos da visão gerencial em SVG puro, sem biblioteca. Regras (skill dataviz): um eixo só, séries em ordem fixa
// de cor (--gr-s1…s6, paleta validada para daltonismo em Gerencial.css), legenda sempre que houver 2+ séries,
// rótulos diretos seletivos, grade recessiva, tooltip ao passar o mouse e texto sempre em cor de texto.

export const CORES = ["var(--gr-s1)", "var(--gr-s2)", "var(--gr-s3)", "var(--gr-s4)", "var(--gr-s5)", "var(--gr-s6)"];

export const fmtNum = (n: number | null | undefined, casas = 0) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: 0 }));
export const fmtPct = (n: number | null | undefined, casas = 0) => (n === null || n === undefined ? "—" : `${fmtNum(n, casas)}%`);
export const fmtHoras = (h: number | null | undefined) => {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${fmtNum(h, 1)} h`;
  return `${fmtNum(h / 24, 1)} d`;
};
export const fmtDia = (d: string) => d.slice(5).split("-").reverse().join("/");

interface Serie {
  nome: string;
  valores: number[];
  /** Linha tracejada (projeção). */
  tracejada?: boolean;
}

function Legenda({ series }: { series: Serie[] }) {
  if (series.length < 2) return null;
  return (
    <div className="gr-legenda">
      {series.map((s, i) => (
        <span key={s.nome}>
          <i style={{ background: CORES[i] }} className={s.tracejada ? "gr-legenda__tracejada" : undefined} />
          {s.nome}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="gr-tooltip" style={{ left: `${x}%`, top: y }} role="status">
      {children}
    </div>
  );
}

interface LinhaProps {
  rotulos: string[];
  series: Serie[];
  altura?: number;
  formato?: (v: number) => string;
  /** Rótulos de eixo a cada N pontos (automático pelo tamanho). */
  titulo: string;
}

/** Linhas (uma ou mais séries na mesma escala), com crosshair e tooltip. */
export function GraficoLinha({ rotulos, series, altura = 190, formato = (v) => fmtNum(v, 1), titulo }: LinhaProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const W = 600;
  const H = altura;
  const pad = { t: 12, r: 12, b: 28, l: 40 };
  const n = rotulos.length;
  const max = Math.max(1, ...series.flatMap((s) => s.valores.filter(Number.isFinite)));
  const topo = Math.ceil(max * 1.1);
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => H - pad.b - (v / topo) * (H - pad.t - pad.b);
  const passo = Math.max(1, Math.ceil(n / 8));
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(topo * f));
  if (n === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  return (
    <div className="gr" onMouseLeave={() => setHover(null)}>
      <Legenda series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} className="gr-svg" role="img" aria-labelledby={`${id}-t`} onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1));
        setHover(Math.max(0, Math.min(n - 1, i)));
      }}>
        <title id={`${id}-t`}>{titulo}</title>
        {grade.map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} className="gr-grade" />
            <text x={pad.l - 6} y={y(g) + 4} className="gr-eixo" textAnchor="end">{fmtNum(g)}</text>
          </g>
        ))}
        {rotulos.map((r, i) => (i % passo === 0 || i === n - 1) && (
          <text key={r} x={x(i)} y={H - 8} className="gr-eixo" textAnchor="middle">{r}</text>
        ))}
        {series.map((s, si) => {
          const pts = s.valores.map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : null));
          const d = pts.map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? "M" : "L"}${p}` : "")).join(" ");
          return <path key={s.nome} d={d} fill="none" stroke={CORES[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.tracejada ? "6 5" : undefined} />;
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="gr-crosshair" />
            {series.map((s, si) => Number.isFinite(s.valores[hover]) && <circle key={s.nome} cx={x(hover)} cy={y(s.valores[hover])} r={4.5} fill={CORES[si]} stroke="var(--surface)" strokeWidth={2} />)}
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={(x(hover) / W) * 100} y={8}>
          <b>{rotulos[hover]}</b>
          {series.map((s, si) => (
            <span key={s.nome}><i style={{ background: CORES[si] }} />{s.nome}: {formato(s.valores[hover])}</span>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

interface ColunasProps {
  rotulos: string[];
  series: Serie[];
  altura?: number;
  formato?: (v: number) => string;
  titulo: string;
  /** Rótulo direto em cima de cada coluna (só com poucas colunas). */
  rotulosDiretos?: boolean;
}

/** Colunas verticais (1 ou 2 séries lado a lado), com tooltip por coluna. */
export function GraficoColunas({ rotulos, series, altura = 190, formato = (v) => fmtNum(v), titulo, rotulosDiretos }: ColunasProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const W = 600;
  const H = altura;
  const pad = { t: 16, r: 8, b: 28, l: 36 };
  const n = rotulos.length;
  const max = Math.max(1, ...series.flatMap((s) => s.valores));
  const topo = Math.ceil(max * 1.15);
  const grupo = (W - pad.l - pad.r) / Math.max(n, 1);
  const larg = Math.max(2, (grupo * 0.7) / series.length);
  const y = (v: number) => H - pad.b - (v / topo) * (H - pad.t - pad.b);
  const passo = Math.max(1, Math.ceil(n / 12));
  if (n === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  return (
    <div className="gr" onMouseLeave={() => setHover(null)}>
      <Legenda series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} className="gr-svg" role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{titulo}</title>
        {[0.5, 1].map((f) => (
          <line key={f} x1={pad.l} x2={W - pad.r} y1={y(topo * f)} y2={y(topo * f)} className="gr-grade" />
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="gr-base" />
        {rotulos.map((r, i) => (
          <g key={r + i} onMouseEnter={() => setHover(i)}>
            <rect x={pad.l + i * grupo} y={pad.t} width={grupo} height={H - pad.t - pad.b} fill="transparent" />
            {series.map((s, si) => {
              const v = s.valores[i] ?? 0;
              const bx = pad.l + i * grupo + (grupo - larg * series.length) / 2 + si * larg;
              return (
                <g key={s.nome}>
                  <rect x={bx + 1} y={y(v)} width={Math.max(1, larg - 2)} height={Math.max(0, y(0) - y(v))} rx={Math.min(4, larg / 2)} fill={CORES[si]} opacity={hover === null || hover === i ? 1 : 0.55} />
                  {rotulosDiretos && n <= 14 && v > 0 && <text x={bx + larg / 2} y={y(v) - 4} className="gr-valor" textAnchor="middle">{formato(v)}</text>}
                </g>
              );
            })}
            {(i % passo === 0 || i === n - 1) && <text x={pad.l + i * grupo + grupo / 2} y={H - 8} className="gr-eixo" textAnchor="middle">{r}</text>}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={((pad.l + hover * grupo + grupo / 2) / W) * 100} y={8}>
          <b>{rotulos[hover]}</b>
          {series.map((s, si) => (
            <span key={s.nome}><i style={{ background: CORES[si] }} />{s.nome}: {formato(s.valores[hover] ?? 0)}</span>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

interface BarrasProps {
  itens: { rotulo: string; valor: number; detalhe?: string; cor?: string }[];
  formato?: (v: number) => string;
  /** Máximo da escala (por padrão, o maior valor). */
  max?: number;
  titulo: string;
}

/** Barras horizontais com rótulo e valor direto (rankings, distribuições). */
export function GraficoBarras({ itens, formato = (v) => fmtNum(v), max, titulo }: BarrasProps) {
  const topo = Math.max(1, max ?? Math.max(0, ...itens.map((i) => i.valor)));
  if (itens.length === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  return (
    <div className="gr-barras" role="img" aria-label={titulo}>
      {itens.map((it, i) => (
        <div key={it.rotulo + i} className="gr-barras__linha" title={`${it.rotulo}: ${formato(it.valor)}${it.detalhe ? ` · ${it.detalhe}` : ""}`}>
          <span className="gr-barras__rotulo">{it.rotulo}</span>
          <span className="gr-barras__trilho">
            <i style={{ width: `${Math.max(it.valor > 0 ? 1.5 : 0, (100 * it.valor) / topo)}%`, background: it.cor ?? CORES[0] }} />
          </span>
          <span className="gr-barras__valor">
            {formato(it.valor)}
            {it.detalhe && <small> {it.detalhe}</small>}
          </span>
        </div>
      ))}
    </div>
  );
}

interface DonutProps {
  itens: { rotulo: string; valor: number }[];
  titulo: string;
  centro?: string;
}

/** Rosca de participação (até 6 fatias; o resto vira "Outros"). Legenda com valores, nunca só a cor. */
export function GraficoDonut({ itens, titulo, centro }: DonutProps) {
  const [hover, setHover] = useState<number | null>(null);
  const ordenados = [...itens].filter((i) => i.valor > 0).sort((a, b) => b.valor - a.valor);
  const fatias = ordenados.length > 6 ? [...ordenados.slice(0, 5), { rotulo: "Outros", valor: ordenados.slice(5).reduce((s, i) => s + i.valor, 0) }] : ordenados;
  const total = fatias.reduce((s, i) => s + i.valor, 0);
  if (total === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  const R = 52;
  const C = 2 * Math.PI * R;
  let acumulado = 0;
  return (
    <div className="gr-donut" role="img" aria-label={titulo} onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 140 140" className="gr-donut__svg">
        {fatias.map((f, i) => {
          const frac = f.valor / total;
          const dash = `${Math.max(0, frac * C - 2)} ${C}`;
          const rot = (acumulado / total) * 360 - 90;
          acumulado += f.valor;
          return <circle key={f.rotulo} cx={70} cy={70} r={R} fill="none" stroke={CORES[i]} strokeWidth={hover === i ? 22 : 18} strokeDasharray={dash} transform={`rotate(${rot} 70 70)`} onMouseEnter={() => setHover(i)} />;
        })}
        <text x={70} y={66} textAnchor="middle" className="gr-donut__total">{hover === null ? fmtNum(total) : fmtPct((100 * fatias[hover].valor) / total)}</text>
        <text x={70} y={82} textAnchor="middle" className="gr-donut__sub">{hover === null ? (centro ?? "total") : fatias[hover].rotulo}</text>
      </svg>
      <ul className="gr-donut__legenda">
        {fatias.map((f, i) => (
          <li key={f.rotulo} onMouseEnter={() => setHover(i)} className={hover === i ? "gr-donut__ativo" : undefined}>
            <i style={{ background: CORES[i] }} />
            <span>{f.rotulo}</span>
            <b>{fmtNum(f.valor)}</b>
            <small>{fmtPct((100 * f.valor) / total)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface MapaCalorProps {
  /** [linha][coluna]. */
  matriz: number[][];
  linhas: readonly string[];
  colunas: readonly string[];
  titulo: string;
}

/** Mapa de calor sequencial (um matiz, claro → escuro). Valor no tooltip e, nas células mais altas, direto. */
export function GraficoMapaCalor({ matriz, linhas, colunas, titulo }: MapaCalorProps) {
  const max = Math.max(1, ...matriz.flat());
  return (
    <div className="gr-calor" role="img" aria-label={titulo} style={{ gridTemplateColumns: `auto repeat(${colunas.length}, minmax(0, 1fr))` }}>
      <span />
      {colunas.map((c) => (
        <span key={c} className="gr-calor__col">{c}</span>
      ))}
      {matriz.map((linha, li) => (
        <div key={linhas[li]} className="gr-calor__linha">
          <span className="gr-calor__rot">{linhas[li]}</span>
          {linha.map((v, ci) => {
            const int = v / max;
            return (
              <span key={ci} className="gr-calor__cel" style={{ background: `color-mix(in oklab, var(--gr-seq) ${Math.round(int * 100)}%, var(--gr-seq-0))`, color: int > 0.55 ? "#fff" : "var(--ink)" }} title={`${linhas[li]} ${colunas[ci]}: ${v}`}>
                {int >= 0.6 ? v : ""}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface ParetoProps {
  itens: { chave: string; valor: number; acumuladoPct: number; vital: boolean }[];
  titulo: string;
}

/** Pareto: colunas por volume + linha do acumulado (mesma escala, em %, com o 80% marcado). */
export function GraficoPareto({ itens, titulo }: ParetoProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const top = itens.slice(0, 12);
  const total = itens.reduce((s, i) => s + i.valor, 0);
  const W = 600;
  const H = 240;
  const pad = { t: 14, r: 36, b: 60, l: 36 };
  const n = top.length;
  const grupo = (W - pad.l - pad.r) / Math.max(n, 1);
  const y = (pct: number) => H - pad.b - (pct / 100) * (H - pad.t - pad.b);
  if (n === 0 || total === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  const pts = top.map((it, i) => `${pad.l + i * grupo + grupo / 2},${y(it.acumuladoPct)}`);
  return (
    <div className="gr" onMouseLeave={() => setHover(null)}>
      <div className="gr-legenda"><span><i style={{ background: CORES[0] }} />Participação</span><span><i style={{ background: CORES[1] }} />Acumulado</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="gr-svg" role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{titulo}</title>
        {[25, 50, 80, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} className={g === 80 ? "gr-meta" : "gr-grade"} />
            <text x={W - pad.r + 4} y={y(g) + 4} className="gr-eixo">{g}%</text>
          </g>
        ))}
        {top.map((it, i) => {
          const pct = (100 * it.valor) / total;
          const bx = pad.l + i * grupo + grupo * 0.15;
          return (
            <g key={it.chave} onMouseEnter={() => setHover(i)}>
              <rect x={bx} y={y(pct)} width={grupo * 0.7} height={Math.max(0, y(0) - y(pct))} rx={4} fill={CORES[0]} opacity={it.vital ? 1 : 0.45} />
              <text x={bx + grupo * 0.35} y={H - pad.b + 14} className="gr-eixo" textAnchor="end" transform={`rotate(-35 ${bx + grupo * 0.35} ${H - pad.b + 14})`}>{it.chave.length > 18 ? `${it.chave.slice(0, 17)}…` : it.chave}</text>
            </g>
          );
        })}
        <polyline points={pts.join(" ")} fill="none" stroke={CORES[1]} strokeWidth={2} />
        {top.map((it, i) => <circle key={it.chave} cx={pad.l + i * grupo + grupo / 2} cy={y(it.acumuladoPct)} r={4} fill={CORES[1]} stroke="var(--surface)" strokeWidth={2} />)}
      </svg>
      {hover !== null && (
        <Tooltip x={((pad.l + hover * grupo + grupo / 2) / W) * 100} y={8}>
          <b>{top[hover].chave}</b>
          <span>{fmtNum(top[hover].valor)} tickets · {fmtPct((100 * top[hover].valor) / total, 1)}</span>
          <span>acumulado {fmtPct(top[hover].acumuladoPct, 1)}{top[hover].vital ? " · entre os 80%" : ""}</span>
        </Tooltip>
      )}
    </div>
  );
}

/** Linha miniatura (dentro de um card de KPI). */
export function Sparkline({ valores, cor = CORES[0] }: { valores: number[]; cor?: string }) {
  if (valores.length < 2) return null;
  const W = 120;
  const H = 32;
  const max = Math.max(1, ...valores);
  const min = Math.min(...valores);
  const pts = valores.map((v, i) => `${(i * W) / (valores.length - 1)},${H - 2 - ((v - min) / Math.max(1, max - min)) * (H - 4)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="gr-spark" aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke={cor} strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}

/** Barra de atingimento de meta (0 a 100%+), com o valor em texto. */
export function Medidor({ pct, tom }: { pct: number | null; tom: "verde" | "amarelo" | "vermelho" | "cinza" }) {
  return (
    <span className={`gr-medidor gr-medidor--${tom}`} aria-label={pct === null ? "Sem dados" : `Atingimento ${pct}%`}>
      <i style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
    </span>
  );
}
