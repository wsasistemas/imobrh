import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router";
import { toast } from "sonner";
import { Carregando, SubCabecalho, useCd } from "./SolicitanteApp";
import { AnexoNaMensagem, Miniaturas, useAnexos } from "./anexos";
import { solicitanteApi } from "./service";
import { CartaoChamado, prazo, quando, Status } from "./Telas";

type Filtro = "abertos" | "resolvidos" | "todos";

/** Meus chamados: só os da própria pessoa, de todos os canais (app, WhatsApp e e-mail). */
export function MeusChamados() {
  const { como } = useCd();
  const [filtro, setFiltro] = useState<Filtro>("abertos");
  const lista = useQuery({ queryKey: ["cd", "meus", como, filtro], queryFn: () => solicitanteApi.meusChamados(filtro, como), refetchInterval: 60_000 });
  const d = lista.data;
  return (
    <>
      <SubCabecalho
        titulo="Meus chamados"
        sub={d ? `${d.abertos} ${d.abertos === 1 ? "aberto" : "abertos"} · ${d.recentes} nos últimos 90 dias` : " "}
        voltar="/app"
      />
      <div className="cd-filtros" role="group" aria-label="Filtro">
        {(["abertos", "resolvidos", "todos"] as const).map((f) => (
          <button key={f} type="button" className="cd-chip" aria-pressed={filtro === f} onClick={() => setFiltro(f)}>
            {f === "abertos" ? `Abertos${d && filtro === "abertos" ? ` (${d.abertos})` : ""}` : f === "resolvidos" ? "Encerrados" : "Todos"}
          </button>
        ))}
      </div>
      {lista.isPending ? (
        <Carregando />
      ) : lista.isError ? (
        <p className="cd-vazio">{lista.error.message}</p>
      ) : d!.itens.length === 0 ? (
        <p className="cd-vazio">
          {filtro === "abertos" ? "Nenhum chamado aberto." : "Nenhum chamado por aqui."}
          <br />
          <Link to="/app" style={{ color: "var(--cd-ouro)" }}>
            Abrir um chamado
          </Link>
        </p>
      ) : (
        <div className="cd-lista">
          {d!.itens.map((c) => (
            <CartaoChamado key={c.id} c={c} />
          ))}
        </div>
      )}
    </>
  );
}

/** Detalhe: histórico público, responder com anexo e "Ficou bom?" quando a equipe resolve. */
export function DetalheChamado() {
  const { id } = useParams();
  const ticketId = Number(id);
  const { entrada, como, simulando } = useCd();
  const qc = useQueryClient();
  const detalhe = useQuery({
    queryKey: ["cd", "chamado", como, ticketId],
    queryFn: () => solicitanteApi.chamado(ticketId, como),
    enabled: Number.isFinite(ticketId),
    refetchInterval: 30_000,
  });
  const [texto, setTexto] = useState("");
  const [comentario, setComentario] = useState("");
  const [naoResolveu, setNaoResolveu] = useState(false);
  const anexos = useAnexos(entrada.usuarioId, simulando);

  const atualizar = () => {
    void qc.invalidateQueries({ queryKey: ["cd", "chamado"] });
    void qc.invalidateQueries({ queryKey: ["cd", "meus"] });
  };
  const responder = useMutation({
    mutationFn: () => solicitanteApi.responder(ticketId, { texto: texto.trim(), anexos: anexos.anexos }),
    onSuccess: () => {
      setTexto("");
      anexos.limpar();
      atualizar();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const confirmar = useMutation({
    mutationFn: (resolveu: boolean) => solicitanteApi.confirmar(ticketId, resolveu, resolveu ? null : comentario.trim() || null),
    onSuccess: (_, resolveu) => {
      toast.success(resolveu ? "Obrigado! Chamado encerrado." : "Chamado reaberto. A equipe vai continuar.");
      setNaoResolveu(false);
      setComentario("");
      atualizar();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!Number.isFinite(ticketId)) return <Navigate to="/app/chamados" replace />;
  if (detalhe.isPending) return <Carregando />;
  if (detalhe.isError) {
    return (
      <>
        <SubCabecalho titulo="Chamado" voltar="/app/chamados" />
        <p className="cd-vazio">{detalhe.error.message}</p>
      </>
    );
  }
  const d = detalhe.data;
  const itens = [
    ...d.acoes.map((a) => ({ tipo: "acao" as const, em: Date.parse(a.criadoEm), a })),
    ...d.eventos.filter((e) => e.tipo !== "criado").map((e) => ({ tipo: "evento" as const, em: Date.parse(e.criadoEm), e })),
  ].sort((x, y) => x.em - y.em);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    if (!texto.trim() && anexos.anexos.length === 0) return;
    responder.mutate();
  };

  return (
    <>
      <SubCabecalho
        titulo={`#${d.id} · ${d.servico ? d.servico.split(" › ").pop() : (d.setor ?? "")}`}
        sub={
          <>
            <Status s={d.status} /> {d.responsavel ? `· com ${d.responsavel}` : d.slaRespostaAte && d.status.categoria === "novo" ? `· resposta ${prazo(d.slaRespostaAte)}` : ""}
          </>
        }
        voltar="/app/chamados"
      />
      <div className="cd-tl">
        <div className="cd-evt">
          {quando(d.criadoEm)} · aberto {d.origem === "intranet" ? "pelo app" : d.origem === "whatsapp" ? "pelo WhatsApp" : d.origem === "email" ? "por e-mail" : "pela equipe"}
          {d.setor ? ` · ${d.setor}` : ""}
        </div>
        <div className="cd-evt" style={{ fontWeight: 600, color: "var(--cd-txt)" }}>{d.assunto}</div>
        {itens.map((it, n) =>
          it.tipo === "evento" ? (
            <div key={`e${n}`} className="cd-evt">
              {it.e.tipo === "responsavel" ? it.e.descricao.replace("Responsável:", "Com") : it.e.descricao} · {quando(it.e.criadoEm)}
            </div>
          ) : (
            <div key={`a${it.a.numero}`} className={`cd-msg ${it.a.direcao === "entrada" ? "cd-msg--eu" : "cd-msg--ti"}`}>
              {it.a.direcao === "saida" && <b>{it.a.autorNome} · {d.setor ?? "equipe"}</b>}
              {it.a.texto}
              {it.a.anexos.length > 0 && (
                <div className="cd-anexos">
                  {it.a.anexos.map((x, i) => (
                    <AnexoNaMensagem key={`${x.path ?? x.nome}-${i}`} a={x} />
                  ))}
                </div>
              )}
              <small>{quando(it.a.criadoEm)}</small>
            </div>
          ),
        )}
      </div>

      {d.aguardandoConfirmacao && (
        <div className="cd-resolvido" role="region" aria-label="Confirmação">
          <p>
            ✅ A equipe marcou como <b>resolvido</b>. Ficou bom?
          </p>
          {d.solucao && <p className="cd-resolvido__solucao">Solução: {d.solucao}</p>}
          {naoResolveu ? (
            <>
              <textarea className="cd-campo" placeholder="O que ainda não funciona? (opcional)" value={comentario} onChange={(e) => setComentario(e.target.value)} style={{ minHeight: 70 }} />
              <div className="cd-dois" style={{ marginTop: 8 }}>
                <button type="button" className="cd-btn-vidro" onClick={() => setNaoResolveu(false)}>
                  Cancelar
                </button>
                <button type="button" className="cd-btn-ouro" disabled={simulando || confirmar.isPending} onClick={() => confirmar.mutate(false)}>
                  Reabrir chamado
                </button>
              </div>
            </>
          ) : (
            <div className="cd-dois">
              <button type="button" className="cd-btn-vidro" disabled={simulando || confirmar.isPending} onClick={() => confirmar.mutate(true)}>
                Sim, resolveu
              </button>
              <button type="button" className="cd-btn-vidro" disabled={simulando || confirmar.isPending} onClick={() => setNaoResolveu(true)}>
                Não, continua
              </button>
            </div>
          )}
        </div>
      )}
      {d.solucao && !d.aguardandoConfirmacao && (
        <div className="cd-resolvido">
          <p className="cd-resolvido__solucao" style={{ margin: 0 }}>Solução: {d.solucao}</p>
        </div>
      )}

      {d.podeResponder ? (
        <form className="cd-responder" onSubmit={enviar}>
          <Miniaturas itens={anexos.itens} onRemover={anexos.remover} />
          <div className="cd-responder__linha" style={{ marginTop: anexos.itens.length ? 8 : 0 }}>
            <label className="cd-redondo" aria-label="Anexar foto ou arquivo">
              <Paperclip size={18} aria-hidden="true" />
              <input type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" multiple disabled={simulando} onChange={(e) => { anexos.adicionar(e.target.files); e.target.value = ""; }} />
            </label>
            <textarea
              className="cd-campo"
              rows={1}
              maxLength={4000}
              placeholder={simulando ? "Modo simulação" : "Responder à equipe…"}
              aria-label="Mensagem"
              value={texto}
              disabled={simulando}
              onChange={(e) => setTexto(e.target.value)}
            />
            <button
              type="submit"
              className="cd-redondo cd-redondo--ouro"
              aria-label="Enviar"
              disabled={simulando || responder.isPending || anexos.enviando || (!texto.trim() && anexos.anexos.length === 0)}
            >
              <Send size={18} aria-hidden="true" />
            </button>
          </div>
        </form>
      ) : (
        <p className="cd-vazio">
          Chamado encerrado.{" "}
          <Link to="/app" style={{ color: "var(--cd-ouro)" }}>
            Abrir um novo
          </Link>
        </p>
      )}
    </>
  );
}
