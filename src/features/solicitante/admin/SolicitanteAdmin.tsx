import * as Popover from "@radix-ui/react-popover";
import * as Switch from "@radix-ui/react-switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlignLeft, ArrowUpDown, Building2, CalendarRange, Copy, ExternalLink, Eye, Hash, Info, LayoutDashboard, Lightbulb, Megaphone, Pencil, Plus, Smartphone, Smile, Trash2, Wrench } from "lucide-react";
import qrcode from "qrcode-generator";
import { useId, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { DetailDialog } from "../../../components/ds/DetailDialog";
import { ThLabel } from "../../../components/ds";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { Notice } from "../../configuracoes/components/Notice";
import { ICONES_SETOR } from "../iconesSetor.data";
import { ICONE_PADRAO, IconeSetor } from "../IconeSetor";
import { solicitanteApi, formatarTelefone, type AvisoAdmin, type PainelSolicitante, type Quadros, type SetorApp, type SolucaoAdmin } from "../service";
import "../../atendimento/pages/Atendimento.css";
import "./solicitanteAdmin.css";

// Administração › App do solicitante (docs/PLANO-app-solicitante.md, Fase 4): endereço e QR do app, simular solicitante,
// departamentos no app, quadros, avisos do carrossel e soluções publicadas.

const CHAVE = ["cd", "painel"];
const QUADROS: { id: keyof Quadros; nome: string }[] = [
  { id: "meus", nome: "📋 Meus chamados" },
  { id: "avisos", nome: "📣 Avisos (carrossel e tela)" },
  { id: "solucoes", nome: "💡 Soluções (e a dica ao abrir chamado)" },
  { id: "whatsapp", nome: "💬 Falar no WhatsApp" },
  { id: "perfil", nome: "👤 Meu perfil" },
];
const TIPOS: { id: AvisoAdmin["tipo"]; nome: string }[] = [
  { id: "comunicado", nome: "Comunicado" },
  { id: "manutencao", nome: "Manutenção" },
  { id: "alerta", nome: "Alerta" },
  { id: "resolvido", nome: "Resolvido" },
];
const DH = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function situacao(a: AvisoAdmin): { texto: string; classe: string } {
  const agora = Date.now();
  if (!a.ativo) return { texto: "Desligado", classe: "cdadm-tag" };
  if (Date.parse(a.inicio) > agora) return { texto: "Agendado", classe: "cdadm-tag" };
  if (a.fim && Date.parse(a.fim) <= agora) return { texto: "Encerrado", classe: "cdadm-tag" };
  return { texto: "No ar", classe: "cdadm-tag cdadm-tag--ok" };
}

/** datetime-local ↔ ISO no fuso do navegador. */
const paraLocal = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const deLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export function SolicitanteAdmin() {
  const painel = useQuery({ queryKey: CHAVE, queryFn: solicitanteApi.painel });
  if (painel.isPending) return <PageSkeleton />;
  if (painel.isError) return <ErrorState message={painel.error.message} onRetry={() => void painel.refetch()} />;
  return <Conteudo p={painel.data} />;
}

function Conteudo({ p }: { p: PainelSolicitante }) {
  return (
    <div className="cdadm">
      <div className="cdadm-g2">
        <OApp p={p} />
        <Quadros p={p} />
      </div>
      <Departamentos setores={p.setores} />
      <div className="cdadm-g2">
        <AvisosAdmin p={p} />
        <SolucoesAdmin p={p} />
      </div>
    </div>
  );
}

function useSalvar<T>(fn: (v: T) => Promise<unknown>, ok: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(ok);
      void qc.invalidateQueries({ queryKey: CHAVE });
      void qc.invalidateQueries({ queryKey: ["cd"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

function OApp({ p }: { p: PainelSolicitante }) {
  const url = `${window.location.origin}/app`;
  const qr = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    return q.createDataURL(5, 2);
  }, [url]);
  const [simular, setSimular] = useState(false);
  return (
    <section className="card cdadm-box" aria-labelledby="cdadm-app">
      <h2 id="cdadm-app">O app</h2>
      <p className="cdadm-desc">Endereço que os colaboradores abrem no celular ou no computador.</p>
      <div className="cdadm-linha">
        <input className="input" value={url} readOnly aria-label="Endereço do app" />
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success("Endereço copiado."), () => toast.error("Não foi possível copiar."))}
        >
          <Copy size={15} aria-hidden="true" /> Copiar
        </button>
        <a className="btn btn--primary" href="/app" target="_blank" rel="noreferrer">
          <ExternalLink size={15} aria-hidden="true" /> Abrir app
        </a>
      </div>
      <div className="cdadm-qr">
        <img src={qr} alt={`QR Code de ${url}`} width={140} height={140} />
        <div>
          <p className="cdadm-desc">QR para cartaz e e-mail interno.</p>
          <a className="btn btn--outline" href={qr} download="solicitante-qr.gif">
            Baixar QR
          </a>
          <div style={{ height: 8 }} />
          <button type="button" className="btn btn--outline" onClick={() => setSimular(true)}>
            <Eye size={15} aria-hidden="true" /> Simular solicitante…
          </button>
          <p className="cdadm-desc" style={{ marginTop: 6 }}>
            Abre o app como a pessoa escolhida (barra amarela "Modo simulação"), sem enviar nada em nome dela.
          </p>
        </div>
      </div>
      <div className="cdadm-kpis">
        <span>
          <b>{p.solicitantes}</b> solicitantes cadastrados
        </span>
        <span>
          <b>{p.chamadosApp30d}</b> chamados pelo app em 30 dias
        </span>
      </div>
      <Notice icon={Info}>
        Acesso: quem é da empresa entra com o próprio e-mail e senha (ou cria em "Primeiro acesso") e ganha o perfil <b>Solicitante</b>, que só
        vê o app. Os chamados entram com origem <b>Portal</b> (recebido em "App do solicitante"), no departamento escolhido.
      </Notice>
      {simular && <Simular onFechar={() => setSimular(false)} />}
    </section>
  );
}

function Simular({ onFechar }: { onFechar: () => void }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const pessoas = useQuery({ queryKey: ["cd", "pessoas", busca], queryFn: () => solicitanteApi.pessoas(busca), enabled: busca.trim().length >= 2 });
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title="Simular solicitante" description="Escolha quem já entrou no App do solicitante (ou usa o portal).">
      <label className="field__label" htmlFor={`${ids}-b`}>
        Nome ou e-mail
      </label>
      <input id={`${ids}-b`} className="input" autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite ao menos 2 letras" />
      <ul className="cdadm-pessoas">
        {(pessoas.data ?? []).map((u) => (
          <li key={u.id}>
            <span>
              <b>{u.nome}</b>
              <small>
                {u.email} · {u.perfil ?? "sem perfil"}
              </small>
            </span>
            <a className="btn btn--outline" href={`/app?simular=${u.id}`} target="_blank" rel="noreferrer" onClick={onFechar}>
              Abrir como
            </a>
          </li>
        ))}
        {busca.trim().length >= 2 && pessoas.data?.length === 0 && <li className="cdadm-desc">Ninguém encontrado.</li>}
      </ul>
    </DetailDialog>
  );
}

function Quadros({ p }: { p: PainelSolicitante }) {
  const ids = useId();
  const [wa, setWa] = useState(formatarTelefone(p.config.whatsapp));
  const [bv, setBv] = useState(p.config.boasVindas);
  const salvar = useSalvar(solicitanteApi.salvarConfig, "Configuração salva.");
  return (
    <section className="card cdadm-box" aria-labelledby="cdadm-q">
      <h2 id="cdadm-q">Quadros do app</h2>
      <p className="cdadm-desc">O botão ABRIR CHAMADO e "Trocar departamento" ficam sempre visíveis.</p>
      <table className="at-tab">
        <thead>
          <tr>
            <th><ThLabel icon={LayoutDashboard}>Quadro</ThLabel></th>
            <th className="c"><ThLabel icon={Eye}>Visível</ThLabel></th>
          </tr>
        </thead>
        <tbody>
          {QUADROS.map((q) => (
            <tr key={q.id}>
              <td id={`${ids}-${q.id}`}>{q.nome}</td>
              <td className="c">
                <Switch.Root
                  className="switch"
                  checked={p.config.quadros[q.id] !== false}
                  disabled={salvar.isPending}
                  aria-labelledby={`${ids}-${q.id}`}
                  onCheckedChange={(v) => salvar.mutate({ quadros: { [q.id]: v } })}
                >
                  <Switch.Thumb className="switch__thumb" />
                </Switch.Root>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="cdadm-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          salvar.mutate({ whatsapp: wa, boasVindas: bv });
        }}
      >
        <label className="field__label" htmlFor={`${ids}-wa`}>
          WhatsApp do suporte (quadro "Falar no WhatsApp")
        </label>
        <input id={`${ids}-wa`} className="input" inputMode="tel" placeholder="(21) 96974-0876" value={wa} onChange={(e) => setWa(e.target.value)} />
        <label className="field__label" htmlFor={`${ids}-bv`}>
          Texto de boas-vindas (abaixo do "Olá, Nome")
        </label>
        <input id={`${ids}-bv`} className="input" maxLength={120} value={bv} onChange={(e) => setBv(e.target.value)} />
        <div>
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>
            Salvar
          </button>
        </div>
      </form>
    </section>
  );
}

function Departamentos({ setores }: { setores: SetorApp[] }) {
  return (
    <section className="card cdadm-box" aria-labelledby="cdadm-d">
      <h2 id="cdadm-d">Departamentos no app</h2>
      <p className="cdadm-desc">
        São os Setores cadastrados. Ligue os que aparecem na tela "Com qual departamento você precisa falar?". O menu "Tipo de serviço" mostra os
        Serviços do setor marcados para o canal <b>Portal</b> (Administração › Serviços).
      </p>
      <div className="at-tab-wrap">
        <table className="at-tab">
          <thead>
            <tr>
              <th><ThLabel icon={Building2}>Departamento</ThLabel></th>
              <th><ThLabel icon={Smile}>Ícone</ThLabel></th>
              <th><ThLabel icon={AlignLeft}>Texto de ajuda</ThLabel></th>
              <th className="n"><ThLabel icon={ArrowUpDown}>Ordem</ThLabel></th>
              <th className="n"><ThLabel icon={Wrench}>Serviços no Portal</ThLabel></th>
              <th className="c"><ThLabel icon={Smartphone}>No app</ThLabel></th>
              <th />
            </tr>
          </thead>
          <tbody>
            {setores.map((s) => (
              <LinhaSetor key={`${s.id}-${s.visivel}-${s.icone}-${s.descricao}-${s.ordem}`} s={s} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LinhaSetor({ s }: { s: SetorApp }) {
  const [icone, setIcone] = useState(s.icone ?? "");
  const [descricao, setDescricao] = useState(s.descricao ?? "");
  const [ordem, setOrdem] = useState(String(s.ordem));
  const salvar = useSalvar((p: Parameters<typeof solicitanteApi.salvarSetor>[1]) => solicitanteApi.salvarSetor(s.id, p), `${s.nome}: salvo.`);
  const mudou = icone !== (s.icone ?? "") || descricao !== (s.descricao ?? "") || ordem !== String(s.ordem);
  return (
    <tr>
      <td>
        <b>{s.nome}</b>
      </td>
      <td>
        <SeletorIcone valor={icone} nome={s.nome} onChange={setIcone} />
      </td>
      <td>
        <input className="input" value={descricao} maxLength={200} placeholder="O que esse departamento atende" aria-label={`Texto de ajuda de ${s.nome}`} onChange={(e) => setDescricao(e.target.value)} />
      </td>
      <td className="n">
        <input className="input cdadm-ordem" type="number" min={0} value={ordem} aria-label={`Ordem de ${s.nome}`} onChange={(e) => setOrdem(e.target.value)} />
      </td>
      <td className="n">{s.servicos === 0 ? <span title="Sem serviços: o solicitante descreve e a equipe classifica.">0 ⚠</span> : s.servicos}</td>
      <td className="c">
        <Switch.Root className="switch" checked={s.visivel} disabled={salvar.isPending} aria-label={`${s.nome} no app`} onCheckedChange={(v) => salvar.mutate({ visivel: v })}>
          <Switch.Thumb className="switch__thumb" />
        </Switch.Root>
      </td>
      <td>
        {mudou && (
          <button type="button" className="btn btn--primary" disabled={salvar.isPending} onClick={() => salvar.mutate({ icone, descricao, ordem: Number(ordem) || 0 })}>
            Salvar
          </button>
        )}
      </td>
    </tr>
  );
}

/** Ícone do departamento: grade dos ícones coloridos (Iconify, embutidos) ou um emoji digitado. */
function SeletorIcone({ valor, nome, onChange }: { valor: string; nome: string; onChange: (v: string) => void }) {
  const [aberto, setAberto] = useState(false);
  const [emoji, setEmoji] = useState(valor.includes(":") ? "" : valor);
  const escolher = (v: string) => {
    onChange(v);
    setAberto(false);
  };
  return (
    <Popover.Root open={aberto} onOpenChange={setAberto}>
      <Popover.Trigger asChild>
        <button type="button" className="input cdadm-icone" aria-label={`Ícone de ${nome}: trocar`} title="Trocar ícone">
          <IconeSetor valor={valor || ICONE_PADRAO} tamanho={24} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="ch-filtropop cdadm-icones" align="start" sideOffset={6} collisionPadding={12} aria-label={`Ícone de ${nome}`}>
          <div className="cdadm-icones__grade" role="listbox" aria-label="Ícones">
            {ICONES_SETOR.map((i) => (
              <button key={i.nome} type="button" role="option" aria-selected={valor === i.nome} title={i.rotulo} aria-label={i.rotulo} onClick={() => escolher(i.nome)}>
                <IconeSetor valor={i.nome} tamanho={28} />
              </button>
            ))}
          </div>
          <label className="cdadm-icones__emoji">
            <span>Ou um emoji</span>
            <input className="input" value={emoji} maxLength={4} placeholder="🎫" onChange={(e) => setEmoji(e.target.value)} onKeyDown={(e) => e.key === "Enter" && emoji.trim() && escolher(emoji.trim())} />
            <button type="button" className="btn btn--outline btn--sm" disabled={!emoji.trim()} onClick={() => escolher(emoji.trim())}>Usar</button>
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AvisosAdmin({ p }: { p: PainelSolicitante }) {
  const [editando, setEditando] = useState<Partial<AvisoAdmin> | null>(null);
  const [excluir, setExcluir] = useState<AvisoAdmin | null>(null);
  const qc = useQueryClient();
  const remover = useMutation({
    mutationFn: (id: number) => solicitanteApi.excluirAviso(id),
    onSuccess: () => {
      toast.success("Aviso excluído.");
      setExcluir(null);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const nomeSetor = (id: number | null) => (id ? (p.setores.find((s) => s.id === id)?.nome ?? "—") : "Todos");
  return (
    <section className="card cdadm-box" aria-labelledby="cdadm-av">
      <div className="cdadm-topo">
        <div>
          <h2 id="cdadm-av">Avisos (carrossel)</h2>
          <p className="cdadm-desc">Aparecem no topo do app e na tela Avisos, no período definido.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setEditando({ tipo: "comunicado", ativo: true, setorId: null })}>
          <Plus size={15} aria-hidden="true" /> Novo aviso
        </button>
      </div>
      {p.avisos.length === 0 ? (
        <p className="cdadm-desc">Nenhum aviso cadastrado.</p>
      ) : (
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Megaphone}>Aviso</ThLabel></th>
                <th><ThLabel icon={Building2}>Departamento</ThLabel></th>
                <th><ThLabel icon={CalendarRange}>Período</ThLabel></th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {p.avisos.map((a) => {
                const st = situacao(a);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.titulo}
                      <br />
                      <small className="cdadm-desc">{TIPOS.find((t) => t.id === a.tipo)?.nome}</small>
                    </td>
                    <td>{nomeSetor(a.setorId)}</td>
                    <td>
                      {DH.format(new Date(a.inicio))} → {a.fim ? DH.format(new Date(a.fim)) : "sem fim"}
                    </td>
                    <td>
                      <span className={st.classe}>{st.texto}</span>
                    </td>
                    <td className="cdadm-acoes">
                      <button type="button" className="btn btn--outline" aria-label={`Editar ${a.titulo}`} onClick={() => setEditando(a)}>
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" className="btn btn--outline" aria-label={`Excluir ${a.titulo}`} onClick={() => setExcluir(a)}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editando && <FormAviso inicial={editando} setores={p.setores} onFechar={() => setEditando(null)} />}
      <ConfirmDialog
        open={excluir !== null}
        onOpenChange={(o) => !o && setExcluir(null)}
        title="Excluir aviso?"
        description={`"${excluir?.titulo ?? ""}" sai do app. Para só tirar do ar, edite e desligue.`}
        confirmLabel="Excluir"
        tone="danger"
        isPending={remover.isPending}
        onConfirm={() => excluir && remover.mutate(excluir.id)}
      />
    </section>
  );
}

function FormAviso({ inicial, setores, onFechar }: { inicial: Partial<AvisoAdmin>; setores: SetorApp[]; onFechar: () => void }) {
  const ids = useId();
  const [v, setV] = useState({
    titulo: inicial.titulo ?? "",
    texto: inicial.texto ?? "",
    tipo: inicial.tipo ?? "comunicado",
    setorId: inicial.setorId ?? null,
    link: inicial.link ?? "",
    inicio: paraLocal(inicial.inicio ?? new Date().toISOString()),
    fim: paraLocal(inicial.fim),
    ativo: inicial.ativo ?? true,
  });
  const salvar = useSalvar(solicitanteApi.salvarAviso, "Aviso salvo.");
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    salvar.mutate(
      { id: inicial.id, titulo: v.titulo, texto: v.texto, tipo: v.tipo, setorId: v.setorId, link: v.link || null, inicio: deLocal(v.inicio) ?? undefined, fim: deLocal(v.fim), ativo: v.ativo },
      { onSuccess: onFechar },
    );
  };
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title={inicial.id ? "Editar aviso" : "Novo aviso"}>
      <form className="cdadm-form" onSubmit={enviar}>
        <label className="field__label" htmlFor={`${ids}-t`}>Título</label>
        <input id={`${ids}-t`} className="input" maxLength={90} required value={v.titulo} onChange={(e) => setV({ ...v, titulo: e.target.value })} placeholder="PVI em manutenção hoje às 18h" />
        <label className="field__label" htmlFor={`${ids}-x`}>Texto</label>
        <textarea id={`${ids}-x`} className="input" maxLength={600} rows={3} value={v.texto} onChange={(e) => setV({ ...v, texto: e.target.value })} />
        <div className="cdadm-2col">
          <span>
            <label className="field__label" htmlFor={`${ids}-tp`}>Tipo</label>
            <select id={`${ids}-tp`} className="input" value={v.tipo} onChange={(e) => setV({ ...v, tipo: e.target.value as AvisoAdmin["tipo"] })}>
              {TIPOS.map((t) => (
                <option key={t.id} value={t.id}>{t.nome}</option>
              ))}
            </select>
          </span>
          <span>
            <label className="field__label" htmlFor={`${ids}-s`}>Departamento</label>
            <select id={`${ids}-s`} className="input" value={v.setorId ?? ""} onChange={(e) => setV({ ...v, setorId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Todos</option>
              {setores.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </span>
          <span>
            <label className="field__label" htmlFor={`${ids}-i`}>Início</label>
            <input id={`${ids}-i`} className="input" type="datetime-local" value={v.inicio} onChange={(e) => setV({ ...v, inicio: e.target.value })} />
          </span>
          <span>
            <label className="field__label" htmlFor={`${ids}-f`}>Fim (opcional)</label>
            <input id={`${ids}-f`} className="input" type="datetime-local" value={v.fim} onChange={(e) => setV({ ...v, fim: e.target.value })} />
          </span>
        </div>
        <label className="field__label" htmlFor={`${ids}-l`}>Link "Saber mais" (opcional)</label>
        <input id={`${ids}-l`} className="input" type="url" placeholder="https://" value={v.link} onChange={(e) => setV({ ...v, link: e.target.value })} />
        <label className="ow-chave">
          <Switch.Root className="switch" checked={v.ativo} onCheckedChange={(x) => setV({ ...v, ativo: x })}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <span>Ligado</span>
        </label>
        <div className="cdadm-botoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>{salvar.isPending ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </DetailDialog>
  );
}

function SolucoesAdmin({ p }: { p: PainelSolicitante }) {
  const [editando, setEditando] = useState<Partial<SolucaoAdmin> | null>(null);
  const [excluir, setExcluir] = useState<SolucaoAdmin | null>(null);
  const qc = useQueryClient();
  const publicar = useSalvar((s: SolucaoAdmin) => solicitanteApi.salvarSolucao({ ...s, publicado: !s.publicado }), "Solução atualizada.");
  const remover = useMutation({
    mutationFn: (id: number) => solicitanteApi.excluirSolucao(id),
    onSuccess: () => {
      toast.success("Solução excluída.");
      setExcluir(null);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="card cdadm-box" aria-labelledby="cdadm-so">
      <div className="cdadm-topo">
        <div>
          <h2 id="cdadm-so">Soluções publicadas</h2>
          <p className="cdadm-desc">Textos revisados, sem dados pessoais. Aparecem em "Soluções" e como dica ao abrir chamado do mesmo serviço.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setEditando({ publicado: true, setorId: p.setores[0]?.id })}>
          <Plus size={15} aria-hidden="true" /> Nova
        </button>
      </div>
      {p.solucoes.length > 0 && (
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr>
                <th><ThLabel icon={Lightbulb}>Solução</ThLabel></th>
                <th><ThLabel icon={Wrench}>Serviço</ThLabel></th>
                <th className="n"><ThLabel icon={Hash}>Usos</ThLabel></th>
                <th className="c"><ThLabel icon={Smartphone}>No app</ThLabel></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.solucoes.map((s) => (
                <tr key={s.id}>
                  <td>{s.titulo}</td>
                  <td>{s.servico ?? p.setores.find((x) => x.id === s.setorId)?.nome ?? "—"}</td>
                  <td className="n">{s.usos}</td>
                  <td className="c">
                    <Switch.Root className="switch" checked={s.publicado} disabled={publicar.isPending} aria-label={`${s.titulo} no app`} onCheckedChange={() => publicar.mutate(s)}>
                      <Switch.Thumb className="switch__thumb" />
                    </Switch.Root>
                  </td>
                  <td className="cdadm-acoes">
                    <button type="button" className="btn btn--outline" aria-label={`Editar ${s.titulo}`} onClick={() => setEditando(s)}>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button type="button" className="btn btn--outline" aria-label={`Excluir ${s.titulo}`} onClick={() => setExcluir(s)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.sugestoes.length > 0 && (
        <details className="cdadm-sug">
          <summary>Publicar a partir de tickets resolvidos ({p.sugestoes.length})</summary>
          <ul>
            {p.sugestoes.map((s) => (
              <li key={s.ticketId}>
                <span>
                  <b>#{s.ticketId}</b> {s.assunto}
                  <small>{s.servico ?? "sem serviço"} · {s.solucao.slice(0, 120)}</small>
                </span>
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={() => setEditando({ ticketId: s.ticketId, setorId: s.setorId, servicoId: s.servicoId, titulo: s.assunto.slice(0, 120), texto: s.solucao, publicado: true })}
                >
                  Revisar e publicar
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editando && <FormSolucao inicial={editando} setores={p.setores} onFechar={() => setEditando(null)} />}
      <ConfirmDialog
        open={excluir !== null}
        onOpenChange={(o) => !o && setExcluir(null)}
        title="Excluir solução?"
        description={`"${excluir?.titulo ?? ""}" sai do app. Para só esconder, desligue "No app".`}
        confirmLabel="Excluir"
        tone="danger"
        isPending={remover.isPending}
        onConfirm={() => excluir && remover.mutate(excluir.id)}
      />
    </section>
  );
}

function FormSolucao({ inicial, setores, onFechar }: { inicial: Partial<SolucaoAdmin>; setores: SetorApp[]; onFechar: () => void }) {
  const ids = useId();
  const [setorId, setSetorId] = useState<number | undefined>(inicial.setorId);
  const [servicoId, setServicoId] = useState<number | null>(inicial.servicoId ?? null);
  const [titulo, setTitulo] = useState(inicial.titulo ?? "");
  const [texto, setTexto] = useState(inicial.texto ?? "");
  const servicos = useQuery({ queryKey: ["cd", "servicos-adm", setorId], queryFn: () => solicitanteApi.servicos(setorId!), enabled: Boolean(setorId) });
  const salvar = useSalvar(solicitanteApi.salvarSolucao, "Solução salva.");
  // Serviço com o caminho completo: "Sistemas › TOTVS › PVI".
  const opcoes = useMemo(() => {
    const lista = servicos.data ?? [];
    const porId = new Map(lista.map((s) => [s.id, s]));
    const trilha = (id: number): string => {
      const s = porId.get(id);
      return s ? (s.paiId ? `${trilha(s.paiId)} › ${s.nome}` : s.nome) : "";
    };
    return lista.map((s) => ({ id: s.id, nome: trilha(s.id) })).sort((a, b) => a.nome.localeCompare(b.nome));
  }, [servicos.data]);
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    salvar.mutate({ id: inicial.id, ticketId: inicial.ticketId ?? null, setorId, servicoId, titulo, texto, publicado: inicial.publicado ?? true }, { onSuccess: onFechar });
  };
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title={inicial.id ? "Editar solução" : "Publicar solução"} description="Revise o texto: ele aparece para todos os colaboradores.">
      <form className="cdadm-form" onSubmit={enviar}>
        <div className="cdadm-2col">
          <span>
            <label className="field__label" htmlFor={`${ids}-s`}>Departamento</label>
            <select id={`${ids}-s`} className="input" value={setorId ?? ""} onChange={(e) => { setSetorId(Number(e.target.value) || undefined); setServicoId(null); }}>
              {setores.map((s) => (
                <option key={s.id} value={s.id}>{s.nome}</option>
              ))}
            </select>
          </span>
          <span>
            <label className="field__label" htmlFor={`${ids}-sv`}>Serviço (opcional)</label>
            <select id={`${ids}-sv`} className="input" value={servicoId ?? ""} onChange={(e) => setServicoId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Qualquer serviço</option>
              {opcoes.map((o) => (
                <option key={o.id} value={o.id}>{o.nome}</option>
              ))}
            </select>
          </span>
        </div>
        <label className="field__label" htmlFor={`${ids}-t`}>Título</label>
        <input id={`${ids}-t`} className="input" maxLength={120} value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Esqueci a senha do Windows" />
        <label className="field__label" htmlFor={`${ids}-x`}>Como resolver</label>
        <textarea id={`${ids}-x`} className="input" rows={6} maxLength={4000} value={texto} onChange={(e) => setTexto(e.target.value)} />
        <div className="cdadm-botoes">
          <button type="button" className="btn btn--outline" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>{salvar.isPending ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </DetailDialog>
  );
}
