import { FileText, FileUp } from "lucide-react";
import { Link } from "react-router";
import { valorPorExtenso } from "../../../../supabase/functions/_shared/sf/adiantamento.ts";
import { moeda } from "../cadeia";
import type { EtapaTimeline } from "../components/ApprovalTimeline";
import { FormSection } from "../components/Campos";
import type { Detalhe } from "../solicitacoes";
import { abrirAnexo, Ro } from "./comuns";
import { dataBR, docBR } from "./formato";

// Tela 14 — detalhe do adiantamento: dados no layout do formulário, prévias do pedido/e-mail e, na linha do tempo,
// Planejamento → Gerente → Diretor → Presidente (não exigidos tracejados) → Conferência → Lançamento → Pagamento no
// vencimento → Comprovação → Encerrado.

const FORMA = { deposito: "Depósito", boleto: "Boleto", cheque: "Cheque", dinheiro: "Dinheiro" } as const;

export function DadosAdiantamento({ d }: { d: Detalhe }) {
  const a = d.adiantamento!;
  const tarefas = a.rateio.map((r) => `${r.tarefa} (${String(r.porcentagem).replace(".", ",")}%)`).join(", ");
  const pagamento = a.formaPagamento === "deposito"
    ? `Depósito · ${[a.banco, [a.agencia, a.conta].filter(Boolean).join(" / ")].filter(Boolean).join(" ")} · ${a.tipoConta === "poupanca" ? "poupança" : "corrente"}`
    : a.formaPagamento ? FORMA[a.formaPagamento] : "—";
  return (
    <>
      <FormSection titulo="Dados do formulário">
        <div className="sf-campos">
          <Ro rotulo="Obra (empresa pagadora)" valor={a.obra ?? "—"} />
          <Ro rotulo="Valor" valor={moeda(a.valor ?? 0)} />
          <Ro rotulo="Favorecido" valor={a.favorecido ?? "—"} />
          <Ro rotulo="CPF/CNPJ" valor={docBR(a.favorecidoDoc) || "—"} />
          <Ro rotulo="Conta caixa · conta de pagamento" valor={`${a.contaCaixa ?? "—"} · ${a.contaPagamento ?? "—"}`} />
          <Ro rotulo="Centro de custo · tarefa" valor={`${a.centroCusto ?? "—"} · ${tarefas || "—"}`} />
          <Ro rotulo="Forma de pagamento" valor={pagamento} />
          <Ro rotulo="Vencimento · comprovação até" valor={`${dataBR(a.vencimento)} · ${dataBR(a.prazoComprovacao)}`} />
          {a.pedidoNumero && <Ro rotulo="Pedido" valor={`${a.pedidoNumero}${a.pedidoValor ? ` · ${moeda(a.pedidoValor)}` : ""}${a.pedidoCondicao ? ` · ${a.pedidoCondicao}` : ""}`} />}
          <div className="sf-campo-todo"><Ro rotulo="Finalidade" valor={a.finalidade ?? "—"} /></div>
          {a.valor ? <div className="sf-campo-todo"><Ro rotulo="Valor por extenso" valor={valorPorExtenso(a.valor)} /></div> : null}
        </div>
      </FormSection>
      <FormSection titulo="Anexos">
        <div className="sf-previas">
          {a.documentos.map((x) => (
            <button key={x.id} type="button" className="sf-previa-doc" onClick={() => void abrirAnexo({ id: x.id, nome: x.nome, path: x.path, mime: x.mime, tamanho: 0 })}>
              <span className="sf-previa-doc__folha" aria-hidden="true"><FileText size={26} /></span>
              <span className="sf-previa-doc__leg">{x.nome}</span>
            </button>
          ))}
          {a.documentos.length === 0 && <p className="field__help">Sem documento de origem.</p>}
        </div>
      </FormSection>
    </>
  );
}

/** Aviso ao solicitante depois do pagamento: comprovar, devolução pendente ou encerrado. */
export function AvisoComprovacao({ d }: { d: Detalhe }) {
  const a = d.adiantamento!;
  const ehSolicitante = a.ehSolicitante;
  const c = a.comprovacoes[0];
  if (d.status === "comprovacao_pendente") {
    const dias = a.prazoComprovacao ? Math.round((Date.parse(`${a.prazoComprovacao}T12:00:00`) - Date.now()) / 86_400_000) : null;
    return (
      <div className={`sf-aviso ${dias != null && dias < 0 ? "sf-aviso--e" : "sf-aviso--w"} sf-aviso--acao`} role="status">
        <div>
          <b>{dias != null && dias < 0 ? "Comprovação vencida" : "Comprovação pendente"}</b> · prazo {dataBR(a.prazoComprovacao)}
          {c?.status === "ajuste" && <> · o Financeiro pediu ajuste: {c.obs}</>}
          {dias != null && dias < 0 && <> · novos adiantamentos ficam bloqueados até a comprovação.</>}
        </div>
        {ehSolicitante && (
          <Link className="btn btn--primary" to={`/financeiro/solicitacoes/${d.id}/comprovacao`}>
            <FileUp size={16} aria-hidden="true" />
            Enviar comprovação
          </Link>
        )}
      </div>
    );
  }
  if (d.status === "devolucao_pendente" && c) {
    return <div className="sf-aviso sf-aviso--e" role="status"><b>Devolução pendente: {moeda(c.saldoDevolver)}</b> · a nota ({moeda(c.valor)}) ficou abaixo do adiantado. Devolva a diferença ao Financeiro.</div>;
  }
  if (d.status === "encerrada" && c) {
    return <div className="sf-aviso sf-aviso--s" role="status"><b>Adiantamento comprovado</b> · nota de {moeda(c.valor)}{c.saldoPagar > 0 ? ` · saldo do pedido ${moeda(c.saldoPagar)} lançado contra a nota` : ""}.</div>;
  }
  if (d.status === "comprovacao_em_conferencia" && c) {
    return <div className="sf-aviso sf-aviso--w" role="status"><b>Comprovação em conferência</b> · nota de {moeda(c.valor)} enviada em {new Date(c.criadoEm).toLocaleString("pt-BR")}.</div>;
  }
  return null;
}

const ROTULO_APROVACAO: Record<string, string> = { aprovado: "aprovou", devolvido: "devolveu", reprovado: "reprovou" };
const ORDEM = ["em_conferencia", "pendencia_solicitante", "lancamento_gerado", "pagamento_programado", "paga", "comprovacao_pendente", "comprovacao_em_conferencia", "devolucao_pendente", "encerrada"];

/** Linha do tempo do adiantamento: de Enviado até Encerrado. */
export function linhaDoTempoAdiantamento(d: Detalhe): EtapaTimeline[] {
  const a = d.adiantamento!;
  const ciclo = d.aprovacoes.filter((x) => x.ciclo === d.ciclo);
  const pos = ORDEM.indexOf(d.status);
  const passou = (s: string) => pos >= 0 && pos >= ORDEM.indexOf(s);
  const c = a.comprovacoes[0];
  return [
    { chave: "env", titulo: "Enviado", detalhe: d.enviadoEm ? `${d.solicitante.nome} · ${new Date(d.enviadoEm).toLocaleString("pt-BR")} · aceite registrado` : undefined, estado: d.enviadoEm ? "feito" : "futuro" },
    ...ciclo.map((x): EtapaTimeline => ({
      chave: `a${x.nivel}`,
      titulo: x.papel.charAt(0).toUpperCase() + x.papel.slice(1),
      detalhe:
        x.status === "nao_exigido" ? "Não exigido para este valor"
        : x.status === "pulado" ? "Etapa do próprio solicitante: pulada"
        : x.decididoEm ? `${x.aprovador ?? ""} ${ROTULO_APROVACAO[x.status] ?? ""} · ${new Date(x.decididoEm).toLocaleString("pt-BR")}`
        : `${x.aprovador ?? ""}${x.prazoEm ? ` · prazo ${new Date(x.prazoEm).toLocaleString("pt-BR")}` : ""}`,
      estado: x.status === "aprovado" ? "feito" : x.status === "aguardando" ? "atual" : x.status === "devolvido" ? "devolvido" : x.status === "nao_exigido" || x.status === "pulado" ? "nao_exigido" : "futuro",
      comentario: x.comentario,
    })),
    { chave: "conf", titulo: "Conferência financeira", estado: passou("lancamento_gerado") ? "feito" : d.status === "em_conferencia" || d.status === "pendencia_solicitante" ? "atual" : "futuro" },
    { chave: "lanc", titulo: "Lançamento SIENGE", estado: passou("pagamento_programado") ? "feito" : d.status === "lancamento_gerado" ? "atual" : "futuro" },
    { chave: "pag", titulo: "Pagamento no vencimento", detalhe: a.pagoEm ? `pago em ${new Date(a.pagoEm).toLocaleDateString("pt-BR")}` : dataBR(a.vencimento), estado: passou("paga") ? "feito" : d.status === "pagamento_programado" ? "atual" : "futuro" },
    {
      chave: "comp", titulo: "Comprovação",
      detalhe: c && passou("comprovacao_em_conferencia") ? `nota de ${moeda(c.valor)}${c.saldoDevolver > 0 ? ` · devolver ${moeda(c.saldoDevolver)}` : ""}` : `até ${dataBR(a.prazoComprovacao)}`,
      estado: d.status === "encerrada" ? "feito" : ["comprovacao_pendente", "comprovacao_em_conferencia", "devolucao_pendente"].includes(d.status) ? "atual" : "futuro",
    },
    { chave: "fim", titulo: "Encerrado", estado: d.status === "encerrada" ? "feito" : "futuro" },
  ];
}
