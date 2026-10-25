import * as Switch from "@radix-ui/react-switch";
import { Building2, CheckCircle2, CircleAlert, KeyRound, Link2, Phone, RefreshCw, Send } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { formatDateTime } from "../../../utils/dates";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { StatusBadge } from "../../configuracoes/components/StatusBadge";
import { ServiceError } from "../../configuracoes/services/types";
import { useAssinarZenvia, useConexaoZenvia, useEnviarTeste, useSalvarConexao, useSalvarToken, useTestarZenvia } from "../hooks/useAtendimento";
import type { ConexaoZenvia, SalvarConexao } from "../services/tipos";
import { telefone } from "./util";
import "./Atendimento.css";

const msgErro = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);

/** Configurações › Integrações › Zenvia WhatsApp (super admin): uma conta para os números de todos os setores. */
export function IntegracaoZenvia() {
  const conexao = useConexaoZenvia();
  if (conexao.isPending) return <PageSkeleton />;
  if (conexao.isError) return <ErrorState message={msgErro(conexao.error, "Não foi possível carregar a conexão da Zenvia.")} onRetry={() => void conexao.refetch()} />;
  return <Tela c={conexao.data} />;
}

function Passo({ ok, titulo, children, direita }: { ok: boolean | null; titulo: string; children: ReactNode; direita?: ReactNode }) {
  return (
    <div className="zv-passo">
      <span className={`zv-passo__ic zv-passo__ic--${ok === null ? "neutro" : ok ? "ok" : "pend"}`} aria-hidden="true">
        {ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
      </span>
      <div className="zv-passo__txt">
        <b>{titulo}</b>
        <span>{children}</span>
      </div>
      {direita && <div>{direita}</div>}
    </div>
  );
}

function Tela({ c }: { c: ConexaoZenvia }) {
  const ids = useId();
  const salvar = useSalvarConexao();
  const salvarToken = useSalvarToken();
  const testar = useTestarZenvia();
  const assinar = useAssinarZenvia();
  const enviar = useEnviarTeste();
  const [token, setToken] = useState("");
  const [erroToken, setErroToken] = useState<string | null>(null);
  const [telefones, setTelefones] = useState(c.telefonesPiloto.map(telefone).join("\n"));
  const [teste, setTeste] = useState(c.telefonesPiloto[0] ? telefone(c.telefonesPiloto[0]) : "");
  const [numeroTeste, setNumeroTeste] = useState<number | "">(c.numeros[0]?.id ?? "");
  const v = c.verificacao;

  useEffect(() => setTelefones(c.telefonesPiloto.map(telefone).join("\n")), [c.telefonesPiloto]);

  const salvarParcial = (dados: SalvarConexao, ok: string) =>
    salvar.mutate(dados, { onSuccess: () => toast.success(ok), onError: (e) => toast.error(msgErro(e, "Não foi possível salvar.")) });

  return (
    <div className="at-grade2">
      <section className="card at-sec" aria-labelledby={`${ids}-con`}>
        <div className="at-mon-head" style={{ padding: 0, border: 0 }}>
          <div style={{ flex: 1 }}>
            <h2 id={`${ids}-con`}>Conta Zenvia WhatsApp</h2>
            <p className="at-sec__ajuda">Um token para todos os números dos setores. Ele fica no cofre do Supabase e nunca chega ao navegador.</p>
          </div>
          <button
            type="button"
            className="btn btn--outline"
            disabled={testar.isPending || !c.tokenMascara}
            onClick={() => testar.mutate(undefined, { onSuccess: () => toast.success("Conexão e números verificados"), onError: (e) => toast.error(msgErro(e, "Falha ao testar.")) })}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {testar.isPending ? "Testando…" : "Testar conexão e números"}
          </button>
        </div>
        {v && <p className="field__help">Última verificação: {formatDateTime(v.em)}</p>}

        <div className="zv-passos">
          <Passo ok={c.tokenMascara ? (v ? v.tokenOk : null) : false} titulo="Token da API">
            {c.tokenMascara ? <>Guardado no cofre ({c.tokenMascara}){c.tokenDefinidoEm ? ` · ${formatDateTime(c.tokenDefinidoEm)}` : ""}.</> : "Ainda não informado."}
            {v?.erroToken && <em className="zv-erro">{v.erroToken}</em>}
          </Passo>
          <form
            className="zv-inline"
            onSubmit={(e) => {
              e.preventDefault();
              setErroToken(null);
              salvarToken.mutate(token.trim(), {
                onSuccess: () => {
                  setToken("");
                  toast.success("Token salvo no cofre");
                },
                onError: (er) => (er instanceof ServiceError && er.field ? setErroToken(er.message) : toast.error(msgErro(er, "Não foi possível salvar o token."))),
              });
            }}
          >
            <label className="visually-hidden" htmlFor={`${ids}-tk`}>Token da API Zenvia</label>
            <input id={`${ids}-tk`} className="input" type="password" autoComplete="off" placeholder={c.tokenMascara ? "Novo token (substitui o atual)" : "Cole o token da Zenvia"} value={token} onChange={(e) => setToken(e.target.value)} />
            <button type="submit" className="btn btn--primary" disabled={!token.trim() || salvarToken.isPending}>
              <KeyRound size={15} aria-hidden="true" />
              Salvar token
            </button>
          </form>
          {erroToken && <span className="field__error" role="alert">{erroToken}</span>}

          <Passo
            ok={v ? v.assinaturaMensagem && v.assinaturaStatus : null}
            titulo="Webhooks (mensagens e status de entrega)"
            direita={
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!c.tokenMascara || assinar.isPending}
                onClick={() => assinar.mutate(undefined, { onSuccess: (r) => toast.success(r.criadas.length ? `Assinaturas criadas: ${r.criadas.join(", ")}` : "As assinaturas já existiam"), onError: (e) => toast.error(msgErro(e, "A Zenvia recusou a assinatura.")) })}
              >
                <Link2 size={14} aria-hidden="true" />
                {assinar.isPending ? "Criando…" : "Criar assinaturas"}
              </button>
            }
          >
            Um webhook só para todos os números: o setor sai do número de destino.{" "}
            {v ? `Mensagens: ${v.assinaturaMensagem ? "ativa" : "falta"} · Status: ${v.assinaturaStatus ? "ativa" : "falta"}.` : "Teste a conexão para conferir."} Sem a de status, uma mensagem recusada pela Zenvia fica invisível.
          </Passo>
        </div>

        <h2 style={{ marginTop: 8 }}>Números cadastrados nos setores</h2>
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Phone}>Número</ThLabel></th>
                <th><ThLabel icon={Building2}>Setor</ThLabel></th>
                <th><ThLabel icon={KeyRound}>Na conta do token?</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {c.numeros.length === 0 && <tr><td colSpan={3} className="at-vazio">Nenhum número. Cadastre em Administração › Setores e números.</td></tr>}
              {c.numeros.map((n) => (
                <tr key={n.id}>
                  <td>{telefone(n.numero)}</td>
                  <td>{n.setorNome}</td>
                  <td>
                    {n.verificacao ? (
                      <StatusBadge variant={n.verificacao.naConta ? "success" : "danger"}>{n.verificacao.naConta ? "Sim" : "Não"}</StatusBadge>
                    ) : (
                      <StatusBadge variant="neutral">Não testado</StatusBadge>
                    )}
                    {n.verificacao?.erro && <em className="zv-erro">{n.verificacao.erro}</em>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card at-sec" aria-labelledby={`${ids}-at`}>
        <h2 id={`${ids}-at`}>Atendimento</h2>
        <div className="zv-chave">
          <Switch.Root className="switch" checked={c.ligado} disabled={salvar.isPending} onCheckedChange={(on) => salvarParcial({ ligado: on }, on ? "Respostas automáticas ligadas" : "Respostas automáticas desligadas")} aria-labelledby={`${ids}-lg`}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <b id={`${ids}-lg`}>Atendimento ligado</b>
            <span>Desligado: as mensagens são gravadas e entram na fila, mas nada é respondido automaticamente.</span>
          </div>
          <StatusBadge variant={c.ligado ? "success" : "neutral"}>{c.ligado ? "Ligado" : "Desligado"}</StatusBadge>
        </div>
        <div className="zv-chave">
          <Switch.Root className="switch" checked={c.travaPiloto} disabled={salvar.isPending} onCheckedChange={(on) => salvarParcial({ travaPiloto: on }, on ? "Trava de piloto ligada" : "Trava de piloto desligada: resposta automática para todos")} aria-labelledby={`${ids}-tp`}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <b id={`${ids}-tp`}>Trava de piloto</b>
            <span>Só os telefones abaixo recebem resposta automática. Use na homologação.</span>
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-tels`}>Telefones do piloto (um por linha)</label>
          <textarea id={`${ids}-tels`} className="input" rows={3} value={telefones} onChange={(e) => setTelefones(e.target.value)} placeholder="(21) 97357-3360" />
          <div className="at-rodape" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn--outline btn--sm" disabled={salvar.isPending} onClick={() => salvarParcial({ telefonesPiloto: telefones.split(/\n|,|;/).map((t) => t.trim()).filter(Boolean) }, "Telefones do piloto salvos")}>
              Salvar telefones
            </button>
          </div>
        </div>

        <h2 style={{ marginTop: 8 }}>Teste de envio</h2>
        <div className="zv-inline">
          <label className="visually-hidden" htmlFor={`${ids}-de`}>Enviar pelo número</label>
          <select id={`${ids}-de`} className="input" value={numeroTeste} onChange={(e) => setNumeroTeste(e.target.value ? Number(e.target.value) : "")}>
            {c.numeros.length === 0 && <option value="">Nenhum número</option>}
            {c.numeros.map((n) => (
              <option key={n.id} value={n.id}>{telefone(n.numero)} · {n.setorNome}</option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor={`${ids}-teste`}>Telefone para o teste</label>
          <input id={`${ids}-teste`} className="input" inputMode="tel" placeholder="(21) 97357-3360" value={teste} onChange={(e) => setTeste(e.target.value)} />
          <button
            type="button"
            className="btn btn--outline"
            disabled={!teste.trim() || numeroTeste === "" || enviar.isPending || !c.tokenMascara}
            onClick={() =>
              numeroTeste !== "" &&
              enviar.mutate({ numeroId: numeroTeste, telefone: teste }, { onSuccess: (r) => (r.ok ? toast.success(`Enviado. ${r.aviso}`) : toast.error(r.erro ?? "A Zenvia recusou o envio.")), onError: (e) => toast.error(msgErro(e, "Falha no envio.")) })
            }
          >
            <Send size={15} aria-hidden="true" />
            {enviar.isPending ? "Enviando…" : "Enviar teste"}
          </button>
        </div>
        <p className="field__help">A Zenvia responde "ok" mesmo quando vai descartar a mensagem. A confirmação de entrega chega pelo webhook de status.</p>
      </section>
    </div>
  );
}
