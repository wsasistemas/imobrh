import { useQueryClient } from "@tanstack/react-query";
import { Eye, Info, Paperclip, Plus, Send, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ServiceError } from "../../configuracoes/services/types";
import { percentualDaCondicao, prazoComprovacao, somaRateio, valorDaTarefa, valorDoPedido, valorPorExtenso } from "../../../../supabase/functions/_shared/sf/adiantamento.ts";
import { adiantamentoService, type SalvarAdiantamento } from "../adiantamento";
import { moeda } from "../cadeia";
import { ApprovalTimeline, type EtapaTimeline } from "../components/ApprovalTimeline";
import { FormSection, OcrField } from "../components/Campos";
import { FormPreview } from "../components/FormPreview";
import { useCancelarSolicitacao, useChecagens, useEnviarSolicitacao } from "../hooks";
import type { ArquivoLido, Detalhe, FormaPagamento } from "../solicitacoes";
import { abrirAnexo, CampoValor, Regra, Ro } from "./comuns";
import { dataBR, docBR } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 13 — Adiantamento de numerário (modelo padrão): documento de origem com leitura (nº do pedido, data, fornecedor,
// CNPJ, valor total e condição; o sistema calcula valor = total × percentual), obra e apropriação com rateio por tarefa
// (A05), valor por extenso gerado, favorecido, forma de pagamento, prazos (comprovação = vencimento + dias do setor),
// aceite com termo de responsabilidade e, ao lado, as alçadas para o valor e as checagens A01–A06.

type Campos = Omit<SalvarAdiantamento, "id" | "rateio">;
type LinhaRateio = { chave: string; tarefa: string; porcentagem: number | null };
let chaveRateio = 0;

const FORMAS: { id: FormaPagamento; rotulo: string }[] = [
  { id: "deposito", rotulo: "Depósito" },
  { id: "boleto", rotulo: "Boleto" },
  { id: "cheque", rotulo: "Cheque" },
  { id: "dinheiro", rotulo: "Dinheiro" },
];

/** Campos do pedido que a leitura preenche, com a legibilidade de cada um. */
type Copiado = Partial<Record<"pedidoNumero" | "pedidoData" | "pedidoFornecedor" | "pedidoFornecedorDoc" | "pedidoValor" | "pedidoCondicao", number>>;

export function AdiantamentoFormulario({ d }: { d: Detalhe }) {
  const ids = useId();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const a = d.adiantamento!;
  const [f, setF] = useState<Campos>(() => ({
    obra: a.obra, contaCaixa: a.contaCaixa, contaPagamento: a.contaPagamento, centroCusto: a.centroCusto, centroApuracao: a.centroApuracao, valor: a.valor,
    favorecido: a.favorecido, favorecidoDoc: a.favorecidoDoc, finalidade: a.finalidade, formaPagamento: a.formaPagamento ?? "deposito", banco: a.banco, agencia: a.agencia,
    conta: a.conta, tipoConta: a.tipoConta ?? "corrente", vencimento: a.vencimento, pedidoNumero: a.pedidoNumero, pedidoData: a.pedidoData,
    pedidoFornecedor: a.pedidoFornecedor, pedidoFornecedorDoc: a.pedidoFornecedorDoc, pedidoValor: a.pedidoValor, pedidoPercentual: a.pedidoPercentual,
    pedidoCondicao: a.pedidoCondicao,
  }));
  const [rateio, setRateio] = useState<LinhaRateio[]>(() =>
    a.rateio.length ? a.rateio.map((r) => ({ chave: `r${++chaveRateio}`, tarefa: r.tarefa, porcentagem: r.porcentagem })) : [{ chave: `r${++chaveRateio}`, tarefa: "", porcentagem: 100 }]);
  const [copiado, setCopiado] = useState<Copiado>({});
  const [aceite, setAceite] = useState(false);
  const [salvoEm, setSalvoEm] = useState<Date | null>(null);
  const [erroSalvar, setErroSalvar] = useState<{ campo?: string; mensagem: string } | null>(null);
  const [lendo, setLendo] = useState(false);
  const [cancelarAberto, setCancelarAberto] = useState(false);
  const [preview, setPreview] = useState(false);
  const enviar = useEnviarSolicitacao();
  const cancelar = useCancelarSolicitacao();
  const checagens = useChecagens(d.id, true);
  const muda = <K extends keyof Campos>(k: K, v: Campos[K]) => setF((x) => ({ ...x, [k]: v }));

  // Rascunho automático (1,2 s depois da última mudança).
  const assinatura = JSON.stringify({ f, rateio: rateio.map(({ tarefa, porcentagem }) => ({ tarefa, porcentagem })) });
  const gravada = useRef(assinatura);
  const salvarAgora = useCallback(async () => {
    await adiantamentoService.salvar({ id: d.id, ...f, rateio: rateio.map(({ tarefa, porcentagem }) => ({ tarefa, porcentagem })) });
    setSalvoEm(new Date());
    setErroSalvar(null);
    void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
    void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
  }, [d.id, f, rateio, qc]);
  useEffect(() => {
    if (assinatura === gravada.current) return;
    const t = setTimeout(() => {
      gravada.current = assinatura;
      salvarAgora().catch((e) => setErroSalvar(e instanceof ServiceError ? { campo: e.field, mensagem: e.message } : { mensagem: "Não foi possível salvar o rascunho." }));
    }, 1200);
    return () => clearTimeout(t);
  }, [assinatura, salvarAgora]);

  // Leitura do documento de origem: copia para os campos vazios (só transcrição; o valor é calculado pelo sistema).
  const aplicados = useRef(new Set(a.documentos.filter((x) => x.status !== "fila" && x.status !== "lendo").map((x) => x.id)));
  useEffect(() => {
    for (const doc of a.documentos) {
      if (aplicados.current.has(doc.id) || !doc.ocr || doc.ocr.erro || (doc.status !== "lido" && doc.status !== "ilegivel")) continue;
      aplicados.current.add(doc.id);
      const o = doc.ocr;
      const leg = o.legibilidade;
      const pct = percentualDaCondicao(o.condicao_pagamento);
      setF((x) => {
        const n = { ...x };
        const novo: Copiado = {};
        const poe = <K extends keyof Copiado>(k: K, v: Campos[K] | null | undefined, l: number) => {
          if (v == null || v === "" || (x[k] != null && x[k] !== "")) return;
          (n as Record<string, unknown>)[k] = v;
          novo[k] = l;
        };
        poe("pedidoNumero", o.numero_documento, leg.favorecido);
        poe("pedidoData", o.data, leg.data);
        poe("pedidoFornecedor", o.favorecido, leg.favorecido);
        poe("pedidoFornecedorDoc", o.cnpj_cpf_emissor, leg.favorecido);
        poe("pedidoValor", o.valor_total, leg.valor);
        poe("pedidoCondicao", o.condicao_pagamento, leg.valor);
        if (n.pedidoPercentual == null && pct != null) n.pedidoPercentual = pct;
        if (n.valor == null) n.valor = valorDoPedido(n.pedidoValor, n.pedidoPercentual);
        if (!n.favorecido && o.favorecido) n.favorecido = o.favorecido;
        if (!n.favorecidoDoc && o.cnpj_cpf_emissor) n.favorecidoDoc = o.cnpj_cpf_emissor;
        setCopiado((c) => ({ ...c, ...novo }));
        return n;
      });
      toast.success(doc.status === "lido" ? `${doc.nome}: dados do pedido copiados` : `${doc.nome}: parte dos campos ficou ilegível, confira à mão`);
    }
  }, [a.documentos]);

  const anexar = async (arquivo: File) => {
    setLendo(true);
    try {
      const r = await adiantamentoService.anexarDocumento({ solicitacaoId: d.id, solicitanteId: d.solicitante.id, arquivo });
      void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      const l = await adiantamentoService.ler(r.id).catch(() => ({ status: "erro", mensagem: "Leitura indisponível: preencha à mão." }));
      if (l.status === "erro") toast.warning(l.mensagem ?? "Não foi possível ler o documento: preencha à mão.");
      await qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível anexar o documento.");
    } finally {
      setLendo(false);
    }
  };
  const tirar = async (x: ArquivoLido) => {
    try {
      await adiantamentoService.removerDocumento(x.id);
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível tirar o documento.");
    }
  };

  const doEnvio = async () => {
    try {
      gravada.current = assinatura;
      await salvarAgora();
      const r = await enviar.mutateAsync(d.id);
      toast.success(r.alertas ? `Enviado para aprovação, com ${r.alertas} alerta${r.alertas > 1 ? "s" : ""} para os aprovadores.` : "Enviado para aprovação");
    } catch (e) {
      if (e instanceof ServiceError) setErroSalvar({ campo: e.field, mensagem: e.message });
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível enviar.");
    }
  };

  const calculado = valorDoPedido(f.pedidoValor, f.pedidoPercentual);
  const soma = somaRateio(rateio.filter((r) => r.tarefa.trim() || r.porcentagem));
  const prazo = prazoComprovacao(f.vencimento, a.prazoDias);
  const lista = checagens.data ?? [];
  const bloqueios = lista.filter((c) => c.resultado === "bloqueio");
  const erroDe = (campo: string) => (erroSalvar?.campo === campo ? <span className="field__error" role="alert">{erroSalvar.mensagem}</span> : null);
  const deposito = f.formaPagamento === "deposito";
  const obras = [...new Set([...(a.obras ?? []), ...(f.obra ? [f.obra] : [])])];
  const leg = (k: keyof Copiado) => copiado[k] ?? null;
  const editado = (k: keyof Copiado) => () => setCopiado(({ [k]: _x, ...resto }) => resto);

  return (
    <>
      <div className="sf-ph">
        <div>
          <div className="sf-eyebrow">{d.status === "devolvida" ? "Devolvido para ajuste" : "Novo"} · {d.numero} (rascunho)</div>
          <h2 className="sf-ph__t">Adiantamento de numerário</h2>
          <p className="sf-ph__s">Segue o modelo "Adiantamento de Numerário" da empresa. As aprovações registradas substituem as assinaturas.</p>
        </div>
        <div className="sf-ph__acoes">
          <span className={`sf-salvo${erroSalvar ? " sf-salvo--erro" : ""}`} role="status">
            {erroSalvar?.mensagem ?? (salvoEm ? `Rascunho salvo às ${salvoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Rascunho salvo automaticamente")}
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

      {d.status === "devolvida" && (
        <div className="sf-aviso sf-aviso--roxo" role="alert">
          <b>Devolvido para ajuste.</b> {[...d.aprovacoes].reverse().find((x) => x.status === "devolvido")?.comentario ?? ""} Corrija e envie de novo: a aprovação recomeça do nível 1.
        </div>
      )}

      <div className="sf-dupla">
        <div className="sf-coluna">
          <FormSection numero={1} titulo="Documento de origem" extra="pedido de compras, proposta ou e-mail">
            <div className="sf-anexos sf-docs">
              {a.documentos.map((x) => (
                <span key={x.id} className="sf-anexo">
                  <button type="button" className="sf-anexo__nome" title="Abrir" onClick={() => void abrirAnexo({ id: x.id, nome: x.nome, path: x.path, mime: x.mime, tamanho: 0 })}>
                    <Paperclip size={13} aria-hidden="true" />
                    {x.nome}
                    {x.status === "lendo" || x.status === "fila" ? " · lendo…" : x.status === "ilegivel" ? " · parte ilegível" : x.status === "erro" ? " · sem leitura" : ""}
                  </button>
                  <button type="button" aria-label={`Tirar ${x.nome}`} onClick={() => void tirar(x)}><X size={13} aria-hidden="true" /></button>
                </span>
              ))}
              <Anexar rotulo={a.documentos.length ? "Anexar outro" : "Anexar documento"} ocupado={lendo} onArquivo={(arq) => void anexar(arq)} />
            </div>
            <div className="sf-campos">
              <OcrField id={`${ids}-pn`} rotulo="Nº do pedido" legibilidade={leg("pedidoNumero")}>
                <input id={`${ids}-pn`} className="input" maxLength={40} value={f.pedidoNumero ?? ""} onChange={(e) => { editado("pedidoNumero")(); muda("pedidoNumero", e.target.value || null); }} />
              </OcrField>
              <OcrField id={`${ids}-pd`} rotulo="Data do pedido" legibilidade={leg("pedidoData")}>
                <input id={`${ids}-pd`} className="input" type="date" value={f.pedidoData ?? ""} onChange={(e) => { editado("pedidoData")(); muda("pedidoData", e.target.value || null); }} />
              </OcrField>
              <OcrField id={`${ids}-pf`} rotulo="Fornecedor" legibilidade={leg("pedidoFornecedor")}>
                <input id={`${ids}-pf`} className="input" maxLength={160} value={f.pedidoFornecedor ?? ""} onChange={(e) => { editado("pedidoFornecedor")(); muda("pedidoFornecedor", e.target.value || null); }} />
              </OcrField>
              <OcrField id={`${ids}-pc`} rotulo="CNPJ do fornecedor" legibilidade={leg("pedidoFornecedorDoc")}>
                <input id={`${ids}-pc`} className="input sf-mono" maxLength={18} value={docBR(f.pedidoFornecedorDoc)} onChange={(e) => { editado("pedidoFornecedorDoc")(); muda("pedidoFornecedorDoc", e.target.value.replace(/\D/g, "") || null); }} />
              </OcrField>
              <OcrField id={`${ids}-pv`} rotulo="Valor total do pedido" legibilidade={leg("pedidoValor")}>
                <CampoValor id={`${ids}-pv`} rotulo="Valor total do pedido" valor={f.pedidoValor} onChange={(v) => { editado("pedidoValor")(); muda("pedidoValor", v); }} />
              </OcrField>
              <OcrField id={`${ids}-cp`} rotulo="Condição de pagamento" legibilidade={leg("pedidoCondicao")}>
                <input id={`${ids}-cp`} className="input" maxLength={200} value={f.pedidoCondicao ?? ""}
                  onChange={(e) => {
                    editado("pedidoCondicao")();
                    muda("pedidoCondicao", e.target.value || null);
                    const p = percentualDaCondicao(e.target.value);
                    if (p != null) muda("pedidoPercentual", p);
                  }} />
              </OcrField>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-pp`}>Percentual da condição (%)</label>
                <input id={`${ids}-pp`} className="input sf-num" inputMode="decimal" value={f.pedidoPercentual == null ? "" : String(f.pedidoPercentual).replace(".", ",")}
                  onChange={(e) => { const n = Number(e.target.value.replace(",", ".")); muda("pedidoPercentual", e.target.value === "" || Number.isNaN(n) ? null : n); }} />
                <span className="field__help">Tirado da condição (ex.: 50% sinal).</span>
              </div>
            </div>
            {calculado != null && (
              <div className="sf-aviso sf-aviso--i" role="status">
                <Info size={16} aria-hidden="true" />
                <div>
                  <b>Valor do adiantamento calculado pelo sistema: {moeda(f.pedidoValor ?? 0)} × {String(f.pedidoPercentual).replace(".", ",")}% = {moeda(calculado)}</b>
                  <p>A leitura só transcreve. O cálculo é do sistema e vai para o campo Valor (seção 3).</p>
                  {f.valor !== calculado && (
                    <button type="button" className="btn btn--outline btn--sm" onClick={() => muda("valor", calculado)}>Usar {moeda(calculado)} no valor</button>
                  )}
                </div>
              </div>
            )}
          </FormSection>

          <FormSection numero={2} titulo="Obra e apropriação">
            <div className="sf-campos">
              <div className="field sf-campo-2">
                <label className="field__label" htmlFor={`${ids}-ob`}>Obra (empresa pagadora)</label>
                <input id={`${ids}-ob`} className="input" list={`${ids}-obras`} maxLength={160} value={f.obra ?? ""} onChange={(e) => muda("obra", e.target.value || null)} />
                <datalist id={`${ids}-obras`}>{obras.map((o) => <option key={o} value={o} />)}</datalist>
                {erroDe("obra")}
              </div>
              <Ro rotulo="Data do preenchimento" valor={`${dataBR(a.dataPreenchimento)} · automática`} trava />
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-cx`}>Conta caixa</label>
                <input id={`${ids}-cx`} className="input" maxLength={40} value={f.contaCaixa ?? ""} onChange={(e) => muda("contaCaixa", e.target.value || null)} />
              </div>
              <div className="field sf-campo-2">
                <label className="field__label" htmlFor={`${ids}-cpg`}>Conta de pagamento</label>
                <input id={`${ids}-cpg`} className="input" maxLength={120} placeholder="Ex.: SICOOB - C/C 30.062-4" value={f.contaPagamento ?? ""} onChange={(e) => muda("contaPagamento", e.target.value || null)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-cc`}>Centro de custo</label>
                <input id={`${ids}-cc`} className="input" maxLength={60} placeholder="Ex.: 00.00114" value={f.centroCusto ?? ""} onChange={(e) => muda("centroCusto", e.target.value || null)} />
                {erroDe("centroCusto")}
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-ca`}>Centro de apuração</label>
                <input id={`${ids}-ca`} className="input" maxLength={60} value={f.centroApuracao ?? ""} onChange={(e) => muda("centroApuracao", e.target.value || null)} />
              </div>
            </div>
            <span className="field__label sf-rot-rateio">Rateio por tarefa</span>
            <div className="at-tab-wrap">
              <table className="at-tab sf-rateio">
                <thead><tr><th>Tarefa</th><th className="n">Porcentagem</th><th className="n">Valor</th><th><span className="sr-only">Remover</span></th></tr></thead>
                <tbody>
                  {rateio.map((r, i) => (
                    <tr key={r.chave}>
                      <td><input className="input" maxLength={40} aria-label={`Tarefa ${i + 1}`} placeholder="Ex.: 29.02.20" value={r.tarefa}
                        onChange={(e) => setRateio((rs) => rs.map((x) => (x.chave === r.chave ? { ...x, tarefa: e.target.value } : x)))} /></td>
                      <td><input className="input sf-num" inputMode="decimal" aria-label={`Porcentagem da tarefa ${i + 1}`} value={r.porcentagem == null ? "" : String(r.porcentagem).replace(".", ",")}
                        onChange={(e) => { const n = Number(e.target.value.replace("%", "").replace(",", ".")); setRateio((rs) => rs.map((x) => (x.chave === r.chave ? { ...x, porcentagem: e.target.value === "" || Number.isNaN(n) ? null : n } : x))); }} /></td>
                      <td className="n">{moeda(valorDaTarefa(f.valor, r.porcentagem))}</td>
                      <td><button type="button" className="icon-btn" aria-label={`Remover tarefa ${i + 1}`} onClick={() => setRateio((rs) => (rs.length > 1 ? rs.filter((x) => x.chave !== r.chave) : rs))}><Trash2 size={15} aria-hidden="true" /></button></td>
                    </tr>
                  ))}
                  <tr className="sf-total">
                    <td>
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => setRateio((rs) => [...rs, { chave: `r${++chaveRateio}`, tarefa: "", porcentagem: null }])}>
                        <Plus size={14} aria-hidden="true" />
                        Adicionar tarefa
                      </button>
                    </td>
                    <td className="n">{String(soma.soma).replace(".", ",")}% <span className={`sf-chip ${soma.fecha ? "sf-chip--ok" : "sf-chip--erro"}`}>A05</span></td>
                    <td className="n">{moeda(rateio.reduce((s, r) => s + valorDaTarefa(f.valor, r.porcentagem), 0))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {!soma.fecha && <span className="field__help">O rateio precisa fechar 100%.</span>}
            {erroDe("rateio")}
          </FormSection>

          <FormSection numero={3} titulo="Valor e favorecido">
            <div className="sf-campos">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-v`}>Valor</label>
                <CampoValor id={`${ids}-v`} rotulo="Valor" valor={f.valor} onChange={(v) => muda("valor", v)} />
                {erroDe("valor") ?? <span className="field__help">{calculado != null ? "Calculado do pedido (editável)" : "Em reais"}</span>}
              </div>
              <div className="sf-campo-2"><Ro rotulo="Valor por extenso" valor={f.valor ? `${valorPorExtenso(f.valor)} · gerado` : "—"} trava /></div>
              <div className="field sf-campo-2">
                <label className="field__label" htmlFor={`${ids}-fv`}>Favorecido</label>
                <input id={`${ids}-fv`} className="input" maxLength={160} value={f.favorecido ?? ""} onChange={(e) => muda("favorecido", e.target.value || null)} />
                {erroDe("favorecido")}
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-fd`}>CPF/CNPJ</label>
                <input id={`${ids}-fd`} className="input sf-mono" maxLength={18} value={docBR(f.favorecidoDoc)} onChange={(e) => muda("favorecidoDoc", e.target.value.replace(/\D/g, "") || null)} />
                {erroDe("favorecidoDoc")}
              </div>
              <div className="field sf-campo-todo">
                <label className="field__label" htmlFor={`${ids}-fi`}>Finalidade</label>
                <input id={`${ids}-fi`} className="input" maxLength={500} value={f.finalidade ?? ""} onChange={(e) => muda("finalidade", e.target.value || null)} />
                {erroDe("finalidade")}
              </div>
              <div className="sf-campo-todo">
                <Ro rotulo="Nome do funcionário" valor={`${d.solicitante.nome} · ${d.setor?.nome ?? "Sem setor"}`} trava />
              </div>
            </div>
          </FormSection>

          <FormSection numero={4} titulo="Forma de pagamento">
            <div className="sf-seg" role="group" aria-label="Forma de pagamento">
              {FORMAS.map((x) => <button key={x.id} type="button" aria-pressed={f.formaPagamento === x.id} onClick={() => muda("formaPagamento", x.id)}>{x.rotulo}</button>)}
            </div>
            {deposito && (
              <div className="sf-campos sf-deposito">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-bc`}>Banco</label>
                  <input id={`${ids}-bc`} className="input" maxLength={60} value={f.banco ?? ""} onChange={(e) => muda("banco", e.target.value || null)} />
                  {erroDe("banco")}
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-ag`}>Agência</label>
                  <input id={`${ids}-ag`} className="input" maxLength={20} value={f.agencia ?? ""} onChange={(e) => muda("agencia", e.target.value || null)} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-ct`}>Conta</label>
                  <input id={`${ids}-ct`} className="input" maxLength={30} value={f.conta ?? ""} onChange={(e) => muda("conta", e.target.value || null)} />
                </div>
                <div className="field">
                  <span className="field__label">Tipo de conta</span>
                  <div className="sf-seg" role="group" aria-label="Tipo de conta">
                    <button type="button" aria-pressed={f.tipoConta === "corrente"} onClick={() => muda("tipoConta", "corrente")}>Corrente</button>
                    <button type="button" aria-pressed={f.tipoConta === "poupanca"} onClick={() => muda("tipoConta", "poupanca")}>Poupança</button>
                  </div>
                </div>
              </div>
            )}
            <span className="field__help">A04: o Financeiro confere se a conta pertence ao CPF/CNPJ do favorecido.</span>
          </FormSection>

          <FormSection numero={5} titulo="Prazos">
            <div className="sf-campos">
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-vc`}>Vencimento</label>
                <input id={`${ids}-vc`} className="input" type="date" min={new Date().toISOString().slice(0, 10)} value={f.vencimento ?? ""} onChange={(e) => muda("vencimento", e.target.value || null)} />
                {erroDe("vencimento")}
              </div>
              <Ro rotulo="Prazo máximo de comprovação" valor={prazo ? `${dataBR(prazo)} · vencimento + ${a.prazoDias} dias (setor)` : `vencimento + ${a.prazoDias} dias (setor)`} trava />
            </div>
          </FormSection>

          <FormSection numero={6} titulo="Aceite e termo de responsabilidade">
            <label className="sf-aceite">
              <input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
              <span>
                <b>Assumo a responsabilidade de comprovar este adiantamento com nota fiscal ou recibo até {prazo ? dataBR(prazo) : "o prazo de comprovação"}.</b>
                <small>Sem comprovação no prazo, o gestor é avisado e novos adiantamentos ficam bloqueados. O aceite registra usuário, data e hora, IP e navegador e substitui a assinatura do funcionário.</small>
              </span>
            </label>
          </FormSection>

          <div className="sf-rodape">
            <button type="button" className="btn btn--primary sf-btn-final" disabled={!aceite || enviar.isPending || bloqueios.length > 0} onClick={() => void doEnvio()}>
              <Send size={16} aria-hidden="true" />
              {enviar.isPending ? "Enviando…" : "Enviar para aprovação"}
            </button>
          </div>
        </div>

        <aside className="sf-lateral">
          <section className="card sf-painel" aria-labelledby={`${ids}-al`}>
            <h3 id={`${ids}-al`}>Alçadas para {moeda(f.valor ?? 0)}</h3>
            <p className="field__help">
              {a.setorObra ? <>Setor <b>{d.setor?.nome ?? "—"}</b> é de obra: entra o Planejamento.</> : <>Setor <b>{d.setor?.nome ?? "—"}</b> não é de obra: sem Planejamento.</>}
            </p>
            <ApprovalTimeline etapas={alcadas(d)} />
          </section>
          <section className="card sf-painel" aria-labelledby={`${ids}-ck`}>
            <h3 id={`${ids}-ck`}>Checagens automáticas</h3>
            <ul className="sf-regras">
              {lista.map((c) => (
                <Regra key={c.codigo} cod={c.codigo} texto={`${NOME_REGRA[c.codigo] ?? ""} · ${c.detalhe}`}
                  tom={c.resultado === "ok" ? "ok" : c.resultado === "alerta" ? "aviso" : "erro"} res={c.resultado === "ok" ? "OK" : c.resultado === "alerta" ? "Alerta" : "Bloqueia"} />
              ))}
              <Regra cod="—" texto={aceite ? "Aceite marcado" : "Marque o termo de responsabilidade"} tom={aceite ? "ok" : "aviso"} res={aceite ? "OK" : "Pendente"} />
            </ul>
            <p className="field__help">As checagens valem para o que já foi salvo. Alertas não impedem o envio: os aprovadores e o Financeiro decidem.</p>
          </section>
        </aside>
      </div>
      <FormPreview d={d} aberto={preview} onFechar={() => setPreview(false)} />
    </>
  );
}

export const NOME_REGRA: Record<string, string> = {
  A01: "Documento de origem", A02: "Valor × pedido", A03: "Favorecido × pedido", A04: "Titularidade bancária", A05: "Rateio", A06: "Adiantamentos em aberto", A07: "Comprovação",
};

/** Cadeia prevista (painel de alçadas): os níveis não exigidos aparecem tracejados. */
function alcadas(d: Detalhe): EtapaTimeline[] {
  const c = d.cadeiaPrevista ?? [];
  if (c.length === 0) return [{ chave: "sem", titulo: "Sem aprovador de adiantamento configurado", detalhe: "Avise o administrador do seu setor.", estado: "futuro" }];
  return c.map((e) => ({
    chave: `n${e.nivel}`,
    titulo: `${e.papel}${e.aprovador ? ` · ${e.aprovador}` : ""}`,
    detalhe: e.exigido && !e.pulado ? (e.motivo === "despesa de obra" ? "Exigido: despesa de obra" : e.motivo === "sempre" ? "Sempre" : "Exigido: acima da alçada") : e.pulado ? "Etapa do próprio solicitante: pulada" : "Não exigido para este valor",
    estado: e.exigido && !e.pulado ? "futuro" : "nao_exigido",
  }));
}

function Anexar({ rotulo, ocupado, onArquivo }: { rotulo: string; ocupado: boolean; onArquivo: (f: File) => void }) {
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
        {ocupado ? "Lendo o documento…" : rotulo}
      </button>
      <input ref={ref} type="file" hidden accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf" aria-label={rotulo} onChange={escolher} />
    </>
  );
}
