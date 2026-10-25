import { CircleCheckBig, CircleDot, Flag, Inbox, MessageSquareReply, Plus, Settings2, Timer, Users, Wrench } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ThLabel } from "../../../components/ds";
import { useSalvarPadroesSetor, useSalvarServico } from "../hooks";
import { ComCadastros, linhaProps, mensagem, Rodape, Situacao } from "./comum";
import { CANAIS, caminhoServico, CORES_URGENCIA, type Cadastros, type Canal, type Servico, type SetorCad, type SlaServico } from "./types";

type Edicao = { tipo: "servico"; servico: Servico | null } | { tipo: "setor"; setor: SetorCad } | null;

/** Administração › Serviços: catálogo em até 3 níveis por setor, com equipe, descrição (IA) e SLA por urgência. */
export function ServicosCadastro() {
  return <ComCadastros>{(c) => <Conteudo cad={c} />}</ComCadastros>;
}

/** Ordem de árvore: setor, depois pai → filhos (pela ordem). */
function arvore(servicos: readonly Servico[], setores: readonly SetorCad[]): Servico[] {
  const saida: Servico[] = [];
  const filhos = (pai: number | null, setor: number) => servicos.filter((s) => s.paiId === pai && s.setorId === setor).sort((a, b) => a.ordem - b.ordem || a.id - b.id);
  const visitar = (s: Servico) => {
    saida.push(s);
    filhos(s.id, s.setorId).forEach(visitar);
  };
  [...setores].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).forEach((st) => filhos(null, st.id).forEach(visitar));
  return saida;
}

function Conteudo({ cad }: { cad: Cadastros }) {
  const [edicao, setEdicao] = useState<Edicao>(null);
  const [setor, setSetor] = useState("");
  const [busca, setBusca] = useState("");
  const ordenados = useMemo(() => arvore(cad.servicos, cad.setores), [cad.servicos, cad.setores]);
  const urgPadrao = cad.urgencias.find((u) => u.padrao) ?? cad.urgencias[0];
  const q = busca.trim().toLowerCase();
  const visiveis = ordenados.filter((s) => (!setor || String(s.setorId) === setor) && (!q || caminhoServico(s.id, cad.servicos).toLowerCase().includes(q)));
  const equipe = (s: Servico) => cad.equipes.find((e) => e.id === s.equipeId)?.nome;
  const slaPadrao = (s: Servico) => s.sla.find((l) => l.urgenciaId === urgPadrao?.id)?.solucaoHoras;
  const setorEscolhido = cad.setores.find((s) => String(s.id) === setor);

  return (
    <div className="cad-layout">
      <section className="cad-card" aria-labelledby="cad-serv-t">
        <div className="cad-head">
          <div>
            <h2 id="cad-serv-t">Serviços</h2>
            <small>Até 3 níveis por setor. O último nível é o que se escolhe no ticket.</small>
          </div>
          <span className="cad-head__spacer" />
          <select className="input" aria-label="Setor" value={setor} onChange={(e) => setSetor(e.target.value)}>
            <option value="">Todos os setores</option>
            {cad.setores.filter((s) => s.recebeChamados || cad.servicos.some((v) => v.setorId === s.id)).map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
          <input className="input" type="search" placeholder="Pesquisar serviço" aria-label="Pesquisar serviço" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {setorEscolhido && (
            <button type="button" className="btn btn--outline" onClick={() => setEdicao({ tipo: "setor", setor: setorEscolhido })}>
              <Settings2 size={15} aria-hidden="true" />
              Padrões do setor
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={() => setEdicao({ tipo: "servico", servico: null })}>
            <Plus size={16} aria-hidden="true" />
            Novo serviço
          </button>
        </div>
        {visiveis.length === 0 ? (
          <p className="cad-vazio">Nenhum serviço com esse filtro.</p>
        ) : (
          <table className="cad-table">
            <thead>
              <tr>
                <th><ThLabel icon={Wrench}>Serviço</ThLabel></th>
                <th><ThLabel icon={Users}>Equipe responsável</ThLabel></th>
                <th><ThLabel icon={Timer}>SLA solução ({urgPadrao?.nome ?? "padrão"})</ThLabel></th>
                <th><ThLabel icon={Inbox}>Disponível em</ThLabel></th>
                <th><ThLabel icon={CircleDot}>Situação</ThLabel></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((s) => (
                <tr
                  key={s.id}
                  className={s.ativo ? undefined : "cad-inativo"}
                  {...linhaProps(edicao?.tipo === "servico" && edicao.servico?.id === s.id, () => setEdicao({ tipo: "servico", servico: s }))}
                >
                  <td className={`cad-n${s.nivel}`}>
                    {s.nome}
                    {s.nivel === 1 && <span className="cad-sub">Setor {cad.setores.find((x) => x.id === s.setorId)?.nome}</span>}
                  </td>
                  <td>{equipe(s) ?? <span className="ch-muted">herda</span>}</td>
                  <td>{slaPadrao(s) ? `${slaPadrao(s)} h úteis` : <span className="ch-muted">herda</span>}</td>
                  <td>
                    <span className="cad-chips">
                      {s.canais.map((c) => (
                        <span key={c} className="ch-badge">
                          {CANAIS[c]}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    <Situacao ativo={s.ativo} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <aside className="cad-card">
        {edicao?.tipo === "servico" && <EditorServico key={edicao.servico?.id ?? "novo"} cad={cad} servico={edicao.servico} onFechar={() => setEdicao(null)} />}
        {edicao?.tipo === "setor" && <EditorSetor key={`setor-${edicao.setor.id}`} cad={cad} setor={edicao.setor} onFechar={() => setEdicao(null)} />}
        {!edicao && <p className="cad-vazio">Escolha um serviço para editar, ou crie um novo. Filtre por setor para ver os padrões do setor.</p>}
      </aside>
    </div>
  );
}

function EditorServico({ cad, servico, onFechar }: { cad: Cadastros; servico: Servico | null; onFechar: () => void }) {
  const salvar = useSalvarServico();
  const [nome, setNome] = useState(servico?.nome ?? "");
  const [paiId, setPaiId] = useState<number | null>(servico?.paiId ?? null);
  const [setorId, setSetorId] = useState<number>(servico?.setorId ?? cad.setores.find((s) => s.recebeChamados)?.id ?? cad.setores[0]?.id ?? 0);
  const [equipeId, setEquipeId] = useState<number | null>(servico?.equipeId ?? null);
  const [descricao, setDescricao] = useState(servico?.descricao ?? "");
  const [urgenciaPadraoId, setUrgencia] = useState<number | null>(servico?.urgenciaPadraoId ?? null);
  const [categoriaPadraoId, setCategoria] = useState<number | null>(servico?.categoriaPadraoId ?? null);
  const [canais, setCanais] = useState<Canal[]>(servico?.canais ?? ["agente", "intranet", "email", "whatsapp"]);
  const [ativo, setAtivo] = useState(servico?.ativo ?? true);
  const [sla, setSla] = useState<SlaServico[]>(servico?.sla ?? []);
  const [erro, setErro] = useState<string | null>(null);

  // Pais possíveis: níveis 1 e 2, fora o próprio serviço e os de dentro dele.
  const descendentes = useMemo(() => {
    const ids = new Set<number>();
    const marcar = (id: number) => {
      for (const f of cad.servicos.filter((s) => s.paiId === id)) {
        ids.add(f.id);
        marcar(f.id);
      }
    };
    if (servico) {
      ids.add(servico.id);
      marcar(servico.id);
    }
    return ids;
  }, [cad.servicos, servico]);
  const pais = cad.servicos.filter((s) => s.nivel < 3 && !descendentes.has(s.id)).sort((a, b) => caminhoServico(a.id, cad.servicos).localeCompare(caminhoServico(b.id, cad.servicos), "pt-BR"));
  const setorAtual = paiId ? (cad.servicos.find((s) => s.id === paiId)?.setorId ?? setorId) : setorId;
  const equipes = cad.equipes.filter((e) => e.setorId === setorAtual || e.id === equipeId);
  const urgencias = [...cad.urgencias].filter((u) => u.ativa).sort((a, b) => a.ordem - b.ordem);

  const valorSla = (urgenciaId: number, campo: "respostaHoras" | "solucaoHoras") => sla.find((l) => l.urgenciaId === urgenciaId)?.[campo] ?? "";
  const mudarSla = (urgenciaId: number, campo: "respostaHoras" | "solucaoHoras", v: string) =>
    setSla((xs) => {
      const atual = xs.find((l) => l.urgenciaId === urgenciaId) ?? { urgenciaId, respostaHoras: null, solucaoHoras: null };
      const novo = { ...atual, [campo]: v === "" ? null : Number(v) };
      return [...xs.filter((l) => l.urgenciaId !== urgenciaId), novo];
    });

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      {
        id: servico?.id,
        nome,
        paiId,
        setorId: setorAtual,
        equipeId,
        descricao,
        urgenciaPadraoId,
        categoriaPadraoId,
        canais,
        ativo,
        sla: sla.filter((l) => l.respostaHoras !== null || l.solucaoHoras !== null),
      },
      {
        onSuccess: () => {
          toast.success(servico ? "Serviço salvo" : "Serviço criado");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar o serviço.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>{servico ? `Editar serviço · ${servico.nome}` : "Novo serviço"}</h3>
      <label className="field">
        <span className="field__label">Nome</span>
        <input className="input" maxLength={80} value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
      </label>
      <div className="cad-grid2">
        <label className="field">
          <span className="field__label">Dentro de</span>
          <select className="input" value={paiId ?? ""} onChange={(e) => setPaiId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— Raiz do setor —</option>
            {pais.map((s) => (
              <option key={s.id} value={s.id}>
                {caminhoServico(s.id, cad.servicos)}
              </option>
            ))}
          </select>
        </label>
        {paiId === null ? (
          <label className="field">
            <span className="field__label">Setor</span>
            <select className="input" value={setorId} onChange={(e) => setSetorId(Number(e.target.value))}>
              {cad.setores.filter((s) => s.recebeChamados || s.id === setorId).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field">
            <span className="field__label">Setor</span>
            <span className="input" aria-readonly="true">
              {cad.setores.find((s) => s.id === setorAtual)?.nome}
            </span>
          </div>
        )}
      </div>
      <label className="field">
        <span className="field__label">Equipe responsável</span>
        <select className="input" value={equipeId ?? ""} onChange={(e) => setEquipeId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{paiId ? "Herda do serviço de cima" : "Equipe padrão do setor"}</option>
          {equipes.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {eq.nome}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">Descrição para a IA e para quem abre</span>
        <textarea className="input" rows={2} maxLength={2000} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
        <span className="field__help">A IA usa este texto para classificar os tickets.</span>
      </label>
      <div className="field">
        <span className="field__label">Prazos de SLA (horas úteis no horário do setor)</span>
        <table className="cad-sla">
          <thead>
            <tr>
              <th><ThLabel icon={Flag}>Urgência</ThLabel></th>
              <th><ThLabel icon={MessageSquareReply}>1ª resposta</ThLabel></th>
              <th><ThLabel icon={CircleCheckBig}>Solução</ThLabel></th>
            </tr>
          </thead>
          <tbody>
            {urgencias.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="cad-dot" style={{ background: CORES_URGENCIA[u.cor].token }} aria-hidden="true" />
                  {u.nome}
                </td>
                <td>
                  <input className="input" type="number" min={0.25} step={0.25} aria-label={`1ª resposta ${u.nome}`} placeholder="herda" value={valorSla(u.id, "respostaHoras")} onChange={(e) => mudarSla(u.id, "respostaHoras", e.target.value)} />
                </td>
                <td>
                  <input className="input" type="number" min={0.25} step={0.25} aria-label={`Solução ${u.nome}`} placeholder="herda" value={valorSla(u.id, "solucaoHoras")} onChange={(e) => mudarSla(u.id, "solucaoHoras", e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="field__help">Em branco = usa o do serviço de cima; sem nenhum, o SLA padrão do setor.</span>
      </div>
      <div className="cad-grid2">
        <label className="field">
          <span className="field__label">Urgência padrão</span>
          <select className="input" value={urgenciaPadraoId ?? ""} onChange={(e) => setUrgencia(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— A padrão do sistema —</option>
            {urgencias.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Categoria padrão</span>
          <select className="input" value={categoriaPadraoId ?? ""} onChange={(e) => setCategoria(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— A padrão do sistema —</option>
            {cad.categorias
              .filter((c) => c.ativa)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span className="field__label">Disponível em</span>
        <div className="cad-checks">
          {(Object.keys(CANAIS) as Canal[]).map((c) => (
            <label key={c}>
              <input type="checkbox" checked={canais.includes(c)} onChange={(e) => setCanais((xs) => (e.target.checked ? [...xs, c] : xs.filter((x) => x !== c)))} />
              {CANAIS[c]}
            </label>
          ))}
        </div>
      </div>
      <label className="cad-check">
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
        Ativo
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}

function EditorSetor({ cad, setor, onFechar }: { cad: Cadastros; setor: SetorCad; onFechar: () => void }) {
  const salvar = useSalvarPadroesSetor();
  const [equipeId, setEquipeId] = useState<number | null>(setor.equipePadraoId);
  const [sla, setSla] = useState(String(setor.slaPadraoHoras));
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    salvar.mutate(
      { setorId: setor.id, equipeId, slaHoras: Number(sla) },
      {
        onSuccess: () => {
          toast.success("Padrões do setor salvos");
          onFechar();
        },
        onError: (er) => setErro(mensagem(er, "Não foi possível salvar os padrões.")),
      },
    );
  };

  return (
    <form className="cad-editor" onSubmit={enviar}>
      <h3>Padrões do setor · {setor.nome}</h3>
      <p className="ch-muted" style={{ margin: 0, fontSize: 13 }}>
        Valem para os tickets que chegam por e-mail ou WhatsApp antes de alguém escolher o serviço.
      </p>
      <label className="field">
        <span className="field__label">Equipe padrão</span>
        <select className="input" value={equipeId ?? ""} onChange={(e) => setEquipeId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Sem equipe (triagem)</option>
          {cad.equipes
            .filter((eq) => eq.setorId === setor.id)
            .map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.nome}
              </option>
            ))}
        </select>
        <span className="field__help">Sem equipe padrão, o ticket entra em "Sem equipe" e a IA (ou o gestor) escolhe.</span>
      </label>
      <label className="field">
        <span className="field__label">SLA padrão de solução (horas úteis)</span>
        <input className="input" type="number" min={0.5} max={999} step={0.5} value={sla} onChange={(e) => setSla(e.target.value)} />
        <span className="field__help">Usado quando o serviço não tem prazo. A 1ª resposta é a metade.</span>
      </label>
      <Rodape salvando={salvar.isPending} onCancelar={onFechar} erro={erro} />
    </form>
  );
}
