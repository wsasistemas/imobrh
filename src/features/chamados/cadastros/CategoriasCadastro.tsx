import { ArrowUpDown, CircleDot, FolderTree, Plus, Star, Wrench } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { useSalvarCategoria } from "../hooks";
import { ComCadastros, linhaProps, mensagem, OrdemBotoes, Rodape, Situacao } from "./comum";
import { caminhoServico, type Cadastros, type Categoria } from "./types";

/** Administração › Categorias: o tipo do ticket (Dúvida, Problema, Solicitação…). */
export function CategoriasCadastro() {
  return <ComCadastros>{(c) => <Conteudo cad={c} />}</ComCadastros>;
}

function Conteudo({ cad }: { cad: Cadastros }) {
  const [edicao, setEdicao] = useState<Categoria | "nova" | null>(null);
  const lista = [...cad.categorias].sort((a, b) => a.ordem - b.ordem);
  const ids = lista.map((c) => c.id);
  const servicosDe = (c: Categoria) =>
    c.servicos === null ? "Todos" : c.servicos.map((id) => cad.servicos.find((s) => s.id === id)?.nome).filter(Boolean).join(", ") || "—";

  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="cad-cat-t">
        <div className="cad-head">
          <div>
            <h2 id="cad-cat-t">Categorias</h2>
            <small>O tipo do ticket. Entra nas visões, nos relatórios e nas regras para exibição.</small>
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
              <th><ThLabel icon={ArrowUpDown}>Ordem</ThLabel></th>
              <th><ThLabel icon={FolderTree}>Categoria</ThLabel></th>
              <th><ThLabel icon={Wrench}>Serviços</ThLabel></th>
              <th><ThLabel icon={Star}>Padrão</ThLabel></th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((c, i) => (
              <tr key={c.id} className={c.ativa ? undefined : "cad-inativo"} {...linhaProps(edicao !== "nova" && edicao?.id === c.id, () => setEdicao(c))}>
                <td>
                  <OrdemBotoes tabela="categorias" ids={ids} index={i} nome={c.nome} />
                </td>
                <td>
                  <b>{c.nome}</b>
                  {c.descricao && <span className="cad-sub">{c.descricao}</span>}
                </td>
                <td>{servicosDe(c)}</td>
                <td>{c.padrao && <span className="ch-badge ch-badge--info">Padrão</span>}</td>
                <td>
                  <Situacao ativo={c.ativa} feminino />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <Editor key={edicao === "nova" ? "nova" : edicao.id} cad={cad} categoria={edicao === "nova" ? null : edicao} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha uma categoria para editar, ou crie uma nova.</p>
        )}
      </aside>
    </div>
  );
}

function Editor({ cad, categoria, onFechar }: { cad: Cadastros; categoria: Categoria | null; onFechar: () => void }) {
  const salvar = useSalvarCategoria();
  const [nome, setNome] = useState(categoria?.nome ?? "");
  const [descricao, setDescricao] = useState(categoria?.descricao ?? "");
  const [todos, setTodos] = useState(categoria?.servicos === null || !categoria);
  const [servicos, setServicos] = useState<number[]>(categoria?.servicos ?? []);
  const [padrao, setPadrao] = useState(categoria?.padrao ?? false);
  const [ativa, setAtiva] = useState(categoria?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);
  // Só os níveis que organizam ou são escolhidos (todos), com o caminho completo.
  const opcoes = [...cad.servicos].sort((a, b) => caminhoServico(a.id, cad.servicos).localeCompare(caminhoServico(b.id, cad.servicos), "pt-BR"));

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: categoria?.id, nome, descricao, servicos: todos ? null : servicos, padrao, ativa },
      {
        onSuccess: () => {
          toast.success(categoria ? "Categoria salva" : "Categoria criada");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar a categoria.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{categoria ? `Editar categoria · ${categoria.nome}` : "Nova categoria"}</h3>
      <label className="field">
        <span className="field__label">Nome</span>
        <input className="input" maxLength={40} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field__label">Descrição</span>
        <textarea className="input" rows={2} maxLength={300} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </label>
      <div className="field">
        <span className="field__label">Vale para</span>
        <div className="cad-checks" role="radiogroup" aria-label="Vale para">
          <label>
            <input type="radio" checked={todos} onChange={() => setTodos(true)} /> Todos os serviços
          </label>
          <label>
            <input type="radio" checked={!todos} onChange={() => setTodos(false)} /> Só estes serviços (e os de dentro deles)
          </label>
        </div>
        {!todos && (
          <div className="cad-multi" role="group" aria-label="Serviços">
            {opcoes.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={servicos.includes(s.id)}
                  onChange={(e) => setServicos((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))}
                />
                {caminhoServico(s.id, cad.servicos)}
              </label>
            ))}
          </div>
        )}
      </div>
      <label className="cad-check">
        <input type="checkbox" checked={padrao} onChange={(e) => setPadrao(e.target.checked)} />
        Categoria padrão
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
        Ativa
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
