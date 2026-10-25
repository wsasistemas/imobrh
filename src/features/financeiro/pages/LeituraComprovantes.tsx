import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Clock, Loader2, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ServiceError } from "../../configuracoes/services/types";
import { OcrField } from "../components/Campos";
import { ReceiptViewer } from "../components/ReceiptViewer";
import { leituraService, solicitacoesService, type ComprovanteNaFila, type Detalhe, type Item } from "../solicitacoes";

// Telas 11 e 12 — Adicionar por comprovante: vários arquivos de uma vez, fila de leitura (fila, lendo, lido, ilegível),
// o comprovante ao lado, campos copiados em azul com "copiado · legibilidade NN%" e os motivos sugeridos.
// A leitura só transcreve: campo abaixo de 80% fica vazio para preencher à mão.

const STATUS: Record<ComprovanteNaFila["status"], { rotulo: string; Icone: typeof Clock }> = {
  fila: { rotulo: "Na fila", Icone: Clock },
  lendo: { rotulo: "Lendo…", Icone: Loader2 },
  lido: { rotulo: "Lido · confira e confirme", Icone: CheckCircle2 },
  ilegivel: { rotulo: "Ilegível · preencha à mão", Icone: AlertTriangle },
  erro: { rotulo: "Sem leitura · preencha à mão", Icone: XCircle },
};

export function LeituraComprovantes({ d, onLinha }: { d: Detalhe; onLinha: (item: Item) => void }) {
  const ids = useId();
  const qc = useQueryClient();
  const entrada = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const chave = ["financeiro", "fila-leitura", d.id];
  const fila = useQuery({
    queryKey: chave,
    queryFn: () => leituraService.fila(d.id),
    // Enquanto houver leitura em andamento, confere de novo.
    refetchInterval: (q) => ((q.state.data ?? []).some((x) => x.status === "fila" || x.status === "lendo") ? 2500 : false),
  });
  const lista = fila.data ?? [];
  const atual = lista.find((x) => x.id === sel) ?? lista[0] ?? null;

  const receber = async (arquivos: File[]) => {
    if (!arquivos.length) return;
    setEnviando((n) => n + arquivos.length);
    // Sobe todos e lê dois por vez.
    const enviados: number[] = [];
    for (const f of arquivos) {
      try {
        const r = await leituraService.enviar({ solicitacaoId: d.id, solicitanteId: d.solicitante.id, arquivo: f });
        if (r.duplicadoEm) toast.warning(`${f.name} já foi usado na ${r.duplicadoEm}. O envio fica bloqueado (R06) se ele virar linha.`);
        enviados.push(r.id);
      } catch (e) {
        toast.error(e instanceof ServiceError ? e.message : `Não foi possível enviar ${f.name}.`);
      } finally {
        setEnviando((n) => n - 1);
      }
    }
    void qc.invalidateQueries({ queryKey: chave });
    const fila2 = [...enviados];
    const trabalhador = async () => {
      for (let id = fila2.shift(); id != null; id = fila2.shift()) {
        try {
          const r = await leituraService.ler(id);
          if (r.mensagem) toast.message(r.mensagem);
        } catch (e) {
          toast.error(e instanceof ServiceError ? e.message : "A leitura falhou. Preencha a linha à mão.");
        }
        void qc.invalidateQueries({ queryKey: chave });
      }
    };
    await Promise.all([trabalhador(), trabalhador()]);
  };

  const soltar = (e: DragEvent) => {
    e.preventDefault();
    setArrastando(false);
    void receber([...e.dataTransfer.files]);
  };

  return (
    <section className="card sf-secao" aria-labelledby={`${ids}-t`}>
      <h2 className="sf-secao__t" id={`${ids}-t`}>
        Adicionar por comprovante
        <small>JPG, PNG, WEBP ou PDF até 10 MB · vários de uma vez</small>
      </h2>
      <div
        className={`sf-drop${arrastando ? " sf-drop--sobre" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={soltar}
      >
        <Upload size={28} aria-hidden="true" />
        <div>
          <b>Arraste os comprovantes aqui</b>
          <span>A leitura transcreve data, valor e favorecido exatamente como estão impressos. Campo com legibilidade abaixo de 80% fica vazio para você preencher.</span>
        </div>
        <button type="button" className="btn btn--outline" onClick={() => entrada.current?.click()} disabled={enviando > 0}>
          {enviando > 0 ? `Enviando ${enviando}…` : "Escolher arquivos"}
        </button>
        <input ref={entrada} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" aria-label="Comprovantes"
          onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void receber(fs); }} />
      </div>

      {lista.length > 0 && (
        <div className="sf-leitura">
          <div>
            <span className="field__label">Fila de leitura · {lista.length}</span>
            <ul className="sf-fila">
              {lista.map((x) => {
                const s = STATUS[x.status];
                return (
                  <li key={x.id}>
                    <button type="button" aria-pressed={atual?.id === x.id} className={`sf-fila__item sf-fila__item--${x.status}`} onClick={() => setSel(x.id)}>
                      <s.Icone size={16} aria-hidden="true" className={x.status === "lendo" ? "sf-gira" : undefined} />
                      <span>
                        <b>{x.nome}</b>
                        <small>{s.rotulo}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {atual && <Comprovante key={atual.id} c={atual} d={d} onPronto={(item) => { onLinha(item); void qc.invalidateQueries({ queryKey: chave }); }} />}
        </div>
      )}
    </section>
  );
}

function Comprovante({ c, d, onPronto }: { c: ComprovanteNaFila; d: Detalhe; onPronto: (item: Item) => void }) {
  const ids = useId();
  const qc = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const o = c.ocr && !c.ocr.erro ? c.ocr : null;
  const [data, setData] = useState(o?.data ?? "");
  const [valor, setValor] = useState(o?.valor_total != null ? o.valor_total.toFixed(2).replace(".", ",") : "");
  const [fav, setFav] = useState(o?.favorecido ?? "");
  const sugestoes = (o?.motivo_sugestoes ?? []).filter((s) => d.categorias.some((x) => x.id === s.categoria_id));
  const [cat, setCat] = useState<number | null>(sugestoes[0]?.categoria_id ?? null);
  const [motivo, setMotivo] = useState<string | null>(sugestoes[0]?.texto ?? null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    solicitacoesService.urlAnexo(c.path).then((u) => vivo && setUrl(u), () => undefined);
    return () => { vivo = false; };
  }, [c.path]);

  // Quando a leitura chega depois de abrir o cartão, preenche o que estiver vazio.
  useEffect(() => {
    if (!o) return;
    setData((v) => v || (o.data ?? ""));
    setValor((v) => v || (o.valor_total != null ? o.valor_total.toFixed(2).replace(".", ",") : ""));
    setFav((v) => v || (o.favorecido ?? ""));
    const primeira = o.motivo_sugestoes.find((s) => d.categorias.some((x) => x.id === s.categoria_id));
    if (primeira) {
      setCat((v) => v ?? primeira.categoria_id);
      setMotivo((v) => v ?? primeira.texto);
    }
  }, [o, d.categorias]);

  const leg = (campo: "data" | "valor" | "favorecido") => (o ? o.legibilidade[campo] : null);
  const confirmar = async () => {
    setSalvando(true);
    try {
      const n = valor.trim() ? Number(valor.replace(/\./g, "").replace(",", ".")) : null;
      const item = await leituraService.confirmar({ anexoId: c.id, data: data || null, valor: n, descricao: fav.trim() || null, categoriaId: cat, motivo });
      toast.success("Linha criada a partir do comprovante");
      void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
      onPronto({ id: Number(item), ordem: 0, data: data || null, valor: n, descricao: fav.trim() || null, motivo: motivo ?? d.categorias.find((x) => x.id === cat)?.nome ?? null,
        categoriaId: cat, origem: "ocr_confirmado", statusConferencia: "pendente", anexos: [{ id: c.id, nome: c.nome, path: c.path, mime: c.mime, tamanho: 0 }] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível criar a linha.");
    } finally {
      setSalvando(false);
    }
  };
  const descartar = async () => {
    try {
      await solicitacoesService.removerAnexo(c.id);
      void qc.invalidateQueries({ queryKey: ["financeiro", "fila-leitura", d.id] });
    } catch (e) {
      toast.error(e instanceof ServiceError ? e.message : "Não foi possível descartar.");
    }
  };

  return (
    <div className="sf-comprovante">
      <ReceiptViewer url={url} mime={c.mime} nome={c.nome} />
      <div className="sf-lido">
        {c.status === "ilegivel" && (
          <div className="sf-aviso sf-aviso--w" role="status">
            <b>Comprovante com campos ilegíveis.</b> O que ficou abaixo de 80% de legibilidade não foi copiado. Preencha à mão ou envie outra foto.
          </div>
        )}
        {c.status === "erro" && <div className="sf-aviso sf-aviso--w" role="status">{c.ocr?.erro ?? "Sem leitura automática."} Preencha à mão.</div>}
        {(c.status === "fila" || c.status === "lendo") && <p className="field__help">Lendo o comprovante… você já pode preencher.</p>}
        <span className="field__label">Dados do comprovante</span>
        <div className="sf-lido__campos">
          <OcrField id={`${ids}-d`} rotulo="Data" legibilidade={leg("data")}>
            <input id={`${ids}-d`} className="input" type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </OcrField>
          <OcrField id={`${ids}-v`} rotulo="Valor (R$)" legibilidade={leg("valor")}>
            <input id={`${ids}-v`} className="input sf-num" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value.replace(/[^\d,.]/g, ""))} />
          </OcrField>
          <div className="sf-lido__largo">
            <OcrField id={`${ids}-f`} rotulo={d.tipo === "fundo_fixo" ? "Favorecido" : "Descrição / fornecedor"} legibilidade={leg("favorecido")}>
              <input id={`${ids}-f`} className="input" maxLength={200} value={fav} onChange={(e) => setFav(e.target.value)} />
            </OcrField>
          </div>
          {o?.cnpj_cpf_emissor && <span className="field__help sf-lido__largo">CNPJ/CPF do emissor: {o.cnpj_cpf_emissor}</span>}
        </div>
        <span className="field__label">Motivo / descrição <span className="field__optional">sugestões entre as categorias cadastradas</span></span>
        <div className="sf-sug" role="group" aria-label="Motivo">
          {sugestoes.map((s) => (
            <button key={s.categoria_id} type="button" aria-pressed={cat === s.categoria_id} onClick={() => { setCat(s.categoria_id); setMotivo(s.texto); }}>
              {s.texto} <small>{Math.round(s.confianca * 100)}%</small>
            </button>
          ))}
        </div>
        <select className="input" aria-label="Outra categoria" value={cat ?? ""}
          onChange={(e) => { const x = d.categorias.find((k) => k.id === Number(e.target.value)); setCat(x?.id ?? null); setMotivo(x?.nome ?? null); }}>
          <option value="">{sugestoes.length ? "Ou escolha outra categoria…" : "Escolha a categoria…"}</option>
          {d.categorias.map((k) => <option key={k.id} value={k.id}>{k.nome}</option>)}
        </select>
        {(o?.alertas ?? []).length > 0 && <p className="field__help">Alertas da leitura: {o!.alertas.join(", ")}</p>}
        <div className="sf-linha-acoes">
          <button type="button" className="btn btn--primary" disabled={salvando} onClick={() => void confirmar()}>
            <Check size={16} aria-hidden="true" />
            Confirmar e criar linha
          </button>
          <button type="button" className="btn btn--outline" onClick={() => void descartar()}>
            <Trash2 size={15} aria-hidden="true" />
            Descartar arquivo
          </button>
        </div>
      </div>
    </div>
  );
}
