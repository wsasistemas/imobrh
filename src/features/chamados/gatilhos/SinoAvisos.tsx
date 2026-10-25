import { AlertTriangle, Bell, BellRing, CheckCircle2, Siren } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { useAccess } from "../../configuracoes/access/useAccess";
import { useAlertasGerenciais } from "../../gerencial/hooks";
import { useLerNotificacoes, useNotificacoes } from "./avisos";
import "./SinoAvisos.css";

const QUANDO = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

type Aba = "notificacoes" | "alertas";

/**
 * Sino do topo: notificações (avisos dos gatilhos e alertas diários do Gerencial gravados no banco) e, para quem tem
 * acesso ao Gerencial, os alertas de agora (limites ultrapassados nos últimos 30 dias, os mesmos da tela Alertas).
 */
export function SinoAvisos({ ativo }: { ativo: boolean }) {
  const { hasPermission } = useAccess();
  const veAlertas = ativo && hasPermission("gestao_chamados_gerencial");
  const q = useNotificacoes(ativo);
  const ler = useLerNotificacoes();
  const al = useAlertasGerenciais(veAlertas);
  const navigate = useNavigate();
  const [aberto, setAberto] = useState(false);
  const [aba, setAba] = useState<Aba>("notificacoes");
  const caixa = useRef<HTMLDivElement>(null);
  const naoLidas = q.data?.naoLidas ?? 0;
  const criticos = al.alertas.filter((a) => a.nivel === "critico").length;
  const total = naoLidas + al.alertas.length;

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => !caixa.current?.contains(e.target as Node) && setAberto(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAberto(false);
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);

  const abrir = () => {
    setAberto((a) => {
      // Ao abrir, mostra primeiro o que tem novidade: notificações não lidas; senão, alertas.
      if (!a) setAba(naoLidas === 0 && al.alertas.length > 0 ? "alertas" : "notificacoes");
      return !a;
    });
  };

  const rotulo = [naoLidas ? `${naoLidas} notificações não lidas` : "", al.alertas.length ? `${al.alertas.length} alertas` : ""].filter(Boolean).join(", ");

  return (
    <div className="sino" ref={caixa}>
      <button type="button" className="topbar__icon-button" aria-label={rotulo ? `Notificações e alertas: ${rotulo}` : "Notificações e alertas"} aria-haspopup="true" aria-expanded={aberto} onClick={abrir}>
        {total > 0 ? <BellRing size={18} /> : <Bell size={18} />}
        {total > 0 && <span className={`sino__n${criticos > 0 ? " sino__n--critico" : ""}`}>{total > 9 ? "9+" : total}</span>}
      </button>
      {aberto && (
        <div className="sino__painel" role="dialog" aria-label="Notificações e alertas">
          <div className="sino__h">
            <b>Central de avisos</b>
            {aba === "notificacoes" && naoLidas > 0 && (
              <button type="button" className="sino__link" disabled={ler.isPending} onClick={() => ler.mutate(null)}>
                Marcar todas como lidas
              </button>
            )}
          </div>

          {veAlertas && (
            <div className="sino__abas" role="tablist" aria-label="Tipo de aviso">
              <button type="button" role="tab" aria-selected={aba === "notificacoes"} className={`sino__aba${aba === "notificacoes" ? " sino__aba--ativa" : ""}`} onClick={() => setAba("notificacoes")}>
                <Bell size={14} aria-hidden="true" /> Notificações
                {naoLidas > 0 && <span className="sino__cont">{naoLidas}</span>}
              </button>
              <button type="button" role="tab" aria-selected={aba === "alertas"} className={`sino__aba${aba === "alertas" ? " sino__aba--ativa" : ""}`} onClick={() => setAba("alertas")}>
                <AlertTriangle size={14} aria-hidden="true" /> Alertas
                {al.alertas.length > 0 && <span className={`sino__cont${criticos ? " sino__cont--critico" : ""}`}>{al.alertas.length}</span>}
              </button>
            </div>
          )}

          {aba === "notificacoes" || !veAlertas ? (
            !q.data?.itens.length ? (
              <p className="sino__vazio">
                <CheckCircle2 size={16} aria-hidden="true" /> Nenhuma notificação por enquanto. Os gatilhos e os alertas diários do Gerencial avisam aqui.
              </p>
            ) : (
              <ul>
                {q.data.itens.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`sino__item${n.lida ? "" : " sino__item--nova"}`}
                      onClick={() => {
                        if (!n.lida) ler.mutate([n.id]);
                        setAberto(false);
                        if (n.ticketId) navigate(`${getMenuItem("gestao_chamados_tickets").path}/${n.ticketId}`);
                        else if (n.link?.startsWith("/")) navigate(n.link);
                        else if (n.titulo.startsWith("Gerencial:")) navigate(`${getMenuItem("gestao_chamados_gerencial").path}/alertas`);
                      }}
                    >
                      <b>{n.titulo}</b>
                      <span>{n.texto}</span>
                      <small>{QUANDO.format(new Date(n.criadoEm))}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : al.carregando ? (
            <p className="sino__vazio">Verificando os limites…</p>
          ) : al.erro ? (
            <p className="sino__vazio">Não foi possível verificar os alertas agora.</p>
          ) : al.alertas.length === 0 ? (
            <p className="sino__vazio">
              <CheckCircle2 size={16} aria-hidden="true" /> Tudo dentro dos limites nos últimos 30 dias.
            </p>
          ) : (
            <ul>
              {al.alertas.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={`sino__item sino__item--alerta sino__item--${a.nivel}`}
                    onClick={() => {
                      setAberto(false);
                      navigate(`${getMenuItem("gestao_chamados_gerencial").path}/alertas`);
                    }}
                  >
                    <b>
                      {a.nivel === "critico" ? <Siren size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />} {a.titulo}
                    </b>
                    <span>{a.texto}</span>
                    <small>{a.nivel === "critico" ? "Crítico" : "Atenção"} · últimos 30 dias</small>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {veAlertas && (
            <button
              type="button"
              className="sino__rodape"
              onClick={() => {
                setAberto(false);
                navigate(`${getMenuItem("gestao_chamados_gerencial").path}/${aba === "alertas" ? "alertas" : "notificacoes"}`);
              }}
            >
              {aba === "alertas" ? "Ver todos os alertas" : "Ver todas as notificações"} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
