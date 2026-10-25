import { CircleDot, Clock, Hash, Tags, Timer, User, UserCheck, Wallet, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { IconeIlustrativo } from "../../../components/ds/IconeColorido";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { moeda } from "../cadeia";
import { StatusChip } from "../components/StatusChip";
import { useDefinirSubstituto, useFilaAprovacao, useRemoverSubstituto } from "../hooks";
import type { AbaAprovacao, FilaAprovacao, LinhaAprovacao } from "../solicitacoes";
import { dataBR, NOME_TIPO } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 5 — Aprovações (/financeiro/aprovacoes): abas Aguardando mim, Aprovadas por mim e Todas do setor; etapa N de M,
// tempo com o aprovador, chip de prazo e substituto por período.

const ABAS: { id: AbaAprovacao; rotulo: string }[] = [
  { id: "aguardando", rotulo: "Aguardando mim" },
  { id: "aprovadas", rotulo: "Aprovadas por mim" },
  { id: "setor", rotulo: "Todas do setor" },
];

export function Aprovacoes() {
  const [aba, setAba] = useState<AbaAprovacao>("aguardando");
  const [substituto, setSubstituto] = useState(false);
  const q = useFilaAprovacao(aba);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar as aprovações." onRetry={() => void q.refetch()} />;
  const f = q.data;

  return (
    <>
      <div className="sf-ph">
        <div>
          <h2 className="sf-ph__t">Aprovações</h2>
          <p className="sf-ph__s">Faltando 25% do prazo da etapa, você recebe um lembrete; vencido, a etapa vai para o substituto.</p>
        </div>
        {f.ehAprovador && (
          <div className="sf-ph__acoes">
            <button type="button" className="btn btn--outline" aria-expanded={substituto} onClick={() => setSubstituto((v) => !v)}>
              <UserCheck size={16} aria-hidden="true" />
              Definir substituto
            </button>
          </div>
        )}
      </div>

      {substituto && <Substituto f={f} />}

      <div className="sf-abas-setor" role="tablist" aria-label="Aprovações">
        {ABAS.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={aba === a.id} onClick={() => setAba(a.id)}>
            {a.rotulo}
            {a.id === "aguardando" && f.contagem > 0 && <span className="sf-contador">{f.contagem}</span>}
          </button>
        ))}
      </div>

      <div className="card sf-tabela">
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Hash}>Número</ThLabel></th>
                <th><ThLabel icon={User}>Solicitante</ThLabel></th>
                <th><ThLabel icon={Tags}>Tipo</ThLabel></th>
                <th className="n"><ThLabel icon={Wallet}>Valor</ThLabel></th>
                <th>Etapa</th>
                <th><ThLabel icon={Clock}>Com você há</ThLabel></th>
                <th><ThLabel icon={Timer}>Prazo</ThLabel></th>
                <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
                <th><span className="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody>
              {f.lista.map((l) => <Linha key={l.id} l={l} aba={aba} />)}
              {f.lista.length === 0 && (
                <tr>
                  <td colSpan={9} className="at-vazio">
                    <span className="sf-vazio">
                      <IconeIlustrativo icon={UserCheck} size={28} />
                      {aba === "aguardando" ? "Nada aguardando a sua aprovação." : "Nenhuma solicitação nesta aba."}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function horas(ms: number): string {
  const h = Math.max(0, Math.round(ms / 3_600_000));
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

function Prazo({ l }: { l: LinhaAprovacao }) {
  if (!l.prazoEm) return <span>—</span>;
  const resta = new Date(l.prazoEm).getTime() - Date.now();
  if (resta < 0) return <span className="sf-chip sf-chip--erro">{l.escaladoEm ? "Vencido · escalado" : "Vencido"}</span>;
  return <span className="sf-chip sf-chip--aviso">Vence em {horas(resta)}</span>;
}

function Linha({ l, aba }: { l: LinhaAprovacao; aba: AbaAprovacao }) {
  return (
    <tr>
      <td><Link className="sf-link" to={`/financeiro/solicitacoes/${l.id}`}>{l.numero}</Link></td>
      <td>
        {l.solicitante}
        {l.setor && <span className="sf-sub">{l.setor}</span>}
      </td>
      <td>{NOME_TIPO[l.tipo]}</td>
      <td className="n">{moeda(l.valor)}</td>
      <td>
        {l.nivel ? `${l.papel} · ${l.nivel} de ${l.de}` : "—"}
        {l.substitutoDe && <span className="sf-sub">substituindo {l.substitutoDe}</span>}
      </td>
      <td>{aba === "aguardando" && l.desde ? horas(Date.now() - new Date(l.desde).getTime()) : "—"}</td>
      <td>{aba === "aguardando" ? <Prazo l={l} /> : l.decididoEm ? dataBR(l.decididoEm) : "—"}</td>
      <td>
        <StatusChip status={l.status} />
        {l.alertas > 0 && <span className="sf-sub">{l.alertas} alerta{l.alertas > 1 ? "s" : ""} nas checagens</span>}
      </td>
      <td><Link className="btn btn--outline btn--sm" to={`/financeiro/solicitacoes/${l.id}`}>Abrir</Link></td>
    </tr>
  );
}

function Substituto({ f }: { f: FilaAprovacao }) {
  const ids = useId();
  const definir = useDefinirSubstituto();
  const remover = useRemoverSubstituto();
  const hoje = new Date().toISOString().slice(0, 10);
  const [quem, setQuem] = useState("");
  const [de, setDe] = useState(hoje);
  const [ate, setAte] = useState(hoje);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    definir.mutate(
      { substitutoId: quem, de, ate },
      { onSuccess: () => { toast.success("Substituto definido"); setQuem(""); }, onError: (er) => setErro(er instanceof ServiceError ? er.message : "Não foi possível salvar.") },
    );
  };

  return (
    <form className="card sf-painel sf-substituto" onSubmit={enviar} aria-labelledby={`${ids}-t`}>
      <h3 id={`${ids}-t`}>Substituto por período</h3>
      <div className="sf-campos">
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-q`}>Substituto</label>
          <select id={`${ids}-q`} className="input" value={quem} onChange={(e) => setQuem(e.target.value)}>
            <option value="">Escolha…</option>
            {f.usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-de`}>De</label>
          <input id={`${ids}-de`} className="input" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-ate`}>Até</label>
          <input id={`${ids}-ate`} className="input" type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
        </div>
        <div className="field sf-substituto__acao">
          <button type="submit" className="btn btn--primary" disabled={definir.isPending}>Salvar</button>
        </div>
      </div>
      {erro && <p className="field__error" role="alert">{erro}</p>}
      <p className="field__help">No período, o substituto vê e decide as etapas que seriam suas.</p>
      {f.substituicoes.length > 0 && (
        <ul className="sf-substituicoes">
          {f.substituicoes.map((s) => (
            <li key={s.id}>
              {s.substituto} · {dataBR(s.de)} a {dataBR(s.ate)}
              <button type="button" className="icon-btn" aria-label={`Remover substituição de ${s.substituto}`} disabled={remover.isPending}
                onClick={() => remover.mutate(s.id, { onError: (er) => toast.error(er instanceof ServiceError ? er.message : "Não foi possível remover.") })}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
