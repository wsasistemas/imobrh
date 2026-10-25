import { Building2, CalendarRange, CircleDot, Flag, Hash, ListChecks, Plus, Tags, User, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../components/ds";
import { PageSkeleton } from "../../components/PageSkeleton";
import { ErrorState } from "../configuracoes/components/ErrorState";
import { linhaProps, mensagem, Rodape, Situacao } from "../chamados/cadastros/comum";
import { moeda } from "./cadeia";
import { useCadastrosFinanceiros, useSalvarCategoria, useSalvarFundoFixo, useSalvarRegra } from "./hooks";
import type { CadastrosFinanceiros as Dados, CategoriaMotivo, FundoFixo, Opcao, RegraAceitacao } from "./service";
import "../chamados/pages/Chamados.css";
import "../chamados/cadastros/Cadastros.css";
import "./financeiro.css";

// Solicitações Financeiras › Cadastros financeiros (Admin e Super admin): valor do fundo fixo por colaborador,
// categorias de motivo (a leitura sugere só entre as ativas) e parâmetros das regras de aceitação.

type Aba = "fundos" | "categorias" | "regras";
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: "fundos", rotulo: "Fundo fixo por colaborador" },
  { id: "categorias", rotulo: "Categorias de motivo" },
  { id: "regras", rotulo: "Regras de aceitação" },
];

export function CadastrosFinanceiros() {
  const q = useCadastrosFinanceiros();
  const [aba, setAba] = useState<Aba>("fundos");
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar os cadastros financeiros." onRetry={() => void q.refetch()} />;
  return (
    <>
      <div className="sf-abas-setor" role="tablist" aria-label="Cadastros financeiros">
        {ABAS.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={aba === a.id} onClick={() => setAba(a.id)}>
            {a.rotulo}
          </button>
        ))}
      </div>
      {aba === "fundos" && <Fundos dados={q.data} />}
      {aba === "categorias" && <Categorias categorias={q.data.categorias} />}
      {aba === "regras" && <Regras regras={q.data.regras} />}
    </>
  );
}

// ---------- Fundo fixo ----------
function Fundos({ dados }: { dados: Dados }) {
  const [edicao, setEdicao] = useState<FundoFixo | "novo" | null>(null);
  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="sf-ff-t">
        <div className="cad-head">
          <div>
            <h2 id="sf-ff-t">Fundo fixo por colaborador</h2>
            <small>Valor do caixinha de cada pessoa. Um valor novo encerra o anterior.</small>
          </div>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setEdicao("novo")}>
            <Plus size={16} aria-hidden="true" />
            Novo fundo fixo
          </button>
        </div>
        <table className="cad-table">
          <thead>
            <tr>
              <th><ThLabel icon={User}>Colaborador</ThLabel></th>
              <th><ThLabel icon={Building2}>Setor</ThLabel></th>
              <th><ThLabel icon={Wallet}>Valor do fundo</ThLabel></th>
              <th><ThLabel icon={CalendarRange}>Vigente desde</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {dados.fundos.map((f) => (
              <tr key={f.id} {...linhaProps(edicao !== "novo" && edicao?.id === f.id, () => setEdicao(f))}>
                <td><b>{f.usuario}</b></td>
                <td>{f.setor ?? <span className="ch-vazio">Sem setor</span>}</td>
                <td>{moeda(f.valor)}</td>
                <td>{new Date(`${f.vigenteDesde}T12:00:00`).toLocaleDateString("pt-BR")}</td>
              </tr>
            ))}
            {dados.fundos.length === 0 && (
              <tr><td colSpan={4} className="cad-vazio">Nenhum fundo fixo cadastrado.</td></tr>
            )}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <EditorFundo key={edicao === "novo" ? "novo" : edicao.id} fundo={edicao === "novo" ? null : edicao} usuarios={dados.usuarios} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha um colaborador para editar, ou cadastre um novo fundo fixo.</p>
        )}
      </aside>
    </div>
  );
}

function EditorFundo({ fundo, usuarios, onFechar }: { fundo: FundoFixo | null; usuarios: Opcao[]; onFechar: () => void }) {
  const salvar = useSalvarFundoFixo();
  const [usuarioId, setUsuarioId] = useState(fundo?.usuarioId ?? "");
  const [valor, setValor] = useState(fundo ? String(fundo.valor) : "");
  const [desde, setDesde] = useState(new Date().toISOString().slice(0, 10));
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { usuarioId, valor: Number(valor.replace(",", ".")) || 0, vigenteDesde: desde },
      { onSuccess: () => { toast.success("Fundo fixo salvo"); onFechar(); }, onError: (er) => setErro(mensagem(er, "Não foi possível salvar o fundo fixo.")) },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{fundo ? `Fundo fixo de ${fundo.usuario}` : "Novo fundo fixo"}</h3>
      <label className="field">
        <span className="field__label">Colaborador</span>
        <select className="input" value={usuarioId} disabled={!!fundo} onChange={(e) => setUsuarioId(e.target.value)}>
          <option value="">Escolha…</option>
          {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field__label">Valor do fundo fixo (R$)</span>
        <input className="input sf-num" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="1000,00" />
        <span className="field__help">Valor 0 retira o fundo fixo do colaborador. O histórico fica guardado.</span>
      </label>
      <label className="field">
        <span className="field__label">Vigente desde</span>
        <input className="input" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}

// ---------- Categorias de motivo ----------
function Categorias({ categorias }: { categorias: CategoriaMotivo[] }) {
  const [edicao, setEdicao] = useState<CategoriaMotivo | "nova" | null>(null);
  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="sf-cat-t">
        <div className="cad-head">
          <div>
            <h2 id="sf-cat-t">Categorias de motivo</h2>
            <small>A leitura dos comprovantes sugere o motivo só entre as categorias ativas. O teto alimenta a regra R08.</small>
          </div>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setEdicao("nova")}>
            <Plus size={16} aria-hidden="true" />
            Nova categoria
          </button>
        </div>
        <table className="cad-table">
          <thead>
            <tr>
              <th><ThLabel icon={Tags}>Categoria</ThLabel></th>
              <th><ThLabel icon={Hash}>Palavras-chave</ThLabel></th>
              <th><ThLabel icon={Wallet}>Teto por item</ThLabel></th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {categorias.map((c) => (
              <tr key={c.id} className={c.ativo ? undefined : "cad-inativo"} {...linhaProps(edicao !== "nova" && edicao?.id === c.id, () => setEdicao(c))}>
                <td><b>{c.nome}</b></td>
                <td>{c.palavrasChave.length ? c.palavrasChave.join(", ") : <span className="ch-vazio">—</span>}</td>
                <td>{c.tetoValor != null ? moeda(c.tetoValor) : <span className="ch-vazio">Sem teto</span>}</td>
                <td><Situacao ativo={c.ativo} feminino /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <EditorCategoria key={edicao === "nova" ? "nova" : edicao.id} cat={edicao === "nova" ? null : edicao} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha uma categoria para editar, ou crie uma nova.</p>
        )}
      </aside>
    </div>
  );
}

function EditorCategoria({ cat, onFechar }: { cat: CategoriaMotivo | null; onFechar: () => void }) {
  const salvar = useSalvarCategoria();
  const [nome, setNome] = useState(cat?.nome ?? "");
  const [descricao, setDescricao] = useState(cat?.descricao ?? "");
  const [chaves, setChaves] = useState(cat?.palavrasChave.join(", ") ?? "");
  const [teto, setTeto] = useState(cat?.tetoValor != null ? String(cat.tetoValor) : "");
  const [ativo, setAtivo] = useState(cat?.ativo ?? true);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      {
        id: cat?.id, nome, descricao: descricao.trim() || null, ativo,
        palavrasChave: chaves.split(",").map((c) => c.trim()).filter(Boolean),
        tetoValor: teto.trim() ? Number(teto.replace(",", ".")) : null,
      },
      { onSuccess: () => { toast.success(cat ? "Categoria salva" : "Categoria criada"); onFechar(); }, onError: (er) => setErro(mensagem(er, "Não foi possível salvar a categoria.")) },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{cat ? "Editar categoria" : "Nova categoria"}</h3>
      <label className="field">
        <span className="field__label">Nome</span>
        <input className="input" maxLength={60} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field__label">Descrição (opcional)</span>
        <input className="input" maxLength={300} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Palavras-chave</span>
        <input className="input" placeholder="gasolina, etanol, posto" value={chaves} onChange={(e) => setChaves(e.target.value)} />
        <span className="field__help">Separe por vírgula. Ajudam a leitura a sugerir esta categoria.</span>
      </label>
      <label className="field">
        <span className="field__label">Teto por item (R$, opcional)</span>
        <input className="input sf-num" inputMode="decimal" value={teto} onChange={(e) => setTeto(e.target.value)} placeholder="Sem teto" />
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
        Ativa (aparece nos formulários e na sugestão de motivo)
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}

// ---------- Regras de aceitação ----------

/** Parâmetro editável de cada regra (o que o PRD deixa configurável). */
const PARAMETRO: Partial<Record<string, { chave: string; rotulo: string; ajuda: string; lista?: boolean; percentual?: boolean }>> = {
  R02: { chave: "limiar", rotulo: "Legibilidade mínima (%)", ajuda: "Abaixo disso o campo não é copiado do comprovante.", percentual: true },
  R04: { chave: "tolerancia", rotulo: "Tolerância de valor (R$)", ajuda: "Diferença aceita entre o comprovante e o valor declarado." },
  R07: { chave: "itens_proibidos", rotulo: "Itens proibidos", ajuda: "Separe por vírgula (ex.: itens que o Financeiro não reembolsa).", lista: true },
  R09: { chave: "dias", rotulo: "Prazo de envio (dias após a competência)", ajuda: "Vazio = ainda não definido (a regra não alerta)." },
};

function textoParametro(r: RegraAceitacao): string {
  const p = PARAMETRO[r.codigo];
  if (!p) return "—";
  const v = r.parametros[p.chave];
  if (v == null || (Array.isArray(v) && v.length === 0)) return "A definir";
  if (p.percentual) return `${Math.round(Number(v) * 100)}%`;
  if (p.lista) return (v as string[]).join(", ");
  if (r.codigo === "R04") return moeda(Number(v));
  return `${v} dias`;
}

function Regras({ regras }: { regras: RegraAceitacao[] }) {
  const [edicao, setEdicao] = useState<RegraAceitacao | null>(null);
  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="sf-reg-t">
        <div className="cad-head">
          <div>
            <h2 id="sf-reg-t">Regras de aceitação</h2>
            <small>Rodam ao anexar e de novo na conferência. Bloqueio impede o envio; alerta fica para o conferente decidir.</small>
          </div>
        </div>
        <table className="cad-table">
          <thead>
            <tr>
              <th><ThLabel icon={Hash}>Código</ThLabel></th>
              <th><ThLabel icon={ListChecks}>Regra</ThLabel></th>
              <th><ThLabel icon={Flag}>Se falhar</ThLabel></th>
              <th>Parâmetro</th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {regras.map((r) => (
              <tr key={r.codigo} className={r.ativo ? undefined : "cad-inativo"} {...linhaProps(edicao?.codigo === r.codigo, () => setEdicao(r))}>
                <td><b>{r.codigo}</b></td>
                <td>
                  {r.nome}
                  <span className="cad-sub">{r.aplicaA === "adiantamento" ? "Adiantamento" : "Reembolso e fundo fixo"}</span>
                </td>
                <td><span className={`sf-chip ${r.severidade === "bloqueio" ? "sf-chip--erro" : "sf-chip--aviso"}`}>{r.severidade === "bloqueio" ? "Bloqueio" : "Alerta"}</span></td>
                <td>{textoParametro(r)}</td>
                <td><Situacao ativo={r.ativo} feminino /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <EditorRegra key={edicao.codigo} regra={edicao} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha uma regra para ajustar.</p>
        )}
      </aside>
    </div>
  );
}

function EditorRegra({ regra, onFechar }: { regra: RegraAceitacao; onFechar: () => void }) {
  const salvar = useSalvarRegra();
  const p = PARAMETRO[regra.codigo];
  const atual = p ? regra.parametros[p.chave] : null;
  const inicial = atual == null ? "" : p?.lista ? (atual as string[]).join(", ") : p?.percentual ? String(Math.round(Number(atual) * 100)) : String(atual);
  const [valor, setValor] = useState(inicial);
  const [ativo, setAtivo] = useState(regra.ativo);
  const [severidade, setSeveridade] = useState(regra.severidade);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    let parametros: Record<string, unknown> = {};
    if (p) {
      const t = valor.trim();
      parametros = {
        [p.chave]: p.lista ? t.split(",").map((x) => x.trim()).filter(Boolean) : t === "" ? null : p.percentual ? Number(t) / 100 : Number(t.replace(",", ".")),
      };
    }
    salvar.mutate(
      { codigo: regra.codigo, ativo, severidade, parametros },
      { onSuccess: () => { toast.success(`Regra ${regra.codigo} salva`); onFechar(); }, onError: (er) => setErro(mensagem(er, "Não foi possível salvar a regra.")) },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{regra.codigo} · {regra.nome}</h3>
      {regra.descricao && <p className="field__help">{regra.descricao}</p>}
      <label className="field">
        <span className="field__label">Se falhar</span>
        <select className="input" value={severidade} onChange={(e) => setSeveridade(e.target.value as RegraAceitacao["severidade"])}>
          <option value="bloqueio">Bloqueio (impede o envio)</option>
          <option value="alerta">Alerta (conferente decide)</option>
        </select>
      </label>
      {p && (
        <label className="field">
          <span className="field__label">{p.rotulo}</span>
          <input className="input" inputMode={p.lista ? "text" : "decimal"} value={valor} onChange={(e) => setValor(e.target.value)} placeholder="A definir" />
          <span className="field__help">{p.ajuda}</span>
        </label>
      )}
      <label className="cad-check">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
        Ativa
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
