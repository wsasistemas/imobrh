import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Building2, CheckCircle2, CircleCheck, CircleDot, CircleX, Clock, Hash, Info, KeyRound, Mail, MoreVertical, Plus, RefreshCw, Server, Tag, ToggleRight, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { useAccess } from "../../configuracoes/access/useAccess";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { formatDateTime } from "../../../utils/dates";
import { useContasEmail, useContexto, useExcluirContaEmail, useHabilitarContasEmail, useSalvarContaEmail, useSenhaContaEmail, useTestarContaEmail, useAutorizarGoogle, useAppGoogle } from "../hooks/useAtendimento";
import { AppGoogleDialog } from "./AppGoogleDialog";
import { contaNova, PROVEDORES, type AbrirTickets, type ContaEmail, type ContaEmailDados, type ProvedorEmail, type VerificacaoEmail } from "../services/email";
import type { MensagemOAuth } from "./OAuthRetorno";
import type { Setor } from "../services/tipos";
import { hora } from "./util";
import "./Atendimento.css";

const msgErro = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);

type Status = "conectado" | "falha" | "aguardando" | "inativo";
type StatusLista = Status | "autorizar" | "reautorizar";
const STATUS: Record<StatusLista, { rotulo: string; classe: string }> = {
  conectado: { rotulo: "Conectado", classe: "em-st--ok" },
  falha: { rotulo: "Falha na conexão", classe: "em-st--falha" },
  aguardando: { rotulo: "Aguardando teste", classe: "em-st--aguardando" },
  inativo: { rotulo: "Inativo", classe: "em-st--inativo" },
  autorizar: { rotulo: "Aguardando autorização", classe: "em-st--aguardando" },
  reautorizar: { rotulo: "Reautorizar", classe: "em-st--falha" },
};
const statusDe = (c: ContaEmail): StatusLista => {
  if (!c.habilitada) return "inativo";
  if (c.modo === "oauth_google") {
    if (!c.oauthEmail) return "autorizar";
    if (c.status === "falha" && /reautoriz/i.test(c.ultimoErro ?? "")) return "reautorizar";
  }
  return c.status;
};

const ABRIR: { id: AbrirTickets; rotulo: string }[] = [
  { id: "qualquer", rotulo: "De qualquer remetente" },
  { id: "cliente", rotulo: "Somente se o remetente estiver cadastrado como cliente (Pessoas)" },
  { id: "cliente_ou_dominio", rotulo: "Somente se o remetente estiver cadastrado como cliente ou o seu domínio estiver relacionado a uma empresa cadastrada" },
  { id: "dominio", rotulo: "Só domínio: somente remetentes dos domínios abaixo (ex.: exemplo.com.br), mesmo que outra pessoa esteja cadastrada" },
  { id: "nao", rotulo: "Não habilitar" },
];

/** Gestão de Atendimento › Central Email (estrutura da Movidesk). */
export function ContasEmail() {
  const contexto = useContexto();
  const contas = useContasEmail();
  const [editando, setEditando] = useState<ContaEmail | "nova" | null>(null);
  if (contexto.isPending || contas.isPending) return <PageSkeleton />;
  if (contexto.isError) return <ErrorState message="Não foi possível carregar os setores." onRetry={() => void contexto.refetch()} />;
  if (contas.isError) return <ErrorState message={msgErro(contas.error, "Não foi possível carregar as contas de e-mail.")} onRetry={() => void contas.refetch()} />;

  const supervisor = contexto.data.supervisor;
  if (editando !== null) {
    const atual = editando === "nova" ? null : (contas.data.find((c) => c.id === editando.id) ?? editando);
    return <FormConta key={atual?.id ?? "nova"} conta={atual} setores={contexto.data.setores} podeEditar={supervisor} onFechar={() => setEditando(null)} onNova={() => setEditando("nova")} onAbrir={(c) => setEditando(c)} />;
  }
  return <Lista contas={contas.data} supervisor={supervisor} onAbrir={setEditando} />;
}

// ---------------------------------------------------------------- Lista

function Lista({ contas, supervisor, onAbrir }: { contas: ContaEmail[]; supervisor: boolean; onAbrir: (c: ContaEmail | "nova") => void }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const [status, setStatus] = useState<StatusLista | "">("");
  const [marcadas, setMarcadas] = useState<Set<number>>(new Set());
  const habilitar = useHabilitarContasEmail();
  const testar = useTestarContaEmail();
  const [testandoTodas, setTestandoTodas] = useState(false);
  const [appAberto, setAppAberto] = useState(false);
  const { isSuperAdmin } = useAccess();
  const app = useAppGoogle();
  const usaGoogle = contas.length === 0 || contas.some((c) => c.provedor === "google");
  const appPendente = isSuperAdmin && app.isSuccess && !app.data.clientId && usaGoogle;

  const q = busca.trim().toLowerCase();
  const visiveis = useMemo(
    () =>
      contas
        .filter((c) => q.length < 3 || `${c.nome} ${c.email} ${c.setorNome ?? ""}`.toLowerCase().includes(q))
        .filter((c) => !status || statusDe(c) === status)
        .sort((a, b) => a.email.localeCompare(b.email)),
    [contas, q, status],
  );
  const naFila = contas.reduce((s, c) => s + c.naFila, 0);
  const todasMarcadas = visiveis.length > 0 && visiveis.every((c) => marcadas.has(c.id));

  const marcar = (id: number) => setMarcadas((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const lote = (habilitada: boolean) => {
    if (marcadas.size === 0) return void toast.info("Marque as contas na lista primeiro.");
    habilitar.mutate({ ids: [...marcadas], habilitada }, { onSuccess: (n) => { toast.success(`${n} conta(s) ${habilitada ? "habilitada(s)" : "desabilitada(s)"}`); setMarcadas(new Set()); }, onError: (e) => toast.error(msgErro(e, "Não foi possível alterar.")) });
  };
  const testarTodas = async () => {
    setTestandoTodas(true);
    let ok = 0;
    const alvo = contas.filter((c) => c.habilitada);
    for (const c of alvo) {
      try {
        if ((await testar.mutateAsync({ id: c.id })).ok) ok++;
      } catch {
        /* a conta fica com a falha registrada */
      }
    }
    setTestandoTodas(false);
    toast.info(`${ok} de ${alvo.length} conta(s) conectada(s)`);
  };
  const exportar = () => {
    const linhas = [["Nome", "Endereço", "Setor", "Provedor", "Status", "E-mails na fila", "Habilitado"], ...visiveis.map((c) => [c.nome, c.email, c.setorNome ?? "", PROVEDORES.find((p) => p.id === c.provedor)?.rotulo ?? c.provedor, STATUS[statusDe(c)].rotulo, String(c.naFila), c.habilitada ? "Sim" : "Não"])];
    const csv = "﻿" + linhas.map((l) => l.map((v) => `"${v.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "contas-de-email.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="card" aria-labelledby={`${ids}-t`}>
      <div className="em-head">
        <div className="em-head__tit">
          <h2 id={`${ids}-t`}>Central Email</h2>
          <small>Exibindo {visiveis.length} de um total de {contas.length} registro(s)</small>
        </div>
        {supervisor && (
          <button type="button" className="btn btn--primary" onClick={() => onAbrir("nova")}>
            <Plus size={16} aria-hidden="true" />
            Nova conta
          </button>
        )}
        {supervisor && (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="btn btn--outline" disabled={testandoTodas}>
                {testandoTodas ? "Testando…" : "Opções"}
                <MoreVertical size={15} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu">
                {isSuperAdmin && (
                  <DropdownMenu.Item className="menu__item" onSelect={() => setAppAberto(true)}><KeyRound size={15} aria-hidden="true" />Aplicativo do Google (chaves)</DropdownMenu.Item>
                )}
                <DropdownMenu.Item className="menu__item" onSelect={() => void testarTodas()}><RefreshCw size={15} aria-hidden="true" />Testar todas as contas</DropdownMenu.Item>
                <DropdownMenu.Item className="menu__item" onSelect={() => lote(true)}><CircleCheck size={15} aria-hidden="true" />Habilitar marcadas</DropdownMenu.Item>
                <DropdownMenu.Item className="menu__item menu__item--warning" onSelect={() => lote(false)}><CircleX size={15} aria-hidden="true" />Desabilitar marcadas</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu__separator" />
                <DropdownMenu.Item className="menu__item" onSelect={exportar}>Exportar lista (Excel)</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <div className="em-busca">
          <label className="visually-hidden" htmlFor={`${ids}-busca`}>Pesquisar</label>
          <input id={`${ids}-busca`} className="input" type="search" placeholder="Pesquisar nome, endereço ou setor" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <small>Digite pelo menos 3 caracteres para iniciar a busca.</small>
        </div>
        <div>
          <label className="visually-hidden" htmlFor={`${ids}-st`}>Status</label>
          <select id={`${ids}-st`} className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusLista | "")}>
            <option value="">Todos os status</option>
            {(Object.keys(STATUS) as StatusLista[]).map((s) => (
              <option key={s} value={s}>{STATUS[s].rotulo}</option>
            ))}
          </select>
        </div>
      </div>

      {appPendente && (
        <div className="em-aviso-app" role="note">
          <KeyRound size={16} aria-hidden="true" />
          <span>Para vincular contas do Google, configure uma vez o <b>Aplicativo do Google</b> (ID do cliente e chave secreta). A chave fica oculta e guardada no banco.</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setAppAberto(true)}>Configurar</button>
        </div>
      )}
      <AppGoogleDialog open={appAberto} onOpenChange={setAppAberto} />

      {contas.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="Nenhuma conta de e-mail"
          description={supervisor ? "Clique em Nova conta, informe o e-mail que já existe no Google e o setor, e depois em Autorizar com Gmail." : "A supervisão geral ainda não cadastrou contas para os seus setores."}
        />
      ) : (
        <div className="at-tab-wrap">
          <table className="at-tab em-tab">
            <thead>
              <tr>
                <th className="c">
                  {supervisor && (
                    <input type="checkbox" aria-label="Marcar todas" checked={todasMarcadas} onChange={() => setMarcadas(todasMarcadas ? new Set() : new Set(visiveis.map((c) => c.id)))} />
                  )}
                </th>
                <th><ThLabel icon={Tag}>Nome</ThLabel></th>
                <th><ThLabel icon={Mail}>Endereço ↑</ThLabel></th>
                <th><ThLabel icon={Building2}>Setor</ThLabel></th>
                <th><ThLabel icon={Server}>Provedor</ThLabel></th>
                <th><ThLabel icon={CircleDot}>Status de conexão</ThLabel></th>
                <th className="n"><ThLabel icon={Hash}>E-mails na fila</ThLabel></th>
                <th><ThLabel icon={Clock}>Última leitura</ThLabel></th>
                <th className="c"><ThLabel icon={ToggleRight}>Habilitado</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((c) => {
                const st = statusDe(c);
                return (
                  <tr key={c.id} className={c.habilitada ? undefined : "em-inativa"} tabIndex={0} onClick={() => onAbrir(c)} onKeyDown={(e) => e.key === "Enter" && onAbrir(c)}>
                    <td className="c" onClick={(e) => e.stopPropagation()}>
                      {supervisor && <input type="checkbox" aria-label={`Marcar ${c.email}`} checked={marcadas.has(c.id)} onChange={() => marcar(c.id)} />}
                    </td>
                    <td>{c.nome}</td>
                    <td>{c.email}</td>
                    <td>{c.setorNome ? <span className="at-tag">{c.setorNome}</span> : <span className="em-sem">Sem setor</span>}</td>
                    <td className="em-nowrap">{c.modo === "oauth_google" ? "Gmail (OAuth)"  : (PROVEDORES.find((p) => p.id === c.provedor)?.rotulo ?? c.provedor)}</td>
                    <td><span className={`em-st ${STATUS[st].classe}`} title={c.ultimoErro ?? undefined}>{STATUS[st].rotulo}</span></td>
                    <td className="n">{c.naFila}</td>
                    <td>{c.ultimaLeituraEm ? hora(c.ultimaLeituraEm) : "—"}</td>
                    <td className="c">
                      {c.habilitada ? <CheckCircle2 size={20} className="em-hab em-hab--sim" aria-label="Sim" /> : <XCircle size={20} className="em-hab em-hab--nao" aria-label="Não" />}
                    </td>
                  </tr>
                );
              })}
              {visiveis.length === 0 && (
                <tr><td colSpan={9} className="at-vazio">Nenhuma conta com esse filtro.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="em-rodape">
        {contas.filter((c) => c.habilitada && c.status === "conectado").length} conectada(s) · {contas.filter((c) => c.habilitada && c.status === "falha").length} com falha · {naFila} e-mail(s) na fila
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Formulário (3 abas)

type Aba = "principal" | "receb" | "envio";

function FormConta({
  conta,
  setores,
  podeEditar,
  onFechar,
  onNova,
  onAbrir,
}: {
  conta: ContaEmail | null;
  setores: Setor[];
  podeEditar: boolean;
  onFechar: () => void;
  onNova: () => void;
  onAbrir: (c: ContaEmail) => void;
}) {
  const ids = useId();
  const { user, isSuperAdmin } = useAccess();
  const appG = useAppGoogle();
  const appFalta = isSuperAdmin && appG.isSuccess && !appG.data.clientId;
  const salvar = useSalvarContaEmail();
  const salvarSenha = useSenhaContaEmail();
  const testar = useTestarContaEmail();
  const excluir = useExcluirContaEmail();
  const autorizar = useAutorizarGoogle();
  const queryClient = useQueryClient();
  const [aba, setAba] = useState<Aba>("principal");
  const [d, setD] = useState<ContaEmailDados>(() => (conta ? { ...conta, dominiosPermitidos: conta.dominiosPermitidos ?? ["exemplo.com.br"] } : contaNova(null)));
  const [dominiosTxt, setDominiosTxt] = useState(() => (conta?.dominiosPermitidos ?? contaNova(null).dominiosPermitidos).join(", "));
  const [senha, setSenha] = useState("");
  const ignorar = (conta?.ignorarRemetentes ?? contaNova(null).ignorarRemetentes).join(", ");
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  const enviarPara = user?.email ?? "";
  const [resultado, setResultado] = useState<VerificacaoEmail | null>(conta?.verificacao ?? null);
  const [confirmarExcluir, setConfirmarExcluir] = useState(false);
  const somenteLeitura = !podeEditar;
  const ocupado = salvar.isPending || salvarSenha.isPending || testar.isPending;

  useEffect(() => setResultado(conta?.verificacao ?? null), [conta?.verificacao]);

  // Resposta da janela do Google (rota /oauth/google): atualiza a lista e mostra o resultado.
  useEffect(() => {
    const ouvir = (ev: MessageEvent<MensagemOAuth>) => {
      if (ev.origin !== window.location.origin || ev.data?.tipo !== "google-oauth") return;
      void queryClient.invalidateQueries({ queryKey: ["atendimento", "emails"] });
      if (ev.data.status === "ok") toast.success(`Conta autorizada como ${ev.data.email ?? ""}`);
      else toast.error(ev.data.msg ?? "O Google não concluiu a autorização.");
    };
    window.addEventListener("message", ouvir);
    return () => window.removeEventListener("message", ouvir);
  }, [queryClient]);

  const muda = <K extends keyof ContaEmailDados>(k: K, v: ContaEmailDados[K]) => setD((x) => ({ ...x, [k]: v }));
  const provedor = PROVEDORES.find((p) => p.id === d.provedor)!;
  const google = d.provedor === "google";
  /** Conta Google: lê e envia com a autorização do Google (botão "Autorizar com Gmail"), sem servidor nem senha. */
  const viaGoogle = google;
  const trocarProvedor = (p: ProvedorEmail) => {
    const pr = PROVEDORES.find((x) => x.id === p)!;
    setD((x) => ({ ...x, provedor: p, modo: p === "google" ? "oauth_google" : "imap_smtp", imapHost: pr.imap, smtpHost: pr.smtp, imapPorta: 993, smtpPorta: 465, imapSeguranca: "ssl" }));
  };
  const erroDe = (campo: string) => (erro?.campo === campo ? <span className="field__error" role="alert">{erro.mensagem}</span> : null);

  /** Salva e devolve o id (ou null se deu erro). A senha, se digitada, vai depois, direto para o cofre. */
  const gravar = async (): Promise<number | null> => {
    setErro(null);
    try {
      const id = await salvar.mutateAsync({
        ...d,
        modo: d.provedor === "google" ? "oauth_google" : "imap_smtp",
        id: conta?.id,
        usuario: d.usuario || d.email,
        ignorarRemetentes: ignorar.split(/\n|,|;/).map((x) => x.trim()).filter(Boolean),
        dominiosPermitidos: dominiosTxt.split(/[\s,;]+/).map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
      });
      if (senha && !viaGoogle) await salvarSenha.mutateAsync({ id, senha });
      setSenha("");
      return id;
    } catch (e) {
      if (e instanceof ServiceError) {
        setErro({ campo: e.field, mensagem: e.message });
        if (e.field && ["imapHost", "smtpPorta", "modo", "dominiosPermitidos"].includes(e.field)) setAba(e.field === "smtpPorta" ? "envio" : "receb");
        else if (e.field) setAba("principal");
      } else toast.error("Não foi possível salvar a conta.");
      return null;
    }
  };

  /** Salva, pede a URL ao servidor e abre o Google numa janela (como a Movidesk). */
  const autorizarAgora = async () => {
    // A janela é aberta já no clique: aberta depois de um await, o navegador a bloquearia como pop-up.
    const janela = window.open("about:blank", "google-oauth", "width=520,height=700");
    const id = await gravar();
    if (!id) {
      janela?.close();
      return;
    }
    try {
      const url = await autorizar.mutateAsync(id);
      if (janela && !janela.closed) janela.location.href = url;
      else window.location.href = url;
      if (!conta) onAbrir({ ...(d as ContaEmail), id });
    } catch (e) {
      janela?.close();
      toast.error(msgErro(e, "Não foi possível abrir a autorização do Google."));
    }
  };

  const salvarEFechar = async () => {
    if (await gravar()) {
      toast.success("Conta salva");
      onFechar();
    }
  };
  const salvarENova = async () => {
    if (await gravar()) {
      toast.success("Conta salva");
      onNova();
    }
  };
  const testarAgora = async () => {
    const id = await gravar();
    if (!id) return;
    try {
      const r = await testar.mutateAsync({ id, enviarPara: enviarPara.trim() || undefined });
      setResultado(r);
      if (r.ok) toast.success("Conta conectada");
      else toast.error("O teste encontrou um problema: veja os passos.");
      if (!conta) onAbrir({ ...(d as ContaEmail), id });
    } catch (e) {
      toast.error(msgErro(e, "Não foi possível testar."));
    }
  };

  return (
    <section className="card em-form" aria-labelledby={`${ids}-t`}>
      <h2 id={`${ids}-t`} className="visually-hidden">{conta ? conta.nome : "Nova conta de e-mail"}</h2>
      <div className="em-abas" role="tablist" aria-label="Seções da conta">
        {([["principal", "Principal"], ["receb", "Configurações de recebimento"], ["envio", "Configurações de envio"]] as const).map(([id, rotulo]) => (
          <button key={id} type="button" role="tab" aria-selected={aba === id} className={`em-aba${aba === id ? " em-aba--on" : ""}`} onClick={() => setAba(id)}>
            {rotulo}
          </button>
        ))}
      </div>

      <fieldset className="em-corpo" disabled={somenteLeitura}>
        {somenteLeitura && <p className="at-sec__ajuda">Só leitura: a supervisão geral cadastra e altera as contas de e-mail.</p>}

        {aba === "principal" && (
          <div className="em-pane">
            <div className="em-l2">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-nome`}>Nome da conta</label>
                <input id={`${ids}-nome`} className="input" maxLength={80} value={d.nome} onChange={(e) => muda("nome", e.target.value)} placeholder="Ex.: CFTV" />
                {erroDe("nome")}
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-email`}>Endereço de e-mail</label>
                <input id={`${ids}-email`} className="input" type="email" value={d.email} onChange={(e) => muda("email", e.target.value)} placeholder="cftv@exemplo.com.br" />
                {erroDe("email")}
              </div>
            </div>
            <div className="em-l2">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-setor`}>Setor (opcional)</label>
                <select id={`${ids}-setor`} className="input" value={d.setorId ?? ""} onChange={(e) => muda("setorId", e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Sem setor (vincular depois)</option>
                  {setores.filter((s) => s.recebeChamados || s.id === d.setorId).map((s) => (
                    <option key={s.id} value={s.id}>{s.nome}</option>
                  ))}
                </select>
                {erroDe("setorId")}
                <span className="field__help">Opcional: a conta funciona só com a autorização do Google. O vínculo com setor/equipe pode ser feito depois.</span>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-rem`}>Nome de exibição do remetente</label>
                <input id={`${ids}-rem`} className="input" maxLength={80} value={d.nomeRemetente} onChange={(e) => muda("nomeRemetente", e.target.value)} placeholder="Sua empresa · CFTV" />
                <span className="field__help">Como o cliente vê quem respondeu: "{d.nomeRemetente || "Sua empresa"} &lt;{d.email || "conta@exemplo.com.br"}&gt;".</span>
              </div>
            </div>
            <hr className="em-sep" />
            <Chk id={`${ids}-c1`} rotulo="Exibir esta conta no envio de e-mails do chamado" ajuda="Desmarcado, a conta não aparece como possível remetente ao responder um chamado." checked={d.exibirNoEnvio} onChange={(v) => muda("exibirNoEnvio", v)} />
            <Chk id={`${ids}-c2`} rotulo="Conta padrão de envio do setor" ajuda="Usada quando o atendente abre um chamado novo para o cliente (e não responde a um e-mail recebido). Só uma por setor." checked={d.padraoDoSetor} onChange={(v) => muda("padraoDoSetor", v)} />
            <Chk id={`${ids}-c3`} rotulo="Utilizar logomarca da conta de e-mail" ajuda="Marcado, o e-mail sai com a logomarca da conta no lugar da foto do atendente. O envio da imagem entra junto com o envio dos e-mails." checked={d.usarLogo} onChange={(v) => muda("usarLogo", v)} />
            <hr className="em-sep" />
            <div className="field">
              <span className="field__label" id={`${ids}-prov`}>Selecione o provedor de e-mail para auxiliar na configuração da conta</span>
              <div className="em-radios" role="radiogroup" aria-labelledby={`${ids}-prov`}>
                {PROVEDORES.map((p) => (
                  <label key={p.id}>
                    <input type="radio" name={`${ids}-prov`} checked={d.provedor === p.id} onChange={() => trocarProvedor(p.id)} />
                    {p.rotulo}
                  </label>
                ))}
              </div>
              <span className="field__help">O domínio @exemplo.com.br está no Google Workspace: para essas contas, use "Google Workspace / Gmail".</span>
              {provedor.aviso && <p className="em-aviso" role="note">{provedor.aviso}</p>}
            </div>
            <Chk id={`${ids}-c4`} rotulo="Conta habilitada" ajuda="Desabilitada: não lê nem envia e-mails, mas mantém o histórico." checked={d.habilitada} onChange={(v) => muda("habilitada", v)} />
          </div>
        )}

        {aba === "receb" && (
          <div className="em-pane">
            <h3 className="em-tit">Configurações de recebimento</h3>
            <Chk id={`${ids}-rh`} rotulo="Habilitar recebimento de e-mails" checked={d.receberHabilitado} onChange={(v) => muda("receberHabilitado", v)} />
            {google ? (
              <div className="em-oauth">
                <div className="em-oauth__topo">
                  <button type="button" className="em-gbtn" disabled={somenteLeitura || ocupado || autorizar.isPending} onClick={() => void autorizarAgora()}>
                    <span className="em-gbtn__g" aria-hidden="true">
                      <svg viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.2C12.5 13.7 17.8 9.5 24 9.5z" />
                        <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
                        <path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6z" />
                        <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6C6.6 42.6 14.6 48 24 48z" />
                      </svg>
                    </span>
                    <span className="em-gbtn__txt">{autorizar.isPending ? "Abrindo o Google…" : conta?.oauthEmail ? "Reautorizar com Gmail" : "Autorizar com Gmail"}</span>
                  </button>
                  {conta?.oauthEmail && conta.status === "falha" && /reautoriz/i.test(conta.ultimoErro ?? "") ? (
                    <span className="em-st-linha"><span className="em-bola em-bola--er" aria-hidden="true" /><span>Autorização revogada ou senha da caixa alterada: clique em <b>Reautorizar com Gmail</b>.</span></span>
                  ) : conta?.oauthEmail ? (
                    <span className="em-st-linha"><span className="em-bola em-bola--ok" aria-hidden="true" /><span>Autorizado como <b>{conta.oauthEmail}</b>{conta.oauthAutorizadoEm ? ` em ${formatDateTime(conta.oauthAutorizadoEm)}` : ""}: recebimento e envio liberados.</span></span>
                  ) : (
                    <span className="em-st-linha"><span className="em-bola em-bola--pend" aria-hidden="true" /><span>Ainda não autorizada. Clique e entre no Google com <b>{d.email || "o endereço da conta"}</b>.</span></span>
                  )}
                </div>
                {appFalta && <p className="em-aviso" role="note">O Aplicativo do Google ainda não foi configurado. {isSuperAdmin ? "Configure em Central Email › Opções › Aplicativo do Google (chaves)." : "Peça ao super admin para configurar (uma vez)."}</p>}
                <p className="em-nota"><Info size={15} aria-hidden="true" />Este provedor utiliza autenticação segura via OAuth2. Por isso, é necessário conceder ao Imobdesk autorização para acessar suas informações, enviar e receber e-mails no seu nome. Essa autorização pode ser revogada a qualquer momento.</p>
              </div>
            ) : (
              <>
                <div className="em-l3">
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-ih`}>Servidor de entrada (IMAP)</label>
                    <input id={`${ids}-ih`} className="input" value={d.imapHost} onChange={(e) => muda("imapHost", e.target.value)} placeholder="imap.provedor.com.br" />
                    {erroDe("imapHost")}
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-ip`}>Porta</label>
                    <input id={`${ids}-ip`} className="input" type="number" value={d.imapPorta} onChange={(e) => muda("imapPorta", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-is`}>Mecanismo de segurança</label>
                    <select id={`${ids}-is`} className="input" value={d.imapSeguranca} onChange={(e) => muda("imapSeguranca", e.target.value as "ssl" | "starttls")}>
                      <option value="ssl">SSL/TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </div>
                </div>
                <div className="em-l2">
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-us`}>Usuário</label>
                    <input id={`${ids}-us`} className="input" value={d.usuario} onChange={(e) => muda("usuario", e.target.value)} placeholder={d.email || "o próprio endereço"} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-se`}>Senha</label>
                    <input id={`${ids}-se`} className="input" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder={conta?.senhaMascara ? `Guardada (${conta.senhaMascara}). Digite para trocar.` : "Digite a senha"} />
                    {erroDe("senha")}
                  </div>
                </div>
              </>
            )}

            <div className="field">
              <label className="field__label" htmlFor={`${ids}-pa`}>Caixa para recebimento de e-mails</label>
              <input id={`${ids}-pa`} className="input" value={d.pasta} onChange={(e) => muda("pasta", e.target.value)} placeholder="INBOX" />
            </div>
            <div className="em-l2 em-l2--estreito">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-mec`}>Mecanismo de autenticação</label>
                <select id={`${ids}-mec`} className="input" value="auto" disabled={google}>
                  <option value="auto">Auto</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-ld`}>Importar somente mensagens recebidas a partir de:</label>
                <input id={`${ids}-ld`} className="input" type="date" value={d.lerDesde} onChange={(e) => muda("lerDesde", e.target.value)} />
              </div>
            </div>
            <div className="em-chk em-chk--inl">
              <input id={`${ids}-ap`} type="checkbox" checked={d.apagarAposDias !== null} onChange={(e) => muda("apagarAposDias", e.target.checked ? 30 : null)} />
              <label htmlFor={`${ids}-ap`}>Apagar as mensagens já processadas depois de</label>
              <input className="input em-inl__num" type="number" min={1} max={3650} value={d.apagarAposDias ?? 30} disabled={d.apagarAposDias === null} aria-label="Dias para apagar" onChange={(e) => muda("apagarAposDias", Number(e.target.value))} />
              <span>dias</span>
            </div>
            {erroDe("apagarAposDias")}
            <div className="em-chk">
              <input id={`${ids}-r1`} type="checkbox" checked={d.marcarLido} onChange={(e) => muda("marcarLido", e.target.checked)} />
              <div>
                <label htmlFor={`${ids}-r1`}>Marcar e-mail como lido ao importá-lo</label>
                <span className="em-nota em-nota--p"><Info size={13} aria-hidden="true" />Se este parâmetro estiver marcado o sistema irá marcar a mensagem como lida antes de importá-la.</span>
              </div>
            </div>
            <div className="field em-campo-medio">
              <label className="field__label em-forte" htmlFor={`${ids}-ic`}>Importar e-mails como:</label>
              <select id={`${ids}-ic`} className="input" value="ticket" disabled>
                <option value="ticket">Ticket</option>
              </select>
            </div>
            <div className="field">
              <span className="field__label" id={`${ids}-ab`}>Habilitar a importação de e-mails para a abertura de novos tickets</span>
              <div className="em-radios em-radios--col" role="radiogroup" aria-labelledby={`${ids}-ab`}>
                {ABRIR.map((o) => (
                  <label key={o.id}>
                    <input type="radio" name={`${ids}-ab`} checked={d.abrirTickets === o.id} onChange={() => muda("abrirTickets", o.id)} />
                    {o.rotulo}
                  </label>
                ))}
              </div>
              {d.abrirTickets === "dominio" && (
                <div className="field em-campo-medio">
                  <label className="field__label" htmlFor={`${ids}-dom`}>Domínios aceitos</label>
                  <input id={`${ids}-dom`} className="input" value={dominiosTxt} onChange={(e) => setDominiosTxt(e.target.value)} placeholder="exemplo.com.br" disabled={somenteLeitura} />
                  <span className="em-nota em-nota--p"><Info size={13} aria-hidden="true" />Separe por vírgula. E-mail de outro domínio fica como ignorado, com o motivo. Respostas a tickets já existentes continuam entrando.</span>
                  {erroDe("dominiosPermitidos")}
                </div>
              )}
              <span className="em-nota em-nota--p"><Info size={13} aria-hidden="true" />Este parâmetro define se o sistema deve transformar e-mails em tickets ou se deve ignorar novas mensagens. Você pode aceitar e-mails somente se o remetente estiver cadastrado, somente se o domínio do e-mail estiver relacionado a uma empresa cadastrada em Pessoas ou pode aceitar e-mails de qualquer remetente.</span>
            </div>
          </div>
        )}

        {aba === "envio" && (
          <div className="em-pane">
            {viaGoogle ? (
              <p className="em-info">
                O envio usa a mesma autorização do Google feita em <b>Configurações de recebimento</b> (botão Autorizar com Gmail): as respostas saem pela própria conta e ficam em "Enviados" do Gmail. Não há servidor nem senha para configurar.
                {conta?.oauthEmail ? <> Autorizado como <b>{conta.oauthEmail}</b>.</> : <> <b>Conta ainda não autorizada.</b></>}
              </p>
            ) : (
              <>
                <div className="em-l3">
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-sh`}>Servidor de saída (SMTP)</label>
                    <input id={`${ids}-sh`} className="input" value={d.smtpHost} onChange={(e) => muda("smtpHost", e.target.value)} placeholder="smtp.provedor.com.br" />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-sp`}>Porta</label>
                    <input id={`${ids}-sp`} className="input" type="number" value={d.smtpPorta} onChange={(e) => muda("smtpPorta", Number(e.target.value))} />
                    {erroDe("smtpPorta")}
                  </div>
                  <div className="field">
                    <span className="field__label">Segurança</span>
                    <input className="input" value="SSL/TLS" readOnly aria-label="Segurança do SMTP" />
                  </div>
                </div>
                <span className="field__help">Só a porta 465 (SSL): o servidor do portal (Supabase) bloqueia as portas 25 e 587.</span>
                <span className="field__help">O envio usa o mesmo usuário e senha do recebimento.</span>
              </>
            )}
            <hr className="em-sep" />
            <div className="em-l2">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-rp`}>Responder para (opcional)</label>
                <input id={`${ids}-rp`} className="input" type="email" value={d.responderPara} onChange={(e) => muda("responderPara", e.target.value)} placeholder="igual ao endereço da conta" />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-co`}>Cópia oculta de todas as respostas (opcional)</label>
                <input id={`${ids}-co`} className="input" type="email" value={d.copiaOculta} onChange={(e) => muda("copiaOculta", e.target.value)} placeholder="ex.: arquivo@exemplo.com.br" />
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-as`}>Assinatura das respostas</label>
              <textarea id={`${ids}-as`} className="input" rows={5} maxLength={4000} value={d.assinatura} onChange={(e) => muda("assinatura", e.target.value)} placeholder={"--\n{atendente}\nSua empresa · CFTV"} />
              <span className="field__help">{"{atendente}"} vira o nome de quem respondeu. O número do chamado entra no assunto: "[#10241] …".</span>
            </div>
          </div>
        )}

        {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}

        {resultado && (
          <div className="em-resultado" aria-live="polite">
            <b>Resultado do teste · {formatDateTime(resultado.em)}</b>
            {resultado.passos.map((p, i) => (
              <div key={i} className="em-passo">
                <i className={p.ok ? "em-passo--ok" : "em-passo--er"} aria-hidden="true">{p.ok ? "✓" : "!"}</i>
                <span>{p.passo}</span>
                <small>{p.detalhe}</small>
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <div className="em-acoes">
        {podeEditar && conta && (
          <button type="button" className="btn btn--danger" disabled={ocupado || excluir.isPending} onClick={() => setConfirmarExcluir(true)}>Excluir</button>
        )}
        <button type="button" className="btn btn--outline" onClick={onFechar}>{podeEditar ? "Cancelar" : "Voltar"}</button>
        {podeEditar && (
          <div className="em-acoes__dir">
            <button type="button" className="btn btn--outline" disabled={ocupado} onClick={() => void testarAgora()}>{testar.isPending ? "Testando…" : "Testar configurações"}</button>
            <button type="button" className="btn btn--outline" disabled={ocupado} onClick={() => void salvarENova()}>Salvar e criar um novo</button>
            <button type="button" className="btn btn--primary" disabled={ocupado} onClick={() => void salvarEFechar()}>{salvar.isPending ? "Salvando…" : "Salvar"}</button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmarExcluir}
        onOpenChange={setConfirmarExcluir}
        title="Excluir a conta?"
        description={`${conta?.email ?? ""} deixa de existir no portal e a senha guardada é apagada. Se a conta já recebeu e-mails, desabilite em vez de excluir.`}
        confirmLabel="Excluir"
        tone="danger"
        isPending={excluir.isPending}
        onConfirm={() =>
          conta &&
          excluir.mutate(conta.id, {
            onSuccess: () => { toast.success("Conta excluída"); setConfirmarExcluir(false); onFechar(); },
            onError: (e) => { toast.error(msgErro(e, "Não foi possível excluir.")); setConfirmarExcluir(false); },
          })
        }
      />
    </section>
  );
}

function Chk({ id, rotulo, ajuda, checked, onChange }: { id: string; rotulo: string; ajuda?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="em-chk">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <label htmlFor={id}>{rotulo}</label>
        {ajuda && <span className="field__help">{ajuda}</span>}
      </div>
    </div>
  );
}
