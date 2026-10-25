import { ArrowUpDown, Asterisk, CircleDot, LayoutPanelTop, ListPlus, Plus, Shapes } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { useSalvarCampo } from "../hooks";
import { ComCadastros, linhaProps, mensagem, OrdemBotoes, Rodape, Situacao } from "./comum";
import { chaveDoRotulo, LOCAIS_CAMPO, TIPOS_CAMPO, type Cadastros, type Campo, type LocalCampo, type Obrigatoriedade, type TipoCampo } from "./types";

const OBRIGATORIEDADE: Record<Obrigatoriedade, string> = { regra: "Só quando uma regra mandar", sempre: "Sempre", nao: "Não" };

/** Administração › Campos adicionais: campos próprios do ticket (quando aparecem: Regras para exibição). */
export function CamposCadastro() {
  return <ComCadastros>{(c) => <Conteudo cad={c} />}</ComCadastros>;
}

function Conteudo({ cad }: { cad: Cadastros }) {
  const [edicao, setEdicao] = useState<Campo | "novo" | null>(null);
  const lista = [...cad.campos].sort((a, b) => a.ordem - b.ordem);
  const ids = lista.map((c) => c.id);

  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="cad-campos-t">
        <div className="cad-head">
          <div>
            <h2 id="cad-campos-t">Campos adicionais</h2>
            <small>Campos próprios do ticket. Quando aparecem é decidido em Regras para exibição.</small>
          </div>
          <span className="cad-head__spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setEdicao("novo")}>
            <Plus size={16} aria-hidden="true" />
            Novo campo
          </button>
        </div>
        <table className="cad-table">
          <thead>
            <tr>
              <th><ThLabel icon={ArrowUpDown}>Ordem</ThLabel></th>
              <th><ThLabel icon={ListPlus}>Campo</ThLabel></th>
              <th><ThLabel icon={Shapes}>Tipo</ThLabel></th>
              <th><ThLabel icon={LayoutPanelTop}>Onde aparece</ThLabel></th>
              <th><ThLabel icon={Asterisk}>Obrigatório</ThLabel></th>
              <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((c, i) => (
              <tr key={c.id} className={c.ativo ? undefined : "cad-inativo"} {...linhaProps(edicao !== "novo" && edicao?.id === c.id, () => setEdicao(c))}>
                <td>
                  <OrdemBotoes tabela="campos" ids={ids} index={i} nome={c.rotulo} />
                </td>
                <td>
                  <b>{c.rotulo}</b>
                  <span className="cad-sub ch-mono">{c.chave}</span>
                </td>
                <td>{TIPOS_CAMPO[c.tipo]}</td>
                <td>
                  <span className="cad-chips">
                    {c.aparece.map((l) => (
                      <span key={l} className="ch-badge">
                        {LOCAIS_CAMPO[l]}
                      </span>
                    ))}
                    {c.interno && <span className="ch-badge ch-badge--warning">Interno</span>}
                  </span>
                </td>
                <td>{c.obrigatorio === "regra" ? "Por regra" : OBRIGATORIEDADE[c.obrigatorio]}</td>
                <td>
                  <Situacao ativo={c.ativo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside className="cad-card">
        {edicao ? (
          <Editor key={edicao === "novo" ? "novo" : edicao.id} campo={edicao === "novo" ? null : edicao} onFechar={() => setEdicao(null)} />
        ) : (
          <p className="cad-vazio">Escolha um campo para editar, ou crie um novo.</p>
        )}
      </aside>
    </div>
  );
}

function Editor({ campo, onFechar }: { campo: Campo | null; onFechar: () => void }) {
  const salvar = useSalvarCampo();
  const [rotulo, setRotulo] = useState(campo?.rotulo ?? "");
  const [chave, setChave] = useState(campo?.chave ?? "");
  const [chaveManual, setChaveManual] = useState(false);
  const [tipo, setTipo] = useState<TipoCampo>(campo?.tipo ?? "texto");
  const [opcoes, setOpcoes] = useState((campo?.opcoes ?? []).join("\n"));
  const [ajuda, setAjuda] = useState(campo?.ajuda ?? "");
  const [aparece, setAparece] = useState<LocalCampo[]>(campo?.aparece ?? ["abertura", "detalhe"]);
  const [interno, setInterno] = useState(campo?.interno ?? false);
  const [obrigatorio, setObrigatorio] = useState<Obrigatoriedade>(campo?.obrigatorio ?? "nao");
  const [usarEmVisoes, setUsarEmVisoes] = useState(campo?.usarEmVisoes ?? true);
  const [ativo, setAtivo] = useState(campo?.ativo ?? true);
  const [erro, setErro] = useState<string | null>(null);
  const chaveFinal = campo ? campo.chave : chaveManual ? chave : chaveDoRotulo(rotulo);
  const comOpcoes = tipo === "lista" || tipo === "multipla";

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      {
        id: campo?.id,
        chave: chaveFinal,
        rotulo,
        tipo,
        opcoes: comOpcoes ? opcoes.split("\n") : [],
        ajuda,
        aparece,
        interno,
        obrigatorio,
        usarEmVisoes,
        ativo,
      },
      {
        onSuccess: () => {
          toast.success(campo ? "Campo salvo" : "Campo criado");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar o campo.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{campo ? `Editar campo · ${campo.rotulo}` : "Novo campo"}</h3>
      <div className="cad-grid2">
        <label className="field">
          <span className="field__label">Nome na tela</span>
          <input className="input" maxLength={60} value={rotulo} onChange={(e) => setRotulo(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="field__label">Chave {campo ? "(não muda)" : ""}</span>
          <input
            className="input ch-mono"
            maxLength={40}
            value={chaveFinal}
            disabled={Boolean(campo)}
            onChange={(e) => {
              setChaveManual(true);
              setChave(e.target.value);
            }}
          />
        </label>
      </div>
      {!campo && <span className="field__help">A chave identifica o campo nas visões, nas regras e na IA. Depois de salvo, ela não muda.</span>}
      <label className="field">
        <span className="field__label">Tipo</span>
        <select className="input" value={tipo} onChange={(e) => setTipo(e.target.value as TipoCampo)}>
          {Object.entries(TIPOS_CAMPO).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {comOpcoes && (
        <label className="field">
          <span className="field__label">Opções (uma por linha)</span>
          <textarea className="input" rows={4} value={opcoes} onChange={(e) => setOpcoes(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span className="field__label">Texto de ajuda</span>
        <input className="input" maxLength={300} value={ajuda} onChange={(e) => setAjuda(e.target.value)} />
      </label>
      <div className="field">
        <span className="field__label">Onde aparece</span>
        <div className="cad-checks">
          {(Object.keys(LOCAIS_CAMPO) as LocalCampo[]).map((l) => (
            <label key={l}>
              <input type="checkbox" checked={aparece.includes(l)} onChange={(e) => setAparece((xs) => (e.target.checked ? [...xs, l] : xs.filter((x) => x !== l)))} />
              {LOCAIS_CAMPO[l]}
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field__label">Obrigatório</span>
        <select className="input" value={obrigatorio} onChange={(e) => setObrigatorio(e.target.value as Obrigatoriedade)}>
          {Object.entries(OBRIGATORIEDADE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {obrigatorio === "regra" && <span className="field__help">O campo fica escondido até uma regra mandar exibir ou obrigar.</span>}
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={interno} onChange={(e) => setInterno(e.target.checked)} />
        Interno (aba Interno; o solicitante não vê)
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={usarEmVisoes} onChange={(e) => setUsarEmVisoes(e.target.checked)} />
        Pode ser usado nas condições e colunas das visões de Tickets
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
        Ativo
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
