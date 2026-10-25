import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Paperclip, Send, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { NotFound } from "../../../pages/NotFound";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { acerto } from "../../../../supabase/functions/_shared/sf/adiantamento.ts";
import { adiantamentoService, type DadosComprovacao } from "../adiantamento";
import { moeda } from "../cadeia";
import { FormSection, OcrField } from "../components/Campos";
import { StatusChip } from "../components/StatusChip";
import { useSolicitacao } from "../hooks";
import type { ArquivoLido, Detalhe, LeituraOcr } from "../solicitacoes";
import { AvisoComprovacao } from "./AdiantamentoVisao";
import { abrirAnexo, CampoValor, Regra } from "./comuns";
import { dataBR, docBR } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 15 — Comprovação do adiantamento (/financeiro/solicitacoes/:id/comprovacao): NF, recibo ou foto lidos no modo
// comprovacao (tipo, emissão, emitente, CNPJ, valor, número e referência ao pedido), regra A07 ao lado e o acerto:
// nota ≥ adiantado → comprovado (o saldo do pedido vai contra a nota no SIENGE); menor → devolução da diferença.

export function ComprovacaoPagina() {
  const { id } = useParams();
  const n = Number(id);
  const q = useSolicitacao(n);
  if (!Number.isInteger(n) || n <= 0) return <NotFound />;
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível abrir o adiantamento." onRetry={() => void q.refetch()} />;
  if (q.data.tipo !== "adiantamento" || !q.data.adiantamento) return <NotFound />;
  return <Tela d={q.data} />;
}

const TIPOS: { id: LeituraOcr["tipo_documento"]; rotulo: string }[] = [
  { id: "nfe", rotulo: "NF-e" }, { id: "nfce", rotulo: "NFC-e" }, { id: "cupom", rotulo: "Cupom" }, { id: "recibo", rotulo: "Recibo" }, { id: "outro", rotulo: "Outro" },
];

type Campos = Omit<DadosComprovacao, "id">;

function Tela({ d }: { d: Detalhe }) {
  const ids = useId();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const a = d.adiantamento!;
  const pendente = d.status === "comprovacao_pendente" && a.ehSolicitante;
  const arquivo = [...a.arquivosComprovacao].reverse().find((x) => !x.enviado) ?? null;
  const [f, setF] = useState<Campos>({ anexoId: arquivo?.id ?? null, tipoDocumento: "nfe", emissao: null, emitente: null, emitenteDoc: null, valor: null, numero: null, referencia: null });
  const [leg, setLeg] = useState<Partial<Record<"emissao" | "emitente" | "emitenteDoc" | "valor" | "numero" | "referencia" | "tipo", number>>>({});
  const [lendo, setLendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const muda = <K extends keyof Campos>(k: K, v: Campos[K]) => setF((x) => ({ ...x, [k]: v }));

  // Copia a leitura da nota para os campos (uma vez por arquivo).
  const aplicado = useRef<number | null>(null);
  useEffect(() => {
    if (!arquivo || aplicado.current === arquivo.id || !arquivo.ocr || arquivo.ocr.erro || (arquivo.status !== "lido" && arquivo.status !== "ilegivel")) return;
    aplicado.current = arquivo.id;
    const o = arquivo.ocr;
    const l = o.legibilidade;
    setF((x) => ({
      ...x, anexoId: arquivo.id, tipoDocumento: o.tipo_documento, emissao: o.data, emitente: o.favorecido, emitenteDoc: o.cnpj_cpf_emissor, valor: o.valor_total,
      numero: o.numero_documento ?? null, referencia: o.referencia_pedido ?? null,
    }));
    setLeg({ tipo: 0.99, emissao: l.data, emitente: l.favorecido, emitenteDoc: l.favorecido, valor: l.valor, numero: l.favorecido, referencia: l.favorecido });
  }, [arquivo]);

  // A07 ao vivo (o banco confere; a prévia não grava).
  const [chave, setChave] = useState(JSON.stringify(f));
  useEffect(() => {
    const t = setTimeout(() => setChave(JSON.stringify(f)), 500);
    return () => clearTimeout(t);
  }, [f]);
  const a07 = useQuery({
    queryKey: ["financeiro", "a07", d.id, chave],
    queryFn: () => adiantamentoService.checarComprovacao({ id: d.id, ...(JSON.parse(chave) as Campos) }),
    enabled: pendente,
    placeholderData: (anterior) => anterior,
  });

  const anexar = async (arq: File) => {
    setLendo(true);
    try {
      if (arquivo) await adiantamentoService.removerComprovacao(arquivo.id).catch(() => undefined);
      const r = await adiantamentoService.anexarComprovacao({ solicitacaoId: d.id, solicitanteId: d.solicitante.id, arquivo: arq });
      muda("anexoId", r.id);
      const l = await adiantamentoService.ler(r.id).catch(() => ({ status: "erro", mensagem: "Leitura indisponível: preencha à mão." }));
      if (l.status === "erro") toast.warning(l.mensagem ?? "Não foi possível ler a nota: preencha à mão.");
      await qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível anexar a nota.");
    } finally {
      setLendo(false);
    }
  };
  const tirar = async (x: ArquivoLido) => {
    await adiantamentoService.removerComprovacao(x.id).catch((e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível tirar o arquivo."));
    muda("anexoId", null);
    aplicado.current = null;
    void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
  };
  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await adiantamentoService.enviarComprovacao({ id: d.id, ...f, anexoId: arquivo?.id ?? f.anexoId });
      toast.success(r.acerto === "comprovado" ? "Comprovação enviada ao Financeiro" : `Comprovação enviada: devolução pendente de ${moeda(r.saldoDevolver)}`);
      await qc.invalidateQueries({ queryKey: ["financeiro"] });
      navegar(`/financeiro/solicitacoes/${d.id}`);
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível enviar a comprovação.");
    } finally {
      setEnviando(false);
    }
  };

  const adiantado = a.valor ?? 0;
  const ac = f.valor != null ? acerto(adiantado, f.valor) : null;
  const dias = a.prazoComprovacao ? Math.round((Date.parse(`${a.prazoComprovacao}T12:00:00`) - Date.now()) / 86_400_000) : null;
  const legDe = (k: keyof typeof leg) => leg[k] ?? null;
  const tira = (k: keyof typeof leg) => setLeg(({ [k]: _x, ...r }) => r);

  return (
    <>
      <div className="sf-ph">
        <div>
          <div className="sf-eyebrow">Adiantamento {d.numero}</div>
          <h2 className="sf-ph__t">Comprovação do adiantamento</h2>
          <p className="sf-ph__s">
            {a.pagoEm ? `Pago em ${new Date(a.pagoEm).toLocaleDateString("pt-BR")}` : "Pagamento"} a {a.favorecido ?? "—"}{a.pedidoNumero ? ` · Pedido ${a.pedidoNumero}` : ""}{a.obra ? ` · ${/^obra/i.test(a.obra) ? a.obra : `Obra ${a.obra}`}` : ""}
          </p>
        </div>
        <div className="sf-ph__acoes">
          {d.status === "comprovacao_pendente" && dias != null
            ? <span className={`sf-chip ${dias < 0 ? "sf-chip--erro" : "sf-chip--aviso"}`}>{dias < 0 ? `Comprovação vencida há ${-dias} dia${dias < -1 ? "s" : ""}` : `Comprovação pendente · vence em ${dias} dia${dias === 1 ? "" : "s"}`}</span>
            : <StatusChip status={d.status} />}
        </div>
      </div>

      {!pendente ? (
        <>
          <AvisoComprovacao d={d} />
          <p><Link to={`/financeiro/solicitacoes/${d.id}`}>Voltar ao adiantamento</Link></p>
        </>
      ) : (
        <>
          <div className="sf-aviso sf-aviso--i" role="note">
            <Info size={16} aria-hidden="true" />
            <div>
              <b>Lembretes automáticos</b>
              <p>Você recebe aviso 7 dias e 1 dia antes de {dataBR(a.prazoComprovacao)}. Vencido o prazo, o gestor é avisado e novos adiantamentos ficam bloqueados.</p>
            </div>
          </div>
          {a.comprovacoes[0]?.status === "ajuste" && (
            <div className="sf-aviso sf-aviso--roxo" role="alert"><b>O Financeiro pediu ajuste:</b> {a.comprovacoes[0].obs}</div>
          )}
          <div className="sf-dupla">
            <div className="sf-coluna">
              <FormSection numero={1} titulo="Nota fiscal ou recibo">
                <div className="sf-anexos sf-docs">
                  {arquivo && (
                    <span className="sf-anexo">
                      <button type="button" className="sf-anexo__nome" onClick={() => void abrirAnexo({ id: arquivo.id, nome: arquivo.nome, path: arquivo.path, mime: arquivo.mime, tamanho: 0 })}>
                        <Paperclip size={13} aria-hidden="true" />
                        {arquivo.nome}
                        {arquivo.status === "ilegivel" ? " · parte ilegível" : arquivo.status === "erro" ? " · sem leitura" : ""}
                      </button>
                      <button type="button" aria-label={`Tirar ${arquivo.nome}`} onClick={() => void tirar(arquivo)}><X size={13} aria-hidden="true" /></button>
                    </span>
                  )}
                  <Arquivo rotulo={arquivo ? "Trocar arquivo" : "Anexar NF, recibo ou foto"} ocupado={lendo} onArquivo={(x) => void anexar(x)} />
                </div>
                <div className="sf-campos">
                  <OcrField id={`${ids}-tp`} rotulo="Tipo" legibilidade={legDe("tipo")}>
                    <select id={`${ids}-tp`} className="input" value={f.tipoDocumento} onChange={(e) => { tira("tipo"); muda("tipoDocumento", e.target.value as Campos["tipoDocumento"]); }}>
                      {TIPOS.map((t) => <option key={t.id} value={t.id}>{t.rotulo}</option>)}
                    </select>
                  </OcrField>
                  <OcrField id={`${ids}-em`} rotulo="Emissão" legibilidade={legDe("emissao")}>
                    <input id={`${ids}-em`} className="input" type="date" value={f.emissao ?? ""} onChange={(e) => { tira("emissao"); muda("emissao", e.target.value || null); }} />
                  </OcrField>
                  <OcrField id={`${ids}-et`} rotulo="Emitente" legibilidade={legDe("emitente")}>
                    <input id={`${ids}-et`} className="input" maxLength={160} value={f.emitente ?? ""} onChange={(e) => { tira("emitente"); muda("emitente", e.target.value || null); }} />
                  </OcrField>
                  <OcrField id={`${ids}-ed`} rotulo="CNPJ do emitente" legibilidade={legDe("emitenteDoc")}>
                    <input id={`${ids}-ed`} className="input sf-mono" maxLength={18} value={docBR(f.emitenteDoc)} onChange={(e) => { tira("emitenteDoc"); muda("emitenteDoc", e.target.value.replace(/\D/g, "") || null); }} />
                  </OcrField>
                  <OcrField id={`${ids}-vl`} rotulo="Valor da nota" legibilidade={legDe("valor")}>
                    <CampoValor id={`${ids}-vl`} rotulo="Valor da nota" valor={f.valor} onChange={(v) => { tira("valor"); muda("valor", v); }} />
                  </OcrField>
                  <OcrField id={`${ids}-nu`} rotulo="Número da nota" legibilidade={legDe("numero")}>
                    <input id={`${ids}-nu`} className="input" maxLength={60} value={f.numero ?? ""} onChange={(e) => { tira("numero"); muda("numero", e.target.value || null); }} />
                  </OcrField>
                  <OcrField id={`${ids}-rf`} rotulo="Referência ao pedido" legibilidade={legDe("referencia")}>
                    <input id={`${ids}-rf`} className="input" maxLength={120} value={f.referencia ?? ""} onChange={(e) => { tira("referencia"); muda("referencia", e.target.value || null); }} />
                  </OcrField>
                </div>
              </FormSection>

              <FormSection numero={2} titulo="Acerto do adiantamento">
                <div className="sf-kpis sf-kpis--3">
                  <div className="sf-kpi"><span className="sf-kpi__rot">Adiantado</span><b>{moeda(adiantado)}</b><span className="sf-kpi__leg">{a.pagoEm ? `pago em ${new Date(a.pagoEm).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}` : ""}</span></div>
                  <div className="sf-kpi"><span className="sf-kpi__rot">Comprovado</span><b>{f.valor != null ? moeda(f.valor) : "—"}</b><span className="sf-kpi__leg">{f.numero ? `${TIPOS.find((t) => t.id === f.tipoDocumento)?.rotulo} ${f.numero}` : ""}</span></div>
                  <div className="sf-kpi">
                    <span className="sf-kpi__rot">Resultado</span>
                    <b className={ac ? (ac.resultado === "comprovado" ? "sf-kpi__n--ok" : "sf-txt-erro") : undefined}>{ac ? (ac.resultado === "comprovado" ? "Comprovado" : "Devolução") : "—"}</b>
                    <span className="sf-kpi__leg">{ac ? (ac.resultado === "comprovado" ? `saldo do pedido ${moeda(ac.saldoPagar)}` : `devolver ${moeda(ac.saldoDevolver)}`) : ""}</span>
                  </div>
                </div>
                {ac?.resultado === "comprovado" && (
                  <div className="sf-aviso sf-aviso--s" role="status">
                    <b>Adiantamento comprovado</b>
                    <p>{ac.saldoPagar > 0 ? `O saldo do pedido (${moeda(ac.saldoPagar)}) gera um novo lançamento contra a nota no SIENGE, e o adiantamento é compensado.` : "A nota cobre exatamente o adiantado: o adiantamento é compensado no SIENGE."}</p>
                  </div>
                )}
                {ac?.resultado === "devolucao" && (
                  <div className="sf-aviso sf-aviso--e" role="status">
                    <b>Devolução pendente: {moeda(ac.saldoDevolver)}</b>
                    <p>A nota ({moeda(f.valor ?? 0)}) é menor que o adiantado. A solicitação vai para "Devolução pendente" até a diferença ser devolvida.</p>
                  </div>
                )}
              </FormSection>
              <div className="sf-rodape">
                <button type="button" className="btn btn--primary sf-btn-final" disabled={enviando || lendo || !arquivo || !f.valor || !f.emissao || !f.emitenteDoc} onClick={() => void enviar()}>
                  <Send size={16} aria-hidden="true" />
                  {enviando ? "Enviando…" : "Enviar comprovação ao Financeiro"}
                </button>
              </div>
            </div>
            <aside className="sf-lateral">
              <section className="card sf-painel" aria-labelledby={`${ids}-a7`}>
                <h3 id={`${ids}-a7`}>Regra A07 · comprovação</h3>
                <ul className="sf-regras">
                  {(a07.data ?? []).map((r) => (
                    <Regra key={r.nome} cod="A07" texto={`${r.nome} · ${r.detalhe}`} tom={r.resultado === "ok" ? "ok" : "aviso"} res={r.resultado === "ok" ? "OK" : "Alerta"} />
                  ))}
                </ul>
                <p className="field__help">Alertas não impedem o envio: o Financeiro decide na conferência. Valor menor que o adiantado gera devolução.</p>
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function Arquivo({ rotulo, ocupado, onArquivo }: { rotulo: string; ocupado: boolean; onArquivo: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const escolher = (e: ChangeEvent<HTMLInputElement>) => {
    const arq = e.target.files?.[0];
    e.target.value = "";
    if (arq) onArquivo(arq);
  };
  return (
    <>
      <button type="button" className="sf-anexar" disabled={ocupado} onClick={() => ref.current?.click()}>
        <Upload size={13} aria-hidden="true" />
        {ocupado ? "Lendo a nota…" : rotulo}
      </button>
      <input ref={ref} type="file" hidden accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf" aria-label={rotulo} onChange={escolher} />
    </>
  );
}
