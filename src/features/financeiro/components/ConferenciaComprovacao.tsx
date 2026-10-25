import { CheckCircle2, CornerUpLeft, HardDrive } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ServiceError } from "../../configuracoes/services/types";
import { moeda } from "../cadeia";
import { useConfirmarDevolucao, useDecidirComprovacao, useSituacaoSienge } from "../hooks";
import { dataBR, docBR } from "../pages/formato";
import { solicitacoesService, type Detalhe } from "../solicitacoes";
import { LancamentoSienge } from "./LancamentoSienge";
import { ReceiptViewer } from "./ReceiptViewer";

// Conferência da comprovação do adiantamento (tela 9 no modo comprovação, RF-14 item 4): a nota ao lado, declarado ×
// nota, regra A07, acerto e a decisão (aceitar ou pedir ajuste). Devolução pendente: confirmar o recebimento.
// Comprovado com nota maior: lançar o saldo do pedido contra a nota no SIENGE (título SF-…-S).

export function ConferenciaComprovacao({ d, podeConferir }: { d: Detalhe; podeConferir: boolean }) {
  const ids = useId();
  const a = d.adiantamento!;
  const c = a.comprovacoes[0];
  const arq = c ? a.arquivosComprovacao.find((x) => x.id === c.anexoId) : undefined;
  const [url, setUrl] = useState<string | null>(null);
  const [obs, setObs] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [lancar, setLancar] = useState(false);
  const decidir = useDecidirComprovacao();
  const devolver = useConfirmarDevolucao();
  const sit = useSituacaoSienge(d.id);

  useEffect(() => {
    if (!arq) return;
    let vivo = true;
    solicitacoesService.urlAnexo(arq.path).then((u) => vivo && setUrl(u), () => undefined);
    return () => { vivo = false; };
  }, [arq]);

  if (d.status === "comprovacao_pendente" || !c) {
    return (
      <section className="card sf-painel">
        <h3>Comprovação</h3>
        <p className="field__help">Aguardando o colaborador enviar a nota fiscal ou o recibo até {dataBR(a.prazoComprovacao)}.{a.statusComprovacao === "vencida" ? " O prazo venceu: novos adiantamentos dele estão bloqueados." : ""}</p>
      </section>
    );
  }

  const alerta = a.checagensComprovacao.some((r) => r.resultado !== "ok");
  const emConferencia = d.status === "comprovacao_em_conferencia" && podeConferir;
  const agir = (decisao: "aceitar" | "ajuste") => {
    setErro(null);
    decidir.mutate({ id: d.id, decisao, obs: obs.trim() || null }, {
      onSuccess: (r) => toast.success(decisao === "ajuste" ? "Devolvida ao colaborador para ajuste" : r.status === "encerrada" ? "Comprovação aceita: adiantamento encerrado" : "Comprovação aceita: devolução pendente"),
      onError: (e) => setErro(e instanceof ServiceError ? e.message : "Não foi possível registrar a decisão."),
    });
  };
  const dif = (x: unknown, y: unknown) => x != null && y != null && String(x) !== String(y);

  return (
    <div className="sf-conf sf-conf--comp">
      <ReceiptViewer url={url} mime={arq?.mime ?? "application/pdf"} nome={arq?.nome ?? "nota"} />
      <div className="sf-coluna">
        <section className="card sf-painel" aria-labelledby={`${ids}-dc`}>
          <h3 id={`${ids}-dc`}>Adiantamento × nota</h3>
          <table className="at-tab sf-dxc">
            <thead><tr><th /><th>Adiantamento</th><th>Nota</th></tr></thead>
            <tbody>
              <tr><th>Favorecido</th><td>{a.favorecido}<br /><small>{docBR(a.favorecidoDoc)}</small></td><td className={dif(a.favorecidoDoc, c.emitenteDoc) ? "sf-dif" : undefined}>{c.emitente ?? "—"}<br /><small>{docBR(c.emitenteDoc)}</small></td></tr>
              <tr><th>Data</th><td>pago em {a.pagoEm ? new Date(a.pagoEm).toLocaleDateString("pt-BR") : "—"}</td><td>emissão {dataBR(c.emissao)}</td></tr>
              <tr><th>Valor</th><td>{moeda(a.valor ?? 0)}</td><td className={c.valor < (a.valor ?? 0) ? "sf-dif" : undefined}>{moeda(c.valor)}</td></tr>
              <tr><th>Documento</th><td>Pedido {a.pedidoNumero ?? "—"}</td><td>{(c.tipoDocumento ?? "").toUpperCase()} {c.numero ?? ""}{c.referencia ? ` · ${c.referencia}` : ""}</td></tr>
            </tbody>
          </table>
        </section>
        <section className="card sf-painel" aria-labelledby={`${ids}-a7`}>
          <h3 id={`${ids}-a7`}>Regra A07</h3>
          <ul className="sf-regras">
            {a.checagensComprovacao.map((r, i) => (
              <li key={i}><span className="sf-regras__cod">{r.codigo}</span><span>{r.detalhe}</span>
                <span className={`sf-chip ${r.resultado === "ok" ? "sf-chip--ok" : "sf-chip--aviso"}`}>{r.resultado === "ok" ? "OK" : "Alerta"}</span></li>
            ))}
          </ul>
        </section>
        <section className="card sf-painel" aria-labelledby={`${ids}-ac`}>
          <h3 id={`${ids}-ac`}>Acerto</h3>
          <div className="sf-decisao__totais">
            <span>Adiantado <b>{moeda(a.valor ?? 0)}</b></span>
            <span>Comprovado <b>{moeda(c.valor)}</b></span>
            {c.saldoDevolver > 0 ? <span>A devolver <b className="sf-txt-erro">{moeda(c.saldoDevolver)}</b></span> : <span>Saldo do pedido contra a nota <b>{moeda(c.saldoPagar)}</b></span>}
          </div>
          {c.obs && <p className="field__help">Observação: {c.obs}</p>}
          {emConferencia && (
            <>
              <div className="field">
                <label className="field__label" htmlFor={`${ids}-o`}>Observação <span className="field__optional">({alerta ? "obrigatória: há alerta" : "obrigatória para pedir ajuste"})</span></label>
                <textarea id={`${ids}-o`} className="input" rows={2} maxLength={1000} value={obs} onChange={(e) => setObs(e.target.value)} />
              </div>
              {erro && <p className="field__error" role="alert">{erro}</p>}
              <div className="sf-decisao__botoes">
                <button type="button" className="btn sf-btn-devolver" disabled={decidir.isPending} onClick={() => agir("ajuste")}>
                  <CornerUpLeft size={16} aria-hidden="true" />
                  Pedir ajuste
                </button>
                <button type="button" className="btn sf-btn-aprovar" disabled={decidir.isPending} onClick={() => agir("aceitar")}>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {c.valor >= (a.valor ?? 0) ? "Aceitar e encerrar" : "Aceitar (gera devolução)"}
                </button>
              </div>
            </>
          )}
          {d.status === "devolucao_pendente" && podeConferir && (
            <div className="sf-decisao__botoes">
              <button type="button" className="btn sf-btn-aprovar" disabled={devolver.isPending}
                onClick={() => devolver.mutate({ id: d.id, obs: obs.trim() || null }, { onSuccess: () => toast.success("Devolução registrada: adiantamento encerrado"), onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível registrar.") })}>
                <CheckCircle2 size={16} aria-hidden="true" />
                Confirmar devolução recebida ({moeda(c.saldoDevolver)})
              </button>
            </div>
          )}
          {d.status === "encerrada" && c.saldoPagar > 0 && (
            a.siengeSaldoId ? <p className="sf-decisao__campo">Saldo lançado no SIENGE: título <b>{a.siengeSaldoId}</b>.</p> : podeConferir && (
              <>
                {a.siengeSaldoErro && <p className="field__error" role="alert">Último lançamento do saldo falhou: {a.siengeSaldoErro}</p>}
                <div className="sf-decisao__botoes">
                  <button type="button" className="btn btn--primary" disabled={!sit.data?.configurada} title={!sit.data?.configurada ? "Ative a integração em Configurações › Integrações › SIENGE" : undefined} onClick={() => setLancar(true)}>
                    <HardDrive size={16} aria-hidden="true" />
                    Lançar saldo do pedido no SIENGE
                  </button>
                </div>
              </>
            )
          )}
        </section>
      </div>
      <LancamentoSienge d={d} aberto={lancar} onFechar={() => setLancar(false)} saldo={c.saldoPagar} />
    </div>
  );
}
