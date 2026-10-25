import { CheckCircle2, Clock, CornerUpLeft, Eye, HardDrive, TriangleAlert, XCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { NotFound } from "../../../pages/NotFound";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { moeda } from "../cadeia";
import { ConferenciaComprovacao } from "../components/ConferenciaComprovacao";
import { FormPreview } from "../components/FormPreview";
import { LancamentoSienge } from "../components/LancamentoSienge";
import { ReceiptViewer } from "../components/ReceiptViewer";
import { StatusChip } from "../components/StatusChip";
import type { DecisaoItem, ItemConferencia } from "../conferencia";
import { useConferencia, useDecidirItem, useMarcarPaga, usePedirAjuste, useProgramarPagamento, useSituacaoSienge, useSolicitacao } from "../hooks";
import { solicitacoesService, type Detalhe } from "../solicitacoes";
import { dataBR, docBR, NOME_TIPO } from "./formato";
import "../../atendimento/pages/Atendimento.css";
import "../financeiro.css";

// Tela 9 — Conferência item a item (/financeiro/conferencia/:id): itens com status, visualizador do comprovante,
// Declarado × comprovante, regras de aceitação e decisão por item. "Concluir e gerar lançamento SIENGE" só com todos os
// itens resolvidos (aceito ou glosado); valor a pagar = total − glosas. Adiantamento (Fase 5B): a linha única é o valor,
// com o documento de origem e a A04 (titularidade bancária); depois do pagamento, a tela confere a comprovação.

const ICONE = { pendente: Clock, aceito: CheckCircle2, glosado: XCircle, ajuste: CornerUpLeft } as const;
const ROTULO = { pendente: "pendente", aceito: "aceito", glosado: "glosado", ajuste: "ajuste pedido" } as const;

export function ConferenciaPagina() {
  const { id } = useParams();
  const n = Number(id);
  const d = useSolicitacao(n);
  const c = useConferencia(n);
  if (!Number.isInteger(n) || n <= 0) return <NotFound />;
  if (d.isPending || c.isPending) return <PageSkeleton />;
  if (d.isError || c.isError) return <ErrorState message="Não foi possível abrir a conferência." onRetry={() => { void d.refetch(); void c.refetch(); }} />;
  return <Tela d={d.data} itens={c.data.itens} podeConferir={c.data.podeConferir} gerais={c.data.gerais} />;
}

const FASE_COMPROVACAO = ["comprovacao_pendente", "comprovacao_em_conferencia", "devolucao_pendente", "encerrada"];

function Tela({ d, itens, podeConferir, gerais: todas }: { d: Detalhe; itens: ItemConferencia[]; podeConferir: boolean; gerais: { codigo: string; resultado?: string; detalhe: string }[] }) {
  const gerais = todas.filter((g) => g.resultado !== "ok");
  const ad = d.tipo === "adiantamento" ? d.adiantamento : undefined;
  const [sel, setSel] = useState<number | null>(itens.find((i) => i.status === "pendente")?.id ?? itens[0]?.id ?? null);
  const [preview, setPreview] = useState(false);
  const atual = itens.find((i) => i.id === sel) ?? itens[0];
  const resolvidos = itens.filter((i) => i.status === "aceito" || i.status === "glosado").length;
  const ajustes = itens.filter((i) => i.status === "ajuste").length;
  const glosas = itens.reduce((s, i) => s + i.valorGlosado, 0);

  return (
    <>
      <div className="sf-ph">
        <div>
          <div className="sf-eyebrow">{NOME_TIPO[d.tipo]} · {d.solicitante.nome} · {d.setor?.nome ?? "Sem setor"}</div>
          <h2 className="sf-ph__t">Conferência {d.numero} <StatusChip status={d.status} /></h2>
          <p className="sf-ph__s">{ad ? `Vencimento ${dataBR(ad.vencimento)} · comprovação até ${dataBR(ad.prazoComprovacao)}` : `Pagar até ${dataBR(d.pagarAte)}`}{d.aprovacoes.length ? ` · aprovada por ${d.aprovacoes.filter((a) => a.status === "aprovado" && a.ciclo === d.ciclo).map((a) => a.aprovador).join(", ")}` : ""}</p>
        </div>
        <div className="sf-ph__acoes">
          <button type="button" className="btn btn--outline" onClick={() => setPreview(true)}><Eye size={16} aria-hidden="true" />Preview do formulário</button>
        </div>
      </div>
      {gerais.length > 0 && (
        <div className="sf-aviso sf-aviso--w" role="status">{gerais.map((g) => `${g.codigo}: ${g.detalhe}`).join(" · ")}</div>
      )}

      {ad && FASE_COMPROVACAO.includes(d.status) ? (
        <ConferenciaComprovacao d={d} podeConferir />
      ) : (<>
      {ad && (
        <section className="card sf-painel sf-a04" aria-label="Pagamento do adiantamento">
          <h3>Pagamento do adiantamento</h3>
          <p>
            <b>{ad.favorecido}</b> · {docBR(ad.favorecidoDoc)} · {ad.formaPagamento === "deposito" ? `depósito ${ad.banco ?? ""} ag. ${ad.agencia ?? "—"} conta ${ad.conta ?? "—"} (${ad.tipoConta === "poupanca" ? "poupança" : "corrente"})` : ad.formaPagamento ?? "—"}
            {" · "}rateio {ad.rateio.map((r) => `${r.tarefa} ${String(r.porcentagem).replace(".", ",")}%`).join(", ")}
          </p>
          <p className="field__help"><span className="sf-chip sf-chip--aviso">A04</span> Confira se a conta pertence ao CPF/CNPJ do favorecido antes de aceitar.</p>
        </section>
      )}
      <div className="sf-conf">
        <section className="card sf-painel" aria-label="Itens">
          <h3>Itens · {itens.length}</h3>
          <ul className="sf-fila">
            {itens.map((i) => {
              const Icone = ICONE[i.status];
              const alerta = i.regras.some((r) => r.resultado !== "ok");
              return (
                <li key={i.id}>
                  <button type="button" aria-pressed={atual?.id === i.id} className={`sf-fila__item sf-fila__item--${i.status}`} onClick={() => setSel(i.id)}>
                    {alerta && i.status === "pendente" ? <TriangleAlert size={16} aria-hidden="true" className="sf-ic-alerta" /> : <Icone size={16} aria-hidden="true" />}
                    <span>
                      <b>{i.ordem} · {i.descricao ?? "—"}</b>
                      <small>{moeda(i.valor)} · {ROTULO[i.status]}{alerta && i.status === "pendente" ? " · com alerta" : ""}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {atual && <Item key={atual.id} item={atual} podeConferir={podeConferir} />}
      </div>

      <Rodape d={d} podeConferir={podeConferir} resolvidos={resolvidos} total={itens.length} ajustes={ajustes} glosas={glosas} />
      </>)}
      <FormPreview d={d} aberto={preview} onFechar={() => setPreview(false)} />
    </>
  );
}

function Item({ item, podeConferir }: { item: ItemConferencia; podeConferir: boolean }) {
  const ids = useId();
  const decidir = useDecidirItem();
  const anexo = item.anexos[0];
  const [url, setUrl] = useState<string | null>(null);
  const [decisao, setDecisao] = useState<DecisaoItem>(item.status === "glosado" ? "glosar" : item.status === "ajuste" ? "ajuste" : "aceitar");
  const [glosa, setGlosa] = useState(item.valorGlosado ? item.valorGlosado.toFixed(2).replace(".", ",") : "");
  const [obs, setObs] = useState(item.obs ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const lido = anexo?.ocr && !anexo.ocr.erro ? anexo.ocr : null;
  const alerta = item.regras.some((r) => r.resultado !== "ok");

  useEffect(() => {
    if (!anexo) return;
    let vivo = true;
    solicitacoesService.urlAnexo(anexo.path).then((u) => vivo && setUrl(u), () => undefined);
    return () => { vivo = false; };
  }, [anexo]);

  const salvar = () => {
    setErro(null);
    const v = glosa.trim() ? Number(glosa.replace(/\./g, "").replace(",", ".")) : null;
    decidir.mutate(
      { itemId: item.id, decisao, valorGlosa: decisao === "glosar" ? v : null, obs: obs.trim() || null },
      { onSuccess: () => toast.success(`Item ${item.ordem}: decisão salva`), onError: (e) => setErro(e instanceof ServiceError ? e.message : "Não foi possível salvar.") },
    );
  };
  const difere = (a: unknown, b: unknown) => a != null && b != null && String(a).toLowerCase() !== String(b).toLowerCase();

  return (
    <>
      {anexo ? <ReceiptViewer url={url} mime={anexo.mime} nome={anexo.nome} /> : <div className="sf-viewer"><div className="sf-viewer__palco"><span className="sf-viewer__msg">Sem comprovante</span></div></div>}
      <div className="sf-coluna">
        <section className="card sf-painel" aria-labelledby={`${ids}-dc`}>
          <h3 id={`${ids}-dc`}>Declarado × comprovante</h3>
          <table className="at-tab sf-dxc">
            <thead><tr><th /><th>Declarado</th><th>Comprovante</th></tr></thead>
            <tbody>
              <tr><th>Data</th><td>{dataBR(item.data)}</td><td className={difere(item.data, lido?.data) ? "sf-dif" : undefined}>{dataBR(lido?.data)}</td></tr>
              <tr><th>Valor</th><td>{moeda(item.valor)}</td><td className={lido?.valor_total != null && Math.abs(lido.valor_total - item.valor) > 0.009 ? "sf-dif" : undefined}>
                {lido?.valor_total != null ? `${moeda(lido.valor_total)}${Math.abs(lido.valor_total - item.valor) > 0.009 ? ` (${(lido.valor_total - item.valor).toFixed(2).replace(".", ",")})` : ""}` : "—"}</td></tr>
              <tr><th>Favorecido</th><td>{item.descricao}</td><td>{lido?.favorecido ?? "—"}</td></tr>
              <tr><th>Documento</th><td>—</td><td>{lido ? `${lido.tipo_documento.toUpperCase()}${lido.cnpj_cpf_emissor ? ` · ${lido.cnpj_cpf_emissor}` : ""}` : "—"}</td></tr>
              <tr><th>Motivo</th><td colSpan={2}>{item.motivo ?? "—"} · origem: {item.origem.replace("_", " ")}</td></tr>
            </tbody>
          </table>
        </section>
        <section className="card sf-painel" aria-labelledby={`${ids}-rg`}>
          <h3 id={`${ids}-rg`}>Regras de aceitação</h3>
          <ul className="sf-regras">
            {item.regras.map((r, k) => (
              <li key={k}><span className="sf-regras__cod">{r.codigo}</span><span>{r.detalhe}</span>
                <span className={`sf-chip ${r.resultado === "bloqueio" ? "sf-chip--erro" : "sf-chip--aviso"}`}>{r.resultado === "bloqueio" ? "Bloqueio" : "Alerta"}</span></li>
            ))}
            {item.regras.length === 0 && <li><span className="sf-regras__cod">—</span><span>Sem alertas para este item</span><span className="sf-chip sf-chip--ok">OK</span></li>}
          </ul>
        </section>
        <section className="card sf-painel" aria-labelledby={`${ids}-de`}>
          <h3 id={`${ids}-de`}>Decisão do item {item.ordem}</h3>
          <div className="sf-seg" role="group" aria-label="Decisão">
            {(["aceitar", "ajuste", "glosar"] as const).map((x) => (
              <button key={x} type="button" aria-pressed={decisao === x} disabled={!podeConferir} onClick={() => setDecisao(x)}>
                {x === "aceitar" ? "Aceitar" : x === "ajuste" ? "Pedir ajuste" : "Glosar"}
              </button>
            ))}
          </div>
          {decisao === "glosar" && (
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-g`}>Valor glosado (R$)</label>
              <input id={`${ids}-g`} className="input sf-num" inputMode="decimal" value={glosa} disabled={!podeConferir} onChange={(e) => setGlosa(e.target.value.replace(/[^\d,.]/g, ""))} />
            </div>
          )}
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-o`}>
              Observação {decisao !== "aceitar" || alerta ? <span className="field__optional">(obrigatória{decisao === "aceitar" ? " com alerta" : ""})</span> : <span className="field__optional">(opcional)</span>}
            </label>
            <textarea id={`${ids}-o`} className="input" rows={3} maxLength={1000} value={obs} disabled={!podeConferir} onChange={(e) => setObs(e.target.value)} />
          </div>
          {erro && <p className="field__error" role="alert">{erro}</p>}
          {podeConferir && <button type="button" className="btn btn--primary" disabled={decidir.isPending} onClick={salvar}>Salvar decisão</button>}
        </section>
      </div>
    </>
  );
}

function Rodape({ d, podeConferir, resolvidos, total, ajustes, glosas }: { d: Detalhe; podeConferir: boolean; resolvidos: number; total: number; ajustes: number; glosas: number }) {
  const ids = useId();
  const ajuste = usePedirAjuste();
  const programar = useProgramarPagamento();
  const pagar = useMarcarPaga();
  const [comentario, setComentario] = useState("");
  const [dataPg, setDataPg] = useState(d.pagarAte ?? new Date().toISOString().slice(0, 10));
  const err = (e: unknown, padrao: string) => toast.error(e instanceof ServiceError ? e.message : padrao);
  const pendentes = total - resolvidos - ajustes;
  const sit = useSituacaoSienge(d.id);
  const [lancar, setLancar] = useState(false);
  const pronto = resolvidos === total && total > 0;

  return (
    <section className="card sf-decisao" aria-label="Conclusão">
      {sit.data?.erro && <p className="field__error sf-decisao__campo" role="alert">Último lançamento falhou: {sit.data.erro}</p>}
      {sit.data?.titulo && <p className="sf-decisao__campo">Título no SIENGE: <b>{sit.data.titulo}</b>{sit.data.ambiente === "homologacao" ? " (homologação)" : ""}</p>}
      <div className="sf-decisao__totais">
        <span>Total <b>{moeda(d.totalDespesas)}</b></span>
        <span>Glosas <b className="sf-txt-erro">− {moeda(glosas)}</b></span>
        <span>Valor a pagar <b>{moeda(d.totalDespesas - glosas)}</b></span>
        {podeConferir && <span className={`sf-chip ${pendentes + ajustes > 0 ? "sf-chip--aviso" : "sf-chip--ok"}`}>{pendentes + ajustes > 0 ? `${pendentes + ajustes} item(ns) sem resolver` : "Todos os itens resolvidos"}</span>}
      </div>
      {podeConferir && ajustes > 0 && (
        <div className="field sf-decisao__campo">
          <label className="field__label" htmlFor={`${ids}-c`}>Mensagem ao solicitante ({ajustes} item(ns) com ajuste pedido)</label>
          <textarea id={`${ids}-c`} className="input" rows={2} maxLength={2000} value={comentario} onChange={(e) => setComentario(e.target.value)} />
        </div>
      )}
      <div className="sf-decisao__botoes">
        {podeConferir && (
          <>
            <button type="button" className="btn sf-btn-devolver" disabled={ajustes === 0 || ajuste.isPending}
              onClick={() => ajuste.mutate({ id: d.id, comentario }, { onSuccess: () => toast.success("Devolvida ao solicitante para ajuste"), onError: (e) => err(e, "Não foi possível devolver.") })}>
              <CornerUpLeft size={16} aria-hidden="true" />
              Devolver ao solicitante
            </button>
            <button type="button" className="btn btn--primary" disabled={!pronto || !sit.data?.configurada || sit.data?.status === "lancando"}
              title={!pronto ? "Resolva todos os itens (aceitar ou glosar)" : !sit.data?.configurada ? "Ative a integração em Configurações › Integrações › SIENGE" : undefined}
              onClick={() => setLancar(true)}>
              <HardDrive size={16} aria-hidden="true" />
              Lançamento no SIENGE
            </button>
          </>
        )}
        {d.status === "lancamento_gerado" && (
          <>
            <input className="input" type="date" aria-label="Data do pagamento" value={dataPg} onChange={(e) => setDataPg(e.target.value)} />
            <button type="button" className="btn btn--primary" disabled={programar.isPending}
              onClick={() => programar.mutate({ id: d.id, data: dataPg }, { onSuccess: () => toast.success("Pagamento programado"), onError: (e) => err(e, "Não foi possível programar.") })}>
              Programar pagamento
            </button>
          </>
        )}
        {d.status === "pagamento_programado" && (
          <button type="button" className="btn sf-btn-aprovar" disabled={pagar.isPending}
            onClick={() => pagar.mutate(d.id, { onSuccess: () => toast.success("Marcada como paga"), onError: (e) => err(e, "Não foi possível marcar como paga.") })}>
            Marcar como paga
          </button>
        )}
      </div>
      <LancamentoSienge d={d} aberto={lancar} onFechar={() => setLancar(false)} />
    </section>
  );
}
