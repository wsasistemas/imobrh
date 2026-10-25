import { AlignLeft, ArrowUpDown, CircleDot, Flag, Plus, Star } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { useSalvarUrgencia } from "../hooks";
import { ComCadastros, linhaProps, mensagem, OrdemBotoes, Rodape, Situacao } from "./comum";
import { CORES_URGENCIA, type Cadastros, type CorUrgencia, type Urgencia } from "./types";

/** Administração › Urgências: níveis da urgência do ticket (os prazos ficam em cada serviço). */
export function UrgenciasCadastro() {
  return <ComCadastros>{(c) => <Conteudo cad={c} />}</ComCadastros>;
}

function Conteudo({ cad }: { cad: Cadastros }) {
  const [edicao, setEdicao] = useState<Urgencia | "nova" | null>(null);
  const lista = [...cad.urgencias].sort((a, b) => a.ordem - b.ordem);
  const ids = lista.map((u) => u.id);

  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="cad-urg-t">
        <div className="cad-head">
          <div>
            <h2 id="cad-urg-t">Urgências</h2>
            <small>Da mais alta para a mais baixa. Os prazos de SLA de cada urgência ficam em Serviços.</small>
          </div>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setEdicao("nova")}>
            <Plus size={16} aria-hidden="true" />
            Nova urgência
          </button>
        </div>
        <table className="cad-table">
          <thead>
            <tr>
              <th><ThLabel icon={ArrowUpDown}>Ordem</ThLabel></th>
              <th><ThLabel icon={Flag}>Urgência</ThLabel></th>
              <th><ThLabel icon={AlignLeft}>Quando usar</ThLabel></th>
              <th><ThLabel icon={Star}>Padrão</ThLabel></th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((u, i) => (
              <tr key={u.id} className={u.ativa ? undefined : "cad-inativo"} {...linhaProps(edicao !== "nova" && edicao?.id === u.id, () => setEdicao(u))}>
                <td>
                  <OrdemBotoes tabela="urgencias" ids={ids} index={i} nome={u.nome} />
                </td>
                <td>
                  <span className="cad-dot" style={{ background: CORES_URGENCIA[u.cor].token }} aria-hidden="true" />
                  <b>{u.nome}</b>
                </td>
                <td className="ch-muted">{u.descricao ?? "—"}</td>
                <td>{u.padrao && <span className="ch-badge ch-badge--info">Padrão</span>}</td>
                <td>
                  <Situacao ativo={u.ativa} feminino />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <Editor key={edicao === "nova" ? "nova" : edicao.id} urgencia={edicao === "nova" ? null : edicao} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha uma urgência para editar, ou crie uma nova.</p>
        )}
      </aside>
    </div>
  );
}

function Editor({ urgencia, onFechar }: { urgencia: Urgencia | null; onFechar: () => void }) {
  const ids = useId();
  const salvar = useSalvarUrgencia();
  const [nome, setNome] = useState(urgencia?.nome ?? "");
  const [cor, setCor] = useState<CorUrgencia>(urgencia?.cor ?? "azul");
  const [descricao, setDescricao] = useState(urgencia?.descricao ?? "");
  const [padrao, setPadrao] = useState(urgencia?.padrao ?? false);
  const [ativa, setAtiva] = useState(urgencia?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { id: urgencia?.id, nome, cor, descricao, padrao, ativa },
      {
        onSuccess: () => {
          toast.success(urgencia ? "Urgência salva" : "Urgência criada");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar a urgência.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{urgencia ? `Editar urgência · ${urgencia.nome}` : "Nova urgência"}</h3>
      <div className="cad-grid2">
        <label className="field">
          <span className="field__label">Nome</span>
          <input id={`${ids}-n`} className="input" maxLength={30} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="field__label">Cor</span>
          <select className="input" value={cor} onChange={(e) => setCor(e.target.value as CorUrgencia)}>
            {Object.entries(CORES_URGENCIA).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field__label">Quando usar</span>
        <textarea className="input" rows={2} maxLength={300} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={padrao} onChange={(e) => setPadrao(e.target.checked)} />
        Urgência padrão (usada quando o serviço não define)
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
        Ativa
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
