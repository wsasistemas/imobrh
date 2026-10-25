import { useMutation } from "@tanstack/react-query";
import { Activity, ArrowDown, ArrowUp, ChartColumn, CircleCheckBig, CircleDot, Clock, History, Plus, Tag, Ticket, Trash2, Zap } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { getMenuItem } from "../../../config/menuRegistry";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ComCadastros, mensagem, Situacao } from "../cadastros/comum";
import { caminhoServico, type Cadastros, type Macro } from "../cadastros/types";
import { useMacros, useStatusTickets } from "../hooks";
import { rotuloStatus, type StatusTicket } from "../status/types";
import { useResponsaveis } from "../ticket/hooks";
import type { Responsavel } from "../ticket/types";
import { useExecucoesGatilhos, useGatilhos, useOrdenarGatilhos, useSalvarGatilho } from "./hooks";
import { validarGatilho, type AutorGatilho } from "./motor";
import { gatilhosService } from "./service";
import {
  ACOES,
  AUTORES,
  DISPAROS,
  OPERADORES,
  QUEM_AVISAR,
  type AcaoGatilho,
  type CampoGatilho,
  type CondicaoGatilho,
  type Disparo,
  type Gatilho,
  type OperadorGatilho,
  type SimulacaoGatilho,
  type TipoAcao,
} from "./types";
import "./Gatilhos.css";

// Administração › Gatilhos (mockup aprovado docs/mockups/gatilhos.html): lista na ordem de execução, editor com
// as abas Principal / Condições / Ações da Movidesk, simulação num ticket e a tela de execuções.

const ORIGENS = [
  { value: "email", label: "E-mail" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "intranet", label: "Intranet" },
  { value: "agente", label: "Agente" },
];

/** Tudo o que a tela precisa para montar os seletores. */
interface Dados {
  cad: Cadastros;
  status: StatusTicket[];
  macros: Macro[];
  pessoas: Responsavel[];
}

type Opcao = { value: string; label: string };

export function GatilhosCadastro() {
  return <ComCadastros>{(cad) => <Carregar cad={cad} />}</ComCadastros>;
}

function Carregar({ cad }: { cad: Cadastros }) {
  const gatilhos = useGatilhos();
  const status = useStatusTickets();
  const macros = useMacros();
  const pessoas = useResponsaveis();
  if (gatilhos.isPending || status.isPending) return <PageSkeleton />;
  if (gatilhos.isError || status.isError) {
    return <ErrorState message={mensagem(gatilhos.error, "Não foi possível carregar os gatilhos.")} onRetry={() => void Promise.all([gatilhos.refetch(), status.refetch()])} />;
  }
  return <Conteudo gatilhos={gatilhos.data} dados={{ cad, status: status.data, macros: (macros.data ?? []).filter((m) => m.ativa), pessoas: pessoas.data ?? [] }} />;
}

function Conteudo({ gatilhos, dados }: { gatilhos: Gatilho[]; dados: Dados }) {
  const [tela, setTela] = useState<{ tipo: "lista" } | { tipo: "editor"; gatilho: Gatilho | null; n: number } | { tipo: "execucoes"; gatilhoId: number | null }>({ tipo: "lista" });
  const novo = () => setTela((t) => ({ tipo: "editor", gatilho: null, n: (t.tipo === "editor" ? t.n : 0) + 1 }));

  if (tela.tipo === "editor") {
    return <Editor key={`${tela.gatilho?.id ?? "novo"}-${tela.n}`} gatilho={tela.gatilho} dados={dados} onFechar={() => setTela({ tipo: "lista" })} onNovo={novo} />;
  }
  if (tela.tipo === "execucoes") {
    return <Execucoes gatilhos={gatilhos} inicial={tela.gatilhoId} onVoltar={() => setTela({ tipo: "lista" })} />;
  }
  return <Lista gatilhos={gatilhos} dados={dados} onAbrir={(g) => setTela({ tipo: "editor", gatilho: g, n: 0 })} onNovo={novo} onExecucoes={(id) => setTela({ tipo: "execucoes", gatilhoId: id })} />;
}

// ---------- Resumos ----------
function resumoDisparos(d: Disparo[]): string {
  return d
    .map((x) => {
      const def = DISPAROS.find((y) => y.tipo === x.tipo);
      return def?.horas ? `${def.label} ${String(x.horas ?? "").replace(".", ",")} h${def.horas === "uteis" ? " úteis" : ""}` : (def?.label ?? x.tipo);
    })
    .join(" · ");
}

function opcoesStatus(status: StatusTicket[]): Opcao[] {
  return status.flatMap((s) => [{ value: String(s.id), label: s.nome }, ...s.justificativas.map((j) => ({ value: `${s.id}:${j.id}`, label: rotuloStatus(s.nome, j.nome) }))]);
}

function resumoAcao(a: AcaoGatilho, dados: Dados): string {
  const { cad } = dados;
  const nome = (lista: { id: number; nome: string }[], id: number | null | undefined, vazio = "nenhuma") => lista.find((x) => x.id === id)?.nome ?? vazio;
  switch (a.tipo) {
    case "status":
      return `Status → ${opcoesStatus(dados.status).find((o) => o.value === (a.justificativaId ? `${a.statusId}:${a.justificativaId}` : String(a.statusId)))?.label ?? "?"}`;
    case "equipe":
      return `Equipe → ${nome(cad.equipes, a.equipeId)}`;
    case "responsavel":
      return `Responsável → ${a.modo === "lider" ? "líder da equipe" : a.modo === "pessoa" ? (dados.pessoas.find((p) => p.id === a.usuarioId)?.nome ?? "pessoa") : "ninguém"}`;
    case "urgencia":
      return `Urgência → ${nome(cad.urgencias, a.urgenciaId)}`;
    case "categoria":
      return `Categoria → ${nome(cad.categorias, a.categoriaId)}`;
    case "servico":
      return `Serviço → ${a.servicoId ? caminhoServico(a.servicoId, cad.servicos) : "nenhum"}`;
    case "tags_adicionar":
      return `Tags + ${(a.tags ?? []).join(", ")}`;
    case "tags_remover":
      return `Tags − ${(a.tags ?? []).join(", ")}`;
    case "campo":
      return `${cad.campos.find((c) => c.chave === a.chave)?.rotulo ?? a.chave} = ${String(a.valor ?? "")}`;
    case "solucao":
      return "Solução aplicada (se vazia)";
    case "nota_interna":
      return "Nota interna";
    case "responder_macro":
      return `Resposta (macro "${dados.macros.find((m) => m.id === a.macroId)?.nome ?? "?"}")`;
    case "seguidor":
      return `Seguidor: ${a.modo === "lider" ? "líder" : a.modo === "responsavel" ? "responsável" : (dados.pessoas.find((p) => p.id === a.usuarioId)?.nome ?? "pessoa")}`;
    case "avisar":
      return `Avisa ${(QUEM_AVISAR[a.quem ?? ""] ?? "").toLowerCase()}`;
  }
}

// ---------- Lista ----------
function Lista({ gatilhos, dados, onAbrir, onNovo, onExecucoes }: { gatilhos: Gatilho[]; dados: Dados; onAbrir: (g: Gatilho) => void; onNovo: () => void; onExecucoes: (id: number | null) => void }) {
  const ordenar = useOrdenarGatilhos();
  const ids = gatilhos.map((g) => g.id);
  const mover = (i: number, delta: number) => {
    const nova = [...ids];
    [nova[i], nova[i + delta]] = [nova[i + delta], nova[i]];
    ordenar.mutate(nova, { onError: (e) => toast.error(mensagem(e, "Não foi possível reordenar.")) });
  };
  return (
    <section className="cad-card" aria-labelledby="gt-lista-t">
      <div className="cad-head">
        <div>
          <h2 id="gt-lista-t">Gatilhos</h2>
          <small>Automações que agem sozinhas no ticket quando as condições batem. Rodam na ordem da lista, uma vez por evento; o que um gatilho muda não dispara outro.</small>
        </div>
        <span className="cad-head__spacer" />
        <button type="button" className="btn btn--outline" onClick={() => onExecucoes(null)}>
          <History size={16} aria-hidden="true" />
          Execuções
        </button>
        <button type="button" className="btn btn--primary" onClick={onNovo}>
          <Plus size={16} aria-hidden="true" />
          Novo gatilho
        </button>
      </div>
      {gatilhos.length === 0 ? (
        <p className="cad-vazio">Nenhum gatilho ainda.</p>
      ) : (
        <table className="cad-table gt-tabela">
          <thead>
            <tr>
              <th aria-label="Ordem" />
              <th><ThLabel icon={Tag}>Nome</ThLabel></th>
              <th><ThLabel icon={Zap}>Quando dispara</ThLabel></th>
              <th><ThLabel icon={Activity}>Faz</ThLabel></th>
              <th><ThLabel icon={ChartColumn}>Últimos 7 dias</ThLabel></th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {gatilhos.map((g, i) => (
              <tr key={g.id} className={g.ativo ? undefined : "cad-inativo"} tabIndex={0} onClick={() => onAbrir(g)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onAbrir(g))}>
                <td onClick={(e) => e.stopPropagation()}>
                  <span className="cad-ordem">
                    <button type="button" className="icon-btn" aria-label={`Subir ${g.nome}`} disabled={i === 0 || ordenar.isPending} onClick={() => mover(i, -1)}>
                      <ArrowUp size={15} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Descer ${g.nome}`} disabled={i === gatilhos.length - 1 || ordenar.isPending} onClick={() => mover(i, 1)}>
                      <ArrowDown size={15} aria-hidden="true" />
                    </button>
                  </span>
                </td>
                <td>
                  <b>{g.nome}</b>
                  {g.execucao === "ticket" && <small className="gt-sub">uma vez por ticket</small>}
                </td>
                <td>{resumoDisparos(g.disparos)}</td>
                <td>{g.acoes.map((a) => resumoAcao(a, dados)).join(" · ")}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="gt-link" onClick={() => onExecucoes(g.id)}>
                    {g.execucoes7d}
                    {g.erros7d > 0 && <span className="ch-badge ch-badge--danger" style={{ marginLeft: 6 }}>{g.erros7d} erro{g.erros7d > 1 ? "s" : ""}</span>}
                  </button>
                </td>
                <td>
                  <Situacao ativo={g.ativo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------- Editor ----------
function camposCondicao(cad: Cadastros): Opcao[] {
  return [
    { value: "status", label: "Status" },
    { value: "urgencia", label: "Urgência" },
    { value: "categoria", label: "Categoria" },
    { value: "servico", label: "Serviço" },
    { value: "equipe", label: "Equipe" },
    { value: "responsavel", label: "Responsável" },
    { value: "setor", label: "Setor" },
    { value: "origem", label: "Origem" },
    { value: "tags", label: "Tags" },
    { value: "texto", label: "Assunto ou texto" },
    { value: "horario", label: "Horário" },
    { value: "autor", label: "Ação feita por" },
    ...cad.campos.filter((c) => c.ativo).map((c) => ({ value: `campo:${c.chave}`, label: `Campo: ${c.rotulo}` })),
  ];
}

function valoresDoCampo(campo: CampoGatilho, dados: Dados): Opcao[] | null {
  const { cad } = dados;
  switch (campo) {
    case "status":
      return opcoesStatus(dados.status);
    case "urgencia":
      return cad.urgencias.map((u) => ({ value: String(u.id), label: u.nome }));
    case "categoria":
      return cad.categorias.map((c) => ({ value: String(c.id), label: c.nome }));
    case "servico":
      return cad.servicos.map((s) => ({ value: String(s.id), label: caminhoServico(s.id, cad.servicos) })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
    case "equipe":
      return cad.equipes.map((e) => ({ value: String(e.id), label: e.nome }));
    case "responsavel":
      return dados.pessoas.map((p) => ({ value: p.id, label: p.nome }));
    case "setor":
      return cad.setores.map((s) => ({ value: String(s.id), label: s.nome }));
    case "origem":
      return ORIGENS;
    case "horario":
      return [
        { value: "dentro", label: "Dentro do expediente" },
        { value: "fora", label: "Fora do expediente" },
      ];
    case "autor":
      return Object.entries(AUTORES).map(([value, label]) => ({ value, label }));
    case "tags":
    case "texto":
      return null;
    default: {
      const c = cad.campos.find((x) => `campo:${x.chave}` === campo);
      if (c && (c.tipo === "lista" || c.tipo === "multipla")) return c.opcoes.map((o) => ({ value: o, label: o }));
      if (c && c.tipo === "sim_nao") return [{ value: "true", label: "Sim" }, { value: "false", label: "Não" }];
      return null;
    }
  }
}

function operadoresDoCampo(campo: CampoGatilho, dados: Dados): OperadorGatilho[] {
  if (campo === "texto") return ["contem", "nao_contem"];
  if (["status", "urgencia", "setor", "origem", "horario", "autor"].includes(campo)) return ["um_de", "nao_um_de"];
  if (campo.startsWith("campo:") && !valoresDoCampo(campo, dados)) return ["contem", "nao_contem", "preenchido", "vazio"];
  return ["um_de", "nao_um_de", "preenchido", "vazio"];
}

function rotuloOperador(campo: CampoGatilho, op: OperadorGatilho) {
  if (campo === "tags" && op === "um_de") return "tem alguma de";
  if (campo === "tags" && op === "nao_um_de") return "não tem nenhuma de";
  return OPERADORES[op];
}

function textoCondicao(c: CondicaoGatilho, dados: Dados): string {
  const campo = camposCondicao(dados.cad).find((x) => x.value === c.campo)?.label ?? c.campo;
  const ops = valoresDoCampo(c.campo, dados);
  const vals = c.valores.map((v) => ops?.find((o) => o.value === v)?.label ?? v).join(", ");
  return `${campo} ${rotuloOperador(c.campo, c.operador)}${vals ? ` ${vals}` : ""}`;
}

const lista = (t: string) => t.split(",").map((x) => x.trim()).filter(Boolean);

function Editor({ gatilho, dados, onFechar, onNovo }: { gatilho: Gatilho | null; dados: Dados; onFechar: () => void; onNovo: () => void }) {
  const salvar = useSalvarGatilho();
  const [nome, setNome] = useState(gatilho?.nome ?? "");
  const [ativo, setAtivo] = useState(gatilho?.ativo ?? true);
  const [execucao, setExecucao] = useState<Gatilho["execucao"]>(gatilho?.execucao ?? "evento");
  const [disparos, setDisparos] = useState<Disparo[]>(gatilho?.disparos ?? []);
  const [todas, setTodas] = useState<CondicaoGatilho[]>(gatilho?.todas ?? []);
  const [qualquer, setQualquer] = useState<CondicaoGatilho[]>(gatilho?.qualquer ?? []);
  const [acoes, setAcoes] = useState<AcaoGatilho[]>(gatilho?.acoes ?? [{ tipo: "status" }]);
  const [erro, setErro] = useState<string | null>(null);
  const [aba, setAba] = useState<"principal" | "condicoes" | "acoes">("principal");
  const refs = { principal: useRef<HTMLDivElement>(null), condicoes: useRef<HTMLDivElement>(null), acoes: useRef<HTMLDivElement>(null) };

  const irPara = (a: keyof typeof refs) => {
    setAba(a);
    refs[a].current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const marcado = (tipo: Disparo["tipo"]) => disparos.find((d) => d.tipo === tipo);
  const alternar = (tipo: Disparo["tipo"], horas?: "uteis" | "corridas") =>
    setDisparos((atual) => (atual.some((d) => d.tipo === tipo) ? atual.filter((d) => d.tipo !== tipo) : [...atual, horas ? { tipo, horas: tipo === "tempo_status" ? 48 : 2 } : { tipo }]));

  const enviar = (criarOutro: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    setErro(null);
    const p = { id: gatilho?.id, nome, ativo, execucao, disparos, todas, qualquer, acoes };
    const local = validarGatilho(p);
    if (local) {
      setErro(local);
      return;
    }
    salvar.mutate(p, {
      onSuccess: () => {
        toast.success(gatilho ? "Gatilho salvo" : "Gatilho criado");
        if (criarOutro) onNovo();
        else onFechar();
      },
      onError: (er) => setErro(mensagem(er, "Não foi possível salvar o gatilho.")),
    });
  };

  return (
    <div className="cad-layout gt-layout">
      <form className="cad-card" onSubmit={enviar(false)} aria-label={gatilho ? `Editar gatilho ${gatilho.nome}` : "Novo gatilho"}>
        <div className="cad-head">
          <div>
            <h2>{gatilho ? gatilho.nome : "Novo gatilho"}</h2>
            {gatilho && (
              <small>
                Gatilho #{gatilho.id}
                {gatilho.atualizadoPor ? ` · alterado por ${gatilho.atualizadoPor}` : ""}
              </small>
            )}
          </div>
          <span className="cad-head__spacer" />
          <label className="cad-check">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Ativo
          </label>
        </div>
        <div className="gt-abas" role="tablist">
          {(
            [
              ["principal", "Principal"],
              ["condicoes", "Condições"],
              ["acoes", "Ações"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={aba === k} onClick={() => irPara(k)}>
              {l}
            </button>
          ))}
        </div>

        <div className="gt-sec" ref={refs.principal}>
          <h3>Principal</h3>
          <p>Os gatilhos executam ações quando as condições são cumpridas. Elas podem ser acionadas por algo que aconteceu no ticket ou por tempo dentro de um status.</p>
          <label className="field">
            <span className="field__label">Nome</span>
            <input className="input" maxLength={80} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus={!gatilho} />
          </label>
          <div className="gt-grid2">
            <label className="field">
              <span className="field__label">Gatilho para</span>
              <select className="input" value="tickets" disabled>
                <option value="tickets">Tickets</option>
              </select>
              <span className="field__help">Define quais condições e ações estão disponíveis. Por enquanto, só Tickets.</span>
            </label>
            <label className="field">
              <span className="field__label">Executar no máximo</span>
              <select className="input" value={execucao} onChange={(e) => setExecucao(e.target.value as Gatilho["execucao"])}>
                <option value="evento">Uma vez por evento</option>
                <option value="ticket">Uma vez por ticket</option>
              </select>
              <span className="field__help">"Uma vez por ticket" evita repetir, por exemplo, um aviso.</span>
            </label>
          </div>
        </div>

        <div className="gt-sec" ref={refs.condicoes}>
          <h3>Condições</h3>
          <p>
            O gatilho precisa de pelo menos um <b>disparo</b>. Depois, as condições filtram em quais tickets ele age.
          </p>
          <div className="gt-grupo">
            <b>Dispara quando</b>
            <small>Marque um ou mais acontecimentos. Os de tempo são conferidos a cada 5 minutos.</small>
            <div className="gt-disparos">
              {DISPAROS.map((d) => {
                const m = marcado(d.tipo);
                return (
                  <label key={d.tipo} className="gt-disparo" data-marcado={Boolean(m)}>
                    <input type="checkbox" checked={Boolean(m)} onChange={() => alternar(d.tipo, d.horas)} />
                    {d.label}
                    {d.horas && (
                      <>
                        <input
                          className="input"
                          type="number"
                          min={0.25}
                          max={2000}
                          step={0.25}
                          aria-label={`Horas de "${d.label}"`}
                          value={m?.horas ?? ""}
                          disabled={!m}
                          onChange={(e) => setDisparos((atual) => atual.map((x) => (x.tipo === d.tipo ? { ...x, horas: Number(e.target.value) } : x)))}
                        />
                        h{d.horas === "uteis" ? " úteis" : ""}
                      </>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
          <Condicoes titulo="Atende TODAS as condições a seguir" ajuda="Só executa se todas forem verdadeiras." lista={todas} setLista={setTodas} dados={dados} />
          <Condicoes titulo="Atende QUALQUER condição a seguir" ajuda="Executa se uma ou mais forem verdadeiras (vazio = não filtra)." lista={qualquer} setLista={setQualquer} dados={dados} />
        </div>

        <div className="gt-sec" ref={refs.acoes} style={{ borderBottom: 0 }}>
          <h3>Ações</h3>
          <p>O que é feito no ticket quando as condições batem, nesta ordem. Resolver por gatilho segue as regras do agente (serviço, obrigatórios e solução).</p>
          <div className="gt-linhas">
            {acoes.map((a, i) => (
              <LinhaAcao
                key={i}
                acao={a}
                dados={dados}
                onChange={(nova) => setAcoes(acoes.map((x, k) => (k === i ? nova : x)))}
                onRemover={acoes.length > 1 ? () => setAcoes(acoes.filter((_, k) => k !== i)) : undefined}
              />
            ))}
          </div>
          <button type="button" className="btn btn--outline gt-add" onClick={() => setAcoes([...acoes, { tipo: "nota_interna", texto: "" }])}>
            <Plus size={14} aria-hidden="true" />
            Adicionar ação
          </button>
        </div>

        {erro && (
          <p className="cad-erro gt-erro" role="alert">
            {erro}
          </p>
        )}
        <div className="gt-rodape">
          <button type="button" className="btn btn--outline" onClick={onFechar}>
            Cancelar
          </button>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--outline" disabled={salvar.isPending} onClick={() => enviar(true)()}>
            Salvar e criar um novo
          </button>
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
      <aside className="cad-card">
        <Simular rascunho={{ id: gatilho?.id, todas, qualquer }} dados={dados} />
      </aside>
    </div>
  );
}

function Condicoes({ titulo, ajuda, lista: itens, setLista, dados }: { titulo: string; ajuda: string; lista: CondicaoGatilho[]; setLista: (l: CondicaoGatilho[]) => void; dados: Dados }) {
  const campos = camposCondicao(dados.cad);
  const mudar = (i: number, c: CondicaoGatilho) => setLista(itens.map((x, k) => (k === i ? c : x)));
  return (
    <div className="gt-grupo">
      <b>{titulo}</b>
      <small>{ajuda}</small>
      <div className="gt-linhas">
        {itens.map((c, i) => {
          const ops = operadoresDoCampo(c.campo, dados);
          const valores = valoresDoCampo(c.campo, dados);
          const semValor = c.operador === "preenchido" || c.operador === "vazio";
          return (
            <div key={i} className="gt-cond">
              <span className="gt-se">Se</span>
              <select
                className="input"
                aria-label="Campo da condição"
                value={c.campo}
                onChange={(e) => {
                  const campo = e.target.value as CampoGatilho;
                  mudar(i, { campo, operador: operadoresDoCampo(campo, dados)[0], valores: [] });
                }}
              >
                {campos.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select className="input" aria-label="Operador" value={c.operador} onChange={(e) => mudar(i, { ...c, operador: e.target.value as OperadorGatilho, valores: [] })}>
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {rotuloOperador(c.campo, o)}
                  </option>
                ))}
              </select>
              <button type="button" className="icon-btn" aria-label="Remover condição" onClick={() => setLista(itens.filter((_, k) => k !== i))}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
              {!semValor && (
                <div className="gt-valores">
                  {valores ? (
                    <div className="cad-multi" role="group" aria-label="Valores">
                      {valores.map((o) => (
                        <label key={o.value}>
                          <input
                            type="checkbox"
                            checked={c.valores.includes(o.value)}
                            onChange={(e) => mudar(i, { ...c, valores: e.target.checked ? [...c.valores, o.value] : c.valores.filter((v) => v !== o.value) })}
                          />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      className="input"
                      aria-label="Valores (separados por vírgula)"
                      placeholder="Valores, separados por vírgula"
                      defaultValue={c.valores.join(", ")}
                      onBlur={(e) => mudar(i, { ...c, valores: lista(e.target.value) })}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="btn btn--outline gt-add" onClick={() => setLista([...itens, { campo: "status", operador: "um_de", valores: [] }])}>
        <Plus size={14} aria-hidden="true" />
        Adicionar condição
      </button>
    </div>
  );
}

function Seletor({ rotulo, valor, opcoes, onChange, vazio }: { rotulo: string; valor: string; opcoes: Opcao[]; onChange: (v: string) => void; vazio?: string }) {
  return (
    <select className="input" aria-label={rotulo} value={valor} onChange={(e) => onChange(e.target.value)}>
      {vazio !== undefined && <option value="">{vazio}</option>}
      {opcoes.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function LinhaAcao({ acao: a, dados, onChange, onRemover }: { acao: AcaoGatilho; dados: Dados; onChange: (a: AcaoGatilho) => void; onRemover?: () => void }) {
  const { cad } = dados;
  const pessoas = dados.pessoas.map((p) => ({ value: p.id, label: p.nome }));
  const num = (v: string) => (v ? Number(v) : null);
  let valor: ReactNode = null;
  switch (a.tipo) {
    case "status":
      valor = (
        <Seletor
          rotulo="Novo status"
          vazio="— Escolha o status —"
          valor={a.statusId ? (a.justificativaId ? `${a.statusId}:${a.justificativaId}` : String(a.statusId)) : ""}
          opcoes={opcoesStatus(dados.status.filter((s) => s.ativo))}
          onChange={(v) => {
            const [s, j] = v.split(":");
            onChange({ tipo: "status", statusId: s ? Number(s) : undefined, justificativaId: j ? Number(j) : null });
          }}
        />
      );
      break;
    case "equipe":
      valor = <Seletor rotulo="Equipe" vazio="Nenhuma equipe" valor={String(a.equipeId ?? "")} opcoes={cad.equipes.filter((e) => e.ativa).map((e) => ({ value: String(e.id), label: e.nome }))} onChange={(v) => onChange({ tipo: "equipe", equipeId: num(v) })} />;
      break;
    case "responsavel":
      valor = (
        <div className="gt-dupla">
          <Seletor
            rotulo="Quem fica responsável"
            valor={a.modo ?? "ninguem"}
            opcoes={[
              { value: "ninguem", label: "Ninguém (tirar o responsável)" },
              { value: "lider", label: "Líder da equipe do ticket" },
              { value: "pessoa", label: "Uma pessoa" },
            ]}
            onChange={(v) => onChange({ tipo: "responsavel", modo: v, usuarioId: null })}
          />
          {a.modo === "pessoa" && <Seletor rotulo="Pessoa" vazio="— Escolha —" valor={a.usuarioId ?? ""} opcoes={pessoas} onChange={(v) => onChange({ ...a, usuarioId: v || null })} />}
        </div>
      );
      break;
    case "urgencia":
      valor = <Seletor rotulo="Urgência" vazio="— Escolha —" valor={String(a.urgenciaId ?? "")} opcoes={cad.urgencias.map((u) => ({ value: String(u.id), label: u.nome }))} onChange={(v) => onChange({ tipo: "urgencia", urgenciaId: v ? Number(v) : undefined })} />;
      break;
    case "categoria":
      valor = <Seletor rotulo="Categoria" vazio="Nenhuma" valor={String(a.categoriaId ?? "")} opcoes={cad.categorias.map((c) => ({ value: String(c.id), label: c.nome }))} onChange={(v) => onChange({ tipo: "categoria", categoriaId: num(v) })} />;
      break;
    case "servico":
      valor = (
        <Seletor
          rotulo="Serviço"
          vazio="Nenhum"
          valor={String(a.servicoId ?? "")}
          opcoes={cad.servicos
            .filter((s) => s.ativo && !cad.servicos.some((f) => f.paiId === s.id))
            .map((s) => ({ value: String(s.id), label: caminhoServico(s.id, cad.servicos) }))
            .sort((x, y) => x.label.localeCompare(y.label, "pt-BR"))}
          onChange={(v) => onChange({ tipo: "servico", servicoId: num(v) })}
        />
      );
      break;
    case "tags_adicionar":
    case "tags_remover":
      valor = <input className="input" aria-label="Tags (separadas por vírgula)" placeholder="tag1, tag2" defaultValue={(a.tags ?? []).join(", ")} onBlur={(e) => onChange({ tipo: a.tipo, tags: lista(e.target.value) })} />;
      break;
    case "campo": {
      const campo = cad.campos.find((c) => c.chave === a.chave);
      const opcoes = campo && (campo.tipo === "lista" || campo.tipo === "multipla") ? campo.opcoes.map((o) => ({ value: o, label: o })) : null;
      valor = (
        <div className="gt-dupla">
          <Seletor rotulo="Campo adicional" vazio="— Campo —" valor={a.chave ?? ""} opcoes={cad.campos.filter((c) => c.ativo).map((c) => ({ value: c.chave, label: c.rotulo }))} onChange={(v) => onChange({ tipo: "campo", chave: v, valor: "" })} />
          {opcoes ? (
            <Seletor rotulo="Valor" vazio="—" valor={String(a.valor ?? "")} opcoes={opcoes} onChange={(v) => onChange({ ...a, valor: v })} />
          ) : (
            <input className="input" aria-label="Valor" placeholder="Valor" value={String(a.valor ?? "")} onChange={(e) => onChange({ ...a, valor: e.target.value })} />
          )}
        </div>
      );
      break;
    }
    case "solucao":
    case "nota_interna":
      valor = <textarea className="input" rows={2} aria-label="Texto" placeholder={a.tipo === "solucao" ? "Texto da solução aplicada" : "Texto da nota interna"} value={a.texto ?? ""} onChange={(e) => onChange({ tipo: a.tipo, texto: e.target.value })} />;
      break;
    case "responder_macro":
      valor = <Seletor rotulo="Macro" vazio="— Escolha a macro —" valor={String(a.macroId ?? "")} opcoes={dados.macros.map((m) => ({ value: String(m.id), label: m.nome }))} onChange={(v) => onChange({ tipo: "responder_macro", macroId: v ? Number(v) : undefined })} />;
      break;
    case "seguidor":
      valor = (
        <div className="gt-dupla">
          <Seletor
            rotulo="Quem passa a seguir"
            valor={a.modo ?? "lider"}
            opcoes={[
              { value: "lider", label: "Líder da equipe" },
              { value: "responsavel", label: "Responsável" },
              { value: "pessoa", label: "Uma pessoa" },
            ]}
            onChange={(v) => onChange({ tipo: "seguidor", modo: v, usuarioId: null })}
          />
          {a.modo === "pessoa" && <Seletor rotulo="Pessoa" vazio="— Escolha —" valor={a.usuarioId ?? ""} opcoes={pessoas} onChange={(v) => onChange({ ...a, usuarioId: v || null })} />}
        </div>
      );
      break;
    case "avisar":
      valor = (
        <div className="gt-dupla">
          <Seletor rotulo="Quem avisar" valor={a.quem ?? "responsavel"} opcoes={Object.entries(QUEM_AVISAR).map(([value, label]) => ({ value, label }))} onChange={(v) => onChange({ ...a, quem: v, usuarioId: null })} />
          {a.quem === "pessoa" && <Seletor rotulo="Pessoa" vazio="— Escolha —" valor={a.usuarioId ?? ""} opcoes={pessoas} onChange={(v) => onChange({ ...a, usuarioId: v || null })} />}
          <input className="input" aria-label="Mensagem do aviso" placeholder="Mensagem (opcional)" value={a.texto ?? ""} onChange={(e) => onChange({ ...a, texto: e.target.value })} />
        </div>
      );
      break;
  }
  const padrao = (tipo: TipoAcao): AcaoGatilho =>
    tipo === "responsavel" ? { tipo, modo: "ninguem" } : tipo === "seguidor" ? { tipo, modo: "lider" } : tipo === "avisar" ? { tipo, quem: "responsavel" } : { tipo };
  return (
    <div className="gt-acao">
      <select className="input" aria-label="Ação" value={a.tipo} onChange={(e) => onChange(padrao(e.target.value as TipoAcao))}>
        {(["Mudar o ticket", "Escrever", "Avisar"] as const).map((g) => (
          <optgroup key={g} label={g}>
            {ACOES.filter((x) => x.grupo === g).map((x) => (
              <option key={x.tipo} value={x.tipo}>
                {x.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="gt-acao__valor">{valor}</div>
      <button type="button" className="icon-btn" aria-label="Remover ação" disabled={!onRemover} onClick={onRemover}>
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------- Simular ----------
function Simular({ rascunho, dados }: { rascunho: { id?: number; todas: CondicaoGatilho[]; qualquer: CondicaoGatilho[] }; dados: Dados }) {
  const [numero, setNumero] = useState("");
  const [autor, setAutor] = useState<AutorGatilho>("agente");
  const simular = useMutation({ mutationFn: (p: { ticket: number }) => gatilhosService.simular({ ...rascunho, autor }, p.ticket) });
  const r: SimulacaoGatilho | undefined = simular.data;
  const linha = (x: { condicao: CondicaoGatilho; ok: boolean }, i: number) => (
    <li key={i} className={x.ok ? "gt-ok" : "gt-nao"}>
      <span aria-hidden="true">{x.ok ? "✔" : "✘"}</span> {textoCondicao(x.condicao, dados)}
    </li>
  );
  return (
    <div className="cad-editor gt-simular">
      <h3>
        <Zap size={16} aria-hidden="true" /> Simular em um ticket
      </h3>
      <p className="ch-muted" style={{ margin: 0, fontSize: 12 }}>
        Confere as condições em edição (salvas ou não) num ticket real. Não altera nada.
      </p>
      <form
        className="gt-sim-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (numero) simular.mutate({ ticket: Number(numero) });
        }}
      >
        <input className="input" inputMode="numeric" aria-label="Número do ticket" placeholder="Nº do ticket" value={numero} onChange={(e) => setNumero(e.target.value.replace(/\D/g, ""))} />
        <select className="input" aria-label="Quem fez a ação" value={autor} onChange={(e) => setAutor(e.target.value as AutorGatilho)}>
          {Object.entries(AUTORES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn--outline" disabled={!numero || simular.isPending}>
          Simular
        </button>
      </form>
      {simular.isError && (
        <p className="cad-erro" role="alert">
          {mensagem(simular.error, "Não foi possível simular.")}
        </p>
      )}
      {r && (
        <div aria-live="polite" className="gt-sim-res">
          <p style={{ margin: 0 }}>
            <Link to={`${getMenuItem("gestao_chamados_tickets").path}/${r.ticket.id}`}>#{r.ticket.id}</Link> · {r.ticket.assunto}
          </p>
          {r.todas.length > 0 && (
            <>
              <b>TODAS</b>
              <ul>{r.todas.map(linha)}</ul>
            </>
          )}
          {r.qualquer.length > 0 && (
            <>
              <b>QUALQUER</b>
              <ul>{r.qualquer.map(linha)}</ul>
            </>
          )}
          {r.todas.length + r.qualquer.length === 0 && <p className="ch-muted" style={{ margin: 0 }}>Sem condições: vale para todo ticket do disparo.</p>}
          <div className={`gt-veredito${r.executaria ? " gt-veredito--sim" : ""}`}>
            Resultado: <b>{r.executaria ? "executaria" : "não executaria"}</b>
            {r.executaria ? " quando o disparo acontecer." : ", porque uma condição falhou."}
            {r.jaExecutou && " Já executou neste ticket antes."}
          </div>
        </div>
      )}
      <div className="gt-nota">
        Ações feitas por um gatilho <b>não disparam outros gatilhos</b>. Cada execução fica no histórico do ticket ("Gatilho: …") e em Execuções.
      </div>
    </div>
  );
}

// ---------- Execuções ----------
function Execucoes({ gatilhos, inicial, onVoltar }: { gatilhos: Gatilho[]; inicial: number | null; onVoltar: () => void }) {
  const [gatilhoId, setGatilhoId] = useState<number | null>(inicial);
  const [dias, setDias] = useState(30);
  const q = useExecucoesGatilhos(dias, gatilhoId);
  const fmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const ticketsPath = getMenuItem("gestao_chamados_tickets").path;
  return (
    <section className="cad-card" aria-labelledby="gt-exec-t">
      <div className="cad-head">
        <div>
          <h2 id="gt-exec-t">Execuções dos gatilhos</h2>
          <small>Erros aparecem aqui e no histórico do ticket, e não travam o atendimento.</small>
        </div>
        <span className="cad-head__spacer" />
        <select className="input" aria-label="Gatilho" value={gatilhoId ?? ""} onChange={(e) => setGatilhoId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Todos os gatilhos</option>
          {gatilhos.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Período" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
          <option value={7}>7 dias</option>
          <option value={30}>30 dias</option>
          <option value={90}>90 dias</option>
        </select>
        <button type="button" className="btn btn--outline" onClick={onVoltar}>
          ← Gatilhos
        </button>
      </div>
      {q.isPending ? (
        <p className="cad-vazio">Carregando…</p>
      ) : q.isError ? (
        <ErrorState message="Não foi possível carregar as execuções." onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="cad-vazio">Nenhuma execução no período.</p>
      ) : (
        <table className="cad-table gt-tabela gt-exec">
          <thead>
            <tr>
              <th><ThLabel icon={Clock}>Quando</ThLabel></th>
              <th><ThLabel icon={Zap}>Gatilho</ThLabel></th>
              <th><ThLabel icon={Ticket}>Ticket</ThLabel></th>
              <th><ThLabel icon={Activity}>Disparo</ThLabel></th>
              <th><ThLabel icon={CircleCheckBig}>Resultado</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id}>
                <td>{fmt.format(new Date(e.criadoEm))}</td>
                <td>{e.gatilho}</td>
                <td>
                  <Link to={`${ticketsPath}/${e.ticketId}`}>#{e.ticketId}</Link>
                </td>
                <td>{DISPAROS.find((d) => d.tipo === e.disparo)?.label.replace(/ [≥≤]$/, "") ?? e.disparo}</td>
                <td>
                  <span className={`ch-badge ${e.resultado === "executado" ? "ch-badge--success" : "ch-badge--danger"}`}>{e.resultado === "executado" ? "Executado" : "Erro"}</span> {e.detalhe}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
