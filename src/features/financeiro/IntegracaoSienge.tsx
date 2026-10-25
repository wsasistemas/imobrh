import * as Switch from "@radix-ui/react-switch";
import { Info, KeyRound, PlugZap, Save } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../components/PageSkeleton";
import { ErrorState } from "../configuracoes/components/ErrorState";
import { Notice } from "../configuracoes/components/Notice";
import { ServiceError } from "../configuracoes/services/types";
import { useConfigSienge, useListasSienge, useSalvarSenhaSienge, useSalvarSienge, useTestarSienge } from "./hooks";
import type { ConfigSienge, SalvarSienge } from "./sienge";
import "../atendimento/pages/Atendimento.css";
import "./financeiro.css";

// Configurações › Integrações › SIENGE (Admin e Super admin): conexão com a API REST do SIENGE (senha no cofre) e os
// padrões do título a pagar que o botão "Lançamento no SIENGE" da conferência cria (POST /bills).

const msg = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);
const dataHora = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");

export function IntegracaoSienge() {
  const q = useConfigSienge();
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message={msg(q.error, "Não foi possível carregar a integração com o SIENGE.")} onRetry={() => void q.refetch()} />;
  return <Tela c={q.data} />;
}

function Tela({ c }: { c: ConfigSienge }) {
  const ids = useId();
  const salvar = useSalvarSienge();
  const testar = useTestarSienge();
  const salvarSenha = useSalvarSenhaSienge();
  const [f, setF] = useState<SalvarSienge>({
    ativo: c.ativo, ambiente: c.ambiente, subdominio: c.subdominio, usuario: c.usuario, empresaId: c.empresaId, tipoDocumento: c.tipoDocumento,
    indexadorId: c.indexadorId, planoReembolso: c.planoReembolso, planoFundoFixo: c.planoFundoFixo, planoAdiantamento: c.planoAdiantamento, centroCustoPadrao: c.centroCustoPadrao,
  });
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  // As listas do SIENGE ajudam a escolher os códigos (só depois de conectar).
  const listas = useListasSienge(!!c.ultimoTeste?.ok);
  const muda = <K extends keyof SalvarSienge>(k: K, v: SalvarSienge[K]) => setF((x) => ({ ...x, [k]: v }));
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "")));
  const erroDe = (campo: string) => (erro?.campo === campo ? <span className="field__error" role="alert">{erro.mensagem}</span> : null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(f, {
      onSuccess: () => toast.success("Configuração do SIENGE salva"),
      onError: (er) => (er instanceof ServiceError ? setErro({ campo: er.field, mensagem: er.message }) : toast.error("Não foi possível salvar.")),
    });
  };

  const t = c.ultimoTeste;
  return (
    <>
      <Notice icon={Info}>
        As solicitações financeiras conferidas viram <b>título a pagar no SIENGE</b> pelo botão <b>Lançamento no SIENGE</b> da conferência. O credor é o colaborador,
        procurado pelo CPF do cadastro de Pessoas (sem cadastro automático). O PDF do formulário e os comprovantes vão anexados ao título.
      </Notice>
      <div className="sf-integ">
        <section className="card at-sec" aria-labelledby={`${ids}-c`}>
          <h2 id={`${ids}-c`}>Conexão</h2>
          <div className="sf-grade">
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-amb`}>Ambiente</label>
              <select id={`${ids}-amb`} className="input" value={f.ambiente} onChange={(e) => muda("ambiente", e.target.value as SalvarSienge["ambiente"])}>
                <option value="homologacao">Homologação</option>
                <option value="producao">Produção</option>
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-sub`}>Subdomínio</label>
              <input id={`${ids}-sub`} className="input" autoComplete="off" placeholder="ex.: suaempresa" value={f.subdominio ?? ""} aria-invalid={erro?.campo === "subdominio" || undefined}
                onChange={(e) => muda("subdominio", e.target.value.trim() || null)} />
              <span className="field__help">api.sienge.com.br/<b>{f.subdominio || "subdominio"}</b>/public/api/v1</span>
              {erroDe("subdominio")}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-usr`}>Usuário da API</label>
              <input id={`${ids}-usr`} className="input" autoComplete="off" value={f.usuario ?? ""} onChange={(e) => muda("usuario", e.target.value || null)} />
            </div>
          </div>
          <form className="sf-senha" onSubmit={(e) => {
            e.preventDefault();
            salvarSenha.mutate(senha, { onSuccess: () => { setSenha(""); toast.success("Senha salva no cofre"); }, onError: (er) => toast.error(msg(er, "Não foi possível salvar a senha.")) });
          }}>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-pwd`}>Senha da API</label>
              <input id={`${ids}-pwd`} className="input" type="password" autoComplete="new-password" value={senha} placeholder={c.senhaDefinida ? "•••••••• (salva no cofre)" : ""}
                onChange={(e) => setSenha(e.target.value)} />
              <span className="field__help">{c.senhaDefinida ? `Salva em ${dataHora(c.senhaDefinidaEm)}. Digite só para trocar.` : "Fica no cofre (Vault); não volta para a tela."}</span>
            </div>
            <button type="submit" className="btn btn--outline" disabled={salvarSenha.isPending || senha.length < 4}>
              <KeyRound size={15} aria-hidden="true" />
              Salvar senha
            </button>
          </form>
          <div className="at-rodape">
            <button type="button" className="btn btn--outline" disabled={testar.isPending}
              onClick={() => testar.mutate(undefined, { onSuccess: (r) => (r.ok ? toast.success("Conexão com o SIENGE ok") : toast.error("A conexão falhou: veja os passos")), onError: (er) => toast.error(msg(er, "Não foi possível testar.")) })}>
              <PlugZap size={15} aria-hidden="true" />
              {testar.isPending ? "Testando…" : "Testar conexão"}
            </button>
          </div>
          {t && (
            <div className="sf-teste">
              <span className={`at-selo ${t.ok ? "s-fim" : "s-comigo"}`}>{t.ok ? "Conectado" : "Falhou"}</span>
              <span className="field__help">Último teste: {dataHora(t.em)}</span>
              <ul className="sf-regras">
                {t.passos.map((p) => (
                  <li key={p.passo}><span>{p.passo}</span><span className="field__help">{p.detalhe}</span><span className={`sf-chip ${p.ok ? "sf-chip--ok" : "sf-chip--erro"}`}>{p.ok ? "OK" : "Erro"}</span></li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <form className="card at-sec" onSubmit={enviar} aria-labelledby={`${ids}-p`}>
          <h2 id={`${ids}-p`}>Padrões do lançamento</h2>
          <p className="at-sec__ajuda">Códigos do SIENGE usados em todo título a pagar. O conferente confirma o centro de custo, o plano e o vencimento na hora de lançar.</p>
          <div className="sf-grade">
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-emp`}>Empresa pagadora (código)</label>
              <input id={`${ids}-emp`} className="input sf-num" inputMode="numeric" value={f.empresaId ?? ""} onChange={(e) => muda("empresaId", num(e.target.value))} />
              <span className="field__help">debtorId do título.</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-doc`}>Tipo de documento</label>
              {listas.data?.documentos.length ? (
                <select id={`${ids}-doc`} className="input" value={f.tipoDocumento ?? ""} onChange={(e) => muda("tipoDocumento", e.target.value || null)}>
                  <option value="">Escolha…</option>
                  {listas.data.documentos.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.nome}</option>)}
                </select>
              ) : (
                <input id={`${ids}-doc`} className="input" maxLength={10} placeholder="ex.: AV" value={f.tipoDocumento ?? ""} onChange={(e) => muda("tipoDocumento", e.target.value.toUpperCase() || null)} />
              )}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-idx`}>Indexador (código)</label>
              <input id={`${ids}-idx`} className="input sf-num" inputMode="numeric" value={f.indexadorId ?? ""} onChange={(e) => muda("indexadorId", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-cc`}>Centro de custo padrão</label>
              {listas.data?.centrosCusto.length ? (
                <select id={`${ids}-cc`} className="input" value={f.centroCustoPadrao ?? ""} onChange={(e) => muda("centroCustoPadrao", num(e.target.value))}>
                  <option value="">Nenhum (o conferente escolhe)</option>
                  {listas.data.centrosCusto.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.nome}</option>)}
                </select>
              ) : (
                <input id={`${ids}-cc`} className="input sf-num" inputMode="numeric" value={f.centroCustoPadrao ?? ""} onChange={(e) => muda("centroCustoPadrao", num(e.target.value))} />
              )}
            </div>
          </div>
          <h3 className="sf-aba__titulo">Plano financeiro por tipo <small>sem máscara, só números</small></h3>
          <div className="sf-grade">
            {([["planoReembolso", "Reembolso"], ["planoFundoFixo", "Fundo fixo"], ["planoAdiantamento", "Adiantamento"]] as const).map(([k, rot]) => (
              <div className="field" key={k}>
                <label className="field__label" htmlFor={`${ids}-${k}`}>{rot}</label>
                {listas.data?.planos.length ? (
                  <select id={`${ids}-${k}`} className="input" value={f[k] ?? ""} onChange={(e) => muda(k, e.target.value || null)}>
                    <option value="">Escolha…</option>
                    {listas.data.planos.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.nome}</option>)}
                  </select>
                ) : (
                  <input id={`${ids}-${k}`} className="input" inputMode="numeric" placeholder="ex.: 2010101" value={f[k] ?? ""} onChange={(e) => muda(k, e.target.value.replace(/\D/g, "") || null)} />
                )}
              </div>
            ))}
          </div>
          {erroDe("planos")}
          <div className="zv-chave">
            <Switch.Root id={`${ids}-at`} className="switch" checked={f.ativo} onCheckedChange={(v) => muda("ativo", v)}>
              <Switch.Thumb className="switch__thumb" />
            </Switch.Root>
            <div>
              <label htmlFor={`${ids}-at`}><b>Integração ativa</b></label>
              <span>Liga o botão "Lançamento no SIENGE" na conferência financeira.</span>
            </div>
          </div>
          {erroDe("ativo")}
          {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}
          <div className="at-rodape">
            <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>
              <Save size={15} aria-hidden="true" />
              {salvar.isPending ? "Salvando…" : "Salvar configuração"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
