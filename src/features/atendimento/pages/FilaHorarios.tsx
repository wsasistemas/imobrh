import * as Switch from "@radix-ui/react-switch";
import { Trash2, UserPlus, UsersRound } from "lucide-react";
import { useEffect, useId, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { useCandidatos, useContexto, useRemoverAtendente, useSalvarAtendente, useSalvarConfigSetor } from "../hooks/useAtendimento";
import type { AtendenteSetor, Horario, RegrasSetor, Setor } from "../services/tipos";
import { DIAS, gerencia, gravar, iniciais, ler, telefone } from "./util";
import "./Atendimento.css";

const msgErro = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);
const online = (a: AtendenteSetor) => !!a.onlineEm && Date.now() - new Date(a.onlineEm).getTime() < 3 * 60_000;

/** Gestão de Atendimento › Fila e horários (gestão do setor e supervisão geral). */
export function FilaHorarios() {
  const contexto = useContexto();
  const ids = useId();
  const [setorId, setSetorId] = useState<number | null>(() => Number(ler("fila-setor")) || null);
  if (contexto.isPending) return <PageSkeleton />;
  if (contexto.isError) return <ErrorState message="Não foi possível carregar os setores." onRetry={() => void contexto.refetch()} />;
  const meus = contexto.data.setores.filter(gerencia);
  if (meus.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={UsersRound}
          title="Nenhum setor sob sua gestão"
          description={contexto.data.supervisor ? "Cadastre o primeiro setor em Setores e números." : "A fila e os horários são configurados pela gestão de cada setor (definida em Setores e números)."}
        />
      </div>
    );
  }
  const setor = meus.find((s) => s.id === setorId) ?? meus[0]!;

  return (
    <div>
      <div className="at-barra">
        {meus.length > 1 ? (
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-setor`}>Setor</label>
            <select
              id={`${ids}-setor`}
              className="input"
              value={setor.id}
              onChange={(e) => {
                setSetorId(Number(e.target.value));
                gravar("fila-setor", e.target.value);
              }}
            >
              {meus.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </div>
        ) : null}
        <span className="at-setor-chip">
          {setor.nome}
          <small>· {setor.numeros.map((n) => telefone(n.numero)).join(", ") || "sem número"}</small>
        </span>
        <span className="field__help">Tudo nesta tela vale só para o setor escolhido.</span>
      </div>
      <ConfigSetor key={setor.id} setor={setor} />
    </div>
  );
}

function ConfigSetor({ setor }: { setor: Setor }) {
  const ids = useId();
  const salvarConfig = useSalvarConfigSetor();
  const [regras, setRegras] = useState<RegrasSetor>(() => regrasDe(setor));
  const [horas, setHoras] = useState<Horario[]>(() => setor.horarios.map((h) => ({ ...h })));
  const [erroCampo, setErroCampo] = useState<string | null>(null);

  useEffect(() => {
    setRegras(regrasDe(setor));
    setHoras(setor.horarios.map((h) => ({ ...h })));
  }, [setor]);

  const mudou = JSON.stringify(regras) !== JSON.stringify(regrasDe(setor)) || JSON.stringify(horas) !== JSON.stringify(setor.horarios);
  const num = (campo: keyof RegrasSetor) => (e: ChangeEvent<HTMLInputElement>) => setRegras((r) => ({ ...r, [campo]: Number(e.target.value) }));
  const txt = (campo: keyof RegrasSetor) => (e: ChangeEvent<HTMLTextAreaElement>) => setRegras((r) => ({ ...r, [campo]: e.target.value }));
  const hora = (dia: number, dados: Partial<Horario>) => setHoras((hs) => hs.map((h) => (h.dia === dia ? { ...h, ...dados } : h)));

  const salvar = () => {
    setErroCampo(null);
    salvarConfig.mutate(
      { setorId: setor.id, ...regras, horarios: horas },
      {
        onSuccess: () => toast.success(`Fila e horários de ${setor.nome} salvos`),
        onError: (e) => {
          if (e instanceof ServiceError && e.field) setErroCampo(e.message);
          else toast.error(msgErro(e, "Não foi possível salvar."));
        },
      },
    );
  };

  return (
    <>
      <div className="at-grade2">
        <div className="card at-sec">
          <Equipe setor={setor} />
          <h2 id={`${ids}-hor`} style={{ marginTop: 10 }}>Horário de atendimento</h2>
          <p className="at-sec__ajuda">Fora do horário, o cliente recebe o aviso do setor e a conversa espera na fila. Fuso de Brasília.</p>
          <table className="at-horas" aria-labelledby={`${ids}-hor`}>
            <tbody>
              {horas.map((h) => (
                <tr key={h.dia}>
                  <td>{DIAS[h.dia]}</td>
                  <td>
                    <Switch.Root className="switch" checked={h.aberto} onCheckedChange={(aberto) => hora(h.dia, { aberto })} aria-label={`${DIAS[h.dia]} aberto`}>
                      <Switch.Thumb className="switch__thumb" />
                    </Switch.Root>
                  </td>
                  {h.aberto ? (
                    <>
                      <td><input className="input input--sm" type="time" value={h.abre} aria-label={`${DIAS[h.dia]}: abre`} onChange={(e) => hora(h.dia, { abre: e.target.value })} /></td>
                      <td>às</td>
                      <td><input className="input input--sm" type="time" value={h.fecha} aria-label={`${DIAS[h.dia]}: fecha`} onChange={(e) => hora(h.dia, { fecha: e.target.value })} /></td>
                    </>
                  ) : (
                    <td colSpan={3}><span className="at-selo s-fim" style={{ background: "var(--neutral-bg)", color: "var(--neutral-fg)" }}>Fechado</span></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card at-sec">
          <h2>Mensagens automáticas do setor</h2>
          <p>Saem pelo número em que o cliente escreveu. São as únicas respostas automáticas (não há robô).</p>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-boas`}>Boas-vindas (1ª mensagem de uma conversa nova)</label>
            <textarea id={`${ids}-boas`} className="input" rows={3} maxLength={1000} value={regras.msgBoasVindas} onChange={txt("msgBoasVindas")} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-fora`}>Fora do horário</label>
            <textarea id={`${ids}-fora`} className="input" rows={3} maxLength={1000} value={regras.msgForaHorario} onChange={txt("msgForaHorario")} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-enc`}>Encerramento</label>
            <textarea id={`${ids}-enc`} className="input" rows={2} maxLength={1000} value={regras.msgEncerramento} onChange={txt("msgEncerramento")} />
          </div>

          <h2 style={{ marginTop: 10 }}>Regras da fila do setor</h2>
          <div>
            <div className="at-regra">
              <span className="at-regra__num">1</span>
              <div><b>Limite por atendente</b><span>Até <span className="at-inl"><input className="input" type="number" min={1} max={50} value={regras.limiteSimultaneo} aria-label="Limite de conversas por atendente" onChange={num("limiteSimultaneo")} /></span> conversas ao mesmo tempo. Acima disso, fica "não disponível".</span></div>
            </div>
            <div className="at-regra">
              <span className="at-regra__num">2</span>
              <div><b>Atendente sem responder</b><span>Depois de <span className="at-inl"><input className="input" type="number" min={5} max={1440} value={regras.atendenteSemRespostaMin} aria-label="Minutos sem resposta do atendente" onChange={num("atendenteSemRespostaMin")} /> min</span>, a conversa volta para a fila do setor.</span></div>
            </div>
            <div className="at-regra">
              <span className="at-regra__num">3</span>
              <div><b>Cliente sem responder</b><span>Depois de <span className="at-inl"><input className="input" type="number" min={1} max={23} value={regras.encerrarAposHoras} aria-label="Horas sem resposta do cliente" onChange={num("encerrarAposHoras")} /> h</span>, a conversa é encerrada com a mensagem de encerramento (máximo 23 h: depois de 24 h a Meta só aceita modelo aprovado).</span></div>
            </div>
            <div className="at-regra">
              <span className="at-regra__num">4</span>
              <div><b>Alertas do Monitor</b><span>Fila acima de <span className="at-inl"><input className="input" type="number" min={1} max={240} value={regras.alertaFilaMin} aria-label="Alerta de fila em minutos" onChange={num("alertaFilaMin")} /> min</span> · cliente esperando resposta acima de <span className="at-inl"><input className="input" type="number" min={1} max={240} value={regras.alertaClienteMin} aria-label="Alerta de cliente esperando em minutos" onChange={num("alertaClienteMin")} /> min</span>.</span></div>
            </div>
          </div>
        </div>
      </div>
      {erroCampo && <p className="field__error" role="alert" style={{ marginTop: 12 }}>{erroCampo}</p>}
      <div className="at-rodape" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn--outline" disabled={!mudou || salvarConfig.isPending} onClick={() => { setRegras(regrasDe(setor)); setHoras(setor.horarios.map((h) => ({ ...h }))); }}>
          Descartar
        </button>
        <button type="button" className="btn btn--primary" disabled={!mudou || salvarConfig.isPending} onClick={salvar}>
          {salvarConfig.isPending ? "Salvando…" : "Salvar fila e horários"}
        </button>
      </div>
    </>
  );
}

function regrasDe(s: Setor): RegrasSetor {
  return {
    msgBoasVindas: s.msgBoasVindas,
    msgForaHorario: s.msgForaHorario,
    msgEncerramento: s.msgEncerramento,
    limiteSimultaneo: s.limiteSimultaneo,
    atendenteSemRespostaMin: s.atendenteSemRespostaMin,
    encerrarAposHoras: s.encerrarAposHoras,
    alertaFilaMin: s.alertaFilaMin,
    alertaClienteMin: s.alertaClienteMin,
  };
}

function Equipe({ setor }: { setor: Setor }) {
  const ids = useId();
  const [incluindo, setIncluindo] = useState(false);
  const [escolhido, setEscolhido] = useState("");
  const [remover, setRemover] = useState<AtendenteSetor | null>(null);
  const candidatos = useCandidatos(incluindo);
  const salvar = useSalvarAtendente();
  const tirar = useRemoverAtendente();
  const naEquipe = new Set(setor.atendentes.map((a) => a.id));
  const opcoes = (candidatos.data ?? []).filter((c) => !naEquipe.has(c.id));
  const outroSetor = opcoes.find((c) => c.id === escolhido)?.setorAtendente ?? null;

  const incluir = () =>
    salvar.mutate(
      { usuarioId: escolhido, setorId: setor.id },
      { onSuccess: () => { toast.success("Atendente incluído na equipe"); setEscolhido(""); setIncluindo(false); }, onError: (e) => toast.error(msgErro(e, "Não foi possível incluir.")) },
    );

  return (
    <>
      <h2>Equipe do setor</h2>
      <p className="at-sec__ajuda">Recebe a fila do setor por rodízio entre os aptos e online. Cada atendente pertence a um setor só. Desligue "Apto" na folga.</p>
      {setor.gestores.map((g) => (
        <div key={g.id} className="at-pessoa">
          <span className="at-av" aria-hidden="true">{iniciais(g.nome)}</span>
          <div><b>{g.nome}</b><small>Gestão do setor · vê o Monitor e configura esta tela</small></div>
        </div>
      ))}
      {setor.atendentes.length === 0 && <p className="at-vazio">Nenhum atendente ainda.</p>}
      {setor.atendentes.map((a) => (
        <div key={a.id} className="at-pessoa">
          <span className="at-av" aria-hidden="true">{iniciais(a.nome)}</span>
          <div><b>{a.nome}</b><small>{a.email}</small></div>
          <div className="at-pessoa__dir">
            <span className={`at-selo ${online(a) ? (a.pausa ? "s-fila" : "s-fim") : ""}`} style={online(a) ? undefined : { background: "var(--neutral-bg)", color: "var(--neutral-fg)" }}>
              {online(a) ? (a.pausa ? "Pausa" : "Online") : "Offline"}
            </span>
            <Switch.Root
              className="switch"
              checked={a.apto}
              disabled={salvar.isPending}
              aria-label={`${a.nome} apto`}
              onCheckedChange={(apto) => salvar.mutate({ usuarioId: a.id, setorId: setor.id, apto }, { onSuccess: () => toast.success(apto ? `${a.nome} apto` : `${a.nome} de folga`), onError: (e) => toast.error(msgErro(e, "Não foi possível salvar.")) })}
            >
              <Switch.Thumb className="switch__thumb" />
            </Switch.Root>
            <span>Apto</span>
            <button type="button" className="icon-btn" title="Tirar da equipe" aria-label={`Tirar ${a.nome} da equipe`} onClick={() => setRemover(a)}>
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
      {incluindo ? (
        <div className="zv-inline">
          <label className="visually-hidden" htmlFor={`${ids}-novo`}>Usuário do portal</label>
          <select id={`${ids}-novo`} className="input" value={escolhido} onChange={(e) => setEscolhido(e.target.value)} disabled={candidatos.isPending}>
            <option value="">{candidatos.isPending ? "Carregando…" : "Escolha um usuário do portal…"}</option>
            {opcoes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
                {c.setorAtendente ? " (já em outro setor)" : ""}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--primary btn--sm" disabled={!escolhido || salvar.isPending} onClick={incluir}>Incluir</button>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setIncluindo(false)}>Cancelar</button>
          {outroSetor && <p className="field__help" style={{ width: "100%" }}>Essa pessoa já é atendente de outro setor. Só a supervisão geral pode mudá-la de setor.</p>}
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setIncluindo(true)}>
            <UserPlus size={15} aria-hidden="true" />
            Adicionar atendente
          </button>
        </div>
      )}
      <ConfirmDialog
        open={remover !== null}
        onOpenChange={(o) => !o && setRemover(null)}
        title="Tirar da equipe?"
        description={`${remover?.nome ?? ""} deixa de receber as conversas de ${setor.nome}. As conversas que estão com ela continuam no histórico.`}
        confirmLabel="Tirar da equipe"
        tone="danger"
        isPending={tirar.isPending}
        onConfirm={() => remover && tirar.mutate(remover.id, { onSuccess: () => { toast.success("Atendente removido da equipe"); setRemover(null); }, onError: (e) => { toast.error(msgErro(e, "Não foi possível remover.")); setRemover(null); } })}
      />
    </>
  );
}
