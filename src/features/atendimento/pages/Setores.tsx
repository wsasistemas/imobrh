import * as Switch from "@radix-ui/react-switch";
import { Building2, CircleDot, Info, Phone, Plus, Ticket, UserCheck, Users, Wallet, X } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { Notice } from "../../configuracoes/components/Notice";
import { ServiceError } from "../../configuracoes/services/types";
import { AprovacaoFinanceira } from "../../financeiro/AprovacaoFinanceira";
import { useResumoSetoresFinanceiro } from "../../financeiro/hooks";
import type { ResumoSetor } from "../../financeiro/service";
import { useCandidatos, useContexto, useSalvarSetor } from "../hooks/useAtendimento";
import type { Pessoa, Setor } from "../services/tipos";
import { telefone } from "./util";
import "./Atendimento.css";


/** Gestão de Atendimento › Setores e números (supervisão geral). */
export function Setores() {
  const contexto = useContexto();
  const [editando, setEditando] = useState<number | "novo" | null>(null);
  const [aba, setAba] = useState<"atendimento" | "financeiro">("atendimento");
  // Coluna "Aprovação" (Solicitações Financeiras, 17/10/2026). Sem acesso ou com erro, a coluna mostra "—".
  const resumo = useResumoSetoresFinanceiro();
  if (contexto.isPending) return <PageSkeleton />;
  if (contexto.isError) return <ErrorState message="Não foi possível carregar os setores." onRetry={() => void contexto.refetch()} />;
  if (!contexto.data.supervisor) {
    return (
      <div className="card">
        <EmptyState icon={Building2} title="Só a supervisão geral" description="Setores e números são cadastrados por quem tem a permissão Supervisão geral do atendimento." />
      </div>
    );
  }
  const setores = contexto.data.setores;
  const atual = editando === "novo" ? null : (setores.find((s) => s.id === editando) ?? setores[0] ?? null);
  const modoNovo = editando === "novo" || setores.length === 0;

  return (
    <>
      <div className="at-setores">
        <section className="card at-mon-card" aria-label="Setores">
          <div className="at-mon-head">
            <h2>Setores</h2>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditando("novo")}>
              <Plus size={15} aria-hidden="true" />
              Novo setor
            </button>
          </div>
          <div className="at-tab-wrap">
            <table className="at-tab">
              <thead>
                <tr>
                  <th><ThLabel icon={Building2}>Setor</ThLabel></th>
                  <th><ThLabel icon={Phone}>Números WhatsApp</ThLabel></th>
                  <th><ThLabel icon={UserCheck}>Gestão</ThLabel></th>
                  <th className="n"><ThLabel icon={Users}>Atendentes</ThLabel></th>
                  <th><ThLabel icon={Ticket}>Receber chamado</ThLabel></th>
                  <th><ThLabel icon={Wallet}>Aprovação</ThLabel></th>
                  <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
                </tr>
              </thead>
              <tbody>
                {setores.length === 0 && (
                  <tr><td colSpan={7} className="at-vazio">Nenhum setor ainda. Cadastre o primeiro ao lado.</td></tr>
                )}
                {setores.map((s) => (
                  <tr
                    key={s.id}
                    className={!modoNovo && atual?.id === s.id ? "at-on" : undefined}
                    tabIndex={0}
                    onClick={() => setEditando(s.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setEditando(s.id))}
                  >
                    <td><b>{s.nome}</b></td>
                    <td>{s.numeros.length ? s.numeros.map((n) => <div key={n.id}>{telefone(n.numero)}</div>) : "—"}</td>
                    <td>{s.gestores.map((g) => g.nome).join(", ") || "—"}</td>
                    <td className="n">{s.atendentes.length}</td>
                    <td>{s.recebeChamados ? <span className="at-selo s-fim">Sim</span> : <span title="Só solicitante: identifica o setor de quem abre o chamado">—</span>}</td>
                    <td><SeloAprovacao resumo={resumo.data?.find((r) => r.setorId === s.id)} /></td>
                    <td><span className={`at-selo ${s.ativo ? "s-fim" : ""}`} style={s.ativo ? undefined : { background: "var(--neutral-bg)", color: "var(--neutral-fg)" }}>{s.ativo ? "Ativo" : "Inativo"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div>
          {/* Setor salvo: abas Atendimento (formulário de sempre) e Aprovação financeira (nova). Setor novo: só o formulário. */}
          {!modoNovo && atual && (
            <div className="sf-abas-setor" role="tablist" aria-label={`Configuração de ${atual.nome}`}>
              <button type="button" role="tab" aria-selected={aba === "atendimento"} onClick={() => setAba("atendimento")}>Atendimento</button>
              <button type="button" role="tab" aria-selected={aba === "financeiro"} onClick={() => setAba("financeiro")}>Aprovação financeira</button>
            </div>
          )}
          {!modoNovo && atual && aba === "financeiro" ? (
            <AprovacaoFinanceira setorId={atual.id} nome={atual.nome} />
          ) : (
            <FormSetor key={modoNovo ? "novo" : atual?.id} setor={modoNovo ? null : atual} onSalvo={(id) => setEditando(id)} onCancelar={() => setEditando(null)} />
          )}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <Notice icon={Info}>
          Cada número pertence a <b>um setor só</b>. A mensagem que chega num número entra na fila do setor dele, e a resposta sai pelo mesmo número. Não há
          transferência entre setores. O número precisa estar na conta Zenvia configurada em Configurações › Integrações › Zenvia WhatsApp.
        </Notice>
      </div>
    </>
  );
}

/** Coluna "Aprovação": conferência (setor financeiro), níveis configurados ou pendente. */
function SeloAprovacao({ resumo }: { resumo: ResumoSetor | undefined }) {
  if (!resumo) return <span>—</span>;
  if (resumo.financeiro) return <span className="at-selo s-info">Confere</span>;
  const n = resumo.niveisReembolso;
  if (n === 0) return <span className="at-selo s-fila" title="Sem aprovador de reembolso e fundo fixo">Pendente</span>;
  return <span className="at-selo s-fim" title={`Adiantamento: ${resumo.niveisAdiantamento} de 4 níveis`}>{n === 1 ? "1 nível" : `${n} níveis`}</span>;
}

function FormSetor({ setor, onSalvo, onCancelar }: { setor: Setor | null; onSalvo: (id: number) => void; onCancelar: () => void }) {
  const ids = useId();
  const salvar = useSalvarSetor();
  const candidatos = useCandidatos(true);
  const [nome, setNome] = useState(setor?.nome ?? "");
  const [ativo, setAtivo] = useState(setor?.ativo ?? true);
  const [recebe, setRecebe] = useState(setor?.recebeChamados ?? false);
  const [numeros, setNumeros] = useState<string[]>(() => (setor?.numeros.length ? setor.numeros.map((n) => telefone(n.numero)) : [""]));
  const [gestores, setGestores] = useState<Pessoa[]>(setor?.gestores ?? []);
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);

  useEffect(() => setErro(null), [setor?.id]);

  const verificacao = (n: string) => setor?.numeros.find((x) => x.numero === n)?.verificacao ?? null;
  const erroDe = (campo: string) => (erro?.campo === campo ? <span className="field__error" role="alert">{erro.mensagem}</span> : null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: setor?.id, nome, ativo, recebeChamados: recebe, numeros: numeros.map((n) => n.trim()).filter(Boolean), gestores: gestores.map((g) => g.id) },
      {
        onSuccess: (id) => {
          toast.success(setor ? "Setor salvo" : "Setor criado: agora monte a equipe em Fila e horários");
          onSalvo(id);
        },
        onError: (er) => {
          if (er instanceof ServiceError) setErro({ campo: er.field, mensagem: er.message });
          else toast.error("Não foi possível salvar o setor.");
        },
      },
    );
  };

  const disponiveis = (candidatos.data ?? []).filter((c) => !gestores.some((g) => g.id === c.id));

  return (
    <form className="card at-sec" onSubmit={enviar} aria-labelledby={`${ids}-t`}>
      <h2 id={`${ids}-t`}>{setor ? setor.nome : "Novo setor"}</h2>
      <div className="field">
        <label className="field__label" htmlFor={`${ids}-nome`}>Nome do setor</label>
        <input id={`${ids}-nome`} className="input" value={nome} maxLength={60} aria-invalid={erro?.campo === "nome" || undefined} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Financeiro" />
        {erroDe("nome")}
      </div>

      <div className="field">
        <span className="field__label" id={`${ids}-nums`}>Números WhatsApp (da conta Zenvia)</span>
        <div className="at-nums" role="group" aria-labelledby={`${ids}-nums`}>
          {numeros.map((n, i) => {
            const v = verificacao(n.replace(/\D/g, ""));
            return (
              <div key={i}>
                <input
                  className="input"
                  inputMode="tel"
                  placeholder="(21) 99999-0002"
                  value={n}
                  aria-label={`Número ${i + 1}`}
                  aria-invalid={erro?.campo === "numeros" || undefined}
                  onChange={(e) => setNumeros((ns) => ns.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {v && <span className={`at-selo ${v.naConta ? "s-fim" : "s-comigo"}`} title={v.erro ?? undefined}>{v.naConta ? "Na conta" : "Fora da conta"}</span>}
                <button type="button" className="icon-btn" aria-label={`Remover número ${i + 1}`} onClick={() => setNumeros((ns) => (ns.length > 1 ? ns.filter((_, j) => j !== i) : [""]))}>
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div>
          <button type="button" className="btn btn--outline btn--sm" style={{ marginTop: 6 }} onClick={() => setNumeros((ns) => [...ns, ""])}>
            <Plus size={14} aria-hidden="true" />
            Adicionar número
          </button>
        </div>
        {erroDe("numeros")}
        <span className="field__help">Com DDD (o 55 entra sozinho). Um número não pode estar em dois setores. Tirar um número daqui não apaga as conversas dele.</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${ids}-gest`}>Gestão do setor</label>
        {gestores.length > 0 && (
          <div className="at-marcas" style={{ marginBottom: 6 }}>
            {gestores.map((g) => (
              <span key={g.id} className="at-marca">
                {g.nome}
                <button type="button" aria-label={`Tirar ${g.nome} da gestão`} onClick={() => setGestores((gs) => gs.filter((x) => x.id !== g.id))}>
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <select
          id={`${ids}-gest`}
          className="input"
          value=""
          disabled={candidatos.isPending}
          onChange={(e) => {
            const p = disponiveis.find((c) => c.id === e.target.value);
            if (p) setGestores((gs) => [...gs, { id: p.id, nome: p.nome, email: p.email }]);
          }}
        >
          <option value="">{candidatos.isPending ? "Carregando…" : "Adicionar gestor…"}</option>
          {disponiveis.map((c) => (
            <option key={c.id} value={c.id}>{c.nome}</option>
          ))}
        </select>
        {erroDe("gestores")}
        <span className="field__help">O gestor precisa ter, no perfil, a permissão "Monitor e gestão do setor".</span>
      </div>

      <div className="zv-chave">
        <Switch.Root id={`${ids}-ativo`} className="switch" checked={ativo} onCheckedChange={setAtivo}>
          <Switch.Thumb className="switch__thumb" />
        </Switch.Root>
        <div>
          <label htmlFor={`${ids}-ativo`}><b>Setor ativo</b></label>
          <span>Inativo: o número continua gravando as mensagens, mas nada é respondido e a fila não distribui.</span>
        </div>
      </div>

      <div className="zv-chave">
        <Switch.Root id={`${ids}-recebe`} className="switch" checked={recebe} onCheckedChange={setRecebe} aria-invalid={erro?.campo === "recebeChamados" || undefined}>
          <Switch.Thumb className="switch__thumb" />
        </Switch.Root>
        <div>
          <label htmlFor={`${ids}-recebe`}><b>Receber chamado</b></label>
          <span>
            Marcado: o setor atende e aparece no App do solicitante como opção para abrir chamado. Desmarcado: sai do app e só identifica o setor de quem abre
            o chamado (campo Setor do ticket).
          </span>
        </div>
      </div>
      {erroDe("recebeChamados")}

      {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}
      <div className="at-rodape">
        {setor === null && (
          <button type="button" className="btn btn--outline" onClick={onCancelar}>Cancelar</button>
        )}
        <button type="submit" className="btn btn--primary" disabled={salvar.isPending || nome.trim().length < 2}>
          {salvar.isPending ? "Salvando…" : setor ? "Salvar setor" : "Criar setor"}
        </button>
      </div>
    </form>
  );
}
