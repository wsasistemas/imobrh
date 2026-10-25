import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, Camera, Check, CloudOff, Paperclip, Receipt, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ServiceError } from "../../configuracoes/services/types";
import { STATUS } from "../../financeiro/components/StatusChip";
import { leituraService, solicitacoesService, type Detalhe, type LeituraOcr, type LinhaLista } from "../../financeiro/solicitacoes";
import { Carregando, SubCabecalho, useCd } from "../SolicitanteApp";
import { ehFalhaDeRede, faltaNaLinha, novaChave, novoRascunhoLocal, rascunhosLocais, sincronizar, totalLocal, type LinhaLocal, type RascunhoLocal, type TipoApp } from "./offline";

// Solicitações Financeiras no App do solicitante (Fase 6; telas 4 e 12 do mockup): /app/financeiro. Mesmas regras do portal
// (as RPCs são as mesmas). Sem rede, o rascunho fica no aparelho e sobe quando a rede volta. O comprovante é
// fotografado pela câmera; com rede, a leitura copia data, valor e favorecido e sugere o motivo.

const NOME: Record<string, string> = { reembolso: "Reembolso", fundo_fixo: "Fundo fixo", adiantamento: "Adiantamento" };
const TOM_CD: Record<string, string> = { neutro: "cancelado", aviso: "pendente", roxo: "roxo", info: "novo", ok: "resolvido", erro: "erro" };
const CATEGORIAS_KEY = "solicitante-sf-categorias";
const CATEGORIAS_PADRAO = ["Material de obra", "Ferramentas", "EPI", "Combustível", "Transporte", "Estacionamento", "Alimentação", "Copa/mantimentos", "Material de escritório", "Outros"];

const moeda = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataBR = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const msg = (e: unknown, padrao: string) => (e instanceof ServiceError ? e.message : padrao);

function Chip({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return <span className={`cd-st cd-st--${TOM_CD[s.tom]}`}>{s.rotulo}</span>;
}

/** Rede do aparelho (eventos online/offline). */
function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    window.addEventListener("online", a);
    window.addEventListener("offline", b);
    return () => {
      window.removeEventListener("online", a);
      window.removeEventListener("offline", b);
    };
  }, []);
  return on;
}

function lerCategorias(): { id: number | null; nome: string }[] {
  try {
    const c = JSON.parse(localStorage.getItem(CATEGORIAS_KEY) ?? "null") as { id: number; nome: string }[] | null;
    if (Array.isArray(c) && c.length) return c;
  } catch {
    // sem armazenamento: lista padrão, sem id
  }
  return CATEGORIAS_PADRAO.map((nome) => ({ id: null, nome }));
}
function guardarCategorias(c: { id: number; nome: string }[]) {
  try {
    localStorage.setItem(CATEGORIAS_KEY, JSON.stringify(c));
  } catch {
    // sem armazenamento: fica a lista padrão quando estiver sem rede
  }
}

/** Foto do celular costuma passar de 5 MB (limite da leitura): reduz para JPEG de até 2000 px. PDF e arquivo pequeno passam direto. */
async function reduzirFoto(f: File): Promise<File> {
  if (!f.type.startsWith("image/") || f.size <= 1.5 * 1024 * 1024 || typeof createImageBitmap === "undefined") return f;
  try {
    const img = await createImageBitmap(f);
    const escala = Math.min(1, 2000 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * escala);
    c.height = Math.round(img.height * escala);
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    return blob ? new File([blob], f.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : f;
  } catch {
    return f;
  }
}

/** Rotas /app/financeiro/*. */
export function AppFinanceiro() {
  const { simulando } = useCd();
  if (simulando) {
    return (
      <>
        <SubCabecalho titulo="Financeiro" voltar="/app" />
        <p className="cd-vazio">As solicitações financeiras não aparecem na simulação: elas são sempre da própria pessoa.</p>
      </>
    );
  }
  return (
    <Routes>
      <Route index element={<Inicio />} />
      <Route path="s/:id" element={<NoServidor />} />
      <Route path="s/:id/comprovante" element={<Comprovante modo="servidor" />} />
      <Route path="l/:id" element={<NoAparelho />} />
      <Route path="l/:id/comprovante" element={<Comprovante modo="local" />} />
      <Route path="*" element={<Navigate to="/app/financeiro" replace />} />
    </Routes>
  );
}

// ---------- Tela 4: início ----------
function Inicio() {
  const online = useOnline();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const minhas = useQuery({ queryKey: ["financeiro", "minhas"], queryFn: () => solicitacoesService.minhas(), enabled: online, retry: 0 });
  const locais = useQuery({ queryKey: ["cd", "sf-locais"], queryFn: rascunhosLocais.listar, networkMode: "always" });
  const [criando, setCriando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const { entrada } = useCd();

  const sincronizarTodos = useCallback(async () => {
    const lista = await rascunhosLocais.listar();
    if (!lista.length) return;
    setSincronizando(true);
    let ok = 0;
    for (const r of lista) {
      try {
        await sincronizar(r, destino(entrada.usuarioId), rascunhosLocais.gravar, rascunhosLocais.apagar);
        ok++;
      } catch (e) {
        await rascunhosLocais.gravar({ ...r, erro: msg(e, "Não foi possível sincronizar.") });
        if (ehFalhaDeRede(e)) break;
      }
    }
    setSincronizando(false);
    if (ok) toast.success(`${ok} rascunho${ok > 1 ? "s" : ""} do aparelho ${ok > 1 ? "enviados" : "enviado"} ao portal. Confira e envie para aprovação.`);
    void qc.invalidateQueries({ queryKey: ["cd", "sf-locais"] });
    void qc.invalidateQueries({ queryKey: ["financeiro"] });
  }, [entrada.usuarioId, qc]);

  // A rede voltou com rascunho no aparelho: sobe sozinho.
  const temLocal = (locais.data?.length ?? 0) > 0;
  useEffect(() => {
    if (online && temLocal) void sincronizarTodos();
  }, [online, temLocal, sincronizarTodos]);

  const iniciar = async (tipo: TipoApp) => {
    setCriando(true);
    try {
      if (!online) throw new TypeError("Failed to fetch");
      const id = await solicitacoesService.criar(tipo);
      navegar(`/app/financeiro/s/${id}`);
    } catch (e) {
      if (ehFalhaDeRede(e)) {
        const r = novoRascunhoLocal(tipo);
        await rascunhosLocais.gravar(r);
        navegar(`/app/financeiro/l/${r.id}`);
      } else toast.error(msg(e, "Não foi possível criar a solicitação."));
    } finally {
      setCriando(false);
    }
  };

  const nLocais = locais.data?.length ?? 0;
  return (
    <>
      <SubCabecalho titulo="Financeiro" sub="Reembolso e fundo fixo, com o comprovante pela câmera" voltar="/app" />
      <div className="cd-sec">
        {!online ? (
          <div className="cd-sf-offline" role="status"><CloudOff size={16} aria-hidden="true" />Sem rede · {nLocais} rascunho{nLocais === 1 ? "" : "s"} salvo{nLocais === 1 ? "" : "s"} no aparelho</div>
        ) : nLocais > 0 ? (
          <div className="cd-sf-offline cd-sf-offline--on" role="status">
            <RefreshCw size={16} aria-hidden="true" className={sincronizando ? "cd-gira" : undefined} />
            {sincronizando ? "Enviando os rascunhos do aparelho…" : `${nLocais} rascunho${nLocais === 1 ? "" : "s"} no aparelho`}
            {!sincronizando && <button type="button" className="cd-btn-mini" onClick={() => void sincronizarTodos()}>Sincronizar</button>}
          </div>
        ) : null}
        <div className="cd-sf-inicio">
          <button type="button" className="cd-sf-tipo" disabled={criando} onClick={() => void iniciar("reembolso")}>
            <Receipt size={26} aria-hidden="true" />
            <b>Reembolso</b>
            <small>gastos pagos do seu bolso</small>
          </button>
          <button type="button" className="cd-sf-tipo" disabled={criando || (online && minhas.data?.temFundoFixo === false)} onClick={() => void iniciar("fundo_fixo")}>
            <Calculator size={26} aria-hidden="true" />
            <b>Fundo fixo</b>
            <small>{online && minhas.data?.temFundoFixo === false ? "sem fundo cadastrado" : "prestação de contas"}</small>
          </button>
        </div>
      </div>
      <div className="cd-lista">
        {(locais.data ?? []).map((r) => (
          <Link key={r.id} to={`/app/financeiro/l/${r.id}`} className="cd-card">
            <div className="cd-card__l1"><span>Rascunho do aparelho</span><span className="cd-st cd-st--cancelado">Rascunho offline</span></div>
            <h3>{NOME[r.tipo]} · {moeda(totalLocal(r))}</h3>
            <p>{r.erro ? `Não sincronizou: ${r.erro}` : `${r.linhas.length} comprovante${r.linhas.length === 1 ? "" : "s"} · sincroniza ao voltar a rede`}</p>
          </Link>
        ))}
        {online && minhas.isPending && <Carregando />}
        {minhas.data?.lista.map((l) => <Cartao key={l.id} l={l} />)}
        {online && minhas.data && minhas.data.lista.length === 0 && nLocais === 0 && <p className="cd-vazio">Nenhuma solicitação ainda.</p>}
        {!online && !minhas.data && <p className="cd-vazio">Sem rede: a lista do portal volta quando a conexão voltar.</p>}
      </div>
    </>
  );
}

function Cartao({ l }: { l: LinhaLista }) {
  return (
    <Link to={`/app/financeiro/s/${l.id}`} className="cd-card">
      <div className="cd-card__l1"><span>{l.numero}</span><Chip status={l.status} /></div>
      <h3>{NOME[l.tipo]} · {moeda(l.valor)}</h3>
      <p>{l.etapa ? `${l.etapa.papel} · ${l.etapa.nivel} de ${l.etapa.de}` : l.pagarAte ? `Pagar até ${dataBR(l.pagarAte)}` : l.tipo === "adiantamento" && l.vencimento ? `Vencimento ${dataBR(l.vencimento)}` : `Atualizada em ${new Date(l.atualizadoEm).toLocaleDateString("pt-BR")}`}</p>
    </Link>
  );
}

function destino(usuarioId: string) {
  return {
    criar: (t: TipoApp) => solicitacoesService.criar(t),
    periodo: async (id: number) => {
      const d = await solicitacoesService.detalhe(id);
      return { competencia: d.competencia, periodoDe: d.periodoDe, periodoAte: d.periodoAte, centroCusto: d.centroCusto };
    },
    salvar: (p: Parameters<typeof solicitacoesService.salvar>[0]) => solicitacoesService.salvar(p),
    anexar: (p: { solicitacaoId: number; itemId: number; arquivo: File }) => solicitacoesService.anexar({ ...p, solicitanteId: usuarioId }),
  };
}

// ---------- Rascunho no servidor (ou a solicitação já enviada) ----------
function NoServidor() {
  const { id } = useParams();
  const n = Number(id);
  const d = useQuery({ queryKey: ["financeiro", "solicitacao", n], queryFn: () => solicitacoesService.detalhe(n), enabled: n > 0 });
  useEffect(() => {
    const c = d.data?.categorias;
    if (c?.length) guardarCategorias(c);
  }, [d.data?.categorias]);
  if (!(n > 0)) return <Navigate to="/app/financeiro" replace />;
  if (d.isPending) return <><SubCabecalho titulo="Solicitação" voltar="/app/financeiro" /><Carregando /></>;
  if (d.isError) return <><SubCabecalho titulo="Solicitação" voltar="/app/financeiro" /><p className="cd-alerta cd-sec">{msg(d.error, "Não foi possível abrir. Confira a rede.")}</p></>;
  return d.data.podeEditar && d.data.tipo !== "adiantamento" ? <FormServidor d={d.data} /> : <Acompanhar d={d.data} />;
}

function FormServidor({ d }: { d: Detalhe }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [aceite, setAceite] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const checks = useQuery({ queryKey: ["financeiro", "checagens", d.id], queryFn: () => solicitacoesService.checagens(d.id) });
  const bloqueios = (checks.data ?? []).filter((c) => c.resultado === "bloqueio");
  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: ["financeiro", "solicitacao", d.id] });
    void qc.invalidateQueries({ queryKey: ["financeiro", "checagens", d.id] });
  };
  const remover = async (itemId: number) => {
    try {
      const resto = d.itens.filter((i) => i.id !== itemId);
      await solicitacoesService.salvar({
        id: d.id, competencia: d.competencia, periodoDe: d.periodoDe, periodoAte: d.periodoAte, centroCusto: d.centroCusto,
        itens: resto.map((i) => ({ chave: String(i.id), id: i.id, data: i.data, valor: i.valor, descricao: i.descricao, motivo: i.motivo, categoriaId: i.categoriaId })),
        conhecidos: d.itens.map((i) => i.id),
      });
      recarregar();
    } catch (e) {
      toast.error(msg(e, "Não foi possível tirar a linha."));
    }
  };
  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await solicitacoesService.enviar(d.id);
      toast.success(r.alertas ? `Enviada, com ${r.alertas} alerta${r.alertas > 1 ? "s" : ""} para o Financeiro.` : "Enviada para aprovação");
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
      navegar("/app/financeiro");
    } catch (e) {
      toast.error(msg(e, "Não foi possível enviar."));
    } finally {
      setEnviando(false);
    }
  };
  const devolvida = [...d.aprovacoes].reverse().find((a) => a.status === "devolvido");
  return (
    <>
      <SubCabecalho titulo={NOME[d.tipo]} sub={`${d.numero} · ${d.status === "devolvida" ? "devolvida para ajuste" : "rascunho"}`} voltar="/app/financeiro" />
      <div className="cd-sec">
        {d.status === "devolvida" && <p className="cd-sf-aviso cd-sf-aviso--roxo">Devolvida{devolvida?.aprovador ? ` por ${devolvida.aprovador}` : ""}: “{devolvida?.comentario ?? ""}”. Corrija e envie de novo.</p>}
        {d.tipo === "fundo_fixo" && <p className="cd-sf-resumo">Saldo inicial {moeda(d.saldoInicial ?? 0)} · saldo final <b>{moeda(d.saldoFinal ?? 0)}</b></p>}
        <Link to={`/app/financeiro/s/${d.id}/comprovante`} className="cd-btn-ouro cd-sf-camera-btn"><Camera size={20} aria-hidden="true" />Novo comprovante</Link>
        <span className="cd-rot">Comprovantes · {d.itens.length}</span>
        <div className="cd-sf-linhas">
          {d.itens.map((i) => (
            <div key={i.id} className="cd-card cd-sf-linha">
              <div className="cd-card__l1"><span>{dataBR(i.data)} · {i.motivo ?? "sem motivo"}</span><b>{moeda(i.valor ?? 0)}</b></div>
              <p>{i.descricao ?? "—"} · {i.anexos.length ? <><Paperclip size={12} aria-hidden="true" /> comprovante</> : <span className="cd-sf-falta">sem comprovante</span>}</p>
              <button type="button" className="cd-sf-tirar" aria-label={`Tirar a linha de ${moeda(i.valor ?? 0)}`} onClick={() => void remover(i.id)}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          ))}
          {d.itens.length === 0 && <p className="cd-vazio">Fotografe o primeiro comprovante.</p>}
        </div>
        <div className="cd-sf-total"><span>{d.tipo === "fundo_fixo" ? "Despesas totais" : "Total"}</span><b>{moeda(d.totalDespesas)}</b></div>
        {bloqueios.length > 0 && (
          <ul className="cd-sf-bloqueios">{bloqueios.map((b, k) => <li key={k}><b>{b.codigo}</b> {b.detalhe}</li>)}</ul>
        )}
        <label className="cd-sf-aceite">
          <input type="checkbox" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
          <span>Declaro que as despesas são verdadeiras e foram feitas a serviço da empresa. O aceite substitui a assinatura.</span>
        </label>
        <button type="button" className="cd-btn-ouro" disabled={!aceite || enviando || bloqueios.length > 0 || d.itens.length === 0} onClick={() => void enviar()}>
          <Send size={18} aria-hidden="true" /> {enviando ? "Enviando…" : "Enviar para aprovação"}
        </button>
      </div>
    </>
  );
}

/** Solicitação já enviada: situação, valor, linhas e as etapas. */
function Acompanhar({ d }: { d: Detalhe }) {
  const ciclo = d.aprovacoes.filter((a) => a.ciclo === d.ciclo && a.status !== "nao_exigido" && a.status !== "pulado");
  return (
    <>
      <SubCabecalho titulo={d.numero} sub={NOME[d.tipo]} voltar="/app/financeiro" />
      <div className="cd-sec">
        <div className="cd-sf-total"><Chip status={d.status} /><b>{moeda(d.adiantamento?.valor ?? d.totalDespesas)}</b></div>
        {d.pagarAte && <p className="cd-sf-resumo">Pagamento até {dataBR(d.pagarAte)}</p>}
        {d.tipo === "adiantamento" && d.status === "comprovacao_pendente" && (
          <p className="cd-sf-aviso">Envie a comprovação até {dataBR(d.adiantamento?.prazoComprovacao)} pelo portal: Solicitações Financeiras › Minhas solicitações.</p>
        )}
        {d.tipo === "adiantamento" && d.podeEditar && <p className="cd-sf-aviso">O adiantamento é preenchido pelo portal (documento de origem e rateio).</p>}
        <span className="cd-rot">Etapas</span>
        <ol className="cd-sf-etapas">
          {ciclo.map((a) => (
            <li key={a.nivel} className={`cd-sf-etapa cd-sf-etapa--${a.status}`}>
              <b>{a.papel}</b>
              <small>{a.aprovador ?? ""}{a.decididoEm ? ` · ${a.status === "aprovado" ? "aprovou" : a.status === "devolvido" ? "devolveu" : a.status === "reprovado" ? "reprovou" : ""} ${new Date(a.decididoEm).toLocaleDateString("pt-BR")}` : a.status === "aguardando" ? " · aguardando" : ""}</small>
              {a.comentario && <em>“{a.comentario}”</em>}
            </li>
          ))}
          {ciclo.length === 0 && <li className="cd-sf-etapa"><small>Ainda não enviada.</small></li>}
        </ol>
        {d.itens.length > 0 && d.tipo !== "adiantamento" && (
          <>
            <span className="cd-rot">Comprovantes</span>
            <div className="cd-sf-linhas">
              {d.itens.map((i) => (
                <div key={i.id} className="cd-card">
                  <div className="cd-card__l1"><span>{dataBR(i.data)} · {i.motivo}</span><b>{moeda(i.valor ?? 0)}</b></div>
                  <p>{i.descricao}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------- Rascunho no aparelho ----------
function NoAparelho() {
  const { id = "" } = useParams();
  const navegar = useNavigate();
  const online = useOnline();
  const { entrada } = useCd();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cd", "sf-local", id], queryFn: () => rascunhosLocais.obter(id), networkMode: "always" });
  const [subindo, setSubindo] = useState(false);
  if (q.isPending) return <Carregando />;
  const r = q.data;
  if (!r) return <Navigate to="/app/financeiro" replace />;
  const salvar = async (novo: RascunhoLocal) => {
    await rascunhosLocais.gravar(novo);
    void qc.invalidateQueries({ queryKey: ["cd", "sf-local", id] });
    void qc.invalidateQueries({ queryKey: ["cd", "sf-locais"] });
  };
  const subir = async () => {
    setSubindo(true);
    try {
      const sid = await sincronizar(r, destino(entrada.usuarioId), rascunhosLocais.gravar, rascunhosLocais.apagar);
      toast.success("Rascunho enviado ao portal. Confira e envie para aprovação.");
      void qc.invalidateQueries({ queryKey: ["cd", "sf-locais"] });
      navegar(`/app/financeiro/s/${sid}`, { replace: true });
    } catch (e) {
      await salvar({ ...r, erro: msg(e, "Não foi possível sincronizar.") });
      toast.error(ehFalhaDeRede(e) ? "Sem rede: tente de novo quando a conexão voltar." : msg(e, "Não foi possível sincronizar."));
    } finally {
      setSubindo(false);
    }
  };
  const apagar = async () => {
    await rascunhosLocais.apagar(r.id);
    void qc.invalidateQueries({ queryKey: ["cd", "sf-locais"] });
    navegar("/app/financeiro", { replace: true });
  };
  return (
    <>
      <SubCabecalho titulo={NOME[r.tipo]} sub="Rascunho salvo no aparelho" voltar="/app/financeiro" />
      <div className="cd-sec">
        <div className={`cd-sf-offline${online ? " cd-sf-offline--on" : ""}`} role="status">
          <CloudOff size={16} aria-hidden="true" />
          <span>{online ? "Com rede: envie o rascunho ao portal." : "Sem rede: as fotos e os dados ficam no aparelho até a conexão voltar."}</span>
        </div>
        {r.erro && <p className="cd-alerta">Não sincronizou: {r.erro}</p>}
        <Link to={`/app/financeiro/l/${r.id}/comprovante`} className="cd-btn-ouro cd-sf-camera-btn"><Camera size={20} aria-hidden="true" />Novo comprovante</Link>
        <span className="cd-rot">Comprovantes · {r.linhas.length}</span>
        <div className="cd-sf-linhas">
          {r.linhas.map((l) => {
            const falta = faltaNaLinha(l);
            return (
              <div key={l.chave} className="cd-card cd-sf-linha">
                <div className="cd-card__l1"><span>{dataBR(l.data)} · {l.motivo ?? "sem motivo"}</span><b>{moeda(l.valor ?? 0)}</b></div>
                <p>{l.descricao ?? "—"}{falta.length ? <span className="cd-sf-falta"> · falta {falta.join(", ")}</span> : null}</p>
                <button type="button" className="cd-sf-tirar" aria-label="Tirar a linha" onClick={() => void salvar({ ...r, linhas: r.linhas.filter((x) => x.chave !== l.chave) })}><Trash2 size={16} aria-hidden="true" /></button>
              </div>
            );
          })}
          {r.linhas.length === 0 && <p className="cd-vazio">Fotografe o primeiro comprovante.</p>}
        </div>
        <div className="cd-sf-total"><span>Total</span><b>{moeda(totalLocal(r))}</b></div>
        <button type="button" className="cd-btn-ouro" disabled={!online || subindo || r.linhas.length === 0} onClick={() => void subir()}>
          <RefreshCw size={18} aria-hidden="true" className={subindo ? "cd-gira" : undefined} /> {subindo ? "Enviando ao portal…" : "Enviar ao portal"}
        </button>
        <p className="cd-sf-resumo">O envio para aprovação (com o aceite) é feito depois, com rede.</p>
        <button type="button" className="cd-btn-vidro" onClick={() => void apagar()}>Descartar rascunho</button>
      </div>
    </>
  );
}

// ---------- Tela 12: novo comprovante (câmera + leitura) ----------
function Comprovante({ modo }: { modo: "servidor" | "local" }) {
  const { id = "" } = useParams();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const { entrada } = useCd();
  const volta = `/app/financeiro/${modo === "servidor" ? "s" : "l"}/${id}`;
  const det = useQuery({ queryKey: ["financeiro", "solicitacao", Number(id)], queryFn: () => solicitacoesService.detalhe(Number(id)), enabled: modo === "servidor" });
  const categorias = useMemo(() => (det.data?.categorias?.length ? det.data.categorias : lerCategorias()), [det.data?.categorias]);
  const ref = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<string | null>(null);
  const [anexoId, setAnexoId] = useState<number | null>(null);
  const [lendo, setLendo] = useState(false);
  const [ocr, setOcr] = useState<LeituraOcr | null>(null);
  const [data, setData] = useState("");
  const [valor, setValor] = useState("");
  const [favorecido, setFavorecido] = useState("");
  const [cat, setCat] = useState<{ id: number | null; nome: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => () => { if (previa) URL.revokeObjectURL(previa); }, [previa]);

  const escolher = async (e: ChangeEvent<HTMLInputElement>) => {
    const bruto = e.target.files?.[0];
    e.target.value = "";
    if (!bruto) return;
    const f = await reduzirFoto(bruto);
    setArquivo(f);
    setPrevia(f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
    setOcr(null);
    if (modo !== "servidor") return;
    setLendo(true);
    try {
      const r = await leituraService.enviar({ solicitacaoId: Number(id), solicitanteId: entrada.usuarioId, arquivo: f });
      setAnexoId(r.id);
      if (r.duplicadoEm) toast.warning(`Este arquivo já foi usado na ${r.duplicadoEm}.`);
      const l = await leituraService.ler(r.id).catch(() => ({ status: "erro", mensagem: "Leitura indisponível: preencha à mão." }));
      const fila = await leituraService.fila(Number(id));
      const lido = fila.find((x) => x.id === r.id)?.ocr ?? null;
      if (lido && !lido.erro) {
        setOcr(lido);
        if (lido.data) setData(lido.data);
        if (lido.valor_total != null) setValor(lido.valor_total.toFixed(2).replace(".", ","));
        if (lido.favorecido) setFavorecido(lido.favorecido);
        const s = lido.motivo_sugestoes[0];
        const c = s ? categorias.find((x) => x.id === s.categoria_id) : undefined;
        if (c) setCat(c);
      } else if (l.status === "erro") toast.warning(l.mensagem ?? "Não foi possível ler: preencha à mão.");
    } catch (er) {
      toast.error(msg(er, "Não foi possível enviar a foto. Confira a rede."));
      setArquivo(null);
    } finally {
      setLendo(false);
    }
  };

  const numero = (t: string) => {
    const n = Number(t.replace(/\./g, "").replace(",", "."));
    return t.trim() === "" || Number.isNaN(n) ? null : Math.round(n * 100) / 100;
  };
  const adicionar = async () => {
    setSalvando(true);
    try {
      if (modo === "servidor") {
        if (!anexoId) throw new ServiceError("INVALID_INPUT", "Fotografe o comprovante.");
        await leituraService.confirmar({ anexoId, data: data || null, valor: numero(valor), descricao: favorecido.trim() || null, categoriaId: cat?.id ?? null, motivo: cat?.nome ?? null });
        void qc.invalidateQueries({ queryKey: ["financeiro"] });
      } else {
        const r = await rascunhosLocais.obter(id);
        if (!r) throw new ServiceError("NOT_FOUND", "Rascunho não encontrado no aparelho.");
        const l: LinhaLocal = { chave: novaChave(), data: data || null, valor: numero(valor), descricao: favorecido.trim() || null, motivo: cat?.nome ?? null,
          categoriaId: cat?.id ?? null, foto: arquivo, fotoNome: arquivo?.name ?? null };
        await rascunhosLocais.gravar({ ...r, linhas: [...r.linhas, l] });
        void qc.invalidateQueries({ queryKey: ["cd", "sf-locais"] });
        void qc.invalidateQueries({ queryKey: ["cd", "sf-local", id] });
      }
      toast.success("Comprovante incluído");
      navegar(volta, { replace: true });
    } catch (e) {
      toast.error(msg(e, "Não foi possível incluir. Confira data, valor e favorecido."));
    } finally {
      setSalvando(false);
    }
  };

  const leg = (k: "data" | "valor" | "favorecido") => (ocr ? ocr.legibilidade[k] : null);
  const tag = (k: "data" | "valor" | "favorecido") => {
    const v = leg(k);
    if (v == null) return null;
    return <span className="cd-sf-tag"><Sparkles size={11} aria-hidden="true" />{v >= 0.8 ? `copiado · legibilidade ${Math.round(v * 100)}%` : `legibilidade ${Math.round(v * 100)}% · confira`}</span>;
  };
  const sugestoes = ocr?.motivo_sugestoes ?? [];
  return (
    <>
      <SubCabecalho titulo="Novo comprovante" sub={modo === "local" ? "Sem rede: a foto fica no aparelho" : "A leitura copia data, valor e favorecido"} voltar={volta} />
      <div className="cd-sec">
        <button type="button" className="cd-sf-camera" onClick={() => ref.current?.click()} aria-label="Fotografar o comprovante">
          {previa ? <img src={previa} alt="Comprovante fotografado" /> : arquivo ? <span><Paperclip size={22} aria-hidden="true" />{arquivo.name}</span> : <span className="cd-sf-moldura" aria-hidden="true" />}
          {lendo && <span className="cd-sf-lendo">Lendo o comprovante…</span>}
        </button>
        <p className="cd-sf-resumo cd-sf-centro">Enquadre o comprovante inteiro, com boa luz.</p>
        <input ref={ref} type="file" hidden accept="image/*,application/pdf" capture="environment" onChange={(e) => void escolher(e)} />
        <button type="button" className="cd-btn-ouro" disabled={lendo} onClick={() => ref.current?.click()}><Camera size={18} aria-hidden="true" />{arquivo ? "Fotografar de novo" : "Fotografar"}</button>
        <label className="cd-rot" htmlFor="sf-data">Data</label>
        <input id="sf-data" className={`cd-campo${leg("data") != null ? " cd-sf-ocr" : ""}`} type="date" value={data} onChange={(e) => setData(e.target.value)} />
        {tag("data")}
        <label className="cd-rot" htmlFor="sf-valor">Valor (R$)</label>
        <input id="sf-valor" className={`cd-campo${leg("valor") != null ? " cd-sf-ocr" : ""}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value.replace(/[^\d,.]/g, ""))} />
        {tag("valor")}
        <label className="cd-rot" htmlFor="sf-fav">Favorecido</label>
        <input id="sf-fav" className={`cd-campo${leg("favorecido") != null ? " cd-sf-ocr" : ""}`} maxLength={200} value={favorecido} onChange={(e) => setFavorecido(e.target.value)} />
        {tag("favorecido")}
        <span className="cd-rot">Motivo</span>
        <div className="cd-chips">
          {sugestoes.map((s) => {
            const c = categorias.find((x) => x.id === s.categoria_id);
            return c ? (
              <button key={s.categoria_id} type="button" className="cd-chip" aria-pressed={cat?.nome === c.nome} onClick={() => setCat(c)}>
                {s.texto} <small>{Math.round(s.confianca * 100)}%</small>
              </button>
            ) : null;
          })}
          {categorias.filter((c) => !sugestoes.some((s) => s.categoria_id === c.id)).map((c) => (
            <button key={c.nome} type="button" className="cd-chip" aria-pressed={cat?.nome === c.nome} onClick={() => setCat(c)}>{c.nome}</button>
          ))}
        </div>
        <button type="button" className="cd-btn-ouro cd-sf-incluir" disabled={salvando || lendo || !arquivo} onClick={() => void adicionar()}>
          <Check size={18} aria-hidden="true" /> {salvando ? "Incluindo…" : "Incluir no formulário"}
        </button>
      </div>
    </>
  );
}
