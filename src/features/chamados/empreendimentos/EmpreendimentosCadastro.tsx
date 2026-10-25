import { Building2, CircleDot, HardHat, MessageSquare, Percent, Plus, Sparkles, Tags, Ticket } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { linhaProps, mensagem, Rodape, Situacao } from "../cadastros/comum";
import { useEmpreendimentos, useSalvarConfigEmpreendimento, useSalvarEmpreendimento } from "./hooks";
import type { CadastroEmpreendimentos, ConfigSetor, Empreendimento } from "./service";
import "../pages/Chamados.css";
import "../cadastros/Cadastros.css";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Administração › Empreendimentos: o cadastro e, por setor, se o App do solicitante pede e se a IA identifica. */
export function EmpreendimentosCadastro() {
  const q = useEmpreendimentos();
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar os empreendimentos." onRetry={() => void q.refetch()} />;
  return <Conteudo dados={q.data} />;
}

function Conteudo({ dados }: { dados: CadastroEmpreendimentos }) {
  const [edicao, setEdicao] = useState<Empreendimento | "novo" | null>(null);
  const [busca, setBusca] = useState("");
  const termos = norm(busca).split(/\s+/).filter(Boolean);
  const lista = dados.empreendimentos.filter((e) => termos.every((t) => norm(`${e.nome} ${e.apelidos.join(" ")} ${e.cidade ?? ""}`).includes(t)));
  const ativos = dados.empreendimentos.filter((e) => e.ativo).length;

  return (
    <>
      <UsoPorSetor setores={dados.setores} />
      <div className="cad-layout">
        <section className="cad-card" aria-labelledby="cad-emp-t">
          <div className="cad-head">
            <div>
              <h2 id="cad-emp-t">Empreendimentos</h2>
              <small>
                {ativos} ativos de {dados.empreendimentos.length}. A IA usa o nome e os apelidos para descobrir de qual empreendimento é o chamado.
              </small>
            </div>
            <span className="cad-head__spacer" />
            <input className="input" type="search" style={{ maxWidth: 220 }} aria-label="Buscar empreendimento" placeholder="Buscar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
            <button type="button" className="btn btn--primary" onClick={() => setEdicao("novo")}>
              <Plus size={16} aria-hidden="true" />
              Novo empreendimento
            </button>
          </div>
          <table className="cad-table">
            <thead>
              <tr>
                <th><ThLabel icon={HardHat}>Empreendimento</ThLabel></th>
                <th><ThLabel icon={Tags}>Apelidos (para a IA)</ThLabel></th>
                <th><ThLabel icon={Ticket}>Tickets</ThLabel></th>
                <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((e) => (
                <tr key={e.id} className={e.ativo ? undefined : "cad-inativo"} {...linhaProps(edicao !== "novo" && edicao?.id === e.id, () => setEdicao(e))}>
                  <td>
                    <b>{e.nome}</b>
                    {e.cidade && <span className="cad-sub">{e.cidade}</span>}
                  </td>
                  <td>
                    {e.apelidos.length ? (
                      <span className="cad-chips">
                        {e.apelidos.map((a) => (
                          <span key={a} className="ch-badge">
                            {a}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="ch-vazio">—</span>
                    )}
                  </td>
                  <td>{e.tickets || <span className="ch-vazio">—</span>}</td>
                  <td>
                    <Situacao ativo={e.ativo} />
                  </td>
                </tr>
              ))}
              {lista.length === 0 && (
                <tr>
                  <td colSpan={4} className="cad-vazio">
                    Nenhum empreendimento encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <aside className="cad-card">
          {edicao ? (
            <Editor key={edicao === "novo" ? "novo" : edicao.id} emp={edicao === "novo" ? null : edicao} onFechar={() => setEdicao(null)} />
          ) : (
            <p className="cad-vazio">Escolha um empreendimento para editar, ou crie um novo.</p>
          )}
        </aside>
      </div>
    </>
  );
}

/** Por setor: o App do solicitante pede o empreendimento? A IA identifica nos chamados que chegam sem ele? */
function UsoPorSetor({ setores }: { setores: ConfigSetor[] }) {
  const salvar = useSalvarConfigEmpreendimento();
  const gravar = (s: ConfigSetor, mudanca: Partial<ConfigSetor>) =>
    salvar.mutate({ ...s, ...mudanca }, { onSuccess: () => toast.success(`${s.setor}: configuração salva`), onError: (e) => toast.error(mensagem(e, "Não foi possível salvar.")) });

  return (
    <section className="cad-card" aria-labelledby="cad-emp-uso" style={{ marginBottom: 16 }}>
      <div className="cad-head">
        <div>
          <h2 id="cad-emp-uso">Uso por setor</h2>
          <small>Ligar a IA vale para os chamados abertos a partir de agora. Abaixo do limiar, o ticket fica em "Revisar empreendimento" com sugestões.</small>
        </div>
      </div>
      <table className="cad-table">
        <thead>
          <tr>
            <th><ThLabel icon={Building2}>Setor</ThLabel></th>
            <th><ThLabel icon={MessageSquare}>App do solicitante pede o empreendimento</ThLabel></th>
            <th><ThLabel icon={Sparkles}>IA identifica</ThLabel></th>
            <th><ThLabel icon={Percent}>Aplicar sozinho a partir de</ThLabel></th>
          </tr>
        </thead>
        <tbody>
          {setores.map((s) => (
            <tr key={s.setorId}>
              <td>
                <b>{s.setor}</b>
              </td>
              <td>
                <label className="cad-check">
                  <input type="checkbox" checked={s.pedirNoApp} disabled={salvar.isPending} onChange={(e) => gravar(s, { pedirNoApp: e.target.checked })} />
                  {s.pedirNoApp ? "Sim, obrigatório" : "Não"}
                </label>
              </td>
              <td>
                <label className="cad-check">
                  <input type="checkbox" checked={s.iaLigada} disabled={salvar.isPending} onChange={(e) => gravar(s, { iaLigada: e.target.checked })} />
                  {s.iaLigada ? "Ligada" : "Desligada"}
                </label>
              </td>
              <td>
                <select
                  className="input"
                  style={{ maxWidth: 110 }}
                  aria-label={`Limiar da IA em ${s.setor}`}
                  value={s.limiar}
                  disabled={!s.iaLigada || salvar.isPending}
                  onChange={(e) => gravar(s, { limiar: Number(e.target.value) })}
                >
                  {[50, 60, 70, 80, 90, 95].map((n) => (
                    <option key={n} value={n}>
                      {n}%
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Editor({ emp, onFechar }: { emp: Empreendimento | null; onFechar: () => void }) {
  const salvar = useSalvarEmpreendimento();
  const [nome, setNome] = useState(emp?.nome ?? "");
  const [apelidos, setApelidos] = useState(emp?.apelidos.join(", ") ?? "");
  const [cidade, setCidade] = useState(emp?.cidade ?? "");
  const [endereco, setEndereco] = useState(emp?.endereco ?? "");
  const [observacao, setObservacao] = useState(emp?.observacao ?? "");
  const [ativo, setAtivo] = useState(emp?.ativo ?? true);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      {
        id: emp?.id,
        nome,
        apelidos: apelidos.split(",").map((a) => a.trim()).filter(Boolean),
        cidade: cidade.trim() || null,
        endereco: endereco.trim() || null,
        observacao: observacao.trim() || null,
        ativo,
      },
      {
        onSuccess: () => {
          toast.success(emp ? "Empreendimento salvo" : "Empreendimento criado");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar o empreendimento.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{emp ? "Editar empreendimento" : "Novo empreendimento"}</h3>
      <label className="field">
        <span className="field__label">Nome</span>
        <input className="input" maxLength={120} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="field__label">Apelidos</span>
        <input className="input" placeholder="Wave Surf, Surf" value={apelidos} onChange={(e) => setApelidos(e.target.value)} />
        <span className="field__help">Separe por vírgula. Como as pessoas escrevem no chamado. Ajuda a IA a separar nomes parecidos.</span>
      </label>
      <label className="field">
        <span className="field__label">Cidade</span>
        <input className="input" maxLength={80} value={cidade} onChange={(e) => setCidade(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Endereço (opcional)</span>
        <input className="input" maxLength={200} value={endereco} onChange={(e) => setEndereco(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Observação para o técnico</span>
        <textarea className="input" rows={2} maxLength={500} placeholder="Portaria 24h. Rack no subsolo 1." value={observacao} onChange={(e) => setObservacao(e.target.value)} />
      </label>
      <label className="cad-check">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
        Ativo (aparece no App do solicitante, no ticket e para a IA)
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
