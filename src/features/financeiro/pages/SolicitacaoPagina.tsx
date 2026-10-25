import { useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CornerUpLeft, Eye, Paperclip, Plus, Send, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { NotFound } from "../../../pages/NotFound";
import { moeda } from "../cadeia";
import { ApprovalTimeline, type EtapaTimeline } from "../components/ApprovalTimeline";
import { FormSection } from "../components/Campos";
import { FormPreview } from "../components/FormPreview";
import { conferenciaService } from "../conferencia";
import { StatusChip } from "../components/StatusChip";
import { useCancelarSolicitacao, useChecagens, useConferencia, useDecidir, useDetalheExtra, useEnviarSolicitacao, usePendenciaResponder, useSolicitacao } from "../hooks";
import { solicitacoesService, type Anexo, type Decisao, type Detalhe, type Item, type LinhaEdicao } from "../solicitacoes";
import { LeituraComprovantes } from "./LeituraComprovantes";
import { abrirAnexo, CampoValor, Regra, Ro } from "./comuns";
import { AdiantamentoFormulario } from "./AdiantamentoFormulario";
import { AvisoComprovacao, DadosAdiantamento, linhaDoTempoAdiantamento } from "./AdiantamentoVisao";
import { dataBR, mesBR, NOME_TIPO } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Telas 2 e 3 (formulário de Reembolso e de Fundo fixo, rascunho automático) e, depois do envio, a visão da solicitação.
// A tela de decisão do aprovador (6) entra na Fase 3.

export function SolicitacaoPagina() {
  const { id } = useParams();
  const n = Number(id);
  const q = useSolicitacao(n);
  if (!Number.isInteger(n) || n <= 0) return <NotFound />;
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível abrir a solicitação." onRetry={() => void q.refetch()} />;
  if (q.data.podeEditar) {
    return q.data.tipo === "adiantamento" && q.data.adiantamento
      ? <AdiantamentoFormulario key={`${q.data.id}-${q.data.status}`} d={q.data} />
      : <Formulario key={`${q.data.id}-${q.data.status}`} d={q.data} />;
  }
  return <Visao d={q.data} />;
}

// ---------- Formulário ----------
let provisoria = 0;
const linhaDe = (i: Detalhe["itens"][number]): LinhaEdicao => ({
  chave: String(i.id), id: i.id, data: i.data, valor: i.valor, descricao: i.descricao, motivo: i.motivo, categoriaId: i.categoriaId,
});
const novaLinha = (): LinhaEdicao => ({ chave: `n${++provisoria}`, data: null, valor: null, descricao: null, motivo: null, categoriaId: null });

function Formulario({ d }: { d: Detalhe }) {
  const ids = useId();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const fundo = d.tipo === "fundo_fixo";
  const [competencia, setCompetencia] = useState(d.competencia?.slice(0, 7) ?? "");
  const [periodoDe, setPeriodoDe] = useState(d.periodoDe ?? "");
  const [periodoAte, setPeriodoAte] = useState(d.periodoAte ?? "");
  const [centroCusto, setCentroCusto] = useState(d.centroCusto ?? "");
  const [linhas, setLinhas] = useState<LinhaEdicao[]>(() => (d.itens.length ? d.itens.map(linhaDe) : [novaLinha()]));
  const [aceite, setAceite] = useState(false);
  const [salvoEm, setSalvoEm] = useState<Date | null>(null);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [enviando, setEnviando] = useState<number | null>(null);
  const [cancelarAberto, setCancelarAberto] = useState(false);
  const [preview, setPreview] = useState(false);
  const enviar = useEnviarSolicitacao();
  const cancelar = useCancelarSolicitacao();
  const checagens = useChecagens(d.id, true);

  const anexosPorItem = useMemo(() => new Map(d.itens.map((i) => [i.id, i.anexos])), [d.itens]);
  const total = linhas.reduce((s, l) => s + (l.valor ?? 0), 0);

  // Rascunho automático: grava 1,2 s depois da última mudança (só o conteúdo; trocar a chave pelo id não regrava).
  const assinatura = JSON.stringify({ competencia, periodoDe, periodoAte, centroCusto, itens: linhas.map(({ chave: _c, id: _i, ...r }) => r) });
  const gravada = useRef(assinatura);
  const salvando = useRef<Promise<LinhaEdicao[]> | null>(null);
  const linhasRef = useRef(linhas);
  linhasRef.current = linhas;
  const conhecidos = useRef(new Set(d.itens.map((i) => i.id)));

  const salvarAgora = useCallback(async (): Promise<LinhaEdicao[]> => {
    if (salvando.current) await salvando.current;
    const atuais = linhasRef.current;
    const tarefa = (async () => {
      const r = await solicitacoesService.salvar({
        id: d.id, competencia: competencia ? `${competencia}-01` : null, periodoDe: periodoDe || null, periodoAte: periodoAte || null,
        centroCusto: centroCusto || null, itens: atuais, conhecidos: [...conhecidos.current],
      });
      const mapa = new Map(r.itens.map((x) => [x.chave, x.id]));
      for (const x of r.itens) conhecidos.current.add(x.id);
      const novas = atuais.map((l) => (l.id ? l : { ...l, id: mapa.get(l.chave) }));
      setLinhas((ls) => ls.map((l) => (l.id ? l : { ...l, id: mapa.get(l.chave) })));
      setSalvoEm(new Date());
      setErroSalvar(null);
      void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
      return novas;
    })();
    salvando.current = tarefa;
    try {
      return await tarefa;
    } finally {
      salvando.current = null;
    }
  }, [d.id, competencia, periodoDe, periodoAte, centroCusto, qc]);

  useEffect(() => {
    if (assinatura === gravada.current) return;
    const t = setTimeout(() => {
      gravada.current = assinatura;
      salvarAgora().catch((e) => setErroSalvar(e instanceof ServiceError ? e.message : "Não foi possível salvar o rascunho."));
    }, 1200);
    return () => clearTimeout(t);
  }, [assinatura, salvarAgora]);

  /** Linha criada a partir do comprovante: entra na lista (e some a linha em branco, se houver). */
  const adicionarDaLeitura = (i: Item) => {
    conhecidos.current.add(i.id);
    setLinhas((ls) => [...ls.filter((l) => l.data || l.valor != null || l.descricao || l.motivo), linhaDe(i)]);
  };

  const muda = (chave: string, p: Partial<LinhaEdicao>) => setLinhas((ls) => ls.map((l) => (l.chave === chave ? { ...l, ...p } : l)));

  const remover = async (l: LinhaEdicao) => {
    for (const a of l.id ? anexosPorItem.get(l.id) ?? [] : []) await solicitacoesService.removerAnexo(a.id).catch(() => {});
    setLinhas((ls) => (ls.length > 1 ? ls.filter((x) => x.chave !== l.chave) : [novaLinha()]));
  };

  const anexar = async (l: LinhaEdicao, arquivo: File) => {
    try {
      const itemId = l.id ?? (await salvarAgora()).find((x) => x.chave === l.chave)?.id;
      if (!itemId) throw new ServiceError("INVALID_INPUT", "Não foi possível gravar a linha antes de anexar.");
      gravada.current = assinatura;
      const r = await solicitacoesService.anexar({ solicitacaoId: d.id, solicitanteId: d.solicitante.id, itemId, arquivo });
      if (r.duplicadoEm) toast.warning(`Este arquivo já foi usado na ${r.duplicadoEm}. O envio fica bloqueado (R06) até você trocar o comprovante.`);
      else toast.success("Comprovante anexado");
      void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível anexar o arquivo.");
    }
  };

  const tirarAnexo = async (a: Anexo) => {
    try {
      await solicitacoesService.removerAnexo(a.id);
      void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível tirar o anexo.");
    }
  };

  const doEnvio = async () => {
    try {
      gravada.current = assinatura;
      await salvarAgora();
      const r = await enviar.mutateAsync(d.id);
      toast.success(r.alertas ? `Enviada para aprovação, com ${r.alertas} alerta${r.alertas > 1 ? "s" : ""} para o conferente.` : "Enviada para aprovação");
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível enviar.");
    }
  };

  const bloqueios = (checagens.data ?? []).filter((c) => c.resultado === "bloqueio");
  const alertas = (checagens.data ?? []).filter((c) => c.resultado === "alerta");

  return (
    <>
      <div className="sf-ph">
        <div>
          <div className="sf-eyebrow">{d.status === "devolvida" ? "Devolvida para ajuste" : "Rascunho"} · {d.numero}</div>
          <h2 className="sf-ph__t">{fundo ? "Fundo fixo de caixa (caixinha)" : "Reembolso de despesas"}</h2>
          <p className="sf-ph__s">Mesmos campos do formulário padrão 2026. O aceite eletrônico substitui as assinaturas.</p>
        </div>
        <div className="sf-ph__acoes">
          <span className={`sf-salvo${erroSalvar ? " sf-salvo--erro" : ""}`} role="status">
            {erroSalvar ?? (salvoEm ? `Rascunho salvo às ${salvoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Rascunho salvo automaticamente")}
          </span>
          <button type="button" className="btn btn--outline" onClick={() => setPreview(true)}>
            <Eye size={15} aria-hidden="true" />
            Pré-visualizar
          </button>
          {cancelarAberto ? (
            <>
              <button type="button" className="btn btn--outline" onClick={() => setCancelarAberto(false)}>Voltar</button>
              <button type="button" className="btn sf-btn-perigo" disabled={cancelar.isPending}
                onClick={() => cancelar.mutate(d.id, { onSuccess: () => { toast.success("Solicitação cancelada"); navegar("/financeiro/solicitacoes"); }, onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível cancelar.") })}>
                Confirmar cancelamento
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--outline" onClick={() => setCancelarAberto(true)}>
              <Trash2 size={15} aria-hidden="true" />
              Cancelar solicitação
            </button>
          )}
        </div>
      </div>

      {d.status === "devolvida" && <Devolucao d={d} />}

      <div className="sf-dupla">
        <div className="sf-coluna">
          <FormSection numero={1} titulo="Dados do solicitante" extra="vem do seu cadastro">
            <div className="sf-campos">
              <Ro rotulo="Funcionário" valor={d.solicitante.nome} trava />
              <Ro rotulo="CPF" valor={d.solicitante.cpfMascarado ?? "Não cadastrado"} trava />
              <Ro rotulo="Departamento (setor)" valor={d.setor?.nome ?? "Sem setor"} />
              {fundo && <Ro rotulo="Valor do fundo fixo" valor={moeda(d.valorFundoFixo ?? 0)} />}
            </div>
          </FormSection>

          <FormSection numero={2} titulo="Competência">
            <div className="sf-campos">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-mes`}>Mês de referência</label>
                <input id={`${ids}-mes`} className="input" type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
                <span className="field__help">{mesBR(competencia ? `${competencia}-01` : null)}</span>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-de`}>Período de</label>
                <input id={`${ids}-de`} className="input" type="date" value={periodoDe} onChange={(e) => setPeriodoDe(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-ate`}>até</label>
                <input id={`${ids}-ate`} className="input" type="date" value={periodoAte} onChange={(e) => setPeriodoAte(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-cc`}>Centro de custo / obra</label>
                <input id={`${ids}-cc`} className="input" maxLength={60} value={centroCusto} placeholder="Ex.: 00.00114" onChange={(e) => setCentroCusto(e.target.value)} />
                <span className="field__help">Código do SIENGE.</span>
              </div>
            </div>
          </FormSection>

          {fundo && <ResumoCaixa d={d} total={total} />}

          <LeituraComprovantes d={d} onLinha={adicionarDaLeitura} />

          <FormSection numero={3} titulo={fundo ? "Linhas do fundo fixo" : "Despesas"} extra="um comprovante por linha, obrigatório">
            <div className="at-tab-wrap">
              <table className="at-tab sf-linhas">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th className="n">Valor (R$)</th>
                    <th>{fundo ? "Favorecido" : "Descrição / fornecedor"}</th>
                    <th>Motivo</th>
                    <th>Comprovante</th>
                    <th><span className="sr-only">Remover</span></th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l, i) => (
                    <tr key={l.chave}>
                      <td><input className="input" type="date" aria-label={`Data da linha ${i + 1}`} value={l.data ?? ""} onChange={(e) => muda(l.chave, { data: e.target.value || null })} /></td>
                      <td><CampoValor rotulo={`Valor da linha ${i + 1}`} valor={l.valor} onChange={(v) => muda(l.chave, { valor: v })} /></td>
                      <td><input className="input" maxLength={200} aria-label={`${fundo ? "Favorecido" : "Descrição"} da linha ${i + 1}`} value={l.descricao ?? ""} onChange={(e) => muda(l.chave, { descricao: e.target.value || null })} /></td>
                      <td>
                        <select className="input" aria-label={`Motivo da linha ${i + 1}`} value={l.categoriaId ?? ""}
                          onChange={(e) => {
                            const c = d.categorias.find((x) => x.id === Number(e.target.value));
                            muda(l.chave, { categoriaId: c?.id ?? null, motivo: c?.nome ?? null });
                          }}>
                          <option value="">Escolha…</option>
                          {d.categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                        </select>
                      </td>
                      <td>
                        <Anexos anexos={l.id ? anexosPorItem.get(l.id) ?? [] : []} linha={i + 1} onAnexar={(f) => void anexar(l, f)} onTirar={(a) => void tirarAnexo(a)} />
                      </td>
                      <td>
                        <button type="button" className="icon-btn" aria-label={`Remover linha ${i + 1}`} onClick={() => void remover(l)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="sf-total">
                    <td>{fundo ? "Despesas totais" : "Total"}</td>
                    <td className="n">{moeda(total)}</td>
                    <td colSpan={4}>{fundo ? `Saldo final ${moeda((d.saldoInicial ?? 0) - total)} · Reposição solicitada ${moeda(total)}` : ""}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="sf-linha-acoes">
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setLinhas((ls) => [...ls, novaLinha()])}>
                <Plus size={14} aria-hidden="true" />
                Adicionar linha
              </button>
            </div>
          </FormSection>

          <FormSection numero={4} titulo="Informações e aceite">
            <ol className="sf-info">
              <li>Preencha corretamente data, valor, {fundo ? "favorecido" : "descrição (fornecedor)"} e motivo. O pagamento segue o padrão: 15 dias após a última aprovação.</li>
              <li>Os comprovantes ficam anexados a esta solicitação e seguem com o lançamento no SIENGE.</li>
              <li>As assinaturas do funcionário e do gestor são substituídas pelo aceite eletrônico e pelas aprovações registradas.</li>
            </ol>
            <label className="sf-aceite">
              <input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
              <span>
                <b>Declaro que as despesas são verdadeiras e foram feitas a serviço da empresa.</b>
                <small>O aceite registra seu usuário, data e hora, IP e navegador.</small>
              </span>
            </label>
          </FormSection>

          <div className="sf-rodape">
            <button type="button" className="btn btn--primary sf-btn-final" disabled={!aceite || enviar.isPending || bloqueios.length > 0} onClick={() => { setEnviando(Date.now()); void doEnvio(); }}>
              <Send size={16} aria-hidden="true" />
              {enviar.isPending && enviando ? "Enviando…" : "Enviar para aprovação"}
            </button>
          </div>
        </div>

        <aside className="sf-lateral">
          <section className="card sf-painel" aria-labelledby={`${ids}-cad`}>
            <h3 id={`${ids}-cad`}>Quem vai aprovar</h3>
            <p className="field__help">
              Cadeia do setor <b>{d.setor?.nome ?? "—"}</b> para <b>{moeda(d.totalDespesas)}</b>. Fica congelada no envio.
            </p>
            <ApprovalTimeline etapas={etapasPrevistas(d)} />
          </section>
          <section className="card sf-painel" aria-labelledby={`${ids}-chk`}>
            <h3 id={`${ids}-chk`}>Antes de enviar</h3>
            <ul className="sf-regras">
              {bloqueios.map((c, i) => <Regra key={`b${i}`} cod={c.codigo} texto={c.detalhe} tom="erro" res="Bloqueia" />)}
              {alertas.map((c, i) => <Regra key={`a${i}`} cod={c.codigo} texto={c.detalhe} tom="aviso" res="Alerta" />)}
              {bloqueios.length === 0 && alertas.length === 0 && <Regra cod="—" texto="Comprovantes, período e duplicidade sem pendência" tom="ok" res="OK" />}
              <Regra cod="—" texto={aceite ? "Aceite marcado" : "Marque a declaração de aceite"} tom={aceite ? "ok" : "aviso"} res={aceite ? "OK" : "Pendente"} />
            </ul>
            <p className="field__help">Os alertas não impedem o envio: o Financeiro decide na conferência.</p>
          </section>
        </aside>
      </div>
      <FormPreview d={d} aberto={preview} onFechar={() => setPreview(false)} />
    </>
  );
}

function etapasPrevistas(d: Detalhe): EtapaTimeline[] {
  const cadeia = d.cadeiaPrevista ?? [];
  if (cadeia.length === 0) return [{ chave: "sem", titulo: "Sem aprovador configurado", detalhe: "Avise o administrador do seu setor.", estado: "futuro" }];
  return [
    ...cadeia.map((e) => ({
      chave: `n${e.nivel}`,
      titulo: `${e.papel}${e.aprovador ? ` · ${e.aprovador}` : ""}`,
      detalhe: `${e.motivo}${e.substituto && e.exigido && !e.pulado ? ` · substituto: ${e.substituto}` : ""}`,
      estado: (e.exigido && !e.pulado ? "futuro" : "nao_exigido") as EtapaTimeline["estado"],
    })),
    { chave: "fin", titulo: "Conferência financeira", detalhe: "Setor Financeiro", estado: "futuro" },
    { chave: "pag", titulo: "Pagamento", detalhe: "Até 15 dias após a última aprovação", estado: "futuro" },
  ];
}




function Anexos({ anexos, linha, onAnexar, onTirar }: { anexos: Anexo[]; linha: number; onAnexar: (f: File) => void; onTirar: (a: Anexo) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const escolher = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) onAnexar(f);
  };
  return (
    <div className="sf-anexos">
      {anexos.map((a) => (
        <span key={a.id} className="sf-anexo">
          <button type="button" className="sf-anexo__nome" title="Abrir" onClick={() => void abrirAnexo(a)}>
            <Paperclip size={13} aria-hidden="true" />
            {a.nome}
          </button>
          <button type="button" aria-label={`Tirar ${a.nome}`} onClick={() => onTirar(a)}><X size={13} aria-hidden="true" /></button>
        </span>
      ))}
      {anexos.length === 0 && (
        <button type="button" className="sf-anexar" onClick={() => ref.current?.click()}>
          <Upload size={13} aria-hidden="true" />
          Anexar comprovante
        </button>
      )}
      <input ref={ref} type="file" hidden accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf" aria-label={`Comprovante da linha ${linha}`} onChange={escolher} />
    </div>
  );
}


function ResumoCaixa({ d, total }: { d: Detalhe; total: number }) {
  const saldoInicial = d.saldoInicial ?? 0;
  const final = saldoInicial - total;
  return (
    <div className="sf-caixa" aria-label="Resumo do caixa">
      <div><span>Valor do fundo fixo</span><b>{moeda(d.valorFundoFixo ?? 0)}</b></div>
      <div><span>Saldo inicial</span><b>{moeda(saldoInicial)}</b><small>saldo final anterior + reposição recebida</small></div>
      <div><span>− Despesas totais</span><b>{moeda(total)}</b></div>
      <div className={final < 0 ? "sf-caixa--erro" : undefined}><span>= Saldo final</span><b>{moeda(final)}</b><small>{final < 0 ? "R10: acima do saldo" : "R10: dentro do saldo"}</small></div>
      <div className="sf-caixa--dest"><span>Reposição solicitada</span><b>{moeda(total)}</b><small>= despesas totais</small></div>
    </div>
  );
}

function Devolucao({ d }: { d: Detalhe }) {
  const ultima = [...d.aprovacoes].reverse().find((a) => a.status === "devolvido");
  return (
    <div className="sf-aviso sf-aviso--roxo" role="alert">
      <b>Devolvida para ajuste{ultima?.aprovador ? ` por ${ultima.aprovador}` : ""}.</b> {ultima?.comentario ?? ""} Corrija e envie de novo: a aprovação recomeça do nível 1.
    </div>
  );
}

// ---------- Visão (depois do envio) ----------
function Visao({ d }: { d: Detalhe }) {
  const navegar = useNavigate();
  const cancelar = useCancelarSolicitacao();
  const [confirmar, setConfirmar] = useState(false);
  const [preview, setPreview] = useState(false);
  const fundo = d.tipo === "fundo_fixo";
  const adiantamento = d.tipo === "adiantamento" && !!d.adiantamento;
  return (
    <>
      <div className="sf-ph">
        <div>
          <div className="sf-eyebrow">{adiantamento ? "Adiantamento de numerário" : NOME_TIPO[d.tipo]}</div>
          <h2 className="sf-ph__t">{d.numero} <StatusChip status={d.status} /></h2>
          <p className="sf-ph__s">{d.solicitante.nome} · {d.setor?.nome ?? "Sem setor"}{d.enviadoEm ? ` · enviada em ${new Date(d.enviadoEm).toLocaleString("pt-BR")}` : ""} · ciclo {d.ciclo}</p>
        </div>
        <div className="sf-ph__acoes">
          <button type="button" className="btn btn--outline" onClick={() => setPreview(true)}>
            <Eye size={15} aria-hidden="true" />
            Ver formulário
          </button>
          {d.podeCancelar && (confirmar ? (
            <>
              <button type="button" className="btn btn--outline" onClick={() => setConfirmar(false)}>Voltar</button>
              <button type="button" className="btn sf-btn-perigo" disabled={cancelar.isPending}
                onClick={() => cancelar.mutate(d.id, { onSuccess: () => { toast.success("Solicitação cancelada"); navegar("/financeiro/solicitacoes"); }, onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível cancelar.") })}>
                Confirmar cancelamento
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--outline" onClick={() => setConfirmar(true)}>Cancelar solicitação</button>
          ))}
        </div>
      </div>
      {d.status === "pendencia_solicitante" && <Pendencia d={d} />}
      {adiantamento && <AvisoComprovacao d={d} />}
      <div className="sf-dupla">
        <div className="sf-coluna">
          {adiantamento ? <DadosAdiantamento d={d} /> : (<>
          <FormSection titulo="Dados">
            <div className="sf-campos">
              <Ro rotulo="Competência" valor={mesBR(d.competencia)} />
              <Ro rotulo="Período" valor={`${dataBR(d.periodoDe)} a ${dataBR(d.periodoAte)}`} />
              <Ro rotulo="Centro de custo / obra" valor={d.centroCusto ?? "—"} />
              <Ro rotulo={fundo ? "Reposição solicitada" : "Total"} valor={moeda(d.totalDespesas)} />
              {fundo && <Ro rotulo="Saldo final" valor={moeda(d.saldoFinal ?? 0)} />}
              {d.pagarAte && <Ro rotulo="Pagar até" valor={dataBR(d.pagarAte)} />}
            </div>
          </FormSection>
          <FormSection titulo={fundo ? "Linhas do fundo fixo" : "Despesas"}>
            <div className="at-tab-wrap">
              <table className="at-tab">
                <thead><tr><th>Data</th><th className="n">Valor</th><th>{fundo ? "Favorecido" : "Descrição"}</th><th>Motivo</th><th>Comprovante</th></tr></thead>
                <tbody>
                  {d.itens.map((i) => (
                    <tr key={i.id}>
                      <td>{dataBR(i.data)}</td>
                      <td className="n">{moeda(i.valor ?? 0)}</td>
                      <td>{i.descricao}</td>
                      <td>{i.motivo}</td>
                      <td>
                        {i.anexos.map((a) => (
                          <button key={a.id} type="button" className="sf-anexo sf-anexo__nome" onClick={() => void abrirAnexo(a)}>
                            <Paperclip size={13} aria-hidden="true" />{a.nome}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FormSection>
          </>)}
          <Checagens id={d.id} />
          <Comentarios d={d} />
          <BarraDecisao d={d} />
        </div>
        <aside className="sf-lateral">
          <section className="card sf-painel">
            <h3>Linha do tempo</h3>
            <ApprovalTimeline etapas={adiantamento ? linhaDoTempoAdiantamento(d) : linhaDoTempo(d)} />
          </section>
        </aside>
      </div>
      <FormPreview d={d} aberto={preview} onFechar={() => setPreview(false)} />
    </>
  );
}

/** Pendência do Financeiro: o solicitante troca o comprovante dos itens em ajuste e responde. */
function Pendencia({ d }: { d: Detalhe }) {
  const ids = useId();
  const qc = useQueryClient();
  const c = useConferencia(d.id);
  const responder = usePendenciaResponder();
  const [resposta, setResposta] = useState("");
  const pedido = [...d.eventos].reverse().find((e) => e.tipo === "pendencia_aberta");
  const ajustes = (c.data?.itens ?? []).filter((i) => i.status === "ajuste");
  const anexar = async (itemId: number, arquivo: File) => {
    try {
      await conferenciaService.pendenciaAnexar({ solicitacaoId: d.id, solicitanteId: d.solicitante.id, itemId, arquivo });
      toast.success("Comprovante anexado");
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível anexar.");
    }
  };
  if (!c.data) return null;
  return (
    <section className="card sf-painel sf-pendencia" aria-labelledby={`${ids}-t`}>
      <h3 id={`${ids}-t`}>Pendência do Financeiro</h3>
      {pedido && <p className="sf-pendencia__msg">{String(pedido.payload.comentario ?? "")}</p>}
      <ul className="sf-comentarios">
        {ajustes.map((i) => (
          <li key={i.id}>
            <b>Linha {i.ordem}</b> · {i.descricao} · {moeda(i.valor)}
            {i.obs && <p>{i.obs}</p>}
            <label className="btn btn--outline btn--sm sf-pendencia__anexar">
              <Upload size={14} aria-hidden="true" />
              Enviar novo comprovante
              <input type="file" hidden accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void anexar(i.id, f); }} />
            </label>
          </li>
        ))}
      </ul>
      <div className="field">
        <label className="field__label" htmlFor={`${ids}-r`}>Resposta ao Financeiro</label>
        <textarea id={`${ids}-r`} className="input" rows={2} maxLength={2000} value={resposta} onChange={(e) => setResposta(e.target.value)} />
      </div>
      <button type="button" className="btn btn--primary" disabled={responder.isPending || !resposta.trim()}
        onClick={() => responder.mutate({ id: d.id, resposta }, { onSuccess: () => toast.success("Respondida: voltou para a conferência"), onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível responder.") })}>
        <Send size={15} aria-hidden="true" />
        Responder e devolver ao Financeiro
      </button>
    </section>
  );
}

/** Checagens gravadas no envio (regras de aceitação). */
function Checagens({ id }: { id: number }) {
  const q = useDetalheExtra(id);
  const regras = q.data?.regras ?? [];
  if (!q.data) return null;
  return (
    <FormSection titulo="Checagens automáticas">
      <ul className="sf-regras">
        {regras.map((r, i) => (
          <Regra key={i} cod={r.codigo} texto={`${r.nome}${r.detalhe ? ` · ${r.detalhe}` : ""}`}
            tom={r.resultado === "ok" ? "ok" : r.resultado === "alerta" ? "aviso" : "erro"} res={r.resultado === "ok" ? "OK" : r.resultado === "alerta" ? "Alerta" : "Bloqueio"} />
        ))}
        {regras.length === 0 && <Regra cod="—" texto="Sem pendências nas checagens feitas no envio" tom="ok" res="OK" />}
      </ul>
    </FormSection>
  );
}

function Comentarios({ d }: { d: Detalhe }) {
  const com = d.aprovacoes.filter((a) => a.comentario);
  if (com.length === 0) return null;
  return (
    <FormSection titulo="Comentários">
      <ul className="sf-comentarios">
        {com.map((a, i) => (
          <li key={i}>
            <b>{a.aprovador ?? a.papel}</b> · {a.papel} · ciclo {a.ciclo}
            {a.decididoEm && <span className="sf-sub">{new Date(a.decididoEm).toLocaleString("pt-BR")} · {ROTULO_APROVACAO[a.status] ?? a.status}</span>}
            <p>{a.comentario}</p>
          </li>
        ))}
      </ul>
    </FormSection>
  );
}

/** DecisionBar: Reprovar (contorno vermelho), Devolver (contorno roxo), Aprovar (verde). Devolver e reprovar exigem comentário. */
function BarraDecisao({ d }: { d: Detalhe }) {
  const ids = useId();
  const extra = useDetalheExtra(d.id);
  const decidir = useDecidir();
  const [comentario, setComentario] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  if (!extra.data?.podeDecidir) return null;
  const etapa = extra.data.etapa;

  const agir = (decisao: Decisao) => {
    if (decisao !== "aprovar" && !comentario.trim()) return setErro("Escreva o motivo antes de devolver ou reprovar.");
    setErro(null);
    decidir.mutate(
      { id: d.id, decisao, comentario: comentario.trim() || null },
      {
        onSuccess: (r) => {
          toast.success(decisao === "aprovar" ? (r.status === "em_conferencia" ? "Aprovada: foi para o Financeiro" : `Aprovada${r.proximo ? `: segue para ${r.proximo}` : ""}`)
            : decisao === "devolver" ? "Devolvida ao solicitante" : "Reprovada");
          setComentario("");
        },
        onError: (e) => setErro(e instanceof ServiceError ? e.message : "Não foi possível registrar a decisão."),
      },
    );
  };

  return (
    <section className="card sf-decisao" aria-labelledby={`${ids}-t`}>
      <h3 id={`${ids}-t`} className="sr-only">Decisão</h3>
      <div className="field sf-decisao__campo">
        <label className="field__label" htmlFor={`${ids}-c`}>
          Comentário <span className="field__optional">(obrigatório para devolver ou reprovar)</span>
        </label>
        <textarea id={`${ids}-c`} className="input" rows={2} maxLength={2000} value={comentario} onChange={(e) => setComentario(e.target.value)}
          placeholder={etapa ? `Etapa ${etapa.nivel} · ${etapa.papel}${etapa.emNomeDe ? ` (substituindo ${etapa.emNomeDe})` : ""}` : ""} />
        {erro && <span className="field__error" role="alert">{erro}</span>}
      </div>
      <div className="sf-decisao__botoes">
        <button type="button" className="btn sf-btn-reprovar" disabled={decidir.isPending} onClick={() => agir("reprovar")}>
          <Ban size={16} aria-hidden="true" />
          Reprovar
        </button>
        <button type="button" className="btn sf-btn-devolver" disabled={decidir.isPending} onClick={() => agir("devolver")}>
          <CornerUpLeft size={16} aria-hidden="true" />
          Devolver para ajuste
        </button>
        <button type="button" className="btn sf-btn-aprovar" disabled={decidir.isPending} onClick={() => agir("aprovar")}>
          <Check size={16} aria-hidden="true" />
          Aprovar
        </button>
      </div>
    </section>
  );
}

const ROTULO_APROVACAO: Record<string, string> = { aprovado: "aprovou", devolvido: "devolveu", reprovado: "reprovou" };

/** Timeline do ciclo atual: enviado → níveis → conferência → lançamento → pagamento. */
export function linhaDoTempo(d: Detalhe): EtapaTimeline[] {
  const ciclo = d.aprovacoes.filter((a) => a.ciclo === d.ciclo);
  const depois = ["em_conferencia", "pendencia_solicitante", "lancamento_gerado", "pagamento_programado", "paga", "comprovacao_pendente", "comprovacao_em_conferencia", "devolucao_pendente", "encerrada"];
  const passou = (s: string) => depois.indexOf(d.status) >= depois.indexOf(s) && depois.includes(d.status);
  return [
    { chave: "env", titulo: "Enviado", detalhe: d.enviadoEm ? `${d.solicitante.nome} · ${new Date(d.enviadoEm).toLocaleString("pt-BR")} · aceite registrado` : undefined, estado: "feito" },
    ...ciclo.map((a): EtapaTimeline => ({
      chave: `a${a.nivel}`,
      titulo: a.papel,
      detalhe:
        a.status === "nao_exigido" ? "Não exigido para este valor"
        : a.status === "pulado" ? "Etapa do próprio solicitante: pulada"
        : a.decididoEm ? `${a.aprovador ?? ""} ${ROTULO_APROVACAO[a.status] ?? ""} · ${new Date(a.decididoEm).toLocaleString("pt-BR")}`
        : `${a.aprovador ?? ""}${a.prazoEm ? ` · prazo ${new Date(a.prazoEm).toLocaleString("pt-BR")}` : ""}`,
      estado: a.status === "aprovado" ? "feito" : a.status === "aguardando" ? "atual" : a.status === "devolvido" ? "devolvido" : a.status === "nao_exigido" || a.status === "pulado" ? "nao_exigido" : "futuro",
      comentario: a.comentario,
    })),
    { chave: "conf", titulo: "Conferência financeira", estado: passou("lancamento_gerado") ? "feito" : d.status === "em_conferencia" ? "atual" : "futuro" },
    { chave: "lanc", titulo: "Lançamento SIENGE", estado: passou("pagamento_programado") ? "feito" : d.status === "lancamento_gerado" ? "atual" : "futuro" },
    { chave: "pag", titulo: "Pagamento", detalhe: d.pagarAte ? `até ${dataBR(d.pagarAte)}` : undefined, estado: passou("paga") ? "feito" : d.status === "pagamento_programado" ? "atual" : "futuro" },
  ];
}
