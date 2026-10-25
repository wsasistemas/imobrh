import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, ChevronRight, Paperclip } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router";
import { Carregando, SubCabecalho, useCd } from "./SolicitanteApp";
import { Miniaturas, useAnexos } from "./anexos";
import { solicitanteApi, formatarTelefone, type Servico, type TipoUrgencia } from "./service";
import { prazo } from "./Telas";
import { IconeSetor } from "./IconeSetor";

const TIPOS_ARQUIVO = "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv";
/** "Tipo urgência" (Wagner, 13/10/2026), do menos para o mais urgente. */
const URGENCIAS: { valor: TipoUrgencia; rotulo: string }[] = [
  { valor: "normal", rotulo: "Normal" },
  { valor: "prazo", rotulo: "Tenho prazo" },
  { valor: "grave", rotulo: "Grave" },
  { valor: "parado", rotulo: "Estou parado" },
];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Abrir chamado: empreendimento (setores que pedem, ex.: CFTV), tipo de serviço (árvore do departamento), descrição, foto/arquivo e urgência. */
export function AbrirChamado() {
  const { setorId } = useParams();
  const { entrada, simulando } = useCd();
  const setor = entrada.setores.find((s) => String(s.id) === setorId) ?? null;
  const qc = useQueryClient();
  const servicos = useQuery({ queryKey: ["cd", "servicos", setor?.id], queryFn: () => solicitanteApi.servicos(setor!.id), enabled: Boolean(setor), staleTime: 300_000 });
  const emps = useQuery({ queryKey: ["cd", "empreendimentos-setor", setor?.id], queryFn: () => solicitanteApi.empreendimentosDoSetor(setor!.id), enabled: Boolean(setor), staleTime: 300_000 });
  const pedeEmp = emps.data?.pedir === true;
  const [empId, setEmpId] = useState<number | null>(null);
  const [empBusca, setEmpBusca] = useState("");
  const [caminho, setCaminho] = useState<Servico[]>([]);
  /** undefined = ainda escolhendo; null = "Outro assunto"; número = serviço final. */
  const [servicoId, setServicoId] = useState<number | null | undefined>(undefined);
  const [descricao, setDescricao] = useState("");
  const [urgencia, setUrgencia] = useState<TipoUrgencia>("normal");
  const [erro, setErro] = useState<{ campo?: string; texto: string } | null>(null);
  const anexos = useAnexos(entrada.usuarioId, simulando);
  const dica = useQuery({
    queryKey: ["cd", "dica", setor?.id, servicoId],
    queryFn: () => solicitanteApi.solucoes(setor!.id, servicoId!, null),
    enabled: Boolean(setor) && typeof servicoId === "number" && entrada.config.quadros.solucoes !== false,
  });
  const [dicaAberta, setDicaAberta] = useState(false);

  const criar = useMutation({
    mutationFn: () => solicitanteApi.criar({ setorId: setor!.id, servicoId: servicoId ?? null, empreendimentoId: pedeEmp ? empId : null, descricao: descricao.trim(), urgencia, anexos: anexos.anexos }),
    onSuccess: () => {
      anexos.limpar();
      void qc.invalidateQueries({ queryKey: ["cd", "meus"] });
    },
    onError: (e: Error & { field?: string }) => setErro({ campo: e.field, texto: e.message }),
  });

  if (!setor) return <Navigate to="/app" replace />;

  if (criar.data) {
    const r = criar.data;
    return (
      <div className="cd__centro cd-confirma">
        <div>
          <div className="cd-ok">
            <Check size={40} aria-hidden="true" />
          </div>
          <h2>Chamado #{r.id} aberto</h2>
          <p>{r.servico ? `${r.setor} › ${r.servico}` : r.setor}</p>
          {r.empreendimento && <p style={{ fontSize: 13, color: "var(--cd-txt-3)", marginTop: -6 }}>{r.empreendimento}</p>}
          {r.slaRespostaAte && <p style={{ fontSize: 13, color: "var(--cd-txt-3)" }}>Prazo para a 1ª resposta: {prazo(r.slaRespostaAte)}</p>}
          <div className="cd-confirma__acoes" style={{ marginLeft: "auto", marginRight: "auto" }}>
            <Link to={`/app/chamados/${r.id}`} className="cd-btn-ouro">
              Acompanhar chamado
            </Link>
            <Link to="/app" className="cd-btn-vidro">
              Voltar ao início
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const todos = servicos.data ?? [];
  const temFilhos = (id: number) => todos.some((s) => s.paiId === id);
  // Nível com uma única opção que tem filhos (ex.: a raiz "Administrativo"): desce sozinho, sem toque a mais.
  const auto: Servico[] = [];
  let atual = caminho[caminho.length - 1] ?? null;
  let opcoes = todos.filter((s) => s.paiId === (atual?.id ?? null));
  while (servicoId === undefined && opcoes.length === 1 && temFilhos(opcoes[0].id)) {
    auto.push(opcoes[0]);
    atual = opcoes[0];
    opcoes = todos.filter((s) => s.paiId === atual!.id);
  }
  const trilha = [...caminho, ...auto];
  const escolher = (s: Servico) => {
    setErro(null);
    setCaminho([...trilha, s]);
    if (!temFilhos(s.id)) setServicoId(s.id);
  };
  const raizUnica = todos.filter((x) => x.paiId === null).length === 1;
  const escolhidoServico = typeof servicoId === "number" ? todos.find((s) => s.id === servicoId) : undefined;
  const recomecar = () => {
    setCaminho([]);
    setServicoId(undefined);
    setDicaAberta(false);
  };
  const semServicos = servicos.isSuccess && todos.length === 0;
  const escolhido = servicoId !== undefined || semServicos;

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (pedeEmp && empId === null) {
      setErro({ campo: "empreendimentoId", texto: "Escolha o empreendimento." });
      return;
    }
    if (!escolhido) {
      setErro({ campo: "servicoId", texto: "Escolha o tipo de serviço." });
      return;
    }
    if (descricao.trim().length < 5) {
      setErro({ campo: "descricao", texto: "Descreva o que está acontecendo." });
      return;
    }
    criar.mutate();
  };
  const sol = dica.data?.[0];
  // Os passos ganham um número a mais quando o setor pede o empreendimento.
  const passo = (n: number) => n + (pedeEmp ? 1 : 0);
  const empEscolhido = emps.data?.lista.find((e) => e.id === empId);
  const termos = norm(empBusca).split(/\s+/).filter(Boolean);
  const empLista = (emps.data?.lista ?? []).filter((e) => termos.every((t) => norm(`${e.nome} ${e.apelidos.join(" ")}`).includes(t)));

  return (
    <>
      <SubCabecalho titulo="Abrir chamado" sub={<>Departamento: <b style={{ color: "var(--cd-ouro)", display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "middle" }}><IconeSetor valor={setor.icone} tamanho={18} /> {setor.nome}</b></>} voltar="/app" />
      <form className="cd-sec" onSubmit={enviar} noValidate>
        {erro && !erro.campo && <p className="cd-alerta" role="alert">{erro.texto}</p>}
        <span className="cd-rot" style={{ marginTop: 0 }}>
          Solicitante (do seu login)
        </span>
        <div className="cd-ro">
          <div>
            <span>Nome</span>
            <b>{entrada.nome}</b>
          </div>
          <div>
            <span>E-mail</span>
            <b>{entrada.email}</b>
          </div>
          <div>
            <span>Telefone</span>
            <b>{entrada.telefone ? formatarTelefone(entrada.telefone) : <Link to="/app/perfil" style={{ color: "var(--cd-ouro)" }}>cadastrar</Link>}</b>
          </div>
        </div>

        {pedeEmp && (
          <>
            <span className="cd-rot" id="cd-emp">
              1 · Empreendimento
            </span>
            {empEscolhido ? (
              <div className="cd-menu">
                <div className="cd-menu__escolhido">
                  <b>{empEscolhido.nome}</b>
                  {!simulando && (
                    <button type="button" className="cd-link" onClick={() => setEmpId(null)}>
                      trocar
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <input
                  className="cd-campo"
                  type="search"
                  aria-labelledby="cd-emp"
                  placeholder="Digite o nome do condomínio ou obra"
                  value={empBusca}
                  onChange={(e) => setEmpBusca(e.target.value)}
                  aria-invalid={erro?.campo === "empreendimentoId" || undefined}
                />
                <div className="cd-menu" role="group" aria-labelledby="cd-emp" style={{ marginTop: 8, maxHeight: 260, overflowY: "auto" }}>
                  {empLista.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className="cd-menu__op"
                      onClick={() => {
                        setErro(null);
                        setEmpId(e.id);
                        setEmpBusca("");
                      }}
                    >
                      {e.nome}
                    </button>
                  ))}
                  {empLista.length === 0 && <p className="cd-vazio" style={{ padding: 12, textAlign: "left" }}>Nenhum empreendimento com “{empBusca}”.</p>}
                </div>
              </>
            )}
            {erro?.campo === "empreendimentoId" && <span className="cd-erro">{erro.texto}</span>}
          </>
        )}

        <span className="cd-rot" id="cd-servico">
          {passo(1)} · Tipo de serviço
        </span>
        {servicos.isPending ? (
          <Carregando />
        ) : semServicos ? (
          <p className="cd-vazio" style={{ padding: "4px 0", textAlign: "left" }}>
            Descreva abaixo o que você precisa: a equipe de {setor.nome} classifica o chamado.
          </p>
        ) : escolhido ? (
          <div className="cd-menu">
            <div className="cd-menu__escolhido">
              <b>{servicoId === null ? "Outro assunto" : (raizUnica && caminho.length > 1 ? caminho.slice(1) : caminho).map((s) => s.nome).join(" › ")}</b>
              {!simulando && (
                <button type="button" className="cd-link" onClick={recomecar}>
                  trocar
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="cd-menu" role="group" aria-labelledby="cd-servico">
            {caminho.length > 0 && (
              <div className="cd-menu__trilha">
                <span>{trilha.map((s) => s.nome).join(" › ")} ›</span>
                <button type="button" className="cd-link" onClick={() => setCaminho((c) => c.slice(0, -1))}>
                  voltar
                </button>
              </div>
            )}
            {opcoes.map((s) => (
              <button key={s.id} type="button" className="cd-menu__op" onClick={() => escolher(s)} title={s.descricao ?? undefined}>
                {s.nome}
                {temFilhos(s.id) && <ChevronRight size={18} aria-hidden="true" />}
              </button>
            ))}
            {caminho.length === 0 && (
              <button type="button" className="cd-menu__op" onClick={() => setServicoId(null)}>
                Outro assunto
              </button>
            )}
          </div>
        )}
        {erro?.campo === "servicoId" && <span className="cd-erro">{erro.texto}</span>}
        {escolhidoServico?.descricao && (
          <div className="cd-dica" role="note">
            📝 <b>Como pedir:</b>
            <p>{escolhidoServico.descricao}</p>
          </div>
        )}

        <label className="cd-rot" htmlFor="cd-desc">
          {passo(2)} · Descrição
        </label>
        <textarea
          id="cd-desc"
          className="cd-campo"
          maxLength={4000}
          placeholder={escolhidoServico?.descricao ? "Escreva o seu pedido com as informações indicadas acima." : "O que você precisa? Se for um problema, desde quando acontece?"}
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          aria-invalid={erro?.campo === "descricao" || undefined}
        />
        {erro?.campo === "descricao" && <span className="cd-erro">{erro.texto}</span>}
        {sol && (
          <div className="cd-dica">
            💡 <b>Talvez resolva:</b> {sol.titulo}{" "}
            <button
              type="button"
              className="cd-link"
              style={{ color: "var(--cd-info)" }}
              aria-expanded={dicaAberta}
              onClick={() => {
                if (!dicaAberta) void solicitanteApi.solucaoUsada(sol.id).catch(() => {});
                setDicaAberta((x) => !x);
              }}
            >
              {dicaAberta ? "Esconder" : "Ver solução"}
            </button>
            {dicaAberta && <p>{sol.texto}</p>}
          </div>
        )}

        <span className="cd-rot">{passo(3)} · Anexar arquivo ou foto (opcional)</span>
        <div className="cd-anexar">
          <label>
            <Camera size={22} aria-hidden="true" />
            Tirar foto
            <input type="file" accept="image/*" capture="environment" disabled={simulando} onChange={(e) => { anexos.adicionar(e.target.files); e.target.value = ""; }} />
          </label>
          <label>
            <Paperclip size={22} aria-hidden="true" />
            Anexar arquivo
            <input type="file" accept={TIPOS_ARQUIVO} multiple disabled={simulando} onChange={(e) => { anexos.adicionar(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <Miniaturas itens={anexos.itens} onRemover={anexos.remover} />

        <span className="cd-rot">{passo(4)} · Tipo urgência</span>
        <div className="cd-chips" role="group" aria-label="Tipo urgência">
          {URGENCIAS.map((u) => (
            <button key={u.valor} type="button" className="cd-chip" aria-pressed={urgencia === u.valor} onClick={() => setUrgencia(u.valor)}>
              {u.rotulo}
            </button>
          ))}
        </div>
        <div style={{ height: 18 }} />
        <button type="submit" className="cd-btn-ouro" disabled={simulando || criar.isPending || anexos.enviando}>
          {criar.isPending ? "Enviando…" : anexos.enviando ? "Enviando arquivo…" : "Enviar chamado"}
        </button>
        <p style={{ fontSize: 12, color: "var(--cd-txt-3)", textAlign: "center", margin: "10px 0 18px" }}>
          {simulando ? "Modo simulação: nada é enviado." : <>A equipe recebe na hora. Você acompanha em <b style={{ color: "#fff" }}>Meus chamados</b>.</>}
        </p>
      </form>
    </>
  );
}
