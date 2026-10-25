import { CATEGORIAS_ENCERRADAS, CATEGORIAS_FECHADAS } from "../chamados/status/types";
import {
  METAS_PADRAO,
  ORIGEM_ROTULO,
  type Alerta,
  type Dimensao,
  type Filtros,
  type Grupo,
  type Insight,
  type Kpis,
  type Metas,
  type PontoDiario,
  type PontoMensal,
  type Projecao,
  type Semaforo,
  type TicketGerencial,
} from "./types";

// Toda a conta da visão gerencial, sem React e sem rede (testes em tests/gerencial-calculos.test.ts).
// Convenções:
//   * "entradas" = tickets criados no período; "resolvidos" = encerrados como resolvido/fechado no período;
//   * "backlog" = abertos no fim do período (ou agora, quando o período inclui hoje);
//   * dias civis sempre no fuso de São Paulo; horas sempre corridas (o SLA em horas úteis já está no prazo).

export const TZ = "America/Sao_Paulo";
const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

// ---------- Datas ----------

/** Dia civil em São Paulo (AAAA-MM-DD). */
export function dia(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

/** "2026-10" do dia civil em São Paulo. */
export function mes(iso: string | Date): string {
  return dia(iso).slice(0, 7);
}

/** Instante do início do dia civil (AAAA-MM-DD) em São Paulo. */
export function inicioDoDia(d: string): Date {
  // Meio-dia UTC cai sempre no dia certo em São Paulo; daí ajusta para 00:00 local.
  const meioDia = new Date(`${d}T12:00:00Z`);
  const local = new Date(meioDia.toLocaleString("en-US", { timeZone: TZ }));
  const diff = meioDia.getTime() - local.getTime();
  return new Date(new Date(`${d}T00:00:00Z`).getTime() + diff);
}

/** Instante do fim do dia civil (23:59:59.999) em São Paulo. */
export function fimDoDia(d: string): Date {
  return new Date(inicioDoDia(somarDias(d, 1)).getTime() - 1);
}

export function somarDias(d: string, n: number): string {
  const base = new Date(`${d}T12:00:00Z`);
  return new Date(base.getTime() + n * DIA_MS).toISOString().slice(0, 10);
}

export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / DIA_MS) + 1;
}

/** Período imediatamente anterior, com o mesmo número de dias. */
export function periodoAnterior(f: Pick<Filtros, "de" | "ate">): { de: string; ate: string } {
  const n = diasEntre(f.de, f.ate);
  return { de: somarDias(f.de, -n), ate: somarDias(f.de, -1) };
}

export function rotuloMes(m: string): string {
  const [ano, mm] = m.split("-");
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${nomes[Number(mm) - 1]}/${ano.slice(2)}`;
}

export function horasEntre(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return (Date.parse(b) - Date.parse(a)) / HORA_MS;
}

// ---------- Predicados ----------

export function encerrado(t: TicketGerencial): boolean {
  return CATEGORIAS_ENCERRADAS.includes(t.categoriaStatus);
}

export function resolvido(t: TicketGerencial): boolean {
  return CATEGORIAS_FECHADAS.includes(t.categoriaStatus) && t.encerradoEm !== null;
}

/** Aberto num instante: criado antes e ainda não encerrado (ou encerrado depois). */
export function abertoEm(t: TicketGerencial, instante: Date): boolean {
  const ms = instante.getTime();
  return Date.parse(t.criadoEm) <= ms && (t.encerradoEm === null || Date.parse(t.encerradoEm) > ms);
}

export function vencido(t: TicketGerencial, agora: Date): boolean {
  return !encerrado(t) && t.slaSolucaoAte !== null && t.slaPausadoDesde === null && Date.parse(t.slaSolucaoAte) < agora.getTime();
}

export function noPrazoSolucao(t: TicketGerencial): boolean | null {
  if (!t.encerradoEm || !t.slaSolucaoAte) return null;
  return Date.parse(t.encerradoEm) <= Date.parse(t.slaSolucaoAte);
}

export function noPrazoResposta(t: TicketGerencial): boolean | null {
  if (!t.primeiraRespostaEm || !t.slaRespostaAte) return null;
  return Date.parse(t.primeiraRespostaEm) <= Date.parse(t.slaRespostaAte);
}

export function parado(t: TicketGerencial, agora: Date, dias: number): boolean {
  if (encerrado(t)) return false;
  const ultima = Date.parse(t.ultimaAcaoEm ?? t.criadoEm);
  return agora.getTime() - ultima > dias * DIA_MS;
}

// ---------- Filtro ----------

/** Recorte por dimensão (setor, equipe, canal). O período é aplicado por cada métrica, não aqui. */
export function filtrarDimensoes(tickets: TicketGerencial[], f: Pick<Filtros, "setor" | "equipe" | "origem">): TicketGerencial[] {
  return tickets.filter(
    (t) => (!f.setor || t.setor === f.setor) && (!f.equipe || (t.equipe ?? "") === f.equipe) && (!f.origem || t.origem === f.origem),
  );
}

export function entradasNoPeriodo(tickets: TicketGerencial[], p: Pick<Filtros, "de" | "ate">): TicketGerencial[] {
  const ini = inicioDoDia(p.de).getTime();
  const fim = fimDoDia(p.ate).getTime();
  return tickets.filter((t) => {
    const c = Date.parse(t.criadoEm);
    return c >= ini && c <= fim;
  });
}

export function resolvidosNoPeriodo(tickets: TicketGerencial[], p: Pick<Filtros, "de" | "ate">): TicketGerencial[] {
  const ini = inicioDoDia(p.de).getTime();
  const fim = fimDoDia(p.ate).getTime();
  return tickets.filter((t) => {
    if (!resolvido(t)) return false;
    const e = Date.parse(t.encerradoEm!);
    return e >= ini && e <= fim;
  });
}

/** "Agora" efetivo do período: o fim dele ou o agora real, o que vier antes. */
export function instanteFinal(p: Pick<Filtros, "ate">, agora: Date): Date {
  const fim = fimDoDia(p.ate);
  return fim.getTime() < agora.getTime() ? fim : agora;
}

export function backlogEm(tickets: TicketGerencial[], instante: Date): TicketGerencial[] {
  return tickets.filter((t) => abertoEm(t, instante));
}

// ---------- Agregações ----------

function media(valores: (number | null)[]): number | null {
  const v = valores.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

function pct(parte: number, total: number): number | null {
  return total === 0 ? null : Math.round((1000 * parte) / total) / 10;
}

function pctDe(itens: TicketGerencial[], teste: (t: TicketGerencial) => boolean | null): number | null {
  const avaliados = itens.map(teste).filter((x): x is boolean => x !== null);
  return pct(avaliados.filter(Boolean).length, avaliados.length);
}

export function kpis(tickets: TicketGerencial[], p: Pick<Filtros, "de" | "ate">, agora: Date, metas: Metas = METAS_PADRAO): Kpis {
  const entradas = entradasNoPeriodo(tickets, p);
  const resolvidos = resolvidosNoPeriodo(tickets, p);
  const fim = instanteFinal(p, agora);
  const backlog = backlogEm(tickets, fim);
  const ini = inicioDoDia(p.de).getTime();
  const fimMs = fimDoDia(p.ate).getTime();
  const cancelados = tickets.filter((t) => t.categoriaStatus === "cancelado" && t.encerradoEm && Date.parse(t.encerradoEm) >= ini && Date.parse(t.encerradoEm) <= fimMs).length;
  const comIa = entradas.filter((t) => t.ia !== null);
  const maisAntigo = backlog.length ? Math.min(...backlog.map((t) => Date.parse(t.criadoEm))) : null;
  return {
    entradas: entradas.length,
    resolvidos: resolvidos.length,
    cancelados,
    backlog: backlog.length,
    vencidos: backlog.filter((t) => vencido(t, fim)).length,
    semResponsavel: backlog.filter((t) => t.responsavelId === null).length,
    parados: backlog.filter((t) => parado(t, fim, metas.parado_dias)).length,
    slaSolucaoPct: pctDe(resolvidos, noPrazoSolucao),
    slaRespostaPct: pctDe(entradas, noPrazoResposta),
    tmrHoras: media(resolvidos.map((t) => horasEntre(t.criadoEm, t.encerradoEm))),
    tprHoras: media(entradas.map((t) => horasEntre(t.criadoEm, t.primeiraRespostaEm))),
    reaberturaPct: pct(resolvidos.filter((t) => t.reaberturas > 0).length, resolvidos.length),
    taxaResolucaoPct: pct(resolvidos.length, entradas.length),
    maisAntigoDias: maisAntigo === null ? null : Math.floor((fim.getTime() - maisAntigo) / DIA_MS),
    iaAutomaticaPct: pct(comIa.filter((t) => t.ia === "aplicado").length, comIa.length),
    esforcoMedio: media(resolvidos.map((t) => t.acoesPublicas)),
  };
}

/** Variação percentual entre dois valores (null quando não dá para comparar). */
export function variacaoPct(atual: number | null, anterior: number | null): number | null {
  if (atual === null || anterior === null || anterior === 0) return null;
  return Math.round((1000 * (atual - anterior)) / Math.abs(anterior)) / 10;
}

export function chaveDimensao(t: TicketGerencial, d: Dimensao): string {
  switch (d) {
    case "origem":
      return ORIGEM_ROTULO[t.origem];
    case "mes":
      return mes(t.criadoEm);
    case "responsavel":
      return t.responsavel ?? "Sem responsável";
    case "equipe":
      return t.equipe ?? "Sem equipe";
    case "servico":
      return t.servico ?? "Sem serviço";
    case "categoria":
      return t.categoria ?? "Sem categoria";
    case "urgencia":
      return t.urgencia ?? "—";
    case "departamento":
      return t.departamento ?? "Não identificado";
    case "setor":
      return t.setor ?? "—";
  }
}

/** Agrupa por dimensão; cada grupo com entradas, resolvidos, backlog, vencidos, SLA e TMR. */
export function agrupar(tickets: TicketGerencial[], d: Dimensao, p: Pick<Filtros, "de" | "ate">, agora: Date): Grupo[] {
  const fim = instanteFinal(p, agora);
  const entradas = entradasNoPeriodo(tickets, p);
  const resolvidos = resolvidosNoPeriodo(tickets, p);
  const backlog = backlogEm(tickets, fim);
  const chaves = new Set<string>([...entradas, ...resolvidos, ...backlog].map((t) => chaveDimensao(t, d)));
  const grupos = [...chaves].map((chave): Grupo => {
    const e = entradas.filter((t) => chaveDimensao(t, d) === chave);
    const r = resolvidos.filter((t) => chaveDimensao(t, d) === chave);
    const b = backlog.filter((t) => chaveDimensao(t, d) === chave);
    return {
      chave,
      entradas: e.length,
      resolvidos: r.length,
      backlog: b.length,
      vencidos: b.filter((t) => vencido(t, fim)).length,
      semResponsavel: b.filter((t) => t.responsavelId === null).length,
      slaSolucaoPct: pctDe(r, noPrazoSolucao),
      tmrHoras: media(r.map((t) => horasEntre(t.criadoEm, t.encerradoEm))),
    };
  });
  return d === "mes" ? grupos.sort((a, b) => a.chave.localeCompare(b.chave)) : grupos.sort((a, b) => b.entradas - a.entradas || a.chave.localeCompare(b.chave));
}

/** Entradas, resolvidos e backlog no fim de cada dia do período. */
export function serieDiaria(tickets: TicketGerencial[], p: Pick<Filtros, "de" | "ate">, agora: Date): PontoDiario[] {
  const n = diasEntre(p.de, p.ate);
  const pontos: PontoDiario[] = [];
  for (let i = 0; i < n; i++) {
    const d = somarDias(p.de, i);
    const fim = fimDoDia(d);
    if (inicioDoDia(d).getTime() > agora.getTime()) break;
    pontos.push({
      dia: d,
      entradas: tickets.filter((t) => dia(t.criadoEm) === d).length,
      resolvidos: tickets.filter((t) => resolvido(t) && dia(t.encerradoEm!) === d).length,
      backlog: backlogEm(tickets, fim.getTime() < agora.getTime() ? fim : agora).length,
    });
  }
  return pontos;
}

/** Série mensal dos últimos `meses` meses (termina no mês de `agora`). */
export function serieMensal(tickets: TicketGerencial[], meses: number, agora: Date): PontoMensal[] {
  const atual = mes(agora);
  const [anoA, mesA] = atual.split("-").map(Number);
  const lista: PontoMensal[] = [];
  for (let i = meses - 1; i >= 0; i--) {
    const total = anoA * 12 + (mesA - 1) - i;
    const ano = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    const m = `${ano}-${String(mm).padStart(2, "0")}`;
    const de = `${m}-01`;
    const ultimo = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
    const ate = `${m}-${String(ultimo).padStart(2, "0")}`;
    const r = resolvidosNoPeriodo(tickets, { de, ate });
    lista.push({
      mes: m,
      rotulo: rotuloMes(m),
      entradas: entradasNoPeriodo(tickets, { de, ate }).length,
      resolvidos: r.length,
      backlogFim: backlogEm(tickets, instanteFinal({ ate }, agora)).length,
      slaSolucaoPct: pctDe(r, noPrazoSolucao),
      tmrHoras: media(r.map((t) => horasEntre(t.criadoEm, t.encerradoEm))),
    });
  }
  return lista;
}

export const FAIXAS_AGING = ["0–1 dia", "1–3 dias", "3–7 dias", "7–15 dias", "15–30 dias", "+30 dias"] as const;

/** Idade do backlog por faixa. */
export function aging(backlog: TicketGerencial[], agora: Date): { faixa: string; total: number; vencidos: number }[] {
  const limites = [1, 3, 7, 15, 30, Infinity];
  const faixas = FAIXAS_AGING.map((faixa) => ({ faixa, total: 0, vencidos: 0 }));
  for (const t of backlog) {
    const dias = (agora.getTime() - Date.parse(t.criadoEm)) / DIA_MS;
    const i = limites.findIndex((l) => dias < l);
    faixas[i].total++;
    if (vencido(t, agora)) faixas[i].vencidos++;
  }
  return faixas;
}

export const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

/** Entradas por dia da semana × hora (fuso de São Paulo). [7][24]. */
export function mapaCalor(entradas: TicketGerencial[]): number[][] {
  const m = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: false });
  const idx: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const t of entradas) {
    const partes = fmt.formatToParts(new Date(t.criadoEm));
    const wd = idx[partes.find((p) => p.type === "weekday")?.value ?? "Mon"];
    const h = Number(partes.find((p) => p.type === "hour")?.value ?? 0) % 24;
    m[wd][h]++;
  }
  return m;
}

export const FAIXAS_SOLUCAO = ["≤ 1 h", "1–4 h", "4–8 h", "8–24 h", "1–3 dias", "3–7 dias", "+7 dias"] as const;

/** Distribuição do tempo de resolução. */
export function histogramaSolucao(resolvidos: TicketGerencial[]): { faixa: string; total: number }[] {
  const limites = [1, 4, 8, 24, 72, 168, Infinity];
  const faixas = FAIXAS_SOLUCAO.map((faixa) => ({ faixa, total: 0 }));
  for (const t of resolvidos) {
    const h = horasEntre(t.criadoEm, t.encerradoEm);
    if (h === null) continue;
    faixas[limites.findIndex((l) => h < l)].total++;
  }
  return faixas;
}

/** Pareto: grupos por entradas com % acumulado (os que somam 80% vêm marcados). */
export function pareto(grupos: Grupo[]): { chave: string; valor: number; acumuladoPct: number; vital: boolean }[] {
  const total = grupos.reduce((s, g) => s + g.entradas, 0);
  let acc = 0;
  return [...grupos]
    .sort((a, b) => b.entradas - a.entradas)
    .map((g) => {
      const antes = acc;
      acc += g.entradas;
      const acumuladoPct = total ? Math.round((1000 * acc) / total) / 10 : 0;
      return { chave: g.chave, valor: g.entradas, acumuladoPct, vital: total > 0 && antes / total < 0.8 };
    });
}

export interface Produtividade {
  responsavel: string;
  resolvidos: number;
  backlog: number;
  vencidos: number;
  slaSolucaoPct: number | null;
  tmrHoras: number | null;
  esforcoMedio: number | null;
}

/** Produtividade por agente no período (resolvidos) e a carga atual (backlog). */
export function produtividade(tickets: TicketGerencial[], p: Pick<Filtros, "de" | "ate">, agora: Date): Produtividade[] {
  const fim = instanteFinal(p, agora);
  const resolvidos = resolvidosNoPeriodo(tickets, p).filter((t) => t.responsavel);
  const backlog = backlogEm(tickets, fim).filter((t) => t.responsavel);
  const nomes = new Set([...resolvidos, ...backlog].map((t) => t.responsavel!));
  return [...nomes]
    .map((nome) => {
      const r = resolvidos.filter((t) => t.responsavel === nome);
      const b = backlog.filter((t) => t.responsavel === nome);
      return {
        responsavel: nome,
        resolvidos: r.length,
        backlog: b.length,
        vencidos: b.filter((t) => vencido(t, fim)).length,
        slaSolucaoPct: pctDe(r, noPrazoSolucao),
        tmrHoras: media(r.map((t) => horasEntre(t.criadoEm, t.encerradoEm))),
        esforcoMedio: media(r.map((t) => t.acoesPublicas)),
      };
    })
    .sort((a, b) => b.resolvidos - a.resolvidos || a.responsavel.localeCompare(b.responsavel));
}

// ---------- Semáforo e metas ----------

/** Direção "maior melhor" (SLA %) ou "menor melhor" (tempos, limites). Amarelo = até 10% fora da meta. */
export function semaforo(valor: number | null, meta: number, maiorMelhor: boolean): Semaforo {
  if (valor === null) return "cinza";
  const folga = Math.abs(meta) * 0.1;
  if (maiorMelhor) {
    if (valor >= meta) return "verde";
    return valor >= meta - folga ? "amarelo" : "vermelho";
  }
  if (valor <= meta) return "verde";
  return valor <= meta + folga ? "amarelo" : "vermelho";
}

export interface Indicador {
  chave: string;
  label: string;
  valor: number | null;
  meta: number;
  unidade: string;
  maiorMelhor: boolean;
  semaforo: Semaforo;
  anterior: number | null;
  variacaoPct: number | null;
  /** Quanto da meta foi atingido, em % (limitado a 150). */
  atingimentoPct: number | null;
  descricao: string;
}

export function indicadores(atual: Kpis, anterior: Kpis, metas: Metas): Indicador[] {
  const def = (chave: string, label: string, valor: number | null, ant: number | null, meta: number, unidade: string, maiorMelhor: boolean, descricao: string): Indicador => {
    let atingimento: number | null = null;
    if (valor !== null && meta > 0) atingimento = Math.min(150, Math.round(maiorMelhor ? (100 * valor) / meta : (100 * meta) / Math.max(valor, 0.0001)));
    return { chave, label, valor, meta, unidade, maiorMelhor, semaforo: semaforo(valor, meta, maiorMelhor), anterior: ant, variacaoPct: variacaoPct(valor, ant), atingimentoPct: atingimento, descricao };
  };
  return [
    def("sla_solucao", "SLA de solução", atual.slaSolucaoPct, anterior.slaSolucaoPct, metas.sla_solucao_pct, "%", true, "Resolvidos dentro do prazo de solução."),
    def("sla_resposta", "SLA de 1ª resposta", atual.slaRespostaPct, anterior.slaRespostaPct, metas.sla_resposta_pct, "%", true, "Primeira resposta dentro do prazo."),
    def("tmr", "Tempo médio de resolução", atual.tmrHoras, anterior.tmrHoras, metas.tmr_horas, "h", false, "Da abertura ao encerramento, em horas corridas."),
    def("tpr", "Tempo médio de 1ª resposta", atual.tprHoras, anterior.tprHoras, metas.tpr_horas, "h", false, "Da abertura à primeira resposta pública."),
    def("reabertura", "Taxa de reabertura", atual.reaberturaPct, anterior.reaberturaPct, metas.reabertura_pct_max, "%", false, "Resolvidos que voltaram a abrir."),
    def("backlog", "Backlog", atual.backlog, anterior.backlog, metas.backlog_max, "tickets", false, "Abertos no fim do período."),
    def("vencidos", "SLA vencido", atual.vencidos, anterior.vencidos, metas.vencidos_max, "tickets", false, "Abertos com prazo de solução vencido."),
    def("sem_responsavel", "Sem responsável", atual.semResponsavel, anterior.semResponsavel, metas.sem_responsavel_max, "tickets", false, "Abertos sem ninguém designado."),
    def("taxa_resolucao", "Taxa de resolução", atual.taxaResolucaoPct, anterior.taxaResolucaoPct, 100, "%", true, "Resolvidos ÷ entradas. Abaixo de 100% o backlog cresce."),
  ];
}

// ---------- Projeção ----------

/** Regressão linear simples: devolve [intercepto, inclinação]. */
export function regressao(valores: number[]): [number, number] {
  const n = valores.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [valores[0], 0];
  const mx = (n - 1) / 2;
  const my = valores.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  valores.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  const b = den ? num / den : 0;
  return [my - b * mx, b];
}

/**
 * Projeta `diasFuturos` dias a partir da série diária: tendência linear das entradas × fator do dia da semana,
 * capacidade = média de resolvidos por dia útil observada. Backlog projetado = anterior + entradas − capacidade.
 */
export function projecao(historico: PontoDiario[], diasFuturos: number, backlogAtual: number, ajusteCapacidade = 1): Projecao {
  const base = historico.slice(-56); // até 8 semanas
  if (base.length === 0) {
    return { dias: [], entradasPorDia: 0, capacidadePorDia: 0, tendenciaPorDia: 0, backlogFinal: backlogAtual, diasParaZerar: null, confiabilidade: "baixa" };
  }
  const entradas = base.map((p) => p.entradas);
  const [a, b] = regressao(entradas);
  const mediaEntradas = entradas.reduce((s, v) => s + v, 0) / entradas.length;
  // Fator sazonal por dia da semana (em relação à média), só com pelo menos 2 semanas.
  const porDiaSemana = Array.from({ length: 7 }, () => [] as number[]);
  for (const p of base) porDiaSemana[new Date(`${p.dia}T12:00:00Z`).getUTCDay()].push(p.entradas);
  const fator = porDiaSemana.map((v) => (base.length >= 14 && v.length && mediaEntradas > 0 ? v.reduce((s, x) => s + x, 0) / v.length / mediaEntradas : 1));
  const diasUteis = base.filter((p) => ![0, 6].includes(new Date(`${p.dia}T12:00:00Z`).getUTCDay()));
  const capacidade = (diasUteis.length ? diasUteis.reduce((s, p) => s + p.resolvidos, 0) / diasUteis.length : 0) * ajusteCapacidade;

  const dias: Projecao["dias"] = [];
  let backlog = backlogAtual;
  let ultimo = base[base.length - 1].dia;
  let zerou: number | null = null;
  for (let i = 1; i <= diasFuturos; i++) {
    ultimo = somarDias(ultimo, 1);
    const dow = new Date(`${ultimo}T12:00:00Z`).getUTCDay();
    const tendencia = Math.max(0, a + b * (base.length - 1 + i));
    const e = Math.max(0, Math.round(tendencia * fator[dow] * 10) / 10);
    const r = [0, 6].includes(dow) ? 0 : Math.round(capacidade * 10) / 10;
    backlog = Math.max(0, Math.round((backlog + e - r) * 10) / 10);
    if (backlog === 0 && zerou === null) zerou = i;
    dias.push({ dia: ultimo, entradas: e, resolvidos: r, backlog });
  }
  const confiabilidade: Projecao["confiabilidade"] = base.length >= 42 ? "alta" : base.length >= 14 ? "media" : "baixa";
  return {
    dias,
    entradasPorDia: Math.round(mediaEntradas * 10) / 10,
    capacidadePorDia: Math.round(capacidade * 10) / 10,
    tendenciaPorDia: Math.round(b * 1000) / 1000,
    backlogFinal: dias.length ? dias[dias.length - 1].backlog : backlogAtual,
    diasParaZerar: zerou,
    confiabilidade,
  };
}

// ---------- Alertas ----------

export function alertas(atual: Kpis, anterior: Kpis, metas: Metas, grupos: { equipe: Grupo[] }): Alerta[] {
  const lista: Alerta[] = [];
  const regra = (id: string, titulo: string, valor: number | null, limite: number, unidade: string, maiorMelhor: boolean, texto: (v: number) => string) => {
    if (valor === null) return;
    const s = semaforo(valor, limite, maiorMelhor);
    lista.push({ id, nivel: s === "vermelho" ? "critico" : s === "amarelo" ? "atencao" : "ok", titulo, texto: texto(valor), valor, limite, unidade });
  };
  regra("vencidos", "Tickets com SLA vencido", atual.vencidos, metas.vencidos_max, "tickets", false, (v) => `${v} abertos com o prazo de solução vencido (limite ${metas.vencidos_max}).`);
  regra("sem_responsavel", "Tickets sem responsável", atual.semResponsavel, metas.sem_responsavel_max, "tickets", false, (v) => `${v} abertos sem ninguém designado (limite ${metas.sem_responsavel_max}).`);
  regra("backlog", "Backlog acima do limite", atual.backlog, metas.backlog_max, "tickets", false, (v) => `${v} tickets abertos ao mesmo tempo (limite ${metas.backlog_max}).`);
  regra("parados", "Tickets parados", atual.parados, 0, "tickets", false, (v) => `${v} abertos há mais de ${metas.parado_dias} dias sem nenhuma ação.`);
  regra("sla_solucao", "SLA de solução abaixo da meta", atual.slaSolucaoPct, metas.sla_solucao_pct, "%", true, (v) => `${v}% resolvidos no prazo (meta ${metas.sla_solucao_pct}%).`);
  regra("sla_resposta", "SLA de 1ª resposta abaixo da meta", atual.slaRespostaPct, metas.sla_resposta_pct, "%", true, (v) => `${v}% respondidos no prazo (meta ${metas.sla_resposta_pct}%).`);
  regra("tmr", "Tempo de resolução acima da meta", atual.tmrHoras === null ? null : Math.round(atual.tmrHoras * 10) / 10, metas.tmr_horas, "h", false, (v) => `${v} h em média para resolver (meta ${metas.tmr_horas} h).`);
  regra("reabertura", "Reabertura acima do limite", atual.reaberturaPct, metas.reabertura_pct_max, "%", false, (v) => `${v}% dos resolvidos voltaram a abrir (limite ${metas.reabertura_pct_max}%).`);
  const cresc = variacaoPct(atual.entradas, anterior.entradas);
  regra("crescimento", "Entradas crescendo", cresc, metas.crescimento_alerta_pct, "%", false, (v) => `${v > 0 ? "+" : ""}${v}% de entradas em relação ao período anterior (alerta a partir de ${metas.crescimento_alerta_pct}%).`);
  const taxa = atual.taxaResolucaoPct;
  regra("taxa_resolucao", "Resolvendo menos do que entra", taxa, 100, "%", true, (v) => `${v}% das entradas foram resolvidas no período: o backlog tende a crescer.`);
  // Equipe sobrecarregada: vencidos concentrados (> 50% dos vencidos numa equipe com ≥ 3 vencidos).
  const totalVencidos = grupos.equipe.reduce((s, g) => s + g.vencidos, 0);
  for (const g of grupos.equipe) {
    if (g.vencidos >= 3 && g.vencidos / Math.max(totalVencidos, 1) > 0.5) {
      lista.push({ id: `equipe:${g.chave}`, nivel: "critico", titulo: `Equipe ${g.chave} sobrecarregada`, texto: `${g.vencidos} dos ${totalVencidos} tickets vencidos estão com ${g.chave} (backlog de ${g.backlog}).`, valor: g.vencidos, limite: Math.ceil(totalVencidos / 2), unidade: "tickets" });
    }
  }
  const ordem = { critico: 0, atencao: 1, ok: 2 };
  return lista.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}

// ---------- Insights (regras; a IA entra por cima, em hooks.ts) ----------

export function insights(args: {
  atual: Kpis;
  anterior: Kpis;
  diaria: PontoDiario[];
  mensal: PontoMensal[];
  porServico: Grupo[];
  porEquipe: Grupo[];
  porOrigem: Grupo[];
  produtividade: Produtividade[];
  metas: Metas;
}): Insight[] {
  const { atual, anterior, diaria, mensal, porServico, porEquipe, porOrigem, produtividade: prod, metas } = args;
  const lista: Insight[] = [];
  const fmt = (n: number | null, d = 0) => (n === null ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: d }));

  // Anomalia: dia com entradas acima de média + 2 desvios.
  if (diaria.length >= 7) {
    const v = diaria.map((p) => p.entradas);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
    const picos = diaria.filter((p) => sd > 0 && p.entradas > m + 2 * sd);
    for (const p of picos.slice(-2)) {
      lista.push({ tipo: "anomalia", titulo: `Pico de entradas em ${p.dia.split("-").reverse().join("/")}`, texto: `${p.entradas} tickets num dia, contra ${fmt(m, 1)} de média. Vale conferir se foi um incidente (vários chamados do mesmo serviço).`, evidencia: `média ${fmt(m, 1)} · desvio ${fmt(sd, 1)}` });
    }
  }
  // Tendência: 3 meses seguidos de alta/baixa nas entradas.
  const ult = mensal.slice(-4);
  if (ult.length === 4) {
    const dif = ult.slice(1).map((p, i) => p.entradas - ult[i].entradas);
    if (dif.every((d) => d > 0)) lista.push({ tipo: "tendencia", titulo: "Demanda em alta há 3 meses", texto: `As entradas subiram de ${ult[0].entradas} (${ult[0].rotulo}) para ${ult[3].entradas} (${ult[3].rotulo}). Planeje capacidade ou automação antes que o backlog acompanhe.`, evidencia: ult.map((p) => `${p.rotulo}: ${p.entradas}`).join(" · ") });
    if (dif.every((d) => d < 0)) lista.push({ tipo: "tendencia", titulo: "Demanda em queda há 3 meses", texto: `As entradas caíram de ${ult[0].entradas} para ${ult[3].entradas}. Pode ser efeito de automação ou de sazonalidade; confirme antes de redistribuir a equipe.`, evidencia: ult.map((p) => `${p.rotulo}: ${p.entradas}`).join(" · ") });
  }
  // Risco: backlog crescendo (taxa de resolução < 100% e backlog subiu).
  if (atual.taxaResolucaoPct !== null && atual.taxaResolucaoPct < 90 && atual.backlog > anterior.backlog) {
    lista.push({ tipo: "risco", titulo: "Backlog em crescimento", texto: `Só ${fmt(atual.taxaResolucaoPct)}% das entradas foram resolvidas e o backlog passou de ${anterior.backlog} para ${atual.backlog}. Sem mudar a capacidade, os prazos vão vencer em cascata.`, evidencia: `entradas ${atual.entradas} · resolvidos ${atual.resolvidos}` });
  }
  // Risco: ticket mais antigo.
  if (atual.maisAntigoDias !== null && atual.maisAntigoDias > metas.parado_dias * 2) {
    lista.push({ tipo: "risco", titulo: `Ticket aberto há ${atual.maisAntigoDias} dias`, texto: `O ticket mais antigo do backlog tem ${atual.maisAntigoDias} dias. Tickets velhos puxam o tempo médio e costumam indicar dependência externa não registrada como pendente.`, evidencia: `limite de parado: ${metas.parado_dias} dias` });
  }
  // Oportunidade: serviço que concentra demanda (Pareto).
  const par = pareto(porServico);
  const vitais = par.filter((p) => p.vital);
  if (par.length >= 4 && vitais.length <= Math.ceil(par.length / 3)) {
    lista.push({ tipo: "oportunidade", titulo: `${vitais.length} serviços concentram ${fmt(vitais[vitais.length - 1].acumuladoPct)}% da demanda`, texto: `${vitais.map((v) => v.chave).join(", ")}. Base de conhecimento, formulário guiado na intranet ou automação nesses serviços têm o maior retorno.`, evidencia: vitais.map((v) => `${v.chave}: ${v.valor}`).join(" · ") });
  }
  // Oportunidade: serviço com SLA ruim e volume.
  const pior = porServico.filter((g) => g.resolvidos >= 5 && g.slaSolucaoPct !== null).sort((a, b) => a.slaSolucaoPct! - b.slaSolucaoPct!)[0];
  if (pior && pior.slaSolucaoPct! < metas.sla_solucao_pct - 10) {
    lista.push({ tipo: "risco", titulo: `${pior.chave} abaixo da meta de SLA`, texto: `${fmt(pior.slaSolucaoPct)}% no prazo em ${pior.resolvidos} resolvidos (meta ${metas.sla_solucao_pct}%). Revise o prazo cadastrado do serviço ou a equipe responsável.`, evidencia: `TMR ${fmt(pior.tmrHoras, 1)} h` });
  }
  // Oportunidade: canal com melhor desempenho.
  const canais = porOrigem.filter((g) => g.resolvidos >= 5 && g.slaSolucaoPct !== null);
  if (canais.length >= 2) {
    const melhor = [...canais].sort((a, b) => b.slaSolucaoPct! - a.slaSolucaoPct!)[0];
    const piorC = [...canais].sort((a, b) => a.slaSolucaoPct! - b.slaSolucaoPct!)[0];
    if (melhor.slaSolucaoPct! - piorC.slaSolucaoPct! >= 15) {
      lista.push({ tipo: "oportunidade", titulo: `${melhor.chave} resolve melhor que ${piorC.chave}`, texto: `${fmt(melhor.slaSolucaoPct)}% no prazo contra ${fmt(piorC.slaSolucaoPct)}%. Direcionar solicitantes para o canal mais eficiente melhora o SLA sem aumentar a equipe.`, evidencia: canais.map((c) => `${c.chave}: ${fmt(c.slaSolucaoPct)}%`).join(" · ") });
    }
  }
  // Risco: carga desigual entre agentes.
  if (prod.length >= 2) {
    const maior = prod.reduce((a, b) => (b.backlog > a.backlog ? b : a));
    const mediaBacklog = prod.reduce((s, p) => s + p.backlog, 0) / prod.length;
    if (maior.backlog >= 5 && maior.backlog > 2 * mediaBacklog) {
      lista.push({ tipo: "risco", titulo: `${maior.responsavel} com o dobro da carga média`, texto: `${maior.backlog} tickets abertos (média ${fmt(mediaBacklog, 1)}), ${maior.vencidos} vencidos. Redistribuir evita que um gargalo individual vire atraso da equipe.`, evidencia: prod.slice(0, 5).map((p) => `${p.responsavel}: ${p.backlog}`).join(" · ") });
    }
  }
  // Oportunidade: IA.
  if (atual.iaAutomaticaPct !== null && atual.iaAutomaticaPct < 50 && atual.entradas >= 20) {
    lista.push({ tipo: "oportunidade", titulo: "Triagem automática abaixo de 50%", texto: `${fmt(atual.iaAutomaticaPct)}% das entradas foram classificadas pela IA sem revisão. Melhorar as descrições dos serviços (Administração › Serviços) aumenta a confiança e tira trabalho manual da triagem.`, evidencia: `${atual.entradas} entradas no período` });
  }
  // Equipe com melhor SLA (reconhecimento).
  const melhorEquipe = porEquipe.filter((g) => g.resolvidos >= 5 && g.slaSolucaoPct !== null).sort((a, b) => b.slaSolucaoPct! - a.slaSolucaoPct!)[0];
  if (melhorEquipe && melhorEquipe.slaSolucaoPct! >= metas.sla_solucao_pct) {
    lista.push({ tipo: "oportunidade", titulo: `${melhorEquipe.chave} dentro da meta de SLA`, texto: `${fmt(melhorEquipe.slaSolucaoPct)}% no prazo em ${melhorEquipe.resolvidos} resolvidos. Vale documentar o que a equipe faz diferente e replicar.`, evidencia: `TMR ${fmt(melhorEquipe.tmrHoras, 1)} h` });
  }
  return lista;
}

/** Resumo compacto (sem dados pessoais) que vai para a IA gerar recomendações. */
export function resumoParaIa(args: { periodo: Filtros; atual: Kpis; anterior: Kpis; porEquipe: Grupo[]; porServico: Grupo[]; porOrigem: Grupo[]; mensal: PontoMensal[]; alertas: Alerta[]; insights: Insight[] }) {
  const g = (lista: Grupo[]) => lista.slice(0, 8).map(({ chave, entradas, resolvidos, backlog, vencidos, slaSolucaoPct, tmrHoras }) => ({ chave, entradas, resolvidos, backlog, vencidos, slaSolucaoPct, tmrHoras: tmrHoras === null ? null : Math.round(tmrHoras * 10) / 10 }));
  return {
    periodo: { de: args.periodo.de, ate: args.periodo.ate, setor: args.periodo.setor || null, equipe: args.periodo.equipe || null, canal: args.periodo.origem || null },
    atual: args.atual,
    anterior: args.anterior,
    porEquipe: g(args.porEquipe),
    porServico: g(args.porServico),
    porCanal: g(args.porOrigem),
    mensal: args.mensal.map(({ rotulo, entradas, resolvidos, backlogFim, slaSolucaoPct }) => ({ mes: rotulo, entradas, resolvidos, backlogFim, slaSolucaoPct })),
    alertas: args.alertas.filter((a) => a.nivel !== "ok").map(({ titulo, texto }) => ({ titulo, texto })),
    insights: args.insights.map(({ tipo, titulo, evidencia }) => ({ tipo, titulo, evidencia })),
  };
}
