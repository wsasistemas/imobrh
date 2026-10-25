import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpDown, Building2, CalendarPlus, CircleCheckBig, Clock, Hash, Hourglass, Inbox, ListOrdered, MessageSquare, Phone, RefreshCw, Ticket, User, UserCheck, Wifi, X } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import "../../configuracoes/components/Sheet.css";
import { useAcaoConversa, useConversas, useMonitorAtendentes, useMonitorConversas, useMonitorIndicadores } from "../hooks/useAtendimento";
import type { Contexto, Indicadores, MonitorAtendente, MonitorConversa, Periodo } from "../services/tipos";
import { Chat, msgErro } from "./Central";
import { duracao, gerencia, minutos, telefone } from "./util";

interface Kpi {
  titulo: string;
  ajuda: string;
  valor: (i: Indicadores) => number | null;
  formato: (v: number | null) => string;
  /** Subir é ruim (tempo de espera, não resolvidas…). */
  menorMelhor: boolean;
}

const KPIS: Kpi[] = [
  { titulo: "Conversas atendidas", ajuda: "Atendimentos encerrados no período", valor: (i) => i.atendidas, formato: (v) => String(v ?? 0), menorMelhor: false },
  { titulo: "Resolvidas no 1º atendimento", ajuda: "Sem transferência, sem voltar à fila e sem o cliente voltar em 24 h", valor: (i) => i.resolvidas1o, formato: (v) => String(v ?? 0), menorMelhor: false },
  { titulo: "Não resolvidas no 1º atendimento", ajuda: "Transferidas, devolvidas à fila ou reabertas em 24 h", valor: (i) => i.atendidas - i.resolvidas1o, formato: (v) => String(v ?? 0), menorMelhor: true },
  { titulo: "Recebidas fora do horário", ajuda: "Entraram com o setor fechado ou sem atendente online", valor: (i) => i.foraHorario, formato: (v) => String(v ?? 0), menorMelhor: true },
  { titulo: "Tempo médio de espera", ajuda: "Da entrada na fila até alguém assumir", valor: (i) => i.esperaMediaSeg, formato: minutos, menorMelhor: true },
  { titulo: "Tempo médio de atendimento", ajuda: "De assumir até encerrar", valor: (i) => i.atendimentoMedioSeg, formato: minutos, menorMelhor: true },
];

function variacao(atual: number | null, anterior: number | null, menorMelhor: boolean): { texto: string; classe: string } {
  if (atual === null || anterior === null || anterior === 0) {
    return { texto: atual && !anterior ? "novo" : "0,00%", classe: "at-kpi__d--igual" };
  }
  const pct = ((atual - anterior) / anterior) * 100;
  if (Math.abs(pct) < 0.005) return { texto: "0,00%", classe: "at-kpi__d--igual" };
  const bom = menorMelhor ? pct < 0 : pct > 0;
  return { texto: `${pct > 0 ? "+" : ""}${pct.toFixed(2).replace(".", ",")}%`, classe: bom ? "at-kpi__d--bom" : "at-kpi__d--ruim" };
}

/** Relógio único do Monitor: os tempos de espera e duração andam a cada segundo. */
function useAgora(): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return agora;
}

const desde = (iso: string | null, agora: number) => (iso ? agora - new Date(iso).getTime() : 0);
const horaDe = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");

/** Central › Monitor: visão do gestor (só os setores dele) e da supervisão geral (todos). */
export function Monitor({ ctx, setorId, onAbrir }: { ctx: Contexto; setorId: number | null; onAbrir: (conversaId: number) => void }) {
  const ids = useId();
  const [periodo, setPeriodo] = useState<Periodo>("mes");
  // O gestor só monitora os setores que gerencia: escolhe dentro deles.
  const gerenciados = ctx.setores.filter(gerencia);
  const alvo = setorId !== null && gerenciados.some((s) => s.id === setorId) ? setorId : gerenciados.length === 1 ? gerenciados[0]!.id : null;
  const indicadores = useMonitorIndicadores(periodo, alvo, true);
  const atendentes = useMonitorAtendentes(alvo, true);
  const conversas = useMonitorConversas(alvo, true);
  const agora = useAgora();
  const [ver, setVer] = useState<number | null>(null);
  const acao = useAcaoConversa();
  const variosSetores = alvo === null && gerenciados.length > 1;
  const setor = (id: number) => ctx.setores.find((s) => s.id === id);

  const atender = (conversaId: number) =>
    acao.mutate(
      { conversaId, acao: { acao: "assumir" } },
      {
        onSuccess: () => {
          toast.success("Conversa assumida");
          setVer(null);
          onAbrir(conversaId);
        },
        onError: (e) => toast.error(msgErro(e, "Não foi possível assumir.")),
      },
    );
  const recarregar = () => {
    void indicadores.refetch();
    void atendentes.refetch();
    void conversas.refetch();
  };

  const fila = (conversas.data ?? []).filter((c) => c.modo === "fila").sort((a, b) => (a.filaDesde ?? "").localeCompare(b.filaDesde ?? ""));
  const emAtendimento = (conversas.data ?? []).filter((c) => c.modo === "atendente");

  return (
    <div>
      <div className="at-mon-topo">
        <section className="card at-mon-card" aria-labelledby={`${ids}-ind`}>
          <div className="at-mon-head">
            <h2 id={`${ids}-ind`}>Principais indicadores</h2>
            <label className="visually-hidden" htmlFor={`${ids}-per`}>Período</label>
            <select id={`${ids}-per`} className="input input--sm" value={periodo} onChange={(e) => setPeriodo(e.target.value as Periodo)}>
              <option value="hoje">Hoje</option>
              <option value="semana">Esta semana</option>
              <option value="mes">Este mês</option>
            </select>
            <button type="button" className="icon-btn icon-btn--bordered" title="Atualizar" aria-label="Atualizar" onClick={recarregar}>
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
          {indicadores.isError ? (
            <ErrorState bare message={msgErro(indicadores.error, "Não foi possível carregar os indicadores.")} onRetry={() => void indicadores.refetch()} />
          ) : (
            KPIS.map((k) => {
              const d = indicadores.data;
              const atual = d ? k.valor(d.atual) : null;
              const v = d ? variacao(atual, k.valor(d.anterior), k.menorMelhor) : null;
              return (
                <div key={k.titulo} className="at-kpi">
                  <div>
                    <b>{k.titulo}</b>
                    <span>{k.ajuda}</span>
                  </div>
                  <div className="at-kpi__v">{d ? k.formato(atual) : "…"}</div>
                  <div className={`at-kpi__d ${v?.classe ?? ""}`} title="Comparado ao mesmo trecho do período anterior">{v?.texto ?? ""}</div>
                </div>
              );
            })
          )}
        </section>

        <section className="card at-mon-card" aria-labelledby={`${ids}-ag`}>
          <div className="at-mon-head">
            <h2 id={`${ids}-ag`}>Acompanhamento de atendentes</h2>
          </div>
          <div className="at-tab-wrap">
            <table className="at-tab">
              <thead>
                <tr>
                  <th><ThLabel icon={UserCheck}>Atendente</ThLabel></th>
                  <th className="c"><ThLabel icon={Wifi}>Online</ThLabel></th>
                  <th className="c"><ThLabel icon={CircleCheckBig}>Disponível</ThLabel></th>
                  <th className="n"><ThLabel icon={MessageSquare}>Em atendimento</ThLabel></th>
                  <th className="n"><ThLabel icon={Hash}>Atendidas hoje</ThLabel></th>
                  <th className="n"><ThLabel icon={Clock}>Tempo médio</ThLabel></th>
                </tr>
              </thead>
              <tbody>
                {atendentes.isError && (
                  <tr><td colSpan={6} className="at-vazio">{msgErro(atendentes.error, "Não foi possível carregar os atendentes.")}</td></tr>
                )}
                {!atendentes.isPending && !atendentes.isError && (atendentes.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="at-vazio">Nenhum atendente na equipe. Inclua em Fila e horários.</td></tr>
                )}
                {agrupar(atendentes.data ?? []).map(([setorNome, lista]) => (
                  <Fragment key={setorNome}>
                    {variosSetores && (
                      <tr className="at-grupo">
                        <td colSpan={6}>{setorNome}</td>
                      </tr>
                    )}
                    {lista.map((a) => (
                      <tr key={a.usuarioId}>
                        <td>{a.nome}</td>
                        <td className="c"><Dot estado={a.online ? "sim" : "nao"} rotulo={a.online ? "Online" : "Offline"} /></td>
                        <td className="c"><Dot estado={disponivel(a)} rotulo={{ sim: "Disponível", pausa: "Em pausa", nao: "Não disponível" }[disponivel(a)]} /></td>
                        <td className="n">{a.emAtendimento} / {a.limite}</td>
                        <td className="n">{a.atendidasHoje}</td>
                        <td className="n">{minutos(a.tempoMedioSeg)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="at-legenda">
            <span><i className="at-dot at-dot--sim" />Sim</span>
            <span><i className="at-dot at-dot--pausa" />Pausa</span>
            <span><i className="at-dot at-dot--nao" />Não</span>
            <span>Online = Central aberta. Disponível = apto, sem pausa, online e abaixo do limite do setor.</span>
          </div>
        </section>
      </div>

      <section className="card at-mon-sec" aria-labelledby={`${ids}-fila`}>
        <div className="at-mon-head">
          <h2 id={`${ids}-fila`}>Conversas aguardando atendimento <small>· {fila.length}</small></h2>
        </div>
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={ArrowUpDown}>Posição</ThLabel></th>
                <th><ThLabel icon={Ticket}>Ticket</ThLabel></th>
                {variosSetores && <th><ThLabel icon={Building2}>Setor</ThLabel></th>}
                <th><ThLabel icon={User}>Cliente</ThLabel></th>
                <th><ThLabel icon={Phone}>Telefone</ThLabel></th>
                <th><ThLabel icon={Inbox}>Número</ThLabel></th>
                <th><ThLabel icon={MessageSquare}>Última mensagem</ThLabel></th>
                <th><ThLabel icon={ListOrdered}>Entrou na fila</ThLabel></th>
                <th><ThLabel icon={Hourglass}>Tempo de espera</ThLabel></th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {conversas.isError && <tr><td colSpan={10} className="at-vazio">{msgErro(conversas.error, "Não foi possível carregar as conversas.")}</td></tr>}
              {!conversas.isPending && !conversas.isError && fila.length === 0 && <tr><td colSpan={10} className="at-vazio">Ninguém aguardando.</td></tr>}
              {fila.map((c, i) => {
                const espera = desde(c.filaDesde, agora);
                const alerta = espera > (setor(c.setorId)?.alertaFilaMin ?? 15) * 60_000;
                return (
                  <tr key={c.conversaId} className={alerta ? "at-alerta" : undefined}>
                    <td>{i + 1}º</td>
                    <td>{c.ticket ? `#${c.ticket}` : "—"}</td>
                    {variosSetores && <td><span className="at-tag">{c.setorNome}</span></td>}
                    <td><b>{c.nome ?? "—"}</b></td>
                    <td>{telefone(c.telefone)}</td>
                    <td>{telefone(c.numero)}</td>
                    <td>{c.ultimaPrevia ?? "—"}</td>
                    <td>{horaDe(c.filaDesde)}</td>
                    <td><span className={`at-tempo${alerta ? " at-tempo--alto" : ""}`}>{duracao(espera)}</span></td>
                    <td>
                      <button type="button" className="at-lnk" onClick={() => setVer(c.conversaId)}>Visualizar</button>
                      <button type="button" className="at-lnk" disabled={acao.isPending} onClick={() => atender(c.conversaId)}>Atender</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card at-mon-sec" aria-labelledby={`${ids}-at`}>
        <div className="at-mon-head">
          <h2 id={`${ids}-at`}>Conversas em atendimento <small>· {emAtendimento.length}</small></h2>
        </div>
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Ticket}>Ticket</ThLabel></th>
                {variosSetores && <th><ThLabel icon={Building2}>Setor</ThLabel></th>}
                <th><ThLabel icon={User}>Cliente</ThLabel></th>
                <th><ThLabel icon={Phone}>Telefone</ThLabel></th>
                <th><ThLabel icon={UserCheck}>Atendente</ThLabel></th>
                <th><ThLabel icon={CalendarPlus}>Início</ThLabel></th>
                <th><ThLabel icon={Clock}>Duração</ThLabel></th>
                <th><ThLabel icon={Hourglass}>Cliente esperando há</ThLabel></th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {!conversas.isPending && !conversas.isError && emAtendimento.length === 0 && <tr><td colSpan={9} className="at-vazio">Nenhuma conversa em atendimento.</td></tr>}
              {emAtendimento.map((c) => {
                const esperando = clienteEsperando(c);
                const espera = esperando ? desde(c.ultimaMsgClienteEm, agora) : 0;
                const alerta = esperando && espera > (setor(c.setorId)?.alertaClienteMin ?? 5) * 60_000;
                return (
                  <tr key={c.conversaId} className={alerta ? "at-alerta" : undefined}>
                    <td>{c.ticket ? `#${c.ticket}` : "—"}</td>
                    {variosSetores && <td><span className="at-tag">{c.setorNome}</span></td>}
                    <td><b>{c.nome ?? "—"}</b></td>
                    <td>{telefone(c.telefone)}</td>
                    <td>{c.atendenteNome ?? "—"}</td>
                    <td>{horaDe(c.atendenteDesde)}</td>
                    <td><span className="at-tempo">{duracao(desde(c.atendenteDesde, agora))}</span></td>
                    <td>{esperando ? <span className={`at-tempo${alerta ? " at-tempo--alto" : ""}`}>{duracao(espera)}</span> : "—"}</td>
                    <td>
                      <button type="button" className="at-lnk" onClick={() => setVer(c.conversaId)}>Visualizar</button>
                      <button type="button" className="at-lnk" onClick={() => onAbrir(c.conversaId)}>Abrir / transferir</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Visualizar conversaId={ver} ctx={ctx} onFechar={() => setVer(null)} onAtender={atender} atendendo={acao.isPending} />
    </div>
  );
}

function agrupar(lista: MonitorAtendente[]): [string, MonitorAtendente[]][] {
  const mapa = new Map<string, MonitorAtendente[]>();
  for (const a of lista) mapa.set(a.setorNome, [...(mapa.get(a.setorNome) ?? []), a]);
  return [...mapa.entries()];
}

function disponivel(a: MonitorAtendente): "sim" | "pausa" | "nao" {
  if (a.online && a.pausa) return "pausa";
  return a.online && a.apto && a.emAtendimento < a.limite ? "sim" : "nao";
}

function Dot({ estado, rotulo }: { estado: "sim" | "pausa" | "nao"; rotulo: string }) {
  return <i className={`at-dot at-dot--${estado}`} role="img" aria-label={rotulo} title={rotulo} />;
}

/** O cliente escreveu depois da última resposta do atendente. */
function clienteEsperando(c: MonitorConversa): boolean {
  if (!c.ultimaMsgClienteEm) return false;
  return !c.ultimaMsgAtendenteEm || c.ultimaMsgClienteEm > c.ultimaMsgAtendenteEm;
}

/** Gaveta "Visualizar": histórico só leitura; na fila, o botão Atender. */
function Visualizar({ conversaId, ctx, onFechar, onAtender, atendendo }: { conversaId: number | null; ctx: Contexto; onFechar: () => void; onAtender: (id: number) => void; atendendo: boolean }) {
  const conversas = useConversas();
  const c = (conversas.data ?? []).find((x) => x.id === conversaId) ?? null;
  return (
    <Dialog.Root open={conversaId !== null} onOpenChange={(aberto) => !aberto && onFechar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet at-gaveta" aria-describedby={undefined}>
          <Dialog.Title className="visually-hidden">Visualizar conversa</Dialog.Title>
          {c ? (
            <>
              <Chat c={c} eu={ctx.eu} setor={ctx.setores.find((s) => s.id === c.setorId)} somenteLeitura />
              <div className="at-gaveta__rod">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--outline">
                    <X size={15} aria-hidden="true" />
                    Fechar
                  </button>
                </Dialog.Close>
                {c.modo === "fila" && (
                  <button type="button" className="btn btn--primary" disabled={atendendo} onClick={() => onAtender(c.id)}>
                    <UserCheck size={15} aria-hidden="true" />
                    Atender
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="at-vazio">{conversas.isPending ? "Carregando…" : "Conversa não encontrada."}</p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
