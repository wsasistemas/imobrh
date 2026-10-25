import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useSalvarRegra } from "../hooks";
import { ComCadastros, mensagem, OrdemBotoes, Rodape, Situacao } from "./comum";
import { estadoCampos } from "./regras";
import {
  ACOES_REGRA,
  caminhoServico,
  OPERADORES_REGRA,
  type AcaoRegra,
  type Cadastros,
  type CampoRegra,
  type CondicaoRegra,
  type OperadorRegra,
  type Regra,
} from "./types";

const ORIGENS = [
  { value: "email", label: "E-mail" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "intranet", label: "Intranet" },
  { value: "agente", label: "Agente" },
];

/** Administração › Regras para exibição: quando cada campo adicional aparece ou é obrigatório. */
export function RegrasCadastro() {
  return <ComCadastros>{(c) => <Conteudo cad={c} />}</ComCadastros>;
}

/** Opções de valor para o campo da condição. */
function opcoesDe(campo: CampoRegra, cad: Cadastros): { value: string; label: string }[] | null {
  if (campo === "servico") return [...cad.servicos].map((s) => ({ value: String(s.id), label: caminhoServico(s.id, cad.servicos) })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  if (campo === "categoria") return cad.categorias.map((c) => ({ value: String(c.id), label: c.nome }));
  if (campo === "urgencia") return cad.urgencias.map((u) => ({ value: String(u.id), label: u.nome }));
  if (campo === "setor") return cad.setores.map((s) => ({ value: String(s.id), label: s.nome }));
  if (campo === "origem") return ORIGENS;
  const c = cad.campos.find((x) => `campo:${x.chave}` === campo);
  if (c && (c.tipo === "lista" || c.tipo === "multipla")) return c.opcoes.map((o) => ({ value: o, label: o }));
  if (c && c.tipo === "sim_nao") return [{ value: "true", label: "Sim" }, { value: "false", label: "Não" }];
  return null;
}

function nomeCampoRegra(campo: CampoRegra, cad: Cadastros): string {
  const fixos: Record<string, string> = { servico: "Serviço", categoria: "Categoria", urgencia: "Urgência", setor: "Setor", origem: "Origem" };
  return fixos[campo] ?? cad.campos.find((c) => `campo:${c.chave}` === campo)?.rotulo ?? campo;
}

function resumo(r: Regra, cad: Cadastros): string {
  const cond = r.condicoes
    .map((c) => {
      const ops = opcoesDe(c.campo, cad);
      const vals = c.valores.map((v) => ops?.find((o) => o.value === v)?.label ?? v).join(", ");
      return `${nomeCampoRegra(c.campo, cad)} ${OPERADORES_REGRA[c.operador]}${vals ? ` ${vals}` : ""}`;
    })
    .join(" e ");
  const acoes = r.acoes.map((a) => `${ACOES_REGRA[a.acao].toLowerCase()} ${cad.campos.find((c) => c.chave === a.campo)?.rotulo ?? a.campo}`).join("; ");
  return `Se ${cond} → ${acoes}`;
}

function Conteudo({ cad }: { cad: Cadastros }) {
  const [edicao, setEdicao] = useState<Regra | "nova" | null>(null);
  const [rascunho, setRascunho] = useState<Regra | null>(null);
  const lista = [...cad.regras].sort((a, b) => a.ordem - b.ordem);
  const ids = lista.map((r) => r.id);

  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="cad-regras-t">
        <div className="cad-head">
          <div>
            <h2 id="cad-regras-t">Regras para exibição</h2>
            <small>Aplicadas de cima para baixo; havendo conflito, vale a última. "Obrigatório" também é conferido no banco ao resolver.</small>
          </div>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setEdicao("nova")}>
            <Plus size={16} aria-hidden="true" />
            Nova regra
          </button>
        </div>
        {lista.length === 0 && <p className="cad-vazio">Nenhuma regra ainda.</p>}
        {lista.map((r, i) => (
          <div key={r.id} style={{ display: "flex", alignItems: "stretch" }}>
            <div style={{ padding: "10px 4px 0 10px" }}>
              <OrdemBotoes tabela="regras" ids={ids} index={i} nome={r.nome} />
            </div>
            <button type="button" className="cad-regra" aria-selected={edicao !== "nova" && edicao?.id === r.id} onClick={() => setEdicao(r)}>
              <span className="cad-regra__h">
                {r.nome}
                <span className="cad-head__spacer" />
                <Situacao ativo={r.ativa} feminino />
              </span>
              <p>{resumo(r, cad)}</p>
            </button>
          </div>
        ))}
      </section>
      <aside style={{ display: "grid", gap: 16 }}>
        <div className="cad-card">
          {edicao ? (
            <Editor
              key={edicao === "nova" ? "nova" : edicao.id}
              cad={cad}
              regra={edicao === "nova" ? null : edicao}
              onRascunho={setRascunho}
              onFechar={() => {
                setEdicao(null);
                setRascunho(null);
              }}
            />
          ) : (
            <p className="cad-vazio">Escolha uma regra para editar, ou crie uma nova.</p>
          )}
        </div>
        <div className="cad-card">
          <Testar cad={cad} rascunho={rascunho} />
        </div>
      </aside>
    </div>
  );
}

function Editor({ cad, regra, onRascunho, onFechar }: { cad: Cadastros; regra: Regra | null; onRascunho: (r: Regra | null) => void; onFechar: () => void }) {
  const salvar = useSalvarRegra();
  const [nome, setNome] = useState(regra?.nome ?? "");
  const [condicoes, setCondicoes] = useState<CondicaoRegra[]>(regra?.condicoes ?? [{ campo: "servico", operador: "um_de", valores: [] }]);
  const [acoes, setAcoes] = useState<Regra["acoes"]>(regra?.acoes ?? [{ acao: "obrigar", campo: cad.campos[0]?.chave ?? "" }]);
  const [ativa, setAtiva] = useState(regra?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);
  const camposRegra: CampoRegra[] = ["servico", "categoria", "urgencia", "setor", "origem", ...cad.campos.map((c) => `campo:${c.chave}` as CampoRegra)];

  // O painel "Testar regras" usa o que está sendo editado.
  const atualizar = (c: CondicaoRegra[], a: Regra["acoes"], at: boolean) =>
    onRascunho({ id: regra?.id ?? -1, nome, ordem: regra?.ordem ?? 9999, condicoes: c, acoes: a, ativa: at });
  const mudarCond = (i: number, c: CondicaoRegra) => {
    const nova = condicoes.map((x, k) => (k === i ? c : x));
    setCondicoes(nova);
    atualizar(nova, acoes, ativa);
  };
  const mudarAcoes = (nova: Regra["acoes"]) => {
    setAcoes(nova);
    atualizar(condicoes, nova, ativa);
  };

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: regra?.id, nome, condicoes, acoes, ativa },
      {
        onSuccess: () => {
          toast.success(regra ? "Regra salva" : "Regra criada");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar a regra.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{regra ? `Editar regra · ${regra.nome}` : "Nova regra"}</h3>
      <label className="field">
        <span className="field__label">Nome</span>
        <input className="input" maxLength={80} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
      </label>
      <div className="field">
        <span className="field__label">Condições (todas precisam valer)</span>
        <div style={{ display: "grid", gap: 8 }}>
          {condicoes.map((c, i) => {
            const ops = opcoesDe(c.campo, cad);
            const semValor = c.operador === "preenchido" || c.operador === "vazio";
            return (
              <div key={i} className="cad-linha">
                <span className="cad-linha__lg">{i === 0 ? "Se" : "e"}</span>
                <select className="input" aria-label="Campo da condição" value={c.campo} onChange={(e) => mudarCond(i, { campo: e.target.value as CampoRegra, operador: "um_de", valores: [] })}>
                  {camposRegra.map((cr) => (
                    <option key={cr} value={cr}>
                      {nomeCampoRegra(cr, cad)}
                    </option>
                  ))}
                </select>
                <select className="input" aria-label="Operador" value={c.operador} onChange={(e) => mudarCond(i, { ...c, operador: e.target.value as OperadorRegra, valores: [] })}>
                  {Object.entries(OPERADORES_REGRA).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <button type="button" className="icon-btn" aria-label="Remover condição" disabled={condicoes.length === 1} onClick={() => {
                  const nova = condicoes.filter((_, k) => k !== i);
                  setCondicoes(nova);
                  atualizar(nova, acoes, ativa);
                }}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
                {!semValor && (
                  <div className="cad-linha__valores">
                    {ops ? (
                      <div className="cad-multi" role="group" aria-label="Valores">
                        {ops.map((o) => (
                          <label key={o.value}>
                            <input
                              type="checkbox"
                              checked={c.valores.includes(o.value)}
                              onChange={(e) => mudarCond(i, { ...c, valores: e.target.checked ? [...c.valores, o.value] : c.valores.filter((v) => v !== o.value) })}
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
                        value={c.valores.join(", ")}
                        onChange={(e) => mudarCond(i, { ...c, valores: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="btn btn--outline" style={{ justifySelf: "start" }} onClick={() => setCondicoes([...condicoes, { campo: "categoria", operador: "um_de", valores: [] }])}>
            <Plus size={14} aria-hidden="true" />
            Condição
          </button>
        </div>
      </div>
      <div className="field">
        <span className="field__label">Então</span>
        <div style={{ display: "grid", gap: 8 }}>
          {acoes.map((a, i) => (
            <div key={i} className="cad-linha cad-linha--acao">
              <span className="cad-linha__lg">→</span>
              <select className="input" aria-label="Ação" value={a.acao} onChange={(e) => mudarAcoes(acoes.map((x, k) => (k === i ? { ...x, acao: e.target.value as AcaoRegra } : x)))}>
                {Object.entries(ACOES_REGRA).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <select className="input" aria-label="Campo" value={a.campo} onChange={(e) => mudarAcoes(acoes.map((x, k) => (k === i ? { ...x, campo: e.target.value } : x)))}>
                {cad.campos.map((c) => (
                  <option key={c.chave} value={c.chave}>
                    {c.rotulo}
                  </option>
                ))}
              </select>
              <button type="button" className="icon-btn" aria-label="Remover ação" disabled={acoes.length === 1} onClick={() => mudarAcoes(acoes.filter((_, k) => k !== i))}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn--outline" style={{ justifySelf: "start" }} onClick={() => mudarAcoes([...acoes, { acao: "exibir", campo: cad.campos[0]?.chave ?? "" }])}>
            <Plus size={14} aria-hidden="true" />
            Ação
          </button>
        </div>
      </div>
      <label className="cad-check">
        <input type="checkbox" checked={ativa} onChange={(e) => {
          setAtiva(e.target.checked);
          atualizar(condicoes, acoes, e.target.checked);
        }} />
        Ativa
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}

function Testar({ cad, rascunho }: { cad: Cadastros; rascunho: Regra | null }) {
  const folhas = useMemo(
    () => cad.servicos.filter((s) => s.ativo && !cad.servicos.some((f) => f.paiId === s.id)).sort((a, b) => caminhoServico(a.id, cad.servicos).localeCompare(caminhoServico(b.id, cad.servicos), "pt-BR")),
    [cad.servicos],
  );
  const [servicoId, setServicoId] = useState<number | null>(folhas[0]?.id ?? null);
  const [categoriaId, setCategoriaId] = useState<number | null>(cad.categorias.find((c) => c.padrao)?.id ?? null);
  const [urgenciaId, setUrgenciaId] = useState<number | null>(cad.urgencias.find((u) => u.padrao)?.id ?? null);
  const [origem, setOrigem] = useState("email");
  const regras = rascunho ? [...cad.regras.filter((r) => r.id !== rascunho.id), rascunho] : cad.regras;
  const setorId = cad.servicos.find((s) => s.id === servicoId)?.setorId ?? null;
  const estado = estadoCampos(cad.campos, regras, { servicoId, categoriaId, urgenciaId, setorId, origem, campos: {} }, cad.servicos);
  const visiveis = [...cad.campos].filter((c) => c.ativo && estado[c.chave]?.visivel).sort((a, b) => a.ordem - b.ordem);

  return (
    <div className="cad-editor">
      <h3>Testar regras</h3>
      <p className="ch-muted" style={{ margin: 0, fontSize: 12 }}>
        Escolha os dados do ticket e veja os campos adicionais como o agente vai ver{rascunho ? " (com a regra em edição)" : ""}.
      </p>
      <label className="field">
        <span className="field__label">Serviço</span>
        <select className="input" value={servicoId ?? ""} onChange={(e) => setServicoId(e.target.value ? Number(e.target.value) : null)}>
          {folhas.map((s) => (
            <option key={s.id} value={s.id}>
              {caminhoServico(s.id, cad.servicos)}
            </option>
          ))}
        </select>
      </label>
      <div className="cad-grid2">
        <label className="field">
          <span className="field__label">Categoria</span>
          <select className="input" value={categoriaId ?? ""} onChange={(e) => setCategoriaId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {cad.categorias.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Urgência</span>
          <select className="input" value={urgenciaId ?? ""} onChange={(e) => setUrgenciaId(e.target.value ? Number(e.target.value) : null)}>
            {cad.urgencias.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nome}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field__label">Origem</span>
        <select className="input" value={origem} onChange={(e) => setOrigem(e.target.value)}>
          {ORIGENS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="cad-teste" aria-live="polite">
        {visiveis.length === 0 && <span className="ch-muted" style={{ fontSize: 13 }}>Nenhum campo adicional aparece para este ticket.</span>}
        {visiveis.map((c) => (
          <div key={c.chave} className="field" style={{ margin: 0 }}>
            <span className={`field__label${estado[c.chave].obrigatorio ? " req" : ""}`}>{c.rotulo}</span>
            <input className="input" disabled placeholder={estado[c.chave].obrigatorio ? "obrigatório" : "opcional"} />
          </div>
        ))}
      </div>
    </div>
  );
}
