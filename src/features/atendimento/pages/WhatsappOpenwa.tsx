import * as Switch from "@radix-ui/react-switch";
import { AlignLeft, CheckCircle2, CircleAlert, CircleDot, Info, KeyRound, Link2, MonitorSmartphone, Phone, QrCode, RefreshCw, Smartphone, Trash2, Upload, User, UserCheck, Users } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { formatDateTime } from "../../../utils/dates";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { Notice } from "../../configuracoes/components/Notice";
import { ServiceError } from "../../configuracoes/services/types";
import {
  useGruposOpenwa,
  useImportarLinhas,
  useLigarOpenwa,
  useLinhas,
  useMembrosGrupo,
  usePainelOpenwa,
  useQrOpenwa,
  useRemoverLinha,
  useSalvarConexaoOpenwa,
  useSalvarNumeroWhatsapp,
  useSalvarSetorWhatsapp,
  useAdicionarAtendentesGrupo,
  useCriarGrupoInterno,
  useSalvarWhatsappAtendente,
  useTestarOpenwa,
} from "../hooks/useAtendimento";
import { openwaService, type LinhaImportar, type NumeroWhatsapp, type PainelOpenwa, type SetorWhatsapp } from "../services/openwa";
import { telefone } from "./util";
import "./Atendimento.css";

// Administração › WhatsApp OpenWA (mockup aprovado em 09/10/2026, tela 6). Opção A: o colaborador fala no
// privado com o número do sistema do setor; cada pedido vai para o grupo interno só de atendentes; a resposta
// que cita o pedido chega ao colaborador. A Zenvia continua para os números que ficarem com ela.

const erroMsg = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);

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

export function WhatsappOpenwa() {
  const painel = usePainelOpenwa();
  if (painel.isPending) return <PageSkeleton />;
  if (painel.isError) {
    const proibido = painel.error instanceof ServiceError && painel.error.code === "FORBIDDEN";
    return proibido ? (
      <div className="card">
        <EmptyState icon={Smartphone} title="Só a gestão do atendimento" description="Esta tela é da supervisão geral e dos gestores de setor (Setores e números)." />
      </div>
    ) : (
      <ErrorState message="Não foi possível carregar o WhatsApp OpenWA." onRetry={() => void painel.refetch()} />
    );
  }
  const p = painel.data;
  return (
    <div className="ow">
      <Notice icon={Info}>
        O colaborador manda mensagem no <b>privado</b> para o número do sistema do setor. Cada pedido vira ticket e é repassado ao <b>grupo interno</b> dos
        atendentes; quem responde <b>citando</b> o pedido (no celular ou pelo portal) fala com o colaborador. Escrever <b>RESOLVIDO</b> (no portal, no grupo ou no
        celular do número) resolve o ticket e avisa o colaborador com o número do chamado. As respostas automáticas do OpenWA são ligadas em cada setor, abaixo.
      </Notice>
      <Conexao p={p} />
      {p.setores.length === 0 && (
        <div className="card">
          <EmptyState icon={Smartphone} title="Nenhum setor" description="Cadastre o setor e o número do sistema em Administração › Setores e números." />
        </div>
      )}
      {p.setores.map((s) => (
        <SetorCard key={s.id} s={s} p={p} />
      ))}
      <Linhas podeEditar={p.supervisor} dominios={p.conexao.dominios} />
    </div>
  );
}

// ---------------------------------------------------------------- conexão

function Conexao({ p }: { p: PainelOpenwa }) {
  const ids = useId();
  const salvar = useSalvarConexaoOpenwa();
  const testar = useTestarOpenwa();
  const ligar = useLigarOpenwa();
  const [confirmarDesligar, setConfirmarDesligar] = useState(false);
  const mudarLigado = (v: boolean) =>
    ligar.mutate(v, {
      onSuccess: (r) => {
        setConfirmarDesligar(false);
        toast.success(r.ligado ? "WhatsApp OpenWA ligado" : `WhatsApp OpenWA desligado${r.canceladas ? ` · ${r.canceladas} envio(s) pendente(s) cancelado(s)` : ""}`);
      },
      onError: (e) => {
        setConfirmarDesligar(false);
        toast.error(erroMsg(e, "Não foi possível mudar."));
      },
    });
  const [url, setUrl] = useState(p.conexao.url ?? "");
  const [chave, setChave] = useState("");
  const v = p.conexao.verificacao;
  useEffect(() => setUrl(p.conexao.url ?? ""), [p.conexao.url]);

  return (
    <section className="card at-sec" aria-labelledby={`${ids}-t`}>
      <div className="at-mon-head" style={{ padding: 0, border: 0 }}>
        <div style={{ flex: 1 }}>
          <h2 id={`${ids}-t`}>Conexão com o OpenWA</h2>
          <p className="at-sec__ajuda">
            Endereço do OpenWA (na validação, o túnel do cloudflared da máquina do Wagner; depois, a Hostinger) e a API key, que fica no cofre do Supabase.
          </p>
        </div>
        {p.supervisor && (
          <button
            type="button"
            className="btn btn--outline"
            disabled={testar.isPending || !p.conexao.url}
            onClick={() => testar.mutate(undefined, { onSuccess: (r) => (r.ok ? toast.success("OpenWA respondeu") : toast.error(r.erro ?? "OpenWA não respondeu")), onError: (e) => toast.error(erroMsg(e, "Falha ao testar.")) })}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {testar.isPending ? "Testando…" : "Testar conexão"}
          </button>
        )}
      </div>
      <div className={`ow-geral${p.conexao.ligado ? "" : " ow-geral--off"}`}>
        <Switch.Root
          className="switch"
          checked={p.conexao.ligado}
          disabled={!p.podeLigar || ligar.isPending}
          aria-labelledby={`${ids}-lig`}
          onCheckedChange={(v) => (v ? mudarLigado(true) : setConfirmarDesligar(true))}
        >
          <Switch.Thumb className="switch__thumb" />
        </Switch.Root>
        <span>
          <b id={`${ids}-lig`}>{p.conexao.ligado ? "WhatsApp OpenWA ligado" : "WhatsApp OpenWA desligado"}</b>
          <small>
            {p.conexao.ligado
              ? "Recebe as mensagens dos números OpenWA, abre os tickets e envia as respostas."
              : "Nada é recebido nem enviado pelo OpenWA: as mensagens que chegarem são ignoradas e as abas Conversas e Monitor de atendimento ficam ocultas. A configuração fica guardada; a Zenvia e o e-mail seguem normais."}
            {!p.podeLigar && " Só o Administrador ou o Super admin muda esta chave."}
          </small>
        </span>
      </div>
      <ConfirmDialog
        open={confirmarDesligar}
        onOpenChange={setConfirmarDesligar}
        title="Desligar o WhatsApp OpenWA?"
        description="As mensagens que chegarem aos números OpenWA deixam de virar conversa e ticket, e nada é enviado por eles (inclusive o grupo interno). Os envios que estavam esperando são cancelados e as abas Conversas e Monitor de atendimento ficam ocultas para todos. A configuração fica guardada para religar depois."
        confirmLabel="Desligar"
        tone="warning"
        isPending={ligar.isPending}
        onConfirm={() => mudarLigado(false)}
      />
      <div className="zv-passos">
        <Passo ok={p.conexao.url ? (v ? v.ok : null) : false} titulo="Endereço e API key">
          {p.conexao.url ? <>{p.conexao.url} · chave {p.conexao.chaveMascara ?? "não informada"}</> : "Ainda não informado."}
          {v && <> · testado em {formatDateTime(v.em)}</>}
          {v?.erro && <em className="zv-erro">{v.erro}</em>}
        </Passo>
      </div>
      {p.superAdmin && (
        <form
          className="zv-inline"
          onSubmit={(e) => {
            e.preventDefault();
            salvar.mutate(
              { url: url.trim(), ...(chave.trim() ? { chave: chave.trim() } : {}) },
              { onSuccess: () => { setChave(""); toast.success("Conexão salva"); }, onError: (er) => toast.error(erroMsg(er, "Não foi possível salvar.")) },
            );
          }}
        >
          <label className="visually-hidden" htmlFor={`${ids}-url`}>URL do OpenWA</label>
          <input id={`${ids}-url`} className="input" placeholder="https://xxxx.trycloudflare.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label className="visually-hidden" htmlFor={`${ids}-ch`}>API key</label>
          <input id={`${ids}-ch`} className="input" type="password" autoComplete="off" placeholder={p.conexao.chaveMascara ? "Nova API key (substitui)" : "API key (data/.api-key)"} value={chave} onChange={(e) => setChave(e.target.value)} />
          <button type="submit" className="btn btn--primary" disabled={!url.trim() || salvar.isPending}>
            <KeyRound size={15} aria-hidden="true" />
            Salvar
          </button>
        </form>
      )}
      {v && v.sessoes.length > 0 && (
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr><th><ThLabel icon={MonitorSmartphone}>Sessão no OpenWA</ThLabel></th><th><ThLabel icon={Phone}>Telefone</ThLabel></th><th><ThLabel icon={CircleDot}>Status</ThLabel></th></tr>
            </thead>
            <tbody>
              {v.sessoes.map((s) => (
                <tr key={s.id}>
                  <td>{s.nome ?? s.id}<br /><small className="ow-mudo">{s.id}</small></td>
                  <td>{s.telefone ? telefone(s.telefone) : "—"}</td>
                  <td><span className={`at-selo ${s.status === "ready" ? "s-ok" : "s-warn"}`}>{s.status ?? "?"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- setor

function SetorCard({ s, p }: { s: SetorWhatsapp; p: PainelOpenwa }) {
  const ids = useId();
  const salvar = useSalvarSetorWhatsapp();
  const [ident, setIdent] = useState(s.waIdentificar);
  const [soCorp, setSoCorp] = useState(s.waSoCorporativo);
  const [auto, setAuto] = useState(s.waRespostasAuto);
  const [descricao, setDescricao] = useState(s.waPedirDescricao);
  const [msg, setMsg] = useState(s.msgNaoCorporativo);
  const mudou = ident !== s.waIdentificar || soCorp !== s.waSoCorporativo || auto !== s.waRespostasAuto || descricao !== s.waPedirDescricao || msg !== s.msgNaoCorporativo;

  return (
    <section className="card at-sec" aria-labelledby={`${ids}-t`}>
      <h2 id={`${ids}-t`}>Setor {s.nome}</h2>

      <div className="ow-regras">
        <label className="ow-chave">
          <Switch.Root className="switch" checked={auto} disabled={!s.gestor} onCheckedChange={setAuto}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <span>
            <b>Respostas automáticas</b>
            <small>Boas-vindas, perguntas de identificação e a mensagem final com o número do chamado. Vale para os números OpenWA do setor (a Zenvia segue a chave dela).</small>
          </span>
        </label>
        <label className="ow-chave">
          <Switch.Root className="switch" checked={ident} disabled={!s.gestor} onCheckedChange={setIdent}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <span>
            <b>Identificar o colaborador no 1º contato</b>
            <small>Pergunta "Você é Fulano (e-mail)?" ou pede nome e e-mail @{p.conexao.dominios.join(", @")}. Confirmado uma vez, não pergunta mais.</small>
          </span>
        </label>
        <label className="ow-chave">
          <Switch.Root className="switch" checked={descricao} disabled={!s.gestor} onCheckedChange={setDescricao}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <span>
            <b>Pedir a descrição do problema e o print</b>
            <small>Depois de identificar, se a 1ª mensagem não explicou (ex.: "Oi", "Bom dia"), pergunta "Descreva em poucas palavras qual é o problema e, se puder, envie um print da tela".</small>
          </span>
        </label>
        <label className="ow-chave">
          <Switch.Root className="switch" checked={soCorp} disabled={!s.gestor} onCheckedChange={setSoCorp}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <span>
            <b>Só linhas corporativas</b>
            <small>Número fora da lista de linhas corporativas recebe a mensagem abaixo e não abre ticket.</small>
          </span>
        </label>
        <label className="field">
          <span className="field__label">Mensagem para quem não é linha corporativa</span>
          <textarea className="input" rows={2} maxLength={1000} value={msg} disabled={!s.gestor} onChange={(e) => setMsg(e.target.value)} />
        </label>
        {s.gestor && mudou && (
          <div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={salvar.isPending}
              onClick={() => salvar.mutate({ setorId: s.id, waIdentificar: ident, waSoCorporativo: soCorp, waRespostasAuto: auto, waPedirDescricao: descricao, msgNaoCorporativo: msg }, { onSuccess: () => toast.success("Regras salvas"), onError: (e) => toast.error(erroMsg(e, "Não foi possível salvar.")) })}
            >
              Salvar regras
            </button>
          </div>
        )}
      </div>

      <h3 className="ow-sub">Números do setor</h3>
      {s.numeros.length === 0 && <p className="at-vazio">Nenhum número. Cadastre em Setores e números.</p>}
      {s.numeros.map((n) => (
        <NumeroLinha key={n.id} n={n} p={p} />
      ))}

      <h3 className="ow-sub">Atendentes · WhatsApp pessoal</h3>
      <p className="at-sec__ajuda">É pelo número que o sistema sabe quem respondeu no grupo interno. Só atendentes do setor falam com o colaborador.</p>
      <Atendentes s={s} />
    </section>
  );
}

function NumeroLinha({ n, p }: { n: NumeroWhatsapp; p: PainelOpenwa }) {
  const ids = useId();
  const salvar = useSalvarNumeroWhatsapp();
  const criarGrupo = useCriarGrupoInterno();
  const adicionar = useAdicionarAtendentesGrupo();
  const [canal, setCanal] = useState(n.canal);
  const [sessao, setSessao] = useState(n.sessao ?? "");
  const [grupo, setGrupo] = useState(n.grupo ?? "");
  const [qr, setQr] = useState(false);
  const grupos = useGruposOpenwa(canal === "openwa" && n.sessao ? n.sessao : null);
  const sessoes = p.conexao.verificacao?.sessoes ?? [];
  const mudou = canal !== n.canal || sessao !== (n.sessao ?? "") || grupo !== (n.grupo ?? "");
  const grupoNome = grupos.data?.find((g) => g.id === grupo)?.name ?? n.grupoNome;

  const cadastrarWebhook = async () => {
    try {
      const r = await openwaService.webhook(n.sessao!);
      toast.success(r.criado ? "Webhook cadastrado no OpenWA" : "O webhook já estava cadastrado");
    } catch (e) {
      toast.error(erroMsg(e, "O OpenWA recusou o webhook."));
    }
  };

  return (
    <div className="ow-numero">
      <div className="ow-numero__linha">
        <b>{telefone(n.numero)}</b>
        <label className="visually-hidden" htmlFor={`${ids}-c`}>Canal</label>
        <select id={`${ids}-c`} className="input input--sm" value={canal} disabled={!p.supervisor} onChange={(e) => setCanal(e.target.value as "zenvia" | "openwa")}>
          <option value="zenvia">Zenvia (oficial)</option>
          <option value="openwa">OpenWA (opção A)</option>
        </select>
        {canal === "openwa" && (
          <>
            <label className="visually-hidden" htmlFor={`${ids}-s`}>Sessão do OpenWA</label>
            {sessoes.length > 0 ? (
              <select id={`${ids}-s`} className="input input--sm" value={sessao} disabled={!p.supervisor} onChange={(e) => setSessao(e.target.value)}>
                <option value="">— sessão —</option>
                {sessoes.map((x) => (
                  <option key={x.id} value={x.id}>{x.nome ?? x.id}{x.telefone ? ` · ${telefone(x.telefone)}` : ""}</option>
                ))}
              </select>
            ) : (
              <input id={`${ids}-s`} className="input input--sm" placeholder="id da sessão (Testar conexão lista)" value={sessao} disabled={!p.supervisor} onChange={(e) => setSessao(e.target.value)} />
            )}
            <label className="visually-hidden" htmlFor={`${ids}-g`}>Grupo interno</label>
            <select id={`${ids}-g`} className="input input--sm" value={grupo} disabled={!p.supervisor || !n.sessao} onChange={(e) => setGrupo(e.target.value)}>
              <option value="">{n.sessao ? "— grupo interno —" : "salve a sessão antes"}</option>
              {n.grupo && !grupos.data?.some((g) => g.id === n.grupo) && <option value={n.grupo}>{n.grupoNome ?? n.grupo}</option>}
              {(grupos.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </>
        )}
        {p.supervisor && mudou && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={salvar.isPending}
            onClick={() =>
              salvar.mutate(
                { numeroId: n.id, canal, sessao: canal === "openwa" ? sessao.trim() || null : null, grupo: canal === "openwa" ? grupo || null : null, grupoNome: canal === "openwa" ? grupoNome ?? null : null },
                { onSuccess: () => toast.success("Número salvo"), onError: (e) => toast.error(erroMsg(e, "Não foi possível salvar.")) },
              )
            }
          >
            Salvar
          </button>
        )}
      </div>
      {n.canal === "openwa" && n.sessao && p.supervisor && (
        <div className="ow-numero__acoes">
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setQr((x) => !x)}>
            <QrCode size={14} aria-hidden="true" /> {qr ? "Fechar QR" : "Parear (QR)"}
          </button>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => void cadastrarWebhook()}>
            <Link2 size={14} aria-hidden="true" /> Cadastrar webhook
          </button>
          {!n.grupo && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={criarGrupo.isPending}
              onClick={() =>
                criarGrupo.mutate(n.id, {
                  onSuccess: (r) => toast.success(`Grupo "${r.nome}" criado com ${r.participantes} atendente(s) e ligado a este número`),
                  onError: (e) => toast.error(erroMsg(e, "O OpenWA não criou o grupo."), { duration: 20_000 }),
                })
              }
            >
              <Users size={14} aria-hidden="true" /> {criarGrupo.isPending ? "Criando…" : "Criar grupo interno"}
            </button>
          )}
          <button type="button" className="btn btn--outline btn--sm" disabled={grupos.isFetching} onClick={() => void grupos.refetch()}>
            <RefreshCw size={14} aria-hidden="true" /> {grupos.isFetching ? "Atualizando…" : "Atualizar grupos"}
          </button>
          {n.grupo && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={adicionar.isPending}
              onClick={() =>
                adicionar.mutate(n.id, {
                  onSuccess: (r) => {
                    const msg = `${r.adicionados} atendente(s) adicionado(s) ao grupo${r.jaEstavam ? ` · ${r.jaEstavam} já estavam` : ""}`;
                    if (r.falhas.length) toast.warning(`${msg} · não entraram: ${r.falhas.map((f) => `${telefone(f.numero)} (${f.motivo})`).join(", ")}`, { duration: 20_000 });
                    else toast.success(msg);
                  },
                  onError: (e) => toast.error(erroMsg(e, "O OpenWA não adicionou os atendentes.")),
                })
              }
            >
              <Users size={14} aria-hidden="true" /> {adicionar.isPending ? "Adicionando…" : "Adicionar atendentes ao grupo"}
            </button>
          )}
          {grupos.isError && <em className="zv-erro">{erroMsg(grupos.error, "Não foi possível listar os grupos.")}</em>}
        </div>
      )}
      {n.canal === "openwa" && n.sessao && !n.grupo && (
        <p className="at-sec__ajuda">
          Sem grupo interno ainda. Se "Criar grupo interno" avisar que esta sessão não cria grupos (engine whatsapp-web.js), crie o grupo no celular do número
          {` ${telefone(n.numero)}`} com pelo menos um atendente, clique em "Atualizar grupos", escolha o grupo acima, salve e depois use "Adicionar atendentes ao grupo".
        </p>
      )}
      {qr && n.sessao && <PainelQr sessao={n.sessao} />}
    </div>
  );
}

function PainelQr({ sessao }: { sessao: string }) {
  const qr = useQrOpenwa(sessao, true);
  return (
    <div className="ow-qr">
      {qr.data?.qr ? (
        <img src={qr.data.qr} alt="QR Code para parear o WhatsApp do número do sistema" width={220} height={220} />
      ) : (
        <p className="at-vazio">{qr.isPending ? "Buscando o QR…" : (qr.data?.erro ?? "Sem QR: a sessão já está pareada ou ainda está iniciando.")}</p>
      )}
      <p className="at-sec__ajuda">No celular do chip do sistema: WhatsApp › Aparelhos conectados › Conectar um aparelho. O QR se renova sozinho.</p>
    </div>
  );
}

function Atendentes({ s }: { s: SetorWhatsapp }) {
  const salvar = useSalvarWhatsappAtendente();
  const numero = s.numeros.find((n) => n.canal === "openwa" && n.sessao && n.grupo) ?? null;
  const membros = useMembrosGrupo(numero?.sessao ?? null, numero?.grupo ?? null);
  const [edicao, setEdicao] = useState<Record<string, string>>({});
  const doGrupo = useMemo(() => new Set((membros.data ?? []).map((m) => m.numero)), [membros.data]);
  const conhecidos = new Set(s.atendentes.map((a) => a.whatsapp).filter(Boolean));
  const estranhos = (membros.data ?? []).filter((m) => !conhecidos.has(m.numero) && m.numero !== numero?.numero);

  return (
    <div className="at-tab-wrap">
      <table className="at-tab">
        <thead>
          <tr><th><ThLabel icon={UserCheck}>Atendente</ThLabel></th><th><ThLabel icon={Phone}>WhatsApp pessoal</ThLabel></th>{numero && <th><ThLabel icon={Users}>No grupo interno?</ThLabel></th>}<th /></tr>
        </thead>
        <tbody>
          {s.atendentes.length === 0 && <tr><td colSpan={4} className="at-vazio">Nenhum atendente no setor (Fila e horários).</td></tr>}
          {s.atendentes.map((a) => {
            const valor = edicao[a.usuarioId] ?? a.whatsapp ?? "";
            return (
              <tr key={a.usuarioId}>
                <td>{a.nome}</td>
                <td>
                  <input className="input input--sm" aria-label={`WhatsApp de ${a.nome}`} placeholder="(21) 99999-9999" value={valor} disabled={!s.gestor}
                         onChange={(e) => setEdicao((x) => ({ ...x, [a.usuarioId]: e.target.value }))} />
                </td>
                {numero && <td>{a.whatsapp ? (membros.isPending ? "…" : doGrupo.has(a.whatsapp) ? <span className="at-selo s-ok">Sim</span> : <span className="at-selo s-warn">Não está</span>) : "—"}</td>}
                <td>
                  {s.gestor && edicao[a.usuarioId] !== undefined && edicao[a.usuarioId] !== (a.whatsapp ?? "") && (
                    <button type="button" className="btn btn--primary btn--sm" disabled={salvar.isPending}
                            onClick={() => salvar.mutate({ usuarioId: a.usuarioId, whatsapp: valor }, { onSuccess: () => { toast.success("WhatsApp salvo"); setEdicao((x) => { const { [a.usuarioId]: _, ...resto } = x; return resto; }); }, onError: (e) => toast.error(erroMsg(e, "Não foi possível salvar.")) })}>
                      Salvar
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {estranhos.length > 0 && (
        <p className="at-sec__ajuda">
          <CircleAlert size={13} aria-hidden="true" /> No grupo interno, sem atendente ligado: {estranhos.map((m) => m.nome ?? telefone(m.numero)).join(", ")}. As mensagens deles são ignoradas.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- linhas corporativas

/** "numero;nome;email;observacao" por linha (vírgula ou tab também). Cabeçalho é ignorado. */
export function lerPlanilha(texto: string): LinhaImportar[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.split(/[;\t,]/).map((x) => x.trim().replace(/^"|"$/g, "")))
    .filter((c) => c[0] && /\d{8,}/.test(c[0].replace(/\D/g, "")))
    .map(([numero, nome, email, observacao]) => ({ numero: numero!, ...(nome ? { nome } : {}), ...(email ? { email } : {}), ...(observacao ? { observacao } : {}) }));
}

function Linhas({ podeEditar, dominios }: { podeEditar: boolean; dominios: string[] }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const [q, setQ] = useState("");
  const linhas = useLinhas(q);
  const importar = useImportarLinhas();
  const remover = useRemoverLinha();
  const [texto, setTexto] = useState("");
  const [abrirImport, setAbrirImport] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(busca), 300);
    return () => clearTimeout(t);
  }, [busca]);
  const lidas = lerPlanilha(texto);

  const lerArquivo = async (f: File | undefined) => {
    if (f) setTexto(await f.text());
  };

  return (
    <section className="card at-sec" aria-labelledby={`${ids}-t`}>
      <div className="at-mon-head" style={{ padding: 0, border: 0 }}>
        <div style={{ flex: 1 }}>
          <h2 id={`${ids}-t`}>Linhas corporativas</h2>
          <p className="at-sec__ajuda">Quem pode abrir ticket pelo WhatsApp nos setores com "Só linhas corporativas". Com e-mail (@{dominios.join(", @")}), a pessoa já fica ligada; o colaborador confirma no 1º contato.</p>
        </div>
        {podeEditar && (
          <button type="button" className="btn btn--outline" onClick={() => setAbrirImport((x) => !x)}>
            <Upload size={15} aria-hidden="true" /> Importar planilha
          </button>
        )}
      </div>

      {abrirImport && (
        <div className="ow-import">
          <label className="field">
            <span className="field__label">Cole as linhas (número; nome; e-mail; observação) ou escolha um .csv</span>
            <textarea className="input" rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={"21996453552;Vinicius Carvalho;vinicius.carvalho@exemplo.com.br;TI\n21988881111;;;Diretoria"} />
          </label>
          <div className="zv-inline">
            <input type="file" accept=".csv,.txt" aria-label="Arquivo da planilha (.csv)" onChange={(e) => void lerArquivo(e.target.files?.[0])} />
            <button
              type="button"
              className="btn btn--primary"
              disabled={lidas.length === 0 || importar.isPending}
              onClick={() =>
                importar.mutate(lidas, {
                  onSuccess: (r) => {
                    toast.success(`${r.salvas} linha(s) salvas${r.invalidas.length ? ` · ${r.invalidas.length} inválida(s): ${r.invalidas.slice(0, 5).join(", ")}` : ""}`);
                    setTexto("");
                    setAbrirImport(false);
                  },
                  onError: (e) => toast.error(erroMsg(e, "Não foi possível importar.")),
                })
              }
            >
              {importar.isPending ? "Importando…" : `Importar ${lidas.length} linha(s)`}
            </button>
          </div>
        </div>
      )}

      <label className="visually-hidden" htmlFor={`${ids}-b`}>Buscar</label>
      <input id={`${ids}-b`} className="input" type="search" placeholder="Buscar número, nome ou observação" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <div className="at-tab-wrap">
        <table className="at-tab">
          <thead>
            <tr><th><ThLabel icon={Phone}>Número</ThLabel></th><th><ThLabel icon={User}>Pessoa</ThLabel></th><th><ThLabel icon={CircleDot}>Situação</ThLabel></th><th><ThLabel icon={AlignLeft}>Observação</ThLabel></th>{podeEditar && <th />}</tr>
          </thead>
          <tbody>
            {linhas.isPending && <tr><td colSpan={5} className="at-vazio">Carregando…</td></tr>}
            {linhas.isError && <tr><td colSpan={5} className="at-vazio">{erroMsg(linhas.error, "Não foi possível carregar as linhas.")}</td></tr>}
            {linhas.data?.length === 0 && <tr><td colSpan={5} className="at-vazio">Nenhuma linha{q ? " para esta busca" : ""}.</td></tr>}
            {(linhas.data ?? []).map((l) => (
              <tr key={l.numero}>
                <td>{telefone(l.numero)}</td>
                <td>{l.pessoa ?? "—"}{l.email && <><br /><small className="ow-mudo">{l.email}</small></>}</td>
                <td>
                  {!l.corporativa ? <span className="at-selo s-info">Confirmada (não corporativa)</span>
                    : l.confirmadoEm ? <span className="at-selo s-ok">Confirmada {formatDateTime(l.confirmadoEm)}</span>
                    : <span className="at-selo s-warn">Aguardando 1º contato</span>}
                </td>
                <td>{l.observacao ?? "—"}</td>
                {podeEditar && (
                  <td>
                    <button type="button" className="btn btn--outline btn--sm" aria-label={`Remover ${l.numero}`} disabled={remover.isPending}
                            onClick={() => remover.mutate(l.numero, { onSuccess: () => toast.success("Linha removida"), onError: (e) => toast.error(erroMsg(e, "Não foi possível remover.")) })}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
