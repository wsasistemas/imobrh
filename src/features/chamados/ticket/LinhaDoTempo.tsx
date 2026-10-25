import { Lock, Mail, MessageCircle, Settings, Sparkles, Zap } from "lucide-react";
import { useState } from "react";
import { DetailDialog } from "../../../components/ds";
import { ListaAnexos } from "../../atendimento/pages/Anexos";
import { ORIGENS, type AcaoTicket, type EventoTicket, type TicketDetalhe } from "./types";

// Linha do tempo no modelo da Movidesk (Wagner, 08/10/2026): uma linha vertical com um marcador por interação —
// quem fez e o que fez. Mensagem externa (e-mail, WhatsApp) leva o ícone do canal; e-mail abre "Visualizar e-mail".

const TZ = "America/Sao_Paulo";
const DATA_HORA = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const DATA_HORA_SEG = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });
const fmt = (iso: string | null | undefined) => (iso ? DATA_HORA.format(new Date(iso)) : "—");

function iniciais(nome: string) {
  const p = nome.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

type Item = { tipo: "acao"; quando: number; ordem: number; a: AcaoTicket } | { tipo: "evento"; quando: number; ordem: number; e: EventoTicket };

/** Marcador da linha: o canal da mensagem, o robô (gatilho, IA, sistema) ou as iniciais de quem fez. */
function Marcador({ item }: { item: Item }) {
  if (item.tipo === "acao") {
    const a = item.a;
    if (a.tipo === "interna") return <span className="tl-no tl-no--interna" title="Nota interna"><Lock size={15} aria-hidden="true" /></span>;
    if (a.canal === "email") return <span className="tl-no tl-no--email" title={a.direcao === "entrada" ? "E-mail recebido" : "E-mail enviado"}><Mail size={15} aria-hidden="true" /></span>;
    if (a.canal === "whatsapp") return <span className="tl-no tl-no--whatsapp" title="WhatsApp"><MessageCircle size={15} aria-hidden="true" /></span>;
    return <span className="tl-no" aria-hidden="true">{iniciais(a.autorNome)}</span>;
  }
  const e = item.e;
  if (e.autorNome === "Gatilho" || e.tipo.startsWith("gatilho")) return <span className="tl-no tl-no--gatilho" title="Gatilho"><Zap size={15} aria-hidden="true" /></span>;
  if (e.autorNome === "IA" || e.tipo === "ia") return <span className="tl-no tl-no--ia" title="Inteligência artificial"><Sparkles size={15} aria-hidden="true" /></span>;
  if (e.autorNome === "Sistema") return <span className="tl-no tl-no--sistema" title="Sistema"><Settings size={15} aria-hidden="true" /></span>;
  return <span className="tl-no tl-no--pessoa" aria-hidden="true">{iniciais(e.autorNome)}</span>;
}

const rotuloCanal = (a: AcaoTicket) => (a.canal === "portal" ? "Portal" : ORIGENS[a.canal]);

export function LinhaDoTempo({ d, historico, setHistorico }: { d: TicketDetalhe; historico: boolean; setHistorico: (v: boolean) => void }) {
  const [publicas, setPublicas] = useState(true);
  const [internas, setInternas] = useState(true);
  const [emailAberto, setEmailAberto] = useState<AcaoTicket | null>(null);
  const itens: Item[] = [
    ...d.acoes.filter((a) => (a.tipo === "publica" ? publicas : internas)).map((a) => ({ tipo: "acao" as const, quando: Date.parse(a.criadoEm), ordem: a.numero, a })),
    ...(historico ? d.eventos.map((e, i) => ({ tipo: "evento" as const, quando: Date.parse(e.criadoEm), ordem: -i, e })) : []),
  ].sort((x, y) => y.quando - x.quando || y.ordem - x.ordem);

  return (
    <section aria-label="Linha do tempo">
      <div className="tk-filtros">
        Visualizar:
        <label>
          <input type="checkbox" checked={publicas} onChange={(e) => setPublicas(e.target.checked)} /> Ações públicas
        </label>
        <label>
          <input type="checkbox" checked={internas} onChange={(e) => setInternas(e.target.checked)} /> Notas internas
        </label>
        <label>
          <input type="checkbox" checked={historico} onChange={(e) => setHistorico(e.target.checked)} /> Histórico de alterações
        </label>
      </div>
      {itens.length === 0 && <p className="ch-muted" style={{ fontSize: 13 }}>Nada para mostrar com estes filtros.</p>}
      <ol className="tl">
        {itens.map((it) => (
          <li key={it.tipo === "acao" ? `a-${it.a.numero}` : `e-${it.ordem}-${it.quando}`} className={`tl-item tl-item--${it.tipo}`}>
            <Marcador item={it} />
            {it.tipo === "evento" ? (
              <div className="tl-evento">
                <div className="tl-evento__h">
                  <b>{it.e.autorNome}</b>
                  <span>{fmt(it.e.criadoEm)}</span>
                </div>
                <div className="tl-evento__c">{it.e.descricao}</div>
              </div>
            ) : (
              <article className={`tk-acao__box${it.a.tipo === "interna" ? " tl-acao--interna" : ""}${it.a.direcao === "entrada" ? " tl-acao--entrada" : ""}`}>
                <div className="tk-acao__h">
                  <b>{it.a.autorNome}</b>
                  <span className="ch-muted">{fmt(it.a.criadoEm)}</span>
                  <span className="ch-badge">
                    {it.a.tipo === "interna" ? "Nota interna" : it.a.direcao === "entrada" ? `Recebido · ${rotuloCanal(it.a)}` : `Resposta · ${rotuloCanal(it.a)}`}
                  </span>
                  {it.a.envioStatus === "pendente" && <span className="ch-badge ch-badge--warning">pendente de envio</span>}
                  {it.a.envioStatus === "falhou" && <span className="ch-badge ch-badge--danger">falha no envio</span>}
                  {it.a.envioStatus === "enviado" && <span className="ch-badge ch-badge--success">enviado</span>}
                  <span className="tk-acao__n">{it.a.numero}</span>
                </div>
                <div className="tk-acao__c">{it.a.texto}</div>
                {/* E-mail mostra os anexos no "Visualizar e-mail"; WhatsApp e App do solicitante (portal), aqui. */}
                {it.a.canal !== "email" && <ListaAnexos anexos={it.a.anexos} />}
                {it.a.email && (
                  <div className="tl-acao__rodape">
                    <button type="button" className="tk-link" onClick={() => setEmailAberto(it.a)}>
                      <Mail size={13} aria-hidden="true" /> Visualizar e-mail
                    </button>
                  </div>
                )}
              </article>
            )}
          </li>
        ))}
      </ol>
      {emailAberto && <DialogoEmail a={emailAberto} onFechar={() => setEmailAberto(null)} />}
    </section>
  );
}

function DialogoEmail({ a, onFechar }: { a: AcaoTicket; onFechar: () => void }) {
  const m = a.email!;
  const entrada = a.direcao === "entrada";
  const end = (email: string | null, nome?: string | null) => (nome ? `${nome} <${email ?? ""}>` : (email ?? "—"));
  const status = entrada
    ? { texto: "Recebido", classe: "tl-email__ok" }
    : a.envioStatus === "enviado"
      ? { texto: "Enviado", classe: "tl-email__ok" }
      : a.envioStatus === "falhou"
        ? { texto: "Falha no envio", classe: "tl-email__erro" }
        : { texto: "Pendente de envio", classe: "tl-email__pend" };
  return (
    <DetailDialog open onOpenChange={(o) => !o && onFechar()} title="Visualizar e-mail" description={entrada ? "E-mail recebido do solicitante." : "E-mail enviado pelo portal."}>
      <dl className="tl-email">
        <dt>De:</dt>
        <dd>{end(m.de, m.deNome)}</dd>
        <dt>{entrada ? "Data do recebimento:" : "Data do envio:"}</dt>
        <dd>{m.data ? DATA_HORA_SEG.format(new Date(m.data)) : "—"}</dd>
        <dt>Para:</dt>
        <dd>{m.para.filter(Boolean).join(", ") || "—"}</dd>
        {m.cc.length > 0 && (
          <>
            <dt>Cc:</dt>
            <dd>{m.cc.join(", ")}</dd>
          </>
        )}
        <dt>Assunto:</dt>
        <dd>{m.assunto || "(sem assunto)"}</dd>
        <dt>Status:</dt>
        <dd className={status.classe}>
          {status.texto}
          {a.envioErro && !entrada ? ` — ${a.envioErro}` : ""}
          {!entrada && a.envioTentativas ? ` (${a.envioTentativas} tentativa${a.envioTentativas > 1 ? "s" : ""})` : ""}
        </dd>
      </dl>
      <div className="tl-email__corpo">{a.texto}</div>
      <ListaAnexos anexos={a.anexos} />
    </DetailDialog>
  );
}
