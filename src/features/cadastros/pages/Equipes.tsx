import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { Building2, CircleDot, Crown, Plus, Users, UsersRound, X } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ThLabel } from "../../../components/ds";
import { getMenuItem } from "../../../config/menuRegistry";
import { configBreadcrumb } from "../../configuracoes/components/configBreadcrumb";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { PageHeader } from "../../configuracoes/components/PageHeader";
import { ServiceError } from "../../configuracoes/services/types";
import "../../configuracoes/components/Sheet.css";
import { useCandidatosEquipe, useEquipes, useExcluirEquipe, useSalvarEquipe, useSetoresEquipe } from "../hooks/useCadastros";
import type { Equipe, PessoaUsuario } from "../services/equipes";
import "./Cadastros.css";

const usuarios = getMenuItem("manage_users");
const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

/** Configurações › Usuários › Equipes. */
export function Equipes({ nav }: { nav?: ReactNode }) {
  const equipes = useEquipes();
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<Equipe | "nova" | null>(null);
  const ids = useId();
  const q = busca.trim().toLowerCase();
  const visiveis = useMemo(
    () => (equipes.data ?? []).filter((e) => !q || `${e.nome} ${e.setorNome ?? ""} ${e.membros.map((m) => m.nome).join(" ")}`.toLowerCase().includes(q)),
    [equipes.data, q],
  );

  return (
    <>
      <Breadcrumb items={[...configBreadcrumb(usuarios.label).slice(0, -1), { label: usuarios.label, to: usuarios.path }, { label: "Equipes" }]} />
      <PageHeader title={usuarios.label} description="Quem pode entrar no sistema, com qual perfil, e em quais equipes trabalha." />
      {nav}
      {equipes.isPending ? (
        <PageSkeleton />
      ) : equipes.isError ? (
        <ErrorState message="Não foi possível carregar as equipes." onRetry={() => void equipes.refetch()} />
      ) : (
        <section className="card" aria-labelledby={`${ids}-t`}>
          <div className="ca-head">
            <div className="ca-head__tit">
              <h2 id={`${ids}-t`}>Equipes</h2>
              <small>Grupos de atendentes dentro de um setor. Um usuário pode estar em mais de uma equipe.</small>
            </div>
            <label className="visually-hidden" htmlFor={`${ids}-b`}>Pesquisar</label>
            <input id={`${ids}-b`} className="input ca-busca" type="search" placeholder="Pesquisar equipe, setor ou membro" value={busca} onChange={(e) => setBusca(e.target.value)} />
            <button type="button" className="btn btn--primary" onClick={() => setEditando("nova")}>
              <Plus size={16} aria-hidden="true" />
              Nova equipe
            </button>
          </div>
          {(equipes.data ?? []).length === 0 ? (
            <EmptyState icon={UsersRound} title="Nenhuma equipe ainda" description="Crie a primeira equipe e escolha os membros." />
          ) : (
            <div className="at-tab-wrap">
              <table className="at-tab ca-tab">
                <thead>
                  <tr>
                    <th><ThLabel icon={UsersRound}>Equipe</ThLabel></th>
                    <th><ThLabel icon={Building2}>Setor</ThLabel></th>
                    <th><ThLabel icon={Users}>Membros</ThLabel></th>
                    <th><ThLabel icon={Crown}>Líder</ThLabel></th>
                    <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((e) => (
                    <tr key={e.id} className={e.ativa ? undefined : "ca-inativa"} tabIndex={0} onClick={() => setEditando(e)} onKeyDown={(k) => k.key === "Enter" && setEditando(e)}>
                      <td>
                        <b>{e.nome}</b>
                        {e.descricao && <small className="ca-sub">{e.descricao}</small>}
                      </td>
                      <td>{e.setorNome ? <span className="at-tag">{e.setorNome}</span> : <span className="ca-muted">Sem setor</span>}</td>
                      <td>
                        <span className="ca-avs">
                          {e.membros.slice(0, 5).map((m) => (
                            <span key={m.id} className="ca-av" title={m.nome}>{iniciais(m.nome)}</span>
                          ))}
                        </span>{" "}
                        {e.membros.length}
                      </td>
                      <td>{e.lider?.nome ?? "—"}</td>
                      <td><span className={`ca-st ${e.ativa ? "ca-st--ok" : "ca-st--inat"}`}>{e.ativa ? "Ativa" : "Inativa"}</span></td>
                    </tr>
                  ))}
                  {visiveis.length === 0 && (
                    <tr><td colSpan={5} className="at-vazio">Nenhuma equipe com essa busca.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="ca-rodape">No cadastro do usuário (Editar usuário) também aparece o campo <b>Equipes</b>: é o mesmo vínculo desta tela.</p>
        </section>
      )}
      <EquipeSheet estado={editando} onFechar={() => setEditando(null)} />
    </>
  );
}

function EquipeSheet({ estado, onFechar }: { estado: Equipe | "nova" | null; onFechar: () => void }) {
  return (
    <Dialog.Root open={estado !== null} onOpenChange={(o) => !o && onFechar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          {estado !== null && <EquipeForm key={estado === "nova" ? "nova" : estado.id} equipe={estado === "nova" ? null : estado} onFechar={onFechar} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EquipeForm({ equipe, onFechar }: { equipe: Equipe | null; onFechar: () => void }) {
  const ids = useId();
  const salvar = useSalvarEquipe();
  const excluir = useExcluirEquipe();
  const candidatos = useCandidatosEquipe(true);
  const setores = useSetoresEquipe(true);
  const [nome, setNome] = useState(equipe?.nome ?? "");
  const [setorId, setSetorId] = useState<number | null>(equipe?.setorId ?? null);
  const [descricao, setDescricao] = useState(equipe?.descricao ?? "");
  const [membros, setMembros] = useState<PessoaUsuario[]>(equipe?.membros ?? []);
  const [liderId, setLiderId] = useState<string | null>(equipe?.lider?.id ?? null);
  const [ativa, setAtiva] = useState(equipe?.ativa ?? true);
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const fora = (candidatos.data ?? []).filter((c) => !membros.some((m) => m.id === c.id));

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: equipe?.id, nome, setorId, descricao, liderId, ativa, membros: membros.map((m) => m.id) },
      {
        onSuccess: () => {
          toast.success(equipe ? "Equipe salva" : "Equipe criada");
          onFechar();
        },
        onError: (er) => setErro(er instanceof ServiceError ? { campo: er.field, mensagem: er.message } : { mensagem: "Não foi possível salvar a equipe." }),
      },
    );
  };

  return (
    <form className="sheet__form" onSubmit={enviar}>
      <header className="sheet__header">
        <div>
          <Dialog.Title className="sheet__title">{equipe ? `Editar equipe · ${equipe.nome}` : "Nova equipe"}</Dialog.Title>
          <p className="sheet__description">Grupo de atendentes que recebe chamados juntos.</p>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Fechar"><X size={18} aria-hidden="true" /></button>
        </Dialog.Close>
      </header>
      <div className="sheet__body">
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-n`}>Nome da equipe</label>
          <input id={`${ids}-n`} className="input" maxLength={60} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Cobrança" autoFocus />
          {erro?.campo === "nome" && <span className="field__error" role="alert">{erro.mensagem}</span>}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-s`}>Setor</label>
          <select id={`${ids}-s`} className="input" value={setorId ?? ""} onChange={(e) => setSetorId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— Sem setor (equipe interna)</option>
            {(setores.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.nome}</option>
            ))}
          </select>
          <span className="field__help">A equipe pertence a um setor: os chamados do setor poderão ir direto para ela.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-d`}>Descrição (opcional)</label>
          <textarea id={`${ids}-d`} className="input" rows={3} maxLength={500} value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="O que esta equipe atende" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-m`}>Membros</label>
          {membros.length > 0 ? (
            <div className="ca-chips">
              {membros.map((m) => (
                <span key={m.id} className="ca-chip">
                  {m.nome}
                  <button type="button" aria-label={`Tirar ${m.nome}`} onClick={() => { setMembros((ms) => ms.filter((x) => x.id !== m.id)); if (liderId === m.id) setLiderId(null); }}>
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span className="field__help">Nenhum membro ainda.</span>
          )}
          <select id={`${ids}-m`} className="input" value="" disabled={candidatos.isPending} onChange={(e) => { const c = fora.find((x) => x.id === e.target.value); if (c) setMembros((ms) => [...ms, c]); }}>
            <option value="">{candidatos.isPending ? "Carregando…" : "Adicionar usuário…"}</option>
            {fora.map((c) => (
              <option key={c.id} value={c.id}>{c.nome}</option>
            ))}
          </select>
          {erro?.campo === "membros" && <span className="field__error" role="alert">{erro.mensagem}</span>}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-l`}>Líder (opcional)</label>
          <select id={`${ids}-l`} className="input" value={liderId ?? ""} onChange={(e) => setLiderId(e.target.value || null)}>
            <option value="">—</option>
            {membros.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        </div>
        <div className="zv-chave">
          <Switch.Root id={`${ids}-a`} className="switch" checked={ativa} onCheckedChange={setAtiva}>
            <Switch.Thumb className="switch__thumb" />
          </Switch.Root>
          <div>
            <label htmlFor={`${ids}-a`}><b>Equipe ativa</b></label>
            <span>Inativa: não recebe chamados, mas mantém o histórico.</span>
          </div>
        </div>
        {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}
      </div>
      <footer className="sheet__footer">
        {equipe && (
          <button type="button" className="btn btn--danger-outline btn--lg ca-esq" disabled={excluir.isPending} onClick={() => setConfirmar(true)}>Excluir</button>
        )}
        <Dialog.Close asChild>
          <button type="button" className="btn btn--outline btn--lg">Cancelar</button>
        </Dialog.Close>
        <button type="submit" className="btn btn--primary btn--lg" disabled={salvar.isPending}>{salvar.isPending ? "Salvando…" : "Salvar"}</button>
      </footer>
      <ConfirmDialog
        open={confirmar}
        onOpenChange={setConfirmar}
        title="Excluir a equipe?"
        description={`A equipe ${equipe?.nome ?? ""} deixa de existir e os membros saem dela. Os usuários continuam no sistema.`}
        confirmLabel="Excluir"
        tone="danger"
        isPending={excluir.isPending}
        onConfirm={() => equipe && excluir.mutate(equipe.id, { onSuccess: () => { toast.success("Equipe excluída"); setConfirmar(false); onFechar(); }, onError: (e) => { toast.error(e instanceof ServiceError ? e.message : "Não foi possível excluir."); setConfirmar(false); } })}
      />
    </form>
  );
}
