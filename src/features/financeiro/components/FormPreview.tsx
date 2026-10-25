import * as Dialog from "@radix-ui/react-dialog";
import { FileText, Printer, X, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { valorPorExtenso } from "../../../../supabase/functions/_shared/sf/adiantamento.ts";
import { moeda } from "../cadeia";
import { dataBR, docBR, mesBR } from "../pages/formato";
import { siengeService } from "../sienge";
import { abrirAnexo } from "./VisualizadorAnexo";
import type { Detalhe } from "../solicitacoes";

// Tela 10 — FormPreview: o formulário no layout padrão 2026 da empresa (A4), com toolbar escura (fechar, zoom, imprimir,
// baixar PDF) e a lista de comprovantes ao lado. "Baixar PDF" é o mesmo PDF que vai anexado ao título no SIENGE
// (gerado no servidor, imobdesk-sf-sienge › pdf).

const TITULO: Record<Detalhe["tipo"], string> = { reembolso: "REEMBOLSO", fundo_fixo: "FUNDO FIXO DE CAIXA", adiantamento: "ADIANTAMENTO DE NUMERÁRIO" };

export function FormPreview({ d, aberto, onFechar }: { d: Detalhe; aberto: boolean; onFechar: () => void }) {
  const [zoom, setZoom] = useState(1);
  const fundo = d.tipo === "fundo_fixo";
  const gestor = [...d.aprovacoes].reverse().find((a) => a.status === "aprovado" && a.ciclo === d.ciclo);
  const ad = d.tipo === "adiantamento" ? d.adiantamento : undefined;
  const anexos = ad
    ? ad.documentos.map((x) => ({ id: x.id, nome: x.nome, path: x.path, valor: null as number | null }))
    : d.itens.flatMap((i) => i.anexos.map((a) => ({ ...a, valor: i.valor })));
  const baixar = async () => {
    try {
      const blob = await siengeService.pdf(d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.numero}-formulario.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível gerar o PDF. Use Imprimir › Salvar como PDF.");
    }
  };

  return (
    <Dialog.Root open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-modal__fundo" />
        <Dialog.Content className="sf-modal" aria-describedby={undefined}>
          <div className="sf-modal__barra">
            <Dialog.Title className="sf-modal__t">{TITULO[d.tipo]} · {d.numero}</Dialog.Title>
            <button type="button" aria-label="Diminuir zoom" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}><ZoomOut size={16} aria-hidden="true" /></button>
            <button type="button" aria-label="Aumentar zoom" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}><ZoomIn size={16} aria-hidden="true" /></button>
            <button type="button" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />Imprimir</button>
            <button type="button" onClick={() => void baixar()}><FileText size={16} aria-hidden="true" />Baixar PDF</button>
            <Dialog.Close asChild>
              <button type="button" aria-label="Fechar"><X size={16} aria-hidden="true" /></button>
            </Dialog.Close>
          </div>
          <div className="sf-modal__corpo">
            <div className="sf-modal__palco">
              <div className="sf-a4" style={{ zoom }}>
                <div className="sf-a4__topo">
                  <div><small>Título:</small><b>{TITULO[d.tipo]}</b></div>
                  <img src="/wsa-logo.png" alt="WSA Sistemas" width={40} height={40} />
                </div>
                {ad ? <CorpoAdiantamento d={d} /> : (<>
                <table className="sf-a4__kv">
                  <tbody>
                    {fundo && <tr><th>VALOR DO FUNDO FIXO:</th><td>{moeda(d.valorFundoFixo ?? 0)}</td><th>SALDO INICIAL:</th><td>{moeda(d.saldoInicial ?? 0)}</td></tr>}
                    <tr><th>FUNCIONÁRIO:</th><td>{d.solicitante.nome.toUpperCase()}</td><th>CPF:</th><td>{d.solicitante.cpfMascarado ?? "—"}</td></tr>
                    <tr><th>DEPARTAMENTO:</th><td>{(d.setor?.nome ?? "—").toUpperCase()}</td><th>MÊS:</th><td>{mesBR(d.competencia)}</td></tr>
                    <tr><th>PERÍODO:</th><td>DE {dataBR(d.periodoDe)} A {dataBR(d.periodoAte)}</td><th>Nº:</th><td>{d.numero}</td></tr>
                  </tbody>
                </table>
                <table className="sf-a4__tab">
                  <thead><tr><th>DATA</th><th>VALOR</th><th>{fundo ? "FAVORECIDO" : "DESCRIÇÃO"}</th><th>{fundo ? "MOTIVO / DESCRIÇÃO" : "MOTIVO"}</th></tr></thead>
                  <tbody>
                    {d.itens.map((i) => (
                      <tr key={i.id}><td>{dataBR(i.data)}</td><td className="n">{(i.valor ?? 0).toFixed(2).replace(".", ",")}</td><td>{i.descricao}</td><td>{i.motivo}</td></tr>
                    ))}
                    <tr className="sf-a4__total">
                      <td>{fundo ? "DESPESAS TOTAIS" : "VALOR TOTAL"}</td><td className="n">{d.totalDespesas.toFixed(2).replace(".", ",")}</td>
                      <td>{fundo ? "SALDO FINAL:" : d.valorGlosado > 0 ? "GLOSAS / A PAGAR:" : ""}</td>
                      <td>{fundo ? (d.saldoFinal ?? 0).toFixed(2).replace(".", ",") : d.valorGlosado > 0 ? `${moeda(d.valorGlosado)} / ${moeda(d.valorAPagar ?? 0)}` : ""}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="sf-a4__info">
                  <b>INFORMAÇÕES DE PREENCHIMENTO</b>
                  <p>1 - Preencher corretamente o campo de data, valor, descrição (fornecedor) e motivo da despesa; o reembolso ocorrerá conforme padrão de pagamento, 15 dias.</p>
                  <p>2 - Os comprovantes da despesa seguem anexados a este formulário.</p>
                  <p>3 - As assinaturas do funcionário e do gestor foram substituídas pelo aceite eletrônico e pelas aprovações registradas no Portal.</p>
                </div>
                <div className="sf-a4__aceites">
                  <div><b>ACEITE DO FUNCIONÁRIO</b><span>{d.solicitante.nome} · {d.aceiteEm ? new Date(d.aceiteEm).toLocaleString("pt-BR") : "pendente"}</span></div>
                  <div><b>APROVAÇÃO DO GESTOR</b><span>{gestor ? `${gestor.aprovador ?? gestor.papel} · ${gestor.decididoEm ? new Date(gestor.decididoEm).toLocaleString("pt-BR") : ""}` : "pendente"}</span>{gestor?.comentario && <span>"{gestor.comentario}"</span>}</div>
                </div>
                </>)}
              </div>
            </div>
            <aside className="sf-modal__lado">
              <h3>{ad ? "Documento de origem" : "Comprovantes"} · {anexos.length}</h3>
              <ul className="sf-fila">
                {anexos.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="sf-fila__item" onClick={() => void abrirAnexo({ path: a.path, nome: a.nome, mime: "mime" in a ? String(a.mime) : a.nome.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg" })}>
                      <FileText size={16} aria-hidden="true" />
                      <span><b>{a.nome}</b>{a.valor != null && <small>{moeda(a.valor)}</small>}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="field__help">O mesmo formulário vai anexado ao lançamento no SIENGE.</p>
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const FORMA = { deposito: "DEPÓSITO", boleto: "BOLETO", cheque: "CHEQUE", dinheiro: "DINHEIRO" } as const;

/** Adiantamento de numerário (modelo padrão): o mesmo conteúdo do PDF do servidor. */
function CorpoAdiantamento({ d }: { d: Detalhe }) {
  const a = d.adiantamento!;
  const aprov = d.aprovacoes.filter((x) => x.ciclo === d.ciclo && x.status === "aprovado");
  const linhas: [string, string, string, string][] = [
    ["OBRA (EMPRESA PAGADORA):", (a.obra ?? "—").toUpperCase(), "DATA DO PREENCHIMENTO:", dataBR(a.dataPreenchimento)],
    ["CONTA CAIXA:", a.contaCaixa ?? "—", "CONTA DE PAGAMENTO:", a.contaPagamento ?? "—"],
    ["CENTRO DE CUSTO:", a.centroCusto ?? "—", "CENTRO DE APURAÇÃO:", a.centroApuracao ?? "—"],
    ["VALOR:", moeda(a.valor ?? 0), "Nº:", d.numero],
    ["FAVORECIDO:", (a.favorecido ?? "—").toUpperCase(), "CPF/CNPJ:", docBR(a.favorecidoDoc) || "—"],
    ["FORMA DE PAGAMENTO:", a.formaPagamento ? FORMA[a.formaPagamento] : "—", "PEDIDO:", a.pedidoNumero ?? "—"],
    ...(a.formaPagamento === "deposito"
      ? [["BANCO / AGÊNCIA:", `${a.banco ?? "—"} / ${a.agencia ?? "—"}`, "CONTA / TIPO:", `${a.conta ?? "—"} / ${a.tipoConta === "poupanca" ? "POUPANÇA" : "CORRENTE"}`] as [string, string, string, string]]
      : []),
    ["VENCIMENTO:", dataBR(a.vencimento), "COMPROVAR ATÉ:", dataBR(a.prazoComprovacao)],
    ["FUNCIONÁRIO:", d.solicitante.nome.toUpperCase(), "DEPARTAMENTO:", (d.setor?.nome ?? "—").toUpperCase()],
  ];
  return (
    <>
      <table className="sf-a4__kv">
        <tbody>
          {linhas.map((l) => <tr key={l[0]}><th>{l[0]}</th><td>{l[1]}</td><th>{l[2]}</th><td>{l[3]}</td></tr>)}
          <tr><th>VALOR POR EXTENSO:</th><td colSpan={3}>{a.valor ? valorPorExtenso(a.valor) : "—"}</td></tr>
          <tr><th>FINALIDADE:</th><td colSpan={3}>{(a.finalidade ?? "—").toUpperCase()}</td></tr>
        </tbody>
      </table>
      <table className="sf-a4__tab">
        <thead><tr><th>RATEIO POR TAREFA</th><th>PORCENTAGEM</th><th>VALOR</th></tr></thead>
        <tbody>
          {a.rateio.map((r) => <tr key={r.id}><td>{r.tarefa}</td><td className="n">{String(r.porcentagem).replace(".", ",")}%</td><td className="n">{r.valor.toFixed(2).replace(".", ",")}</td></tr>)}
        </tbody>
      </table>
      <div className="sf-a4__info">
        <p><b>TERMO DE RESPONSABILIDADE:</b> o funcionário assume comprovar este adiantamento com nota fiscal ou recibo até {dataBR(a.prazoComprovacao)}. Sem comprovação no prazo, o gestor é avisado e novos adiantamentos ficam bloqueados. As assinaturas foram substituídas pelo aceite eletrônico e pelas aprovações registradas no Portal.</p>
      </div>
      <div className="sf-a4__aceites">
        <div><b>ACEITE DO FUNCIONÁRIO</b><span>{d.solicitante.nome} · {d.aceiteEm ? new Date(d.aceiteEm).toLocaleString("pt-BR") : "pendente"}</span></div>
        {aprov.map((x) => (
          <div key={x.nivel}><b>APROVAÇÃO · {x.papel.toUpperCase()}</b><span>{x.aprovador ?? x.papel} · {x.decididoEm ? new Date(x.decididoEm).toLocaleString("pt-BR") : ""}</span></div>
        ))}
        {aprov.length === 0 && <div><b>APROVAÇÕES</b><span>pendentes</span></div>}
      </div>
    </>
  );
}
