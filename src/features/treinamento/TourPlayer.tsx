import { ExternalLink, Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModulo, useResponder, useSalvarProgresso } from "./hooks";
import { DEMO_URL, ehTelaCelular, PAPEIS, telaUrl, type Modulo, type Resposta } from "./types";

// Tour por balões sobre a própria tela do sistema (D2 do mockup aprovado): a tela capturada aparece inteira, o botão
// explicado fica contornado (resto escurecido) e o balão aponta para ele. Só texto (D1). No fim, a pergunta (conferida
// no banco) e "Praticar na demonstração".

/** Tamanho das capturas (public/treinamento), em que os alvos (%) foram marcados. */
const TAMANHO = { desktop: [1440, 900], celular: [780, 1688] } as const;
const LARGURA_BALAO = 320;
type Lado = "direita" | "esquerda" | "abaixo" | "acima" | "dentro";

const RITMOS = [
  { valor: 1.4, rotulo: "Devagar" },
  { valor: 1, rotulo: "Normal" },
  { valor: 0.7, rotulo: "Rápido" },
];

export function TourPlayer({ moduloId, onFechar }: { moduloId: number; onFechar: () => void }) {
  const q = useModulo(moduloId);

  useEffect(() => {
    const antes = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = antes;
    };
  }, []);

  let corpo;
  // Espera a leitura feita agora: o cache pode ter o passo de uma abertura anterior, e o tour retoma de onde parou.
  if (q.isLoading || (!q.isFetchedAfterMount && !q.isError)) corpo = <div className="tr-pl-estado">Carregando o treinamento…</div>;
  else if (q.isError || !q.data) {
    corpo = (
      <div className="tr-pl-estado">
        <div>
          <p>{q.error instanceof Error ? q.error.message : "Não foi possível abrir este treinamento."}</p>
          <button type="button" className="tr-pl-btn" onClick={onFechar}>
            <X size={14} /> Fechar
          </button>
        </div>
      </div>
    );
  } else corpo = <Tour modulo={q.data} onFechar={onFechar} />;

  return createPortal(
    <div className="tr-player" role="dialog" aria-modal="true" aria-labelledby="tr-pl-titulo">
      {corpo}
    </div>,
    document.body,
  );
}

function Tour({ modulo, onFechar }: { modulo: Modulo; onFechar: () => void }) {
  const { baloes } = modulo;
  const total = baloes.length;
  // Retoma de onde parou; concluído começa do início.
  const [i, setI] = useState(() => (modulo.concluidoEm ? 0 : Math.min(modulo.passoAtual, total)));
  const [telaMostrada, setTelaMostrada] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [ritmo, setRitmo] = useState(1);
  const [escolha, setEscolha] = useState<number | null>(null);
  const [resultado, setResultado] = useState<Resposta | null>(null);
  const [concluidoEm, setConcluidoEm] = useState(modulo.concluidoEm);

  const { mutate: salvarPasso } = useSalvarProgresso();
  const responder = useResponder();

  const palcoRef = useRef<HTMLDivElement>(null);
  const telaRef = useRef<HTMLDivElement>(null);
  const alvoRef = useRef<HTMLDivElement>(null);
  const balaoRef = useRef<HTMLDivElement>(null);
  const setaRef = useRef<HTMLSpanElement>(null);
  const autoRef = useRef<HTMLDivElement>(null);
  const fecharRef = useRef<HTMLButtonElement>(null);
  const iRef = useRef(i);
  const salvoRef = useRef(modulo.passoAtual);

  const fim = i >= total;
  const passo = fim ? null : baloes[i];
  const trocando = passo != null && telaMostrada !== passo.tela;

  const ir = (n: number) => {
    const novo = Math.max(0, Math.min(n, total));
    if (novo >= total) setAuto(false);
    setI(novo);
  };
  const irRef = useRef(ir);
  irRef.current = ir;

  // Foco no diálogo ao abrir e de volta onde estava ao fechar.
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    fecharRef.current?.focus();
    return () => anterior?.focus?.();
  }, []);

  // Passo atual no banco (retoma em qualquer computador).
  useEffect(() => {
    iRef.current = i;
    if (salvoRef.current === i) return;
    salvoRef.current = i;
    salvarPasso({ moduloId: modulo.id, passo: i });
  }, [i, modulo.id, salvarPasso]);

  // Troca de tela: some, troca a imagem e reaparece. Lê o passo da hora da troca (cliques rápidos não mostram a tela errada).
  useEffect(() => {
    if (!passo || telaMostrada === passo.tela) return;
    const t = setTimeout(() => {
      const atual = baloes[iRef.current];
      if (atual) setTelaMostrada(atual.tela);
    }, telaMostrada ? 250 : 0);
    return () => clearTimeout(t);
  }, [passo, telaMostrada, baloes]);

  /** Encaixa a tela no palco (inteira, sem cortar), contorna o alvo e põe o balão ao lado. */
  const posicionar = (k: number = iRef.current) => {
    const atual = baloes[k];
    const palco = palcoRef.current, tela = telaRef.current, alvo = alvoRef.current, balao = balaoRef.current, seta = setaRef.current;
    if (!atual || !palco || !tela || !alvo || !balao || !seta || telaMostrada !== atual.tela) return;
    const celular = ehTelaCelular(atual.tela);
    const [iw, ih] = celular ? TAMANHO.celular : TAMANHO.desktop;
    const pw = palco.clientWidth, ph = palco.clientHeight;
    const margem = celular ? 24 : 20;
    const esc = Math.min((pw - margem * 2) / iw, (ph - margem * 2) / ih);
    const w = iw * esc, h = ih * esc;
    // Celular: a tela vai um pouco para a esquerda para sobrar espaço ao balão.
    const left = celular ? Math.max(margem, pw / 2 - w - 20) : (pw - w) / 2;
    const top = (ph - h) / 2;
    Object.assign(tela.style, { width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${top}px` });

    const [x, y, aw, ah] = atual.alvo;
    const a = { l: (x / 100) * w, t: (y / 100) * h, w: (aw / 100) * w, h: (ah / 100) * h };
    Object.assign(alvo.style, { left: `${a.l - 4}px`, top: `${a.t - 4}px`, width: `${a.w + 8}px`, height: `${a.h + 8}px` });

    const bw = Math.min(LARGURA_BALAO, pw - 32);
    balao.style.width = `${bw}px`;
    const bh = balao.offsetHeight;
    const ax = left + a.l, ay = top + a.t;
    const espaco = { direita: pw - (ax + a.w), esquerda: ax, abaixo: ph - (ay + a.h), acima: ay };
    let lado: Lado;
    if (atual.posicao !== "auto") lado = atual.posicao;
    else if (espaco.direita >= bw + 24) lado = "direita";
    else if (espaco.esquerda >= bw + 24) lado = "esquerda";
    else if (espaco.abaixo >= bh + 24) lado = "abaixo";
    else if (espaco.acima >= bh + 24) lado = "acima";
    else lado = "dentro";
    const lim = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    let bl: number, bt: number;
    if (lado === "direita") [bl, bt] = [ax + a.w + 16, lim(ay + a.h / 2 - bh / 2, 10, ph - bh - 10)];
    else if (lado === "esquerda") [bl, bt] = [ax - bw - 16, lim(ay + a.h / 2 - bh / 2, 10, ph - bh - 10)];
    else if (lado === "abaixo") [bl, bt] = [lim(ax + a.w / 2 - bw / 2, 10, pw - bw - 10), ay + a.h + 16];
    else if (lado === "acima") [bl, bt] = [lim(ax + a.w / 2 - bw / 2, 10, pw - bw - 10), ay - bh - 16];
    else [bl, bt] = [pw - bw - 16, ph - bh - 16];
    // Posição escolhida no editor pode não caber: o balão nunca sai do palco.
    bl = lim(bl, 8, pw - bw - 8);
    bt = lim(bt, 8, ph - bh - 8);
    balao.dataset.lado = lado;
    Object.assign(balao.style, { left: `${bl}px`, top: `${bt}px` });

    if (lado === "direita" || lado === "esquerda") {
      Object.assign(seta.style, { top: `${lim(ay + a.h / 2 - bt - 8, 14, bh - 30)}px`, left: lado === "direita" ? "-9px" : "", right: lado === "esquerda" ? "-9px" : "", bottom: "" });
    } else if (lado !== "dentro") {
      Object.assign(seta.style, { left: `${lim(ax + a.w / 2 - bl - 8, 14, bw - 30)}px`, top: lado === "abaixo" ? "-9px" : "", bottom: lado === "acima" ? "-9px" : "", right: "" });
    }
  };
  const posicionarRef = useRef(posicionar);
  posicionarRef.current = posicionar;

  // O passo vai explícito: iRef só é atualizado no efeito (depois deste), e o contorno sairia com o alvo do passo anterior.
  useLayoutEffect(() => {
    posicionarRef.current(i);
  }, [i, telaMostrada]);

  useEffect(() => {
    const aoRedimensionar = () => posicionarRef.current();
    addEventListener("resize", aoRedimensionar);
    return () => removeEventListener("resize", aoRedimensionar);
  }, []);

  // Teclado: ← → para navegar, Esc fecha.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
      else if (e.key === "ArrowRight") irRef.current(iRef.current + 1);
      else if (e.key === "ArrowLeft") irRef.current(iRef.current - 1);
    };
    addEventListener("keydown", tecla);
    return () => removeEventListener("keydown", tecla);
  }, [onFechar]);

  // Passar sozinho: tempo de leitura do balão.
  useEffect(() => {
    const barra = autoRef.current;
    if (barra) Object.assign(barra.style, { transition: "none", width: "0" });
    if (!auto || !passo) return;
    const ms = Math.max(4000, (passo.titulo.length + passo.texto.length) * 55) * ritmo;
    const quadro = requestAnimationFrame(() => {
      if (barra) Object.assign(barra.style, { transition: `width ${ms}ms linear`, width: "100%" });
    });
    const t = setTimeout(() => irRef.current(iRef.current + 1), ms);
    return () => {
      cancelAnimationFrame(quadro);
      clearTimeout(t);
    };
  }, [auto, passo, ritmo]);

  const alternarAuto = () => {
    if (auto) {
      setAuto(false);
      return;
    }
    if (fim) setI(0);
    setAuto(true);
  };

  const escolher = (k: number) => {
    setEscolha(k);
    setResultado(null);
    responder.mutate(
      { moduloId: modulo.id, opcao: k },
      {
        onSuccess: (r) => {
          setResultado(r);
          if (r.certo) setConcluidoEm(r.concluidoEm);
        },
      },
    );
  };

  const verDeNovo = () => {
    setEscolha(null);
    setResultado(null);
    setI(0);
  };

  const praticar = `${DEMO_URL}/login`;

  return (
    <>
      <div className="tr-pl-top">
        <div>
          <h2 id="tr-pl-titulo">{modulo.titulo}</h2>
          <small>
            {PAPEIS[modulo.papel]} · {total} passos · {modulo.minutos} min
          </small>
        </div>
        <div className="tr-pl-top__acoes">
          <a className="tr-pl-btn" href={praticar} target="_blank" rel="noopener noreferrer" title={`Entre com o usuário de demonstração e vá para ${modulo.rotaDemo}`}>
            Praticar na demonstração <ExternalLink size={14} aria-hidden />
          </a>
          <button type="button" className="tr-pl-btn" onClick={onFechar} ref={fecharRef}>
            <X size={14} aria-hidden /> Fechar
          </button>
        </div>
      </div>

      <div className="tr-pl-corpo">
        <div className="tr-palco" ref={palcoRef}>
          {passo && (
            <>
              <div className={`tr-tela${trocando ? " tr-tela--troca" : ""}`} ref={telaRef}>
                {telaMostrada && <img src={telaUrl(telaMostrada)} alt={`Tela do sistema: ${passo.titulo}`} onLoad={() => posicionarRef.current()} />}
                <div className="tr-alvo" ref={alvoRef} aria-hidden />
              </div>
              <div className={`tr-balao${trocando ? " tr-balao--some" : ""}`} ref={balaoRef} role="status" aria-live="polite">
                <span className="tr-balao__seta" ref={setaRef} aria-hidden />
                <div className="tr-balao__passo">
                  Passo {i + 1} de {total}
                </div>
                <h3>{passo.titulo}</h3>
                <p>{passo.texto}</p>
                <div className="tr-balao__acoes">
                  <span className="tr-pontos" aria-hidden>
                    {baloes.map((b, k) => (
                      <i key={b.id} className={k === i ? "a" : ""} />
                    ))}
                  </span>
                  {i > 0 && (
                    <button type="button" className="btn btn--outline tr-btn-sm" onClick={() => ir(i - 1)}>
                      Voltar
                    </button>
                  )}
                  <button type="button" className="btn btn--primary tr-btn-sm" onClick={() => ir(i + 1)}>
                    {i === total - 1 ? "Concluir" : "Próximo"}
                  </button>
                </div>
              </div>
            </>
          )}

          {fim && (
            <div className="tr-fim">
              <div className="tr-fim__card">
                <h3>{concluidoEm ? "Módulo concluído!" : "Você chegou ao fim!"}</h3>
                <p style={{ margin: 0, color: "var(--muted)" }}>
                  {concluidoEm ? "Pode responder de novo para revisar ou praticar na demonstração." : "Responda para concluir o módulo."}
                </p>
                <fieldset className="tr-quiz" disabled={responder.isPending}>
                  <legend>{modulo.pergunta}</legend>
                  {modulo.opcoes.map((o, k) => (
                    <label key={k}>
                      <input type="radio" name="tr-quiz" checked={escolha === k} onChange={() => escolher(k)} /> {o}
                    </label>
                  ))}
                  <div aria-live="polite" style={{ marginTop: 6 }}>
                    {responder.isError && <span className="tr-no">{responder.error instanceof Error ? responder.error.message : "Não foi possível conferir. Tente de novo."}</span>}
                    {resultado?.certo && <span className="tr-ok">✓ Isso mesmo! Módulo concluído.</span>}
                    {resultado && !resultado.certo && <span className="tr-no">Ainda não. Reveja os passos e tente de novo.</span>}
                  </div>
                </fieldset>
                <div className="tr-fim__acoes">
                  <button type="button" className="btn btn--outline" onClick={verDeNovo}>
                    <RotateCcw size={16} aria-hidden /> Ver de novo
                  </button>
                  <a className="btn btn--primary" href={praticar} target="_blank" rel="noopener noreferrer">
                    Praticar na demonstração <ExternalLink size={16} aria-hidden />
                  </a>
                </div>
                <p style={{ fontSize: 12, margin: "10px 0 0", color: "var(--muted)" }}>
                  Na demonstração, entre com o usuário fictício e abra {modulo.rotaDemo}.
                </p>
              </div>
            </div>
          )}
          <div className="tr-auto-barra" ref={autoRef} aria-hidden />
        </div>

        <aside className="tr-pl-lado" aria-label="Passos do treinamento">
          <h3>Passos</h3>
          {baloes.map((b, k) => (
            <button
              type="button"
              key={b.id}
              className={`tr-cap${k === i ? " tr-cap--on" : ""}${k < i || concluidoEm ? " tr-cap--feito" : ""}`}
              aria-current={k === i ? "step" : undefined}
              onClick={() => ir(k)}
            >
              <span className="tr-cap__n">{k + 1}</span>
              <span>{b.titulo}</span>
            </button>
          ))}
          <button type="button" className={`tr-cap${fim ? " tr-cap--on" : ""}`} aria-current={fim ? "step" : undefined} onClick={() => ir(total)}>
            <span className="tr-cap__n">★</span>
            <span>
              <b>Pergunta e prática</b>
            </span>
          </button>
        </aside>
      </div>

      <div className="tr-pl-ctl">
        <button type="button" className="tr-pl-btn" onClick={() => ir(i - 1)} disabled={i === 0}>
          ‹ Voltar
        </button>
        <button type="button" className="tr-pl-btn tr-pl-btn--brand" onClick={() => ir(i + 1)} disabled={fim}>
          {i >= total - 1 ? "Concluir ›" : "Próximo ›"}
        </button>
        <span className="tr-pl-tempo">
          {Math.min(i + 1, total)} / {total}
        </span>
        <div className="tr-pl-prog">
          {baloes.map((b, k) => (
            <button type="button" key={b.id} className={k < i ? "f" : k === i ? "a" : ""} onClick={() => ir(k)} aria-label={`Passo ${k + 1}`} />
          ))}
        </div>
        <button type="button" className="tr-pl-btn" onClick={alternarAuto} aria-pressed={auto}>
          {auto ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} {auto ? "Pausar" : "Passar sozinho"}
        </button>
        <select value={ritmo} onChange={(e) => setRitmo(Number(e.target.value))} aria-label="Ritmo">
          {RITMOS.map((r) => (
            <option key={r.valor} value={r.valor}>
              {r.rotulo}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
