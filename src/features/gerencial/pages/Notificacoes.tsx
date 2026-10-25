import { Bell, Mail, MessageCircle, Send, Smartphone } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ADMIN_ROLE } from "../../../config/app";
import { getMenuItem } from "../../../config/menuRegistry";
import { useLerNotificacoes, useNotificacoes } from "../../chamados/gatilhos/avisos";
import { useAccess } from "../../configuracoes/access/useAccess";
import { ServiceError } from "../../configuracoes/services/types";
import { KpiGer, Secao, Semaforo } from "../componentes";
import { fmtNum } from "../graficos";
import { useEnviarAlertas, useVisao } from "../hooks";

const QUANDO = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

const CANAIS = [
  { icone: Bell, nome: "Aviso interno (sino)", situacao: "Ativo", tom: "verde" as const, texto: "O sino no topo do portal, à direita. Recebe os alertas gerenciais (dias úteis às 8h) e os avisos dos gatilhos de ticket (Administração › Gatilhos, ação \"Avisar\")." },
  { icone: Mail, nome: "E-mail", situacao: "Em breve", tom: "cinza" as const, texto: "Resumo dos alertas por e-mail para quem tem acesso ao Gerencial. Previsto na etapa de avisos por e-mail dos Gatilhos." },
  { icone: MessageCircle, nome: "WhatsApp", situacao: "Em breve", tom: "cinza" as const, texto: "Aviso pelo número do setor para gestores. Depende do motor de WhatsApp já usado nas conversas." },
  { icone: Smartphone, nome: "Push", situacao: "Em breve", tom: "cinza" as const, texto: "Notificação no navegador ou no celular, mesmo com o portal fechado." },
];

/** Notificações: comunicar acontecimentos (sino do portal, e-mail, WhatsApp e push) e disparar os alertas gerenciais. */
export function Notificacoes() {
  const v = useVisao();
  const { role, isSuperAdmin, user } = useAccess();
  const podeDisparar = isSuperAdmin || role === ADMIN_ROLE;
  const enviar = useEnviarAlertas();
  const avisos = useNotificacoes(Boolean(user));
  const ler = useLerNotificacoes();
  const [erro, setErro] = useState<string | null>(null);
  const base = getMenuItem("gestao_chamados_gerencial").path;
  const tickets = getMenuItem("gestao_chamados_tickets").path;
  const itens = avisos.data?.itens ?? [];
  const gerenciais = itens.filter((n) => n.titulo.startsWith("Gerencial:"));
  const naoLidas = avisos.data?.naoLidas ?? 0;
  const criticos = v.alertas.filter((a) => a.nivel === "critico").length;

  return (
    <>
      <div className="ds-kpis">
        <KpiGer label="Avisos não lidos" valor={fmtNum(naoLidas)} tom={naoLidas ? "amarelo" : "verde"} hint="No seu sino agora" />
        <KpiGer label="Avisos gerenciais recentes" valor={fmtNum(gerenciais.length)} hint="Entre os últimos 30 avisos" />
        <KpiGer label="Alertas críticos no recorte" valor={fmtNum(criticos)} tom={criticos ? "vermelho" : "verde"} hint="Veja a tela Alertas" />
        <KpiGer label="Canais ativos" valor={fmtNum(CANAIS.filter((c) => c.tom === "verde").length)} unidade={`de ${CANAIS.length}`} hint="Sino ativo; e-mail, WhatsApp e push em breve" />
      </div>

      <Secao titulo="Canais" subtitulo="Por onde os acontecimentos chegam às pessoas.">
        <div className="ger-lista">
          {CANAIS.map((c) => (
            <div key={c.nome} className={`ger-item ger-item--${c.tom === "verde" ? "ok" : "tendencia"}`}>
              <span className="ger-item__icone">
                <c.icone size={16} aria-hidden="true" />
              </span>
              <div>
                <b>{c.nome}</b>
                <p>{c.texto}</p>
              </div>
              <Semaforo tom={c.tom}>{c.situacao}</Semaforo>
            </div>
          ))}
        </div>
      </Secao>

      <div className="ger-grid ger-grid--2">
        <Secao titulo="Alertas gerenciais automáticos" subtitulo="O que vai para o sino sem ninguém precisar abrir o Gerencial.">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
            <li>
              <b>Quando:</b> dias úteis às 8h (horário de São Paulo), de forma automática.
            </li>
            <li>
              <b>Para quem:</b> Admin, Super admin e quem tem acesso ao Gerencial, cada um só com os tickets que pode ver.
            </li>
            <li>
              <b>Regras:</b> SLA vencido acima do limite, tickets sem responsável, backlog acima do limite e tickets parados.
            </li>
            <li>
              <b>Sem repetição:</b> um aviso por regra, por pessoa e por dia; se já foi enviado hoje, não vai de novo.
            </li>
            <li>
              <b>Limites:</b> os mesmos de <Link to={{ pathname: `${base}/indicadores`, search: location.search }}>Indicadores › Metas e limites</Link>.
            </li>
          </ul>
          <p className="ger-nota">Os avisos olham a situação de agora, do backlog inteiro; a tela Alertas usa o período e os filtros escolhidos.</p>
        </Secao>
        <Secao titulo="Enviar alertas agora" subtitulo={podeDisparar ? "Dispara a mesma rotina das 8h sem esperar o horário. Só Admin e Super admin." : "Só Admin e Super admin disparam os avisos fora do horário."}>
          <div className="ger-acoes">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!podeDisparar || enviar.isPending}
              onClick={() => {
                setErro(null);
                enviar.mutate(undefined, { onError: (err) => setErro(err instanceof ServiceError ? err.message : "Não foi possível enviar os alertas. Tente de novo.") });
              }}
            >
              <Send size={16} aria-hidden="true" /> {enviar.isPending ? "Enviando…" : "Enviar alertas agora"}
            </button>
            {enviar.isSuccess && (
              <span className="ds-muted" style={{ fontSize: 13 }}>
                {enviar.data === 0 ? "Nada novo para avisar: ou está tudo dentro dos limites, ou os avisos de hoje já foram enviados." : `${enviar.data} ${enviar.data === 1 ? "aviso criado" : "avisos criados"} no sino.`}
              </span>
            )}
          </div>
          {erro && (
            <p className="ger-nota" role="alert">
              {erro}
            </p>
          )}
        </Secao>
      </div>

      <Secao
        titulo="Seus avisos"
        subtitulo="Os mesmos do sino: alertas gerenciais e avisos de ticket dos gatilhos."
        aside={
          naoLidas > 0 ? (
            <button type="button" className="ds-linkbtn" disabled={ler.isPending} onClick={() => ler.mutate(null)}>
              Marcar todas como lidas
            </button>
          ) : undefined
        }
      >
        <div className="ger-lista">
          {avisos.isPending && <p className="gr-vazio">Carregando…</p>}
          {avisos.isError && <p className="gr-vazio">Não foi possível carregar os avisos.</p>}
          {avisos.isSuccess && itens.length === 0 && <p className="gr-vazio">Nenhum aviso por enquanto.</p>}
          {itens.map((n) => (
            <div key={n.id} className={`ger-item ger-item--${n.lida ? "ok" : "atencao"}`}>
              <span className="ger-item__icone">
                <Bell size={16} aria-hidden="true" />
              </span>
              <div>
                <b>{n.titulo}</b>
                <p>{n.texto}</p>
                {n.ticketId && (
                  <small>
                    <Link to={`${tickets}/${n.ticketId}`} onClick={() => !n.lida && ler.mutate([n.id])}>
                      Abrir ticket #{n.ticketId}
                    </Link>
                  </small>
                )}
              </div>
              <span className="ger-item__lado">
                {QUANDO.format(new Date(n.criadoEm))}
                <br />
                {n.lida ? "lida" : <Semaforo tom="amarelo">nova</Semaforo>}
              </span>
            </div>
          ))}
        </div>
      </Secao>
    </>
  );
}
