import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Building, CalendarClock, CalendarPlus, CircleDot, Contact, Download, GitMerge, HardDrive, IdCard, ImagePlus, Inbox, Mail, Paperclip, Phone, Plus, Shapes, Ticket, Trash2, User, UserPen, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "../../../components/Breadcrumb";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ThLabel } from "../../../components/ds";
import { getMenuItem } from "../../../config/menuRegistry";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import { formatDateTime } from "../../../utils/dates";
import { configBreadcrumb } from "../../configuracoes/components/configBreadcrumb";
import { ConfirmDialog } from "../../configuracoes/components/ConfirmDialog";
import { EmptyState } from "../../configuracoes/components/EmptyState";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { PageHeader } from "../../configuracoes/components/PageHeader";
import { ServiceError } from "../../configuracoes/services/types";
import { A_IDENTIFICAR, useDefinirSetorNaPessoa, useSetoresOpcoes } from "../../chamados/setorSolicitante";
import "../../configuracoes/components/Sheet.css";
import { useAnexarPessoa, useBuscaPessoas, useExcluirPessoa, useMesclarPessoa, usePessoa, usePessoas, useRemoverAnexo, useSalvarPessoa } from "../hooks/useCadastros";
import {
  CLASSIFICACOES,
  pessoaNova,
  pessoasService,
  SINALIZADORES,
  type Contato,
  type FiltroPessoas,
  type OrigemPessoa,
  type PessoaDados,
  type PessoaDetalhe,
  type Relacao,
  type TipoContato,
  type TipoPessoa,
} from "../services/pessoas";
import "./Cadastros.css";

const item = getMenuItem("manage_pessoas");
const msgErro = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);
const TIPO: Record<TipoPessoa, string> = { pessoa: "Pessoa", empresa: "Empresa", departamento: "Departamento" };
const ORIGEM: Record<OrigemPessoa, { rotulo: string; classe: string }> = {
  manual: { rotulo: "Manual", classe: "ca-or--man" },
  email: { rotulo: "E-mail", classe: "ca-or--mail" },
  whatsapp: { rotulo: "WhatsApp", classe: "ca-or--wpp" },
  importacao: { rotulo: "Importação", classe: "ca-or--man" },
};
const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";

export function formatarDoc(d: string | null): string {
  if (!d) return "—";
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d;
}

export function formatarContato(tipo: TipoContato, v: string): string {
  if (tipo === "email") return v;
  if (/^55\d{10,11}$/.test(v)) return `+55 ${v.slice(2, 4)} ${v.slice(4, -4)}-${v.slice(-4)}`;
  return v;
}

function quando(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? "hoje" : d.toLocaleDateString("pt-BR");
}

/** Configurações › Pessoas. */
export function Pessoas() {
  const [editando, setEditando] = useState<number | "nova" | null>(null);
  return (
    <>
      <Breadcrumb items={editando === null ? configBreadcrumb(item.label) : [...configBreadcrumb(item.label).slice(0, -1), { label: item.label, to: item.path }, { label: editando === "nova" ? "Nova pessoa" : "Ficha" }]} />
      <PageHeader title={item.label} description={item.description} />
      {editando === null ? (
        <Lista onAbrir={setEditando} />
      ) : (
        <PessoaForm key={editando} id={editando === "nova" ? null : editando} onFechar={() => setEditando(null)} onAbrir={setEditando} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Lista

function Lista({ onAbrir }: { onAbrir: (id: number | "nova") => void }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const [tipo, setTipo] = useState<TipoPessoa | "">("");
  const [origem, setOrigem] = useState<OrigemPessoa | "">("");
  const [pagina, setPagina] = useState(1);
  const buscaDebounce = useDebouncedValue(busca, 300);
  const filtro: FiltroPessoas = { busca: buscaDebounce.trim().length >= 3 ? buscaDebounce : "", tipo, origem, pagina };
  const lista = usePessoas(filtro);
  const total = lista.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / 25));

  useEffect(() => setPagina(1), [buscaDebounce, tipo, origem]);

  const exportar = () => {
    const linhas = [["Nome", "Tipo", "CPF/CNPJ", "E-mail", "Telefone", "Empresa", "Origem", "Chamados", "Situação"], ...(lista.data?.linhas ?? []).map((p) => [p.nome, TIPO[p.tipo], formatarDoc(p.documento), p.email ?? "", p.telefone ? formatarContato("telefone", p.telefone) : "", p.empresa ?? "", ORIGEM[p.origem].rotulo, String(p.chamados), p.habilitada ? "Habilitada" : "Desabilitada"])];
    const csv = "﻿" + linhas.map((l) => l.map((v) => `"${v.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "pessoas.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (lista.isError) return <ErrorState message={msgErro(lista.error, "Não foi possível carregar as pessoas.")} onRetry={() => void lista.refetch()} />;

  return (
    <section className="card" aria-labelledby={`${ids}-t`}>
      <div className="ca-head">
        <div className="ca-head__tit">
          <h2 id={`${ids}-t`}>Pessoas</h2>
          <small>{lista.isPending ? "Carregando…" : `Exibindo ${lista.data?.linhas.length ?? 0} de um total de ${total} registro(s)`}</small>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => onAbrir("nova")}>
          <Plus size={16} aria-hidden="true" />
          Nova pessoa
        </button>
        <button type="button" className="btn btn--outline" disabled={!lista.data?.linhas.length} onClick={exportar}>
          <Download size={15} aria-hidden="true" />
          Exportar
        </button>
        <div className="ca-busca">
          <label className="visually-hidden" htmlFor={`${ids}-b`}>Pesquisar</label>
          <input id={`${ids}-b`} className="input" type="search" placeholder="Nome, e-mail, telefone, CPF/CNPJ ou Cód. Ref." value={busca} onChange={(e) => setBusca(e.target.value)} />
          <small>Digite pelo menos 3 caracteres para iniciar a busca.</small>
        </div>
        <label className="visually-hidden" htmlFor={`${ids}-tp`}>Tipo</label>
        <select id={`${ids}-tp`} className="input ca-sel" value={tipo} onChange={(e) => setTipo(e.target.value as TipoPessoa | "")}>
          <option value="">Todos os tipos</option>
          {(Object.keys(TIPO) as TipoPessoa[]).map((t) => (
            <option key={t} value={t}>{TIPO[t]}</option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${ids}-or`}>Origem</label>
        <select id={`${ids}-or`} className="input ca-sel" value={origem} onChange={(e) => setOrigem(e.target.value as OrigemPessoa | "")}>
          <option value="">Todas as origens</option>
          <option value="manual">Manual</option>
          <option value="email">E-mail</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>
      {lista.isPending ? (
        <PageSkeleton />
      ) : total === 0 && !filtro.busca && !tipo && !origem ? (
        <EmptyState icon={Contact} title="Nenhuma pessoa ainda" description="As pessoas aparecem aqui sozinhas no primeiro e-mail ou WhatsApp, ou cadastradas em Nova pessoa." />
      ) : (
        <div className="at-tab-wrap">
          <table className="at-tab ca-tab">
            <thead>
              <tr>
                <th><ThLabel icon={User}>Nome</ThLabel></th>
                <th><ThLabel icon={Shapes}>Tipo</ThLabel></th>
                <th><ThLabel icon={IdCard}>CPF/CNPJ</ThLabel></th>
                <th><ThLabel icon={Mail}>E-mail principal</ThLabel></th>
                <th><ThLabel icon={Phone}>Telefone</ThLabel></th>
                <th><ThLabel icon={Building}>Empresa</ThLabel></th>
                <th><ThLabel icon={Inbox}>Origem</ThLabel></th>
                <th className="n"><ThLabel icon={Ticket}>Chamados</ThLabel></th>
                <th><ThLabel icon={CalendarClock}>Último contato</ThLabel></th>
                <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {(lista.data?.linhas ?? []).map((p) => (
                <tr key={p.id} className={p.habilitada ? undefined : "ca-inativa"} tabIndex={0} onClick={() => onAbrir(p.id)} onKeyDown={(e) => e.key === "Enter" && onAbrir(p.id)}>
                  <td><span className="ca-av">{iniciais(p.nome)}</span> {p.nome}</td>
                  <td>{TIPO[p.tipo]}</td>
                  <td>{formatarDoc(p.documento)}</td>
                  <td>{p.email ?? "—"}</td>
                  <td>{p.telefone ? formatarContato("telefone", p.telefone) : "—"}</td>
                  <td>{p.empresa ?? "—"}</td>
                  <td><span className={`ca-or ${ORIGEM[p.origem].classe}`}>{ORIGEM[p.origem].rotulo}</span></td>
                  <td className="n">{p.chamados}</td>
                  <td>{quando(p.ultimoContatoEm)}</td>
                  <td><span className={`ca-st ${p.habilitada ? "ca-st--ok" : "ca-st--inat"}`}>{p.habilitada ? "Habilitada" : "Desabilitada"}</span></td>
                </tr>
              ))}
              {(lista.data?.linhas ?? []).length === 0 && (
                <tr><td colSpan={10} className="at-vazio">Nenhuma pessoa com esse filtro.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {paginas > 1 && (
        <div className="ca-paginas">
          <button type="button" className="btn btn--outline btn--sm" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>‹ Anterior</button>
          <span>Página {pagina} de {paginas}</span>
          <button type="button" className="btn btn--outline btn--sm" disabled={pagina >= paginas} onClick={() => setPagina((p) => p + 1)}>Próxima ›</button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Formulário

type Aba = "principal" | "contatos" | "relacoes" | "sinal" | "obs" | "anexos" | "hist";

function dadosDe(p: PessoaDetalhe): PessoaDados {
  return {
    tipo: p.tipo, nome: p.nome ?? "", razaoSocial: p.razaoSocial ?? "", ramo: p.ramo ?? "", documento: formatarDoc(p.documento).replace("—", ""),
    codRef: p.codRef ?? "", codRefAdicional: p.codRefAdicional ?? "", classificacao: p.classificacao ?? "Cliente", dominios: p.dominios ?? [],
    sinalizadores: p.sinalizadores ?? [], observacoes: p.observacoes ?? "", avatarPath: p.avatarPath ?? null, habilitada: p.habilitada,
    contatos: (p.contatos ?? []).map((c) => ({ tipo: c.tipo, valor: formatarContato(c.tipo, c.valor), principal: c.principal })),
    relacoes: (p.relacoes ?? []).map((r) => ({ pessoaId: r.pessoaId, cargo: r.cargo })),
  };
}

function PessoaForm({ id, onFechar, onAbrir }: { id: number | null; onFechar: () => void; onAbrir: (id: number | "nova") => void }) {
  const detalhe = usePessoa(id);
  if (id !== null && detalhe.isPending) return <PageSkeleton />;
  if (id !== null && detalhe.isError) return <ErrorState message={msgErro(detalhe.error, "Não foi possível abrir a pessoa.")} onRetry={() => void detalhe.refetch()} />;
  return <Ficha key={id ?? "nova"} pessoa={detalhe.data ?? null} onFechar={onFechar} onAbrir={onAbrir} />;
}

function Ficha({ pessoa, onFechar, onAbrir }: { pessoa: PessoaDetalhe | null; onFechar: () => void; onAbrir: (id: number | "nova") => void }) {
  const ids = useId();
  const salvar = useSalvarPessoa();
  const excluir = useExcluirPessoa();
  const [aba, setAba] = useState<Aba>("principal");
  const [d, setD] = useState<PessoaDados>(() => (pessoa ? dadosDe(pessoa) : pessoaNova()));
  const [rel, setRel] = useState<Relacao[]>(pessoa?.relacoes ?? []);
  const [dominios, setDominios] = useState((pessoa?.dominios ?? []).join(", "));
  const [erro, setErro] = useState<{ campo?: string; mensagem: string } | null>(null);
  const [confirmarExcluir, setConfirmarExcluir] = useState(false);
  const [mesclar, setMesclar] = useState(false);
  const [setorId, setSetorId] = useState<number | null>(pessoa?.setorId ?? null);
  const setores = useSetoresOpcoes();
  const definirSetor = useDefinirSetorNaPessoa();
  const muda = <K extends keyof PessoaDados>(k: K, v: PessoaDados[K]) => setD((x) => ({ ...x, [k]: v }));
  const empresa = d.tipo !== "pessoa";

  const gravar = async (): Promise<number | null> => {
    setErro(null);
    try {
      const id = await salvar.mutateAsync({
        ...d,
        id: pessoa?.id,
        dominios: empresa ? dominios.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) : [],
        contatos: d.contatos.filter((c) => c.valor.trim()),
        relacoes: rel.map((r) => ({ pessoaId: r.pessoaId, cargo: r.cargo })),
      });
      if (d.tipo === "pessoa" && setorId !== (pessoa?.setorId ?? null)) await definirSetor.mutateAsync({ pessoaId: id, setorId });
      return id;
    } catch (e) {
      if (e instanceof ServiceError) {
        setErro({ campo: e.field, mensagem: e.message });
        if (e.field === "contatos") setAba("contatos");
        else if (e.field === "relacoes") setAba("relacoes");
        else if (e.field) setAba("principal");
      } else toast.error("Não foi possível salvar.");
      return null;
    }
  };
  const salvarEFechar = async () => {
    if ((await gravar()) !== null) {
      toast.success("Pessoa salva");
      onFechar();
    }
  };
  const salvarENova = async () => {
    if ((await gravar()) !== null) {
      toast.success("Pessoa salva");
      onAbrir("nova");
    }
  };
  const erroDe = (campo: string) => (erro?.campo === campo ? <span className="field__error" role="alert">{erro.mensagem}</span> : null);

  const abas: { id: Aba; rotulo: string; n?: number; precisaSalvar?: boolean }[] = [
    { id: "principal", rotulo: "Principal" },
    { id: "contatos", rotulo: "Contatos", n: d.contatos.length },
    { id: "relacoes", rotulo: "Relações", n: rel.length },
    { id: "sinal", rotulo: "Sinalizadores", n: d.sinalizadores.length || undefined },
    { id: "obs", rotulo: "Observações" },
    { id: "anexos", rotulo: "Anexos", n: pessoa?.anexos.length, precisaSalvar: true },
    { id: "hist", rotulo: "Histórico de chamados", n: pessoa?.historico.length, precisaSalvar: true },
  ];

  return (
    <section className="card ca-form" aria-label={pessoa ? pessoa.nome : "Nova pessoa"}>
      <p className="ca-criado">
        {pessoa
          ? `${pessoa.origem === "manual" ? `Cadastrada manualmente${pessoa.criadoPor ? ` por ${pessoa.criadoPor}` : ""}` : `Criada automaticamente pelo ${ORIGEM[pessoa.origem].rotulo}${pessoa.origemDetalhe ? ` (${pessoa.origemDetalhe})` : ""}`} em ${formatDateTime(pessoa.criadoEm)}`
          : "Nova pessoa"}
      </p>
      <div className="em-abas" role="tablist" aria-label="Seções da pessoa">
        {abas.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={aba === a.id} className={`em-aba${aba === a.id ? " em-aba--on" : ""}`} disabled={a.precisaSalvar && !pessoa} title={a.precisaSalvar && !pessoa ? "Salve a pessoa primeiro" : undefined} onClick={() => setAba(a.id)}>
            {a.rotulo}
            {a.n ? <span className="ca-n">{a.n}</span> : null}
          </button>
        ))}
      </div>

      <div className="ca-corpo">
        <div className="em-pane">
          {aba === "principal" && (
            <>
              <div className="em-l2">
                <div className="field">
                  <span className="field__label" id={`${ids}-tipo`}>Tipo</span>
                  <div className="ca-radios" role="radiogroup" aria-labelledby={`${ids}-tipo`}>
                    {(Object.keys(TIPO) as TipoPessoa[]).map((t) => (
                      <label key={t}><input type="radio" name={`${ids}-tipo`} checked={d.tipo === t} onChange={() => muda("tipo", t)} /> {TIPO[t]}</label>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span className="field__label">Perfil</span>
                  <label className="ca-radios"><input type="checkbox" checked disabled /> Cliente</label>
                  <span className="field__help">Agentes são os Usuários do portal; aqui ficam só os clientes.</span>
                </div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-nome`}>{d.tipo === "pessoa" ? "Nome" : d.tipo === "empresa" ? "Nome fantasia" : "Nome do departamento"}</label>
                <input id={`${ids}-nome`} className="input" maxLength={160} value={d.nome} onChange={(e) => muda("nome", e.target.value)} />
                {erroDe("nome")}
              </div>
              {empresa && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-rz`}>Razão social</label>
                    <input id={`${ids}-rz`} className="input" maxLength={160} value={d.razaoSocial} onChange={(e) => muda("razaoSocial", e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-ra`}>Ramo de atividade</label>
                    <input id={`${ids}-ra`} className="input" maxLength={120} value={d.ramo} onChange={(e) => muda("ramo", e.target.value)} />
                  </div>
                </>
              )}
              <div className="em-l3 ca-l3">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-doc`}>{d.tipo === "pessoa" ? "CPF" : "CNPJ"}</label>
                  <input id={`${ids}-doc`} className="input" inputMode="numeric" value={d.documento} onChange={(e) => muda("documento", e.target.value)} placeholder={d.tipo === "pessoa" ? "000.000.000-00" : "00.000.000/0000-00"} />
                  {erroDe("documento")}
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-ref`}>Cód. Ref.</label>
                  <input id={`${ids}-ref`} className="input" maxLength={80} value={d.codRef} onChange={(e) => muda("codRef", e.target.value)} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-ref2`}>Cód. Ref. adicional</label>
                  <input id={`${ids}-ref2`} className="input" maxLength={80} value={d.codRefAdicional} onChange={(e) => muda("codRefAdicional", e.target.value)} />
                </div>
              </div>
              <span className="field__help">O código de referência liga a pessoa a outro sistema (ex.: o código do cliente no TOTVS RM). Opcional, mas recomendado para manter as bases em sincronia.</span>
              <div className="em-l2">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-cl`}>Classificação</label>
                  <select id={`${ids}-cl`} className="input" value={d.classificacao} onChange={(e) => muda("classificacao", e.target.value)}>
                    {[...new Set([...CLASSIFICACOES, d.classificacao])].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                {!empresa && (
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-setor`}>Setor</label>
                    <select id={`${ids}-setor`} className="input" value={setorId ?? ""} disabled={setores.isPending} onChange={(e) => setSetorId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">{A_IDENTIFICAR}</option>
                      {(setores.data ?? []).map((s) => (
                        <option key={s.id} value={s.id}>{s.nome}</option>
                      ))}
                    </select>
                    {erroDe("setorId")}
                    <span className="field__help">Vai para o campo Setor dos chamados que ela abrir. Os chamados abertos dela sem setor também recebem.</span>
                  </div>
                )}
                {empresa && (
                  <div className="field">
                    <label className="field__label" htmlFor={`${ids}-dom`}>Domínios de e-mail da empresa</label>
                    <input id={`${ids}-dom`} className="input" value={dominios} onChange={(e) => setDominios(e.target.value)} placeholder="casanovamoveis.com.br" />
                    {erroDe("dominios")}
                    <span className="field__help">E-mail novo desse domínio vira uma pessoa já ligada a esta empresa. Domínios públicos (gmail, hotmail…) não valem.</span>
                  </div>
                )}
              </div>
              <div className="field">
                <div className="ca-radios" role="radiogroup" aria-label="Situação">
                  <label><input type="radio" name={`${ids}-hab`} checked={d.habilitada} onChange={() => muda("habilitada", true)} /> Habilitado</label>
                  <label><input type="radio" name={`${ids}-hab`} checked={!d.habilitada} onChange={() => muda("habilitada", false)} /> Desabilitado</label>
                </div>
                <span className="field__help">Habilitada, a pessoa aparece no sistema. Desabilitada, some das buscas e os e-mails dela são ignorados.</span>
              </div>
            </>
          )}

          {aba === "contatos" && <Contatos contatos={d.contatos} onChange={(c) => muda("contatos", c)} />}
          {aba === "contatos" && erroDe("contatos")}

          {aba === "relacoes" && <Relacoes tipo={d.tipo} relacoes={rel} onChange={setRel} proprioId={pessoa?.id ?? null} />}
          {aba === "relacoes" && erroDe("relacoes")}

          {aba === "sinal" && <Sinalizadores lista={d.sinalizadores} onChange={(s) => muda("sinalizadores", s)} />}

          {aba === "obs" && (
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-obs`}>Observações internas (não são enviadas ao cliente)</label>
              <textarea id={`${ids}-obs`} className="input" rows={8} maxLength={8000} value={d.observacoes} onChange={(e) => muda("observacoes", e.target.value)} />
            </div>
          )}

          {aba === "anexos" && pessoa && <Anexos pessoa={pessoa} />}
          {aba === "hist" && pessoa && <Historico pessoa={pessoa} />}

          {erro && !erro.campo && <p className="field__error" role="alert">{erro.mensagem}</p>}
        </div>
        <Foto pessoa={pessoa} nome={d.nome} avatarPath={d.avatarPath} onTrocar={(path) => muda("avatarPath", path)} />
      </div>

      <div className="em-acoes">
        {pessoa && (
          <button type="button" className="btn btn--danger" disabled={excluir.isPending} onClick={() => setConfirmarExcluir(true)}>Excluir</button>
        )}
        <button type="button" className="btn btn--outline" onClick={onFechar}>Cancelar</button>
        <div className="em-acoes__dir">
          {pessoa && (
            <button type="button" className="btn btn--outline" onClick={() => setMesclar(true)}>
              <GitMerge size={15} aria-hidden="true" />
              Mesclar pessoa
            </button>
          )}
          <button type="button" className="btn btn--outline" disabled={salvar.isPending} onClick={() => void salvarENova()}>Salvar e criar um novo</button>
          <button type="button" className="btn btn--primary" disabled={salvar.isPending} onClick={() => void salvarEFechar()}>{salvar.isPending ? "Salvando…" : "Salvar"}</button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmarExcluir}
        onOpenChange={setConfirmarExcluir}
        title="Excluir a pessoa?"
        description={`${pessoa?.nome ?? ""} deixa de existir no cadastro, com os contatos e anexos. Se ela já tem chamados, desabilite em vez de excluir.`}
        confirmLabel="Excluir"
        tone="danger"
        isPending={excluir.isPending}
        onConfirm={() => pessoa && excluir.mutate(pessoa.id, { onSuccess: () => { toast.success("Pessoa excluída"); setConfirmarExcluir(false); onFechar(); }, onError: (e) => { toast.error(msgErro(e, "Não foi possível excluir.")); setConfirmarExcluir(false); } })}
      />
      {pessoa && <Mesclar aberto={mesclar} pessoa={pessoa} onFechar={() => setMesclar(false)} onMesclado={onFechar} />}
    </section>
  );
}

function Contatos({ contatos, onChange }: { contatos: Contato[]; onChange: (c: Contato[]) => void }) {
  const ids = useId();
  const muda = (i: number, c: Partial<Contato>) => onChange(contatos.map((x, j) => (j === i ? { ...x, ...c } : x)));
  const marcarPrincipal = (i: number) => {
    const email = contatos[i]!.tipo === "email";
    onChange(contatos.map((x, j) => ((x.tipo === "email") === email ? { ...x, principal: j === i } : x)));
  };
  return (
    <>
      <p className="em-info">O <b>e-mail</b> e o <b>telefone/WhatsApp</b> identificam a pessoa nos próximos chamados. Cada contato pertence a uma pessoa só.</p>
      {contatos.length === 0 && <p className="at-vazio">Nenhum contato.</p>}
      {contatos.map((c, i) => (
        <div key={i} className="ca-contato">
          <label className="visually-hidden" htmlFor={`${ids}-t${i}`}>Tipo do contato</label>
          <select id={`${ids}-t${i}`} className="input" value={c.tipo} onChange={(e) => muda(i, { tipo: e.target.value as TipoContato })}>
            <option value="email">E-mail</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="telefone">Telefone</option>
          </select>
          <label className="visually-hidden" htmlFor={`${ids}-v${i}`}>Contato</label>
          <input id={`${ids}-v${i}`} className="input" value={c.valor} onChange={(e) => muda(i, { valor: e.target.value })} placeholder={c.tipo === "email" ? "nome@empresa.com.br" : "(21) 99999-0000"} />
          <label className="ca-principal"><input type="radio" checked={c.principal} onChange={() => marcarPrincipal(i)} /> principal</label>
          <button type="button" className="icon-btn" aria-label="Remover contato" onClick={() => onChange(contatos.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => onChange([...contatos, { tipo: "email", valor: "", principal: !contatos.some((x) => x.tipo === "email") }])}>
          <Plus size={14} aria-hidden="true" />
          Adicionar contato
        </button>
      </div>
    </>
  );
}

function Relacoes({ tipo, relacoes, onChange, proprioId }: { tipo: TipoPessoa; relacoes: Relacao[]; onChange: (r: Relacao[]) => void; proprioId: number | null }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const q = useDebouncedValue(busca, 250);
  const alvo: TipoPessoa[] = tipo === "pessoa" ? ["empresa", "departamento"] : ["pessoa"];
  const achados = useBuscaPessoas(q, alvo);
  const opcoes = (achados.data ?? []).filter((a) => a.id !== proprioId && !relacoes.some((r) => r.pessoaId === a.id));
  return (
    <>
      <p className="at-sec__ajuda">
        {tipo === "pessoa" ? "Empresas e departamentos aos quais esta pessoa pertence." : "Pessoas que falam em nome desta empresa ou departamento."} Os chamados aparecem nas duas fichas.
      </p>
      {relacoes.length === 0 ? (
        <p className="at-vazio">Nenhuma relação.</p>
      ) : (
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead>
              <tr><th><ThLabel icon={tipo === "pessoa" ? Building : User}>{tipo === "pessoa" ? "Empresa" : "Pessoa"}</ThLabel></th><th><ThLabel icon={Briefcase}>Cargo</ThLabel></th><th><ThLabel icon={Mail}>E-mail</ThLabel></th><th /></tr>
            </thead>
            <tbody>
              {relacoes.map((r, i) => (
                <tr key={r.pessoaId}>
                  <td><span className="ca-av">{iniciais(r.nome)}</span> {r.nome}</td>
                  <td>
                    <label className="visually-hidden" htmlFor={`${ids}-c${i}`}>Cargo</label>
                    <input id={`${ids}-c${i}`} className="input input--sm" maxLength={80} value={r.cargo ?? ""} onChange={(e) => onChange(relacoes.map((x, j) => (j === i ? { ...x, cargo: e.target.value } : x)))} />
                  </td>
                  <td>{r.email ?? "—"}</td>
                  <td><button type="button" className="icon-btn" aria-label={`Remover ${r.nome}`} onClick={() => onChange(relacoes.filter((_, j) => j !== i))}><X size={15} aria-hidden="true" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor={`${ids}-b`}>{tipo === "pessoa" ? "Relacionar a uma empresa ou departamento" : "Relacionar pessoa"}</label>
        <input id={`${ids}-b`} className="input" placeholder="Digite o nome ou o e-mail" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {q.trim().length >= 2 && (
          <div className="ca-sugestoes" role="listbox">
            {achados.isPending && <span className="field__help">Buscando…</span>}
            {!achados.isPending && opcoes.length === 0 && <span className="field__help">Nada encontrado.</span>}
            {opcoes.map((o) => (
              <button key={o.id} type="button" role="option" aria-selected={false} onClick={() => { onChange([...relacoes, { pessoaId: o.id, nome: o.nome, tipo: o.tipo, cargo: null, email: o.email }]); setBusca(""); }}>
                <b>{o.nome}</b> <small>{TIPO[o.tipo]}{o.email ? ` · ${o.email}` : ""}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Sinalizadores({ lista, onChange }: { lista: string[]; onChange: (s: string[]) => void }) {
  const ids = useId();
  const [novo, setNovo] = useState("");
  const add = (s: string) => {
    const v = s.trim();
    if (v && !lista.includes(v)) onChange([...lista, v]);
  };
  return (
    <>
      <span className="field__label">Sinalizadores (etiquetas que aparecem no chamado)</span>
      {lista.length > 0 ? (
        <div className="ca-chips">
          {lista.map((s) => (
            <span key={s} className="ca-chip ca-chip--sinal">
              {s}
              <button type="button" aria-label={`Remover ${s}`} onClick={() => onChange(lista.filter((x) => x !== s))}><X size={13} aria-hidden="true" /></button>
            </span>
          ))}
        </div>
      ) : (
        <span className="field__help">Nenhum sinalizador.</span>
      )}
      <div className="zv-inline">
        <label className="visually-hidden" htmlFor={`${ids}-s`}>Sinalizador</label>
        <select id={`${ids}-s`} className="input" value="" onChange={(e) => add(e.target.value)}>
          <option value="">Adicionar sinalizador…</option>
          {SINALIZADORES.filter((s) => !lista.includes(s)).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${ids}-n`}>Outro sinalizador</label>
        <input id={`${ids}-n`} className="input" maxLength={40} placeholder="Ou digite outro" value={novo} onChange={(e) => setNovo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(novo); setNovo(""); } }} />
        <button type="button" className="btn btn--outline btn--sm" disabled={!novo.trim()} onClick={() => { add(novo); setNovo(""); }}>Adicionar</button>
      </div>
    </>
  );
}

function Anexos({ pessoa }: { pessoa: PessoaDetalhe }) {
  const anexar = useAnexarPessoa();
  const remover = useRemoverAnexo();
  const input = useRef<HTMLInputElement>(null);
  const abrir = async (path: string) => {
    try {
      window.open(await pessoasService.url(path), "_blank", "noopener");
    } catch (e) {
      toast.error(msgErro(e, "Não foi possível abrir o arquivo."));
    }
  };
  return (
    <>
      {pessoa.anexos.length === 0 ? (
        <p className="at-vazio">Nenhum anexo.</p>
      ) : (
        <div className="at-tab-wrap">
          <table className="at-tab">
            <thead><tr><th><ThLabel icon={Paperclip}>Arquivo</ThLabel></th><th><ThLabel icon={HardDrive}>Tamanho</ThLabel></th><th><ThLabel icon={UserPen}>Enviado por</ThLabel></th><th><ThLabel icon={CalendarPlus}>Em</ThLabel></th><th /></tr></thead>
            <tbody>
              {pessoa.anexos.map((a) => (
                <tr key={a.id}>
                  <td><button type="button" className="at-lnk" onClick={() => void abrir(a.path)}>📄 {a.nome}</button></td>
                  <td>{a.tamanho ? `${(a.tamanho / 1_048_576).toFixed(1).replace(".", ",")} MB` : "—"}</td>
                  <td>{a.enviadoPor ?? "—"}</td>
                  <td>{formatDateTime(a.enviadoEm)}</td>
                  <td><button type="button" className="icon-btn" aria-label={`Remover ${a.nome}`} disabled={remover.isPending} onClick={() => remover.mutate(a.id, { onSuccess: () => toast.success("Anexo removido"), onError: (e) => toast.error(msgErro(e, "Não foi possível remover.")) })}><Trash2 size={15} aria-hidden="true" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) anexar.mutate({ pessoaId: pessoa.id, arquivo: f }, { onSuccess: () => toast.success("Anexo enviado"), onError: (er) => toast.error(msgErro(er, "Não foi possível enviar.")) });
        }}
      />
      <div>
        <button type="button" className="btn btn--outline btn--sm" disabled={anexar.isPending} onClick={() => input.current?.click()}>
          <Paperclip size={14} aria-hidden="true" />
          {anexar.isPending ? "Enviando…" : "Enviar anexo (até 20 MB)"}
        </button>
      </div>
    </>
  );
}

function Historico({ pessoa }: { pessoa: PessoaDetalhe }) {
  return (
    <>
      <p className="at-sec__ajuda">Tudo o que esta pessoa{pessoa.tipo !== "pessoa" ? " e as pessoas relacionadas" : ""} já abriu, em qualquer canal.</p>
      {pessoa.historico.length === 0 ? (
        <p className="at-vazio">Nenhum chamado ainda.</p>
      ) : (
        <div className="ca-hist">
          {pessoa.historico.map((h, i) => (
            <div key={i} className="ca-hist__it">
              <span className={`ca-or ${h.canal === "email" ? "ca-or--mail" : "ca-or--wpp"}`}>{h.canal === "email" ? "E-mail" : "WhatsApp"}</span>
              <div>
                <b>{h.ticket ? `#${h.ticket} · ` : ""}{h.titulo}</b>
                <small>{h.setor}{h.atendente ? ` · ${h.atendente}` : ""}{pessoa.tipo !== "pessoa" ? ` · ${h.pessoa}` : ""} · {formatDateTime(h.em)}</small>
              </div>
              <span className={`ca-st ${h.situacao === "andamento" ? "ca-st--and" : h.situacao === "ignorado" ? "ca-st--inat" : "ca-st--ok"}`}>
                {h.situacao === "andamento" ? "Em andamento" : h.situacao === "ignorado" ? "Ignorado" : "Encerrado"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Foto({ pessoa, nome, avatarPath, onTrocar }: { pessoa: PessoaDetalhe | null; nome: string; avatarPath: string | null; onTrocar: (path: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const url = useQuery({ queryKey: ["cadastros", "arquivo", avatarPath], queryFn: () => pessoasService.url(avatarPath!), enabled: !!avatarPath, staleTime: 240_000 });
  return (
    <aside className="ca-foto">
      {url.data ? <img src={url.data} alt="" className="ca-foto__img" /> : <span className="ca-foto__circ" aria-hidden="true">{iniciais(nome)}</span>}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f || !pessoa) return;
          setEnviando(true);
          try {
            onTrocar(await pessoasService.enviarImagem(pessoa.id, f));
            toast.info("Imagem enviada: clique em Salvar para gravar.");
          } catch (er) {
            toast.error(msgErro(er, "Não foi possível enviar a imagem."));
          } finally {
            setEnviando(false);
          }
        }}
      />
      <button type="button" className="at-lnk" disabled={!pessoa || enviando} title={pessoa ? undefined : "Salve a pessoa primeiro"} onClick={() => input.current?.click()}>
        <ImagePlus size={14} aria-hidden="true" /> {enviando ? "Enviando…" : "Inserir ou alterar imagem"}
      </button>
      {pessoa && (
        <div className="ca-foto__info">
          <span className={`ca-or ${ORIGEM[pessoa.origem].classe}`}>{pessoa.origem === "manual" ? "Cadastro manual" : `Criada pelo ${ORIGEM[pessoa.origem].rotulo}`}</span>
          <small>{pessoa.historico.length} chamado(s) · último contato {quando(pessoa.ultimoContatoEm)}</small>
        </div>
      )}
    </aside>
  );
}

function Mesclar({ aberto, pessoa, onFechar, onMesclado }: { aberto: boolean; pessoa: PessoaDetalhe; onFechar: () => void; onMesclado: () => void }) {
  const ids = useId();
  const [busca, setBusca] = useState("");
  const [sai, setSai] = useState<{ id: number; nome: string; email: string | null } | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const q = useDebouncedValue(busca, 250);
  const achados = useBuscaPessoas(q);
  const mesclar = useMesclarPessoa();
  return (
    <Dialog.Root open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <div className="sheet__form">
            <header className="sheet__header">
              <div>
                <Dialog.Title className="sheet__title">Mesclar pessoa</Dialog.Title>
                <p className="sheet__description">Junta duas fichas da mesma pessoa (ex.: uma criada pelo e-mail e outra pelo WhatsApp).</p>
              </div>
              <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Fechar"><X size={18} aria-hidden="true" /></button></Dialog.Close>
            </header>
            <div className="sheet__body">
              <div className="field">
                <span className="field__label">Ficha que fica</span>
                <input className="input" value={pessoa.nome} readOnly />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-b`}>Ficha que será incorporada</label>
                <input id={`${ids}-b`} className="input" placeholder="Digite o nome, e-mail ou telefone" value={sai ? sai.nome : busca} onChange={(e) => { setSai(null); setBusca(e.target.value); }} />
                {!sai && q.trim().length >= 2 && (
                  <div className="ca-sugestoes" role="listbox">
                    {(achados.data ?? []).filter((a) => a.id !== pessoa.id).map((a) => (
                      <button key={a.id} type="button" role="option" aria-selected={false} onClick={() => setSai(a)}>
                        <b>{a.nome}</b> <small>{TIPO[a.tipo]}{a.email ? ` · ${a.email}` : ""}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="em-info">Contatos, relações, anexos e o histórico de chamados passam para a ficha que fica. A outra é apagada. Não dá para desfazer.</p>
            </div>
            <footer className="sheet__footer">
              <Dialog.Close asChild><button type="button" className="btn btn--outline btn--lg">Cancelar</button></Dialog.Close>
              <button type="button" className="btn btn--primary btn--lg" disabled={!sai || mesclar.isPending} onClick={() => setConfirmar(true)}>Mesclar</button>
            </footer>
          </div>
          <ConfirmDialog
            open={confirmar}
            onOpenChange={setConfirmar}
            title="Mesclar as fichas?"
            description={`"${sai?.nome ?? ""}" será incorporada em "${pessoa.nome}" e deixará de existir.`}
            confirmLabel="Mesclar"
            tone="warning"
            isPending={mesclar.isPending}
            onConfirm={() => sai && mesclar.mutate({ fica: pessoa.id, sai: sai.id }, { onSuccess: () => { toast.success("Fichas mescladas"); setConfirmar(false); setSai(null); setBusca(""); onFechar(); onMesclado(); }, onError: (e) => { toast.error(msgErro(e, "Não foi possível mesclar.")); setConfirmar(false); } })}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
