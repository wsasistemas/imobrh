import * as Switch from "@radix-ui/react-switch";
import { Plus, Trash2, Users } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../components/PageSkeleton";
import { ErrorState } from "../configuracoes/components/ErrorState";
import { Notice } from "../configuracoes/components/Notice";
import { ServiceError } from "../configuracoes/services/types";
import { CadeiaPrevia } from "./components/CadeiaPrevia";
import { useSalvarSetorFinanceiro, useSetorFinanceiro, useUsuariosFinanceiro } from "./hooks";
import { validarConfig, type ConfigSetorFinanceiro, type NivelAdiantamento, type Opcao, type SetorFinanceiro } from "./service";
import "./financeiro.css";

// Setores e números › aba "Aprovação financeira" (decisão do Wagner, 17/10/2026; CONTEXTO.md 9.2).
// Quem é do setor (cadastro de Pessoas) segue esta cadeia ao pedir reembolso, fundo fixo ou adiantamento.

const NOME_PAPEL: Record<NivelAdiantamento["papel"], string> = { planejamento: "Planejamento", gerente: "Gerente", diretor: "Diretor", presidente: "Presidente" };
const QUANDO: Record<NivelAdiantamento["papel"], string> = { planejamento: "Só setor de obra", gerente: "Sempre", diretor: "", presidente: "" };

export function AprovacaoFinanceira({ setorId, nome }: { setorId: number; nome?: string }) {
  const setor = useSetorFinanceiro(setorId);
  const usuarios = useUsuariosFinanceiro();
  if (setor.isPending || usuarios.isPending) return <PageSkeleton />;
  if (setor.isError || usuarios.isError) return <ErrorState message="Não foi possível carregar a aprovação financeira." onRetry={() => void setor.refetch()} />;
  return <FormAprovacao key={setorId} setor={nome ? { ...setor.data, setor: nome } : setor.data} usuarios={usuarios.data} />;
}

/** Sem cadeia salva: sugere a Gestão do setor como Gestor (reembolso) e Gerente (adiantamento). Aprovado em 17/10/2026. */
function comSugestao(s: SetorFinanceiro): ConfigSetorFinanceiro {
  const { setor: _nome, podeEditar: _pode, pessoas: _p, gestores, ...config } = s;
  const gestor = gestores[0]?.id ?? null;
  return {
    ...config,
    reembolso: config.reembolso.length || !gestor ? config.reembolso : [{ papel: "Gestor", aprovadorId: gestor, substitutoId: null, alcadaMinima: 0 }],
    adiantamento: config.adiantamento.map((n) => (n.papel === "gerente" && !n.aprovadorId && gestor ? { ...n, aprovadorId: gestor } : n)),
  };
}

function FormAprovacao({ setor, usuarios }: { setor: SetorFinanceiro; usuarios: Opcao[] }) {
  const ids = useId();
  const salvar = useSalvarSetorFinanceiro();
  const [c, setC] = useState<ConfigSetorFinanceiro>(() => comSugestao(setor));
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  const sugerido = setor.reembolso.length === 0 && c.reembolso.length > 0;
  const ro = !setor.podeEditar;

  useEffect(() => setErro(null), [setor.setorId]);

  const muda = <K extends keyof ConfigSetorFinanceiro>(k: K, v: ConfigSetorFinanceiro[K]) => setC((x) => ({ ...x, [k]: v }));
  const mudaReembolso = (i: number, p: Partial<ConfigSetorFinanceiro["reembolso"][number]>) =>
    setC((x) => ({ ...x, reembolso: x.reembolso.map((n, j) => (j === i ? { ...n, ...p } : n)) }));
  const mudaAdiant = (papel: NivelAdiantamento["papel"], p: Partial<NivelAdiantamento>) =>
    setC((x) => ({ ...x, adiantamento: x.adiantamento.map((n) => (n.papel === papel ? { ...n, ...p } : n)) }));
  const erroDe = (campo: string) => (erro?.campo === campo ? <span className="field__error" role="alert">{erro.mensagem}</span> : null);
  const nomeDe = (id: string | null) => usuarios.find((u) => u.id === id)?.nome ?? null;

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const invalido = validarConfig(c);
    if (invalido) return setErro({ campo: invalido.field, mensagem: invalido.message });
    setErro(null);
    salvar.mutate(c, {
      onSuccess: () => toast.success("Aprovação financeira salva"),
      onError: (er) => {
        if (er instanceof ServiceError) setErro({ campo: er.field, mensagem: er.message });
        else toast.error("Não foi possível salvar a aprovação financeira.");
      },
    });
  };

  const opcoes = (vazio: string) => (
    <>
      <option value="">{vazio}</option>
      {usuarios.map((u) => (
        <option key={u.id} value={u.id}>{u.nome}</option>
      ))}
    </>
  );

  return (
    <form className="card at-sec sf-aba" onSubmit={enviar} aria-labelledby={`${ids}-t`}>
      <h2 id={`${ids}-t`}>{setor.setor}</h2>
      <Notice icon={Users}>
        <b>Vale para {setor.pessoas} {setor.pessoas === 1 ? "pessoa" : "pessoas"} deste setor.</b> O setor da pessoa (cadastro de Pessoas) define quem aprova o
        reembolso, o fundo fixo e o adiantamento dela.
      </Notice>
      {ro && <p className="field__help">Só Admin e Super admin alteram a aprovação financeira.</p>}

      <fieldset className="sf-aba__grupo" disabled={ro}>
        <div className="zv-chave">
          <Switch.Root id={`${ids}-obra`} className="switch" checked={c.obra} onCheckedChange={(v) => muda("obra", v)}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <label htmlFor={`${ids}-obra`}><b>Setor de obra</b></label>
            <span>Adiantamentos deste setor passam pelo Planejamento (nível 1).</span>
          </div>
        </div>
        <div className="zv-chave">
          <Switch.Root id={`${ids}-fin`} className="switch" checked={c.financeiro} onCheckedChange={(v) => muda("financeiro", v)}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <label htmlFor={`${ids}-fin`}><b>Setor financeiro</b></label>
            <span>Recebe a conferência das solicitações aprovadas de todos os setores (fila do Financeiro).</span>
          </div>
        </div>

        <div className="sf-grade">
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-modo`}>Modo de aprovação</label>
            <select id={`${ids}-modo`} className="input" value={c.modoAprovacao} onChange={(e) => muda("modoAprovacao", e.target.value as ConfigSetorFinanceiro["modoAprovacao"])}>
              <option value="sequencial">Sequencial</option>
              <option value="paralelo">Paralelo</option>
              <option value="qualquer_um">Qualquer um</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-prazo`}>Prazo por etapa (horas)</label>
            <input id={`${ids}-prazo`} className="input" type="number" min={1} max={720} value={c.prazoHoras} aria-invalid={erro?.campo === "prazoHoras" || undefined}
              onChange={(e) => muda("prazoHoras", Number(e.target.value))} />
            {erroDe("prazoHoras")}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-venc`}>Ao vencer o prazo</label>
            <select id={`${ids}-venc`} className="input" value={c.acaoPrazoVencido} onChange={(e) => muda("acaoPrazoVencido", e.target.value as ConfigSetorFinanceiro["acaoPrazoVencido"])}>
              <option value="escalar">Escalar ao substituto</option>
              <option value="lembrar">Só lembrar</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-cc`}>Centro de custo padrão</label>
            <input id={`${ids}-cc`} className="input" maxLength={60} value={c.centroCustoPadrao ?? ""} placeholder="Ex.: 00.00114"
              onChange={(e) => muda("centroCustoPadrao", e.target.value || null)} />
          </div>
        </div>

        <h3 className="sf-aba__titulo">Reembolso e fundo fixo</h3>
        {sugerido && <p className="field__help">Sugestão: a Gestão do setor como Gestor. Confira e salve.</p>}
        <ol className="sf-niveis">
          {c.reembolso.map((n, i) => (
            <li key={i}>
              <span className="sf-niveis__n">{i + 1}</span>
              <div className="sf-niveis__campos">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-r${i}-p`}>Papel</label>
                  <input id={`${ids}-r${i}-p`} className="input" maxLength={40} value={n.papel} onChange={(e) => mudaReembolso(i, { papel: e.target.value })} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-r${i}-a`}>Aprovador</label>
                  <select id={`${ids}-r${i}-a`} className="input" value={n.aprovadorId} onChange={(e) => mudaReembolso(i, { aprovadorId: e.target.value })}>
                    {opcoes("Escolha…")}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-r${i}-v`}>Alçada mínima (R$)</label>
                  <input id={`${ids}-r${i}-v`} className="input sf-num" type="number" min={0} step="0.01" value={n.alcadaMinima}
                    onChange={(e) => mudaReembolso(i, { alcadaMinima: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-r${i}-s`}>Substituto</label>
                  <select id={`${ids}-r${i}-s`} className="input" value={n.substitutoId ?? ""} onChange={(e) => mudaReembolso(i, { substitutoId: e.target.value || null })}>
                    {opcoes("—")}
                  </select>
                </div>
              </div>
              <button type="button" className="icon-btn" aria-label={`Remover nível ${i + 1}`} onClick={() => setC((x) => ({ ...x, reembolso: x.reembolso.filter((_, j) => j !== i) }))}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
        <div>
          <button type="button" className="btn btn--outline btn--sm"
            onClick={() => setC((x) => ({ ...x, reembolso: [...x.reembolso, { papel: x.reembolso.length ? "Diretor" : "Gestor", aprovadorId: "", substitutoId: null, alcadaMinima: 0 }] }))}>
            <Plus size={14} aria-hidden="true" />
            Adicionar nível
          </button>
        </div>
        {erroDe("reembolso")}
        <span className="field__help">O aprovador entra quando o total da solicitação é maior ou igual à alçada mínima dele. Se o solicitante for o aprovador, a etapa dele é pulada.</span>

        <h3 className="sf-aba__titulo">Adiantamento de numerário <small>sempre sequencial · 4 níveis</small></h3>
        <ol className="sf-niveis">
          {c.adiantamento.map((n, i) => (
            <li key={n.papel}>
              <span className="sf-niveis__n">{i + 1}</span>
              <div className="sf-niveis__campos">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-a${i}-a`}>{NOME_PAPEL[n.papel]}</label>
                  <select id={`${ids}-a${i}-a`} className="input" value={n.aprovadorId ?? ""} onChange={(e) => mudaAdiant(n.papel, { aprovadorId: e.target.value || null })}>
                    {opcoes("Não configurado")}
                  </select>
                </div>
                {n.papel === "diretor" || n.papel === "presidente" ? (
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-a${i}-v`}>Quando o valor passar de (R$)</label>
                    <input id={`${ids}-a${i}-v`} className="input sf-num" type="number" min={0} step="0.01" value={n.alcadaMinima ?? ""} placeholder="Alçada"
                      onChange={(e) => mudaAdiant(n.papel, { alcadaMinima: e.target.value === "" ? null : Number(e.target.value) })} />
                  </div>
                ) : (
                  <div className="field">
                    <span className="field__label">Quando</span>
                    <span className="sf-ro">{QUANDO[n.papel]}</span>
                  </div>
                )}
                <div className="field sf-niveis__largo">
                  <label className="field__label" htmlFor={`${ids}-a${i}-s`}>Substituto</label>
                  <select id={`${ids}-a${i}-s`} className="input" value={n.substitutoId ?? ""} onChange={(e) => mudaAdiant(n.papel, { substitutoId: e.target.value || null })}>
                    {opcoes("—")}
                  </select>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {erroDe("adiantamento")}

        <div className="sf-grade">
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-pc`}>Prazo de comprovação (dias após o vencimento)</label>
            <input id={`${ids}-pc`} className="input" type="number" min={1} max={365} value={c.prazoComprovacaoDias} aria-invalid={erro?.campo === "prazoComprovacaoDias" || undefined}
              onChange={(e) => muda("prazoComprovacaoDias", Number(e.target.value))} />
            {erroDe("prazoComprovacaoDias")}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-ac`}>Ao vencer a comprovação</label>
            <select id={`${ids}-ac`} className="input" value={c.acaoComprovacaoVencida} onChange={(e) => muda("acaoComprovacaoVencida", e.target.value as ConfigSetorFinanceiro["acaoComprovacaoVencida"])}>
              <option value="avisar_bloquear">Avisar gestor e bloquear novos</option>
              <option value="avisar">Só avisar o gestor</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-lim`}>Adiantamentos em aberto por pessoa</label>
            <input id={`${ids}-lim`} className="input" type="number" min={1} max={99} value={c.limiteAdiantamentosAbertos ?? ""} placeholder="Sem limite"
              aria-invalid={erro?.campo === "limiteAdiantamentosAbertos" || undefined}
              onChange={(e) => muda("limiteAdiantamentosAbertos", e.target.value === "" ? null : Number(e.target.value))} />
            {erroDe("limiteAdiantamentosAbertos")}
          </div>
        </div>
      </fieldset>

      <h3 className="sf-aba__titulo">Prévia: quem aprovaria</h3>
      <CadeiaPrevia config={c} nomeDe={nomeDe} />
      <span className="field__help">Mudanças aqui não afetam solicitações já enviadas: a cadeia é congelada no envio.</span>

      {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}
      {!ro && (
        <div className="at-rodape">
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>
            {salvar.isPending ? "Salvando…" : "Salvar aprovação financeira"}
          </button>
        </div>
      )}
    </form>
  );
}
