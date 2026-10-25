import { ArrowLeft, ArrowRight, Play, Plus, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { getMenuItem } from "../../config/menuRegistry";
import { useExcluirBalao, useModuloAdmin, useReordenarBaloes, useSalvarBalao, useSalvarModulo } from "./hooks";
import {
  ehTelaCelular, PAPEIS, TELAS, telaUrl, TEXTO_RECOMENDADO,
  type Alvo, type Balao, type ModuloAdmin, type Papel, type PosicaoBalao, type Restricao, type SalvarModulo, type StatusModulo, type TrilhaAdmin,
} from "./types";

// Gerenciar tutoriais › editar um módulo (dados, trilhas e pergunta) e os balões dele (tela, contorno arrastável, texto).

const meus = getMenuItem("centro_treinamento_meus");
const erroMsg = (e: unknown, padrao: string) => (e instanceof Error && e.message ? e.message : padrao);

const POSICOES: { valor: PosicaoBalao; rotulo: string }[] = [
  { valor: "auto", rotulo: "Automática" },
  { valor: "direita", rotulo: "À direita" },
  { valor: "esquerda", rotulo: "À esquerda" },
  { valor: "abaixo", rotulo: "Abaixo" },
  { valor: "acima", rotulo: "Acima" },
];

interface Props {
  /** null = módulo novo. */
  moduloId: number | null;
  trilhas: TrilhaAdmin[];
  onFechar: () => void;
  onCriado: (id: number) => void;
}

export function EditorModulo({ moduloId, trilhas, onFechar, onCriado }: Props) {
  const q = useModuloAdmin(moduloId ?? 0);
  if (moduloId && q.isLoading) return <div className="card tr-editor">Carregando o módulo…</div>;
  if (moduloId && (q.isError || !q.data)) return <div className="card tr-editor field__error">{erroMsg(q.error, "Não foi possível abrir o módulo.")}</div>;
  const modulo = moduloId ? (q.data ?? null) : null;
  return (
    <div className="card tr-editor">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h3>{modulo ? `Editar: ${modulo.titulo}` : "Novo módulo"}</h3>
          <p className="field__help" style={{ margin: 0 }}>
            {modulo ? "Dados do módulo e os balões de cada tela." : "Salve os dados do módulo para começar a montar os balões."}
          </p>
        </div>
        <button type="button" className="btn btn--outline tr-btn-sm" style={{ marginLeft: "auto" }} onClick={onFechar}>
          <X size={14} aria-hidden /> Fechar
        </button>
      </div>
      <FormModulo modulo={modulo} trilhas={trilhas} onCriado={onCriado} />
      {modulo && <EditorBaloes modulo={modulo} />}
    </div>
  );
}

function FormModulo({ modulo, trilhas, onCriado }: { modulo: ModuloAdmin | null; trilhas: TrilhaAdmin[]; onCriado: (id: number) => void }) {
  const salvar = useSalvarModulo();
  const [f, setF] = useState<SalvarModulo>(() => ({
    id: modulo?.id,
    titulo: modulo?.titulo ?? "",
    descricao: modulo?.descricao ?? "",
    papel: modulo?.papel ?? "atendente",
    restricao: modulo?.restricao ?? null,
    minutos: modulo?.minutos ?? 3,
    rotaDemo: modulo?.rotaDemo ?? "/",
    celular: modulo?.celular ?? false,
    pergunta: modulo?.pergunta ?? "",
    opcoes: modulo?.opcoes ?? ["", ""],
    resposta: modulo?.resposta ?? 0,
    status: modulo?.status ?? "rascunho",
    trilhas: modulo?.trilhas ?? [],
  }));
  const [erro, setErro] = useState<string | null>(null);
  const muda = <K extends keyof SalvarModulo>(k: K, v: SalvarModulo[K]) => setF((x) => ({ ...x, [k]: v }));

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const opcoes = f.opcoes.map((o) => o.trim());
    if (f.titulo.trim().length < 3) return setErro("Dê um título ao módulo (3 letras ou mais).");
    if (f.pergunta.trim().length < 5) return setErro("Escreva a pergunta final.");
    if (opcoes.filter(Boolean).length < 2 || opcoes.some((o) => !o)) return setErro("Preencha todas as opções da pergunta (de 2 a 5).");
    if (f.status === "publicado" && f.trilhas.length === 0) return setErro("Marque ao menos uma trilha para publicar.");
    setErro(null);
    salvar.mutate(
      { ...f, opcoes },
      {
        onSuccess: (id) => {
          toast.success(modulo ? "Módulo salvo" : "Módulo criado");
          if (!modulo) onCriado(id);
        },
        onError: (er) => setErro(erroMsg(er, "Não foi possível salvar o módulo.")),
      },
    );
  };

  return (
    <form onSubmit={enviar} style={{ marginTop: 14 }}>
      <div className="tr-form">
        <label className="field field--larga">
          <span className="field__label">Título</span>
          <input className="input input--sm" value={f.titulo} maxLength={90} onChange={(e) => muda("titulo", e.target.value)} />
        </label>
        <label className="field field--larga">
          <span className="field__label">Descrição do cartão</span>
          <input className="input input--sm" value={f.descricao} maxLength={240} onChange={(e) => muda("descricao", e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Para quem</span>
          <select className="input input--sm" value={f.papel} onChange={(e) => muda("papel", e.target.value as Papel)}>
            {(Object.keys(PAPEIS) as Papel[]).map((p) => (
              <option key={p} value={p}>
                {PAPEIS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Quem vê na trilha</span>
          <select className="input input--sm" value={f.restricao ?? ""} onChange={(e) => muda("restricao", (e.target.value || null) as Restricao | null)}>
            <option value="">Todos do setor</option>
            <option value="gestor_setor">Só gestores do setor (e supervisão)</option>
            <option value="aprovador">Só aprovadores e substitutos</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Duração (min)</span>
          <input className="input input--sm" type="number" min={1} max={60} value={f.minutos} onChange={(e) => muda("minutos", Number(e.target.value) || 1)} />
        </label>
        <label className="field">
          <span className="field__label">Rota na demonstração</span>
          <input className="input input--sm" value={f.rotaDemo} placeholder="/gestao-chamados/tickets" onChange={(e) => muda("rotaDemo", e.target.value)} />
          <span className="field__help">O botão "Praticar na demonstração" indica esta tela.</span>
        </label>
        <fieldset className="field field--larga" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field__label" style={{ marginBottom: 6 }}>
            Trilhas
          </legend>
          <div className="tr-checks">
            {trilhas.map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  checked={f.trilhas.includes(t.id)}
                  onChange={(e) => muda("trilhas", e.target.checked ? [...f.trilhas, t.id] : f.trilhas.filter((x) => x !== t.id))}
                />
                {t.nome}
              </label>
            ))}
            <label>
              <input type="checkbox" checked={f.celular} onChange={(e) => muda("celular", e.target.checked)} /> Mostra o celular (App do solicitante)
            </label>
          </div>
        </fieldset>
        <label className="field field--larga">
          <span className="field__label">Pergunta final</span>
          <input className="input input--sm" value={f.pergunta} maxLength={200} onChange={(e) => muda("pergunta", e.target.value)} />
        </label>
        <fieldset className="field field--larga" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field__label" style={{ marginBottom: 6 }}>
            Opções (marque a certa)
          </legend>
          <div className="tr-opcoes">
            {f.opcoes.map((o, k) => (
              <div key={k} className="tr-opcao">
                <input type="radio" name="tr-certa" aria-label={`Opção ${k + 1} é a certa`} checked={f.resposta === k} onChange={() => muda("resposta", k)} />
                <input
                  className="input input--sm"
                  aria-label={`Opção ${k + 1}`}
                  value={o}
                  onChange={(e) => muda("opcoes", f.opcoes.map((x, j) => (j === k ? e.target.value : x)))}
                />
                <button
                  type="button"
                  className="btn btn--outline tr-btn-sm"
                  aria-label={`Remover opção ${k + 1}`}
                  disabled={f.opcoes.length <= 2}
                  onClick={() => setF((x) => ({ ...x, opcoes: x.opcoes.filter((_, j) => j !== k), resposta: x.resposta === k ? 0 : x.resposta > k ? x.resposta - 1 : x.resposta }))}
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            ))}
            {f.opcoes.length < 5 && (
              <button type="button" className="btn btn--outline tr-btn-sm" style={{ justifySelf: "start" }} onClick={() => muda("opcoes", [...f.opcoes, ""])}>
                <Plus size={14} aria-hidden /> Opção
              </button>
            )}
          </div>
        </fieldset>
      </div>
      <div className="tr-rodape-form">
        {erro && (
          <span className="field__error" role="alert">
            {erro}
          </span>
        )}
        <select className="input input--sm" style={{ width: "auto" }} aria-label="Status" value={f.status} onChange={(e) => muda("status", e.target.value as StatusModulo)}>
          <option value="rascunho">Rascunho</option>
          <option value="publicado">Publicado</option>
        </select>
        <button type="submit" className="btn btn--primary" disabled={salvar.isPending}>
          {modulo ? "Salvar módulo" : "Criar módulo"}
        </button>
      </div>
    </form>
  );
}

interface Rascunho {
  id?: number;
  tela: string;
  titulo: string;
  texto: string;
  alvo: Alvo;
  posicao: PosicaoBalao;
}

const doBalao = (b: Balao): Rascunho => ({ id: b.id, tela: b.tela, titulo: b.titulo, texto: b.texto, alvo: [...b.alvo] as Alvo, posicao: b.posicao });

function EditorBaloes({ modulo }: { modulo: ModuloAdmin }) {
  const { baloes } = modulo;
  const [selecionado, setSelecionado] = useState<number | null>(baloes[0]?.id ?? null);
  const atual = baloes.find((b) => b.id === selecionado) ?? null;
  const [r, setR] = useState<Rascunho | null>(atual ? doBalao(atual) : null);
  const [erro, setErro] = useState<string | null>(null);
  const salvar = useSalvarBalao();
  const excluir = useExcluirBalao();
  const reordenar = useReordenarBaloes();

  const abrir = (b: Balao) => {
    setSelecionado(b.id);
    setR(doBalao(b));
    setErro(null);
  };
  const novo = () => {
    setSelecionado(null);
    setR({ tela: atual?.tela ?? baloes.at(-1)?.tela ?? TELAS[0], titulo: "", texto: "", alvo: [40, 40, 20, 10], posicao: "auto" });
    setErro(null);
  };

  const gravar = () => {
    if (!r) return;
    if (r.titulo.trim().length < 2 || r.texto.trim().length < 2) return setErro("Preencha o título e a explicação do balão.");
    setErro(null);
    salvar.mutate(
      { ...r, moduloId: modulo.id },
      {
        onSuccess: (id) => {
          toast.success(r.id ? "Balão salvo" : "Balão criado");
          setSelecionado(id);
          setR({ ...r, id });
        },
        onError: (e) => setErro(erroMsg(e, "Não foi possível salvar o balão.")),
      },
    );
  };

  const apagar = () => {
    if (!r?.id || !confirm(`Excluir o balão "${r.titulo}"?`)) return;
    excluir.mutate(r.id, {
      onSuccess: () => {
        toast.success("Balão excluído");
        setSelecionado(null);
        setR(null);
      },
      onError: (e) => setErro(erroMsg(e, "Não foi possível excluir o balão.")),
    });
  };

  const mover = (delta: number) => {
    const k = baloes.findIndex((b) => b.id === selecionado);
    const j = k + delta;
    if (k < 0 || j < 0 || j >= baloes.length) return;
    const ids = baloes.map((b) => b.id);
    [ids[k], ids[j]] = [ids[j], ids[k]];
    reordenar.mutate({ moduloId: modulo.id, ids }, { onError: (e) => setErro(erroMsg(e, "Não foi possível reordenar.")) });
  };
  const posicao = baloes.findIndex((b) => b.id === selecionado);

  return (
    <section aria-label="Balões do módulo" style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 15 }}>Balões ({baloes.length})</h3>
      <div className="tr-quadros">
        {baloes.map((b, k) => (
          <button type="button" key={b.id} className={`tr-mini${b.id === selecionado ? " tr-mini--on" : ""}`} onClick={() => abrir(b)} aria-pressed={b.id === selecionado}>
            <img src={telaUrl(b.tela)} alt="" loading="lazy" />
            <span>
              {k + 1}. {b.titulo}
            </span>
          </button>
        ))}
        <button type="button" className={`tr-mini tr-mini--novo${r && !r.id ? " tr-mini--on" : ""}`} onClick={novo}>
          <span>
            <Plus size={16} aria-hidden /> Balão
          </span>
        </button>
      </div>

      {!r ? (
        <p className="field__help">Escolha um balão acima ou crie um novo.</p>
      ) : (
        <div className="tr-duas">
          <div>
            <Previa rascunho={r} onAlvo={(alvo) => setR({ ...r, alvo })} />
            <p className="field__help" style={{ marginTop: 6 }}>
              Arraste o contorno vermelho até o botão que o balão explica; o quadradinho no canto muda o tamanho. O balão se posiciona sozinho ao lado.
            </p>
          </div>
          <div className="tr-form" style={{ gridTemplateColumns: "1fr" }}>
            <label className="field">
              <span className="field__label">Tela do sistema</span>
              <select className="input input--sm" value={r.tela} onChange={(e) => setR({ ...r, tela: e.target.value })}>
                {TELAS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {ehTelaCelular(t) ? " (celular)" : ""}
                  </option>
                ))}
              </select>
              <span className="field__help">Telas capturadas da demonstração (npm run treinamento:capturar).</span>
            </label>
            <label className="field">
              <span className="field__label">Posição do balão</span>
              <select className="input input--sm" value={r.posicao} onChange={(e) => setR({ ...r, posicao: e.target.value as PosicaoBalao })}>
                {POSICOES.map((p) => (
                  <option key={p.valor} value={p.valor}>
                    {p.rotulo}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Título do balão</span>
              <input className="input input--sm" value={r.titulo} maxLength={60} onChange={(e) => setR({ ...r, titulo: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Explicação</span>
              <textarea className="input" value={r.texto} maxLength={400} onChange={(e) => setR({ ...r, texto: e.target.value })} />
              <span className={r.texto.length > TEXTO_RECOMENDADO ? "field__error" : "field__help"}>
                {r.texto.length} caracteres · até {TEXTO_RECOMENDADO} recomendados para caber no balão
              </span>
            </label>
            {erro && (
              <span className="field__error" role="alert">
                {erro}
              </span>
            )}
            <div className="tr-rodape-form" style={{ justifyContent: "flex-start", marginTop: 0 }}>
              <button type="button" className="btn btn--primary tr-btn-sm" onClick={gravar} disabled={salvar.isPending}>
                Salvar balão
              </button>
              {r.id && (
                <>
                  <button type="button" className="btn btn--outline tr-btn-sm" onClick={() => mover(-1)} disabled={posicao <= 0 || reordenar.isPending} aria-label="Mover para antes">
                    <ArrowLeft size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline tr-btn-sm"
                    onClick={() => mover(1)}
                    disabled={posicao < 0 || posicao >= baloes.length - 1 || reordenar.isPending}
                    aria-label="Mover para depois"
                  >
                    <ArrowRight size={14} aria-hidden />
                  </button>
                  <button type="button" className="btn btn--danger-outline tr-btn-sm" onClick={apagar} disabled={excluir.isPending}>
                    <Trash2 size={14} aria-hidden /> Excluir
                  </button>
                </>
              )}
              <Link to={`${meus.path}/${modulo.id}`} className="btn btn--outline tr-btn-sm">
                <Play size={14} aria-hidden /> Ver no tour
              </Link>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** A tela com o contorno arrastável (mover) e o canto que redimensiona; valores em % da tela, com 1 casa. */
function Previa({ rascunho, onAlvo }: { rascunho: Rascunho; onAlvo: (a: Alvo) => void }) {
  const telaRef = useRef<HTMLDivElement>(null);
  const arraste = useRef<{ modo: "mover" | "redimensionar"; x: number; y: number; alvo: Alvo } | null>(null);
  const [x, y, w, h] = rascunho.alvo;
  const celular = ehTelaCelular(rascunho.tela);

  const comecar = (modo: "mover" | "redimensionar") => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    arraste.current = { modo, x: e.clientX, y: e.clientY, alvo: [...rascunho.alvo] as Alvo };
  };
  const mexer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const a = arraste.current, tela = telaRef.current;
    if (!a || !tela) return;
    const box = tela.getBoundingClientRect();
    const dx = ((e.clientX - a.x) / box.width) * 100;
    const dy = ((e.clientY - a.y) / box.height) * 100;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const lim = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    const [ax, ay, aw, ah] = a.alvo;
    if (a.modo === "mover") onAlvo([r1(lim(ax + dx, 0, 100 - aw)), r1(lim(ay + dy, 0, 100 - ah)), aw, ah]);
    else onAlvo([ax, ay, r1(lim(aw + dx, 1, 100 - ax)), r1(lim(ah + dy, 1, 100 - ay))]);
  };
  const soltar = () => {
    arraste.current = null;
  };

  return (
    <div className="tr-prev">
      <div className="tr-prev__tela" ref={telaRef} style={{ width: celular ? "42%" : "100%" }}>
        <img src={telaUrl(rascunho.tela)} alt={`Tela ${rascunho.tela}`} draggable={false} />
        <div
          className="tr-prev__alvo"
          style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
          onPointerDown={comecar("mover")}
          onPointerMove={mexer}
          onPointerUp={soltar}
          onPointerCancel={soltar}
          role="img"
          aria-label={`Contorno em ${x}% × ${y}%, tamanho ${w}% × ${h}%`}
        >
          <div className="tr-prev__alca" onPointerDown={comecar("redimensionar")} onPointerMove={mexer} onPointerUp={soltar} onPointerCancel={soltar} aria-hidden />
        </div>
      </div>
      <p className="tr-prev__dica">
        Contorno: x {x}% · y {y}% · {w}% × {h}%
      </p>
    </div>
  );
}
